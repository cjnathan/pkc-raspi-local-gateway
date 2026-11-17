// Teltonika RUT241 (RutOS) reader: polls the router's local REST API for
// signal strength, connectivity and data usage (quota) and publishes
// router/{source}/status. Optional and experimental — runs only when
// config.rut241.enabled is true. Zero npm deps (node:https), accepts the
// router's self-signed certificate. Poll failures never affect metering.
//
// RutOS API notes (verified on this unit's firmware):
//   POST /api/login {username,password} → {data:{token,expires(~299s)}}
//   Auth: "Authorization: Bearer <token>" (other headers are rejected)
//   /api/modems/status              → signal + connectivity
//   /api/data_usage/total/status    → daily [[epoch, rxBytes, txBytes], ...]
//   /api/data_limit/status          → router-side data limit feature
//   /api/system/device/usage/status → uptime, RAM, loadavg

import https from "node:https";
import os from "node:os";

export class Rut241 {
  constructor(cfg, mqttClient) {
    this.state = {
      enabled: false,
      source: "",
      lastPollAt: null,
      lastPublishAt: null,
      lastPayload: null,
      lastError: null,
      publishCount: 0,
    };
    this.timer = null;
    this.setConfig(cfg, mqttClient);
  }

  setConfig(cfg, mqttClient) {
    this.cfg = cfg || {};
    this.mqttClient = mqttClient;
    this.state.enabled = !!this.cfg.enabled;
    this.state.source = this.source();
    this._restartTimer();
  }

  source() {
    return (this.cfg && this.cfg.source) || os.hostname();
  }

  _mqtt() {
    return typeof this.mqttClient === "function" ? this.mqttClient() : this.mqttClient;
  }

  _restartTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const enabled = this.state.enabled && this.cfg.url && this.cfg.username;
    if (!this.state.enabled) return;
    if (!this.cfg.url || !this.cfg.username) {
      console.warn("[rut241] enabled but url/username missing — polling disabled");
      return;
    }
    const iv = Math.max(300, this.cfg.intervalSec || 1800) * 1000;
    this.timer = setInterval(() => this.poll().catch(() => {}), iv);
    setTimeout(() => this.poll().catch(() => {}), 8000);
    console.log(`[rut241] polling ${this.cfg.url} every ${iv / 1000}s, source=${this.source()}`);
  }

  start() {
    this._restartTimer();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _request(path, method = "GET", body, token) {
    return new Promise((resolve, reject) => {
      const r = https.request(
        {
          hostname: new URL(this.cfg.url).hostname,
          port: new URL(this.cfg.url).port || 443,
          path,
          method,
          rejectUnauthorized: false,
          timeout: 15000,
          headers: {
            "Accept-Encoding": "identity",
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(token ? { Authorization: "Bearer " + token } : {}),
          },
        },
        (s) => {
          let d = "";
          s.on("data", (c) => (d += c));
          s.on("end", () => resolve({ status: s.statusCode, body: d }));
        }
      );
      r.on("error", (e) => reject(new Error(`${this.cfg.url}${path}: ${e.message}`)));
      r.on("timeout", () => { r.destroy(new Error("timeout after 15s")); });
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  }

  async _login() {
    const r = await this._request("/api/login", "POST", { username: this.cfg.username, password: this.cfg.password });
    const b = this._json(r);
    if (r.status !== 200 || !b || !b.success || !b.data || !b.data.token) {
      const detail = b && b.errors ? b.errors[0].error : r.status;
      throw new Error("router login failed: " + detail);
    }
    return b.data.token;
  }

  async _get(path, token) {
    const r = await this._request(path, "GET", null, token);
    const b = this._json(r);
    if (r.status !== 200 || !b || !b.success) {
      const detail = b && b.errors ? b.errors[0].error : r.status;
      throw new Error(`${path}: ${detail}`);
    }
    return b.data;
  }

  _json(r) {
    try { return JSON.parse(r.body); } catch { return null; }
  }

  async poll() {
    try {
      const payload = await this.buildPayload();
      this.state.lastPollAt = Date.now();
      this.state.lastPayload = payload;
      this.state.lastError = null;
      await this.publishPayload(payload);
      return payload;
    } catch (e) {
      this.state.lastError = e.message;
      console.error("[rut241] poll failed:", e.message);
      return null;
    }
  }

  async publishNow() {
    return this.poll();
  }

  async buildPayload() {
    const errors = [];
    const token = await this._login();
    let modems = null, usageDaily = null, dataLimit = null, deviceUsage = null;
    try {
      const arr = await this._get("/api/modems/status", token);
      modems = Array.isArray(arr) ? arr[0] : arr;
    } catch (e) { errors.push("modems: " + e.message); }
    try { usageDaily = await this._get("/api/data_usage/total/status", token); } catch (e) { errors.push("usage: " + e.message); }
    try { dataLimit = await this._get("/api/data_limit/status", token); } catch (e) { errors.push("dataLimit: " + e.message); }
    try { deviceUsage = await this._get("/api/system/device/usage/status", token); } catch (e) { errors.push("deviceUsage: " + e.message); }
    if (!modems) throw new Error(errors.join("; ") || "no modem data");

    const daily = Array.isArray(usageDaily) ? usageDaily.slice(-62) : [];
    const last30 = Array.isArray(usageDaily) ? usageDaily.slice(-30) : [];
    const today = daily.length ? daily[daily.length - 1] : null;
    const modem = modems || {};

    return {
      timestamp: new Date().toISOString(),
      source: this.source(),
      device: {
        manufacturer: "Teltonika",
        model: "RUT241",
        serial: modem.serial || null,
        imei: modem.imei || null,
        imsi: modem.imsi || null,
        iccid: modem.iccid || null,
      },
      connectivity: {
        state: modem.state || null,
        operatorState: modem.operator_state || null,
        connType: modem.conntype || null,
        networkType: modem.ntype || null,
        operator: modem.operator || null,
        dataConnState: modem.data_conn_state || null,
        simState: modem.simstate || null,
        pinState: modem.pinstate || null,
      },
      signal: {
        rssi: modem.rssi ?? null,
        rsrp: modem.rsrp ?? null,
        rsrq: modem.rsrq ?? null,
        sinr: modem.sinr ?? null,
        signal: modem.signal ?? null,
      },
      usage: {
        unit: "bytes",
        daily,
        todayRx: today ? today[1] : null,
        todayTx: today ? today[2] : null,
        last30Rx: last30.reduce((a, d) => a + d[1], 0),
        last30Tx: last30.reduce((a, d) => a + d[2], 0),
        samples: Array.isArray(usageDaily) ? usageDaily.length : 0,
      },
      dataLimit: dataLimit || null,
      system: {
        uptimeSeconds: deviceUsage && deviceUsage.uptime_seconds != null ? deviceUsage.uptime_seconds : null,
        uptime: deviceUsage ? deviceUsage.uptime : null,
        ramUsed: deviceUsage && deviceUsage.memory ? deviceUsage.memory.ram_used : null,
        ramTotal: deviceUsage && deviceUsage.memory ? deviceUsage.memory.ram_total : null,
        ramPercentage: deviceUsage && deviceUsage.memory ? deviceUsage.memory.ram_percentage : null,
        loadavg: deviceUsage ? deviceUsage.loadavg : null,
        temperature: modem.temperature ?? null,
      },
      ...(errors.length ? { errors } : {}),
    };
  }

  publishPayload(payload) {
    const client = this._mqtt();
    if (!client || !client.connected) {
      this.state.lastError = "mqtt offline";
      console.warn(`[rut241] publish skipped (mqtt offline): router/${this.source()}/status`);
      return Promise.resolve(false);
    }
    return new Promise((resolve, reject) => {
      client.publish(`router/${this.source()}/status`, JSON.stringify(payload), { qos: 1 }, (err) => {
        if (err) { this.state.lastError = err.message; reject(err); return; }
        this.state.lastPublishAt = Date.now();
        this.state.lastError = null;
        this.state.publishCount++;
        console.log(`[rut241] published router/${this.source()}/status (signal ${payload.signal && payload.signal.rsrp} dBm RSRP, ${payload.usage && payload.usage.last30Rx + payload.usage.last30Tx} bytes/30d)`);
        resolve();
      });
    });
  }
}

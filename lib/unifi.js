// UniFi controller reader: polls the local controller REST API and
// publishes wifi/{source}/status (central format, consumed by the
// server's mqtt-processor). Ported 1:1 in logic from the original
// unifi-mqtt-reporter.py. Zone concept removed: the topic segment is
// just a source label (Pi hostname by default); zoning is decided on
// the server. Zero npm dependencies (node:https only).

import https from "node:https";

export class UnifiReader {
  constructor(config, mqttClient, meterIps = () => ({})) {
    this.cfg = config;
    this.mqtt = mqttClient;
    this.meterIps = meterIps;
    this.cookie = null;
    this.state = {
      enabled: !!config.enabled,
      source: config.source || "",
      lastPollAt: null,
      lastPublishAt: null,
      lastPayload: null,
      lastError: null,
      publishCount: 0,
    };
    this.timer = null;
  }

  setConfig(config, mqttClient) {
    this.cfg = config;
    if (mqttClient) this.mqtt = mqttClient;
    this.state.enabled = !!config.enabled;
    this.state.source = config.source || "";
    this._restartTimer();
  }

  _restartTimer() {
    if (this.timer) clearInterval(this.timer);
    if (!this.cfg.enabled) return;
    const iv = Math.max(60, this.cfg.intervalSec || 1800) * 1000;
    this.timer = setInterval(() => { this.poll().catch(() => {}); }, iv);
    setTimeout(() => { this.poll().catch(() => {}); }, 5000);
    console.log(`[unifi] polling every ${iv / 1000}s, source=${this.source()}`);
  }

  source() {
    return this.cfg.source || "gateway";
  }

  // Raw request helper. Uses node:https with rejectUnauthorized:false
  // because the UniFi controller serves a SELF-SIGNED certificate (the
  // original Python reporter ignored it too). Surfaces the real cause
  // instead of a bare "fetch failed".
  _request(path, { method = "GET", body } = {}) {
    const target = new URL(this.cfg.url.replace(/\/$/, "") + path);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: target.hostname,
          port: target.port || (target.protocol === "http:" ? 80 : 443),
          path: target.pathname + target.search,
          method,
          rejectUnauthorized: false,
          timeout: 30000,
          headers: {
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(this.cookie ? { Cookie: this.cookie } : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode, setCookie: res.headers["set-cookie"], data }));
        }
      );
      req.on("timeout", () => { req.destroy(new Error("timeout after 30s")); });
      req.on("error", (e) => reject(new Error(`${this.cfg.url}${path}: ${e.message}`)));
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async _login() {
    const res = await this._request("/api/login", {
      method: "POST",
      body: { username: this.cfg.username, password: this.cfg.password },
    });
    if (res.status === 401) throw new Error("login rejected (HTTP 401) — check the controller USERNAME (not email) and PASSWORD in the Configuration tab");
    if (res.status !== 200) throw new Error(`login HTTP ${res.status}`);
    const setCookie = Array.isArray(res.setCookie) ? res.setCookie[0] : res.setCookie;
    this.cookie = setCookie ? setCookie.split(";")[0] : null;
    if (!this.cookie) throw new Error("no session cookie from controller");
  }

  async _get(path, retried = false) {
    const res = await this._request(path);
    if (res.status === 401 && !retried) {
      await this._login();
      return this._get(path, true);
    }
    if (res.status === 404) throw new Error(`${path} HTTP 404 — check the SITE name in the Configuration tab (usually "default")`);
    if (res.status !== 200) throw new Error(`${path} HTTP ${res.status}`);
    const body = JSON.parse(res.data);
    return body.data || [];
  }

  static extractDevice(d, nameByMac) {
    let uplink = d.uplink || {};
    if (typeof uplink !== "object" || uplink === null) uplink = {};
    const parent =
      uplink.uplink_device_name ||
      uplink.device_name ||
      nameByMac.get(uplink.ap_mac || uplink.uplink_device_mac) ||
      null;
    const signal = uplink.signal ?? uplink.uplink_signal ?? null;
    let sysStats = d["system-stats"] || {};
    if (typeof sysStats !== "object" || sysStats === null) sysStats = {};
    let state = d.state ?? (d.adopted === true ? 1 : 0);

    return {
      name: d.name || d.dev_name || d.mac || null,
      mac: d.mac || null,
      model: d.model ?? null,
      state: typeof state === "number" ? state : null,
      uplinkType: uplink.type ?? null,
      uplinkParent: parent,
      uplinkSignal: typeof signal === "number" ? signal : null,
      channel: typeof d.channel === "number" ? d.channel : null,
      clientCount: d.num_sta || d["user-num-sta"] || 0,
      cpu: typeof sysStats.cpu === "number" ? sysStats.cpu : null,
      memory: typeof sysStats.mem === "number" ? sysStats.mem : null,
      uptimeSec: typeof sysStats.uptime === "number" ? sysStats.uptime : null,
    };
  }

  async fetchDevices() {
    const raw = await this._get(`/api/s/${this.cfg.site}/stat/device`);
    const nameByMac = new Map();
    for (const d of raw) if (d.mac) nameByMac.set(d.mac, d.name || d.dev_name);
    return raw.filter((d) => d.mac).map((d) => UnifiReader.extractDevice(d, nameByMac)).filter((d) => d.name);
  }

  async fetchClients() {
    const raw = await this._get(`/api/s/${this.cfg.site}/stat/sta`);
    return raw.map((c) => ({
      name: c.name || c.hostname || c.mac,
      mac: c.mac,
      ip: c.ip || null,
      ap: c.ap_mac || (c["last-ap-mac"]) || null,
      signal: c.signal ?? null,
      uptimeSec: typeof c.uptime === "number" ? c.uptime : null,
    }));
  }

  async buildPayload() {
    const devices = await this.fetchDevices();
    const nameByMac = new Map(devices.map((d) => [d.mac, d.name]));
    let clients = [];
    let clientsError = null;
    try {
      const idx = this.meterIps() || {};
      const raw = await this.fetchClients();
      clients = raw.map((c) => ({
        name: c.name,
        mac: c.mac,
        ip: c.ip,
        apMac: c.ap,
        ap: c.ap ? nameByMac.get(c.ap) || c.ap : null,
        signal: c.signal,
        uptimeSec: c.uptimeSec,
        meter: c.ip && idx[c.ip] ? idx[c.ip] : null,
      }));
    } catch (e) {
      clientsError = e.message;
    }
    return {
      timestamp: new Date().toISOString(),
      zone: this.source(),
      devices,
      clients,
      clientCount: devices.reduce((sum, d) => sum + (Number(d.clientCount) || 0), 0),
      meterCount: clients.filter((c) => c.meter).length,
      ...(clientsError ? { clientsError } : {}),
    };
  }

  async poll() {
    try {
      const payload = await this.buildPayload();
      this.state.lastPollAt = Date.now();
      this.state.lastPayload = payload;
      this.state.lastError = null;
      await this.publishPayload(payload);
    } catch (e) {
      this.state.lastError = e.message;
      console.error("[unifi] poll failed:", e.message);
    }
  }

  publishPayload(payload) {
    return new Promise((resolve, reject) => {
      this.mqtt.publish(
        `wifi/${this.source()}/status`,
        JSON.stringify(payload),
        { qos: 1 },
        (err) => {
          if (err) { this.state.lastError = err.message; reject(err); return; }
          this.state.lastPublishAt = Date.now();
          this.state.publishCount++;
          console.log(`[unifi] published ${payload.devices.length} devices, ${payload.clientCount} clients -> wifi/${this.source()}/status`);
          resolve();
        }
      );
    });
  }

  async live() {
    const [devices, clients] = await Promise.all([this.fetchDevices(), this.fetchClients()]);
    this.state.lastPollAt = Date.now();
    return { devices, clients, fetchedAt: new Date().toISOString() };
  }

  start() { this._restartTimer(); }
  stop() { if (this.timer) clearInterval(this.timer); }
}

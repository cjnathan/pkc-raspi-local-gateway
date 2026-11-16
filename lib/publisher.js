// Scans the Modbus register blocks, decodes them and publishes
// meters/{serial}/readings to MQTT (central perumpkc.com format).
// Publishes only blocks that CHANGED since the last publish and whose
// freq > freqGate (meter alive), so a quiet block generates no traffic.

import mqtt from "mqtt";
import os from "node:os";
import { decodeBlock, toCentralPayload, hashRegs } from "./decode.js";

export class Publisher {
  constructor(modbusStore, config, meters) {
    this.store = modbusStore;
    this.setConfig(config, meters, true);
    this.state = new Map(); // serial -> status
    for (const m of meters) {
      this.state.set(m.devSer, {
        home: m.home, name: m.name, start: m.start,
        lastWriteAt: 0, lastPublishAt: 0, lastChangeSeenAt: 0,
        lastHash: null, decoded: null, payload: null,
        publishCount: 0, lastError: null,
      });
    }
    this.scanTimer = null;
    this.startedAt = Date.now();
    this.totalPublished = 0;
  }

  setConfig(config, meters, initial = false) {
    this.config = config;
    this.freqGate = config.freqGate ?? 1.0;
    this.publishOnlyChanged = config.publishOnlyChanged !== false;
    if (!initial) {
      for (const m of meters) {
        if (!this.state.has(m.devSer)) {
          this.state.set(m.devSer, {
            home: m.home, name: m.name, start: m.start,
            lastWriteAt: 0, lastPublishAt: 0, lastChangeSeenAt: 0,
            lastHash: null, decoded: null, payload: null,
            publishCount: 0, lastError: null,
          });
        }
      }
    }
    this._connectMqtt();
  }

  _connectMqtt() {
    const c = this.config.mqtt;
    if (this.client) this.client.end(true);
    this.client = mqtt.connect({
      host: c.host, port: c.port,
      username: c.username || undefined,
      password: c.password || undefined,
      clientId: (c.clientId || "pkc-gateway") + "-" + os.hostname(),
      keepalive: 60, reconnectPeriod: 5000, connectTimeout: 15000,
    });
    this.client.on("connect", () => console.log(`[mqtt] connected to ${c.host}:${c.port}`));
    this.client.on("error", (e) => console.error("[mqtt] error:", e.message));
    this.client.on("reconnect", () => console.log("[mqtt] reconnecting..."));
  }

  start() {
    const iv = Math.max(1, this.config.scanIntervalSec || 10) * 1000;
    this.scanTimer = setInterval(() => this.scan(), iv);
    console.log(`[publisher] scan every ${iv / 1000}s, ${this.state.size} meters`);
  }

  stop() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.client) this.client.end(true);
  }

  isMqttConnected() {
    return this.client && this.client.connected;
  }

  scan() {
    for (let idx = 0; idx < this.store.meters.length; idx++) {
      const m = this.store.meters[idx];
      const st = this.state.get(m.devSer);
      if (!st) continue;
      st.lastWriteAt = this.store.lastWriteAt[idx] || 0;
      const regs = this.store.getBlock(idx);
      const h = hashRegs(regs);
      const decoded = decodeBlock(regs);
      st.decoded = decoded;
      if (h !== st.lastHash) st.lastChangeSeenAt = Date.now();

      const changed = h !== st.lastHash;
      const alive = (decoded.freq || 0) > this.freqGate;
      if (alive && (!this.publishOnlyChanged || changed)) {
        this._publishDecoded(m.devSer, decoded, st);
      }
      st.lastHash = h;
    }
  }

  _publishDecoded(serial, decoded, st) {
    const payload = {
      timestamp: new Date().toISOString(),
      deviceSerial: serial,
      readings: toCentralPayload(decoded),
    };
    return this._publishRaw(serial, payload, st);
  }

  _publishRaw(serial, payload, st) {
    return new Promise((resolve) => {
      this.client.publish(
        `meters/${serial}/readings`,
        JSON.stringify(payload),
        { qos: 1 },
        (err) => {
          if (err) {
            if (st) st.lastError = err.message;
            console.error(`[publisher] publish failed for ${serial}:`, err.message);
            resolve(false);
          } else {
            if (st) {
              st.lastPublishAt = Date.now();
              st.payload = payload;
              st.publishCount++;
              st.lastError = null;
            }
            this.totalPublished++;
            resolve(true);
          }
        }
      );
    });
  }

  // Manual force-publish from the dashboard.
  async publishNow(serial) {
    const idx = this.store.meters.findIndex((m) => m.devSer === serial);
    if (idx < 0) throw new Error(`unknown serial ${serial}`);
    const st = this.state.get(serial);
    const decoded = decodeBlock(this.store.getBlock(idx));
    if (st) st.decoded = decoded;
    return this._publishDecoded(serial, decoded, st);
  }

  // Simulator: publish hand-entered readings through the same MQTT path.
  async simulate(serial, readings) {
    const st = this.state.get(serial);
    if (st && st.decoded && typeof readings.kwh === "number" && readings.kwh < st.decoded.kwhImport) {
      console.warn(`[simulate] WARNING: kwh ${readings.kwh} < current register ${st.decoded.kwhImport} for ${serial}`);
    }
    const payload = {
      timestamp: new Date().toISOString(),
      deviceSerial: serial,
      readings,
    };
    return this._publishRaw(serial, payload, st);
  }

  overview() {
    const arr = [...this.state.values()];
    return {
      meters: arr.length,
      online: arr.filter((s) => (s.decoded?.freq || 0) > this.freqGate).length,
      published: this.totalPublished,
      mqttConnected: this.isMqttConnected(),
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  list() {
    const now = Date.now();
    return this.store.meters.map((m, idx) => {
      const s = this.state.get(m.devSer) || {};
      const d3 = s.decoded?.ipSegment3, d4 = s.decoded?.ipSegment4;
      return {
        serial: m.devSer, home: m.home, name: m.name, start: m.start,
        online: (s.decoded?.freq || 0) > this.freqGate,
        freq: s.decoded?.freq ?? null,
        kwh: s.decoded?.kwhImport ?? null,
        converterIp: d3 > 0 && d4 > 0 ? `192.168.${d3}.${d4}` : null,
        lastWriteAt: s.lastWriteAt || null,
        secondsSinceWrite: s.lastWriteAt ? Math.floor((now - s.lastWriteAt) / 1000) : null,
        writeCount: this.store.writeCounts[idx] || 0,
        lastPublishAt: s.lastPublishAt || null,
        publishCount: s.publishCount || 0,
        lastError: s.lastError ?? null,
      };
    });
  }

  meterIpIndex() {
    const idx = {};
    for (const [serial, s] of this.state) {
      const d3 = s.decoded?.ipSegment3, d4 = s.decoded?.ipSegment4;
      if (d3 > 0 && d4 > 0) idx[`192.168.${d3}.${d4}`] = { home: s.home, serial };
    }
    return idx;
  }

  detail(serial) {
    const idx = this.store.meters.findIndex((m) => m.devSer === serial);
    if (idx < 0) return null;
    const st = this.state.get(serial);
    const regs = this.store.getBlock(idx);
    return {
      serial, home: st?.home, name: st?.name, start: st?.start,
      writeCount: this.store.writeCounts[idx] || 0,
      rawRegisters: regs,
      decoded: st?.decoded ?? null,
      lastPayload: st?.payload ?? null,
      lastWriteAt: st?.lastWriteAt || null,
      lastPublishAt: st?.lastPublishAt || null,
      publishCount: st?.publishCount ?? 0,
    };
  }
}

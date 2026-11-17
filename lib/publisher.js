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
    this.truth = null;
    this.warned = new Map();
  }

  // Truth-table identity: (converterIp, slaveId) -> house/serial. Canonical.
  // meters.json stays only as the read-where fallback (README_INSTRUCTION_RPI.md).
  setTruthIndex(entries) {
    if (!entries) { this.truth = null; return; }
    const byKey = new Map();
    const byIp = new Map();
    for (const e of entries) {
      if (!e.converterIp) continue;
      if (e.slaveId != null) byKey.set(`${e.converterIp}|${e.slaveId}`, e);
      const arr = byIp.get(e.converterIp);
      if (arr) arr.push(e); else byIp.set(e.converterIp, [e]);
    }
    for (const [ip, arr] of byIp) {
      const live = arr.filter((e) => e.slaveId != null);
      if (live.length > 2) throw new Error(`truth table: ${ip} carries ${live.length} meters (max 2 / D-pair)`);
    }
    this.truth = { byKey, byIp };
  }

  selfIpOf(decoded) {
    return decoded && decoded.ipSegment3 > 0 && decoded.ipSegment4 > 0
      ? `192.168.${decoded.ipSegment3}.${decoded.ipSegment4}` : null;
  }

  identify(selfIp, slaveId) {
    if (!this.truth || !selfIp) return { entry: null, how: "legacy" };
    const exact = this.truth.byKey.get(`${selfIp}|${slaveId}`);
    if (exact) return { entry: exact, how: "ip+slave" };
    const hits = (this.truth.byIp.get(selfIp) || []).filter((e) => e.slaveId != null);
    if (hits.length === 1) return { entry: hits[0], how: "ip" };
    if (hits.length > 1) return { entry: null, how: "ambiguous:" + hits.map((e) => e.home).join("/") };
    return { entry: null, how: "unknown-ip" };
  }

  warnMismatch(slotStart, m, selfIp, slaveId, res, pubSerial) {
    const key = `${slotStart}|${pubSerial}`;
    if (this.warned.has(key)) return;
    this.warned.set(key, true);
    console.warn(`[publisher] MISMATCH: converter ${selfIp} (slave ${slaveId}, ${res.how}) writes slot of ${m.devSer}/${m.home} @${slotStart} — publishing as ${pubSerial} (truth table)`);
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
    if (this.client) { this.client.end(true); this.client = null; }
    this.mqttDownLogged = false;
    this.reconnectLogged = false;
    this.lastMqttErr = null;
    if (!c.host) {
      console.warn("[mqtt] no broker host configured — running offline (publish disabled)");
      return;
    }
    this.client = mqtt.connect({
      host: c.host, port: c.port,
      username: c.username || undefined,
      password: c.password || undefined,
      clientId: (c.clientId || "pkc-gateway") + "-" + os.hostname(),
      keepalive: 60, reconnectPeriod: 5000, connectTimeout: 15000,
    });
    this.client.on("connect", () => {
      this.mqttDownLogged = false;
      this.reconnectLogged = false;
      this.lastMqttErr = null;
      console.log(`[mqtt] connected to ${c.host}:${c.port}`);
    });
    this.client.on("error", (e) => {
      const msg = e.code || e.message || "unknown error";
      if (msg === this.lastMqttErr) return;
      this.lastMqttErr = msg;
      console.error(`[mqtt] error: ${msg} (${c.host}:${c.port})`);
    });
    this.client.on("reconnect", () => {
      if (this.reconnectLogged) return;
      this.reconnectLogged = true;
      console.log("[mqtt] reconnecting...");
    });
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

      const selfIp = this.selfIpOf(decoded);
      const { entry, how } = this.identify(selfIp, decoded.devSlave);
      const pubSerial = entry ? entry.serial : m.devSer;
      if (entry && entry.serial !== m.devSer) this.warnMismatch(m.start, m, selfIp, decoded.devSlave, { entry, how }, pubSerial);

      const changed = h !== st.lastHash;
      const alive = (decoded.freq || 0) > this.freqGate;
      if (alive && (!this.publishOnlyChanged || changed)) {
        this._publishDecoded(pubSerial, decoded, st);
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
    if (!this.client) {
      if (st) st.lastError = "mqtt offline";
      console.warn(`[publisher] publish skipped (mqtt offline): ${serial}`);
      return Promise.resolve(false);
    }
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
    const m = this.store.meters[idx];
    const st = this.state.get(serial);
    const decoded = decodeBlock(this.store.getBlock(idx));
    if (st) st.decoded = decoded;
    const selfIp = this.selfIpOf(decoded);
    const { entry } = this.identify(selfIp, decoded.devSlave);
    const pubSerial = entry ? entry.serial : serial;
    if (entry && entry.serial !== serial && st) this.warnMismatch(m.start, m, selfIp, decoded.devSlave, { entry, how: "publishNow" }, pubSerial);
    return this._publishDecoded(pubSerial, decoded, st);
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
      const { entry } = this.identify(this.selfIpOf(s.decoded), s.decoded?.devSlave);
      return {
        serial: m.devSer, home: m.home, name: m.name, start: m.start,
        identifiedAs: entry && entry.serial !== m.devSer ? { home: entry.home, serial: entry.serial } : null,
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
    for (const s of this.state.values()) {
      const selfIp = this.selfIpOf(s.decoded);
      if (!selfIp) continue;
      const { entry } = this.identify(selfIp, s.decoded.devSlave);
      if (entry) idx[selfIp] = { home: entry.home, serial: entry.serial };
    }
    return idx;
  }

  detail(serial) {
    const idx = this.store.meters.findIndex((m) => m.devSer === serial);
    if (idx < 0) return null;
    const st = this.state.get(serial);
    const regs = this.store.getBlock(idx);
    const decoded = st?.decoded ?? decodeBlock(regs);
    const { entry } = this.identify(this.selfIpOf(decoded), decoded?.devSlave);
    return {
      serial, home: st?.home, name: st?.name, start: st?.start,
      writeCount: this.store.writeCounts[idx] || 0,
      identifiedAs: entry && entry.serial !== serial ? { home: entry.home, serial: entry.serial } : null,
      rawRegisters: regs,
      decoded: st?.decoded ?? null,
      lastPayload: st?.payload ?? null,
      lastWriteAt: st?.lastWriteAt || null,
      lastPublishAt: st?.lastPublishAt || null,
      publishCount: st?.publishCount ?? 0,
    };
  }
}

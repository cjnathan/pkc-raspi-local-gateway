// Raspberry Pi host telemetry: reads local system stats (CPU, temperature,
// memory, disk, uptime), runtime info (node/npm versions, pm2 daemon and
// its process list), connectivity probes (DNS, MQTT broker, gateway, RUT)
// and Raspberry Pi Connect status, then publishes pi/{source}/status.
// Optional — runs only when config.pihost.enabled is true. Zero npm deps;
// everything is read-only local access + a few TCP probes.

import https from "node:https";
import os from "node:os";
import fs from "node:fs";
import net from "node:net";
import dns from "node:dns";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export class PiHost {
  constructor(cfg, mqttClient, essentials) {
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
    this.essentials = essentials || (() => ({}));
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
    if (!this.state.enabled) return;
    const iv = Math.max(60, this.cfg.intervalSec || 300) * 1000;
    this.timer = setInterval(() => this.poll().catch(() => {}), iv);
    setTimeout(() => this.poll().catch(() => {}), 10000);
    console.log(`[pihost] reading host stats every ${iv / 1000}s, source=${this.source()}`);
  }

  start() {
    this._restartTimer();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _rd(p) {
    try { return fs.readFileSync(p, "utf8"); } catch { return null; }
  }

  _cpuSample() {
    const line = (this._rd("/proc/stat") || "").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    return { idle: line[3] + (line[4] || 0), total: line.reduce((a, b) => a + b, 0) };
  }

  _tcp(host, port, timeout = 3000) {
    return new Promise((resolve) => {
      const s = net.connect({ host, port, timeout }, () => { s.destroy(); resolve(true); });
      s.on("error", () => resolve(false));
      s.on("timeout", () => { s.destroy(); resolve(false); });
    });
  }

  async _exec(cmd, args, timeout = 8000) {
    try {
      const { stdout } = await execFileP(cmd, args, { timeout, encoding: "utf8" });
      return stdout.trim();
    } catch { return null; }
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
      console.error("[pihost] poll failed:", e.message);
      return null;
    }
  }

  async publishNow() {
    return this.poll();
  }

  async buildPayload() {
    const errors = [];

    // CPU usage needs a short delta window
    const a = this._cpuSample();
    await new Promise((r) => setTimeout(r, 250));
    const b = this._cpuSample();
    const usagePercent = b.total > a.total ? Math.round((1 - (b.idle - a.idle) / (b.total - a.total)) * 1000) / 10 : null;

    const tempC = parseInt(this._rd("/sys/class/thermal/thermal_zone0/temp"), 10) / 1000 || null;
    const mi = {};
    (this._rd("/proc/meminfo") || "").split("\n").slice(0, 6).forEach((l) => {
      const m = l.match(/(\w+):\s+(\d+) kB/); if (m) mi[m[1]] = +m[2] * 1024;
    });

    const disks = [];
    for (const p of ["/", "/boot/firmware"]) {
      try {
        const s = fs.statfsSync(p);
        const total = s.blocks * s.bsize, free = s.bfree * s.bsize;
        disks.push({ path: p, totalBytes: total, freeBytes: free, usedPercent: Math.round(100 * (total - free) / total) });
      } catch { /* ignore */ }
    }

    // runtime: node is our own process; npm version via exec; pm2 via jlist
    const node = {
      version: process.version,
      pid: process.pid,
      gatewayUptimeSeconds: Math.floor(process.uptime()),
      rssBytes: process.memoryUsage().rss,
      running: true,
    };
    let npm = { available: false, version: null };
    const npmOut = await this._exec("npm", ["--version"], 10000);
    if (npmOut) npm = { available: true, version: npmOut };

    const pm2Home = process.env.PM2_HOME || os.homedir() + "/.pm2";
    let pm2 = { active: false, home: pm2Home, apps: [] };
    const jlistRaw = await this._exec("pm2", ["jlist"], 15000);
    if (jlistRaw) {
      try {
        const apps = JSON.parse(jlistRaw);
        pm2.active = true;
        pm2.apps = apps.map((a) => ({
          name: a.name,
          status: a.pm2_env ? a.pm2_env.status : null,
          pid: a.pid,
          uptimeSeconds: a.pm2_env && a.pm2_env.pm_uptime ? Math.floor((Date.now() - a.pm2_env.pm_uptime) / 1000) : null,
          restarts: a.pm2_env ? a.pm2_env.restart_time : null,
          memoryBytes: a.monit ? a.monit.memory : null,
          cpuPercent: a.monit ? a.monit.cpu : null,
        }));
      } catch (e) { errors.push("pm2 jlist parse: " + e.message); }
    } else {
      errors.push("pm2 jlist unavailable");
    }

    // connectivity probes
    const checkHost = (this.cfg.mqttHost || "perumpkc.com").trim();
    let dnsOk = false, dnsIp = null;
    try {
      dnsOk = true;
      dnsIp = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), 4000);
        dns.resolve4(checkHost, (e, addrs) => { clearTimeout(t); e ? reject(e) : resolve(addrs[0]); });
      });
    } catch { dnsOk = false; }
    const mqttBrokerTcp = await this._tcp(checkHost, 1883);
    const rutReachable = await this._tcp(this.cfg.rutHost || "192.168.10.1", 443);
    let ess = {};
    try { ess = this.essentials() || {}; } catch { /* ignore */ }

    const mem = {
      totalBytes: mi.MemTotal || os.totalmem(),
      availableBytes: mi.MemAvailable != null ? mi.MemAvailable : os.freemem(),
    };

    const pgrepOut = await this._exec("pgrep", ["-af", "rpi-connect"], 5000);
    const rpiConnect = {
      installed: fs.existsSync("/usr/bin/rpi-connect"),
      running: pgrepOut ? /rpi-connectd/.test(pgrepOut) : false,
    };

    return {
      timestamp: new Date().toISOString(),
      source: this.source(),
      host: {
        hostname: os.hostname(),
        model: (this._rd("/proc/device-tree/model") || "").replace(/\0/g, "").trim() || null,
        arch: os.arch(),
        cpus: os.cpus().length,
        kernel: (this._rd("/proc/sys/kernel/osrelease") || "").trim() || null,
        uptimeSeconds: Math.floor(os.uptime()),
      },
      cpu: {
        usagePercent,
        temperatureC: tempC,
        load1: os.loadavg()[0], load5: os.loadavg()[1], load15: os.loadavg()[2],
      },
      memory: {
        totalBytes: mem.totalBytes,
        availableBytes: mem.availableBytes,
        usedBytes: mem.totalBytes - mem.availableBytes,
        usedPercent: mem.totalBytes ? Math.round(100 * (mem.totalBytes - mem.availableBytes) / mem.totalBytes) : null,
      },
      disk: disks,
      network: Object.fromEntries(
        Object.entries(os.networkInterfaces())
          .filter(([k, v]) => !v.every((x) => x.internal))
          .map(([k, v]) => [k, v.filter((x) => x.family === "IPv4").map((x) => x.address).join(", ")])
      ),
      runtime: { node, npm, pm2 },
      connectivity: {
        dnsOk,
        dnsIp,
        mqttBrokerTcp,
        rutReachable,
        gatewayMqttConnected: ess.mqtt ?? null,
        metersOnline: ess.metersOnline ?? null,
        target: checkHost,
      },
      rpiConnect,
      ...(errors.length ? { errors } : {}),
    };
  }

  publishPayload(payload) {
    const client = typeof this.mqttClient === "function" ? this.mqttClient() : this.mqttClient;
    if (!client || !client.connected) {
      this.state.lastError = "mqtt offline";
      console.warn(`[pihost] publish skipped (mqtt offline): pi/${this.source()}/status`);
      return Promise.resolve(false);
    }
    return new Promise((resolve, reject) => {
      client.publish(`pi/${this.source()}/status`, JSON.stringify(payload), { qos: 1 }, (err) => {
        if (err) { this.state.lastError = err.message; reject(err); return; }
        this.state.lastPublishAt = Date.now();
        this.state.lastError = null;
        this.state.publishCount++;
        console.log(`[pihost] published pi/${this.source()}/status (cpu ${payload.cpu && payload.cpu.usagePercent}%, temp ${payload.cpu && payload.cpu.temperatureC}°C, pm2 ${payload.runtime && payload.runtime.pm2.active ? payload.runtime.pm2.apps.length + " apps" : "n/a"})`);
        resolve();
      });
    });
  }
}

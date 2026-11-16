// Modbus TCP server: the field converters (Modbus masters) write their
// meter values into the holding registers, exactly as they did with the
// legacy Node-RED server on the same port and register map.

import ModbusRTU from "modbus-serial";
import { BLOCK_REGS } from "./decode.js";
import os from "node:os";

export class ModbusStore {
  constructor(meters, { port = 10502, unitId = 1, debug = false } = {}) {
    this.meters = [...meters].sort((a, b) => a.start - b.start);
    this.starts = this.meters.map((m) => m.start);
    const maxEnd = this.meters.reduce((mx, m) => Math.max(mx, m.start + BLOCK_REGS), 0);
    this.regs = new Uint16Array(maxEnd);
    this.lastWriteAt = new Array(this.meters.length).fill(0);
    this.writeCounts = new Array(this.meters.length).fill(0);
    this.totalWrites = 0;
    this.debug = debug;
    this.clients = new Map();
    this.lastClient = null;
    this.port = port;
    this.unitId = unitId;
    this.server = null;
    this.startedAt = null;
  }

  meterIndexForRegister(addr) {
    // last meter whose start <= addr
    let lo = 0, hi = this.starts.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] <= addr) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  _recordWrite(addr) {
    const idx = this.meterIndexForRegister(addr);
    if (idx >= 0 && addr - this.starts[idx] < BLOCK_REGS) {
      this.lastWriteAt[idx] = Date.now();
      this.writeCounts[idx]++;
    }
  }

  start() {
    const store = this;
    const vector = {
      getHoldingRegister: (addr) => store.regs[addr] || 0,
      getMultipleHoldingRegisters: (addr, length) => {
        const out = [];
        for (let i = 0; i < length; i++) out.push(store.regs[addr + i] || 0);
        return out;
      },
      setRegister: (addr, value) => {
        store.totalWrites++;
        if (store.debug) console.log(`[modbus] write 1 reg @${addr}`);
        store.regs[addr] = value & 0xffff;
        store._recordWrite(addr);
      },
      setRegisterArray: (addr, values) => {
        store.totalWrites += values.length;
        if (store.debug) console.log(`[modbus] write ${values.length} regs @${addr} (block ${store.meterIndexForRegister(addr)})`);
        for (let i = 0; i < values.length; i++) {
          store.regs[addr + i] = values[i] & 0xffff;
          store._recordWrite(addr + i);
        }
      },
      getCoil: (addr) => false,
      setCoil: () => { /* unused by converters */ },
      readDeviceIdentification: () => ({
        0x00: "PERUM PKC",
        0x01: "node-gateway",
        0x02: "1.0.0",
        0x05: "pkc-gateway-" + os.hostname(),
      }),
    };

    this.server = new ModbusRTU.ServerTCP(vector, {
      host: "0.0.0.0",
      port: this.port,
      debug: false,
      unitID: this.unitId,
    });
    this.startedAt = Date.now();

    this.server.on("initialized", () => {
      console.log(`[modbus] listening on 0.0.0.0:${this.port} (unit ${this.unitId}), ${this.meters.length} meter blocks, ${this.regs.length} registers`);
    });

    const netServer = this.server._server;
    if (netServer) {
      netServer.on("connection", (sock) => {
        const ip = sock.remoteAddress || "?";
        this.clients.set(sock, { ip, since: Date.now() });
        this.lastClient = ip;
        console.log(`[modbus] client connected from ${ip} (${this.clients.size} open)`);
        sock.on("close", () => {
          this.clients.delete(sock);
          console.log(`[modbus] client ${ip} closed (${this.clients.size} open)`);
        });
        sock.on("error", (err) => {
          console.error(`[modbus] socket error from ${ip}: ${err.message}`);
        });
      });
    } else {
      this.server.on("socketError", (err) => {
        console.error("[modbus] socket error:", err.message);
      });
    }
    return this.server;
  }

  stop(cb) {
    if (this.server) this.server.close(cb);
    else if (cb) cb();
  }

  clientCount() {
    return this.clients.size;
  }

  getBlock(idx) {
    const m = this.meters[idx];
    const out = new Array(BLOCK_REGS);
    for (let i = 0; i < BLOCK_REGS; i++) out[i] = this.regs[m.start + i];
    return out;
  }
}

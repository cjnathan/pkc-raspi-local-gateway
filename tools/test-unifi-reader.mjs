// Spin up a fake UniFi controller with a SELF-SIGNED cert (like the
// real one) and verify the reader can log in, tolerate the cert, and
// extract devices — the exact scenario that produced "fetch failed".
import https from "node:https";
import fs from "node:fs";
import { execSync } from "node:child_process";

execSync(`openssl req -x509 -newkey rsa:2048 -keyout /tmp/fake-unifi.key -out /tmp/fake-unifi.crt -days 2 -nodes -subj "/CN=fake-unifi" 2>/dev/null`);

const server = https.createServer(
  { key: fs.readFileSync("/tmp/fake-unifi.key"), cert: fs.readFileSync("/tmp/fake-unifi.crt") },
  (req, res) => {
    if (req.method === "POST" && req.url === "/api/login") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const { username, password } = JSON.parse(b);
        if (username === "pkc-reporter" && password === "secret") {
          res.writeHead(200, { "Set-Cookie": "unifises=abc123; Path=/; Secure; HttpOnly" });
          res.end("{}");
        } else {
          res.writeHead(401); res.end("{}");
        }
      });
      return;
    }
    if (req.url === "/api/s/default/stat/device") {
      if (!req.headers.cookie?.includes("unifises")) { res.writeHead(401); res.end("{}"); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [
        { name: "Antenna-Test1", mac: "DE:AD:BE:EF:00:01", model: "U6-LR", state: 1, num_sta: 5,
          uplink: { type: "wireless", uplink_device_name: "Antenna-Core", signal: -61 },
          channel: 44, "system-stats": { cpu: 21, mem: 40, uptime: 999 } },
      ] }));
      return;
    }
    if (req.url === "/api/s/default/stat/sta") {
      if (!req.headers.cookie?.includes("unifises")) { res.writeHead(401); res.end("{}"); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [
        { name: "ESP_TEST01", mac: "84:f3:eb:00:00:01", ip: "192.168.11.181", ap_mac: "DE:AD:BE:EF:00:01", signal: -80, uptime: 500 },
        { name: "phone", mac: "AA:BB:CC:00:00:02", ip: "192.168.11.200", ap_mac: "DE:AD:BE:EF:00:01", signal: -55, uptime: 900 },
      ] }));
      return;
    }
    res.writeHead(404); res.end("{}");
  }
);

await new Promise((r) => server.listen(18443, "127.0.0.1", r));

const { UnifiReader } = await import("../lib/unifi.js");
const reader = new UnifiReader(
  { enabled: true, url: "https://127.0.0.1:18443", username: "pkc-reporter", password: "secret", site: "default", intervalSec: 1800, source: "test" },
  { publish: (t, m, o, cb) => cb(null) },
  () => ({ "192.168.11.181": { home: "E29", serial: "PCU18070227" } })
);

const payload = await reader.buildPayload();
console.log("payload:", JSON.stringify(payload));
if (payload.devices[0].name !== "Antenna-Test1" || payload.devices[0].uplinkSignal !== -61) {
  console.log("FAIL: unexpected extraction"); process.exit(1);
}
const cl = payload.clients;
if (!cl || cl.length !== 2 || cl[0].meter?.home !== "E29" || cl[0].meter?.serial !== "PCU18070227" || cl[1].meter !== null || cl[0].ap !== "Antenna-Test1" || payload.meterCount !== 1) {
  console.log("FAIL: client correlation wrong"); process.exit(1);
}
console.log("client correlation OK: ESP_TEST01 → E29/PCU18070227, phone → null, AP name resolved");

// wrong password must give a helpful error, not "fetch failed"
const bad = new UnifiReader(
  { enabled: true, url: "https://127.0.0.1:18443", username: "pkc-reporter", password: "WRONG", site: "default", intervalSec: 1800, source: "test" },
  { publish: (t, m, o, cb) => cb(null) }
);
try { await bad.buildPayload(); console.log("FAIL: expected 401"); process.exit(1); }
catch (e) { console.log("wrong-password error:", e.message); }

// unreachable host must name the real cause
const dead = new UnifiReader(
  { enabled: true, url: "https://127.0.0.1:19999", username: "x", password: "x", site: "default", intervalSec: 1800, source: "test" },
  { publish: (t, m, o, cb) => cb(null) }
);
try { await dead.buildPayload(); }
catch (e) { console.log("unreachable error:", e.message); }

console.log("ALL CHECKS DONE");
server.close();
process.exit(0);

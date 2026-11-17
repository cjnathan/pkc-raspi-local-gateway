// Dashboard web server: single page (public/index.html) + JSON APIs.
// LAN-only by design (the Pi firewall from setup-os.sh restricts access).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startWeb({ port, host, publisher, unifi, store, rut, pihost, configPath, metersPath, onConfigSaved }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (code, data) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const readBody = () => new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => { b += c; if (b.length > 5e6) req.destroy(); });
      req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve(null); } });
    });

    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/overview") {
        return send(200, {
          publisher: publisher.overview(),
          modbus: {
            port: store.port,
            registers: store.regs.length,
            startedAt: store.startedAt,
            openClients: store.clientCount ? store.clientCount() : undefined,
            totalRegisterWrites: store.totalWrites,
          },
          unifi: unifi.state,
          rut: rut ? rut.state : undefined,
          pihost: pihost ? pihost.state : undefined,
        });
      }

      if (req.method === "GET" && url.pathname === "/api/meters") {
        return send(200, publisher.list());
      }

      const mDetail = url.pathname.match(/^\/api\/meters\/([^/]+)$/);
      if (req.method === "GET" && mDetail) {
        const d = publisher.detail(decodeURIComponent(mDetail[1]));
        return d ? send(200, d) : send(404, { error: "unknown serial" });
      }

      const mPub = url.pathname.match(/^\/api\/meters\/([^/]+)\/publish$/);
      if (req.method === "POST" && mPub) {
        const ok = await publisher.publishNow(decodeURIComponent(mPub[1]));
        return ok ? send(200, { ok: true }) : send(502, { error: "publish failed (MQTT down?)" });
      }

      if (req.method === "POST" && url.pathname === "/api/simulate") {
        const body = await readBody();
        if (!body || !body.serial || !body.readings) return send(400, { error: "serial and readings required" });
        const nums = {};
        for (const [k, v] of Object.entries(body.readings)) {
          const n = Number(v);
          if (!Number.isFinite(n)) return send(400, { error: `readings.${k} is not a number` });
          nums[k] = n;
        }
        const ok = await publisher.simulate(body.serial, nums);
        return ok ? send(200, { ok: true }) : send(502, { error: "publish failed (MQTT down?)" });
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        return send(200, {
          config: JSON.parse(fs.readFileSync(configPath, "utf8")),
          meters: JSON.parse(fs.readFileSync(metersPath, "utf8")),
          configPath, metersPath,
        });
      }

      if (req.method === "POST" && url.pathname === "/api/config") {
        const body = await readBody();
        if (!body) return send(400, { error: "invalid JSON" });
        if (body.config) fs.writeFileSync(configPath, JSON.stringify(body.config, null, 2) + "\n", { mode: 0o600 });
        if (body.meters) fs.writeFileSync(metersPath, JSON.stringify(body.meters, null, 2) + "\n", { mode: 0o600 });
        const restartRequired = await onConfigSaved(body.config || null, body.meters || null);
        return send(200, { ok: true, restartRequired });
      }

      if (req.method === "GET" && url.pathname === "/api/unifi/live") {
        if (!unifi.state.enabled) return send(400, { error: "unifi disabled in config" });
        return send(200, await unifi.live());
      }

      if (req.method === "POST" && url.pathname === "/api/unifi/publish-now") {
        if (!unifi.state.enabled) return send(400, { error: "unifi disabled in config" });
        const payload = await unifi.buildPayload();
        unifi.state.lastPayload = payload;
        await unifi.publishPayload(payload);
        return send(200, { ok: true, devices: payload.devices.length });
      }

      if (req.method === "POST" && url.pathname === "/api/rut/publish-now") {
        if (!rut || !rut.state.enabled) return send(400, { error: "rut241 disabled in config" });
        const payload = await rut.publishNow();
        return send(200, { ok: true, source: payload && payload.source });
      }

      if (req.method === "POST" && url.pathname === "/api/pi/publish-now") {
        if (!pihost || !pihost.state.enabled) return send(400, { error: "pihost disabled in config" });
        const payload = await pihost.publishNow();
        return send(200, { ok: true, source: payload && payload.source });
      }

      send(404, { error: "not found" });
    } catch (e) {
      send(500, { error: e.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`[web] dashboard on http://${host}:${port}`);
      resolve(server);
    });
  });
}

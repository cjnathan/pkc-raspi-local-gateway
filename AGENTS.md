# AGENTS.md — pkc-node-gateway

Single-process Node.js gateway running on a Raspberry Pi. It replaces a legacy Node-RED flow and does four jobs in one process:

1. **Modbus TCP server (slave)** on :10502 — field house converters (Modbus masters) *write* meter values into holding registers. This gateway does not poll meters; it is written to.
2. **MQTT publisher** — scans register blocks on a timer, decodes them, publishes `meters/{serial}/readings` (QoS 1) to the MQTT broker.
3. **UniFi reader** — polls the local UniFi controller REST API and publishes `wifi/{source}/status`.
4. **Web dashboard** — single-page UI (`public/index.html`) + JSON API on :8090, LAN-only, no auth (protected by the Pi firewall from the separate `setup-os.sh`).

The MQTT broker is the **local** Mosquitto (127.0.0.1:1883) installed by a separate `install-mosquitto-bridge.sh` which bridges to perumpkc.com. Readings queue locally during internet outages — do not assume the gateway talks to the central server directly.

## Commands

```bash
npm start                     # runs node gateway.js (no build step, no linter, no test framework)

# Tests are ad-hoc scripts, not a suite:
node tools/test-write-block.mjs   # simulates field converters writing blocks @0/@100; targets :10502, override with PKC_MODBUS_PORT (e.g. to test a local instance on another port without touching production)
node tools/test-unifi-reader.mjs  # self-contained; spins a fake self-signed UniFi controller on :18443 (needs openssl)

# Regenerate meters.json from the legacy devSerNum.txt mapping:
node tools/generate-meters-json.js /path/to/devSerNum.txt [out.json]
```

### Deployment (this matters)

Production runs from **`/opt/pkc/node-gateway`** under pm2 (app name `pkc-gateway`), *not* from this dev directory (`~/Desktop/deploy/raspberry-pi/node-gateway`). Install with:

```bash
sudo bash install-node-gateway.sh --mqtt-user <u> --mqtt-pass '<p>' [--mqtt-host 127.0.0.1] [--mqtt-port 1883] [--web-port 8090]
```

- The script copies source into `/opt/pkc/node-gateway`, writes `gateway.config.json`, runs `npm install`, and `pm2 start`s the ecosystem file.
- **`meters.json` is only copied if it doesn't already exist in the install dir** — re-installing never clobbers a live register map.
- Logs: `pm2 logs pkc-gateway`, or `/var/log/pkc-gateway/{out,error}.log`.
- After editing source here, changes do nothing until you re-run the install script (or copy files) and `pm2 restart pkc-gateway`.

## Configuration

- `gateway.config.json` — gitignored, mode 0600 (holds the MQTT password). Auto-created with defaults on first run if missing. Path overridable via `PKC_GATEWAY_CONFIG`; meters via `PKC_GATEWAY_METERS`.
- `meters.json` — required. Program exits at startup if missing/empty; there is no default. Entries: `{start, name, devSer: "PCU…", home}` where `start` is the Modbus holding-register block base (blocks are 100 regs, so starts are 0, 100, 200, …).
- The dashboard Configuration tab edits both files live via `POST /api/config`.

### Hot-reload semantics (non-obvious)

`onConfigSaved` in gateway.js applies config changes live, with caveats encoded in behavior:

- MQTT host/port/username changes → MQTT client is torn down and reconnected.
- `meters.json` reload applies **only to NEW writes**: the `Uint16Array` register backing store is not reallocated, so a changed register map leaves old register values in place.
- Modbus port or web host/port changes require a process restart; the API returns `restartRequired: true` and the dashboard shows it.

## Register map contract (lib/decode.js)

The 100-register block layout is the wire contract with every field converter — it is byte-for-byte identical to the legacy Node-RED flow:

- reg 0: `isOnline` (int16), reg 1: `ipSegment3`, reg 2: `ipSegment4`, reg 3: `devSlave`
- regs 4..47: 22 **big-endian float32** values, 2 regs each, in the order of `FLOAT_FIELDS` in decode.js (volts, currents, freq, pf, power totals, then energy registers ending `kwhExport`, `kwhTotal`).

Energy semantics: published `kwh` = `kwhImport`, a **cumulative always-increasing register**. Consumption is computed server-side (perumpkc.com) as a delta between readings. Never publish a decreasing kwh — the simulate endpoint warns but does not block.

Publisher gating: a block is "alive" when decoded `freq > freqGate` (default 1.0 Hz); with `publishOnlyChanged` (default true) only blocks whose register hash changed are published, so a quiet/dead meter generates no traffic. `tools/test-write-block.mjs` exists precisely because a freshly-started gateway publishes nothing until something writes registers.

## Architecture notes per module

- `lib/modbus.js` — `ModbusStore`: in-memory `Uint16Array` behind modbus-serial's `ServerTCP`. Tracks per-meter `lastWriteAt`/`writeCounts` via binary search on block starts (meters are kept sorted by `start`; Publisher indexes into `store.meters` by array position, so these two classes share that ordering assumption). Logs client connects/closes/errors with remote IP and per-block write ops when `config.modbus.debug` is true (toggled live from the dashboard config, no restart needed). Exposes `clientCount()`/`totalWrites`; `/api/overview.modbus` carries `openClients`/`totalRegisterWrites`, `/api/meters` rows carry `writeCount`.

### ECONNRESET in the logs

`[modbus] socket error: read ECONNRESET` is **client-side noise, not lost data**: field converters open TCP, write, then drop the connection abruptly (RST instead of FIN), and modbus-serial surfaces each reset as a `socketError`. The server never closes connections itself (no idle timeout; only `.close()` at shutdown). Verified experimentally: a client that writes a block and immediately destroys its socket still has its registers stored — the write is processed before the reset arrives. Typical volume on this deployment is 100–170 resets/day across ~16 active converters, harmless. With the connection logging above, resets now name the source IP.
- `lib/publisher.js` — `Publisher`: scan loop, MQTT client, per-serial state map keyed by `devSer`. Also exposes `publishNow(serial)` (dashboard force-publish) and `simulate(serial, readings)` (dashboard hand-entry through the same MQTT path).
- `lib/unifi.js` — `UnifiReader`: zero npm deps, raw `node:https`. Uses `rejectUnauthorized: false` **on purpose** — the UniFi controller serves a self-signed cert and the original Python reporter ignored it too. Login uses the controller *username* (not email); errors are phrased to point at that. The `source` (Pi hostname by default) is just a topic label; zone grouping is decided server-side, not here. **Endpoint gotcha**: this controller serves `/api/s/{site}/stat/device` (SINGULAR); the plural `stat/devices` returns 404 `api.err.NotFound` even though login and `/api/self/sites` work — a 404 here is an endpoint-name problem, not necessarily a bad site.

### WiFi MQTT payload contract (wifi/{source}/status, QoS 1, every `unifi.intervalSec` + manual publish-now)

```json
{
  "timestamp": "ISO",
  "zone": "<source/hostname>",
  "devices":  [ { name, mac, model, state, uplinkType, uplinkParent, uplinkSignal, channel, clientCount, cpu, memory, uptimeSec } ],
  "clients":  [ { name, mac, ip, apMac, ap, signal, uptimeSec, meter: {home, serial} | null } ],
  "clientCount": <sum of per-AP client counts>,
  "meterCount": <clients with meter != null>,
  "clientsError": "<only present if the clients endpoint failed>"
}
```

`devices` shape is the legacy Python-reporter format (unchanged); `clients` is additive (2026-11). `meter` is filled by matching the client's IP against each meter block's self-reported converter IP (regs 1/2 of the register block, `192.168.{seg3}.{seg4}`) — i.e. the ESP's own claim, cross-checked against the block it writes. `meterCount` reads 0 right after a gateway restart and refills as converters re-write their blocks (publish is every 30 min; dashboard "Publish now" forces it).
- `lib/web.js` — bare `node:http`, no framework: static `index.html` + JSON endpoints (`/api/overview`, `/api/meters[.../publish]`, `/api/simulate`, `/api/config` GET/POST, `/api/unifi/*`). All errors funnel into a 500 `{error}` JSON.
- `public/index.html` — single-file dashboard (inline JS, no build step). Metering tab has Block (leading letters of `home`, e.g. "E02" → "E") and online/offline filters, both client-side over `/api/meters`. Clicking a row shows raw registers plus the converter's self-reported IP (regs 1/2 → `192.168.{seg3}.{seg4}`) matched by last-two-octets against `/api/unifi/live` clients (cached 60s in the page; those matches are the ESP_* WiFi converters). `/api/meters` rows carry `converterIp`; the WiFi tab auto-loads the live view on open, refreshes it every 30s while visible, and highlights clients whose IP matches a meter (Meter column). Note the backend libs load once at startup: HTML edits are visible immediately, but lib/ changes need a process restart even though the page re-reads per request.
- `gateway.js` — wiring + config bootstrap + SIGINT/SIGTERM shutdown (modbus close, MQTT end, 3s hard exit).

## Conventions

- **ESM only** (`"type": "module"`, Node >= 18): `import` syntax throughout, no `require`.
- Only two runtime deps (`modbus-serial`, `mqtt`); keep it that way — the UniFi reader deliberately avoids libraries, and install uses `npm install --omit=dev`.
- Console logs are prefixed by component: `[modbus]`, `[mqtt]`, `[publisher]`, `[unifi]`, `[web]`, `[gateway]` — keep new logs consistent.
- One exported class per lib file; config passed in and applied via `setConfig()` so components survive hot config changes.
- No tests framework, no CI, no lint config — verification is the two `tools/` scripts plus exercising the dashboard API.

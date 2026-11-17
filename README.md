# pkc-raspi-local-gateway

Single-process **Node.js gateway for a Raspberry Pi 5** that replaces the old
Node-RED flow of the PKC metering network. It talks to ~277 house power
meters over Modbus TCP, publishes their readings to the central server
(perumpkc.com) over MQTT, monitors the UniFi WiFi network and the Teltonika
LTE router, and serves a small operations dashboard for humans.

```
  house meters (ESP32 converters, WiFi)      UniFi AC Mesh APs
            │  Modbus TCP writes                    │ CAPsIP
            ▼                                       ▼
   ┌──────────────────────────────────────────────────────┐
   │              Raspberry Pi 5 (this repo)              │
   │  gateway.js  :10502 Modbus server (converters WRITE) │
   │              :8090  dashboard (LAN, no auth)         │
   │  UniFi controller :8443  ·  MongoDB :27117           │
   └──────────────┬───────────────────────────┬───────────┘
                  │ MQTT (QoS 1)              │ HTTPS REST (local)
                  ▼                           ▼
          perumpkc.com (central)      Teltonika RUT241 (LTE uplink)
```

## What runs where

| Process | Port | Purpose |
|---|---|---|
| **gateway.js** (pm2: `pkc-gateway`) | 10502 | Modbus TCP **server** — house converters *write* their 100-register block every few minutes |
| | 8090 | Dashboard: Metering, Access Points, WiFi/UniFi, Router, Pi host, Configuration |
| | → MQTT | `meters/{serial}/readings` (kWh + electrical readings, QoS 1) |
| **lib/unifi.js** | → MQTT | `wifi/{source}/status`: APs + WiFi clients, each client matched to its house meter |
| **lib/rut241.js** | → MQTT | `router/{source}/status`: LTE signal, connectivity, daily data usage (quota) |
| **lib/pihost.js** | → MQTT | `pi/{source}/status`: CPU/temp/memory/disk, node/npm/pm2 status, connectivity |
| **UniFi controller 9.4.19** | 8443 | Self-hosted, manages the AC Mesh APs (uses its own MongoDB on 127.0.0.1:27117) |
| **Teltonika RUT241** | 192.168.10.1 | LTE uplink (Telkomsel) — polled by the gateway for signal + usage |

## Dashboard (:8090, LAN only)

| Tab | What you see |
|---|---|
| **Metering (Modbus → MQTT)** | all 277 register slots, block + online/offline filters, per-slot raw registers, true house identity (`E04 → C01` style when the truth table disagrees with the matrix), force-publish |
| **Access Points** | every UniFi AP with uplink/state/signal, and the clients connected to it — house meters are highlighted with their home code |
| **WiFi / UniFi** | controller status, AP/client tables (clients matched to meters), published MQTT payload, plus Router (RUT241) and Raspberry Pi host cards |
| **Configuration** | live editor for `gateway.config.json` and `meters.json` |

Header pills always show: MQTT link, meters online, publishes, Modbus clients, RUT signal/usage, Pi temp/RAM/pm2.

## Meter identity: the truth table (important!)

`meters.json` (register `start` → serial → house) only decides **where to
read**. It does **not** prove identity. Each converter writes its **own IP**
(regs 1-2) and **slave ID** (reg 3) into the block it fills, so the gateway
attributes every block by `(converterIp, slaveId)` using
**`truth-table.json`** — the operator-confirmed matrix.

Field reality: 21+ live converters are B/C devices flashed with E/DD register
starts. With the old register-keying their readings were published under the
wrong houses; the gateway now publishes under the **truth serial** and logs a
`MISMATCH` warning per slot. Full background: [`README_INSTRUCTION_RPI.md`](README_INSTRUCTION_RPI.md).

## Installing

### Fresh Raspberry Pi (recommended)

Replicates the whole stack: Node 20 + pm2 7, MongoDB 8.0 arm64, UniFi
controller 9.4.19, this gateway under pm2, config generated.

```bash
git clone https://github.com/cjnathan/pkc-raspi-local-gateway.git
cd pkc-raspi-local-gateway
sudo bash install-fresh-pi.sh
# secrets (MQTT/UniFi/RUT passwords) are asked interactively, or set env vars:
#   MQTT_USER=... MQTT_PASS=... UNIFI_PASS=... RUT_PASS=... \
#   RESTORE_UNIFI_BACKUP=/path/to/backup.unf sudo bash install-fresh-pi.sh
```

After it finishes: open `https://<pi-ip>:8443` and complete the UniFi wizard
(create the admin, optionally restore a `.unf` backup to get APs/users back),
then open `http://<pi-ip>:8090`.

### Existing Pi (gateway only)

```bash
sudo bash install-node-gateway.sh --mqtt-user <u> --mqtt-pass '<p>'
```

Copies the code to `/opt/pkc/node-gateway`, generates `gateway.config.json`
(never overwrites an existing config or `meters.json`), installs deps and
starts `pkc-gateway` under pm2.

## Configuration

`gateway.config.json` (mode 600, gitignored — holds passwords). Edited live
from the dashboard Configuration tab.

| Section | What it controls | Hot-reload |
|---|---|---|
| `modbus` | port (10502), unit id, `debug` (per-write logging) | no — restart |
| `mqtt` | broker host/port/credentials (local Mosquitto bridge or perumpkc.com direct) | yes — reconnects |
| `web` | dashboard host/port (8090) | no — restart |
| `unifi` | controller url/credentials/site, publish interval | yes |
| `rut241` | `enabled`, router url/credentials, interval (1800 s) | yes |
| `pihost` | `enabled`, publish interval (300 s) | yes |
| top level | `scanIntervalSec` (10), `freqGate` (1 Hz), `publishOnlyChanged` | yes |

Env overrides: `PKC_GATEWAY_CONFIG`, `PKC_GATEWAY_METERS`.

## MQTT topics (consumed by the central server)

| Topic | Every | Payload highlights |
|---|---|---|
| `meters/{serial}/readings` | 10 s scan, gated | `kwh` (cumulative — consumption = server-side delta), volts, currents, power, freq, pf |
| `wifi/{source}/status` | 30 min | 26 APs + every WiFi client with `meter: {home, serial}` when it is a house converter |
| `router/{source}/status` | 30 min | LTE RSRP/RSRQ/SINR, connection state, daily rx/tx history (quota), uptime, temp |
| `pi/{source}/status` | 5 min | CPU/temp/mem/disk, node/npm/pm2 status + process list, connectivity probes, rpi-connect |

`{source}` is the Pi hostname. Full payload schemas: [`AGENTS.md`](AGENTS.md).

## Operating

```bash
pm2 restart pkc-gateway     # apply changes that need a restart
pm2 logs pkc-gateway        # tail logs
```

- Only `lib/` changes need a restart; `public/index.html` re-reads per request.
- `[modbus] socket error: read ECONNRESET` = converters dropping WiFi
  abruptly (weak signal, −80…−87 dBm on some APs). Harmless: writes land
  before the reset. The connection log names the source IP.
- `[publisher] MISMATCH: converter … writes slot of … — publishing as …` =
  truth-table reattribution in action; fix the field, not the warning.
- Readings only publish for blocks with `freq > freqGate` — a quiet meter
  generates no traffic by design. A freshly restarted gateway publishes
  nothing until converters write.

## Files

| File | Purpose |
|---|---|
| `gateway.js` + `lib/` | the gateway (one process, four jobs) |
| `meters.json` | register matrix (read-map): `start` → serial → house |
| `truth-table.json` | **canonical identity**: `(converterIp, slaveId)` → house/serial |
| `public/index.html` | the dashboard (single file, inline JS, no build) |
| `tools/` | meter-matrix generator, Modbus write simulator, UniFi fake-controller test |
| `install-fresh-pi.sh` | full fresh-Pi provisioning (Node, pm2, MongoDB, UniFi 9.4.19, gateway) |
| `install-node-gateway.sh` | gateway-only install on an existing Pi |
| [`README_INSTRUCTION_RPI.md`](README_INSTRUCTION_RPI.md) | identity model deep-dive + field survey |
| [`README_UNIFI_QUOTA_GUARD.md`](README_UNIFI_QUOTA_GUARD.md) | protect the LTE quota from phones/laptops (UniFi setup) |
| [`AGENTS.md`](AGENTS.md) | coding conventions, API notes, MQTT payload contracts |

## Requirements

- Raspberry Pi (64-bit OS, Debian 12 bookworm tested) — Pi 5 used here
- Node.js ≥ 20 (NodeSource), pm2 7
- UniFi Network Application 9.4.19 + MongoDB 8.0 arm64 (only if self-hosting the controller)
- Two runtime npm deps only: `modbus-serial`, `mqtt`

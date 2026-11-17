#!/usr/bin/env node
// PKC node-gateway: Modbus TCP server (:10502) + meter publisher +
// UniFi reader + dashboard. One process, managed by pm2.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ModbusStore } from "./lib/modbus.js";
import { Publisher } from "./lib/publisher.js";
import { UnifiReader } from "./lib/unifi.js";
import { Rut241 } from "./lib/rut241.js";
import { PiHost } from "./lib/pihost.js";
import { startWeb } from "./lib/web.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.PKC_GATEWAY_CONFIG || path.join(__dirname, "gateway.config.json");
const METERS_PATH = process.env.PKC_GATEWAY_METERS || path.join(__dirname, "meters.json");

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

let config = loadJson(CONFIG_PATH, null);
if (!config) {
  config = {
    modbus: { port: 10502, unitId: 1 },
    scanIntervalSec: 10,
    freqGate: 1.0,
    publishOnlyChanged: true,
    mqtt: { host: "127.0.0.1", port: 1883, username: "", password: "", clientId: "pkc-gateway" },
    web: { host: "0.0.0.0", port: 8090 },
    unifi: { enabled: false, url: "https://127.0.0.1:8443", username: "", password: "", site: "default", intervalSec: 1800, source: "" },
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`[gateway] created default config at ${CONFIG_PATH} — edit it via the dashboard`);
}
const TRUTH_PATH = path.join(__dirname, "truth-table.json");

function loadTruth() {
  const t = loadJson(TRUTH_PATH, null);
  if (!t || !Array.isArray(t.entries)) {
    console.warn("[gateway] truth-table.json missing/invalid — running legacy register-keyed attribution");
    return null;
  }
  return t.entries;
}

let meters = loadJson(METERS_PATH, null);
if (!Array.isArray(meters) || meters.length === 0) {
  console.error(`[gateway] ${METERS_PATH} missing or empty — generate it with tools/generate-meters-json.js`);
  process.exit(1);
}
if (!config.unifi.source) config.unifi.source = os.hostname();
if (!config.rut241) config.rut241 = { enabled: false, url: "https://192.168.10.1", username: "admin", password: "", intervalSec: 1800, source: "" };
if (!config.pihost) config.pihost = { enabled: false, intervalSec: 300, source: "" };

const store = new ModbusStore(meters, config.modbus);
const publisher = new Publisher(store, config, meters);
try {
  publisher.setTruthIndex(loadTruth());
  if (publisher.truth) console.log(`[gateway] truth table loaded: ${publisher.truth.byKey.size} ip|slave identities`);
} catch (e) {
  console.error("[gateway] refusing to start:", e.message);
  process.exit(1);
}
const unifi = new UnifiReader(config.unifi, publisher.client, () => publisher.meterIpIndex());
const rut = new Rut241(config.rut241, () => publisher.client);
const pihost = new PiHost(config.pihost, () => publisher.client, () => ({ mqtt: publisher.isMqttConnected(), metersOnline: publisher.overview().online }));
store.start();
publisher.start();
if (config.unifi.enabled) unifi.start();

// Config hot-apply: MQTT endpoint / meters / scan settings apply live;
// Modbus port or web port changes need a process restart.
async function onConfigSaved(newConfig, newMeters) {
  let restartRequired = false;
  if (newConfig) {
    restartRequired =
      newConfig.modbus?.port !== config.modbus.port ||
      newConfig.web?.port !== config.web.port ||
      newConfig.web?.host !== config.web.host;
    if (!newConfig.unifi.source) newConfig.unifi.source = os.hostname();
    store.debug = !!newConfig.modbus?.debug;
    try { publisher.setTruthIndex(loadTruth()); } catch (e) { console.error("[gateway] truth table reload failed, keeping previous:", e.message); }
    const prevMqttHost = config.mqtt.host, prevMqttPort = config.mqtt.port, prevMqttUser = config.mqtt.username;
    config = newConfig;
    if (
      newConfig.mqtt.host !== prevMqttHost || newConfig.mqtt.port !== prevMqttPort ||
      newConfig.mqtt.username !== prevMqttUser
    ) {
      publisher.setConfig(config, newMeters || meters);
      unifi.setConfig(config.unifi, publisher.client);
    } else {
      publisher.setConfig({ ...config }, newMeters || meters, true); // only rescan settings
    }
    unifi.setConfig(config.unifi, publisher.client);
    rut.setConfig(config.rut241, () => publisher.client);
    pihost.setConfig(config.pihost, () => publisher.client);
  }
  if (Array.isArray(newMeters) && newMeters.length) {
    meters = newMeters;
    console.log(`[gateway] meters.json reloaded: ${meters.length} entries (register map changes apply to NEW writes)`);
  }
  return restartRequired;
}

startWeb({ ...config.web, publisher, unifi, store, rut, pihost, configPath: CONFIG_PATH, metersPath: METERS_PATH, onConfigSaved });

function shutdown() {
  console.log("[gateway] shutting down...");
  publisher.stop();
  unifi.stop();
  rut.stop();
  pihost.stop();
  store.stop(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

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
let meters = loadJson(METERS_PATH, null);
if (!Array.isArray(meters) || meters.length === 0) {
  console.error(`[gateway] ${METERS_PATH} missing or empty — generate it with tools/generate-meters-json.js`);
  process.exit(1);
}
if (!config.unifi.source) config.unifi.source = os.hostname();

const store = new ModbusStore(meters, config.modbus);
const publisher = new Publisher(store, config, meters);
const unifi = new UnifiReader(config.unifi, publisher.client, () => publisher.meterIpIndex());
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
  }
  if (Array.isArray(newMeters) && newMeters.length) {
    meters = newMeters;
    console.log(`[gateway] meters.json reloaded: ${meters.length} entries (register map changes apply to NEW writes)`);
  }
  return restartRequired;
}

startWeb({ ...config.web, publisher, unifi, store, configPath: CONFIG_PATH, metersPath: METERS_PATH, onConfigSaved });

function shutdown() {
  console.log("[gateway] shutting down...");
  publisher.stop();
  unifi.stop();
  store.stop(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

#!/usr/bin/env bash
# Install the PKC node-gateway (Modbus server + MQTT publisher + UniFi
# reader + dashboard) as a pm2 service.
#
# Usage:
#   sudo bash install-node-gateway.sh \
#        --mqtt-user perumpkc --mqtt-pass '<CENTRAL_MQTT_PASSWORD>' \
#        [--mqtt-host 127.0.0.1] [--mqtt-port 1883] [--web-port 8090]
#
# Requires: nodejs >= 18, pm2 (npm install -g pm2).
# MQTT defaults to the LOCAL broker (127.0.0.1) as installed by
# install-mosquitto-bridge.sh, which bridges to perumpkc.com — that is
# the recommended path (readings queue during internet outages).
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run with sudo" >&2; exit 1; fi

MQTT_USER=""; MQTT_PASS=""; MQTT_HOST="127.0.0.1"; MQTT_PORT="1883"; WEB_PORT="8090"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mqtt-user) MQTT_USER="$2"; shift 2 ;;
    --mqtt-pass) MQTT_PASS="$2"; shift 2 ;;
    --mqtt-host) MQTT_HOST="$2"; shift 2 ;;
    --mqtt-port) MQTT_PORT="$2"; shift 2 ;;
    --web-port)  WEB_PORT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
if [[ -z $MQTT_USER || -z $MQTT_PASS ]]; then
  echo "Usage: sudo bash install-node-gateway.sh --mqtt-user <u> --mqtt-pass <p> [--mqtt-host 127.0.0.1] [--mqtt-port 1883] [--web-port 8090]" >&2
  exit 1
fi

command -v node >/dev/null || { echo "nodejs >= 18 required" >&2; exit 1; }
command -v pm2  >/dev/null || { echo "pm2 required (npm install -g pm2)" >&2; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="/opt/pkc/node-gateway"
mkdir -p "$INSTALL_DIR" /var/log/pkc-gateway

echo "== Installing node-gateway to $INSTALL_DIR =="
cp -r "$SRC"/gateway.js "$SRC"/lib "$SRC"/public "$SRC"/tools "$SRC"/package.json "$SRC"/ecosystem.config.js "$INSTALL_DIR"/
if [[ ! -f "$INSTALL_DIR/meters.json" ]]; then
  cp "$SRC"/meters.json "$INSTALL_DIR"/meters.json
  echo "meters.json installed (edit via dashboard if the mapping changes)"
fi

if [[ ! -f "$INSTALL_DIR/gateway.config.json" ]]; then
  cat > "$INSTALL_DIR/gateway.config.json" <<EOF
{
  "modbus": { "port": 10502, "unitId": 1 },
  "scanIntervalSec": 10,
  "freqGate": 1.0,
  "publishOnlyChanged": true,
  "mqtt": { "host": "${MQTT_HOST}", "port": ${MQTT_PORT}, "username": "${MQTT_USER}", "password": "${MQTT_PASS}", "clientId": "pkc-gateway" },
  "web": { "host": "0.0.0.0", "port": ${WEB_PORT} },
  "unifi": { "enabled": false, "url": "https://127.0.0.1:8443", "username": "", "password": "", "site": "default", "intervalSec": 1800, "source": "" }
}
EOF
else
  echo "gateway.config.json already exists - keeping it (edit via dashboard)"
fi
chmod 600 "$INSTALL_DIR/gateway.config.json"

echo "== Installing npm dependencies =="
cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund

echo "== Starting under pm2 =="
pm2 start "$INSTALL_DIR/ecosystem.config.js" || pm2 restart pkc-gateway
pm2 save

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<EOF

Done.
  Dashboard : http://${IP:-<pi-ip>}:${WEB_PORT}   (LAN only - keep the firewall from setup-os.sh)
  Modbus    : port 10502, register map per meters.json
  Logs      : pm2 logs pkc-gateway
  UniFi     : enable in the dashboard Configuration tab (controller user must be read-only)
EOF

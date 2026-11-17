#!/usr/bin/env bash
# ============================================================================
# install-fresh-pi.sh — bring a fresh Raspberry Pi OS to the pkc-gateway state
#
# Replicates the production Pi (raspberrypi, Debian 12 bookworm, arm64):
#   1. System basics: hostname, timezone, SSH, boot-wait-for-network
#   2. Node.js 20.x (NodeSource) + npm  +  pm2 7.x global
#   3. MongoDB 8.0 for arm64 (GlennR mongod package, used by UniFi)
#      + mongodb database tools / mongosh
#   4. UniFi Network Application 9.4.19 (openjdk-17, self-hosted, port 8443;
#      UniFi's own init starts /usr/bin/mongod on 127.0.0.1:27117)
#   5. node-gateway deployed to /opt/pkc/node-gateway, config generated,
#      run under pm2 as user "raspberrypi" (app name: pkc-gateway)
#
# Usage:
#   git clone https://github.com/cjnathan/pkc-raspi-local-gateway.git
#   cd pkc-raspi-local-gateway
#   sudo bash install-fresh-pi.sh
#
# Secrets are NOT hardcoded. Provide them as environment variables or you
# will be prompted interactively:
#   MQTT_HOST   (default perumpkc.com)   MQTT_PORT (default 1883)
#   MQTT_USER   MQTT_PASS
#   UNIFI_USER  (default perumpkc-hds-b) UNIFI_PASS
#   RUT_HOST    (default 192.168.10.1)   RUT_USER (default admin) RUT_PASS
# Optional:
#   RESTORE_UNIFI_BACKUP=/path/to/backup.unf   (restore APs/users/settings
#                                               during the UniFi wizard)
# ============================================================================
set -euo pipefail

# ----------------------------------------------------------------------------
# 0. Sanity checks
# ----------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo bash $0)"; exit 1; }
[ "$(uname -m)" = "aarch64" ] || echo "WARN: expected aarch64 (Pi 64-bit OS), got $(uname -m)"
. /etc/os-release
[ "${VERSION_ID:-}" = "12" ] || echo "WARN: expected Debian 12 bookworm, got ${VERSION_ID:-unknown}"

# ----------------------------------------------------------------------------
# Secrets: environment overrides, else interactive prompt
# ----------------------------------------------------------------------------
ask_secret() { # $1=varname $2=label
  local var="$1" label="$2" val
  if [ -z "${!var:-}" ]; then
    read -rsp "$label (input hidden): " val; echo
    printf -v "$var" '%s' "$val"
  fi
}
ask_plain() { # $1=varname $2=label $3=default
  local var="$1" label="$2" def="${3:-}" val
  if [ -z "${!var:-}" ]; then
    read -rp "$label [$def]: " val
    printf -v "$var" '%s' "${val:-$def}"
  fi
}

ask_plain  MQTT_HOST   "MQTT broker host"        "perumpkc.com"
ask_plain  MQTT_PORT   "MQTT broker port"        "1883"
ask_plain  MQTT_USER   "MQTT username"
ask_secret MQTT_PASS   "MQTT password"
ask_plain  UNIFI_USER  "UniFi admin username"    "perumpkc-hds-b"
ask_secret UNIFI_PASS  "UniFi admin password"
ask_plain  RUT_HOST    "Teltonika RUT241 host"   "192.168.10.1"
ask_plain  RUT_USER    "RUT241 username"         "admin"
ask_secret RUT_PASS    "RUT241 password"

UNIFI_VERSION="9.4.19"        # UniFi Network Application (installed: 9.4.19-31042-1)
NODE_VERSION="20.19.5-1nodesource1"
PI_USER="raspberrypi"
PI_HOME="/home/$PI_USER"
DEST="/opt/pkc/node-gateway"
SRC="$(cd "$(dirname "$0")" && pwd)"   # the repo checkout containing this script

echo "== 1. System basics =="
hostnamectl set-hostname raspberrypi
timedatectl set-timezone Asia/Jakarta
raspi-config nonint do_ssh 0            # enable SSH
raspi-config nonint do_boot_wait 0      # wait for network at boot (pm2/unifi)
apt-get update -qq

echo "== 2. Node.js 20 (NodeSource) + pm2 =="
apt-get install -y -qq curl git ca-certificates gnupg binutils logrotate
curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh
bash /tmp/nodesource_setup.sh
apt-get install -y -qq nodejs="$NODE_VERSION" || {
  echo "pinned node version unavailable — installing latest 20.x"; apt-get install -y -qq nodejs; }
npm install -g pm2@7.1.2
echo "node $(node -v) | npm $(npm -v) | pm2 $(pm2 -v)"

echo "== 3. MongoDB 8.0 arm64 (GlennR package used by UniFi) + tools =="
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://apt.glennr.nl/public.gpg | gpg --dearmor -o /etc/apt/keyrings/apt-glennr.gpg
echo "deb [ arch=arm64 signed-by=/etc/apt/keyrings/apt-glennr.gpg ] https://apt.glennr.nl/repo bookworm mongod/8.0" \
  > /etc/apt/sources.list.d/glennr-mongod-8.0.list
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg --dearmor -o /etc/apt/keyrings/mongodb-server-8.0.gpg
echo "deb [ arch=arm64 signed-by=/etc/apt/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/8.0 multiverse" \
  > /etc/apt/sources.list.d/mongodb-org-8.0.list
apt-get update -qq
apt-get install -y -qq mongod-armv8 mongodb-database-tools mongodb-mongosh-shared-openssl3 openjdk-17-jre-headless
mongod --version | head -1

echo "== 4. UniFi Network Application $UNIFI_VERSION =="
DEB=/tmp/unifi_sysvinit_all.deb
curl -fsSL "https://dl.ui.com/download/unifi/${UNIFI_VERSION}/unifi_sysvinit_all.deb" -o "$DEB" \
  || { echo "download failed — get the deb manually from https://ui.com → Software → UniFi Network Application ${UNIFI_VERSION} (Debian), place it at $DEB and re-run this script"; exit 1; }
[ -n "${RESTORE_UNIFI_BACKUP:-}" ] && {
  install -d -m 0775 /usr/lib/unifi/data/autobackup
  cp "$RESTORE_UNIFI_BACKUP" /usr/lib/unifi/data/autobackup/
  echo "backup staged: $RESTORE_UNIFI_BACKUP (choose Restore in the wizard)"
}
apt-get install -y -qq "$DEB"          # installs, enables unifi.service;
rm -f "$DEB"                           # unifi.service launches /usr/bin/mongod itself

echo "== 5. Deploy node-gateway to $DEST =="
mkdir -p "$DEST" /var/log/pkc-gateway
for item in gateway.js lib public tools meters.json truth-table.json \
            ecosystem.config.js package.json package-lock.json AGENTS.md \
            README_INSTRUCTION_RPI.md; do
  cp -r "$SRC/$item" "$DEST/"
done
chown -R "$PI_USER:$PI_USER" "$DEST" /var/log/pkc-gateway
cd "$DEST" && runuser -u "$PI_USER" -- npm ci --omit=dev --no-audit --no-fund

echo "== 6. Generate gateway.config.json =="
cat > "$DEST/gateway.config.json" <<JSON
{
  "modbus": { "port": 10502, "unitId": 1, "debug": false },
  "scanIntervalSec": 10,
  "freqGate": 1.0,
  "publishOnlyChanged": true,
  "mqtt": { "host": "$MQTT_HOST", "port": $MQTT_PORT, "username": "$MQTT_USER", "password": "$MQTT_PASS", "clientId": "pkc-gateway" },
  "web": { "host": "0.0.0.0", "port": 8090 },
  "unifi": { "enabled": true, "url": "https://127.0.0.1:8443", "username": "$UNIFI_USER", "password": "$UNIFI_PASS", "site": "default", "intervalSec": 1800, "source": "" },
  "rut241": { "enabled": true, "url": "https://$RUT_HOST", "username": "$RUT_USER", "password": "$RUT_PASS", "intervalSec": 1800, "source": "" },
  "pihost": { "enabled": true, "intervalSec": 300, "source": "", "mqttHost": "$MQTT_HOST", "rutHost": "$RUT_HOST" }
}
JSON
chown "$PI_USER:$PI_USER" "$DEST/gateway.config.json"
chmod 600 "$DEST/gateway.config.json"

echo "== 7. pm2: boot persistence + start pkc-gateway =="
pm2 startup systemd -u "$PI_USER" --hp "$PI_HOME"    # creates pm2-raspberrypi.service
runuser -u "$PI_USER" -- env PM2_HOME="$PI_HOME/.pm2" \
  pm2 start "$DEST/ecosystem.config.js" --name pkc-gateway
runuser -u "$PI_USER" -- env PM2_HOME="$PI_HOME/.pm2" pm2 install pm2-logrotate
runuser -u "$PI_USER" -- env PM2_HOME="$PI_HOME/.pm2" pm2 save

echo "== 8. Verify =="
sleep 6
for port in 10502 8090; do
  ss -tln | grep -q ":$port " && echo "port $port: LISTENING" || echo "port $port: NOT LISTENING (check pm2 logs pkc-gateway)"
done
systemctl is-active --quiet unifi && echo "unifi service: active" || echo "unifi service: not active yet"
curl -fsS --max-time 5 "http://127.0.0.1:8090/api/overview" >/dev/null \
  && echo "gateway API: OK" || echo "gateway API: not responding yet"

cat <<DONE

============================================================================
Setup complete. Remaining MANUAL steps:
  1. UniFi controller wizard:  https://$(hostname -I | awk '{print $1}'):8443
     - complete setup, create admin: $UNIFI_USER
     - if a backup was staged, choose Restore during the wizard
     - adopt the AC Mesh APs (they remember the controller; may auto-adopt
       once you restore the backup)
  2. Converters: they reconnect to Modbus :10502 by themselves.
  3. Dashboard:  http://$(hostname -I | awk '{print $1}'):8090
     (Configuration tab shows the generated gateway.config.json)
  4. Logs: pm2 logs pkc-gateway   ·   UniFi: /usr/lib/unifi/logs/server.log
DONE

# README — Raspberry Pi Gateway: Meters Matrix & IP-Keyed Attribution

Instructions for implementing and maintaining the meter identity system
on the zone Raspberry Pi (`pkc-gateway`). This README lives IN the
node-gateway folder — copy the whole folder to deploy the gateway
(meters matrix, truth table, code, and docs travel together).

## The two files

| File | Key | Purpose | Status |
|---|---|---|---|
| `meters.json` | `start` (register offset) | What the gateway uses **today**: decodes each 100-register block and publishes it as that slot's serial | Active (register-keyed) |
| `truth-table.json` | `(converterIp, slaveId)` | The **corrected operator-confirmed identity source**: which converter (IP) + which meter on it (slave ID) belongs to which house/serial | Canonical, ready for the IP-keyed logic |

Both live in this folder (`meters.json`, `truth-table.json`). The CSV twin
(`truth-table.csv`) is the human-readable export.

## Identity model (why IP, not register)

- One ESP converter = one WiFi client with a **fixed IP** — the IP is the
  device's identity and is self-reported inside every register block it
  writes (regs 1-2 → `192.168.{seg3}.{seg4}`).
- **Block D: one converter serves TWO power meters.** The pair shares one
  IP; the two meters are distinguished by **Modbus slave ID** (reg 3) —
  lower house number = lower slave ID. All other blocks are 1:1.
- A converter flashed with the wrong register start silently attributes
  its data to the wrong house (this is live in the field today: 21 B/C
  converters write E/DD slots). The register start is only "where to
  read" — never identity. Resolving by `(ip, slaveId)` fixes attribution
  regardless of where the converter writes, and the IP↔block mismatch
  becomes a loud, actionable warning.

## Register block layout (legacy, unchanged — 100 regs per meter)

| Regs | Content |
|---|---|
| 0 | isOnline (int16) |
| 1 / 2 | converter IP segment 3 / 4 (int16 → `192.168.r1.r2`) |
| 3 | Modbus slave ID of the meter polled (int16) |
| 4-47 | 22 big-endian float32 (2 regs each): voltAN, voltBN, voltCN, voltAvgLN, voltAB, voltBC, voltCA, voltAvgLL, currA, currB, currC, currN, currAvg, freq, pf, kWtotal, kVAtotal, kVARtotal, kvarhImport, **kwhImport**, kwhExport, kwhTotal |
| 48-99 | unused |

`readings.kwh` published to the server = **kwhImport** (raw cumulative
register, always increasing — consumption is computed server-side).

## Implementing IP-keyed attribution in the gateway

Modify `lib/publisher.js` (scan path). The lookup:

```js
// once at startup (and on config reload):
// truth = entries of truth-table.json
byKey = new Map(truth.entries.filter(e => e.converterIp && e.slaveId != null)
  .map(e => [`${e.converterIp}|${e.slaveId}`, e]));

// per scanned block:
const decoded = decodeBlock(regs);          // existing lib/decode.js
const selfIp = `192.168.${decoded.ipSegment3}.${decoded.ipSegment4}`;
const entry  = byKey.get(`${selfIp}|${decoded.devSlave}`)   // IP+slave first
            ?? truthByIpSingle.get(selfIp)                   // 1:1 blocks
            ?? matrixByStart.get(meter.start);               // last resort
if (entry.serial !== meter.devSer) {
  console.warn(`[publisher] MISMATCH: converter ${selfIp} (slave ${decoded.devSlave}) ` +
    `writes slot of ${meter.devSer} but is ${entry.serial}/${entry.home} — ` +
    `misflashed converter or stale meters.json`);
}
// publish as entry.serial (the true owner), not meter.devSer
```

Rules:
- `meters.json` stays loaded — register starts are still needed to know
  WHERE to read and as the fallback when a block reports no/unknown IP
  (fresh boot, all-zero regs).
- Max 2 meters per IP (D-pairs). If a third entry ever shares an IP,
  the truth table is wrong — refuse to start.
- Only publish when `freq > freqGate` (unchanged) — a block with zeros
  has no identity yet.

## Deploying / updating on the Pi

```bash
cd pkcbilling2025 && git pull
# regenerate meters.json only if the legacy mapping file changed:
node tools/generate-meters-json.js /path/to/devSerNum.txt meters.json
# truth-table.json comes from the SERVER (needs the DB) — copy it via git
pm2 restart pkc-gateway
```

Editing either file live: dashboard → Configuration tab → edit JSON →
Save & apply (register map changes apply to new writes; a restart is
cleaner after matrix edits).

Regenerating `truth-table.json` happens on the **server** (DB access):

```bash
node scripts/generate-truth-table.mjs /home/cjnathan/truthtablerumahkujang.rtf
```

## Verifying after deployment

1. Dashboard → Metering tab: click rows of two known D-pair meters on
   one converter — `devSlave` (shown in the decoded panel) must differ;
   both blocks' `last write` tick together each cycle.
2. Trigger a write with
   `node tools/test-write-block.mjs`
   (adjust serials first) and watch the transformed payload use the
   IP-resolved serial.
3. On the server:
   ```sql
   SELECT m."serialNumber", h."houseAlias", cr.kwh, cr."lastReadingAt"
   FROM "CurrentReading" cr JOIN "Meter" m ON m.id=cr."meterId"
   JOIN "House" h ON h.id=m."houseId" ORDER BY cr."lastReadingAt" DESC LIMIT 20;
   ```
   Readings must land on the houses the truth table assigns
   (B/C houses once IP-keying is live — see warning below).

## Current field state & warnings (2026-11-16)

- **21 live converters are B/C devices flashed with E/DD register
  starts.** With register-keying (current code) their data lands on
  E/DD houses. IP-keying fixes attribution in software; re-flashing the
  converters fixes it in the field. That decision is pending — until
  then do NOT treat E/DD readings as real E/DD consumption.
- E and DD areas have **no internet yet** — those converters are not
  deployed; their table IPs (.66-.124, .234+. ranges) are the future
  plan.
- C42 / C62 / C64: dead `PCU2506xxxx` meters, no converter. B13 is not
  a registered house (dropped from the table). C23's converter is
  `.233` (newest addition), reading the old PCU25060001 meter.
- The two live IPs `.227` (C46) and `.233` (C23) are the newest
  converters; `.235` belongs to DD10 per the table — if you see a live
  device on an unassigned IP, report it before assigning.

## Server-side counterpart (already live)

The server (`mqtt-processor`) accepts `meters/{serial}/readings` and
drops unknown serials — every serial in `truth-table.json` must exist
in the `Meter` table (all do after the D45/D51 relink). Payload spec:
`README_PUBLISH_MQTT.md`. Identity background + survey findings:
`AGENTS.md` → "Meter / Converter Identity Model".

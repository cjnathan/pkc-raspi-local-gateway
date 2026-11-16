#!/usr/bin/env node
// Generates meters.json from the legacy devSerNum.txt mapping
// (register-start ↔ meter name ↔ device serial ↔ house code).
// Usage: node tools/generate-meters-json.js /path/to/devSerNum.txt [out.json]

import fs from "node:fs";

const [src, out] = process.argv.slice(2);
if (!src) {
  console.error("Usage: node tools/generate-meters-json.js <devSerNum.txt> [out.json]");
  process.exit(1);
}

const txt = fs.readFileSync(src, "utf8");
const meters = [...txt.matchAll(/\{start:(\d+),\s*name:"([^"]+)",\s*devSer:"(PCU\d+)"/g)].map((m) => ({
  start: Number(m[1]),
  name: m[2],
  devSer: m[3],
  home: "",
}));

// house codes come as a 4th property in newer lines: home:"D01"
for (const line of txt.split("\n")) {
  const h = line.match(/\{start:(\d+),\s*name:"([^"]+)",\s*devSer:"(PCU\d+)",\s*home:"([^"]*)"/);
  if (h) {
    const m = meters.find((x) => x.start === Number(h[1]) && x.devSer === h[3]);
    if (m) m.home = h[4];
  }
}

const dest = out || new URL("../meters.json", import.meta.url).pathname;
fs.writeFileSync(dest, JSON.stringify(meters, null, 2) + "\n");
console.log(`wrote ${meters.length} meters -> ${dest}`);
console.log(`register span: 0 .. ${Math.max(...meters.map((m) => m.start)) + 100}`);

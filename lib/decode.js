// Register block decoding: legacy PKC layout, 100 registers per meter.
// Layout (from the original Node-RED flow, /home/cjnathan/2o23):
//   reg0 isOnline (int16), reg1 ipSegment3, reg2 ipSegment4, reg3 devSlave,
//   then 22 big-endian float32 values across 2 registers each.

export const BLOCK_REGS = 100;

const FLOAT_FIELDS = [
  "voltAN", "voltBN", "voltCN", "voltAvgLN",
  "voltAB", "voltBC", "voltCA", "voltAvgLL",
  "currA", "currB", "currC", "currN", "currAvg",
  "freq", "pf",
  "kWtotal", "kVAtotal", "kVARtotal",
  "kvarhImport", "kwhImport", "kwhExport", "kwhTotal",
];

export function decodeBlock(regs) {
  const buf = Buffer.alloc(BLOCK_REGS * 2);
  for (let i = 0; i < BLOCK_REGS; i++) buf.writeUInt16BE(regs[i] & 0xffff, i * 2);
  const out = {
    isOnline: buf.readInt16BE(0),
    ipSegment3: buf.readInt16BE(2),
    ipSegment4: buf.readInt16BE(4),
    devSlave: buf.readInt16BE(6),
  };
  for (let f = 0; f < FLOAT_FIELDS.length; f++) {
    out[FLOAT_FIELDS[f]] = buf.readFloatBE(8 + f * 4);
  }
  return out;
}

// Map the decoded legacy block to the central meters/{serial}/readings
// payload. kwh = kwhImport (cumulative register, always increasing —
// consumption is computed server-side as a delta between readings).
export function toCentralPayload(decoded) {
  return {
    kwh: decoded.kwhImport,
    voltAN: decoded.voltAN,
    voltBN: decoded.voltBN,
    voltCN: decoded.voltCN,
    currA: decoded.currA,
    currB: decoded.currB,
    currC: decoded.currC,
    kw: decoded.kWtotal,
    kvar: decoded.kVARtotal,
    kva: decoded.kVAtotal,
    freq: decoded.freq,
    cosphi: decoded.pf,
  };
}

export function hashRegs(regs) {
  let h = 0;
  for (let i = 0; i < regs.length; i++) {
    h = ((h << 5) - h + (regs[i] & 0xffff)) | 0;
  }
  return h.toString(36) + ":" + regs.length;
}

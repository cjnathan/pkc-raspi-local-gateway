// Simulates a house converter: writes a meter block into the gateway's
// Modbus server on :10502 exactly like the field devices do (FC16).
import ModbusRTU from "modbus-serial";

const regs = new Array(100).fill(0);
const setInt = (reg, v) => { regs[reg] = v & 0xffff; };
const setFloat = (reg, v) => {
  const b = Buffer.alloc(4);
  b.writeFloatBE(v, 0);
  regs[reg] = b.readUInt16BE(0);
  regs[reg + 1] = b.readUInt16BE(2);
};

setInt(0, 1);   // isOnline
setInt(1, 137); // ipSegment3
setInt(2, 42);  // ipSegment4
setInt(3, 7);   // devSlave
setFloat(4, 219.5);   // voltAN
setFloat(6, 220.1);   // voltBN
setFloat(8, 221.3);   // voltCN
setFloat(10, 220.3);  // voltAvgLN
setFloat(12, 381.0);  // voltAB
setFloat(14, 382.1);  // voltBC
setFloat(16, 380.4);  // voltCA
setFloat(18, 381.2);  // voltAvgLL
setFloat(20, 4.2);    // currA
setFloat(22, 3.9);    // currB
setFloat(24, 4.1);    // currC
setFloat(26, 0.3);    // currN
setFloat(28, 4.07);   // currAvg
setFloat(30, 50.02);  // freq
setFloat(32, 0.987);  // pf
setFloat(34, 2.75);   // kWtotal
setFloat(36, 2.79);   // kVAtotal
setFloat(38, 0.45);   // kVARtotal
setFloat(40, 111.22); // kvarhImport
setFloat(42, 1234.56);// kwhImport
setFloat(44, 0.0);    // kwhExport
setFloat(46, 1234.56);// kwhTotal

const PORT = Number(process.env.PKC_MODBUS_PORT || 10502);
const client = new ModbusRTU();
await client.connectTCP("127.0.0.1", { port: PORT });
client.setID(1);
await client.writeRegisters(0, regs);
console.log("wrote 100 registers for block @0 (TESTGW001)");
// second write for TESTGW002 (block @100) with only a couple of values
const regs2 = new Array(100).fill(0);
const b = (v) => { const x = Buffer.alloc(4); x.writeFloatBE(v, 0); return [x.readUInt16BE(0), x.readUInt16BE(2)]; };
regs2[0] = 1;
[regs2[4], regs2[5]] = b(215.7); // voltAN
[regs2[30], regs2[31]] = b(49.98); // freq
[regs2[32], regs2[33]] = b(0.97);  // pf
[regs2[42], regs2[43]] = b(999.99);// kwhImport
await client.writeRegisters(100, regs2);
console.log("wrote 100 registers for block @100 (TESTGW002)");
await client.close();

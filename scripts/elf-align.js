'use strict';
// Periksa alignment segmen LOAD pada berkas .so (syarat 16 KB: p_align >= 0x4000).  node scripts/elf-align.js a.so [b.so ...]
const fs = require('fs');
let bad = 0;
for (const file of process.argv.slice(2)) {
  const fd = fs.openSync(file, 'r'), h = Buffer.alloc(64); fs.readSync(fd, h, 0, 64, 0);
  if (h.readUInt32BE(0) !== 0x7f454c46) { console.log('BUKAN ELF  ' + file); bad++; continue; }
  const is64 = h[4] === 2;
  const phoff = is64 ? Number(h.readBigUInt64LE(32)) : h.readUInt32LE(28), ent = h.readUInt16LE(is64 ? 54 : 42), num = h.readUInt16LE(is64 ? 56 : 44);
  const al = [];
  for (let i = 0; i < num; i++) {
    const e = Buffer.alloc(ent); fs.readSync(fd, e, 0, ent, phoff + i * ent);
    if (e.readUInt32LE(0) === 1) al.push(is64 ? Number(e.readBigUInt64LE(48)) : e.readUInt32LE(28));
  }
  fs.closeSync(fd);
  const ok = al.length > 0 && al.every((a) => a >= 0x4000);
  if (!ok) bad++;
  console.log((ok ? 'OK 16KB   ' : 'TIDAK 16KB') + '  ' + file + '  LOAD p_align=' + al.map((a) => '0x' + a.toString(16)).join(','));
}
process.exit(bad ? 1 : 0);

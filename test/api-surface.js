'use strict';
// Menjaga permukaan API Core tidak berubah saat refaktor (PLAN-RESTRUKTUR Step 1).
//   node test/api-surface.js --write   -> simpan baseline ke test/.api-baseline.json
//   node test/api-surface.js           -> bandingkan kondisi sekarang dengan baseline (gagal bila beda)
// Yang dibandingkan: nama semua properti Core.prototype (+ jenisnya: method/getter) dan kunci module.exports src/archne-core.js.
const fs = require('fs'), path = require('path'), assert = require('assert');
const BASE = path.join(__dirname, '.api-baseline.json');
const mod = require('../src/archne-core');
const { Core } = mod;
function snapshot() {
  const proto = {};
  for (const n of Object.getOwnPropertyNames(Core.prototype).sort()) {
    const d = Object.getOwnPropertyDescriptor(Core.prototype, n);
    proto[n] = d.get || d.set ? 'accessor' : typeof d.value;
  }
  const exp = Object.keys(mod).sort().map((k) => k + ':' + typeof mod[k]);
  return { prototype: proto, exports: exp };
}
const now = snapshot();
if (process.argv.includes('--write')) {
  fs.writeFileSync(BASE, JSON.stringify(now, null, 1) + '\n');
  console.log('baseline ditulis: ' + Object.keys(now.prototype).length + ' anggota prototype, ' + now.exports.length + ' ekspor');
  process.exit(0);
}
if (!fs.existsSync(BASE)) { console.error('Baseline belum ada. Jalankan: node test/api-surface.js --write'); process.exit(2); }
const old = JSON.parse(fs.readFileSync(BASE, 'utf8'));
const diff = [];
for (const k of Object.keys(old.prototype)) if (!(k in now.prototype)) diff.push('HILANG  Core.prototype.' + k);
for (const k of Object.keys(now.prototype)) if (!(k in old.prototype)) diff.push('BARU    Core.prototype.' + k);
for (const k of Object.keys(old.prototype)) if (k in now.prototype && old.prototype[k] !== now.prototype[k]) diff.push('BEDA    Core.prototype.' + k + ' ' + old.prototype[k] + ' -> ' + now.prototype[k]);
for (const k of old.exports) if (now.exports.indexOf(k) < 0) diff.push('HILANG  ekspor ' + k);
for (const k of now.exports) if (old.exports.indexOf(k) < 0) diff.push('BARU    ekspor ' + k);
assert.strictEqual(diff.length, 0, 'permukaan API berubah:\n  ' + diff.join('\n  '));
console.log('  OK  permukaan API identik: ' + Object.keys(now.prototype).length + ' anggota prototype, ' + now.exports.length + ' ekspor');

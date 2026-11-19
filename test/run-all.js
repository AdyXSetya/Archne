'use strict';
// Menjalankan semua tes berurutan; berhenti pada kegagalan pertama.
//   node test/run-all.js            -> semua tes
//   node test/run-all.js pin call   -> hanya tes yang namanya mengandung "pin" ATAU "call"
// Keluaran tes disembunyikan bila lulus (hemat token); bila gagal, ekornya ditampilkan.
// udp.js tidak ikut suite bawaan (memang tidak ada di "npm test" lama); jalankan dengan: node test/udp.js
const fs = require('fs'), path = require('path'), cp = require('child_process');
const EXCLUDE = new Set(['udp.js']);
const filters = process.argv.slice(2).filter((a) => a[0] !== '-');
const verbose = process.argv.includes('-v');
const files = fs.readdirSync(__dirname)
  .filter((f) => /\.(m?js)$/.test(f) && f[0] !== '_' && f !== 'run-all.js')
  .filter((f) => !EXCLUDE.has(f) || filters.some((k) => f.indexOf(k) >= 0))
  .filter((f) => !filters.length || filters.some((k) => f.indexOf(k) >= 0))
  .sort((a, b) => (a === 'test.js' ? -1 : b === 'test.js' ? 1 : a < b ? -1 : a > b ? 1 : 0));
if (!files.length) { console.error('Tidak ada tes yang cocok dengan: ' + filters.join(' ')); process.exit(2); }
const t0 = Date.now();
let n = 0;
for (const f of files) {
  const t = Date.now();
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, f)], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const dt = ((Date.now() - t) / 1000).toFixed(1);
  if (r.status !== 0) {
    const out = ((r.stdout || '') + (r.stderr || '')).split('\n');
    console.log('FAIL ' + f + ' (' + dt + 's, kode ' + r.status + ')');
    console.log(out.slice(-40).join('\n'));
    console.log('\nBerhenti di tes ke-' + (n + 1) + ' dari ' + files.length + '.');
    process.exit(1);
  }
  n++;
  console.log('ok   ' + f + ' (' + dt + 's)');
  if (verbose) console.log(r.stdout);
}
console.log('\n' + n + '/' + files.length + ' tes lulus dalam ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

'use strict';
// renderer/vendor/VERSIONS.txt mencatat sha256 tiap berkas pihak ketiga. Tes ini memastikan berkas yang ada sama dengan catatan
// (tidak ada yang berubah diam-diam), setiap berkas vendored tercatat, dan lisensi yang wajib menyertainya ada.
const assert = require('assert'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const dir = path.resolve(__dirname, '..', 'renderer', 'vendor');
const ok = (m) => console.log('ok - ' + m);

const rows = fs.readFileSync(path.join(dir, 'VERSIONS.txt'), 'utf8').split('\n')
  .map((l) => /^([0-9a-f]{64})\s+(\S+)\s+<=\s+(.+)$/.exec(l)).filter(Boolean)
  .map((m) => ({ sha: m[1], file: m[2], from: m[3] }));
assert(rows.length >= 4, 'VERSIONS.txt memuat tabel hash');
for (const r of rows) {
  const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, r.file))).digest('hex');
  assert.strictEqual(got, r.sha, r.file + ' berubah dari catatan (' + r.from + '). Perbarui lewat prosedur di VERSIONS.txt');
}
ok('hash ' + rows.length + ' berkas vendored cocok dengan VERSIONS.txt');

const listed = new Set(rows.map((r) => r.file));
const bin = fs.readdirSync(dir).filter((f) => /\.(js|wasm)$/.test(f));
for (const f of bin) assert(listed.has(f), f + ' ada di vendor/ tapi tidak tercatat di VERSIONS.txt');
ok('semua berkas .js/.wasm vendored tercatat');

for (const f of ['LICENSE-mqtt.txt', 'LICENSE-web-noise-suppressor.txt', 'LICENSE-rnnoise.txt', 'LICENSE-rnnoise-wasm.txt']) {
  assert(fs.existsSync(path.join(dir, f)) && fs.statSync(path.join(dir, f)).size > 500, f + ' ada');
}
assert(/Xiph\.Org Foundation/.test(fs.readFileSync(path.join(dir, 'LICENSE-rnnoise.txt'), 'utf8')), 'notis RNNoise (BSD-3) lengkap');
assert(/Apache License/.test(fs.readFileSync(path.join(dir, 'LICENSE-rnnoise-wasm.txt'), 'utf8')), 'lisensi Apache-2.0 ada');
ok('lisensi MQTT.js (MIT), web-noise-suppressor (MIT), RNNoise (BSD-3), rnnoise-wasm (Apache-2.0) menyertai berkas');

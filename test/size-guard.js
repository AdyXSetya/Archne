'use strict';
// Penjaga ukuran (PLAN-RESTRUKTUR Step 3): mencegah berkas modul membengkak lagi.
// Gagal bila ada berkas di src/core/*.js, renderer/js/*.js, renderer/css/*.css yang
//   > 30 KB  atau  > 450 baris.
// Pengecualian HARUS didaftarkan eksplisit di EXCEPT (dengan batas sendiri + alasan),
// supaya berkas pengecualian pun tidak boleh tumbuh tanpa disengaja.
//   node test/size-guard.js          -> cek
//   node test/size-guard.js --list   -> tampilkan 10 berkas terbesar
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');

const MAX_BYTES = 30 * 1024;
const MAX_LINES = 450;
const DIRS = [['src/core', '.js'], ['renderer/js', '.js'], ['renderer/css', '.css']];

// berkas (relatif ke root) -> { bytes, lines, why }  (batas pengecualian, bukan batas bawaan)
const EXCEPT = {
  'renderer/css/archne-app.css': { bytes: 36 * 1024, lines: 450, why: 'satu stylesheet utuh hasil Step 2 (273 baris panjang); urutan cascade dijaga, belum dipecah' },
};
// Berkas di luar folder yang dijaga, hanya dicatat agar tidak lupa (lihat Step 5).
const NOTE_ONLY = { 'renderer/archne-call.js': 'closure UMD besar; ditangani di Step 5 (opsional)' };

const rows = [];
for (const [sub, ext] of DIRS) {
  const d = path.join(root, sub);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith(ext)).sort()) {
    const rel = sub + '/' + f;
    const buf = fs.readFileSync(path.join(d, f));
    const lines = buf.toString('utf8').split('\n').length - (buf.length && buf[buf.length - 1] === 10 ? 1 : 0);
    rows.push({ rel, bytes: buf.length, lines });
  }
}

if (process.argv.includes('--list')) {
  rows.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 10)
    .forEach((r) => console.log(String(r.lines).padStart(5) + ' baris ' + String(r.bytes).padStart(7) + ' B  ' + r.rel + (EXCEPT[r.rel] ? '  (pengecualian)' : '')));
  Object.keys(NOTE_ONLY).forEach((k) => console.log('      dicatat: ' + k + ' - ' + NOTE_ONLY[k]));
  process.exit(0);
}

const errs = [];
if (!rows.length) errs.push('tidak ada berkas yang diperiksa (struktur folder berubah?)');
for (const r of rows) {
  const ex = EXCEPT[r.rel];
  const mb = ex ? ex.bytes : MAX_BYTES, ml = ex ? ex.lines : MAX_LINES;
  if (r.bytes > mb) errs.push(r.rel + ': ' + r.bytes + ' B > batas ' + mb + ' B' + (ex ? ' (pengecualian)' : ''));
  if (r.lines > ml) errs.push(r.rel + ': ' + r.lines + ' baris > batas ' + ml + (ex ? ' (pengecualian)' : ''));
}
// pengecualian yatim (berkas sudah dipecah/hilang) harus dibersihkan dari daftar
for (const k of Object.keys(EXCEPT)) {
  if (!rows.some((r) => r.rel === k)) errs.push('pengecualian yatim (berkas tidak ada): ' + k + ' - hapus dari EXCEPT');
  // pengecualian yang sudah tidak perlu (muat di batas bawaan) juga dibersihkan
  const r = rows.find((x) => x.rel === k);
  if (r && r.bytes <= MAX_BYTES && r.lines <= MAX_LINES) errs.push('pengecualian tidak perlu lagi (sudah di bawah batas bawaan): ' + k + ' - hapus dari EXCEPT');
}

if (errs.length) {
  console.error('size-guard GAGAL:\n  - ' + errs.join('\n  - '));
  console.error('\nPecah berkas per domain (lihat README > Panduan update fitur), jangan naikkan batas.');
  process.exit(1);
}
console.log('size-guard ok: ' + rows.length + ' berkas dicek (batas ' + (MAX_BYTES / 1024) + ' KB / ' + MAX_LINES + ' baris, ' + Object.keys(EXCEPT).length + ' pengecualian)');

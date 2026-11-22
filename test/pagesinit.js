'use strict';
// Skrip Halaman dijalankan saat halaman dimuat, sebelum ada Halaman yang dibuka. Tes lain memakai DOM palsu yang membuat elemen apa pun,
// jadi galat "getElementById(...) null" di tingkat atas tidak ketahuan (di HP: baris 209 melempar galat, scroll-muat-lagi dan Esc tidak pernah terpasang).
// Tes ini membaca HTML sungguhan: setiap $('id') yang dipakai langsung di tingkat atas berkas archne-pages*.js harus ada sebagai id statis.
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..', 'renderer');
const html = fs.readFileSync(path.join(root, 'archne-index.html'), 'utf8');
const staticIds = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
let n = 0;
for (const f of fs.readdirSync(path.join(root, 'js')).filter((x) => /^archne-pages.*\.js$/.test(x))) {
  const lines = fs.readFileSync(path.join(root, 'js', f), 'utf8').split('\n');
  lines.forEach((l, i) => {
    const m = /^\$\('([\w-]+)'\)\./.exec(l); // baris tingkat atas (kolom 0): dieksekusi saat dimuat
    if (!m) return; n++;
    assert(staticIds.has(m[1]), `${f}:${i + 1} memakai $('${m[1]}') saat dimuat, tetapi id itu tidak ada di archne-index.html (elemen dinamis?)`);
  });
}
assert(n > 0, 'tidak ada baris tingkat atas yang diperiksa');
console.log('  OK  id yang dipakai saat muat ada di HTML (' + n + ' baris diperiksa)');
console.log('pagesinit: 1 lulus');

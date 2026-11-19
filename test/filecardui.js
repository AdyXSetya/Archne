'use strict';
// Kartu berkas v0.25.1: tanpa teks tombol, aksi berupa ikon, status berupa ikon, aksi lain di menu ⋮.
const assert = require('assert'), fs = require('fs'), path = require('path');
const FC = require('../renderer/archne-filecard.js');
const ok = (m) => console.log('  OK  ' + m);
const ID = 'ab'.repeat(16), DM = '0123456789abcdef', th = Buffer.from('jpeg').toString('base64');
const msg = (file, to) => ({ id: ID, to: to || DM, from: 'p', file: Object.assign({ name: 'laporan.pdf', size: 2097152, psize: 2097152, mode: 'raw' }, file) });
const card = (file, to, ctx) => FC.cardHtml(msg(file, to), {}, ctx);
const vis = (h) => h.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); // teks yang terlihat

// 1. tombol hanya ikon: teks terlihat tidak memuat kata tombol lama
const kinds = [{}, { saved: { name: 'laporan.pdf' } }, { rx: { phase: 'download', done: 1, total: 2 } }, { rx: { phase: 'error', code: 'net' } }, { mine: true },
  { name: 'a.mp3' }, { name: 'a.mp3', saved: { name: 'a.mp3' } }, { name: 's.weba', x: { k: 'vc', d: 5000 } }, { name: 'v.mp4', x: { k: 'vid', w: 10, h: 10, d: 1000, th } }, { name: 'f.jpg', x: { k: 'img', w: 10, h: 10, th }, saved: { name: 'f.jpg' } }];
for (const k of kinds) {
  const h = card(k), t = vis(h);
  assert(!/(Terima|Unduh|Putar|Tampilkan|Buka|Lihat|Tersimpan|Batal|Coba lagi|Lanjutkan|Buang|Tersedia)/.test(t.replace(/Gagal:.*$/, '')), 'tidak ada teks tombol: ' + JSON.stringify(k) + ' -> ' + t);
  assert(/class="fmore" data-menu="/.test(h) && h.includes('aria-label="Menu berkas"'), 'tombol ⋮ ada di semua kartu: ' + JSON.stringify(k));
  for (const b of h.match(/<button[^>]*class="fb[^>]*>/g) || []) assert(/title="[^"]+"/.test(b) && /aria-label="[^"]+"/.test(b), 'tombol ikon punya title dan aria-label: ' + b);
}
ok('semua keadaan kartu: tidak ada teks tombol, tiap tombol ikon berlabel, ada tombol ⋮');

// 2. nama berkas: tampil di kartu berkas biasa (satu baris), disembunyikan di media; selalu ada di menu
assert(card({}).includes('class="fn" title="laporan.pdf"') && card({}).includes('2,0 MB'));
for (const k of [{ name: 's.weba', x: { k: 'vc', d: 5000 } }, { name: 'IMG_hash.jpg', x: { k: 'img', w: 10, h: 10, th } }, { name: 'VID_hash.mp4', x: { k: 'vid', w: 10, h: 10, d: 1000, th } }]) assert(!card(k).includes('class="fn"') && !vis(card(k)).includes(k.name), 'media: nama tidak tampil di layar ' + k.name);
assert(FC.menuItems(msg({ name: 'IMG_hash.jpg' }))[0].label.startsWith('IMG_hash.jpg · 2,0 MB') && FC.menuItems(msg({}))[0].disabled);
ok('nama berkas: satu baris untuk berkas biasa, tersembunyi untuk foto/video/suara dan tersedia di butir info menu');

// 3. status berupa ikon (teks lengkap di title)
let h = card({ saved: { name: 'laporan.pdf' } }); assert(/class="fst ok" title="Tersimpan: laporan.pdf"/.test(h));
h = card({ held: 2 }); assert(/class="fst cour" title="Tersedia di 2 kurir/.test(h) && vis(h).includes('2'));
h = card({}, DM, { senderOnline: false }); assert(/class="fst warn" title="Pengirim sedang offline/.test(h));
ok('status tersimpan / kurir / offline: ikon kecil, penjelasan di title');

// 4. butir menu menurut keadaan
const acts = (f, to) => FC.menuItems(msg(f, to)).map((i) => i.act).join();
assert.strictEqual(acts({}), 'f:info');
assert.strictEqual(acts({ saved: { name: 'laporan.pdf' } }), 'f:info,f:open,f:show');
assert.strictEqual(acts({ name: 'a.mp3', saved: { name: 'a.mp3' } }), 'f:info,f:play,f:open,f:show');
assert.strictEqual(acts({ name: 'v.mp4', saved: { name: 'v.mp4' } }), 'f:info,f:full,f:open,f:show', 'video: Layar penuh = pemutar modal');
assert.strictEqual(FC.menuItems(msg({ name: 'v.mp4', saved: { name: 'v.mp4' } }))[1].label, 'Layar penuh');
assert.strictEqual(acts({ name: 'f.jpg', saved: { name: 'f.jpg' } }), 'f:info,f:view,f:open,f:show');
assert.strictEqual(FC.menuItems(msg({ name: 'f.jpg', saved: { name: 'f.jpg' } }))[1].label, 'Layar penuh');
assert.strictEqual(acts({ name: 'x.exe', saved: { name: 'x.exe' } }), 'f:info,f:show', 'berisiko: hanya tampilkan di folder');
assert.strictEqual(acts({ rx: { phase: 'error', code: 'net' } }), 'f:info,f:discard');
assert.strictEqual(acts({ mine: true }), 'f:info');
assert.strictEqual(acts({ name: 's.weba', x: { k: 'vc', d: 5000 }, saved: { name: 's.weba' } }), 'f:info,f:play,f:show');
ok('menu ⋮: Layar penuh untuk foto/video, Putar untuk audio, Buka di aplikasi lain, Tampilkan di folder; berisiko dan suara dibatasi');

// 5. kabel: ⋮ membuka menu pesan yang sama; aksi f:* lewat satu jalur fileAct
const mm = fs.readFileSync(path.join(__dirname, '../renderer/js/archne-msgmenu.js'), 'utf8'), pc = fs.readFileSync(path.join(__dirname, '../renderer/js/archne-profile-compose.js'), 'utf8');
assert(mm.includes("t.closest('.mmore,.fmore')") && mm.includes('FileCard.menuItems(m)') && mm.includes("act.indexOf('f:') === 0") && mm.includes('.mmore,.fmore'));
assert(pc.includes('async function fileAct(act, id, risky)') && pc.includes("await fileAct(a.dataset.act, a.dataset.id, !!a.dataset.risky)"));
assert(fs.readFileSync(path.join(__dirname, '../renderer/archne-index.html'), 'utf8').includes('css/archne-filecard.css'));
ok('kabel: .fmore memakai #mmenu, aksi f:* lewat fileAct, archne-filecard.css dimuat');

// 6. progres singkat + gelembung kirim berupa ikon
assert.strictEqual(FC.progressText('download', 512, 1024), '50% · 512 B / 1,0 KB');
h = FC.jobHtml({ job: 'j1', name: 'a.zip', phase: 'pack', done: 25, total: 100 }); assert(h.includes('data-act="cancelsend"') && h.includes('title="Batal"') && !/>\s*Batal\s*</.test(h) && h.includes('width:25%'));
h = FC.jobHtml({ job: 'j1', name: 'a.zip', phase: 'error', err: 'x', code: 'ENOENT' }); assert(h.includes('data-act="dismiss"') && h.includes('title="Tutup"'));
ok('kemajuan singkat; gelembung kirim memakai ikon Batal/Tutup');
console.log('\nOK: 6 kelompok');

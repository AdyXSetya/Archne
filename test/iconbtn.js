'use strict';
// Penjaga: tombol profil / Halaman = tombol ikon saja (nama di title + aria-label), tanpa teks deskripsi di profil, video Halaman satu ketuk langsung diputar.
const assert = require('assert'), fs = require('fs'), path = require('path');
const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const ok = (m) => console.log('  OK  ' + m);
const util = rd('renderer/js/archne-state-util.js'), prof = rd('renderer/js/archne-profile-compose.js'), pgs = rd('renderer/js/archne-pages.js'), med = rd('renderer/js/archne-pages-media.js');

assert(/\n  home: svg\(/.test(util) && /\n  play: svg\(/.test(util) && util.includes('const ibtn = '), 'ikon home/play + helper ibtn');
ok('ikon home + play dan helper ibtn ada');

// profil: tidak ada tombol bertulisan teks; placeholder = bawaan "Hallo..." tanpa petunjuk panjang
const pf = prof.slice(prof.indexOf('function renderProfile'), prof.indexOf("$('pmodal').onclick"));
for (const n of ['check', 'x', 'add', 'chat']) assert(pf.includes("ibtn('" + n), 'profil: ibtn ' + n);
for (const bad of ['<button data-pact="save">', '<button data-pact="chat">', '<button class="sec" data-pact="friend">', '<button data-pact="friend">']) assert(!pf.includes(bad), 'profil: tombol bertulisan lama hilang: ' + bad);
assert(pf.includes('placeholder="${esc(DEFAULT_BIO)}"') && !pf.includes('phint') && !pf.includes('bioHint') && !pf.includes('bioPh'), 'profil: placeholder = Hallo..., tanpa petunjuk');
for (const f of ['renderer/i18n/archne-en.js', 'renderer/i18n/archne-id.js']) assert(!/profile\.(bioPh|bioHint)/.test(rd(f)), f + ' tanpa kunci petunjuk lama');
ok('profil: Simpan/Terima/Tolak/Teman/Chat = ikon saja, placeholder Hallo..., petunjuk panjang dihapus');

// Halaman: Halamanku/Halaman = ikon rumah; Tutup = ikon x; Cadangan = ikon
assert(pgs.includes("pgIb('home'") && pgs.includes("pgIb('x', txf('common.close'"), 'Halaman: home + x');
assert(!/<button[^>]*data-pg="(open|close)"[^>]*>\s*\$?\{?\s*(esc\()?txf/.test(pgs), 'Halaman: tombol open/close tanpa teks');
ok('Halaman: Halamanku/Halaman = ikon rumah, Tutup = ikon x');

// video: kartu = tombol putar ikon besar; sesudah token dipasang langsung play()
assert(med.includes('pgvbig') && med.includes("icn(err ? 'reload'") && !med.includes("txf('common.play', 'Putar')"), 'video: tombol putar ikon');
assert(/k\.el\.play\(\)/.test(med), 'video: langsung diputar sesudah dimuat');
ok('video Halaman: satu ketuk (ikon putar) lalu langsung diputar');
// ganti nama: tidak lagi input di sidebar; diubah di profil lewat ikon pensil (Enter simpan, Esc batal)
const html = rd('renderer/archne-index.html'), allJs = fs.readdirSync(path.join(__dirname, '..', 'renderer', 'js')).map((f) => [f, rd('renderer/js/' + f)]);
assert(!/<input id="name"/.test(html) && /id="myname"/.test(html), 'sidebar: nama hanya tampilan');
assert(allJs.filter(([, c]) => /api\.setName\(/.test(c)).map(([f]) => f).join() === 'archne-profile-compose.js', 'setName hanya dipanggil dari profil');
assert(pf.includes('data-pact="editname"') && pf.includes("ibtn('edit'") && prof.includes("act === 'savename'") && prof.includes("act === 'cancelname'") && /key === 'Enter'/.test(prof) && /key === 'Escape'/.test(prof), 'profil: pensil + simpan/batal + Enter/Esc');
assert(prof.includes("Nama tidak boleh kosong") && prof.includes('.trim()'), 'nama kosong ditolak');
assert(html.includes('css/archne-iconbtn.css') && fs.existsSync(path.join(__dirname, '..', 'renderer/css/archne-iconbtn.css')), 'archne-iconbtn.css dimuat');
ok('ganti nama: sidebar hanya tampilan, edit lewat ikon pensil di profil (simpan/batal, Enter/Esc, kosong ditolak)');
console.log('\nLULUS iconbtn');

'use strict';
// Dijalankan SETELAH `cap sync android` (lihat scripts/mobile.ps1). Aman dijalankan berulang.
//   node scripts/mobile-decordova.js [folder mobile/android]
//
// Kenapa perlu: `cap sync` (CLI Capacitor 8) SELALU membuat ulang modul kosong `capacitor-cordova-android-plugins`, menyisipkan baris
// `apply from: ...cordova.variables.gradle` ke app/capacitor.build.gradle, dan menulis res/xml/config.xml berisi namespace Cordova,
// walau tidak ada satu pun plugin Cordova. Archne tidak memakainya, jadi semuanya dibuang di sini supaya proyek Android bersih.
// Yang TIDAK bisa dibuang: pustaka Maven org.apache.cordova:framework yang dibawa @capacitor/android sendiri (ada di node_modules,
// bukan di proyek ini) dan nama berkas res/xml/config.xml (dibaca inti Capacitor lewat identifier "config").
const fs = require('fs'), path = require('path');
const android = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'mobile', 'android');
const log = (m) => console.log('[decordova] ' + m);
const die = (m) => { console.error('[decordova] GAGAL: ' + m); process.exit(1); };
if (!fs.existsSync(android)) die('folder tidak ada: ' + android);

const MOD = 'capacitor-cordova-android-plugins';

// Ubah isi berkas teks lewat fungsi; pertahankan akhir baris (CRLF/LF). Mengembalikan true bila berubah.
function edit(rel, fn, label) {
  const p = path.join(android, rel);
  if (!fs.existsSync(p)) return false;
  const src = fs.readFileSync(p, 'utf8');
  const nl = src.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const out = fn(src.split(/\r?\n/)).join(nl);
  if (out === src) return false;
  fs.writeFileSync(p, out);
  log(rel.replace(/\\/g, '/') + ': ' + label);
  return true;
}
const drop = (re) => (lines) => lines.filter((l) => !re.test(l));

// 1. folder modul kosong buatan cap sync
const modDir = path.join(android, MOD);
if (fs.existsSync(modDir)) { fs.rmSync(modDir, { recursive: true, force: true }); log(MOD + '/ dihapus'); }

// 2. berkas bawaan cap sync (ditulis ulang tiap sync) dan berkas proyek
edit('app/capacitor.build.gradle', drop(/cordova\.variables\.gradle/), 'baris apply cordova.variables dibuang');
const NOTE = /CATATAN: nama 'cordova'|Archne tidak memakai plugin Cordova/; // komentar penjelasan dari checkpoint sebelumnya
edit('settings.gradle', (lines) => lines.filter((l) => !l.includes(MOD) && !NOTE.test(l)), 'include modul cordova dibuang');
edit('app/build.gradle', (lines) => lines
  .filter((l) => !/implementation project\(':capacitor-cordova-android-plugins'\)/.test(l))
  .filter((l) => !NOTE.test(l))
  .map((l) => l.replace(/dirs\s+'\.\.\/capacitor-cordova-android-plugins\/src\/main\/libs',\s*'libs'/, "dirs 'libs'")), 'dependensi dan flatDir cordova dibuang');
edit('variables.gradle', (lines) => lines.filter((l) => !/cordovaAndroidVersion|bukan Cordova sungguhan/.test(l)), 'cordovaAndroidVersion dibuang');
edit('app/src/main/res/xml/config.xml', (lines) => lines.map((l) => l.replace(/\s+xmlns:cdv="[^"]*"/, '')), 'namespace cdv dibuang');

// 3. verifikasi: tidak boleh ada sisa. Gagal keras dengan daftar berkas, bukan galat Gradle yang membingungkan.
const SKIP = new Set(['build', '.gradle', 'node_modules', '.idea', 'gradle', 'public']); // public = salinan mobile/www
const left = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); continue; }
    if (!/\.(gradle|xml|properties|java|kt|pro|json)$/.test(e.name)) continue;
    const t = fs.readFileSync(p, 'utf8');
    if (/cordova/i.test(t)) left.push(path.relative(android, p).replace(/\\/g, '/'));
  }
})(android);
if (left.length) die('masih ada referensi "cordova" di: ' + left.join(', '));
log('bersih: tidak ada referensi cordova di mobile/android');

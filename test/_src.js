'use strict';
// Pembaca teks sumber untuk tes yang memeriksa isi kode (regex / pencocokan string).
// Memakai helper ini, tes tidak patah saat berkas dipecah (Step 1 & 2 PLAN-RESTRUKTUR).
//   coreSrc() : src/archne-core.js + src/core/*.js (jika ada)
//   htmlSrc() : renderer/archne-index.html + renderer/css/* + renderer/js/* (jika ada)
//   callSrc() : renderer/archne-call.js + renderer/call/* (jika ada)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
function dir(sub, ext) {
  const d = path.join(root, sub);
  if (!fs.existsSync(d)) return '';
  return fs.readdirSync(d).filter((f) => f.endsWith(ext)).sort().map((f) => '\n' + rd(sub, f)).join('');
}
const coreSrc = () => rd('src', 'archne-core.js') + dir('src/core', '.js');
const htmlSrc = () => rd('renderer', 'archne-index.html') + dir('renderer/css', '.css') + dir('renderer/js', '.js');
const callSrc = () => rd('renderer', 'archne-call.js') + dir('renderer/call', '.js');
// inlineJs(): skrip utama UI (dulu satu <script> inline di archne-index.html). Sebelum Step 2 diambil dari archne-index.html,
// sesudahnya dari renderer/js/*.js berurutan (urutan = urutan tag <script> di archne-index.html).
// jsOrder(): urutan muat skrip renderer/js sesuai tag <script src="js/..."> di archne-index.html (nama berkas tidak lagi memakai angka urutan).
function jsOrder() {
  const html = rd('renderer', 'archne-index.html'), out = [], re = /<script src="js\/([^"]+\.js)"><\/script>/g;
  let m; while ((m = re.exec(html))) out.push(m[1]);
  return out;
}
function inlineJsRaw() {
  const d = path.join(root, 'renderer', 'js');
  if (fs.existsSync(d)) return jsOrder().map((f) => rd('renderer', 'js', f)).join('\n');
  return /<script>\n([\s\S]*)<\/script><\/body>/.exec(rd('renderer', 'archne-index.html'))[1];
}
// pagesJs(): berkas UI Halaman (renderer/js/archne-pages.js dan pecahannya pages-*.js, 3d-a; berkas baru wajib didaftarkan di test/pagesplit.js) berurutan sesuai archne-index.html = urutan dimuat; tes yang menjalankan UI Halaman di vm memuat semuanya.
const pagesFiles = () => fs.readdirSync(path.join(root, 'renderer', 'js')).filter((f) => /^archne-pages(-.*)?\.js$/.test(f)).sort((a, b) => jsOrder().indexOf(a) - jsOrder().indexOf(b));
// txfJs(): definisi asli txf/tnf dari archne-state-util.js (C4). Berkas Halaman memakainya, tapi tes vm yang hanya memuat berkas Halaman tidak memuat archne-state-util.js; tanpa ini txf tak terdefinisi. Diambil dari sumbernya (bukan salinan) agar tidak melenceng.
const txfJs = () => { const u = rd('renderer', 'js', 'archne-state-util.js'); return ['txf', 'tnf'].map((n) => { const m = new RegExp('^const ' + n + ' = .*$', 'm').exec(u); if (!m) throw new Error(n + ' tidak ditemukan di archne-state-util.js'); return m[0]; }).join('\n'); };
const pagesJsRaw = () => txfJs() + '\n' + pagesFiles().map((f) => rd('renderer', 'js', f)).join('\n');
// i18nJs(): renderer/archne-i18n.js + kamus (urutan muat di archne-index.html). Tes vm yang ingin teks lewat tx()/tn() memuat ini SEBELUM inlineJs(); tanpa ini tx tak terdefinisi (kode UI menjaganya dengan typeof).
const i18nJs = () => ['archne-i18n.js', 'i18n/archne-en.js', 'i18n/archne-id.js'].map((f) => rd('renderer', f)).join('\n');
// F1: tes vm yang memuat UI lewat inlineJs()/pagesJs() kini BAWAAN berjalan terhadap kamus asli yang dikunci ke Indonesia
// (i18nJs() + I18N.setLang('id')), jadi tidak bergantung pada bahasa bawaan aplikasi (English) dan teks cadangan txf tidak lagi dipakai diam-diam.
//   ARCHNE_TEST_I18N=id   (bawaan)  kamus asli, bahasa id
//   ARCHNE_TEST_I18N=en             kamus asli, bahasa en (informasi: tes yang mengecek teks Indonesia memang gagal di sini)
//   ARCHNE_TEST_I18N=off            tanpa kamus (jalur cadangan txf/tnf, seperti sebelum F1)
// Core palsu di tes yang membuka Pengaturan harus melaporkan lang: 'id' (archne-lang.js menyamakan UI dengan Core).
const forcedLang = () => process.env.ARCHNE_TEST_I18N || 'id';
const forced = () => (forcedLang() === 'off' ? '' : i18nJs() + "\nI18N.setLang('" + forcedLang() + "');\n");
const inlineJs = () => forced() + inlineJsRaw();
const pagesJs = () => forced() + pagesJsRaw();
module.exports = { coreSrc, htmlSrc, callSrc, inlineJs, i18nJs, txfJs, pagesFiles, pagesJs };

'use strict';
// i18n (E2): terjemahan di sisi Core/Node memakai kamus YANG SAMA dengan UI (renderer/archne-i18n.js + renderer/i18n/archne-en.js + archne-id.js).
// Berkas itu dijalankan di konteks `vm` terpisah (tanpa DOM), jadi tidak ada kamus kedua dan tidak ada perubahan di renderer.
// Android menyalin src + renderer ke proyek Node, dan paket Electron memuat keduanya (package.json "files"): berkas kamus selalu ada di sisi Core.
//
// API (semua aman dipanggil kapan saja; tidak pernah melempar):
//   bind(() => 'en'|'id')        pasang sumber bahasa (Core: () => core.getSettings().lang). Dibaca SAAT DIPANGGIL, jadi ganti bahasa langsung berlaku.
//   lang()                       bahasa aktif ('en' bawaan bila sumber belum dipasang / gagal / tak dikenal)
//   tr(kunci, param, cadangan)   terjemahkan. Kunci tak ada di kamus, atau kamus gagal dimuat -> `cadangan` (teks Indonesia asli) diberi param juga.
//   trn(kunci, n, param, cadangan)  bentuk jamak (kunci.one / kunci.other); {n} otomatis terisi
//   nf(n)                        angka berformat bahasa aktif (pemisah ribuan)
//   ok()                         true bila kamus berhasil dimuat
//   load(dir?)                   muat ulang dari folder renderer lain (dipakai tes untuk menguji kegagalan muat); mengembalikan ok()
// Kompatibel Node 12 (Android): tanpa ?. ?? dan sejenisnya.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DEF = 'en';
let I = null;          // objek I18N dari konteks vm (null = gagal dimuat)
let source = null;     // () => kode bahasa

function load(dir) {
  I = null;
  try {
    const root = dir || path.join(__dirname, '..', '..', 'renderer');
    const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
    for (const f of ['archne-i18n.js', path.join('i18n', 'archne-en.js'), path.join('i18n', 'archne-id.js')]) {
      vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
    }
    const api = vm.runInContext('I18N', ctx);
    if (!api || typeof api.tx !== 'function' || !api.has('en', 'common.close')) return false;
    I = api;
    return true;
  } catch (e) {
    I = null;
    return false;
  }
}

function bind(fn) { source = typeof fn === 'function' ? fn : null; }

function lang() {
  let l = DEF;
  try { if (source) l = source(); } catch (e) { l = DEF; }
  if (I && !I.valid(l)) l = DEF;
  return l === 'id' ? 'id' : DEF;
}

// Angka bulat >= 1000 di parameter diberi pemisah ribuan sesuai bahasa ('.' untuk id, ',' untuk en); tanpa ICU (Android tidak membawa locale id).
function grp(n, sep) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep); }
function numFmt(params, sep) {
  if (!params) return params;
  let out = null;
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) >= 1000) { if (!out) out = Object.assign({}, params); out[k] = grp(v, sep); }
  }
  return out || params;
}

function fmt(s, params) {
  if (!params) return s;
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(params, k) && params[k] != null ? String(params[k]) : m));
}

// Samakan bahasa konteks vm dengan sumber (setLang murah bila tidak berubah; hanya dipanggil bila beda).
function sync() {
  const l = lang();
  if (I.getLang() !== l) I.setLang(l);
  return l;
}

function tr(key, params, fallback) {
  try {
    if (I) {
      const l = sync();
      if (I.has(l, key) || I.has(DEF, key)) return I.tx(key, numFmt(params, l === 'id' ? '.' : ','));
    }
  } catch (e) { /* jatuh ke cadangan */ }
  return fmt(fallback == null ? String(key) : fallback, numFmt(params, '.'));
}

function trn(key, n, params, fallback) {
  try {
    if (I) {
      const l = sync();
      if (I.has(l, key + '.other') || I.has(DEF, key + '.other')) return I.tn(key, n, numFmt(params, l === 'id' ? '.' : ','));
    }
  } catch (e) { /* jatuh ke cadangan */ }
  return fmt(fallback == null ? String(key) : fallback, Object.assign({ n }, params || {}));
}

function nf(n) {
  try { return Number(n).toLocaleString(lang() === 'id' ? 'id-ID' : 'en-US'); } catch (e) { return String(n); }
}

function ok() { return !!I; }

load();

module.exports = { bind, lang, tr, trn, nf, ok, load, numFmt };

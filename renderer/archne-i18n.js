// ---- i18n (A1): terjemahan UI. Bahasa bawaan English; pilihan lain Bahasa Indonesia (Pengaturan -> Bahasa). ----
// Dimuat PALING AWAL di archne-index.html (sebelum skrip lain), lalu kamus: i18n/archne-en.js dan i18n/archne-id.js memanggil I18N.add(lang, {...}).
//
// API global:
//   tx('kunci', { nama: 'x' })     terjemahkan; placeholder {nama}. Kunci tidak ada di bahasa aktif -> English -> kunci itu sendiri.
//   tn('kunci', n, { ... })        bentuk jamak: mencari 'kunci.one' / 'kunci.other' (aturan Intl.PluralRules bahasa aktif); {n} otomatis terisi.
//   I18N.setLang('id')             ganti bahasa + catat di localStorage 'lc.lang' + <html lang> + terapkan ulang atribut data-i18n.
//   I18N.getLang() / I18N.LANGS / I18N.onChange(fn) / I18N.applyDom(root?) / I18N.add(lang, dict) / I18N.has(lang, key)
//
// Atribut HTML statis (dibaca applyDom): data-i18n (teks), data-i18n-ph (placeholder), data-i18n-title (title), data-i18n-aria (aria-label).
//   data-i18n MENGGANTI isi teks elemen. Untuk tombol berikon, bungkus teksnya dengan <span data-i18n="..."> supaya <svg> tidak terhapus.
// Tidak ada innerHTML dari kamus (tanpa risiko XSS): kamus hanya berisi teks biasa.
// Aman dimuat di lingkungan tanpa DOM/localStorage (tes vm, Node).
(function (g) {
  'use strict';
  const DEF = 'en';
  const LANGS = [['en', 'English'], ['id', 'Bahasa Indonesia']];
  const CACHE_KEY = 'lc.lang';
  const DICT = {};
  const listeners = [];
  const missing = new Set(); // kunci yang diminta tapi tidak ada di kamus mana pun (untuk dicek tes/pengembang)
  let lang = DEF;

  const valid = (l) => LANGS.some((x) => x[0] === l);
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

  function add(l, dict) {
    if (!l || !dict || typeof dict !== 'object') return;
    DICT[l] = Object.assign(DICT[l] || {}, dict);
  }
  function has(l, key) { return own(DICT[l], key); }

  function fmt(s, params) {
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (own(params, k) && params[k] != null ? String(params[k]) : m));
  }

  function raw(key) {
    if (own(DICT[lang], key)) return DICT[lang][key];
    if (own(DICT[DEF], key)) return DICT[DEF][key];
    missing.add(key);
    return null;
  }

  function tx(key, params) {
    const s = raw(key);
    return fmt(s == null ? String(key) : s, params);
  }

  function pluralRule(n) {
    try { return new Intl.PluralRules(lang).select(n); } catch (x) { return n === 1 ? 'one' : 'other'; }
  }
  function tn(key, n, params) {
    const p = Object.assign({ n }, params || {});
    const rule = pluralRule(n);
    let s = raw(key + '.' + rule);
    if (s == null && rule !== 'other') s = raw(key + '.other');
    return fmt(s == null ? String(key) : s, p);
  }

  function applyDom(root) {
    const doc = root || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.querySelectorAll !== 'function') return 0;
    let n = 0;
    const each = (sel, attr, fn) => {
      const list = doc.querySelectorAll(sel) || [];
      for (let i = 0; i < list.length; i++) {
        const el = list[i], key = el.getAttribute && el.getAttribute(attr);
        if (key) { fn(el, tx(key)); n++; }
      }
    };
    each('[data-i18n]', 'data-i18n', (el, s) => { el.textContent = s; });
    each('[data-i18n-ph]', 'data-i18n-ph', (el, s) => { el.setAttribute('placeholder', s); });
    each('[data-i18n-title]', 'data-i18n-title', (el, s) => { el.setAttribute('title', s); });
    each('[data-i18n-aria]', 'data-i18n-aria', (el, s) => { el.setAttribute('aria-label', s); });
    return n;
  }

  function cache(l) { try { if (l === DEF) localStorage.removeItem(CACHE_KEY); else localStorage.setItem(CACHE_KEY, l); } catch (x) {} }
  function cached() { try { const l = localStorage.getItem(CACHE_KEY); return valid(l) ? l : null; } catch (x) { return null; } }

  function mark() {
    try { if (typeof document !== 'undefined' && document.documentElement && document.documentElement.setAttribute) document.documentElement.setAttribute('lang', lang); } catch (x) {}
  }

  // setLang: bahasa tak dikenal -> English. Cache localStorage ikut diperbarui (penyimpanan resmi ada di Core, dipasang di A2/A3).
  function setLang(l) {
    if (!valid(l)) l = DEF;
    const changed = l !== lang;
    lang = l;
    cache(l);
    mark();
    applyDom();
    if (changed) listeners.slice().forEach((fn) => { try { fn(lang); } catch (x) {} });
    return lang;
  }
  function getLang() { return lang; }
  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  // Awal: cache localStorage (tanpa deteksi bahasa sistem: bawaan memang English). Core menyinkronkan lagi saat UI dibuka (lihat A3).
  lang = cached() || DEF;
  mark();

  const api = { DEF, LANGS, add, has, tx, tn, setLang, getLang, onChange, applyDom, valid, missing, _dict: DICT };
  g.I18N = api;
  g.tx = tx;
  g.tn = tn;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

'use strict';
// src/archne-weboffrewrite.js — Penulis ulang referensi untuk "Jadikan offline" (0.34.0 Fase O3a). MURNI: tanpa jaringan, tanpa berkas, tanpa IPC. Teks masuk -> teks keluar.
// Mengganti URL eksternal yang SUDAH diunduh (peta url -> jalur 'assets/vendor/...') dengan jalur lokal. Tempat yang diganti sama persis dengan tempat pemindai O1 (archne-webassets) menemukannya;
// selain itu tidak disentuh: <a href>, komentar, URL yang tidak ada di peta, URL berisi templat, konteks fetch / import (golongan 'online' tidak pernah masuk peta).
// API:
//   canon(raw) -> URL kanonik (kunci yang sama dengan pemindai: tanpa kata sandi, tanpa fragmen, '//x' jadi 'https://x') | null
//   rewriteFile(rel, text, map, st) -> teks baru. rel = jalur berkas di situs (ekstensi menentukan cara: css | js, mjs | php | selain itu HTML/SVG). map = Map(kanonik -> jalur vendor). st = penghitung { n, sri }.
//   rewriteVendorCss(rel, text, base, map, st) -> teks baru. CSS hasil unduhan: referensi relatif DIURAI terhadap `base` (URL asal CSS-nya), lalu dicari di peta. Yang tidak ada di peta dicatat di st.unresolved ({ p, url }) dan dibiarkan (rantai: O3b).
//   cssRefs(text, base) -> [{ url, kind:'style'|'font'|'image', cred? }]: referensi CSS unduhan yang harus diikuti (O3c); aturan urai sama dengan rewriteVendorCss
//   makeMap(items) -> Map dari butir manifest ({ url, rel })
//   relFrom(fileRel, target) -> jalur relatif dari folder berkas ke target
// Jalur yang disisipkan selalu hasil webpath (daftar-putih [A-Za-z0-9._/-]), jadi aman disisipkan di atribut, CSS, maupun string tanpa pelolosan.
//   HTML / CSS: jalur RELATIF terhadap berkas (tetap jalan bila situs diekspor / dibuka dari subfolder). String JS / PHP: jalur akar '/assets/vendor/...' (relatif terhadap dokumen, bukan berkas skrip, jadi tidak bisa relatif).
//   Atribut integrity pada tag yang ditulis ulang DIHAPUS (isi berkas bisa berubah, mis. CSS yang jalurnya ditulis ulang; berkas aslinya sudah diverifikasi O2d-2 sebelum disimpan). st.sri menghitungnya.
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/weboffrewrite.js): tiap penjaga satu baris.
const path = require('path');

const TPL = /<\?|\{\{|\$\{|\{%|<%/;
const dec = (s) => String(s).replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0*39;/g, "'");

function canon(raw) {
  if (typeof raw !== 'string') return null;
  let s = dec(raw).trim();
  if (!s || s.length > 2048) return null;
  if (TPL.test(s)) return null; // G:tpl
  if (s.startsWith('//')) s = 'https:' + s;
  if (!/^https?:\/\//i.test(s)) return null;
  let u; try { u = new URL(s); } catch { return null; }
  if (!u.hostname) return null;
  u.username = ''; u.password = ''; u.hash = '';
  return u.href;
}

function makeMap(items) {
  const m = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const c = it && canon(it.url);
    if (c && typeof it.rel === 'string' && /^assets\/vendor\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(it.rel) && !m.has(c)) m.set(c, it.rel);
  }
  return m;
}

const relFrom = (fileRel, target) => path.posix.relative('/' + path.posix.dirname(fileRel).replace(/^\.$/, ''), '/' + target) || target;
const extOf = (p) => { const m = /\.([A-Za-z0-9]{1,12})$/.exec(p); return m ? m[1].toLowerCase() : ''; };

// Terapkan fn pada potongan di LUAR komentar (cmt = regex global komentar).
function outside(text, cmt, fn) {
  let out = '', last = 0, m;
  cmt.lastIndex = 0;
  while ((m = cmt.exec(text))) { out += fn(text.slice(last, m.index)) + m[0]; last = m.index + m[0].length; }
  return out + fn(text.slice(last));
}

// ---- CSS ----
// Satu lintasan untuk @import dan url(): bentuk yang sudah ditulis ulang tidak diperiksa dua kali.
const CSSREF = /(@import\s+(?:url\(\s*)?)(["']?)([^"')\s;]{1,2048})|(url\(\s*)(["']?)([^"')]{1,2048})\5(\s*\))/gi;
// pick(rawUrl) -> jalur relatif baru | null
// pick(rawUrl, info) -> jalur relatif baru | null. info = { imp: dari @import, ff: di dalam blok @font-face } (dipakai O3c untuk menebak jenis berkas)
function cssBody(text, pick) {
  return outside(text, /\/\*[\s\S]*?\*\//g, (seg) => seg.replace(CSSREF, (m, a1, q1, u1, a2, q2, u2, t2, off, whole) => {
    if (a1 !== undefined) { const n = pick(u1.trim(), { imp: true, ff: false }); return n ? a1 + q1 + n : m; }
    const i = whole.lastIndexOf('@font-face', off), close = i >= 0 ? whole.indexOf('}', i) : -1;
    const n = pick(u2.trim(), { imp: false, ff: i >= 0 && (close < 0 || close > off) });
    return n ? a2 + q2 + n + q2 + t2 : m;
  }));
}

// ---- atribut HTML ----
const attrRe = (name) => new RegExp('((?<![\\w:-])' + name + '\\s*=\\s*)(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'); // sama dengan attr() pemindai
function getAttr(tag, name) { const m = attrRe(name).exec(tag); return m ? dec(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]) : null; }
// fn(rawValue) -> nilai baru | null (tanpa perubahan). Mengembalikan tag baru.
function mapAttr(tag, name, fn) {
  return tag.replace(attrRe(name), (m, pre, dq, sq, uq) => {
    const raw = dq !== undefined ? dq : sq !== undefined ? sq : uq;
    const nv = fn(raw);
    if (nv == null) return m;
    return dq !== undefined ? pre + '"' + nv + '"' : sq !== undefined ? pre + "'" + nv + "'" : pre + nv;
  });
}
const SRCSET_SPLIT = /,\s+/;
// Konteks yang BUKAN aset (sama dengan pemindai): fetch / XHR / WebSocket dan import ES. Golongan 'online' tidak masuk peta, tapi di sini dijaga lagi supaya salah peta tidak merusak kode.
const NOT_ASSET = /(?:\bimport\s*\(|\bfrom\s*|\bimport\s*|fetch|axios(?:\.\w+)?|\.open|\.ajax|\.get|\.post|WebSocket|EventSource|sendBeacon|importScripts|file_get_contents|curl_init|wp_remote_\w+|CURLOPT_URL|url\s*:)\s*[(,:=]?\s*$/i;

function ctxFor(rel, map, st, base) {
  // lookup untuk satu URL mentah -> jalur vendor | null
  const hit = (raw) => { const c = canon(raw); return c ? map.get(c) || null : null; };
  const one = (raw) => { const r = hit(raw); if (!r) return null; st.n++; return relFrom(rel, r); };
  const set = (raw) => {
    if (TPL.test(raw)) return one(raw);
    let any = false;
    const parts = String(raw).split(SRCSET_SPLIT).map((p) => {
      const t = p.trim().split(/\s+/);
      const r = hit(t[0]);
      if (!r) return p.trim();
      any = true; st.n++; t[0] = relFrom(rel, r);
      return t.join(' ');
    });
    return any ? parts.join(', ') : null;
  };
  const css = (text) => cssBody(text, (u) => {
    if (base) { // CSS hasil unduhan: relatif diurai terhadap URL asalnya
      if (/^(data:|#|about:|blob:)/i.test(u)) return null;
      let abs; try { abs = new URL(TPL.test(u) ? 'x:' : u, base).href; } catch { return null; }
      if (!/^https?:/i.test(abs)) return null;
      const r = hit(abs);
      if (r) { st.n++; return relFrom(rel, r); }
      if (st.unresolved && st.unresolved.length < 200) st.unresolved.push({ p: rel, url: abs.slice(0, 300) });
      if (st.unresolvedN !== undefined) st.unresolvedN++;
      return null;
    }
    return one(u);
  });
  const str = (text) => text.replace(/(["'`])((?:https?:)?\/\/[^"'`\s\\]{3,2000})\1/g, (m, q, u, off, whole) => {
    const before = whole.slice(Math.max(0, off - 60), off);
    if (/href\s*=\s*$/i.test(before)) return m; // G:anchor — tautan, bukan aset
    if (NOT_ASSET.test(before)) return m; // G:ctx
    const r = hit(u);
    if (!r) return m;
    st.n++; return q + '/' + r + q;
  });
  return { one, set, css, str, hit };
}

const TAGS = /<(script|link|img|input|source|video|audio|iframe|frame|embed|object|image|use|div|body|section|span|a|p|td|header|footer|main|li|ul|button)\b((?:"[^"]*"|'[^']*'|[^'">]){0,4000})>/gi;
const LINK_REL = /\b(stylesheet|preload|modulepreload|prefetch|icon|apple-touch-icon|mask-icon)\b/;

function htmlBody(text, rel, php, c, st) {
  const dropSri = (t) => { const n = t.replace(/(\s)integrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '$1'); if (n !== t) st.sri++; return n; };
  const tag = (m, nameRaw) => {
    const name = nameRaw.toLowerCase();
    const before = st.n;
    let t = m;
    const one = (a) => { t = mapAttr(t, a, c.one); };
    const set = (a) => { t = mapAttr(t, a, c.set); };
    switch (name) {
      case 'script': one('src'); break;
      case 'link': {
        const rl = (getAttr(m, 'rel') || '').toLowerCase();
        if (LINK_REL.test(rl)) { one('href'); set('imagesrcset'); }
        break;
      }
      case 'img': one('src'); set('srcset'); one('data-src'); set('data-srcset'); break;
      case 'input': if ((getAttr(m, 'type') || '').toLowerCase() === 'image') one('src'); break;
      case 'source': one('src'); set('srcset'); break;
      case 'video': one('poster'); break;
      case 'image': case 'use': one('href'); one('xlink:href'); break;
      default: break;
    }
    t = mapAttr(t, 'style', (v) => { if (!/url\(/i.test(v)) return null; const b = st.n; const r = c.css(v); return st.n > b ? r : null; });
    if (st.n > before && (name === 'script' || name === 'link')) t = dropSri(t); // G:sri
    return t;
  };
  return outside(text, /<!--[\s\S]*?-->/g, (seg) => {
    seg = seg.replace(TAGS, tag);
    seg = seg.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, b, z) => a + c.css(b) + z);
    seg = seg.replace(/(<script\b)([^>]*)(>)([\s\S]*?)(<\/script>)/gi, (m, a, attrs, g, body, z) => (/\bsrc\s*=/i.test(attrs) || !body.trim() ? m : a + attrs + g + c.str(body) + z));
    if (php) seg = c.str(seg);
    return seg;
  });
}

function rewriteFile(rel, text, map, st) {
  st = st || { n: 0, sri: 0 };
  if (st.n === undefined) st.n = 0;
  if (st.sri === undefined) st.sri = 0;
  const c = ctxFor(rel, map, st, null), ext = extOf(rel);
  if (ext === 'css') return c.css(text);
  if (ext === 'js' || ext === 'mjs') return c.str(text);
  return htmlBody(text, rel, ext === 'php', c, st);
}

// O3c: referensi dalam CSS unduhan yang HARUS diikuti. Diurai terhadap `base` dengan aturan yang SAMA dengan rewriteVendorCss (jadi himpunannya sama dengan st.unresolved bila petanya kosong).
// -> [{ url (kanonik, mutlak), kind: 'style'|'font'|'image', cred? }] tanpa duplikat. data:, #, templat, dan skema selain http(s) dilewati.
const FONT_EXT = new Set(['woff2', 'woff', 'ttf', 'otf', 'eot']);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp']);
function cssRefs(text, base) {
  const out = [], seen = new Set();
  if (typeof text !== 'string') return out;
  cssBody(text, (u, info) => {
    if (/^(data:|#|about:|blob:)/i.test(u)) return null;
    let abs, uo; try { uo = new URL(TPL.test(u) ? 'x:' : u, base); abs = uo.href; } catch { return null; }
    if (!/^https?:/i.test(abs)) return null;
    const cred = !!(uo.username || uo.password);
    const c = canon(abs);
    if (!c || seen.has(c)) return null;
    seen.add(c);
    const ext = extOf(new URL(c).pathname);
    const kind = info.imp ? 'style' : IMG_EXT.has(ext) ? 'image' : FONT_EXT.has(ext) ? 'font' : ext === 'css' ? 'style' : info.ff ? 'font' : 'image';
    out.push(cred ? { url: c, kind, cred: true } : { url: c, kind });
    return null;
  });
  return out;
}

function rewriteVendorCss(rel, text, base, map, st) {
  st = st || {};
  if (st.n === undefined) st.n = 0;
  if (st.sri === undefined) st.sri = 0;
  if (!st.unresolved) st.unresolved = [];
  if (st.unresolvedN === undefined) st.unresolvedN = 0;
  return ctxFor(rel, map, st, base).css(text);
}

module.exports = { canon, makeMap, relFrom, rewriteFile, rewriteVendorCss, cssRefs };

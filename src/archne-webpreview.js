'use strict';
// src/archne-webpreview.js — pratinjau SEMENTARA situs milik sendiri (0.34.0 Fase E.5 / Sesi E-4). Murni fungsi atas WebFiles: tanpa jaringan, tanpa jalur disk keluar.
// Penampil sungguhan (protokol archne-site, header + CSP dari penampil) = Fase F; F.4 akan menggantikan ini supaya yang diuji = yang dilihat peer.
// Sementara: berkas awal dibaca, lalu stylesheet / skrip / gambar / font relatif DISISIPKAN ke dalam satu dokumen HTML (CSS: <style>, JS: <script>, gambar dan font: data URI).
// Dokumen ini dimuat renderer di <iframe sandbox="allow-scripts" srcdoc> (asal buram, tanpa allow-same-origin), dan diawali <meta> CSP yang menutup SEMUA jaringan (default-src 'none', hanya data: dan inline),
// jadi situs yang diuji tidak bisa menghubungi apa pun di luar dan tidak bisa menyentuh aplikasi. <meta> ditaruh paling awal (sebelum konten situs) supaya komentar / teks situs tidak bisa melewatinya.
// Batas yang diketahui (dilaporkan ke pengguna lewat `limits`): tautan ke halaman lain tidak berfungsi; <script type="module"> tidak bisa mengimpor berkas lain; @import CSS tidak diikuti; media (audio/video) tidak disisipkan; mode dokumen selalu standar (<!doctype html> ditambahkan).
const path = require('path');
const { ek } = require('./core/archne-ecode');
const { tryRel } = require('./archne-webfiles');

const HTML_EXT = new Set(['html', 'htm', 'xhtml']);
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp' };
const FONT_MIME = { woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };
const TEXT_MAX = 2 * 1024 * 1024, BIN_MAX = 3 * 1024 * 1024, BUDGET = 8 * 1024 * 1024, MISS_KEEP = 20, DEPTH_MAX = 2;
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

const extOf = (p) => { const m = /\.([A-Za-z0-9]{1,12})$/.exec(p); return m ? m[1].toLowerCase() : ''; };
const dec = (s) => String(s).replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
const b64 = (buf) => buf.toString('base64');
function attr(tag, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
  return m ? dec(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : null;
}
function dropAttr(tag, name) { return tag.replace(new RegExp('\\s' + name + '\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s>]+)', 'i'), ''); }

// Rujukan situs -> jalur relatif di www/ (atau null bila bukan berkas situs: skema, //host, kosong, #anchor, keluar dari akar). Awalan "/" = akar situs.
function resolveRef(baseDir, ref) {
  if (typeof ref !== 'string') return null;
  let r = ref.trim();
  if (!r || r[0] === '#' || r.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(r)) return null;
  r = r.split(/[?#]/)[0];
  try { r = decodeURIComponent(r); } catch { return null; }
  if (!r || r.indexOf('\\') >= 0 || r.indexOf('\0') >= 0) return null;
  const segs = r[0] === '/' ? [] : baseDir.split('/').filter(Boolean);
  for (const s of r.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') { if (!segs.length) return null; segs.pop(); continue; }
    segs.push(s);
  }
  return segs.length ? tryRel(segs.join('/')) : null;
}
const isRemote = (ref) => typeof ref === 'string' && (/^(https?:)?\/\//i.test(ref.trim()));

function build(wf, entry) {
  const e = typeof entry === 'string' ? tryRel(entry) : null;
  const st = e && wf.stat(e);
  if (!st || st.type !== 'file') throw ek('e.lw.prevNone', null, 'Berkas awal tidak ditemukan. Atur di tab Pengaturan.', 'noentry');
  if (!HTML_EXT.has(extOf(e))) throw ek('e.lw.prevType', null, 'Berkas awal harus berkas HTML untuk dipratinjau', 'type');
  const ctx = { wf, used: 0, inlined: 0, external: 0, missing: [], seen: new Set() };
  const note = (rel) => { if (ctx.missing.length < MISS_KEEP && !ctx.missing.includes(rel)) ctx.missing.push(rel); };
  const take = (rel, max) => { // -> Buffer | null (tidak ada / terlalu besar / melewati anggaran)
    try {
      const buf = wf.read(rel, { max });
      if (ctx.used + buf.length > BUDGET) { note(rel); return null; }
      ctx.used += buf.length; return buf;
    } catch { note(rel); return null; }
  };
  const dataUri = (rel, table) => { const m = table[extOf(rel)]; if (!m) return null; const buf = take(rel, BIN_MAX); return buf ? 'data:' + m + ';base64,' + b64(buf) : null; };
  const base = (rel) => path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);

  const cssOf = (rel) => { // teks CSS dengan url(...) relatif diganti data URI
    const buf = take(rel, TEXT_MAX); if (!buf) return null;
    const dir = base(rel), txt = buf.toString('utf8');
    if (/@import\b/i.test(txt)) ctx.imp = true;
    return txt.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi, (all, a, b, c) => {
      const ref = dec(a !== undefined ? a : b !== undefined ? b : c);
      if (/^data:/i.test(ref.trim()) || ref.trim()[0] === '#') return all;
      if (isRemote(ref)) { ctx.external++; return 'url("")'; }
      const p = resolveRef(dir, ref); if (!p) return all;
      const uri = dataUri(p, Object.assign({}, IMG_MIME, FONT_MIME));
      if (uri) { ctx.inlined++; return 'url("' + uri + '")'; }
      return 'url("")';
    }).replace(/<\/style/gi, '<\\/style');
  };

  const html0 = wf.read(e, { max: TEXT_MAX }).toString('utf8').replace(/^\uFEFF/, '');
  const dir = base(e);
  ctx.used += html0.length;
  let html = html0;
  // <link rel=stylesheet href> -> <style>
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) return tag;
    const ref = attr(tag, 'href'); if (ref === null) return tag;
    if (isRemote(ref)) { ctx.external++; return ''; }
    const p = resolveRef(dir, ref); if (!p) return tag;
    const css = cssOf(p); if (css === null) return '';
    ctx.inlined++;
    const media = attr(tag, 'media');
    return '<style' + (media ? ' media="' + media.replace(/"/g, '&quot;') + '"' : '') + '>' + css + '</style>';
  });
  // <script src> -> <script> (tanpa src)
  html = html.replace(/<script\b([^>]*)>\s*<\/script\s*>/gi, (all, attrs) => {
    const ref = attr('<script ' + attrs + '>', 'src'); if (ref === null) return all;
    if (isRemote(ref)) { ctx.external++; return ''; }
    const p = resolveRef(dir, ref); if (!p) return all;
    const buf = take(p, TEXT_MAX); if (!buf) return '';
    ctx.inlined++;
    const rest = dropAttr('<script ' + attrs + '>', 'src').slice(7, -1).trim();
    return '<script' + (rest ? ' ' + rest : '') + '>' + buf.toString('utf8').replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--') + '</script>';
  });
  // <img src> / <source srcset tidak> -> data URI
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const ref = attr(tag, 'src'); if (ref === null || /^data:/i.test(ref.trim())) return tag;
    if (isRemote(ref)) { ctx.external++; return dropAttr(tag, 'src'); }
    const p = resolveRef(dir, ref); if (!p) return tag;
    const uri = dataUri(p, IMG_MIME);
    if (!uri) return dropAttr(tag, 'src');
    ctx.inlined++;
    return dropAttr(tag, 'src').replace(/^<img/i, '<img src="' + uri + '"');
  });
  // style="...url()" dan <style>@import / url()</style> milik situs sendiri: url() relatif di <style> inline disisipkan juga
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (all, open, body, close) => {
    if (!/url\(/i.test(body)) return all;
    const out = body.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi, (u, a, b, c) => {
      const ref = dec(a !== undefined ? a : b !== undefined ? b : c);
      if (/^data:/i.test(ref.trim()) || ref.trim()[0] === '#') return u;
      if (isRemote(ref)) { ctx.external++; return 'url("")'; }
      const p = resolveRef(dir, ref); if (!p) return u;
      const uri = dataUri(p, Object.assign({}, IMG_MIME, FONT_MIME));
      if (uri) { ctx.inlined++; return 'url("' + uri + '")'; }
      return 'url("")';
    });
    return open + out + close;
  });
  const limits = [];
  if (/<script\b[^>]*\btype\s*=\s*["']?module/i.test(html0)) limits.push('module');
  if (ctx.imp || /@import\b/i.test(html0)) limits.push('import');
  if ((html0.match(/<a\b[^>]*>/gi) || []).some((t) => resolveRef(dir, attr(t, 'href')) !== null)) limits.push('links');
  if (/<(audio|video)\b/i.test(html0)) limits.push('media');
  return { html: '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + CSP + '">' + html, entry: e, inlined: ctx.inlined, external: ctx.external, missing: ctx.missing, limits, bytes: ctx.used };
}

module.exports = { build, resolveRef, CSP };

'use strict';
// src/archne-webpath.js — Penamaan jalur aset untuk "Jadikan offline" (0.34.0 Fase O2d-1). MURNI: tanpa jaringan, tanpa DNS, tanpa berkas, tanpa IPC. Hanya mengubah (url, jenis) menjadi jalur relatif yang aman.
// API:
//   pathFor(url, kind, type?) -> { ok:true, rel, host, ext, flat } | { ok:false, code:'bad'|'kind' }
//     rel  = 'assets/vendor/<host>/<dir>/<nama><ext>' (selalu '/', selalu relatif, selalu di bawah assets/vendor). flat:true = jalur diringkas jadi '<host>/_/<hash16><ext>' karena terlalu dalam/panjang.
//     kind = script | style | font | image. type (opsional) = Content-Type dari pengambil; HANYA dipakai memilih ekstensi bila nama tidak punya ekstensi yang sah untuk jenis itu.
//   assign(list) -> { ok:true, results:[...] } | { ok:false, code:'bad' } (list bukan larik)
//     list = [{ url, kind, type? }]; results SEJAJAR dengan list: { i, ok:true, rel, renamed } | { i, ok:false, code:'bad'|'kind'|'path' }. renamed:true = jalur dasar sudah dipakai butir sebelumnya (atau bertabrakan dengan berkas/folder) sehingga diganti.
//   cleanSegment(s) -> satu segmen aman (diekspor untuk tes).
// Sikap: daftar-putih karakter [A-Za-z0-9._-]; selain itu jadi '_'. Segmen diambil SESUDAH decode persen, jadi %2f, %5c, %00, %2e%2e tidak bisa menyelundupkan pemisah atau '..'. Titik di depan jadi '_' (tanpa '..', '.', berkas tersembunyi),
//   titik di belakang dibuang (Windows membuangnya diam-diam => dua nama jadi satu), nama perangkat Windows (con, nul, com1, lpt1, ...) diberi awalan '_' walau berekstensi ('con.example.com' pun terlarang di Windows lama).
//   Ekstensi dipaksa sesuai jenis: ekstensi yang tidak sah ditambahi ekstensi jenisnya ('evil.html' jenis script => 'evil.html.js'), sehingga akhiran terakhir selalu sah. Query ikut dinamai (hash 8 hex), fragmen dibuang.
//   Tabrakan dibandingkan TANPA membedakan huruf besar/kecil (NTFS/APFS) dan memeriksa berkas-vs-folder dua arah. Urutan list yang menang; yang kalah diberi sufiks '-<hash8 URL>', lalu jalur datar '_/<hash16>', lalu '-2'...'-50'.
//   Tidak ada penulis di sini: pemanggil (O2d-3) wajib tetap memeriksa bahwa jalur akhir ada di dalam folder stagingnya.
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/webpath.js): tiap penjaga satu baris.
const crypto = require('crypto');

const ROOT = 'assets/vendor';
const LIM = { url: 2048, seg: 64, depth: 6, path: 200, tries: 50 };
const EXTS = {
  script: ['.js', '.mjs'],
  style: ['.css'],
  font: ['.woff2', '.woff', '.ttf', '.otf', '.eot'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp'],
};
const DEFAULT = { script: '.js', style: '.css', font: '.woff2', image: '.png' };
const BY_TYPE = {
  'application/javascript': '.js', 'text/javascript': '.js', 'application/x-javascript': '.js', 'application/ecmascript': '.js', 'text/ecmascript': '.js',
  'text/css': '.css',
  'font/woff2': '.woff2', 'font/woff': '.woff', 'application/font-woff': '.woff', 'application/font-woff2': '.woff2', 'application/x-font-woff': '.woff',
  'font/ttf': '.ttf', 'application/x-font-ttf': '.ttf', 'font/otf': '.otf', 'application/x-font-otf': '.otf', 'application/vnd.ms-fontobject': '.eot',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg',
  'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico', 'image/bmp': '.bmp',
};

const h = (s, n) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);
const lc = (s) => s.toLowerCase();
const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const bad = (code) => ({ ok: false, code });

function cleanSegment(raw) {
  let s = String(raw);
  s = s.replace(/[^A-Za-z0-9._-]/g, '_'); // G:chars
  s = s.replace(/^\.+/, (m) => '_'.repeat(m.length)); // G:lead
  s = s.replace(/^-+/, (m) => '_'.repeat(m.length)); // G:dash
  s = s.replace(/\.+$/, ''); // G:trail
  if (!s) s = '_';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(s)) s = '_' + s; // G:win
  if (s.length > LIM.seg) s = s.slice(0, LIM.seg - 9) + '-' + h(raw, 8); // G:len
  return s;
}

function extFor(kind, type) {
  const t = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
  const e = BY_TYPE[t];
  return e && EXTS[kind].includes(e) ? e : DEFAULT[kind];
}

function withSuffix(name, suf) { // sisipkan sebelum ekstensi terakhir
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) + suf + name.slice(i) : name + suf;
}

function pathFor(url, kind, type) {
  if (typeof url !== 'string' || !url || url.length > LIM.url) return bad('bad');
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(EXTS, kind)) return bad('kind');
  let u;
  try { u = new URL(url); } catch { return bad('bad'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return bad('bad');
  const rawHost = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (!rawHost) return bad('bad');
  const host = cleanSegment(rawHost) + (u.port ? '_p' + u.port : '');
  u.hash = '';
  const canon = u.href;

  const parts = u.pathname.split('/').slice(1).map(dec);
  let file = parts.pop();
  if (!file) file = 'index'; // jalur berakhir '/' atau kosong
  const dirs = parts.filter((s) => s !== '').map(cleanSegment);

  let name = cleanSegment(file);
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  const ext = m ? '.' + m[1].toLowerCase() : '';
  if (!EXTS[kind].includes(ext)) name += extFor(kind, type); // G:ext
  const fe = /\.[A-Za-z0-9]+$/.exec(name), finalExt = fe ? fe[0].toLowerCase() : '';
  if (u.search && u.search !== '?') name = withSuffix(name, '-q' + h(u.search, 8)); // G:query

  const rel = [ROOT, host].concat(dirs, [name]).join('/');
  if (dirs.length > LIM.depth || rel.length > LIM.path) return { ok: true, rel: flat(host, canon, finalExt), host, ext: finalExt, flat: true }; // G:deep
  return { ok: true, rel, host, ext: finalExt, flat: false };
}

function flat(host, canon, ext, n) { return ROOT + '/' + host + '/_/' + h(canon, 16) + (n ? '-' + n : '') + ext; }

function fits(rel, files, dirs) {
  const k = lc(rel); // G:case
  if (files.has(k)) return false; // G:coll
  if (dirs.has(k)) return false; // G:dirfile
  const p = k.split('/');
  for (let n = 1; n < p.length; n++) if (files.has(p.slice(0, n).join('/'))) return false; // G:filedir
  return true;
}
function reg(rel, files, dirs) {
  const p = lc(rel).split('/');
  files.add(p.join('/'));
  for (let n = 1; n < p.length; n++) dirs.add(p.slice(0, n).join('/'));
}

function assign(list) {
  if (!Array.isArray(list)) return bad('bad');
  const files = new Set(), dirs = new Set(), results = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const r = it && typeof it === 'object' ? pathFor(it.url, it.kind, it.type) : bad('bad');
    if (!r.ok) { results.push({ i, ok: false, code: r.code }); continue; }
    const canon = new URL(it.url).href.replace(/#.*$/, '');
    const cands = [r.rel, withSuffix(r.rel, '-' + h(canon, 8)), flat(r.host, canon, r.ext)];
    for (let n = 2; n <= LIM.tries; n++) cands.push(flat(r.host, canon, r.ext, n));
    let got = -1;
    for (let c = 0; c < cands.length; c++) if (fits(cands[c], files, dirs)) { got = c; break; }
    if (got < 0) { results.push({ i, ok: false, code: 'path' }); continue; }
    reg(cands[got], files, dirs);
    results.push({ i, ok: true, rel: cands[got], renamed: got > 0 });
  }
  return { ok: true, results };
}

module.exports = { pathFor, assign, cleanSegment, ROOT, LIM };

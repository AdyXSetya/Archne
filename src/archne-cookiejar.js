'use strict';
// Cookie jar per situs di sisi server (v0.34.0, penampil situs Android).
// Masalah: WebView Android menolak cookie pihak ketiga, dan frame situs (ID.lw.localhost di dalam UI 127.0.0.1) dianggap pihak ketiga,
// jadi cookie asli tidak pernah tersimpan. Solusi: cookie tidak pernah lewat WebView. Server menangkap Set-Cookie dari situs,
// menyimpannya di jar milik situs itu saja (kunci = ID situs dari header Host), lalu menyuntikkan header Cookie ke tiap permintaan berikutnya.
// document.cookie di JavaScript situs diganti shim kecil yang membaca/menulis jar yang sama lewat /__cookie (XHR sinkron, hanya same-origin).
//
// Aturan (disederhanakan dengan sengaja, tiap situs satu origin):
//  - Cookie selalu host-only: atribut Domain diabaikan, jadi tidak ada cookie yang melintas antar-situs (lebih ketat dari browser).
//  - HttpOnly: tidak pernah terlihat shim; JS tidak bisa membuat atau menimpa cookie HttpOnly.
//  - Max-Age menang atas Expires; Max-Age<=0 atau Expires lampau = hapus. Cookie sesi hidup di memori; yang berumur ikut serialize().
//  - Awalan __Host- (wajib Secure, Path=/) dan __Secure- (wajib Secure) ditegakkan. Origin *.localhost adalah secure context, jadi Secure diterima.
//  - SameSite disimpan tetapi tidak ditegakkan: semua permintaan berasal dari situs itu sendiri.
//  - Batas: 4096 byte per cookie (nama+nilai), 180 cookie per jar, 512 KB total.
const MAX_COOKIE = 4096, MAX_COUNT = 180, MAX_TOTAL = 512 * 1024, MAX_PATH = 1024, MAX_EXP_MS = 400 * 24 * 3600 * 1000; // 400 hari, batas Chrome
const MAX_JARS = 64;

const CTL = /[\u0000-\u0008\u000a-\u001f\u007f]/;
function defaultPath(reqPath) {
  const p = typeof reqPath === 'string' ? reqPath.split('?')[0].split('#')[0] : '/';
  if (!p || p[0] !== '/') return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
function pathMatch(reqPath, cp) {
  const rp = (typeof reqPath === 'string' ? reqPath.split('?')[0] : '/') || '/';
  if (rp === cp) return true;
  if (!rp.startsWith(cp)) return false;
  return cp.endsWith('/') || rp[cp.length] === '/';
}

// Urai satu baris Set-Cookie / tulisan document.cookie. Kembalikan null bila tidak sah.
function parse(line, reqPath, now, fromJs) {
  if (typeof line !== 'string' || !line || CTL.test(line)) return null;
  const parts = line.split(';');
  const first = parts.shift();
  const eq = first.indexOf('=');
  let name, value;
  if (eq < 0) { name = ''; value = first.trim(); } else { name = first.slice(0, eq).trim(); value = first.slice(eq + 1).trim(); }
  if (!name && !value) return null;
  if (name.length + value.length > MAX_COOKIE) return null;
  if (/[\s()<>@,;:\\"/[\]?={}]/.test(name)) return null; // bukan token
  const c = { name, value, path: defaultPath(reqPath), secure: false, httpOnly: false, sameSite: '', expires: 0, persistent: false, created: now };
  let maxAge = null, exp = null;
  for (const raw of parts) {
    const j = raw.indexOf('=');
    const k = (j < 0 ? raw : raw.slice(0, j)).trim().toLowerCase(), v = j < 0 ? '' : raw.slice(j + 1).trim();
    if (k === 'path') { if (v && v[0] === '/' && v.length <= MAX_PATH) c.path = v; }
    else if (k === 'secure') c.secure = true;
    else if (k === 'httponly') { if (!fromJs) c.httpOnly = true; }
    else if (k === 'samesite') { const s = v.toLowerCase(); c.sameSite = s === 'strict' ? 'Strict' : s === 'none' ? 'None' : 'Lax'; }
    else if (k === 'max-age') { if (/^-?\d+$/.test(v)) maxAge = parseInt(v, 10); }
    else if (k === 'expires') { const t = Date.parse(v); if (!isNaN(t)) exp = t; }
    else if (k === 'domain') { /* diabaikan: selalu host-only */ }
  }
  if (maxAge !== null) { c.persistent = true; c.expires = maxAge <= 0 ? 0 : now + Math.min(maxAge * 1000, MAX_EXP_MS); if (maxAge <= 0) c.expires = -1; }
  else if (exp !== null) { c.persistent = true; c.expires = exp <= now ? -1 : Math.min(exp, now + MAX_EXP_MS); }
  // awalan
  const lower = name.toLowerCase();
  if (lower.startsWith('__host-') && !(c.secure && c.path === '/')) return null;
  if (lower.startsWith('__secure-') && !c.secure) return null;
  if (c.sameSite === 'None' && !c.secure) c.sameSite = 'Lax'; // meniru Chrome: None tanpa Secure ditolak; di sini dilunakkan, tidak berdampak (tidak ditegakkan)
  return c;
}

function createJar() {
  const m = new Map(); // key: name + '\n' + path
  const key = (c) => c.name + '\n' + c.path;
  const purge = (now) => { for (const [k, c] of m) if (c.persistent && c.expires > 0 && c.expires <= now) m.delete(k); };
  const total = () => { let n = 0; for (const c of m.values()) n += c.name.length + c.value.length + c.path.length + 16; return n; };
  function evict() {
    while (m.size > MAX_COUNT || total() > MAX_TOTAL) { // buang yang tertua dibuat
      let oldK = null, oldC = Infinity;
      for (const [k, c] of m) if (c.created < oldC) { oldC = c.created; oldK = k; }
      if (oldK === null) break; m.delete(oldK);
    }
  }
  // set: satu baris Set-Cookie. fromJs=true untuk tulisan document.cookie (tidak bisa HttpOnly dan tidak bisa menimpa cookie HttpOnly).
  function set(line, reqPath, fromJs, now) {
    now = now || Date.now();
    const c = parse(line, reqPath, now, !!fromJs);
    if (!c) return false;
    const k = key(c), old = m.get(k);
    if (fromJs && old && old.httpOnly) return false;
    if (c.persistent && c.expires === -1) { m.delete(k); return true; }
    if (old) c.created = old.created;
    m.set(k, c); evict();
    return true;
  }
  function setAll(lines, reqPath, now) { let n = 0; for (const l of lines || []) if (set(l, reqPath, false, now)) n++; return n; }
  function pick(reqPath, now, jsOnly) {
    now = now || Date.now(); purge(now);
    const out = [];
    for (const c of m.values()) { if (jsOnly && c.httpOnly) continue; if (pathMatch(reqPath, c.path)) out.push(c); }
    out.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    return out;
  }
  const fmt = (list) => list.map((c) => (c.name ? c.name + '=' : '') + c.value).join('; ');
  // Isi header Cookie untuk permintaan ke reqPath (termasuk HttpOnly).
  const header = (reqPath, now) => fmt(pick(reqPath, now, false));
  // Isi document.cookie untuk halaman di reqPath (tanpa HttpOnly).
  const visible = (reqPath, now) => fmt(pick(reqPath, now, true));
  function serialize(now) { now = now || Date.now(); purge(now); return Array.from(m.values()).filter((c) => c.persistent).map((c) => Object.assign({}, c)); }
  function load(list, now) {
    now = now || Date.now();
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (!c || typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.path !== 'string' || c.path[0] !== '/') continue;
      if (c.name.length + c.value.length > MAX_COOKIE || !(c.expires > now)) continue;
      m.set(key(c), { name: c.name, value: c.value, path: c.path, secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: String(c.sameSite || ''), expires: c.expires, persistent: true, created: +c.created || now });
    }
    evict();
  }
  return { set, setAll, header, visible, serialize, load, clear: () => m.clear(), get size() { return m.size; } };
}

// Kumpulan jar per ID situs.
function createStore(opts) {
  opts = opts || {};
  const jars = new Map();
  const get = (id) => {
    id = String(id);
    let j = jars.get(id);
    if (!j) {
      if (jars.size >= MAX_JARS) jars.delete(jars.keys().next().value);
      j = createJar();
      if (opts.load) { try { j.load(opts.load(id)); } catch (e) {} }
      jars.set(id, j);
    }
    return j;
  };
  return { get, drop: (id) => jars.delete(String(id)), clearAll: () => jars.clear() };
}

// Shim document.cookie. `initial` = isi awal yang terlihat JS (string), supaya pembacaan pertama tidak perlu jaringan.
// Penulisan dan pembacaan memakai XHR sinkron ke /__cookie (same-origin; CSP situs connect-src 'self' mengizinkan).
// Cache hanya berlaku dalam satu tugas (dibersihkan di microtask) supaya cookie yang diset lewat fetch() terbaca pada pembacaan berikutnya.
function shimScript(initial) {
  const init = JSON.stringify(String(initial || '')).replace(/</g, '\\u003c');
  return '(function(){try{var c=' + init + ',fresh=true;function stale(){fresh=false}function clear(){if(fresh)Promise.resolve().then(stale)}'
    + 'function sync(m,b){var x=new XMLHttpRequest();x.open(m,"/__cookie?p="+encodeURIComponent(location.pathname),false);if(b!==undefined)x.setRequestHeader("content-type","text/plain");x.send(b);if(x.status===200)return x.responseText;return null}'
    + 'Object.defineProperty(Document.prototype,"cookie",{configurable:true,enumerable:true,'
    + 'get:function(){if(!fresh){try{var r=sync("GET");if(r!==null)c=r}catch(e){}fresh=true;Promise.resolve().then(stale)}return c},'
    + 'set:function(v){try{var r=sync("POST",String(v));if(r!==null)c=r;fresh=true;Promise.resolve().then(stale)}catch(e){}}});'
    + 'fresh=true;Promise.resolve().then(stale)}catch(e){}})();';
}

// Sisipkan shim ke HTML (tepat setelah <head ...> bila ada, kalau tidak di awal dokumen). nonce opsional untuk CSP produksi.
function injectShim(html, initial, nonce) {
  const tag = '<script' + (nonce ? ' nonce="' + String(nonce).replace(/[^\w+/=-]/g, '') + '"' : '') + '>' + shimScript(initial) + '</script>';
  const m = /<head(?:\s[^>]*)?>/i.exec(html);
  if (m) { const i = m.index + m[0].length; return html.slice(0, i) + tag + html.slice(i); }
  const d = /^\s*<!doctype[^>]*>/i.exec(html);
  if (d) return html.slice(0, d[0].length) + tag + html.slice(d[0].length);
  return tag + html;
}

// Penampil Electron (F.1b): situs statis dilayani dari berkas lewat protocol.handle, bukan penangan Node, jadi attach() tidak terpakai. Tiga bagian murni di bawah dipakai di sana.
const MAX_BODY = 8192; // batas badan tulisan document.cookie lewat /__cookie
// Jawaban rute /__cookie. p = path halaman yang dikirim shim (?p=), body = isi tulisan. -> { status, text }
function cookieReply(jar, method, p, body) {
  const ref = typeof p === 'string' && p[0] === '/' && p.length <= MAX_PATH ? p : '/';
  if (method === 'GET') return { status: 200, text: jar.visible(ref) };
  if (method === 'POST') { jar.set(String(body || ''), ref, true); return { status: 200, text: jar.visible(ref) }; }
  return { status: 405, text: '' };
}
// Titik sisip shim pada awal berkas HTML (Buffer): sesudah BOM, spasi, komentar awal, dan <!doctype>; tidak pernah sebelum doctype (skrip sebelum doctype memicu quirks mode)
// dan tidak mencari <head> di dalam isi (komentar atau skrip yang memuat teks "<head>" tidak bisa menipunya). Skrip di sini jatuh ke <head> yang tersirat. Dibaca sebagai latin1 supaya indeks = indeks byte.
function shimOffset(buf) {
  const s = buf.toString('latin1');
  let p = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  const WS = /[\t\n\f\r ]*/y, CM = /<!--[\s\S]*?-->/y, DT = /<!doctype[^>]*>/iy;
  for (;;) { WS.lastIndex = p; WS.exec(s); p = WS.lastIndex; CM.lastIndex = p; if (CM.test(s)) { p = CM.lastIndex; continue; } break; }
  DT.lastIndex = p; if (DT.test(s)) p = DT.lastIndex;
  return p;
}
// Tag <script> shim sebagai Buffer UTF-8 (isi awal = cookie yang terlihat JS pada halaman itu).
const shimTagBytes = (initial, nonce) => Buffer.from('<script' + (nonce ? ' nonce="' + String(nonce).replace(/[^\w+/=-]/g, '') + '"' : '') + '>' + shimScript(initial) + '</script>', 'utf8');

// Pasang pada pasangan (req, res) dari situs: menyuntik Cookie, menangkap Set-Cookie, menyisipkan shim ke HTML, dan melayani /__cookie.
// Mengembalikan true bila permintaan sudah dilayani seluruhnya (rute /__cookie); selain itu penangan situs boleh lanjut.
function attach(jar, req, res, opts) {
  opts = opts || {};
  const url = new URL(req.url, 'http://x'), rp = url.pathname;
  if (rp === '/__cookie') {
    const sfs = req.headers['sec-fetch-site'];
    if (sfs && sfs !== 'same-origin') { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('ditolak'); return true; }
    const refPath = (() => { const q = url.searchParams.get('p'); return q && q[0] === '/' && q.length <= MAX_PATH ? q : '/'; })(); // path halaman dikirim shim (Referer kosong karena no-referrer)
    const done = (b) => { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(b); };
    if (req.method === 'GET') { done(jar.visible(refPath)); return true; }
    if (req.method === 'POST') {
      const ch = []; let n = 0;
      req.on('data', (d) => { n += d.length; if (n <= 8192) ch.push(d); });
      req.on('end', () => { if (n <= 8192) jar.set(Buffer.concat(ch).toString(), refPath, true); done(jar.visible(refPath)); });
      return true;
    }
    res.writeHead(405); res.end(); return true;
  }
  req.headers.cookie = jar.header(rp) || undefined; // WebView tidak mengirim cookie; yang dilihat penangan situs hanya isi jar
  if (!req.headers.cookie) delete req.headers.cookie;
  const wh = res.writeHead.bind(res), we = res.end.bind(res), ww = res.write.bind(res);
  let html = false, pend = null, started = false; const chunks = [];
  const begin = () => { if (!started) res.writeHead(res.statusCode); }; // penangan tanpa writeHead eksplisit (setHeader + end): kepala tetap lewat wrapper
  res.writeHead = function (status, a, b) {
    started = true;
    const hdrs = (typeof a === 'string' ? b : a) || {};
    const lines = [];
    const grab = (v) => { if (v === undefined) return; for (const x of Array.isArray(v) ? v : [v]) lines.push(String(x)); };
    const sc = res.getHeader('set-cookie'); grab(sc); if (sc !== undefined) res.removeHeader('set-cookie');
    if (Array.isArray(hdrs)) { for (let i = 0; i + 1 < hdrs.length; i += 2) if (String(hdrs[i]).toLowerCase() === 'set-cookie') grab(hdrs[i + 1]); }
    else for (const k of Object.keys(hdrs)) if (k.toLowerCase() === 'set-cookie') { grab(hdrs[k]); delete hdrs[k]; }
    jar.setAll(lines, rp);
    const ct = String(res.getHeader('content-type') || (Array.isArray(hdrs) ? '' : Object.keys(hdrs).filter((k) => k.toLowerCase() === 'content-type').map((k) => hdrs[k])[0]) || '');
    html = /^text\/html\b/i.test(ct) && opts.shim !== false;
    if (html) { res.removeHeader('content-length'); if (!Array.isArray(hdrs)) for (const k of Object.keys(hdrs)) if (k.toLowerCase() === 'content-length') delete hdrs[k]; }
    if (html) { pend = { status, a: typeof a === 'string' ? a : null, hdrs }; return res; } // HTML: kepala ditahan sampai end() supaya Content-Length bisa dihitung ulang
    return typeof a === 'string' ? wh(status, a, hdrs) : wh(status, hdrs);
  };
  res.write = function (d, enc, cb) { begin(); if (!html) return ww(d, enc, cb); if (d != null) chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d), typeof enc === 'string' ? enc : 'utf8')); if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb(); return true; };
  res.end = function (d, enc, cb) {
    begin();
    if (!html) return we(d, enc, cb);
    if (typeof d === 'function') { cb = d; d = null; }
    if (d != null && typeof d !== 'function') chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d), typeof enc === 'string' ? enc : 'utf8'));
    const out = Buffer.from(injectShim(Buffer.concat(chunks).toString('utf8'), jar.visible(rp), opts.nonce), 'utf8');
    if (pend) { const h = Array.isArray(pend.hdrs) ? {} : pend.hdrs; h['content-length'] = out.length; if (pend.a) wh(pend.status, pend.a, h); else wh(pend.status, h); }
    else { try { res.setHeader('content-length', out.length); } catch (e) {} }
    return we(out, typeof cb === 'function' ? cb : undefined);
  };
  return false;
}

module.exports = { createJar, createStore, parse, defaultPath, pathMatch, shimScript, injectShim, attach, cookieReply, shimOffset, shimTagBytes, MAX_COOKIE, MAX_COUNT, MAX_BODY };

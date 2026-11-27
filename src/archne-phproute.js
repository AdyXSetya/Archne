'use strict';
// Pemetaan permintaan -> PHP / berkas statis untuk satu situs PHP (P.3), seperti Apache/Nginx Laragon:
//   - jalur ke direktori: tanpa "/" di belakang -> 301 ke versi ber-"/"; lalu index.php, index.html, index.htm
//   - berkas .php yang ada dijalankan (juga dengan PATH_INFO: /app.php/a/b); berkas lain dilayani langsung dari disk, TIDAK lewat PHP
//   - jalur tidak ketemu -> /index.php di akar (front controller: WordPress, framework)
//   - segmen tersembunyi (".git", ".env", ".htaccess") -> 403, kecuali ".well-known"
//   - lintas direktori (.., \, NUL, symlink keluar www) ditolak; data/ tidak pernah terjangkau karena bukan bagian www
// o.cron:true = router milik penjalan cron (C4): $_SERVER['ARCHNE_CRON']='1', tanpa peer.
// Tidak tahu soal jaringan/peer: pemanggil (P.5) memberi { method, path, query, headers, body, peer, host } dan menerima { status, headers, body }.
// headers jawaban: { namaKecil: [nilai, ...] } (Set-Cookie bisa banyak). peer hanya diterima bila 16 hex (ID terverifikasi Core).
const fs = require('fs'), path = require('path');

const MIME = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf', wasm: 'application/wasm', map: 'application/json', csv: 'text/csv; charset=utf-8', md: 'text/plain; charset=utf-8' };
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const INDEXES = ['index.php', 'index.html', 'index.htm'];
const DROP_REQ = new Set(['host', 'connection', 'transfer-encoding', 'proxy', 'content-length', 'expect', 'upgrade', 'te', 'keep-alive']); // proxy: httpoxy
const DROP_RES = new Set(['x-powered-by', 'transfer-encoding', 'connection', 'keep-alive']);

// Range: 'bytes=a-b' | 'bytes=a-' | 'bytes=-n' (satu rentang). null = abaikan; { unsat:true } = 416; { a, b } = 206.
function parseRange(h, size) {
  let v = null, ir = false;
  for (const [k, x] of Object.entries(h || {})) { const n = String(k).toLowerCase(); if (n === 'range') v = String(Array.isArray(x) ? x[0] : x); else if (n === 'if-range') ir = true; }
  const m = v && !ir ? /^bytes=(\d{0,15})-(\d{0,15})$/.exec(v.trim()) : null;
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let a, b;
  if (m[1] === '') { const n = Number(m[2]); if (n === 0) return { unsat: true }; a = Math.max(0, size - n); b = size - 1; }
  else { a = Number(m[1]); b = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); if (a >= size || (m[2] !== '' && Number(m[2]) < a)) return a >= size ? { unsat: true } : null; }
  return a > b ? { unsat: true } : { a, b };
}
const reply = (status, text, extra) => ({ status, headers: Object.assign({ 'content-type': ['text/plain; charset=utf-8'] }, extra || {}), body: Buffer.from(text || '') });
const isPhp = (n) => /\.php$/i.test(n);
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (root, p) => { const r = norm(root), q = norm(p); return q === r || q.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };
const stat = (p) => fs.promises.stat(p).catch(() => null);

function createPhpRouter(o) {
  if (!o || !o.pool || !o.siteId || !o.www || !o.data) throw new Error('createPhpRouter: pool, siteId, www, data wajib');
  const { pool, siteId } = o;
  const wwwReal = fs.realpathSync(o.www);
  const maxBody = o.maxBody || 64 * 1024 * 1024, maxStatic = o.maxStatic || 256 * 1024 * 1024;
  const cfg = { www: o.www, data: o.data, tmp: o.tmp, ini: o.ini };
  const idleOpt = Number.isFinite(o.idleMs) && o.idleMs >= 0 ? { idleMs: o.idleMs } : {}; // batas nganggur Worker situs ini (tanpa = bawaan pool)

  async function resolve(segs) { // -> { kind:'static'|'php'|'redirect'|'miss'|'hidden'|'bad', ... }
    let cur = wwwReal;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg[0] === '.' && seg !== '.well-known') return { kind: 'hidden' };
      cur = path.join(cur, seg);
      const st = await stat(cur);
      if (!st) return { kind: 'miss' };
      if (st.isDirectory()) continue;
      if (!st.isFile()) return { kind: 'miss' };
      if (isPhp(seg)) return { kind: 'php', rel: segs.slice(0, i + 1), info: segs.slice(i + 1), abs: cur };
      if (i < segs.length - 1) return { kind: 'miss' }; // berkas biasa tidak punya PATH_INFO
      return { kind: 'static', abs: cur, st };
    }
    return { kind: 'dir', abs: cur };
  }

  // Tanpa index.php: 404.html / 404.htm di akar www/ (status tetap 404). Tidak ada = teks polos "Not found" (halaman bawaan Archne dipasang oleh penampil).
  async function notFoundPage(method) {
    for (const n of ['404.html', '404.htm']) {
      const f = path.join(wwwReal, n), st = await stat(f);
      if (!st || !st.isFile() || st.size > 1024 * 1024) continue;
      let real; try { real = await fs.promises.realpath(f); } catch { continue; }
      if (!inside(wwwReal, real)) continue;
      const data = await fs.promises.readFile(real);
      return { status: 404, headers: { 'content-type': ['text/html; charset=utf-8'], 'cache-control': ['no-cache'], 'content-length': [String(data.length)] }, body: method === 'HEAD' ? Buffer.alloc(0) : data };
    }
    return reply(404, 'Not found');
  }

  async function handle(req) {
    const method = String(req.method || 'GET').toUpperCase();
    if (!METHODS.has(method)) return reply(405, 'metode tidak didukung', { allow: ['GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'] });
    const rawPath = String(req.path || '/'), query = String(req.query || '').replace(/^\?/, '');
    if (rawPath[0] !== '/') return reply(400, 'permintaan salah');
    let dec; try { dec = decodeURIComponent(rawPath); } catch { return reply(400, 'permintaan salah'); }
    if (dec.indexOf('\0') >= 0 || dec.indexOf('\\') >= 0) return reply(400, 'permintaan salah');
    const segs = dec.split('/').filter(Boolean);
    if (segs.some((s) => s === '.' || s === '..')) return reply(400, 'permintaan salah');
    const body = req.body ? Buffer.from(req.body) : Buffer.alloc(0);
    if (body.length > maxBody) return reply(413, 'badan permintaan terlalu besar');
    const trailing = rawPath.endsWith('/') || segs.length === 0;

    let hit = await resolve(segs);
    if (hit.kind === 'hidden') return reply(403, 'ditolak');
    if (hit.kind === 'dir') {
      if (!trailing) return reply(301, '', { location: [rawPath + '/' + (query ? '?' + query : '')] });
      let found = null;
      for (const n of INDEXES) { const st = await stat(path.join(hit.abs, n)); if (st && st.isFile()) { found = n; break; } }
      if (!found) hit = { kind: 'miss' };
      else { const sub = segs.concat(found); hit = isPhp(found) ? { kind: 'php', rel: sub, info: [], abs: path.join(hit.abs, found) } : { kind: 'static', abs: path.join(hit.abs, found), st: await stat(path.join(hit.abs, found)) }; }
    }
    if (hit.kind === 'miss') { // front controller
      const ix = path.join(wwwReal, 'index.php'), st = await stat(ix);
      if (!st || !st.isFile()) return notFoundPage(method);
      hit = { kind: 'php', rel: ['index.php'], info: [], abs: ix };
    }
    // symlink: berkas akhir harus tetap di dalam www
    let real; try { real = await fs.promises.realpath(hit.abs); } catch { return reply(404, 'Not found'); }
    if (!inside(wwwReal, real)) return reply(403, 'ditolak');

    if (hit.kind === 'static') {
      if (hit.st.size > maxStatic) return reply(413, 'berkas terlalu besar');
      if (method !== 'GET' && method !== 'HEAD') return reply(405, 'metode tidak didukung', { allow: ['GET, HEAD'] });
      const ext = path.extname(hit.abs).slice(1).toLowerCase();
      const base = { 'content-type': [MIME[ext] || 'application/octet-stream'], 'last-modified': [hit.st.mtime.toUTCString()], 'cache-control': ['no-cache'], 'accept-ranges': ['bytes'] };
      const rg = method === 'GET' ? parseRange(req.headers, hit.st.size) : null; // satu rentang saja; Range tak sah / ganda / If-Range = abaikan (200 penuh)
      if (rg && rg.unsat) return reply(416, 'rentang tidak terpenuhi', { 'content-range': ['bytes */' + hit.st.size] });
      if (rg) {
        const buf = Buffer.alloc(rg.b - rg.a + 1), fh = await fs.promises.open(real, 'r');
        try { await fh.read(buf, 0, buf.length, rg.a); } finally { await fh.close(); }
        return { status: 206, headers: Object.assign(base, { 'content-length': [String(buf.length)], 'content-range': ['bytes ' + rg.a + '-' + rg.b + '/' + hit.st.size] }), body: buf };
      }
      const data = method === 'HEAD' ? Buffer.alloc(0) : await fs.promises.readFile(real);
      return { status: 200, headers: Object.assign(base, { 'content-length': [String(hit.st.size)] }), body: data };
    }

    // PHP
    const scriptName = '/' + hit.rel.join('/'), pathInfo = hit.info.length ? '/' + hit.info.join('/') : '';
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) { const n = String(k).toLowerCase(); if (!DROP_REQ.has(n) && !/[\r\n\0]/.test(String(v))) headers[n] = Array.isArray(v) ? v.join(', ') : String(v); }
    const host = String(req.host || 'localhost');
    headers.host = host;
    const server = {
      REQUEST_URI: rawPath + (query ? '?' + query : ''), SCRIPT_NAME: scriptName, SCRIPT_FILENAME: '/www' + scriptName, PHP_SELF: scriptName + pathInfo,
      DOCUMENT_ROOT: '/www', QUERY_STRING: query, SERVER_NAME: host.replace(/:\d+$/, ''), SERVER_PROTOCOL: 'HTTP/1.1', SERVER_SOFTWARE: 'Archne',
      REMOTE_ADDR: '127.0.0.1', REMOTE_PORT: '0', ARCHNE_PEER: !o.cron && /^[0-9a-f]{16}$/.test(String(req.peer || '')) ? req.peer : '', _: '/usr/bin/php', // "_" bawaan membocorkan jalur berkas pemilik
    };
    if (o.cron === true) server.ARCHNE_CRON = '1'; // G:cron-flag  Hanya dari opsi pembuat router (cron milik pemilik), tidak pernah dari permintaan: situs bisa membedakan eksekusi cron dari pengunjung
    if (pathInfo) { server.PATH_INFO = pathInfo; server.PATH_TRANSLATED = '/www' + pathInfo; }
    if (body.length) server.CONTENT_LENGTH = String(body.length);
    let r;
    try { r = await pool.request(siteId, cfg, { method: method === 'HEAD' ? 'GET' : method, uri: rawPath + (query ? '?' + query : ''), script: '/www' + scriptName, headers, body: body.length ? new Uint8Array(body) : undefined, server }, Object.assign({ timeoutMs: o.timeoutMs }, idleOpt)); }
    catch (e) { const c = e && e.code; return reply(c === 'TIMEOUT' ? 504 : c === 'BUSY' ? 503 : 502, c === 'TIMEOUT' ? 'PHP melewati batas waktu' : c === 'BUSY' ? 'server PHP sibuk' : 'PHP tidak dapat menjawab'); }
    const out = {};
    for (const [k, v] of Object.entries(r.headers || {})) if (!DROP_RES.has(k)) out[k] = v;
    return { status: r.status, headers: out, body: method === 'HEAD' ? Buffer.alloc(0) : r.body };
  }

  return { handle, warm: () => pool.warm(siteId, cfg), stop: () => pool.stop(siteId) };
}

module.exports = { createPhpRouter, MIME };

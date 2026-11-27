'use strict';
// Pelayan situs Web Lokal untuk Android / peramban (0.34.0 Fase F.3, langkah 1). Pasangan archne-sitebrowser.js (Electron): isi, jalur, Range, dan header
// SAMA persis karena yang menjawab tetap respond() milik penampil; modul ini hanya mengubah permintaan HTTP loopback menjadi Request bergaya archne-site://
// dan menulis Response-nya kembali. Tidak ada logika berkas ganda di sini.
//
// Pemisahan origin (hasil spike A.2): situs hanya dilayani lewat Host `<siteId>.lw.localhost:PORT`. UI Archne memakai host lain (127.0.0.1 / localhost) pada PORT yang
// sama, jadi penangan ini hanya memutus berdasarkan Host dan tidak pernah melayani UI. Host selain milik situs yang sedang terbuka ditolak (403), tanpa situs terbuka = 404.
//
// Satu-satunya beda header dari Electron: CSP `frame-ancestors 'none'` diganti daftar origin yang boleh menyematkan (UI Archne), karena di Android situs
// ditampilkan di dalam iframe. Sisanya (CSP lain, nosniff, no-store, no-referrer, CORP, permissions-policy) tetap dari penampil.
//
// Cookie (F.3.2): jar dibuat OLEH pelayan ini di open() (pemanggil tidak bisa lupa atau membawa jar lama), hidup selama satu pembukaan, dibuang oleh open() berikutnya
// (situs sama maupun lain) dan clear(). refresh() memperbarui manifest tanpa menyentuh jar. Jar hanya di memori, tidak pernah ke disk, tidak dibagi antar-situs.
//
// Pakai: const host = createSiteHost({ core, getPort }); host.open(cur); lalu di penangan HTTP: if (host.isSiteHost(req)) return host.handle(req, res).
// createSiteServer() membungkusnya dengan http.createServer sendiri (untuk tes dan mode mandiri). `cur` berbentuk sama dengan milik createSiteBrowser.
const http = require('http');
const { Readable } = require('stream');
const SB = require('./archne-sitebrowser');
const { createJar } = require('./archne-cookiejar');

const SUFFIX = '.lw.localhost';
const SITEHOST = /^[0-9a-f]{16}\.lw\.localhost:[0-9]{1,5}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const ABS_PATH = /^\/(?![\/\\])/; // jalur absolut asli; "//host" dan "/\host" bisa dibaca sebagai host oleh pengurai URL

function createSiteHost(opts) {
  if (!opts || !opts.core || typeof opts.getPort !== 'function') throw new Error('createSiteHost: core dan getPort wajib');
  const core = opts.core, getPort = opts.getPort, log = opts.log || function () {};
  const ancestorsOf = opts.ancestors || ((port) => ['http://127.0.0.1:' + port]);
  let cur = null;

  const cspFor = (base) => {
    const list = ancestorsOf(getPort());
    if (!Array.isArray(list) || !list.length || !list.every((o) => /^https?:\/\/[A-Za-z0-9.\-]+(:[0-9]{1,5})?$/.test(o))) throw new Error('ancestors tidak valid');
    const b = base || SB.CSP; // situs PHP membawa CSP_PHP (form-action 'self'); jangan diganti CSP statis
    const csp = b.replace("frame-ancestors 'none'", 'frame-ancestors ' + list.join(' '));
    if (csp === b) throw new Error('CSP penampil berubah bentuk: frame-ancestors tidak ditemukan');
    return csp;
  };
  const hostOf = (siteId) => siteId + SUFFIX + ':' + getPort();
  const urlOf = (siteId, p) => 'http://' + hostOf(siteId) + '/' + String(p || '').split('/').filter((s, i, a) => s || i === a.length - 1).map(encodeURIComponent).join('/');
  const isSiteHost = (req) => SITEHOST.test(String(req.headers.host || '').toLowerCase());

  const plain = (res, status, text) => {
    if (res.headersSent) { try { res.destroy(); } catch {} return; }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(text || '');
  };

  async function handle(req, res) {
    const ac = new AbortController();
    let body = null;
    try {
      const host = String(req.headers.host || '').toLowerCase();
      if (!SITEHOST.test(host)) { req.resume(); return plain(res, 403, 'host ditolak'); }
      if (!cur) { req.resume(); return plain(res, 404, 'Not found'); }
      if (host !== hostOf(cur.siteId)) { req.resume(); return plain(res, 403, 'host ditolak'); }
      const raw = String(req.url || '');
      let u = null;
      if (ABS_PATH.test(raw)) { try { u = new URL(raw, 'http://x'); } catch {} }
      if (!u || u.origin !== 'http://x') { req.resume(); return plain(res, 400, 'permintaan salah'); }

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) { if (k !== 'host' && k !== 'connection' && k !== 'transfer-encoding') headers.set(k, Array.isArray(v) ? v.join(', ') : String(v)); }
      const init = { method: req.method, headers, signal: ac.signal };
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') { body = Readable.toWeb(req); init.body = body; init.duplex = 'half'; } // hanya rute /__cookie yang membacanya (batas badan di respond)
      let request;
      try { request = new Request(SB.SCHEME + '://' + cur.siteId + u.pathname + u.search, init); } catch { req.resume(); return plain(res, 400, 'permintaan salah'); }

      const r = await SB.respond(core, cur, request);
      if (!body) req.resume(); // jangan biarkan badan yang tidak dibaca menggantung
      const h = {};
      r.headers.forEach((v, k) => { h[k] = v; });
      h['content-security-policy'] = cspFor(h['content-security-policy']);
      res.writeHead(r.status, h);
      if (!r.body) return res.end();
      const rs = Readable.fromWeb(r.body);
      rs.on('error', () => { try { res.destroy(); } catch {} });
      res.on('close', () => { if (!res.writableFinished) { try { rs.destroy(); } catch {} ac.abort(); } });
      rs.pipe(res);
    } catch (e) {
      log('siteserver: ' + (e && e.message));
      plain(res, 500);
    }
  }

  return {
    handle, isSiteHost, hostOf, urlOf,
    // Buka situs: salinan `c` dengan jar BARU (jar kiriman pemanggil dibuang). Mengembalikan cur yang dilayani.
    // Situs PHP (Android, P.3): `c.gateFor(jar)` dipanggil dengan jar baru itu juga, supaya gerbang cookie dan rute /__cookie memakai SATU jar (sama dengan createSiteBrowser di Electron).
    open(c) {
      if (!c || typeof c.siteId !== 'string' || !HEX16.test(c.siteId)) throw new Error('open: cur tidak valid');
      const jar = createJar(), n = Object.assign({}, c, { jar });
      delete n.gateFor; delete n.gate; // gerbang kiriman pemanggil tidak dipercaya: hanya yang dibuat dari jar ini
      if (typeof c.gateFor === 'function') n.gate = c.gateFor(jar);
      cur = n; return cur;
    },
    // Muat ulang dari pemilik: perbarui entry / rev / files / offline / stale tanpa mengganti situs atau jar. Bidang lain (termasuk jar, siteId, ownerId) diabaikan.
    refresh(patch) { if (!cur || !patch) return false; for (const k of ['entry', 'rev', 'files', 'offline', 'stale']) if (k in patch) cur[k] = patch[k]; return true; },
    clear() { cur = null; },
    get cur() { return cur; },
    cspFor,
  };
}

// Pelayan mandiri di loopback. listen() -> port. Hanya 127.0.0.1 (situs dijangkau lewat *.lw.localhost yang diarahkan peramban ke loopback).
function createSiteServer(opts) {
  let server = null;
  const host = createSiteHost(Object.assign({}, opts, { getPort: () => (server && server.address() ? server.address().port : 0) }));
  server = http.createServer((req, res) => { host.handle(req, res); });
  server.on('clientError', (_e, sock) => { try { sock.destroy(); } catch {} });
  return Object.assign(host, {
    listen(port) { return new Promise((ok, no) => { server.once('error', no); server.listen(port || 0, '127.0.0.1', () => { server.removeListener('error', no); ok(server.address().port); }); }); },
    close() { return new Promise((ok) => { server.close(() => ok()); if (server.closeAllConnections) server.closeAllConnections(); }); },
  });
}

module.exports = { createSiteHost, createSiteServer, SUFFIX, SITEHOST, HEX16 };

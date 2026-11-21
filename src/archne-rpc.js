'use strict';
// Adaptor HTTP untuk kontrak `window.api` (v0.10.0). Dipakai oleh Android (WebView) dan mode peramban/Termux/server.
// Tidak ada dependensi: hanya `http`. Inti dan src/archne-ipc.js tidak berubah; adaptor ini hanya mengganti `ipcMain` Electron.
//
//   GET  /?t=TOKEN        -> set cookie sesi lalu arahkan ke /
//   GET  /s/TOKEN/...     -> sesi lewat jalur URL, TANPA cookie (untuk iframe Android: WebView memblokir cookie pihak ketiga dan
//                            SameSite=Strict tidak berlaku di iframe lintas situs localhost <-> 127.0.0.1). Semua jalur di bawahnya
//                            sama dengan jalur biasa (/rpc/.., /events, /upload, berkas UI).
//   GET  /<berkas UI>     -> isi folder renderer/ (perlu cookie)
//   POST /rpc/<nama>      -> badan JSON = larik argumen; balasan JSON = hasil handler archne-ipc.js
//   GET  /events          -> Server-Sent Events: update | removed | fprog | dxprog | pgdl | pgcq | pgnew | pgarc | dxscan | call | vcpres | pvpres | pvkick | rtcb (| notify, bila canNotify)
//   POST /upload?name=... -> badan mentah (berkas) disimpan ke <dataDir>/shared; balasan { path }
//
// Keamanan: hanya mendengarkan 127.0.0.1 (kecuali host diubah sengaja), token acak, cookie HttpOnly+SameSite=Strict,
// pemeriksaan header Host (menahan DNS rebinding) dan POST wajib application/json (menahan CSRF lintas situs).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { register, isRisky } = require('./archne-ipc');
const I18N = require('./core/archne-i18n-node'); // i18n (E10)

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm' };
const JOBID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_JSON = 4 * 1024 * 1024; // avatar base64 dll masih jauh di bawah ini
const safeName = (n) => (String(n || 'berkas').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\.{2,}/g, '_').replace(/^\./, '_').slice(0, 120) || 'berkas');

function createRpc(opts) {
  const { core } = opts;
  const log = opts.log || (() => {});
  const host = opts.host || '127.0.0.1';
  const token = opts.token || crypto.randomBytes(24).toString('hex');
  const rendererDir = opts.rendererDir || path.join(__dirname, '..', 'renderer');
  const sharedDir = path.join(core.opts.dataDir, 'shared');
  const handlers = new Map();
  const clients = new Set();
  let server = null, port = 0;

  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const broadcast = (ch, payload) => {
    const data = `event: ${ch}\ndata: ${JSON.stringify(payload === undefined ? null : payload)}\n\n`;
    for (const res of clients) { try { res.write(data); } catch {} }
    if (typeof opts.onEvent === 'function') { try { opts.onEvent(ch, payload); } catch {} } // cangkang (Android) ikut mendengar, mis. ekspor Halaman selesai
  };

  // Tindakan khusus platform (buka/tampilkan berkas): di Android ditangani cangkang lewat postMessage, bukan di sini.
  // `shell` palsu hanya mencatat permintaan; handler archne-ipc.js tetap memeriksa id, keberadaan berkas, dan ekstensi berisiko.
  let native = null, blocked = false;
  const shell = {
    // Di Android "tampilkan" = dialog "buka dengan", jadi berkas berisiko (.apk dll) tidak boleh lewat sini juga.
    showItemInFolder: (p) => { if (isRisky(p)) blocked = true; else native = { action: 'show', path: p, name: path.basename(p) }; },
    openPath: async (p) => { native = { action: 'open', path: p, name: path.basename(p) }; return ''; },
  };
  // Cangkang Android menampilkan notifikasi panggilan masuk dengan foto penelepon; event 'incoming' membawa fotonya (base64 JPEG kecil, '' bila tidak ada).
  const sendOut = opts.canNotify
    ? (ch, p) => broadcast(ch, ch === 'call' && p && p.ev === 'incoming' ? Object.assign({}, p, { av: core.avatarOf(p.peer) }) : p)
    : broadcast;
  const ipc = register({ ipcMain, core, log, send: sendOut, shell, pickFiles: async () => [], rtcBase64: true, pickSave: opts.pickSave, pickArc: opts.pickArc }); // pickSave / pickArc: cadangan Halaman (Android: tanpa dialog Electron, lihat mobile/shell/main.js) // byte jembatan lintas jaringan lewat JSON: base64

  // Setelah tawaran terkirim: salinan unggahan hanya boleh dihapus bila Core sudah membuat salinan sendiri (staged).
  // Kalau tidak, Core masih membaca berkas ini untuk mengirim ke penerima nanti.
  const inShared = (p) => typeof p === 'string' && path.resolve(p).startsWith(path.resolve(sharedDir) + path.sep);
  const cleanShared = (src, r) => {
    if (inShared(src)) {
      const rec = r && r.ok ? core.store.files[r.id] : null;
      if (!r.ok || (rec && rec.staged)) fs.promises.rm(src, { force: true }).catch(() => {});
    }
    return r;
  };
  const sendFileRaw = handlers.get('sendFile');
  handlers.set('sendFile', async (e, job, src, to, media) => cleanShared(src, await sendFileRaw(e, job, src, to, media)));
  const sendVoiceRaw = handlers.get('sendVoice');
  handlers.set('sendVoice', async (e, job, src, to, durMs) => cleanShared(src, await sendVoiceRaw(e, job, src, to, durMs)));

  // Halaman: PageStore.addMedias SUDAH membuat salinan sendiri di penyimpanan halaman (selesai sebelum pgCreate kembali), jadi unggahan di shared/ tidak diperlukan lagi,
  // sukses maupun gagal (percobaan ulang dari UI mengunggah ulang). Tanpa ini tiap postingan bergambar dari HP meninggalkan sampai 10 salinan sampai aplikasi dimulai ulang.
  const pgCreateRaw = handlers.get('pgCreate');
  // Video (3c-6) ikut lewat popts.videos: unggahannya di shared/ dibersihkan seperti gambar dan lampiran. Lampiran (files) dan opts (3b) WAJIB ikut diteruskan: sebelumnya pembungkus ini hanya meneruskan tiga argumen, sehingga lampiran dari HP / peramban hilang diam-diam. Unggahan lampiran di shared/ juga dibersihkan.
  if (pgCreateRaw) handlers.set('pgCreate', async (e, text, priv, images, files, popts) => {
    try { return await pgCreateRaw(e, text, priv, images, files, popts); }
    finally { for (const list of [images, files, popts && popts.videos]) if (Array.isArray(list)) for (const it of list) if (it && inShared(it.src)) fs.promises.rm(it.src, { force: true }).catch(() => {}); }
  });

  // Android tidak punya "buka folder"; beri tahu lokasi saja.
  if (opts.canOpenFolder === false) {
    handlers.set('openDownloads', async () => ({ ok: false, err: I18N.tr('e.rpc.downloadsAndroid', null, 'Berkas yang diterima disalin ke folder Download perangkat. Buka lewat aplikasi Berkas.') }));
    const stateRaw = handlers.get('state'); // UI menyembunyikan tombol "Unduhan" bila tidak ada folder yang bisa dibuka
    handlers.set('state', async (...a) => Object.assign({}, await stateRaw(...a), { canOpenFolder: false }));
  }

  // HP (tanpa pemilih berkas berpath): Kirim Langsung memakai salinan sementara. UI memunculkan "Kirim berkas…" bila state.canDirectCopy.
  if (opts.canDirectCopy) {
    const st3 = handlers.get('state');
    handlers.set('state', async (...a) => Object.assign({}, await st3(...a), { canDirectCopy: true }));
    // Batal saat masih menyalin (job belum terdaftar di ipc-direct => hasil false): buang salinan job itu.
    const cancelRaw = handlers.get('dxCancelScan');
    if (cancelRaw) handlers.set('dxCancelScan', async (e, job) => {
      const r = await cancelRaw(e, job);
      if (r === false && JOBID.test(String(job))) fs.promises.rm(path.join(core._dxTmpRoot(), String(job)), { recursive: true, force: true }).catch(() => {});
      return r;
    });
  }

  if (opts.canNotify) { // UI menampilkan tombol bisu hanya bila cangkangnya bisa menampilkan notifikasi
    const st2 = handlers.get('state');
    handlers.set('state', async (...a) => Object.assign({}, await st2(...a), { canNotify: true }));
  }

  const tokenEq = (t) => typeof t === 'string' && t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
  const cookieOk = (req) => {
    const m = /(?:^|;\s*)lc=([0-9a-f]+)/.exec(req.headers.cookie || '');
    if (!m || m[1].length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(token));
  };
  const hostOk = (req) => {
    const h = String(req.headers.host || '').toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}` || (host !== '127.0.0.1' && h.endsWith(':' + port));
  };
  const deny = (res, code, msg) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(msg); };

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0;
      req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('terlalu besar'), { code: 413 })); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function onRequest(req, res) {
    try {
      if (!hostOk(req)) return deny(res, 403, 'host tidak dikenal');
      const url = new URL(req.url, 'http://x');

      // Sesi lewat jalur URL: /s/<token>/<jalur biasa>. Token divalidasi di sini lalu awalan dibuang, sisanya diproses seperti biasa.
      let viaPath = false;
      const sp = /^\/s\/([^/]*)(\/.*)?$/.exec(url.pathname);
      if (sp) {
        if (!tokenEq(sp[1])) return deny(res, 403, 'token salah');
        if (!sp[2]) { res.writeHead(302, { location: `/s/${sp[1]}/`, 'referrer-policy': 'no-referrer' }); return res.end(); }
        viaPath = true;
        url.pathname = sp[2];
      }

      if (!viaPath && req.method === 'GET' && url.pathname === '/' && url.searchParams.get('t')) {
        if (!tokenEq(url.searchParams.get('t'))) return deny(res, 403, 'token salah');
        res.writeHead(302, { 'set-cookie': `lc=${token}; HttpOnly; SameSite=Strict; Path=/`, location: '/' });
        return res.end();
      }
      if (!viaPath && !cookieOk(req)) return deny(res, 401, I18N.tr('e.rpc.needToken', null, 'buka lewat tautan yang berisi token'));

      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/media/')) return require('./archne-mediaserve').serveHttp(core, url.pathname.slice(7), req, res); // pemutar: token acak dari Core.mediaStream
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 1000\n\n');
        clients.add(res);
        const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 20000);
        req.on('close', () => { clearInterval(ka); clients.delete(res); });
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/rpc/')) {
        if (!/^application\/json/.test(req.headers['content-type'] || '')) return deny(res, 415, 'wajib application/json');
        const name = url.pathname.slice(5);
        const fn = handlers.get(name);
        if (!fn) return deny(res, 404, 'saluran tidak ada');
        let args = [];
        try { args = JSON.parse((await readBody(req, MAX_JSON)).toString() || '[]'); } catch (e) { return deny(res, e.code === 413 ? 413 : 400, 'JSON tidak valid'); }
        if (!Array.isArray(args)) return deny(res, 400, 'argumen harus larik');
        native = null; blocked = false;
        let out = await fn({}, ...args);
        if (blocked) out = { ok: false, risky: true, err: 'Berkas jenis ini (mis. .apk, .exe) tidak dibuka dari Archne di perangkat ini.' };
        else if (native && out && typeof out === 'object') out = Object.assign({}, out, { native });
        native = null; blocked = false;
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(out === undefined ? null : out));
      }

      if (req.method === 'POST' && url.pathname === '/dxupload' && opts.canDirectCopy) { // salinan sementara untuk Kirim Langsung (dihapus Core saat sesinya berakhir)
        if (!/^application\/octet-stream/.test(req.headers['content-type'] || '')) return deny(res, 415, 'wajib application/octet-stream');
        const job = String(url.searchParams.get('job') || '');
        if (!JOBID.test(job)) return deny(res, 400, 'job tidak valid');
        const dir = path.join(core._dxTmpRoot(), job, crypto.randomBytes(6).toString('hex')), dest = path.join(dir, safeName(url.searchParams.get('name')));
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
        const ws = fs.createWriteStream(dest, { mode: 0o600 });
        let full = false;
        await new Promise((resolve, reject) => { req.pipe(ws); ws.on('finish', resolve); ws.on('error', (e) => { full = e && e.code === 'ENOSPC'; reject(e); }); req.on('error', reject); req.on('aborted', () => reject(new Error('dibatalkan'))); })
          .catch(async (e) => { ws.destroy(); await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); if (full) { res.writeHead(507, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('penyimpanan penuh'); } throw e; });
        if (res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ path: dest }));
      }

      if (req.method === 'POST' && url.pathname === '/upload') {
        if (!/^application\/octet-stream/.test(req.headers['content-type'] || '')) return deny(res, 415, 'wajib application/octet-stream');
        await fs.promises.mkdir(sharedDir, { recursive: true, mode: 0o700 });
        const dest = path.join(sharedDir, crypto.randomBytes(6).toString('hex') + '-' + safeName(url.searchParams.get('name')));
        const ws = fs.createWriteStream(dest, { mode: 0o600 });
        await new Promise((resolve, reject) => { req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject); req.on('aborted', () => reject(new Error('dibatalkan'))); })
          .catch(async (e) => { ws.destroy(); await fs.promises.rm(dest, { force: true }).catch(() => {}); throw e; });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ path: dest }));
      }

      if (req.method === 'GET') { // berkas UI statis, hanya dari renderer/
        const rel = url.pathname === '/' ? 'archne-index.html' : decodeURIComponent(url.pathname.slice(1));
        const abs = path.resolve(rendererDir, rel);
        if (!abs.startsWith(path.resolve(rendererDir) + path.sep)) return deny(res, 403, 'terlarang');
        const data = await fs.promises.readFile(abs).catch(() => null);
        if (!data) return deny(res, 404, 'tidak ada');
        res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end(data);
      }
      deny(res, 405, 'metode tidak didukung');
    } catch (e) {
      log('rpc error ' + (e && e.stack || e));
      if (!res.headersSent) deny(res, 500, 'galat internal'); else try { res.end(); } catch {}
    }
  }

  return {
    handlers, token,
    get port() { return port; },
    url: () => `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/?t=${token}`,
    sessionUrl: () => `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/s/${token}/`,
    async start() {
      // bersihkan unggahan sisa sesi lalu yang tidak lagi dirujuk Core
      try {
        const keep = new Set(Object.values(core.store.files || {}).map((f) => f && f.path).filter(Boolean).map((p) => path.resolve(p)));
        for (const f of await fs.promises.readdir(sharedDir).catch(() => [])) { const p = path.resolve(sharedDir, f); if (!keep.has(p)) await fs.promises.rm(p, { force: true }).catch(() => {}); }
      } catch {}
      server = http.createServer(onRequest);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(opts.port || 0, host, () => { server.removeListener('error', reject); resolve(); }); });
      port = server.address().port;
      return port;
    },
    async stop() {
      try { ipc.dispose(); } catch {}
      for (const r of clients) { try { r.end(); } catch {} }
      clients.clear();
      if (server) await new Promise((r) => server.close(() => r()));
    },
    broadcast,
  };
}

module.exports = { createRpc, safeName };

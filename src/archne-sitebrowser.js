'use strict';
// Penampil situs Web Lokal (0.34.0 Fase F.1, Electron). Pola archne-webbrowser.js: semua yang menyentuh Electron masuk lewat `deps`
// ({ WebContentsView, session, getWindow, core, send(state), onExternal(url), log }), jadi bisa dites tanpa Electron.
//
// Situs = kode tak tepercaya milik orang lain. Aturan (rencana bagian 4.6):
//  - Origin unik per situs: archne-site://<siteId>/. Hanya SATU situs terbuka; tiap open() membuat tampilan baru dan membuang penyimpanan situs sebelumnya.
//  - Tanpa preload / Node, sandbox menyala, partisi memori sendiri. Semua izin ditolak, unduhan dan jendela baru diblokir, WebRTC tidak boleh mengirim UDP.
//  - Jaringan luar mati di dua lapis: webRequest membatalkan apa pun selain archne-site://<situs ini>/, data:, blob: milik situs ini; CSP dari penampil sebagai lapis kedua.
//  - Isi dilayani dari cache penonton lewat Core (webCacheStream), atau untuk situs MILIK SENDIRI (pratinjau, F.4) dari www/ lewat core.webOwnStream: penampil tidak pernah menerima jalur berkas. Header respons dan CSP SELALU dari sini: pemilik tidak bisa menimpa (berkasnya tidak punya header).
//  - Cookie (F.1b): skema kustom tidak menyimpan cookie, jadi document.cookie diganti shim yang membaca / menulis JAR di memori milik situs yang sedang terbuka (cur.jar, lewat rute /__cookie yang dilayani di sini). Jar dibuat tiap open() dan dibuang bersama penyimpanan situs; tidak pernah ke disk dan tidak pernah dibagi antar-situs. Situs statis tidak punya header Set-Cookie, jadi hanya tulisan JS yang masuk (HttpOnly tidak ada).
//  - Navigasi hanya di dalam situs yang sama. Tautan http(s) tidak dibuka di sini: diserahkan ke deps.onExternal (konfirmasi = F.2). Skema lain ditolak.
const { Readable } = require('stream');
const { tryRel } = require('./archne-webfiles');
const { parseRange } = require('./archne-mediaserve');
const { safeUrl } = require('./archne-webbrowser');
const { tryDomain, showDomain } = require('./archne-webdomain');
const { ek, errText } = require('./core/archne-ecode');
const { createJar, cookieReply, shimOffset, shimTagBytes, MAX_BODY } = require('./archne-cookiejar');
const { createPhpGate } = require('./archne-phpgate');
const { probeRemote, makeRemoteSend } = require('./archne-siteremote');
const PW = require('./archne-pwdetect');
const NF = require('./archne-notfound');

const SCHEME = 'archne-site', PARTITION = 'archne-site';
const COOKIE_PATH = '/__cookie', HTML_WIN = 65536; // HTML_WIN = awal berkas HTML yang dibaca untuk mencari titik sisip shim
const HEX16 = /^[0-9a-f]{16}$/;
const EXT_MAX = 3, EXT_WIN = 5000, EXT_TTL = 60000;
// Satu-satunya sumber kebijakan konten situs. Catatan: 'unsafe-inline' aman di sini karena jaringan luar sudah mati di lapisan webRequest (spike A.1). Tambahan di atas rancangan awal: object-src, base-uri, frame-ancestors.
const CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; form-action 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const CSP_PHP = CSP.replace("form-action 'none'", "form-action 'self'"); // situs PHP: formulir login harus bisa mengirim ke situsnya sendiri; jaringan luar tetap mati di webRequest dan connect-src
const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml', map: 'application/json; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
};
const mimeOf = (p) => { const m = /\.([A-Za-z0-9]+)$/.exec(p); return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream'; };
const SEC = {
  'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), clipboard-read=()',
};
const hdr = (o) => Object.assign({}, SEC, o);

// URL permintaan -> jalur relatif bersih di dalam situs (host harus persis siteId; tanpa kredensial / port) atau null. "/" = berkas awal, "dir/" = dir/index.html.
// Query dan fragmen diabaikan. Jalur dibongkar per segmen: %2F / %5C di dalam segmen ditolak, sisanya lewat tryRel (satu pintu yang sama dengan pengelola berkas).
function siteRel(raw, siteId, entry) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== SCHEME + ':' || u.hostname !== siteId || u.port || u.username || u.password) return null;
  const p = u.pathname;
  if (p === '/' || p === '') return tryRel(entry);
  const segs = p.slice(1).split('/');
  const dir = segs[segs.length - 1] === '';
  if (dir) segs.pop();
  const out = [];
  for (const s of segs) {
    let d;
    try { d = decodeURIComponent(s); } catch { return null; }
    if (d.includes('/') || d.includes('\\')) return null;
    out.push(d);
  }
  return tryRel(out.join('/') + (dir ? '/index.html' : ''));
}

// Permintaan sub-sumber yang boleh lewat. host = siteId situs yang sedang terbuka (kosong = tidak ada: tolak semua).
function allowRequest(raw, host) {
  if (!host) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol === 'data:') return true;
  if (u.protocol === 'blob:') { try { u = new URL(u.pathname); } catch { return false; } } // blob:archne-site://<host>/<uuid>
  return u.protocol === SCHEME + ':' && u.hostname === host && !u.port && !u.username && !u.password;
}

const plain = (status, extra) => new Response(status === 404 ? 'Not found' : null, { status, headers: hdr(Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, extra)) });

// 404 untuk permintaan halaman: 404.html milik situs (status tetap 404), kalau tidak ada halaman bawaan (archne-notfound.js). Sub-sumber: 404 polos.
const notFound = (core, cur, rq) => {
  const nf = cur.files.get('404.html'), d = () => NF.response(rq, hdr({}));
  if (!NF.wantsHtml(rq.headers.get('accept'))) return plain(404);
  return nf && nf.size > 0 && nf.size < 1048577 && cur.jar ? htmlResponse(core, cur, rq, '404.html', nf, { 'content-type': 'text/html; charset=utf-8' }).then((r) => (r.status === 200 ? new Response(r.body, { status: 404, headers: r.headers }) : d()), d) : d();
};
// URL rute cookie (host harus persis siteId, tanpa kredensial / port) -> URL, atau null.
function cookieUrl(raw, siteId) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  return u.protocol === SCHEME + ':' && u.hostname === siteId && !u.port && !u.username && !u.password && u.pathname === COOKIE_PATH ? u : null;
}
// Baca badan permintaan paling banyak max byte -> string, atau null bila lebih besar (pembacaan dihentikan).
async function readCapped(request, max) {
  if (Number(request.headers.get('content-length')) > max) return null;
  if (!request.body) return '';
  const rd = request.body.getReader(), ch = []; let n = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    n += value.length;
    if (n > max) { try { await rd.cancel(); } catch {} return null; }
    ch.push(Buffer.from(value));
  }
  return Buffer.concat(ch).toString('utf8');
}
// Rute /__cookie: hanya halaman situs ini sendiri (same-origin) yang bisa membaca / menulis jar-nya.
async function cookieRoute(cur, request, u) {
  if (!cur.jar) return plain(404);
  const sfs = request.headers.get('sec-fetch-site');
  if (sfs && sfs !== 'same-origin') return plain(403);
  let body = '';
  if (request.method === 'POST') { const b = await readCapped(request, MAX_BODY); if (b === null) return plain(413); body = b; }
  const r = cookieReply(cur.jar, request.method, u.searchParams.get('p'), body);
  if (r.status !== 200) return plain(405, { allow: 'GET, POST' });
  return new Response(r.text, { status: 200, headers: hdr({ 'content-type': 'text/plain; charset=utf-8' }) });
}
// Halaman HTML dengan shim document.cookie disisipkan di awal (byte lain tidak disentuh). Range diabaikan (selalu 200 utuh): panjang berubah, dan peramban tidak meminta Range untuk dokumen.
// Hanya awal berkas (HTML_WIN) yang ditahan di memori untuk mencari titik sisip; sisanya dialirkan.
async function htmlResponse(core, cur, request, rel, f, base) {
  const tag = shimTagBytes(cur.jar.visible(new URL(request.url).pathname));
  const h = hdr(Object.assign(base, { 'accept-ranges': 'none', 'content-length': String(f.size + tag.length) }));
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers: h });
  const open = (a, b) => (cur.own ? core.webOwnStream(cur.siteId, rel, f.size, a, b) : core.webCacheStream(cur.ownerId, cur.siteId, f.hash, f.size, a, b));
  const n1 = Math.min(f.size, HTML_WIN);
  const s1 = open(0, n1 - 1), s2 = s1 && f.size > n1 ? open(n1, f.size - 1) : null;
  const dead = () => { for (const s of [s1, s2]) { try { s && s.destroy(); } catch {} } };
  if (!s1 || (f.size > n1 && !s2)) { dead(); return plain(404); }
  if (request.signal) request.signal.addEventListener('abort', dead, { once: true });
  const parts = [];
  try { for await (const c of s1) parts.push(c); } catch (e) { dead(); if (request.signal && request.signal.aborted) return plain(499); throw e; } // 499 = peramban membatalkan
  const first = Buffer.concat(parts);
  if (first.length !== n1) { dead(); return plain(404); }
  PW.scan(cur, first);
  let off = shimOffset(first);
  if (off >= first.length && f.size > first.length) off = first.length >= 3 && first[0] === 0xef && first[1] === 0xbb && first[2] === 0xbf ? 3 : 0; // awal terlalu panjang untuk dipindai: sisip sesudah BOM
  const out = Readable.from((async function* () { yield first.subarray(0, off); yield tag; yield first.subarray(off); if (s2) for await (const c of s2) yield c; })(), { objectMode: false });
  out.on('close', dead);
  return new Response(Readable.toWeb(out), { status: 200, headers: h });
}


// Situs PHP (P.4): cur.gate = createPhpGate(...). Request web -> gate -> Response. Cookie, Set-Cookie, shim, dan Location ditangani gate.
const GATE_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']), GATE_MAX_BODY = 64 * 1024 * 1024;
async function gateRespond(cur, request) {
  let u;
  try { u = new URL(request.url); } catch { return plain(400); }
  if (u.protocol !== SCHEME + ':' || u.hostname !== cur.siteId || u.port || u.username || u.password) return plain(400);
  if (!GATE_METHODS.has(request.method)) return plain(405, { allow: [...GATE_METHODS].join(', ') });
  const cl = Number(request.headers.get('content-length') || 0);
  if (cl > GATE_MAX_BODY) return plain(413);
  let body;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const ab = Buffer.from(await request.arrayBuffer());
    if (ab.length > GATE_MAX_BODY) return plain(413);
    body = ab.length ? ab : undefined;
  }
  const headers = {}; request.headers.forEach((v, k) => { headers[k] = v; });
  const r = await cur.gate.fetch({ method: request.method, pathname: u.pathname, search: u.search, headers, body });
  const nf = NF.gate(request, r, hdr({ 'content-security-policy': CSP_PHP })); if (nf) return nf; // tanpa 404 sendiri
  const h = new Headers(hdr({ 'content-security-policy': CSP_PHP }));
  for (const [k, v] of Object.entries(r.headers)) for (const x of v) h.append(k, x);
  PW.scan(cur, r.body, r.headers);
  const none = r.status === 204 || r.status === 304 || request.method === 'HEAD' || !r.body.length;
  return new Response(none ? null : r.body, { status: r.status, headers: h });
}

// Satu permintaan -> Response (atau Promise<Response> untuk rute cookie dan HTML bershim). cur = { jar?, ownerId, siteId, entry, own?, files: Map(jalur -> { size, hash? }) }. Hanya GET / HEAD; semua byte lewat core.webCacheStream (cur.own: core.webOwnStream). Selain sumber byte, jalurnya SAMA untuk situs sendiri dan situs peer.
function respond(core, cur, request) {
  if (!cur) return plain(404);
  const cu = cookieUrl(request.url, cur.siteId);
  if (cu) return cookieRoute(cur, request, cu); // Promise
  if (cur.gate) return gateRespond(cur, request); // situs PHP (P.4): Promise
  if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, { allow: 'GET, HEAD' });
  const rel = siteRel(request.url, cur.siteId, cur.entry);
  const f = rel === null ? null : cur.files.get(rel);
  if (!f) return notFound(core, cur, request);
  const base = { 'content-type': mimeOf(rel), 'accept-ranges': 'bytes' };
  const head = request.method === 'HEAD';
  if (f.size === 0) return new Response(null, { status: 200, headers: hdr(Object.assign(base, { 'content-length': '0' })) });
  if (cur.jar && /^text\/html\b/.test(base['content-type'])) return htmlResponse(core, cur, request, rel, f, base); // Promise
  const r = parseRange(request.headers.get('range'), f.size);
  if (r === 'bad') return new Response(null, { status: 416, headers: hdr(Object.assign(base, { 'content-range': 'bytes */' + f.size })) });
  const a = r ? r.start : 0, b = r ? r.end : f.size - 1;
  const h = hdr(Object.assign(base, { 'content-length': String(b - a + 1) }, r ? { 'content-range': `bytes ${a}-${b}/${f.size}` } : {}));
  if (head) return new Response(null, { status: r ? 206 : 200, headers: h });
  const st = cur.own ? core.webOwnStream(cur.siteId, rel, f.size, a, b) : core.webCacheStream(cur.ownerId, cur.siteId, f.hash, f.size, a, b);
  if (!st) return plain(404); // blob hilang / rusak
  if (request.signal) request.signal.addEventListener('abort', () => { try { st.destroy(); } catch {} }, { once: true });
  return new Response(Readable.toWeb(st), { status: r ? 206 : 200, headers: h });
}

const fail = (key, idMsg, code) => { const e = ek(key, null, idMsg, code); return { ok: false, err: errText(e), code }; };

const filesOf = (m) => new Map(m.files.map((x) => [x.p, { size: x.size, hash: x.hash }])); // situs sendiri: hash tidak ada (undefined), tidak dipakai
// Ambil manifest terbaru bila pemilik bisa dijangkau; kalau tidak, pakai cache. -> { man, offline, stale } | { err }. Dipakai bersama oleh penampil Electron dan sesi Android (archne-sitesession.js).
// h = { setAc(ac) (pembatalan dari luar), onProgress({done,total}), mine() (apakah pemanggilan ini masih yang terbaru), php? (true = perangkat ini punya mesin PHP) }.
async function fetchSiteShared(core, log, peerId, siteId, h) {
  const av = core.webReach ? await core.webReach(peerId) : core.webAvail(peerId);
  if (!av.ok && av.why === 'self') { // pratinjau pemilik (F.4): sumber = www/ di perangkat ini, tanpa jaringan dan tanpa cache; penampil, isolasi, dan bilahnya sama dengan situs peer
    let site = null, man = null;
    try { if (core.webStore().has(siteId)) { site = core.webStore().get(siteId); man = core.webOwnManifest(siteId); } } catch (e) { log('sitebrowser: pratinjau gagal ' + (e && e.code)); } // galat disk = sama dengan tidak ada (pesan galat bisa memuat jalur)
    if (!site || !man) return { err: fail('e.site.gone', 'Situs tidak ditemukan atau tidak lagi dibagikan pemiliknya', 'gone') };
    if (site.php && !(h && h.php)) return { err: fail('e.site.phpOff', 'Mesin PHP belum tersedia di perangkat ini', 'phpoff') }; // situs PHP tanpa mesin: jangan sajikan berkas .php sebagai teks
    return { man, offline: false, stale: false, own: true, domain: site.domain, priv: site.priv, php: !!site.php };
  }
  if (!av.ok && !(av.why === 'offline' || av.why === 'old')) {
    return { err: fail('e.site.gone', 'Situs tidak ditemukan atau tidak lagi dibagikan pemiliknya', av.why === 'blocked' ? 'gone' : 'peer') }; // diblokir tak dibedakan dari "tidak ada"
  }
  let stale = false, offline = !av.ok;
  if (av.ok) {
    try {
      let r;
      for (let attempt = 0; ; attempt++) { // webCacheSync berbagi satu pekerjaan per situs: bila yang terbawa baru dibatalkan open sebelumnya, ulangi sekali
        const ac = new AbortController(); h.setAc(ac);
        try { r = await core.webCacheSync(peerId, siteId, { signal: ac.signal, onProgress: (p) => h.onProgress(p) }); break; }
        catch (e) { if (!(e && e.code === 'cancel' && h.mine() && attempt < 1)) throw e; }
      }
      if (r === null) { // tanpa manifest: bukan situs, atau situs PHP (lw_req); Android belum (h.remote)
        if (h.remote) return probeRemote(core, peerId, siteId, h, fail);
        return { err: fail('e.site.gone', 'Situs tidak ditemukan atau tidak lagi dibagikan pemiliknya', 'gone') };
      }
    } catch (e) {
      if (e && e.code === 'cancel') return { err: { ok: false, err: errText(e), code: 'cancel' } };
      stale = true; // gagal di tengah jalan: cache lama (bila ada) tetap utuh karena manifest ditulis terakhir
      const man = core.webCacheManifest(peerId, siteId);
      if (!man) return { err: { ok: false, err: errText(e), code: (e && e.code) || 'peer' } };
    }
  }
  const man = core.webCacheManifest(peerId, siteId);
  if (!man) return { err: fail('e.lw.err.offline', 'Pemilik sedang offline. Situs hanya bisa dibuka saat pemilik online.', 'offline') };
  return { man, offline, stale };
}

const linkOf = (c) => (c.domain && !(c.own && c.priv === 'private') ? 'archne://' + showDomain(c.domain) + '@' + c.ownerId : '');

function createSiteBrowser(deps) {
  const log = deps.log || function () {};
  const core = deps.core;
  const send = (st) => { try { deps.send && deps.send(st); } catch {} };
  let pending = null, opening = null, ses = null, view = null, win = null, top = 48, cur = null, seq = 0, ac = null, onResize = null, onClosed = null, phase = 'idle', progress = null;
  let rac = null; // pembatal permintaan situs PHP peer
  let phpSite = ''; // situs PHP yang Worker-nya sedang dipegang penampil ini (dihentikan saat ditutup / diganti)
  const stopPhp = () => { if (rac) { try { rac.abort(); } catch {} rac = null; } const id = phpSite; phpSite = ''; if (id && deps.php) { try { deps.php.stop(id); } catch {} } };

  // Nama pemilik SELALU dari Core (deps.nameOf), bukan renderer/situs: bilah tak bisa dipalsukan. Domain dari renderer dipakai bila lolos normDomain.
  const ownerName = (id) => { let n = ''; try { n = deps.nameOf ? deps.nameOf(id) : ''; } catch {} return typeof n === 'string' ? n.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 32) : ''; };

  const wcOf = () => (view && view.webContents && !view.webContents.isDestroyed() ? view.webContents : null);
  const hist = (wc) => wc.navigationHistory || wc;
  const state = (extra) => {
    const wc = wcOf();
    const c = cur || opening; // saat menyinkronkan, bilah sudah tahu siapa pemiliknya (nama dari Core)
    const o = { open: !!cur, status: phase, siteId: c ? c.siteId : '', peerId: c ? c.ownerId : '', domain: c ? c.domain : '', owner: c && !c.own ? ownerName(c.ownerId) : '', own: !!(c && c.own), pw: !!(cur && cur.pw), priv: c && c.own ? c.priv : '', link: c ? linkOf(c) : '', rev: cur ? cur.rev : 0, offline: !!(cur && cur.offline), stale: !!(cur && cur.stale), progress, path: '', title: '', canBack: false, canFwd: false, loading: false };
    if (wc && cur) {
      try { const u = new URL(wc.getURL()); if (u.hostname === cur.siteId) o.path = decodeURIComponent(u.pathname) + u.search; o.title = wc.getTitle(); o.loading = !!wc.isLoading(); const h = hist(wc); o.canBack = !!h.canGoBack(); o.canFwd = !!h.canGoForward(); } catch {}
    }
    return Object.assign(o, extra || {});
  };
  const push = (extra) => send(state(extra));

  function layout() {
    if (!view || !win || win.isDestroyed()) return;
    const cb = win.getContentBounds();
    const z = (win.webContents && typeof win.webContents.getZoomFactor === 'function' ? win.webContents.getZoomFactor() : 1) || 1;
    const y = Math.max(0, Math.min(Math.round(top * z), cb.height - 40));
    view.setBounds({ x: 0, y, width: Math.max(1, cb.width), height: Math.max(1, cb.height - y) });
  }

  // Sesi memori bersama (dibuat sekali). Penangan protokol membaca `cur` pada saat permintaan datang.
  function setup() {
    if (ses) return;
    ses = deps.session.fromPartition(PARTITION); // tanpa 'persist:' = hanya di memori
    ses.protocol.handle(SCHEME, async (req) => { try { return await respond(core, cur, req); } catch (e) { log('sitebrowser: ' + e.message); return plain(500); } });
    ses.webRequest.onBeforeRequest((d, cb) => { const ok = allowRequest(d.url, cur && cur.siteId); if (!ok) log('sitebrowser: dibatalkan ' + String(d.url).slice(0, 60)); cb({ cancel: !ok }); });
    for (const [fn, v] of [['setPermissionRequestHandler', (_w, _p, cb) => cb(false)], ['setPermissionCheckHandler', () => false], ['setDevicePermissionHandler', () => false]]) { try { ses[fn](v); } catch {} }
    try { ses.on('will-download', (ev) => ev.preventDefault()); } catch {}
  }

  const inSite = (u) => { try { const x = new URL(u); return !!cur && x.protocol === SCHEME + ':' && x.hostname === cur.siteId && !x.port && !x.username && !x.password; } catch { return false; } };
  // Tautan http(s) keluar: diserahkan ke deps.onExternal (konfirmasi pengguna di F.2). Situs bisa memicunya dari skrip tanpa klik, jadi dibatasi EXT_MAX kali per EXT_WIN ms; selebihnya diam-diam dibuang.
  const now = deps.now || Date.now, extLog = [];
  function external(u) {
    const w = safeUrl(u), t = now();
    while (extLog.length && t - extLog[0] >= EXT_WIN) extLog.shift();
    if (!w || !deps.onExternal) { log('sitebrowser: tautan ditolak ' + String(u).slice(0, 40)); return; }
    if (extLog.length >= EXT_MAX) { log('sitebrowser: tautan keluar dibatasi'); return; }
    extLog.push(t);
    pending = { url: w, at: t };
    try { deps.onExternal(w); } catch {}
  }
  // Konfirmasi pengguna di bilah: hanya tautan yang BARU diminta situs ini yang boleh dibuka (sekali pakai, kedaluwarsa EXT_TTL); renderer tidak bisa menyuruh membuka alamat lain lewat jalur ini.
  async function confirmExternal(url) {
    const p = pending; pending = null;
    if (!p || typeof url !== 'string' || url !== p.url || now() - p.at > EXT_TTL) return { ok: false, err: errText(ek('e.site.extGone', null, 'Permintaan membuka tautan sudah kedaluwarsa')), code: 'gone' };
    if (!deps.shell || typeof deps.shell.openExternal !== 'function') return { ok: false, err: errText(ek('e.web.extFail', null, 'Gagal membuka peramban luar')) };
    try { await deps.shell.openExternal(p.url); return { ok: true }; } catch { return { ok: false, err: errText(ek('e.web.extFail', null, 'Gagal membuka peramban luar')) }; }
  }
  const dismissExternal = () => { pending = null; return { ok: true }; }

  function build() {
    const v = new deps.WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, devTools: false, webviewTag: false, navigateOnDragDrop: false } });
    const wc = v.webContents;
    try { wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'); } catch {} // spike A.2: situs bisa mengirim UDP buta lewat ICE; kebijakan ini mematikannya
    wc.setWindowOpenHandler((d) => { const u = d && d.url; if (inSite(u)) { try { wc.loadURL(u); } catch {} } else external(u); return { action: 'deny' }; });
    const guard = (ev, u) => { if (inSite(u)) return; try { ev.preventDefault(); } catch {} external(u); };
    wc.on('will-navigate', (ev, u) => guard(ev, u));
    wc.on('will-redirect', (ev, u) => { if (!inSite(u)) { try { ev.preventDefault(); } catch {} } }); // penampil sendiri tidak pernah mengalihkan; pengalihan keluar hanya dicegat (tanpa onExternal)
    for (const e of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-fail-load']) wc.on(e, () => push());
    wc.on('render-process-gone', () => push({ crashed: true }));
    return v;
  }

  // Tutup tampilan dan buang semua yang dibuat situs (localStorage, cookie, IndexedDB). Menunggu selesai supaya situs berikutnya tidak berbagi sisa.
  async function teardown() {
    const v = view; view = null;
    if (v) {
      try { if (win && !win.isDestroyed()) { win.contentView.removeChildView(v); win.removeListener('resize', onResize); win.removeListener('closed', onClosed); } } catch {}
      try { if (v.webContents && !v.webContents.isDestroyed()) v.webContents.close(); } catch {}
    }
    if (ses) { try { await ses.clearStorageData(); await ses.clearCache(); } catch (e) { log('sitebrowser: bersihkan sesi gagal ' + e.message); } }
  }

  const urlOf = (siteId, p) => SCHEME + '://' + siteId + '/' + p.split('/').map(encodeURIComponent).join('/');

  const fetchSite = (peerId, siteId, my) => fetchSiteShared(core, log, peerId, siteId, { php: !!deps.php, remote: true, setAc: (a) => { ac = a; }, onProgress: (p) => { if (my === seq) { progress = { done: p.done, total: p.total }; push(); } }, mine: () => my === seq });

  // Buka situs milik peer. Balasan async: { ok:true, rev, offline, stale } | { ok:false, err, code }. Panggilan baru membatalkan yang masih berjalan.
  async function open(a) {
    if (!a || typeof a !== 'object' || typeof a.peerId !== 'string' || !HEX16.test(a.peerId) || typeof a.siteId !== 'string' || !HEX16.test(a.siteId)) return fail('e.site.bad', 'Situs tidak valid', 'bad');
    win = deps.getWindow();
    if (!win || win.isDestroyed()) return fail('e.site.noWin', 'Jendela tidak tersedia', 'nowin');
    const domain = typeof a.domain === 'string' ? (tryDomain(a.domain) || '') : '';
    if (typeof a.topPx === 'number' && isFinite(a.topPx)) top = Math.max(0, Math.min(400, a.topPx));
    setup();
    const my = ++seq;
    if (ac) { try { ac.abort(); } catch {} }
    stopPhp();
    await teardown();
    cur = null; progress = null; pending = null; phase = 'syncing';
    opening = { ownerId: a.peerId, siteId: a.siteId, domain };
    push({ open: true });
    const r = await fetchSite(a.peerId, a.siteId, my);
    if (my !== seq) return { ok: false, err: '', code: 'cancel' }; // digantikan open / close yang lebih baru
    if (r.err) { opening = null; phase = 'error'; push({ open: false, error: r.err.err }); return r.err; }
    // Situs PHP: lewat gerbang cookie/sesi; pratinjau pemilik -> router lokal (Worker dinyalakan DULU), situs peer -> lw_req.
    const jar = createJar();
    let gate = null;
    if (r.remote) { // situs PHP peer: jalan di perangkat pemilik
      rac = new AbortController();
      gate = createPhpGate({ jar, send: makeRemoteSend(core, a.peerId, a.siteId, r.first, r.firstAt, rac.signal), host: a.siteId, peer: '', onExternal: external });
    } else if (r.php) {
      let router = null, bad = null;
      try { router = deps.php.router(a.siteId); phpSite = a.siteId; await router.warm(); } catch (e) { bad = e; }
      if (my !== seq) return { ok: false, err: '', code: 'cancel' }; // Worker-nya dihentikan oleh open / close yang menggantikan (jangan stop di sini: bisa situs yang sama dan Worker barunya)
      if (bad) { stopPhp(); log('sitebrowser: mesin PHP gagal ' + (bad.code || bad.message)); opening = null; phase = 'error'; const f = fail('e.site.phpFail', 'Mesin PHP gagal dimulai', 'phpfail'); push({ open: false, error: f.err }); return f; }
      const me = core && typeof core.id === 'string' && HEX16.test(core.id) ? core.id : '';
      gate = createPhpGate({ jar, send: (rq) => router.handle(rq), host: a.siteId, peer: me, onExternal: external });
    }
    opening = null;
    const c0 = cur = Object.assign({ jar, ownerId: a.peerId, siteId: a.siteId, domain: r.own ? r.domain : domain, own: !!r.own, priv: r.priv, entry: r.man.entry, rev: r.man.rev, files: filesOf(r.man), offline: r.offline, stale: r.stale }, gate ? { gate } : {}); // situs sendiri: domain dari catatan situs, bukan dari renderer
    c0.onPw = PW.hook(c0, () => cur === c0, push);
    phase = 'ready'; progress = null;
    view = build(); // situs PHP dimuat dari akar "/": router memilih index.php / index.html seperti Apache (berkas awal situs tidak dipakai)
    win.contentView.addChildView(view);
    onResize = () => layout(); onClosed = () => { close().catch(() => {}); };
    win.on('resize', onResize); win.on('closed', onClosed);
    layout();
    try { view.webContents.loadURL(urlOf(a.siteId, cur.gate ? '' : cur.entry)).catch(() => {}); } catch (e) { log('sitebrowser: loadURL gagal ' + e.message); }
    push();
    return { ok: true, rev: cur.rev, offline: cur.offline, stale: cur.stale };
  }

  async function close() {
    seq++;
    if (ac) { try { ac.abort(); } catch {} }
    cur = null; opening = null; progress = null; pending = null; phase = 'idle';
    stopPhp();
    await teardown();
    send({ open: false, status: 'idle', siteId: '', peerId: '', domain: '', owner: '', own: false, priv: '', link: '', rev: 0, offline: false, stale: false, progress: null, path: '', title: '', canBack: false, canFwd: false, loading: false });
    return { ok: true };
  }
  const dispose = () => { close().catch(() => {}); };

  function nav(action) {
    const wc = wcOf();
    if (!wc) return { ok: false };
    const h = hist(wc);
    if (action === 'back') { if (h.canGoBack()) { if (typeof h.goBack === 'function') h.goBack(); else wc.goBack(); } }
    else if (action === 'forward') { if (h.canGoForward()) { if (typeof h.goForward === 'function') h.goForward(); else wc.goForward(); } }
    else if (action === 'reload') wc.reload(); // dari cache yang sudah ada; ambil versi terbaru dari pemilik = refresh()
    else if (action === 'stop') wc.stop();
    else return { ok: false, err: errText(ek('e.web.badAction', null, 'Aksi tidak dikenal')) };
    return { ok: true };
  }
  // Ambil ulang dari pemilik lalu muat ulang (berbeda dengan open: tampilan dan penyimpanan situs tetap).
  async function refresh() {
    if (!cur || !view) return { ok: false };
    const my = ++seq, { ownerId, siteId } = cur;
    phase = 'syncing'; push();
    const r = await fetchSite(ownerId, siteId, my);
    if (my !== seq || !cur) return { ok: false, code: 'cancel' };
    phase = 'ready'; progress = null;
    if (r.err) { push({ error: r.err.err }); return r.err; }
    if (!!r.php !== !!cur.gate) { const f = fail('e.site.phpMode', 'Mode PHP situs berubah. Buka ulang situsnya.', 'mode'); push({ error: f.err }); return f; } // saklar Mesin PHP diubah saat terbuka: gerbang tidak dipasang / dilepas di tengah jalan
    Object.assign(cur, { entry: r.man.entry, rev: r.man.rev, files: filesOf(r.man), offline: r.offline, stale: r.stale }, r.own ? { domain: r.domain, priv: r.priv } : {});
    const wc = wcOf();
    if (wc) wc.reload();
    push();
    return { ok: true, rev: cur.rev, offline: cur.offline, stale: cur.stale };
  }
  function setTop(px) { if (typeof px === 'number' && isFinite(px)) { top = Math.max(0, Math.min(400, px)); layout(); } return { ok: true }; }

  return { open, close, refresh, nav, setTop, confirmExternal, dismissExternal, dispose, state, get isOpen() { return !!cur; } };
}

module.exports = { createSiteBrowser, fetchSiteShared, filesOf, linkOf, fail, siteRel, allowRequest, respond, mimeOf, CSP, CSP_PHP, SCHEME, PARTITION };

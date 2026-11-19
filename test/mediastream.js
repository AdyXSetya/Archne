'use strict';
// Tes streaming media (v0.25.0 Step 2b): Range, berkas yang masih tumbuh (putar sambil unduh), kebijakan keamanan, server HTTP, dan alur pemutar.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), vm = require('vm'), assert = require('assert');
const S = require('../src/archne-mediaserve');
const mixin = require('../src/core/archne-media');
const root = path.join(__dirname, '..');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B = (...a) => Buffer.concat(a.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x, 'latin1'))));
const MP4 = (n) => B([0, 0, 0, 0x18], 'ftypisom', Buffer.from(Array.from({ length: n - 12 }, (_, i) => (i * 7 + 3) & 255)));

(async () => {
  // ---- 1. parseRange ----
  assert.deepStrictEqual(S.parseRange(undefined, 100), null); assert.deepStrictEqual(S.parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepStrictEqual(S.parseRange('bytes=10-', 100), { start: 10, end: 99 }); assert.deepStrictEqual(S.parseRange('bytes=-5', 100), { start: 95, end: 99 });
  assert.deepStrictEqual(S.parseRange('bytes=90-500', 100), { start: 90, end: 99 }, 'akhir dipotong ke ukuran');
  for (const bad of ['bytes=100-', 'bytes=5-2', 'bytes=0-1,4-5', 'bytes=-', 'bytes=-0', 'items=0-1', 'bytes=a-b', 'bytes=0-1e3', 'bytes=99999999999999999999-']) assert.strictEqual(S.parseRange(bad, 100), 'bad', bad);
  ok('parseRange: rentang sah, akhir dipotong, rentang ganda/terbalik/di luar ukuran/aneh ditolak (416)');

  // ---- 2. Core.mediaStream: kebijakan ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-'));
  const ID = (n) => String(n).padStart(32, 'c'), FROM = 'bb'.repeat(8), TOTAL = 200000;
  const full = MP4(TOTAL);
  const mkOffer = (name, o) => Object.assign({ name, meta: { mode: 'raw', size: TOTAL, psize: TOTAL } }, o || {});
  const store = { msgs: {}, got: {} }, offers = {}, rx = new Set();
  const add = (n, name, msg, off) => { store.msgs[ID(n)] = Object.assign({ from: FROM, to: 'me', kind: 'e1' }, msg); offers[ID(n)] = mkOffer(name, off); };
  add(1, 'klip.mp4'); add(2, 'klip.mp4', { to: 'public', kind: undefined }); add(3, 'klip.mp4', {}, { meta: { mode: 'br', size: TOTAL, psize: 1000 } }); add(4, 'klip.mkv'); add(5, 'lagu.mp4'); add(6, 'klip.mp4', {}, {});
  const core = Object.assign({ id: 'me', store, stopped: false, _rx: { has: (i) => rx.has(i) }, _dl: { has: () => false },
    _offerOf: (m) => offers[Object.keys(store.msgs).find((k) => store.msgs[k] === m)], _inPaths: (i) => ({ part: path.join(dir, i + '.part'), pk: path.join(dir, i + '.pk') }) }, mixin);
  let r = await core.mediaStream(ID(2)); assert(!r.ok && r.code === 'public', 'Publik: tidak sambil unduh');
  r = await core.mediaStream(ID(3)); assert(!r.ok && r.code === 'packed', 'terkompres: tidak sambil unduh');
  r = await core.mediaStream(ID(4)); assert(!r.ok && r.code === 'format', 'mkv: bukan format pemutar');
  r = await core.mediaStream(ID(1)); assert(!r.ok && r.code === 'notstarted', 'unduhan belum jalan');
  rx.add(ID(1)); r = await core.mediaStream(ID(1)); assert(!r.ok && r.code === 'wait', 'belum ada data');
  fs.writeFileSync(core._inPaths(ID(1)).part, B('<html>', Buffer.alloc(100))); r = await core.mediaStream(ID(1)); assert(!r.ok && r.code === 'notmedia', 'data pertama bukan media: ditolak');
  for (const bad of ['x', '../a', undefined]) { r = await core.mediaStream(bad); assert(!r.ok && r.code === 'bad'); }
  ok('Core.mediaStream: Publik, terkompres, format asing, belum mulai, belum ada data, isi palsu -> ditolak dengan kode jelas');

  // ---- 3. berkas tumbuh: dibaca konsisten, pindah .part -> .pk -> final ----
  const part = core._inPaths(ID(1)).part;
  fs.writeFileSync(part, full.subarray(0, 50000));
  r = await core.mediaStream(ID(1)); assert(r.ok && r.live && r.total === TOTAL && r.mime === 'video/mp4' && /^[0-9a-f]{32}$/.test(r.tok), JSON.stringify(r));
  const tok = r.tok; assert.deepStrictEqual(core.mediaSrcInfo(tok), { mime: 'video/mp4', total: TOTAL }); assert.strictEqual(core.mediaSrcInfo('0'.repeat(32)), null);
  let b = await core.mediaSrcRead(tok, 100, 1000); assert(b.equals(full.subarray(100, 1100)), 'baca di tengah .part');
  b = await core.mediaSrcRead(tok, 49000, 5000); assert(b.length === 1000 && b.equals(full.subarray(49000, 50000)), 'dibatasi data yang sudah ada');
  b = await core.mediaSrcRead(tok, 60000, 10); assert(b.length === 0, 'belum sampai: kosong (tunggu), bukan galat');
  fs.appendFileSync(part, full.subarray(50000, 120000)); b = await core.mediaSrcRead(tok, 60000, 10); assert(b.equals(full.subarray(60000, 60010)), 'data baru langsung terbaca');
  fs.writeFileSync(part, full); fs.renameSync(part, core._inPaths(ID(1)).pk); b = await core.mediaSrcRead(tok, 150000, 100); assert(b.equals(full.subarray(150000, 150100)), '.part menjadi .pk: tetap terbaca');
  const fin = path.join(dir, 'final.mp4'); fs.writeFileSync(fin, full); store.got[ID(1)] = { name: 'klip.mp4', path: fin }; fs.unlinkSync(core._inPaths(ID(1)).pk); rx.clear();
  b = await core.mediaSrcRead(tok, 199990, 100); assert(b.equals(full.subarray(199990)), 'berkas final: terbaca sampai ujung');
  assert.strictEqual(await core.mediaSrcRead(tok, TOTAL, 10), null, 'melewati ujung: null'); assert.strictEqual(await core.mediaSrcRead(tok, -1, 10), null);
  fs.writeFileSync(fin, full.subarray(0, 1000)); b = await core.mediaSrcRead(tok, 10, 10); assert(b === null, 'berkas final terpotong/diganti: tidak dibaca; tidak ada unduhan: null');
  fs.writeFileSync(fin, full);
  core.stopped = true; assert.strictEqual(core.mediaSrcInfo(tok), null); assert.strictEqual(await core.mediaSrcRead(tok, 0, 10), null, 'Core berhenti: token mati'); core.stopped = false;
  ok('berkas tumbuh: dibaca sebatas data yang ada, data baru langsung terbaca, .part->.pk->final tetap terbaca, berkas final yang salah ukuran ditolak, token mati saat Core berhenti');

  // ---- 4. server HTTP nyata: Range, 416, 404, berkas tumbuh selagi dilayani ----
  r = await core.mediaStream(ID(1)); const tokF = r.tok; assert(r.ok && !r.live, 'berkas lengkap: bukan live');
  const srv = http.createServer((req, res) => { const m = /^\/media\/(.*)$/.exec(req.url); if (!m) { res.writeHead(404); return res.end(); } S.serveHttp(core, m[1], req, res); });
  await new Promise((rs) => srv.listen(0, '127.0.0.1', rs)); const port = srv.address().port;
  const get = (p, h, method) => new Promise((rs, rj) => { const q = http.request({ port, path: p, headers: h || {}, method: method || 'GET' }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => rs({ s: res.statusCode, h: res.headers, b: Buffer.concat(c) })); }); q.on('error', rj); q.end(); });
  let x = await get('/media/' + tokF); assert(x.s === 200 && x.b.equals(full) && x.h['content-type'] === 'video/mp4' && x.h['accept-ranges'] === 'bytes' && x.h['x-content-type-options'] === 'nosniff' && x.h['cache-control'] === 'no-store');
  x = await get('/media/' + tokF, { range: 'bytes=1000-1999' }); assert(x.s === 206 && x.h['content-range'] === `bytes 1000-1999/${TOTAL}` && x.b.equals(full.subarray(1000, 2000)));
  x = await get('/media/' + tokF, { range: 'bytes=-500' }); assert(x.s === 206 && x.b.equals(full.subarray(TOTAL - 500)), 'seek ke ujung (moov di akhir)');
  x = await get('/media/' + tokF, { range: 'bytes=150000-' }); assert(x.s === 206 && x.b.length === 50000 && x.b.equals(full.subarray(150000)), 'rentang terbuka mengalir sampai ujung, lewat beberapa potongan');
  x = await get('/media/' + tokF, { range: 'bytes=999999-' }); assert(x.s === 416 && x.h['content-range'] === `bytes */${TOTAL}`);
  x = await get('/media/' + tokF, null, 'HEAD'); assert(x.s === 200 && x.b.length === 0 && x.h['content-length'] === String(TOTAL));
  for (const t of ['0'.repeat(32), 'x', '../../etc/passwd', tokF.toUpperCase(), tokF + 'a']) { x = await get('/media/' + t); assert(x.s === 404 && x.b.length === 0, 'token tidak sah: ' + t); }
  // tumbuh selagi dilayani: permintaan terbuka menunggu data baru, selesai bila unduhan selesai
  delete store.got[ID(1)]; rx.add(ID(1));
  fs.writeFileSync(part, full.subarray(0, 30000));
  const live = await core.mediaStream(ID(1)); assert(live.ok && live.live);
  const pend = get('/media/' + live.tok, { range: 'bytes=0-' });
  await sleep(300); fs.appendFileSync(part, full.subarray(30000, 120000)); await sleep(300); fs.appendFileSync(part, full.subarray(120000));
  await sleep(200); fs.renameSync(part, core._inPaths(ID(1)).pk); rx.clear();
  x = await pend; assert(x.s === 206 && x.b.equals(full), 'permintaan yang menunggu data baru mendapat seluruh berkas utuh walau data tiba bertahap');
  // klien putus: tidak menggantung
  rx.add(ID(1)); fs.rmSync(core._inPaths(ID(1)).pk); fs.writeFileSync(part, full.subarray(0, 1000));
  const live2 = await core.mediaStream(ID(1));
  await new Promise((rs) => { const q = http.request({ port, path: '/media/' + live2.tok, headers: { range: 'bytes=5000-' } }); q.on('error', () => {}); q.on('response', () => {}); q.end(); setTimeout(() => { q.destroy(); rs(); }, 300); });
  await sleep(400); rx.clear(); srv.close();
  ok('server HTTP: 200/206/416/404/HEAD, seek ke ujung, rentang terbuka bertahap, token jelek -> 404, permintaan menunggu data yang tumbuh dan selesai utuh, klien putus tidak menggantung');

  // ---- 5. alur pemutar (renderer) ----
  const els = {}, hist = [], created = [], toasts = [], calls = [];
  const mk = (id) => ({ id, textContent: '', innerHTML: '', onclick: null, firstChild: null, classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    appendChild(c) { this.firstChild = c; }, removeAttribute() {}, setAttribute() {}, pause() {}, load() {}, play() { return Promise.resolve(); } });
  const $ = (id) => els[id] || (els[id] = mk(id));
  els.mpb = mk('mpb'); Object.defineProperty(els.mpb, 'innerHTML', { get() { return ''; }, set() { els.mpb.firstChild = null; } });
  let streamRet, blobRet = { ok: true, kind: 'aud', mime: 'audio/mpeg', size: 5, b64: Buffer.from('hello').toString('base64') }, loc = { protocol: 'file:', pathname: '/x/archne-index.html' };
  const ctx = { $, S: { messages: [{ id: 'm1', file: { name: 'lagu.mp3' } }], call: null }, toast: (t) => toasts.push(t), callCtl: { cur: null }, Blob: function (p, o) { this.type = o.type; }, atob: (s) => Buffer.from(s, 'base64').toString('latin1'), Uint8Array, console, setTimeout,
    URL: { createObjectURL: () => 'blob:abc', revokeObjectURL() {} }, document: { createElement: (t) => { const e = mk(t); e.tag = t; created.push(e); return e; }, addEventListener() {} },
    window: { location: loc, history: { pushState: (s) => hist.push(s), back: () => { hist.pop(); ctx.playerPop(); } }, addEventListener() {}, api: { mediaStream: async (id) => { calls.push('stream'); return typeof streamRet === 'function' ? streamRet() : streamRet; }, mediaPlay: async () => { calls.push('blob'); return blobRet; }, openFile: async () => ({ ok: true }) } } };
  vm.createContext(ctx);
  vm.runInContext(require('./_src').txfJs() + '\n' + fs.readFileSync(path.join(root, 'renderer/js/archne-player.js'), 'utf8') + '\nglobalThis.__t = { openPlayer, playerStop, playerOpenNow };', ctx);
  const T = ctx.__t, TK = 'a'.repeat(32);
  streamRet = { ok: true, kind: 'aud', mime: 'audio/mpeg', total: 5000000, tok: TK, live: false };
  await T.openPlayer('m1'); assert.strictEqual(created[0].src, 'archne-media://m/' + TK, 'desktop: protokol archne-media'); assert.deepStrictEqual(calls, ['stream'], 'tanpa membaca isi lewat IPC'); T.playerStop();
  loc.protocol = 'http:'; loc.pathname = '/s/' + 'ab'.repeat(8) + '/'; await T.openPlayer('m1'); assert.strictEqual(created[1].src, '/s/' + 'ab'.repeat(8) + '/media/' + TK, 'Android: rute /media/ di bawah awalan sesi'); T.playerStop();
  loc.pathname = '/'; await T.openPlayer('m1'); assert.strictEqual(created[2].src, '/media/' + TK, 'peramban: akar'); T.playerStop();
  // stream gagal -> blob sekali (berkas kecil lengkap); berkas besar atau live: tidak
  calls.length = 0; streamRet = { ok: true, kind: 'aud', mime: 'audio/mpeg', total: 5000, tok: TK, live: false };
  await T.openPlayer('m1'); created[created.length - 1].onerror(); await sleep(10); assert(calls.join() === 'stream,blob' && created[created.length - 1].src === 'blob:abc', 'jatuh balik ke blob'); created[created.length - 1].onerror(); await sleep(10); assert.strictEqual(calls.filter((c) => c === 'blob').length, 1, 'hanya sekali'); T.playerStop();
  streamRet = { ok: true, kind: 'vid', mime: 'video/mp4', total: 900 * 1048576, tok: TK, live: false }; calls.length = 0;
  await T.openPlayer('m1'); created[created.length - 1].onerror(); await sleep(10); assert(!calls.includes('blob') && ctx.$('mpm').textContent.includes('tidak didukung'), 'berkas besar: tidak ada blob; pesan format'); T.playerStop();
  // shell lama tanpa mediaStream
  const keep = ctx.window.api.mediaStream; ctx.window.api.mediaStream = undefined; calls.length = 0; await T.openPlayer('m1'); assert(calls.join() === 'blob' && created[created.length - 1].src === 'blob:abc', 'tanpa mediaStream: jalur blob lama'); T.playerStop(); ctx.window.api.mediaStream = keep;
  // putar sambil unduh: menunggu data pertama, lalu jalan; galat jelas bila ditolak
  let n = 0; streamRet = () => (++n < 3 ? { ok: false, code: 'wait', err: 'Menunggu data pertama…' } : { ok: true, kind: 'vid', mime: 'video/mp4', total: 9e6, tok: TK, live: true });
  const t0 = Date.now(); await T.openPlayer('m1', true); assert(n === 3 && Date.now() - t0 >= 1300 && created[created.length - 1].tag === 'video' && T.playerOpenNow(), 'menunggu lalu memutar'); T.playerStop();
  streamRet = { ok: false, code: 'public', err: 'Di Publik, berkas diputar setelah selesai diunduh.' }; await T.openPlayer('m1', true); assert(ctx.$('mpm').textContent.includes('Publik') && ctx.$('mpb').firstChild === null); T.playerStop();
  streamRet = { ok: false, code: 'wait' }; n = 0; const pr = T.openPlayer('m1', true); await sleep(100); T.playerStop(); const c0 = created.length; await pr; assert(!T.playerOpenNow() && created.length === c0, 'ditutup saat menunggu: berhenti, tidak ada elemen');
  ok('alur pemutar: URL per platform, tanpa IPC byte, jatuh balik blob sekali, shell lama, putar sambil unduh menunggu data pertama, galat Publik, tutup saat menunggu');

  // ---- 6. kartu dan kontrak ----
  const FC = require('../renderer/archne-filecard'), ID1 = 'ab'.repeat(16);
  const card = (to, file, extra) => FC.cardHtml({ id: ID1, to, file: Object.assign({ name: 'klip.mp4', size: 9e6, psize: 9e6, mode: 'raw' }, file) }, {}, extra);
  assert(card('0123456789abcdef').includes('data-act="playdl"') && card('g:abc').includes('data-act="playdl"'), 'DM/grup belum diunduh: Putar sambil unduh');
  assert(!card('public').includes('playdl') && !card('0123456789abcdef', { mode: 'br' }).includes('playdl') && !card('0123456789abcdef', { name: 'film.mkv' }).includes('playdl') && !card('0123456789abcdef', { name: 'a.mp4.exe' }).includes('playdl'), 'tidak untuk Publik, terkompres, mkv, berisiko');
  assert(card('0123456789abcdef', { rx: { phase: 'download', done: 10, total: 100 } }).includes('data-act="playdl"'), 'selagi mengunduh: tombol tetap ada'); assert(!card('0123456789abcdef', { saved: { name: 'klip.mp4' } }).includes('playdl'), 'sudah tersimpan: Putar biasa');
  const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  assert(/mediaStream: \(id\) => ipcRenderer\.invoke\('mediaStream', id\)/.test(rd('preload.js')) && /'mediaStream'/.test(rd('renderer/archne-api-http.js')) && /ipcMain\.handle\('mediaStream'/.test(rd('src/archne-ipc.js')));
  assert(/registerSchemesAsPrivileged\(\[\{ scheme: 'archne-media'[^\]]*stream: true/.test(rd('main.js')) && /protocol\.handle\('archne-media'/.test(rd('main.js')) && /startsWith\('\/media\/'\)/.test(rd('src/archne-rpc.js')));
  assert(/act === 'playdl'/.test(rd('renderer/js/archne-profile-compose.js')));
  ok('kartu: Putar sambil unduh hanya DM/grup raw yang aman; kontrak preload/api-http/ipc, protokol Electron, rute Android');

  // ---- 7. jalur Electron (protocol.handle): Response Web ----
  fs.writeFileSync(path.join(dir, 'w.mp4'), full); store.got[ID(1)] = { name: 'klip.mp4', path: path.join(dir, 'w.mp4') };
  const wt = (await core.mediaStream(ID(1))).tok;
  let wr = S.serveWeb(core, wt, new Request('archne-media://m/' + wt, { headers: { range: 'bytes=70000-79999' } }));
  assert(wr.status === 206 && wr.headers.get('content-range') === `bytes 70000-79999/${TOTAL}` && Buffer.from(await wr.arrayBuffer()).equals(full.subarray(70000, 80000)), 'serveWeb: 206 dengan rentang');
  wr = S.serveWeb(core, wt, new Request('archne-media://m/' + wt)); assert(wr.status === 200 && Buffer.from(await wr.arrayBuffer()).equals(full), 'serveWeb: utuh');
  assert.strictEqual(S.serveWeb(core, 'zz', new Request('archne-media://m/zz')).status, 404); assert.strictEqual(S.serveWeb(core, wt, new Request('archne-media://m/' + wt, { headers: { range: 'bytes=9999999-' } })).status, 416);
  ok('serveWeb (Electron): 206 berisi rentang tepat, 200 utuh, 404 token jelek, 416 di luar ukuran');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nOK: ' + pass + ' kelompok');
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

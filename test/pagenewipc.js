'use strict';
// Tes Halaman 5b-3 fase 1 (5b-3a): jembatan IPC lencana "postingan baru" (src/archne-ipc-pages.js: kanal pgNewList, event pgnew; Core.pageNewList) dengan Electron palsu + Core sungguhan.
// Yang diuji: daftar kosong tanpa membuat berkas, daftar sesudah menyala, penyaring teman / blokir pada daftar, bentuk event keluar (dua bidang), event cacat tidak disiarkan,
// pgList tidak bisa memakai quiet dari renderer, galat Core dipetakan, dispose melepas pendengar, Core tiruan tanpa EventEmitter tidak merusak register; (5b-3b) preload.js dan archne-api-http.js memuat pgNewList + onPgNew.
// V = penonton, A = pemilik.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { registerPages } = require('../src/archne-ipc-pages');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagenewipc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
let pass = 0;
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, tickMs: 100 });
function fake(core) {
  const handlers = {}, sent = [];
  const reg = register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core, send: (ch, p) => { sent.push([ch, p]); }, log: () => {} });
  const f = (n, ...a) => handlers[n]({}, ...a); f.sent = sent; f.reg = reg; f.handlers = handlers;
  return f;
}
const news = (f) => f.sent.filter((x) => x[0] === 'pgnew').map((x) => x[1]);

(async () => {
  const V = mk('V'), A = mk('A');
  await V.start(); await A.start();
  try {
    const v = fake(V);
    await V.addPeer('127.0.0.1', A.port);
    await until(() => V.peers.has(A.id) && A.peers.has(V.id) && V.isOnline(V.peers.get(A.id)), 8000, 'saling kenal');
    const file = path.join(tmp, 'V', 'pgnew.json');
    const mkPost = async (c, o) => { await sleep(5); return c.pageStore().create(o); };
    const lit = async (label) => { V._pgnStore().soon(A.id); await until(() => V._pgn && V._pgn.has(A.id), 4000, label); };
    let r;

    // ---- 1. daftar kosong: tanpa penyimpanan, tanpa berkas; argumen diabaikan ----
    {
      r = await v('pgNewList'); assert.deepStrictEqual(r, { ok: true, peers: [] });
      r = await v('pgNewList', 'zz', { x: 1 }, 5); assert.deepStrictEqual(r, { ok: true, peers: [] }, 'argumen apa pun diabaikan');
      assert.strictEqual(fs.existsSync(file), false, 'membaca daftar kosong tidak membuat berkas'); assert(!V._pgn || V._pgn.size === 0, 'tidak membuat penyimpanan');
      ok('pgNewList: kosong = { ok:true, peers:[] }, argumen diabaikan, tidak ada berkas / objek baru');
    }

    // ---- 2. jalur sukses: garis dasar diam, menyala, daftar dan event, feed dibuka memadamkan ----
    V.store.friends[A.id] = { st: 'ok' };
    await mkPost(A, { text: 'lama' });
    await until(() => V._pgn && V._pgn.map.has(A.id), 4000, 'garis dasar');
    assert.deepStrictEqual(news(v), [], 'garis dasar diam');
    r = await v('pgNewList'); assert.deepStrictEqual(r, { ok: true, peers: [] }, 'garis dasar belum menyala');
    await mkPost(A, { text: 'baru' }); await lit('menyala');
    {
      r = await v('pgNewList'); assert.deepStrictEqual(r, { ok: true, peers: [A.id] });
      const e = news(v); assert.strictEqual(e.length, 1); assert.deepStrictEqual(e[0], { peerId: A.id, on: true });
      assert.deepStrictEqual(Object.keys(e[0]).sort(), ['on', 'peerId'], 'hanya dua bidang');
      const pl = await v('pgList', A.id); assert.strictEqual(pl.ok, true); assert.strictEqual(pl.items.length, 2);
      assert.deepStrictEqual(await v('pgNewList'), { ok: true, peers: [] }, 'feed dibuka lewat IPC memadamkan');
      const e2 = news(v); assert.strictEqual(e2.length, 2); assert.deepStrictEqual(e2[1], { peerId: A.id, on: false });
      await v('pgList', A.id); assert.strictEqual(news(v).length, 2, 'membuka lagi tanpa perubahan = tidak ada event');
      ok('pgNewList + event pgnew: menyala (peerId, on:true) lalu pgList tanpa kursor memadamkan (on:false), tanpa event ganda');
    }

    // ---- 3. daftar disaring: bukan teman / diblokir tidak keluar walau berkas masih memuatnya ----
    {
      await mkPost(A, { text: 'baru2' }); await lit('menyala lagi');
      assert.deepStrictEqual((await v('pgNewList')).peers, [A.id]);
      for (const a of [['zz'], [{ x: 1 }], [null, 5], [A.id], [{ quiet: true }]]) assert.deepStrictEqual(await v('pgNewList', ...a), { ok: true, peers: [A.id] }, 'argumen tidak mengubah daftar yang menyala: ' + JSON.stringify(a));
      const f0 = V.fstate.bind(V), b0 = V.isBlocked.bind(V);
      try {
        V.fstate = (id) => (id === A.id ? 'none' : f0(id));
        assert.deepStrictEqual(await v('pgNewList'), { ok: true, peers: [] }, 'bukan teman lagi (sebelum _pgnPrune) tidak bocor');
      } finally { V.fstate = f0; }
      try {
        V.isBlocked = (id) => (id === A.id ? true : b0(id));
        assert.deepStrictEqual(await v('pgNewList'), { ok: true, peers: [] }, 'diblokir tidak bocor');
      } finally { V.isBlocked = b0; }
      assert.deepStrictEqual((await v('pgNewList')).peers, [A.id], 'pulih bila kembali teman / tak diblokir');
      ok('pgNewList: pemilik yang bukan teman / diblokir disaring walau penyimpanan belum dibersihkan');
    }

    // ---- 4. event keluar: hanya dua bidang, cacat tidak disiarkan ----
    {
      v.sent.length = 0;
      V.emit('pgnew', { peer: A.id, on: false, secret: 'x', text: 'bocor', post: { id: 'p' } });
      assert.deepStrictEqual(news(v), [{ peerId: A.id, on: false }], 'bidang lain dibuang');
      v.sent.length = 0;
      const H = 'cccccccccccccccc';
      for (const bad of [null, undefined, 5, 'x', [], {}, { peer: A.id }, { on: true }, { peer: 'zz', on: true }, { peer: A.id.toUpperCase(), on: true }, { peer: 5, on: true }, { peer: A.id, on: 'true' }, { peer: A.id, on: 1 }, { peer: A.id, on: null }, { peer: H + '0', on: true }]) V.emit('pgnew', bad);
      assert.strictEqual(news(v).length, 0, 'event cacat tidak disiarkan: ' + JSON.stringify(news(v)));
      V.emit('pgnew', { peer: H, on: true }); assert.deepStrictEqual(news(v), [{ peerId: H, on: true }], 'id 16 heks apa pun yang sah diteruskan apa adanya (Core yang menjamin hanya teman)');
      ok('event pgnew: dua bidang (peerId, on), bidang lain dibuang, 15 bentuk cacat tidak disiarkan');
    }

    // ---- 5. renderer tidak bisa memakai quiet: pgList meneruskan hanya after / limit ----
    {
      await mkPost(A, { text: 'baru3' }); await lit('menyala untuk quiet');
      const calls = []; const real = V.pageList.bind(V); V.pageList = (id, o) => { calls.push(o); return real(id, o); };
      try {
        const r2 = await v('pgList', A.id, { quiet: true, limit: 2 }); assert.strictEqual(r2.ok, true);
        assert.deepStrictEqual(calls[0], { limit: 2 }, 'quiet dari renderer dibuang: ' + JSON.stringify(calls[0]));
        assert.strictEqual(V._pgn.has(A.id), false, 'feed dibuka tetap memadamkan lencana');
      } finally { V.pageList = real; }
      ok('pgList: opsi quiet dari renderer tidak sampai ke Core (lencana tetap padam saat feed dibuka)');
    }

    // ---- 6. galat Core dipetakan jadi { ok:false } ----
    {
      const real = V.pageNewList; V.pageNewList = () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); };
      try { r = await v('pgNewList'); assert.strictEqual(r.ok, false); assert.strictEqual(typeof r.err, 'string'); } finally { V.pageNewList = real; }
      V.pageNewList = () => ['zz', A.id, 5, null, A.id.toUpperCase()];
      try { r = await v('pgNewList'); assert.deepStrictEqual(r, { ok: true, peers: [A.id] }, 'filter kedua membuang id cacat'); } finally { V.pageNewList = real; }
      ok('pgNewList: galat Core = ok:false; id cacat dari Core tidak keluar');
    }

    // ---- 7. dispose dan Core tiruan ----
    {
      const n0 = V.listenerCount('pgnew'); assert(n0 >= 1);
      v.reg.dispose(); assert.strictEqual(V.listenerCount('pgnew'), n0 - 1, 'dispose melepas pendengar pgnew');
      v.sent.length = 0; V.emit('pgnew', { peer: A.id, on: true }); assert.strictEqual(news(v).length, 0, 'setelah dispose tidak ada event');
      const hs = {}; const p = registerPages({ ipcMain: { handle: (n, fn) => { hs[n] = fn; } }, core: { pageNewList: () => [A.id] }, toRenderer: () => {} }); // tanpa on / removeListener
      assert.deepStrictEqual(await hs.pgNewList({}), { ok: true, peers: [A.id] }); p.dispose();
      ok('dispose melepas pgnew; Core tiruan tanpa EventEmitter tetap bisa register');
    }

    // ---- 8. preload.js dan archne-api-http.js (5b-3b): pgNewList + onPgNew, dijalankan sungguhan dengan Electron / EventSource palsu ----
    {
      const vm = require('vm'), rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      // preload: invoke('pgNewList') TANPA argumen (argumen renderer tidak diteruskan), onPgNew mendengarkan 'pgnew' dan meneruskan muatan apa adanya
      const inv = [], ons = {}; let exposed = null;
      const electron = { contextBridge: { exposeInMainWorld: (n, o) => { exposed = o; } }, ipcRenderer: { invoke: (...a) => { inv.push(a); return Promise.resolve(null); }, on: (ch, fn) => { (ons[ch] = ons[ch] || []).push(fn); } } };
      vm.runInNewContext(rd('preload.js'), { require: (m) => { assert.strictEqual(m, 'electron'); return electron; }, process: { platform: 'win32', versions: {} }, console }, { filename: 'preload.js' });
      assert(exposed && typeof exposed.pgNewList === 'function' && typeof exposed.onPgNew === 'function', 'preload memuat pgNewList dan onPgNew');
      await exposed.pgNewList(A.id, { quiet: true }); assert.deepStrictEqual(inv.pop(), ['pgNewList'], 'preload: tanpa argumen');
      const got = []; exposed.onPgNew((p) => got.push(p)); assert.strictEqual(ons.pgnew.length, 1); ons.pgnew[0]({}, { peerId: A.id, on: true }); assert.deepStrictEqual(got, [{ peerId: A.id, on: true }]);
      // api-http: pgNewList lewat POST rpc/pgNewList, onPgNew lewat satu EventSource ('pgnew' didengar, dipasang sekali)
      const posts = [], es = [];
      const fetchFake = async (url, o) => { posts.push([url, o && o.body]); return { ok: true, status: 200, json: async () => ({ ok: true, peers: [A.id] }) }; };
      function ES(u) { this.url = u; this.l = {}; this.addEventListener = (k, f) => { this.l[k] = f; }; es.push(this); }
      const w = {}; vm.runInNewContext(rd('renderer/archne-api-http.js'), { window: w, fetch: fetchFake, location: { pathname: '/' }, document: {}, EventSource: ES, setTimeout, clearTimeout, console, encodeURIComponent, JSON, Promise, Array, Math, Date });
      assert(typeof w.api.pgNewList === 'function' && typeof w.api.onPgNew === 'function', 'api-http memuat pgNewList dan onPgNew');
      assert.deepStrictEqual(await w.api.pgNewList(), { ok: true, peers: [A.id] }); assert.strictEqual(posts.pop()[0], '/rpc/pgNewList');
      const got2 = [], got3 = []; w.api.onPgNew((p) => got2.push(p)); w.api.onPgNew((p) => got3.push(p)); assert.strictEqual(es.length, 1, 'satu EventSource untuk semua pendengar');
      assert.strictEqual(typeof es[0].l.pgnew, 'function', 'api-http mendengar event pgnew');
      es[0].l.pgnew({ data: JSON.stringify({ peerId: A.id, on: false }) }); assert.deepStrictEqual(got2, [{ peerId: A.id, on: false }]); assert.deepStrictEqual(got3, [{ peerId: A.id, on: false }], 'semua pendengar dapat');
      w.api.onPgNew(() => { throw new Error('rusak'); }); es[0].l.pgnew({ data: JSON.stringify({ peerId: A.id, on: true }) }); assert.strictEqual(got2.length, 2, 'pendengar yang melempar tidak menghentikan yang lain');
      ok('preload.js dan archne-api-http.js: pgNewList tanpa argumen, onPgNew meneruskan { peerId, on }, satu EventSource, pendengar rusak terisolasi');
    }

    console.log('\n' + pass + ' kelompok lulus');
  } finally { await V.stop(); await A.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

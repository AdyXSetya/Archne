'use strict';
// Tes Halaman 5b-2 fase 1 (+ penyesuaian 5b-2b: yang bukan teman lagi dilupakan): Core menanyai teman online (src/core/archne-pages-new.js). V = penonton, A dan C = pemilik halaman, N = peer yang bukan teman V.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { PGN_POLL } = require('../src/archne-pagenew');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagenewcore-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
let pass = 0;
const ok = (s) => { pass++; console.log('  OK  ' + s); };

(async () => {
  const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, tickMs: 100 });
  const V = mk('V'), A = mk('A'), C = mk('C'), N = mk('N');
  for (const c of [V, A, C, N]) await c.start();
  for (const o of [A, C, N]) await V.addPeer('127.0.0.1', o.port);
  await until(() => [A, C, N].every((o) => V.peers.has(o.id) && o.peers.has(V.id) && V.isOnline(V.peers.get(o.id))), 8000, 'saling kenal');
  const file = path.join(tmp, 'V', 'pgnew.json'), ev = []; V.on('pgnew', (e) => ev.push(e));
  const calls = [], lims = []; const real = V.pageList.bind(V); V.pageList = (id, o) => { calls.push(id); lims.push(o && o.limit); return real(id, o); };
  const mkPost = async (c, o) => { await sleep(5); return c.pageStore().create(o); };
  const force = (id) => { V._pgnStore().soon(id); };

  {
    // bukan teman: tidak ditanyai, tidak ada objek, tidak ada berkas
    await mkPost(A, { text: 'lama' }); await sleep(500);
    assert.strictEqual(calls.length, 0, 'bukan teman tidak ditanyai'); assert.strictEqual(V._pgn == null, true, 'penyimpanan malas'); assert.strictEqual(fs.existsSync(file), false);
    ok('malas: tanpa teman, tidak ada pertanyaan, objek, maupun berkas');
  }
  {
    // teman = garis dasar diam
    V.store.friends[A.id] = { st: 'ok' };
    await until(() => calls.includes(A.id), 4000, 'A ditanyai'); await until(() => fs.existsSync(file), 3000, 'berkas');
    assert.deepStrictEqual(ev, [], 'pengamatan pertama = garis dasar, tanpa event'); assert.strictEqual(V._pgn.has(A.id), false);
    assert.strictEqual(calls.includes(N.id), false, 'N bukan teman tidak ditanyai');
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).m), [A.id], 'hanya kursor teman tersimpan');
    assert(lims.length && lims.every((l) => l === 1), 'selalu limit 1: hanya postingan terbaru yang ditanyakan');
    ok('teman online ditanyai sekali; postingan lama = garis dasar diam, tanpa event; bukan teman tetap tidak ditanyai');
  }
  {
    // selang: tanpa soon(), tidak ditanyai lagi
    const n = calls.length; await sleep(600); assert.strictEqual(calls.length, n, 'selang ' + PGN_POLL + ' ms: tidak ditanya lagi');
    // postingan baru -> lencana + event
    const p = await mkPost(A, { text: 'baru' }); force(A.id);
    await until(() => ev.length === 1, 4000, 'event'); assert.deepStrictEqual(ev, [{ peer: A.id, on: true }]); assert.strictEqual(V._pgn.has(A.id), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).m[A.id].l[1], p.id);
    // observasi yang sama tidak mengulang event
    force(A.id); const m = calls.length; await until(() => calls.length > m, 4000, 'tanya lagi'); await sleep(200); assert.strictEqual(ev.length, 1, 'tanpa perubahan = tanpa event baru');
    ok('selang tanya dihormati; postingan baru menyalakan lencana + satu event; tanya ulang tanpa perubahan diam');
  }
  {
    // privasi: postingan Teman tidak terlihat bila A belum menganggap V teman
    V.store.friends[C.id] = { st: 'ok' }; await mkPost(C, { text: 'lama C' });
    await until(() => V._pgn.map.has(C.id), 4000, 'C garis dasar');
    await mkPost(C, { text: 'rahasia', priv: 'friends' }); force(C.id); const n = calls.length; await until(() => calls.length > n, 4000, 'tanya C');
    await sleep(200); assert.strictEqual(V._pgn.has(C.id), false, 'postingan Teman tak terlihat oleh yang bukan teman: tanpa lencana'); assert.strictEqual(ev.length, 1);
    C.store.friends[V.id] = { st: 'ok' }; force(C.id); await until(() => V._pgn.has(C.id), 4000, 'terlihat sesudah berteman');
    assert.deepStrictEqual(ev[1], { peer: C.id, on: true }, 'sesudah A menjadikan V teman, postingan Teman menyalakan lencana');
    ok('penyaring privasi pemilik berlaku per penonton: Teman tak menyalakan lencana bagi yang bukan teman, menyala sesudah berteman');
  }
  {
    // galat tidak menyalakan / mengubah apa pun; satu pertanyaan sekaligus; berhenti bila bukan teman lagi
    const before = JSON.stringify(V._pgn.map.get(A.id)), n0 = ev.length;
    V.pageList = async () => { throw Object.assign(new Error('x'), { code: 'offline' }); };
    force(A.id); await sleep(400); assert.strictEqual(JSON.stringify(V._pgn.map.get(A.id)), before, 'galat = tidak mengubah apa pun'); assert.strictEqual(ev.length, n0);
    let live = 0, peak = 0, started = 0;
    V.pageList = async () => { started++; live++; peak = Math.max(peak, live); await sleep(250); live--; return { items: [], next: null, count: 0, skipped: 0 }; };
    V._pgn.polled(A.id, 0); V._pgn.polled(C.id, 0); force(A.id); force(C.id); await sleep(900);
    assert.strictEqual(peak, 1, 'tidak pernah dua pertanyaan sekaligus'); assert(started >= 2, 'keduanya tetap giliran: ' + started);
    // bukan teman lagi selagi menunggu: jawaban dibuang
    V.pageList = async () => { await sleep(300); return { items: [{ ts: 9e12, id: 'f'.repeat(16) }], next: null, count: 1, skipped: 0 }; };
    force(A.id); await sleep(150); V.store.friends[A.id] = { st: '' }; await sleep(600);
    assert.strictEqual(V._pgn.map.has(A.id), false, 'bukan teman lagi (5b-2b): dilupakan, dan jawaban yang datang sesudahnya dibuang, bukan dicatat ulang');
    ok('galat tidak mengubah apa pun; satu pertanyaan sekaligus; jawaban untuk yang bukan teman lagi dibuang');
  }
  {
    // bertahan dan dibaca ulang dari berkas
    // jawaban kosong tadi (halaman kosong) memadamkan lencana C: itu benar. Pulihkan pageList asli; postingan C masih ada, jadi menyala lagi.
    assert.strictEqual(V._pgn.has(C.id), false, 'halaman kosong = lencana padam'); assert(ev.some((e) => e.peer === C.id && e.on === false), 'event padam membawa on:false'); V.pageList = real; V.store.friends[A.id] = { st: 'ok' };
    force(C.id); await until(() => V._pgn.has(C.id), 4000, 'C menyala lagi');
    const { PageNew } = require('../src/archne-pagenew'), re = new PageNew(file); assert.strictEqual(re.has(C.id), true, 'lencana bertahan di berkas'); assert.deepStrictEqual(re.list(), V._pgn.list());
    ok('halaman kosong memadamkan lencana, pulih sesudah terisi lagi; keadaan bertahan di pgnew.json dan terbaca ulang');
  }
  for (const c of [V, A, C, N]) await c.stop();
  console.log('\nTes pagenewcore: ' + pass + ' kelompok lulus.');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

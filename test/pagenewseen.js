'use strict';
// Tes Halaman 5b-2 fase 2: pembukaan feed menandai "sudah dilihat" (pageList tanpa kursor), pertanyaan latar belakang diam (quiet), dan pemilik yang bukan teman / diblokir dilupakan. V = penonton, A dan C = pemilik, N = bukan teman V.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagenewseen-'));
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
  const calls = []; const real = V.pageList.bind(V); V.pageList = (id, o) => { calls.push({ id, o }); return real(id, o); };
  const mkPost = async (c, o) => { await sleep(5); return c.pageStore().create(o); };
  const force = (id) => V._pgnStore().soon(id);
  const fileEntry = (id) => JSON.parse(fs.readFileSync(file, 'utf8')).m[id];
  const lit = async (id, label) => { force(id); await until(() => V._pgn && V._pgn.has(id), 4000, label); };

  V.store.friends[A.id] = { st: 'ok' }; V.store.friends[C.id] = { st: 'ok' };
  await mkPost(A, { text: 'lama' });
  await until(() => V._pgn && V._pgn.map.has(A.id), 4000, 'garis dasar A');
  {
    await mkPost(A, { text: 'baru1' }); await lit(A.id, 'A menyala');
    assert.deepStrictEqual(ev, [{ peer: A.id, on: true }]);
    assert(calls.length && calls.every((c) => c.o && c.o.quiet === true && c.o.limit === 1), 'semua pertanyaan latar belakang quiet + limit 1');
    const n = calls.length; force(A.id); await until(() => calls.length > n, 4000, 'tanya lagi'); await sleep(200);
    assert.strictEqual(V._pgn.has(A.id), true, 'pertanyaan quiet tidak menandai sudah dilihat'); assert.strictEqual(ev.length, 1);
    ok('pertanyaan latar belakang quiet: lencana tidak padam sendiri');
  }
  {
    const r = await V.pageList(A.id);
    assert.strictEqual(r.items.length, 2, 'feed asli tetap utuh'); assert.strictEqual(V._pgn.has(A.id), false);
    assert.deepStrictEqual(ev[1], { peer: A.id, on: false }); assert.deepStrictEqual(fileEntry(A.id).s, fileEntry(A.id).l, 'berkas: s = l');
    await V.pageList(A.id); assert.strictEqual(ev.length, 2, 'membuka lagi tanpa perubahan = diam');
    ok('membuka feed (tanpa kursor) memadamkan lencana + satu event on:false; membuka lagi diam');
  }
  {
    await mkPost(A, { text: 'baru2' }); await mkPost(A, { text: 'baru3' }); await lit(A.id, 'A menyala lagi');
    assert.deepStrictEqual(ev[2], { peer: A.id, on: true });
    const q = await V.pageList(A.id, { limit: 1, quiet: true }); assert(q.next, 'ada halaman berikutnya');
    await V.pageList(A.id, { after: q.next }); assert.strictEqual(V._pgn.has(A.id), true, 'halaman berkursor tidak menandai sudah dilihat'); assert.strictEqual(ev.length, 3);
    await V.pageList(A.id, { limit: 1 }); assert.strictEqual(V._pgn.has(A.id), false, 'halaman pertama (limit berapa pun) menandai'); assert.deepStrictEqual(ev[3], { peer: A.id, on: false });
    ok('hanya halaman pertama yang menandai: halaman berkursor dan quiet tidak');
  }
  {
    // feed dibuka SEBELUM jadwal tanya berikutnya, padahal ada postingan baru: yang baru saja dibaca tidak boleh menyalakan lencana sesudah tanya berikutnya
    const n = ev.length; await mkPost(A, { text: 'baru-sebelum-tanya' });
    const r = await V.pageList(A.id); assert(r.items.length >= 1, 'feed terbuka');
    const c = calls.length; force(A.id); await until(() => calls.length > c, 4000, 'tanya sesudah feed dibuka'); await sleep(250);
    assert.strictEqual(V._pgn.has(A.id), false, 'postingan yang baru dibaca tidak menyalakan lencana'); assert.strictEqual(ev.length, n, 'tanpa event');
    ok('feed dibuka sebelum tanya berikutnya: kursor terbaru ikut tercatat, tanya berikutnya diam');
  }
  {
    await mkPost(N, { text: 'dari N' }); const r = await V.pageList(N.id);
    assert.strictEqual(r.items.length, 1); assert.strictEqual(V._pgn.map.has(N.id), false, 'bukan teman: tidak dilacak'); assert.strictEqual(ev.length, 4);
    ok('membuka feed bukan teman tidak membuat entri maupun event');
  }
  {
    await mkPost(A, { text: 'baru4' }); await lit(A.id, 'A menyala (gagal tulis)'); const n = ev.length, w0 = V._pgn.write;
    V._pgn.write = () => { throw new Error('disk penuh'); };
    const r = await V.pageList(A.id); assert(r.items.length >= 1, 'feed tetap terbuka walau gagal tulis');
    assert.strictEqual(V._pgn.has(A.id), true, 'gagal tulis: memori dipulihkan, lencana tetap'); assert.strictEqual(ev.length, n, 'tanpa event palsu');
    V._pgn.write = w0; await V.pageList(A.id); assert.strictEqual(V._pgn.has(A.id), false); assert.deepStrictEqual(ev[ev.length - 1], { peer: A.id, on: false });
    ok('gagal tulis tidak merusak pembukaan feed dan tidak membuat event palsu; pulih sesudahnya');
  }
  {
    await mkPost(A, { text: 'baru5' }); await lit(A.id, 'A menyala (bukan teman)'); const n = ev.length;
    V.store.friends[A.id] = { st: '' }; await until(() => !V._pgn.map.has(A.id), 3000, 'A dilupakan');
    assert.deepStrictEqual(ev.slice(n), [{ peer: A.id, on: false }], 'lencana menyala dipadamkan dengan event'); assert.strictEqual(fileEntry(A.id), undefined, 'berkas ikut bersih');
    V.store.friends[A.id] = { st: 'ok' };
    await mkPost(C, { text: 'c1' }); force(C.id); await until(() => V._pgn.map.has(C.id), 4000, 'garis dasar C');
    await mkPost(C, { text: 'c2' }); await lit(C.id, 'C menyala'); const m = ev.length;
    V.store.blocked[C.id] = true; await until(() => !V._pgn.map.has(C.id), 3000, 'C dilupakan');
    assert.deepStrictEqual(ev.slice(m), [{ peer: C.id, on: false }], 'diblokir: padam + event'); delete V.store.blocked[C.id];
    const w = ev.length; await sleep(400); assert.strictEqual(ev.length, w, 'tanpa event berulang');
    ok('bukan teman lagi / diblokir: dilupakan, lencana menyala padam dengan satu event, berkas bersih');
  }
  for (const c of [V, A, C, N]) await c.stop();
  console.log('\nTes pagenewseen: ' + pass + ' kelompok lulus.');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

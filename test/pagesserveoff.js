'use strict';
// Tes Halaman 5a-1: pengaturan `pagesServe` (Core). Nonaktif = pemilik menjawab peminta persis seperti pemilik yang tidak punya halaman ("tidak ada"), tanpa petunjuk bahwa layanannya dimatikan;
// pemilik tetap memakai halamannya sendiri; berlaku seketika (tanpa cache); bertahan lewat restart; validasi setSettings. Jaringan sungguhan (soket lokal).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { cmtSign } = require('../src/archne-pagecmt');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagesserveoff-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); } throw new Error('timeout: ' + label); }
let pass = 0;
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const strip = (r) => { if (r) delete r.hi; return r; };
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

(async () => {
  const A = mk('A'), B = mk('B'), C = mk('C'), E = mk('E'); // A pemilik (halaman ada), B teman, C asing, E pemilik yang belum pernah memakai Halaman (pembanding "tidak ada")
  for (const n of [A, B, C, E]) await n.start();
  const ask = async (from, to, obj) => strip(await from._request(from.peers.get(to.id), from._pgSign(to.id, obj), 4000));
  for (const n of [B, C]) { await n.addPeer('127.0.0.1', A.port); await n.addPeer('127.0.0.1', E.port); }
  await until(() => [B, C].every((n) => n.peers.has(A.id) && A.peers.has(n.id) && n.peers.has(E.id) && E.peers.has(n.id)), 8000, 'peer saling kenal');
  A.store.friends[B.id] = { st: 'ok' }; E.store.friends[B.id] = { st: 'ok' };

  const file = path.join(tmp, 'g.png'); fs.writeFileSync(file, png);
  const ps = A.pageStore();
  const [m1] = await ps.addMedias([{ src: file }]);
  const pub = ps.create({ text: 'publik', media: [m1] }), frd = ps.create({ text: 'teman', priv: 'friends' });
  const EMPTY = { t: 'pg_list', ok: true, items: [], next: null, count: 0 };
  const cmt = (core, owner, post, text) => ({ t: 'pg_cmt', id: post, c: cmtSign(core.privKey, core.pub, owner, post, text) });
  const probe = async (from, to) => ({
    list: await ask(from, to, { t: 'pg_list' }),
    get: await ask(from, to, { t: 'pg_get', id: pub.id }),
    media: await ask(from, to, { t: 'pg_media', id: pub.id, mid: m1.id, off: 0, len: 1000 }),
    rx: await ask(from, to, { t: 'pg_rx', id: pub.id, e: '👍' }),
    cmt: await ask(from, to, cmt(from, to.id, pub.id, 'halo')),
    cml: await ask(from, to, { t: 'pg_cml', id: pub.id }),
  });

  // 1. bawaan = aktif: semuanya terlayani
  assert.deepStrictEqual({ serve: A.getSettings().pages.serve, def: A.getSettings().pages.def }, { serve: true, def: true });
  assert.strictEqual('pagesServe' in A._settings, false);
  {
    const r = await probe(B, A);
    assert.strictEqual(r.list.count, 2); assert.strictEqual(r.get.post.id, pub.id); assert(r.media.chunk && r.media.chunk.total === png.length);
    assert.strictEqual(r.rx.r.mine, '👍'); assert.strictEqual(r.cmt.r, 'added'); assert.strictEqual(r.cml.r.count, 1);
    ok('bawaan aktif: list / get / media / rx / cmt / cml terlayani');
  }
  await ask(B, A, { t: 'pg_rx', id: pub.id, e: '' });

  // 2. nonaktif: jawaban IDENTIK dengan pemilik tanpa halaman (E), untuk teman maupun asing; tidak ada yang tertulis
  const before = { rx: JSON.stringify(ps.withRx(B.id, ps.get(pub.id))), cm: ps.commentsFor(A.id, pub.id).length };
  assert.strictEqual(A.setSettings({ pagesServe: false }).ok, true);
  assert.deepStrictEqual({ serve: A.getSettings().pages.serve, def: A.getSettings().pages.def }, { serve: false, def: true });
  for (const who of [B, C]) {
    const a = await probe(who, A), e = await probe(who, E);
    assert.deepStrictEqual(a, e, 'sama persis dengan pemilik tanpa halaman');
    assert.deepStrictEqual(a.list, EMPTY); assert.deepStrictEqual(a.get, { t: 'pg_get', ok: true, post: null });
    assert.deepStrictEqual(a.media, { t: 'pg_media', ok: true, chunk: null }); assert.deepStrictEqual(a.rx, { t: 'pg_rx', ok: true, r: null });
    assert.deepStrictEqual(a.cml, { t: 'pg_cml', ok: true, r: null }); assert.deepStrictEqual(a.cmt, { t: 'pg_cmt', ok: true, r: null });
  }
  assert.strictEqual(ps.commentsFor(A.id, pub.id).length, before.cm, 'komentar baru tidak tertulis'); assert.strictEqual(JSON.stringify(ps.withRx(B.id, ps.get(pub.id))), before.rx, 'reaksi tidak berubah');
  ok('nonaktif: jawaban sama persis dengan pemilik tanpa halaman (teman dan asing); tidak ada reaksi / komentar yang tertulis');

  // 3. kesalahan bentuk dan tanda tangan tetap seperti biasa (tidak bergantung pada pengaturan, jadi tidak membocorkan apa pun)
  assert.deepStrictEqual(await ask(B, A, { t: 'pg_get', id: 'xyz' }), { t: 'pg_get', ok: false, err: 'bad' });
  assert.deepStrictEqual(await ask(B, A, { t: 'pg_list', after: 'x' }), { t: 'pg_list', ok: false, err: 'bad' });
  assert.deepStrictEqual(strip(await B._request(B.peers.get(A.id), { t: 'pg_list', ts: Date.now(), n: 'aa', sig: 'bb' }, 4000)), { t: 'pg_list', ok: false, err: 'auth' });
  ok("'bad' dan 'auth' tidak berubah saat nonaktif");

  // 4. pemilik tetap memakai halamannya sendiri; hello masih mengumumkan 'pg' (tidak membocorkan); sisi peminta tidak berubah
  assert.strictEqual(ps.list().items.length, 2); assert.strictEqual(ps.get(frd.id).text, 'teman');
  assert.strictEqual((await A.pageReact(A.id, pub.id, '❤️')).mine, '❤️');
  const st = await A.pageComment(A.id, pub.id, 'komentar sendiri'); assert.strictEqual(st.st, 'added');
  assert((await A.pageComments(A.id, pub.id)).count >= 1);
  const tok = await A.pageMedia(A.id, pub.id, m1.id); assert(tok && tok.total === png.length);
  assert(A.hello().caps.includes('pg')); assert.strictEqual(B.pageAvail(A.id).ok, true);
  assert.strictEqual(A.pageAvail(B.id).ok, true, 'A masih bisa membuka halaman B (yang mati hanya LAYANAN)');
  ok('pemilik tetap bisa membaca / bereaksi / berkomentar / memutar media sendiri; caps pg tetap diumumkan');

  // 5. berlaku seketika dua arah (tanpa cache), lalu aktif lagi
  assert.strictEqual(A.setSettings({ pagesServe: true }).ok, true);
  assert.strictEqual('pagesServe' in A._settings, false, 'bawaan = kunci dibuang');
  assert.strictEqual((await ask(B, A, { t: 'pg_list' })).count, 2);
  A.setSettings({ pagesServe: false }); assert.deepStrictEqual(await ask(B, A, { t: 'pg_list' }), EMPTY);
  A.setSettings({ pagesServe: null }); assert.strictEqual((await ask(B, A, { t: 'pg_list' })).count, 2);
  A.setSettings({ pagesServe: false }); A.setSettings({ pagesServe: 'default' }); assert.strictEqual(A.getSettings().pages.serve, true);
  ok('berlaku seketika; true / null / default = kembali ke bawaan');

  // 6. validasi: semua atau tidak sama sekali
  for (const v of ['off', 0, 1, 'unlimited', {}, [], 'false']) assert.deepStrictEqual(A.setSettings({ pagesServe: v }), { ok: false, code: 'bad', key: 'pagesServe' }, JSON.stringify(v));
  assert.deepStrictEqual(A.setSettings({ pagesServe: false, cust: 1 }).code, 'min');
  assert.strictEqual(A.getSettings().pages.serve, true, 'patch gagal tidak menerapkan sebagian');
  ok('validasi: hanya boolean / null / default; patch gagal tidak menerapkan sebagian');

  // 7. bertahan lewat restart; berkas diedit tangan; nilai tidak sah dibuang
  A.setSettings({ pagesServe: false });
  const f = path.join(A.opts.dataDir, 'settings.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).pagesServe, false);
  await A.stop();
  const A2 = new Core({ dataDir: A.opts.dataDir, name: 'A', discovery: false }); await A2.start();
  assert.strictEqual(A2.getSettings().pages.serve, false); assert.strictEqual(A2._pgServePs(), null);
  await A2.stop();
  for (const bad of ['off', 0, null, 'false']) {
    fs.writeFileSync(f, JSON.stringify({ v: 1, pagesServe: bad }));
    const A3 = new Core({ dataDir: A.opts.dataDir, name: 'A', discovery: false }); A3._loadSettings();
    assert.strictEqual(A3.getSettings().pages.serve, true, 'nilai sampah = bawaan: ' + JSON.stringify(bad));
  }
  ok('settings.json: false bertahan lewat restart; nilai tidak sah dibuang (bawaan aktif)');

  // 8. pemilik yang belum pernah memakai Halaman tidak membuat folder, aktif atau nonaktif
  assert.strictEqual(fs.existsSync(path.join(E.opts.dataDir, 'pages')), false);
  E.setSettings({ pagesServe: false }); await probe(C, E);
  assert.strictEqual(fs.existsSync(path.join(E.opts.dataDir, 'pages')), false, 'tidak ada folder halaman dibuat');
  ok('tanpa halaman: tidak ada folder yang dibuat');

  for (const n of [B, C, E]) await n.stop();
  console.log('\n' + pass + ' pemeriksaan lulus');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

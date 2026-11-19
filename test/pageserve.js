'use strict';
// Tes Halaman 1c-2: sisi PEMILIK melayani pg_list / pg_get lewat jaringan sungguhan (soket lokal). Tes memakai core._request langsung; sejak 1c-3b permintaan harus ditandatangani (from._pgSign). Pemalsuan / putar ulang diuji di pagesign.js.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pageserve-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); } throw new Error('timeout: ' + label); }
let pass = 0;
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const strip = (r) => { if (r) delete r.hi; return r; };
const EMPTY = { t: 'pg_list', ok: true, items: [], next: null, count: 0 };

(async () => {
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D'), E = mk('E'); // A pemilik, B teman, C orang asing, D diblokir, E pemilik yang belum pernah memakai Halaman
  const all = [A, B, C, D, E];
  for (const n of all) await n.start();
  const ask = async (from, to, obj) => strip(await from._request(from.peers.get(to.id), from._pgSign(to.id, obj), 4000));
  for (const n of [B, C, D]) await n.addPeer('127.0.0.1', A.port);
  await E.addPeer('127.0.0.1', C.port);
  await until(() => [B, C, D].every((n) => n.peers.has(A.id)) && [B, C, D].every((n) => A.peers.has(n.id)) && C.peers.has(E.id) && E.peers.has(C.id), 8000, 'peer saling kenal');

  const ps = A.pageStore();
  const pub1 = ps.create({ text: 'publik satu' }), frd = ps.create({ text: 'khusus teman', priv: 'friends' }), pub2 = ps.create({ text: 'publik dua' });
  A.store.friends[B.id] = { st: 'ok' };
  A.store.blocked[D.id] = 1;

  // 1. hello mengumumkan kemampuan 'pg'; peer mencatatnya
  assert(A.hello().caps.includes('pg'));
  assert(B.peers.get(A.id).caps.includes('pg'), 'peer mencatat caps pg');
  ok("hello membawa caps 'pg' dan peer mencatatnya");

  // 2. pg_list lewat jaringan: orang asing hanya Publik, teman semuanya; count ikut disaring
  {
    const rc = await ask(C, A, { t: 'pg_list' }), rb = await ask(B, A, { t: 'pg_list' });
    assert.strictEqual(rc.ok, true);
    assert.deepStrictEqual(rc.items.map((p) => p.id), [pub2.id, pub1.id]); assert.strictEqual(rc.count, 2); assert.strictEqual(rc.next, null);
    assert.deepStrictEqual(rb.items.map((p) => p.id), [pub2.id, frd.id, pub1.id]); assert.strictEqual(rb.count, 3);
    assert.deepStrictEqual(rb.items[1], frd, 'isi postingan utuh apa adanya');
    assert(!JSON.stringify(rc).includes('khusus teman'), 'postingan Teman tidak bocor ke orang asing');
    ok('pg_list: asing = Publik saja, teman = semua; count ikut disaring; tidak ada bocoran');
  }

  // 3. paging dengan kursor (limit 1) menyusuri semua tanpa celah/ganda; pemilik sendiri (bukan lewat jaringan) tetap lewat list()
  {
    const seen = []; let after;
    for (let i = 0; i < 10; i++) {
      const r = await ask(B, A, { t: 'pg_list', limit: 1, after });
      assert.strictEqual(r.items.length, 1); seen.push(r.items[0].id);
      if (!r.next) break; after = r.next;
    }
    assert.deepStrictEqual(seen, [pub2.id, frd.id, pub1.id]);
    ok('kursor: limit 1 menyusuri tiga postingan berurutan, next null di akhir');
  }

  // 4. pg_get: Publik terbuka, Teman hanya untuk teman, id tak dikenal = sama dengan "bukan untukmu"
  {
    assert.deepStrictEqual((await ask(C, A, { t: 'pg_get', id: pub1.id })), { t: 'pg_get', ok: true, post: pub1 });
    const hidden = await ask(C, A, { t: 'pg_get', id: frd.id }), none = await ask(C, A, { t: 'pg_get', id: 'f'.repeat(16) });
    assert.deepStrictEqual(hidden, { t: 'pg_get', ok: true, post: null }); assert.deepStrictEqual(hidden, none, 'postingan Teman tak bisa dibedakan dari yang tidak ada');
    assert.deepStrictEqual((await ask(B, A, { t: 'pg_get', id: frd.id })).post, frd);
    ok('pg_get: Publik terbuka; Teman hanya teman; "bukan untukmu" = "tidak ada"');
  }

  // 5. diblokir: jawaban KOSONG yang persis sama dengan pemilik yang tak punya halaman; pg_get null; kursor salah pun diperlakukan sama seperti peminta lain
  {
    const blocked = await ask(D, A, { t: 'pg_list' }), nobody = await ask(C, E, { t: 'pg_list' });
    assert.deepStrictEqual(blocked, EMPTY); assert.deepStrictEqual(blocked, nobody, 'diblokir tak bisa dibedakan dari pemilik tanpa halaman');
    assert.deepStrictEqual(await ask(D, A, { t: 'pg_get', id: pub1.id }), { t: 'pg_get', ok: true, post: null });
    const badB = await ask(D, A, { t: 'pg_list', after: 'xx' }), badC = await ask(C, A, { t: 'pg_list', after: 'xx' });
    assert.deepStrictEqual(badB, badC); assert.strictEqual(badB.ok, false);
    ok('diblokir: balasan kosong identik dengan "tak ada halaman"; kursor salah dijawab sama seperti peminta lain');
  }

  // 6. relasi berubah seketika di sisi pemilik (blokir, putus teman) tanpa cache
  {
    assert.strictEqual((await ask(B, A, { t: 'pg_list' })).count, 3);
    A.store.blocked[B.id] = 1;
    assert.deepStrictEqual(await ask(B, A, { t: 'pg_list' }), EMPTY, 'blokir mengalahkan teman, seketika');
    delete A.store.blocked[B.id]; delete A.store.friends[B.id];
    assert.strictEqual((await ask(B, A, { t: 'pg_list' })).count, 2, 'putus teman: kembali jadi Publik saja');
    A.store.friends[B.id] = { st: 'ok' };
    assert.strictEqual((await ask(B, A, { t: 'pg_list' })).count, 3);
    ok('blokir dan putus teman berlaku seketika');
  }

  // 7. salah bentuk: ditolak 'bad' untuk semua; limit yang bukan bilangan bulat diabaikan; tanpa identitas = kosong
  {
    for (const o of [{ t: 'pg_list', after: 'abc' }, { t: 'pg_list', after: 5 }, { t: 'pg_get' }, { t: 'pg_get', id: '../../x' }, { t: 'pg_get', id: 5 }]) {
      const r = await ask(C, A, o); assert.deepStrictEqual(r, { t: o.t, ok: false, err: 'bad' }, JSON.stringify(o));
    }
    assert.strictEqual((await ask(C, A, { t: 'pg_list', limit: 'banyak' })).items.length, 2);
    assert.deepStrictEqual(A._pgHandle({ t: 'pg_list' }, null), EMPTY, 'tanpa identitas');
    assert.deepStrictEqual(strip(A._handle({ t: 'pg_list' }, '127.0.0.1')), { t: 'pg_list', ok: false, err: 'auth' }, 'tanpa hello / tanda tangan: ditolak (1c-3b)');
    ok('salah bentuk ditolak seragam; limit aneh diabaikan; tanpa identitas = kosong; tanpa tanda tangan = auth');
  }

  // 8. malas: pertanyaan orang asing tidak membuat folder halaman di pemilik yang belum memakainya
  {
    assert(!fs.existsSync(path.join(tmp, 'E', 'pages')));
    await ask(C, E, { t: 'pg_list' }); await ask(C, E, { t: 'pg_get', id: pub1.id });
    assert(!fs.existsSync(path.join(tmp, 'E', 'pages')), 'tidak ada folder baru');
    assert.strictEqual(E._pages, null);
    ok('pemilik yang belum memakai Halaman: tidak membuat folder karena ada yang bertanya');
  }

  // 9. teks sangat panjang: pratinjau di daftar (trunc), utuh di pg_get; jawaban daftar dibatasi byte dan kursornya menyusuri semuanya
  {
    const F = mk('F'); await F.start(); await F.addPeer('127.0.0.1', C.port); await C.addPeer('127.0.0.1', F.port);
    await until(() => C.peers.has(F.id) && F.peers.has(C.id), 8000, 'F-C');
    const fs2 = F.pageStore(), ids = [];
    const long = 'a'.repeat(100000);
    for (let i = 10; i < 70; i++) ids.push(fs2.create({ text: String(i) + long }).id); // 60 x 100k = 6 MB bila dikirim utuh; pratinjau 60 x 20k > 1 MB
    ids.reverse(); // terbaru dulu
    const r1 = await ask(C, F, { t: 'pg_list', limit: 50 });
    const bytes = Buffer.byteLength(JSON.stringify(r1));
    assert(bytes < 1.2e6, 'jawaban daftar dibatasi byte: ' + bytes);
    assert(r1.items.length < 50 && r1.next, 'halaman dipendekkan, kursor menunjuk sisanya');
    assert(r1.items.every((p) => p.text.length === 20000 && p.trunc === 100002), 'pratinjau 20000 karakter + panjang asli di trunc');
    const got = []; let after;
    for (let i = 0; i < 100; i++) { const r = await ask(C, F, { t: 'pg_list', limit: 50, after }); for (const p of r.items) got.push(p.id); if (!r.next) break; after = r.next; }
    assert.deepStrictEqual(got, ids, 'semua terambil berurutan, tanpa celah / ganda');
    const full = await ask(C, F, { t: 'pg_get', id: ids[0] });
    assert.strictEqual(full.post.text.length, 100002); assert.strictEqual(full.post.trunc, undefined, 'pg_get utuh tanpa trunc');
    const huge = fs2.create({ text: 'b'.repeat(1700000) });
    const rg = await ask(C, F, { t: 'pg_get', id: huge.id });
    assert.strictEqual(rg.post.text.length, 1500000); assert.strictEqual(rg.post.trunc, 1700000);
    // pemotongan tidak memutus pasangan surrogate
    const emo = fs2.create({ text: 'x'.repeat(19999) + '😀' + 'y'.repeat(50) });
    const re = await ask(C, F, { t: 'pg_get', id: emo.id }), rl = await ask(C, F, { t: 'pg_list', limit: 1 });
    assert.strictEqual(re.post.text.length, 19999 + 2 + 50, 'utuh di pg_get (di bawah batasnya)');
    const pv = rl.items[0];
    assert(pv.id === emo.id && pv.text.length === 19999 && pv.trunc === 20051, 'dipotong sebelum separuh pasangan surrogate');
    await F.stop();
    ok('teks panjang: pratinjau + trunc di daftar, utuh di pg_get, jawaban dibatasi byte, kursor memadai, surrogate aman');
  }

  // 8. media (2a-4): metadata gambar ikut di pg_list / pg_get, isi gambar tidak; privasi postingan berlaku juga untuk metadatanya
  {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
    const src = path.join(tmp, 'm.png'); fs.writeFileSync(src, png);
    const m1 = ps.addMedia(src), m2 = ps.addMedia(src);
    const pubM = ps.create({ text: 'publik bergambar', media: [m1] }), frdM = ps.create({ text: 'teman bergambar', priv: 'friends', media: [m2] });
    const rc = await ask(C, A, { t: 'pg_list' }), rb = await ask(B, A, { t: 'pg_list' });
    assert.deepStrictEqual(rc.items.find((p) => p.id === pubM.id).media, [m1], 'metadata media ikut di daftar');
    assert(!rc.items.some((p) => p.id === frdM.id) && !JSON.stringify(rc).includes(m2.id), 'media postingan Teman tidak bocor ke orang asing');
    assert.deepStrictEqual(rb.items.find((p) => p.id === frdM.id).media, [m2], 'teman melihat metadata media Teman');
    assert(JSON.stringify(rc.items.find((p) => p.id === pubM.id)).length < 600, 'hanya metadata, bukan isi gambar');
    assert.deepStrictEqual((await ask(C, A, { t: 'pg_get', id: pubM.id })).post.media, [m1], 'pg_get membawa media');
    assert.strictEqual((await ask(C, A, { t: 'pg_get', id: frdM.id })).post, null, 'pg_get postingan Teman bergambar = null untuk orang asing');
    assert.deepStrictEqual((await C.pagePost(A.id, pubM.id)).media, [m1], 'sisi peminta (wirePost) meneruskan media');
    ok('media: metadata ikut di pg_list/pg_get dan lolos wirePost; tanpa isi gambar; privasi Teman berlaku');
  }

  // 9. thumbnail (2b-2): th ikut di pg_list / pg_get dan lolos wirePost; th rusak ditolak sisi peminta
  {
    const jpg = (w, h) => { const b = Buffer.alloc(24); Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]).copy(b); return b.toString('base64'); };
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
    const src = path.join(tmp, 'th.png'); fs.writeFileSync(src, png);
    const th = jpg(160, 120), mt = ps.addMedia(src, th), pT = ps.create({ text: 'dengan thumbnail', media: [mt] });
    assert.strictEqual(mt.th, th);
    assert.strictEqual((await ask(C, A, { t: 'pg_list' })).items.find((p) => p.id === pT.id).media[0].th, th, 'th ikut di daftar');
    assert.strictEqual((await ask(C, A, { t: 'pg_get', id: pT.id })).post.media[0].th, th, 'th ikut di pg_get');
    assert.strictEqual((await C.pagePost(A.id, pT.id)).media[0].th, th, 'sisi peminta meneruskan th');
    assert.strictEqual(require('../src/archne-pagestore').wirePost({ v: 1, id: pT.id, ts: pT.ts, kind: 'text', text: 'x', priv: 'public', media: [Object.assign({}, mt, { th: jpg(900, 900) })] }), null, 'th terlalu besar membuat postingan ditolak di sisi peminta');
    ok('thumbnail: th ikut di pg_list/pg_get dan lolos wirePost; th cacat dari jaringan ditolak');
  }

  // 10. banyak gambar (2c): urutan + privasi lewat jaringan, dan ukuran balasan tetap terjaga walau thumbnail banyak
  {
    const jpg = (w, h, size = 24) => { const b = Buffer.alloc(size); Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]).copy(b); return b.toString('base64'); };
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
    const src = path.join(tmp, 'banyak.png'); fs.writeFileSync(src, png);
    const trio = () => [ps.addMedia(src, jpg(100, 80)), ps.addMedia(src), ps.addMedia(src, jpg(60, 90))];
    const t1 = trio(), t2 = trio();
    const pubX = ps.create({ text: 'publik tiga gambar', media: t1 }), frdX = ps.create({ text: 'teman tiga gambar', priv: 'friends', media: t2 });
    const rc = await ask(C, A, { t: 'pg_list' }), rb = await ask(B, A, { t: 'pg_list' });
    assert.deepStrictEqual(rc.items.find((p) => p.id === pubX.id).media, t1, 'ketiga gambar ikut, urutan terjaga');
    assert(!rc.items.some((p) => p.id === frdX.id) && t2.every((m) => !JSON.stringify(rc).includes(m.id)), 'tidak satu pun id media postingan Teman bocor ke orang asing');
    assert.deepStrictEqual(rb.items.find((p) => p.id === frdX.id).media, t2, 'teman melihat ketiganya');
    assert.deepStrictEqual((await ask(C, A, { t: 'pg_get', id: pubX.id })).post.media, t1, 'pg_get membawa ketiganya');
    assert.strictEqual((await ask(C, A, { t: 'pg_get', id: frdX.id })).post, null);
    assert.deepStrictEqual((await C.pagePost(A.id, pubX.id)).media, t1, 'sisi peminta meneruskan ketiganya');
    // ukuran: 20 postingan x 10 gambar x thumbnail ~6900 karakter (mendekati batas 7000) = ~1,4 MB, lebih dari PG_LIST_BYTES (1 MB)
    const big = jpg(320, 240, 5184); assert(big.length <= 7000 && big.length > 6800);
    const mine = [];
    for (let i = 0; i < 20; i++) mine.push(ps.create({ text: 'berat ' + i, media: Array.from({ length: 10 }, () => ps.addMedia(src, big)) }));
    const r1 = await ask(C, A, { t: 'pg_list', limit: 50 });
    const bytes = Buffer.byteLength(JSON.stringify(r1.items));
    assert(r1.items.length < 20 + 3 && r1.next, 'halaman dipendekkan, next menunjuk lanjutannya');
    assert(bytes <= 1e6 + 110000, 'balasan tidak melewati batas + satu postingan: ' + bytes);
    const last = r1.items[r1.items.length - 1]; assert.strictEqual(r1.next, last.ts + ':' + last.id, 'next = postingan terakhir yang ikut');
    // lewat sisi peminta (wireList) sampai habis: semua postingan Publik datang tepat sekali, urut, tanpa hilang
    const seen = []; let after;
    for (let k = 0; k < 20; k++) { const pg = await C.pageList(A.id, { limit: 50, after }); seen.push(...pg.items.map((p) => p.id)); assert.strictEqual(pg.skipped, 0); if (!pg.next) break; after = pg.next; }
    const want = ps.idx.filter((e) => e.priv === 'public').map((e) => e.id);
    assert.deepStrictEqual(seen, want, 'semua postingan publik datang tepat sekali dan berurutan walau halaman dipotong');
    ok('banyak gambar: urutan dan privasi Teman terjaga; 20x10 thumbnail terpotong di batas byte tanpa kehilangan postingan');
  }

  // 11. potongan gambar (2d-2): pg_media lewat jaringan, privasi, salah bentuk, tanda tangan menutup off/len/mid, penampung nonce dan laju terpisah
  {
    const { MEDIA_CHUNK } = require('../src/archne-pagestore');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
    const big = Buffer.concat([png, Buffer.alloc(MEDIA_CHUNK + 777, 9)]); // 2 potongan
    const fb = path.join(tmp, 'media-besar.png'); fs.writeFileSync(fb, big);
    const mB = ps.addMedia(fb), mF = ps.addMedia(fb);
    const pubB = ps.create({ text: 'publik besar', media: [mB] }), frdB = ps.create({ text: 'teman besar', priv: 'friends', media: [mF] });
    const get = (who, post, m, off, len) => ask(who, A, { t: 'pg_media', id: post.id, mid: m.id, off, len });
    const NONE = { t: 'pg_media', ok: true, chunk: null };
    assert(A.hello().caps.includes('pgm') && C.peers.get(A.id).caps.includes('pgm'), "caps 'pgm' diumumkan dan dicatat");

    // a. orang asing dan teman merakit gambar utuh potongan demi potongan
    for (const who of [C, B]) {
      const parts = []; let off = 0;
      while (off < big.length) {
        const r = await get(who, pubB, mB, off, 1e9);
        assert.strictEqual(r.ok, true); assert(r.chunk && r.chunk.off === off && r.chunk.total === big.length && r.chunk.mime === 'image/png');
        const b = Buffer.from(r.chunk.b64, 'base64'); assert(b.length > 0 && b.length <= MEDIA_CHUNK); parts.push(b); off += b.length;
      }
      assert.strictEqual(parts.length, 2); assert(Buffer.concat(parts).equals(big), 'rakitan identik');
    }
    // b. privasi: postingan Teman hanya untuk teman; asing, diblokir, id tak ada, media postingan lain = jawaban SAMA (null)
    assert(((await get(B, frdB, mF, 0, 10)).chunk || {}).total === big.length, 'teman boleh');
    for (const [who, post, m] of [[C, frdB, mF], [D, pubB, mB], [C, pubB, mF], [C, { id: 'bbbbbbbbbbbbbbbb' }, mB]]) assert.deepStrictEqual(await get(who, post, m, 0, 10), NONE);
    assert.deepStrictEqual(await get(C, pubB, mB, big.length, 10), NONE, 'off di luar berkas');
    assert(!JSON.stringify(await get(C, frdB, mF, 0, 10)).includes(mF.id), 'tidak ada bocoran id');
    // c. salah bentuk ditolak 'bad' sebelum relasi dilihat
    for (const o of [{ mid: 'x' }, { mid: mB.id, off: -1, len: 5 }, { mid: mB.id, off: 1.5, len: 5 }, { mid: mB.id, off: '0', len: 5 }, { mid: mB.id, off: 0, len: 0 }, { mid: mB.id, off: 0 }, { mid: '../x', off: 0, len: 5 }]) assert.deepStrictEqual(await ask(C, A, Object.assign({ t: 'pg_media', id: pubB.id }, o)), { t: 'pg_media', ok: false, err: 'bad' }, JSON.stringify(o));
    assert.deepStrictEqual(await ask(C, A, { t: 'pg_media', mid: mB.id, off: 0, len: 5 }), { t: 'pg_media', ok: false, err: 'bad' }, 'tanpa id postingan');
    // d. tanda tangan menutup mid/off/len: mengubah salah satunya sesudah ditandatangani = auth
    for (const mut of [{ off: 1 }, { len: 99 }, { mid: mF.id }]) {
      const signed = C._pgSign(A.id, { t: 'pg_media', id: pubB.id, mid: mB.id, off: 0, len: 10 }), r = strip(await C._request(C.peers.get(A.id), Object.assign({}, signed, mut), 4000));
      assert.deepStrictEqual(r, { t: 'pg_media', ok: false, err: 'auth' }, 'diubah: ' + Object.keys(mut));
    }
    { const signed = C._pgSign(A.id, { t: 'pg_media', id: pubB.id, mid: mB.id, off: 0, len: 10 }); assert.strictEqual(strip(await C._request(C.peers.get(A.id), signed, 4000)).ok, true); assert.strictEqual(strip(await C._request(C.peers.get(A.id), signed, 4000)).err, 'auth', 'putar ulang ditolak'); }
    // e. pemilik yang belum memakai Halaman: tidak membuat folder
    await ask(C, E, { t: 'pg_media', id: pubB.id, mid: mB.id, off: 0, len: 10 });
    assert(!fs.existsSync(path.join(tmp, 'E', 'pages')) && E._pages === null, 'tidak ada folder baru');
    // f. penampung nonce pg_media terpisah: pg_list/pg_get yang penuh tidak menutup pg_media, dan sebaliknya
    {
      const far = Date.now() + 1e9, saved = A._pgSeen; A._pgSeen = new Map(); for (let i = 0; i < 20000; i++) A._pgSeen.set('x' + i, far);
      assert.deepStrictEqual(await ask(C, A, { t: 'pg_list' }), { t: 'pg_list', ok: false, err: 'busy' }, 'pg_list penuh = busy');
      assert.strictEqual((await get(C, pubB, mB, 0, 10)).ok, true, 'pg_media tetap jalan');
      A._pgSeen = saved;
      const savedM = A._pgSeenM; A._pgSeenM = new Map(); for (let i = 0; i < 100000; i++) A._pgSeenM.set('x' + i, far);
      assert.deepStrictEqual(await get(C, pubB, mB, 0, 10), { t: 'pg_media', ok: false, err: 'busy' }, 'pg_media penuh = busy');
      assert.strictEqual((await ask(C, A, { t: 'pg_list' })).ok, true, 'pg_list tetap jalan');
      A._pgSeenM = savedM;
    }
    // g. pembatas laju per peer: 48 per jendela, peer lain tidak terpengaruh, jendela baru memulihkan
    {
      A._pgMediaRate = new Map();
      let okN = 0; for (let i = 0; i < 60; i++) if (A._pgMediaOk(B.id)) okN++;
      assert.strictEqual(okN, 48, '48 potongan per jendela'); assert(A._pgMediaOk(C.id), 'peer lain punya jatah sendiri');
      A._pgMediaRate.get(B.id).t0 -= 1500; assert(A._pgMediaOk(B.id), 'jendela baru');
      A._pgMediaRate = new Map(); for (let i = 0; i < 49; i++) A._pgMediaOk(C.id);
      assert.deepStrictEqual(await get(C, pubB, mB, 0, 10), { t: 'pg_media', ok: false, err: 'busy' }, 'lewat jatah = busy lewat jaringan');
      assert.strictEqual((await get(B, pubB, mB, 0, 10)).ok, true, 'B tidak ikut kena');
      A._pgMediaRate = new Map();
    }
    ok('pg_media: potongan identik lewat jaringan; privasi seragam; salah bentuk; tanda tangan menutup mid/off/len; folder malas; nonce dan laju terpisah');
  }

  // 12. lampiran lewat pg_media (3a-4): id berkas dilayani dengan jalur, privasi, penandatanganan, dan laju yang sama; chunk tanpa mime
  {
    const { FILE_CHUNK } = require('../src/archne-pagestore');
    const bin = require('crypto').randomBytes(FILE_CHUNK + 555), fa = path.join(tmp, 'lampiran.bin'); fs.writeFileSync(fa, bin);
    const pf = path.join(tmp, 'g12.png'); fs.writeFileSync(pf, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex'));
    const [fPub, fFrd] = await ps.addFiles([{ src: fa }, { src: fa }]), [gImg] = [ps.addMedia(pf)];
    const pubF = ps.create({ text: 'publik berlampiran', files: [fPub], media: [gImg] }), frdF = ps.create({ text: 'teman berlampiran', priv: 'friends', files: [fFrd] });
    const get = (who, post, m, off, len) => ask(who, A, { t: 'pg_media', id: post.id, mid: m.id, off, len });
    const NONE = { t: 'pg_media', ok: true, chunk: null };

    // a. asing dan teman merakit lampiran utuh; chunk membawa total/off/b64 TANPA mime; pg_get/pg_list ikut membawa metadata files
    for (const who of [C, B]) {
      const parts = []; let off = 0;
      while (off < bin.length) {
        const r = await get(who, pubF, fPub, off, 1e9);
        assert.strictEqual(r.ok, true); assert.deepStrictEqual(Object.keys(r.chunk).sort(), ['b64', 'off', 'total'], 'tanpa mime'); assert(r.chunk.off === off && r.chunk.total === bin.length);
        const b = Buffer.from(r.chunk.b64, 'base64'); assert(b.length > 0 && b.length <= FILE_CHUNK); parts.push(b); off += b.length;
      }
      assert.strictEqual(parts.length, 2); assert(Buffer.concat(parts).equals(bin), 'rakitan identik');
    }
    assert.deepStrictEqual((await ask(C, A, { t: 'pg_get', id: pubF.id })).post.files, [fPub], 'pg_get membawa metadata lampiran');
    assert.deepStrictEqual((await ask(C, A, { t: 'pg_list' })).items.find((p) => p.id === pubF.id).files, [fPub], 'pg_list juga');
    // b. gambar di postingan yang sama tetap dilayani dengan mime (jalur lama tidak terganggu)
    assert.strictEqual(((await get(C, pubF, gImg, 0, 1e9)).chunk || {}).mime, 'image/png');
    // c. privasi seragam: asing/diblokir/id tak ada/lampiran postingan lain = jawaban SAMA (null)
    assert(((await get(B, frdF, fFrd, 0, 10)).chunk || {}).total === bin.length, 'teman boleh');
    for (const [who, post, m] of [[C, frdF, fFrd], [D, pubF, fPub], [C, pubF, fFrd], [C, { id: 'bbbbbbbbbbbbbbbb' }, fPub]]) assert.deepStrictEqual(await get(who, post, m, 0, 10), NONE);
    assert.deepStrictEqual(await get(C, pubF, fPub, bin.length, 10), NONE, 'off di luar berkas');
    assert(!JSON.stringify(await get(C, frdF, fFrd, 0, 10)).includes(Buffer.from(bin.subarray(0, 6)).toString('base64').slice(0, 6)), 'tak ada byte bocor');
    // d. tanda tangan menutup mid: lampiran tidak bisa diganti di jalan
    {
      const signed = C._pgSign(A.id, { t: 'pg_media', id: pubF.id, mid: fPub.id, off: 0, len: 10 });
      assert.deepStrictEqual(strip(await C._request(C.peers.get(A.id), Object.assign({}, signed, { mid: fFrd.id }), 4000)), { t: 'pg_media', ok: false, err: 'auth' });
    }
    // e. berkas lampiran hilang dari disk = null (bukan galat), laju dibagi dengan gambar (satu jatah per peer)
    ps.dropFile(fFrd.id); assert.deepStrictEqual(await get(B, frdF, fFrd, 0, 10), NONE, 'berkas hilang');
    A._pgMediaRate = new Map();
    for (let i = 0; i < 60; i++) { const r = await get(C, pubF, fPub, 0, 10); if (r.ok === false) { assert.strictEqual(r.err, 'busy'); break; } if (i === 59) assert.fail('laju pg_media tidak membatasi lampiran'); }
    A._pgMediaRate = new Map();
    ok('pg_media melayani lampiran: rakit identik tanpa mime, metadata files di pg_get/pg_list, gambar tetap, privasi seragam, tanda tangan menutup mid, berkas hilang = null, laju sama');
  }

  // 13. video lewat pg_media (3c-4): id video dilayani dengan jalur, privasi, penandatanganan, dan laju yang sama; chunk membawa mime video; nodl tidak menutupnya
  {
    const { VIDEO_CHUNK, FILE_CHUNK } = require('../src/archne-pagestore');
    const rnd = (n) => require('crypto').randomBytes(n);
    const vbin = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), rnd(VIDEO_CHUNK * 2 + 777)]), vp = path.join(tmp, 'g13.mp4'); fs.writeFileSync(vp, vbin);
    const wbin = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....webm'), rnd(300)]), wp = path.join(tmp, 'g13.webm'); fs.writeFileSync(wp, wbin);
    const fp = path.join(tmp, 'g13.bin'); fs.writeFileSync(fp, rnd(1000));
    const pf = path.join(tmp, 'g13.png'); fs.writeFileSync(pf, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex'));
    const [vPub, vFrd, vNd] = await ps.addVideos([{ src: vp }, { src: wp }, { src: wp }]), [fNd, fAll] = await ps.addFiles([{ src: fp }, { src: fp }]), gImg = ps.addMedia(pf);
    const pubV = ps.create({ text: 'publik berbideo', videos: [vPub], files: [fAll], media: [gImg] }), frdV = ps.create({ text: 'teman berbideo', priv: 'friends', videos: [vFrd] });
    const ndV = ps.create({ text: 'tanpa unduh berbideo', videos: [vNd], files: [fNd], nodl: true });
    const get = (who, post, m, off, len) => ask(who, A, { t: 'pg_media', id: post.id, mid: m.id, off, len });
    const NONE = { t: 'pg_media', ok: true, chunk: null };
    A._pgMediaRate = new Map();

    // a. asing dan teman merakit video utuh; chunk membawa mime video; urutan potongan acak (seek) tetap identik
    for (const who of [C, B]) {
      const parts = []; let off = 0;
      while (off < vbin.length) {
        const r = await get(who, pubV, vPub, off, 1e9);
        assert.strictEqual(r.ok, true); assert.deepStrictEqual(Object.keys(r.chunk).sort(), ['b64', 'mime', 'off', 'total'], 'membawa mime'); assert.strictEqual(r.chunk.mime, 'video/mp4');
        assert(r.chunk.off === off && r.chunk.total === vbin.length);
        const b = Buffer.from(r.chunk.b64, 'base64'); assert(b.length > 0 && b.length <= VIDEO_CHUNK); parts.push(b); off += b.length;
      }
      assert.strictEqual(parts.length, 3); assert(Buffer.concat(parts).equals(vbin), 'rakitan identik');
    }
    for (const o of [VIDEO_CHUNK + 5, vbin.length - 1, 123]) { const r = await get(C, pubV, vPub, o, 64); assert(Buffer.from(r.chunk.b64, 'base64').equals(vbin.subarray(o, o + Math.min(64, vbin.length - o))), 'seek ke ' + o); }
    assert.strictEqual(((await get(C, frdV, vFrd, 0, 10)).chunk), null, 'webm milik postingan Teman: asing ditolak');
    assert.strictEqual((await get(B, frdV, vFrd, 0, 10)).chunk.mime, 'video/webm', 'teman: mime webm');
    assert.deepStrictEqual((await ask(C, A, { t: 'pg_get', id: pubV.id })).post.videos, [vPub], 'pg_get membawa metadata video');
    assert.deepStrictEqual((await ask(C, A, { t: 'pg_list' })).items.find((p) => p.id === pubV.id).videos, [vPub], 'pg_list juga');

    // b. gambar dan lampiran di postingan yang sama tetap dilayani seperti sebelumnya (jalur lama tidak terganggu)
    assert.strictEqual(((await get(C, pubV, gImg, 0, 1e9)).chunk || {}).mime, 'image/png');
    assert.deepStrictEqual(Object.keys((await get(C, pubV, fAll, 0, 1e9)).chunk).sort(), ['b64', 'off', 'total'], 'lampiran tetap tanpa mime');

    // c. privasi seragam: asing/diblokir/id tak ada/video postingan lain/off di luar berkas = jawaban SAMA (null)
    for (const [who, post, m] of [[C, frdV, vFrd], [D, pubV, vPub], [C, pubV, vFrd], [C, { id: 'bbbbbbbbbbbbbbbb' }, vPub]]) assert.deepStrictEqual(await get(who, post, m, 0, 10), NONE);
    assert.deepStrictEqual(await get(C, pubV, vPub, vbin.length, 10), NONE, 'off di luar berkas');
    assert(!JSON.stringify(await get(C, frdV, vFrd, 0, 10)).includes(wbin.subarray(0, 6).toString('base64').slice(0, 6)), 'tak ada byte bocor');

    // d. nodl menutup lampiran tetapi TIDAK video: video diputar, bukan diunduh
    assert.deepStrictEqual(await get(C, ndV, fNd, 0, 10), NONE, 'lampiran postingan nodl ditutup untuk asing');
    assert.strictEqual((await get(C, ndV, vNd, 0, 10)).chunk.mime, 'video/webm', 'video postingan nodl tetap terbaca');
    assert.deepStrictEqual(await get(C, ndV, vPub, 0, 10), NONE, 'id video postingan lain tidak lewat sini');

    // e. tanda tangan menutup mid: video tidak bisa diganti di jalan
    {
      const signed = C._pgSign(A.id, { t: 'pg_media', id: pubV.id, mid: vPub.id, off: 0, len: 10 });
      assert.deepStrictEqual(strip(await C._request(C.peers.get(A.id), Object.assign({}, signed, { mid: vFrd.id }), 4000)), { t: 'pg_media', ok: false, err: 'auth' });
    }
    // f. berkas video hilang dari disk = null (bukan galat); laju dibagi dengan gambar dan lampiran (satu jatah per peer)
    ps.dropVideo(vFrd.id); assert.deepStrictEqual(await get(B, frdV, vFrd, 0, 10), NONE, 'berkas hilang');
    A._pgMediaRate = new Map();
    for (let i = 0; i < 60; i++) { const r = await get(C, pubV, vPub, 0, 10); if (r.ok === false) { assert.strictEqual(r.err, 'busy'); break; } if (i === 59) assert.fail('laju pg_media tidak membatasi video'); }
    A._pgMediaRate = new Map();
    ok('pg_media melayani video: rakit dan seek identik dengan mime, metadata videos di pg_get/pg_list, gambar dan lampiran tetap, privasi seragam, nodl menutup lampiran bukan video, tanda tangan menutup mid, berkas hilang = null, laju sama');
  }

  // 16. (4a-2) reaksi ikut di pg_list / pg_get: jumlah + reaksi PENONTON sendiri (id terbukti); Teman tertutup untuk asing; diblokir kosong; tanpa id pelaku; lewat peminta (pageList / pagePost) bentuknya diperiksa
  {
    const plain = ps.create({ text: 'tanpa reaksi' }), rp = ps.create({ text: 'reaksi publik' }), rf = ps.create({ text: 'reaksi teman', priv: 'friends' });
    ps.react(B.id, rp.id, '👍', 100); ps.react(A.id, rp.id, '🩷', 101); ps.react(B.id, rf.id, '🥺', 102);
    const pick = (r, id) => r.items.find((p) => p.id === id);
    const rc = await ask(C, A, { t: 'pg_list', limit: 50 }), rb = await ask(B, A, { t: 'pg_list', limit: 50 }); // 50: postingan dari grup sebelumnya ikut di daftar
    assert.deepStrictEqual(pick(rc, rp.id).rx, [{ e: '👍', n: 1 }, { e: '🩷', n: 1 }]); assert(!('mine' in pick(rc, rp.id)), 'C belum bereaksi: tanpa mine');
    assert.strictEqual(pick(rc, rf.id), undefined, 'postingan Teman tak terlihat asing, reaksinya pun tidak'); assert(!JSON.stringify(rc).includes('🥺'));
    assert.deepStrictEqual(pick(rb, rp.id).rx, [{ e: '👍', n: 1 }, { e: '🩷', n: 1 }]); assert.strictEqual(pick(rb, rp.id).mine, '👍', 'mine = reaksi B sendiri');
    assert.deepStrictEqual(pick(rb, rf.id).rx, [{ e: '🥺', n: 1 }]); assert.strictEqual(pick(rb, rf.id).mine, '🥺');
    assert(![B.id, C.id, A.id].some((id) => JSON.stringify(rc).includes(id)), 'tak ada id pelaku di jawaban asing');
    assert(!('rx' in pick(rb, plain.id)) && !('mine' in pick(rb, plain.id)), 'postingan tanpa reaksi tetap polos');
    const gc = await ask(C, A, { t: 'pg_get', id: rp.id }), gf = await ask(C, A, { t: 'pg_get', id: rf.id });
    assert.deepStrictEqual(gc.post.rx, pick(rc, rp.id).rx); assert.strictEqual(gf.post, null, 'pg_get Teman untuk asing = null, tanpa reaksi');
    assert.deepStrictEqual(strip(await ask(D, A, { t: 'pg_list' })), EMPTY, 'diblokir: kosong seperti biasa');
    // lewat peminta sungguhan: bentuk diperiksa wirePost, dan perubahan reaksi terlihat seketika
    const lb = await B.pageList(A.id, { limit: 50 }), pb = lb.items.find((p) => p.id === rp.id);
    assert.deepStrictEqual({ rx: pb.rx, mine: pb.mine }, { rx: [{ e: '👍', n: 1 }, { e: '🩷', n: 1 }], mine: '👍' });
    ps.react(B.id, rp.id, '', 200); const pb2 = await B.pagePost(A.id, rp.id); assert.deepStrictEqual(pb2.rx, [{ e: '🩷', n: 1 }]); assert(!('mine' in pb2), 'dicabut: mine hilang seketika');
    // pemilik nakal: rx cacat dari jaringan diabaikan, postingan tetap sampai
    const real = A._pgHandle.bind(A); A._pgHandle = (o, rid) => { const r = real(o, rid); if (r.post) r.post = Object.assign({}, r.post, { rx: [{ e: 'x', n: 1 }] }); return r; };
    const pn = await B.pagePost(A.id, rp.id); A._pgHandle = real; assert(pn && pn.text === 'reaksi publik' && !('rx' in pn), 'rx cacat dari pemilik diabaikan');
    ok('reaksi di pg_list / pg_get: jumlah + mine per penonton terbukti, Teman tertutup untuk asing, diblokir kosong, tanpa id pelaku, polos bila tanpa reaksi, pageList / pagePost memeriksa bentuk, cabut terlihat seketika, rx cacat dari pemilik diabaikan');
  }

  // 17. (4a-3) pg_rx: pemilik menerima reaksi penonton. Bertanda tangan (menutup id DAN e), izin = izin melihat, jawaban seragam untuk tak terlihat, laju per peer + global, nonce terpisah, caps 'pgr'
  {
    const rp = ps.create({ text: 'rx publik' }), rf = ps.create({ text: 'rx teman', priv: 'friends' }), NONE = 'f'.repeat(16);
    const rx = (from, id, e) => ask(from, A, { t: 'pg_rx', id, e });
    const ids = (r) => JSON.stringify(r);
    assert(A.hello().caps.includes('pgr') && B.peers.get(A.id).caps.includes('pgr'), "caps 'pgr' diumumkan dan dicatat");
    // a. penonton sah: pasang, idempotent, ganti, cabut; hasil = keadaan SETELAHNYA untuk penonton itu
    const r1 = await rx(B, rp.id, '👍');
    assert.deepStrictEqual(r1, { t: 'pg_rx', ok: true, r: { rx: [{ e: '👍', n: 1 }], mine: '👍' } });
    assert.deepStrictEqual(await rx(B, rp.id, '👍'), r1, 'kirim ulang = keadaan sama (idempotent)');
    assert.deepStrictEqual((await rx(C, rp.id, '🩷')).r, { rx: [{ e: '👍', n: 1 }, { e: '🩷', n: 1 }], mine: '🩷' }, 'asing boleh bereaksi di postingan Publik; mine per penonton');
    { const r = (await rx(B, rp.id, '😭')).r; assert.strictEqual(r.mine, '😭'); assert.deepStrictEqual(r.rx.map((x) => x.e).sort(), ['🩷', '😭'].sort(), 'ganti emoji: satu orang satu reaksi'); }
    assert.strictEqual(ps.reactionsFor(B.id, rp.id).mine, '😭'); assert.strictEqual(ps.reactionsFor(B.id, rp.id).rx.reduce((a, x) => a + x.n, 0), 2);
    assert.deepStrictEqual((await rx(B, rp.id, '')).r.mine, '', 'cabut'); assert.strictEqual(ps.reactionsFor(B.id, rp.id).rx.reduce((a, x) => a + x.n, 0), 1);
    assert.deepStrictEqual((await rx(B, rp.id, '')).r, ps.reactionsFor(B.id, rp.id), 'cabut ulang = sama');
    // terlihat di pg_get / pagePost lewat jalur 4a-2
    await rx(B, rp.id, '👍'); const pg = await B.pagePost(A.id, rp.id); assert.strictEqual(pg.mine, '👍'); assert.strictEqual(pg.rx.reduce((a, x) => a + x.n, 0), 2);
    assert(!ids(r1).includes(B.id) && !ids(await rx(C, rp.id, '🩷')).includes(C.id), 'tak ada id pelaku di jawaban');
    // b. tak terlihat: Teman untuk asing, tidak ada, diblokir, folder belum ada = jawaban SAMA persis, dan tidak ada yang tercatat
    const NULL = { t: 'pg_rx', ok: true, r: null };
    assert.deepStrictEqual(await rx(C, rf.id, '👍'), NULL, 'postingan Teman untuk asing'); assert.deepStrictEqual(await rx(C, NONE, '👍'), NULL, 'tidak ada');
    assert.deepStrictEqual(await rx(D, rp.id, '👍'), NULL, 'diblokir, postingan Publik sekalipun'); assert.deepStrictEqual(await rx(D, rf.id, '👍'), NULL);
    assert.strictEqual(ps.rx.view(rf.id, C.id).rx.length, 0); assert.strictEqual(ps.rx.view(rp.id, D.id).mine, '', 'tidak ada yang tercatat dari yang tak terlihat / diblokir');
    assert.deepStrictEqual((await rx(B, rf.id, '🥺')).r, { rx: [{ e: '🥺', n: 1 }], mine: '🥺' }, 'teman boleh di postingan Teman');
    A.store.friends[B.id] = { st: 'x' }; assert.deepStrictEqual(await rx(B, rf.id, '😭'), NULL, 'memutus pertemanan berlaku seketika'); A.store.friends[B.id] = { st: 'ok' };
    A.store.blocked[B.id] = 1; assert.deepStrictEqual(await rx(B, rp.id, '😭'), NULL, 'blokir berlaku seketika'); delete A.store.blocked[B.id];
    assert.strictEqual(ps.reactionsFor(B.id, rp.id).mine, '👍', 'tidak berubah selama diblokir');
    const Eg = await ask(C, E, { t: 'pg_rx', id: rp.id, e: '👍' }); assert.deepStrictEqual(Eg, NULL, 'pemilik yang belum punya halaman'); assert(!fs.existsSync(path.join(tmp, 'E', 'pages')), 'bereaksi tidak membuat folder halaman');
    // c. salah bentuk = bad, dicek SEBELUM relasi (sama untuk postingan Teman, tidak ada, dan Publik)
    const BAD = { t: 'pg_rx', ok: false, err: 'bad' };
    for (const [id, e] of [['zz', '👍'], [5, '👍'], [rf.id.toUpperCase(), '👍'], [rp.id, 'abc'], [rp.id, '<b>'], [rp.id, 5], [rp.id, null], [rp.id, '👍👍'], [rp.id, '👍'.repeat(40)], [rp.id, undefined]]) assert.deepStrictEqual(await rx(C, id, e), BAD, 'bentuk salah: ' + String(id).slice(0, 6) + ' / ' + String(e).slice(0, 4));
    for (const id of [rp.id, rf.id, NONE]) assert.deepStrictEqual(await rx(C, id, 'abc'), BAD, 'emoji salah dijawab sama untuk Teman, tidak ada, Publik (tak membocorkan)');
    // d. tanda tangan: emoji diubah = auth; putar ulang = auth; hello teman tanpa tanda tangan = auth
    const signed = A.peers.size && B._pgSign(A.id, { t: 'pg_rx', id: rp.id, e: '🥺' });
    const forged = Object.assign({}, signed, { e: '🩷' });
    assert.deepStrictEqual(strip(await B._request(B.peers.get(A.id), forged, 4000)), { t: 'pg_rx', ok: false, err: 'auth' }, 'emoji diganti di jalan');
    assert.strictEqual(strip(await B._request(B.peers.get(A.id), signed, 4000)).ok, true); assert.deepStrictEqual(strip(await B._request(B.peers.get(A.id), signed, 4000)), { t: 'pg_rx', ok: false, err: 'auth' }, 'putar ulang');
    assert.strictEqual(ps.reactionsFor(B.id, rp.id).mine, '🥺', 'hanya yang sah tercatat');
    const nosig = await new Promise((res) => { const s = require('net').connect(A.port, '127.0.0.1'); let b = ''; s.on('data', (d) => { b += d; if (b.includes('\n')) { s.destroy(); res(strip(JSON.parse(b))); } }); s.on('connect', () => s.write(JSON.stringify({ hi: B.hello(), t: 'pg_rx', id: rp.id, e: '😭' }) + '\n')); });
    assert.deepStrictEqual(nosig, { t: 'pg_rx', ok: false, err: 'auth' }, 'hello teman disalin tanpa kunci'); assert.strictEqual(ps.reactionsFor(B.id, rp.id).mine, '🥺');
    // e. penampung nonce terpisah: penuh di pg_rx tidak mematikan pg_list / pg_get, dan sebaliknya
    { const big = new Map(), exp = Date.now() + 1e6; for (let i = 0; i < 20000; i++) big.set('k' + i, exp); A._pgSeenR = big;
      assert.deepStrictEqual(await rx(B, rp.id, '👍'), { t: 'pg_rx', ok: false, err: 'busy' }, 'nonce pg_rx penuh = busy'); assert.strictEqual((await ask(B, A, { t: 'pg_get', id: rp.id })).ok, true, 'pg_get tetap jalan'); A._pgSeenR = null;
      A._pgSeen = new Map(big); assert.strictEqual((await rx(B, rp.id, '👍')).ok, true, 'nonce pg_list / pg_get penuh tidak mematikan pg_rx'); assert.strictEqual((await ask(B, A, { t: 'pg_get', id: rp.id })).err, 'busy'); A._pgSeen = null; }
    // f. laju: RX_RATE_RECV per peer (peer lain tidak ikut), 'busy' sama untuk apa pun isinya; lalu batas global
    { const RXX = require('../src/archne-reactions'); A._pgRxLim = null; await rx(B, rp.id, '👍'); // membuat limiter; satu jatah B terpakai
      let n = 1; while ((await rx(C, rp.id, '🩷')).ok) { n++; if (n > 400) break; }
      assert.strictEqual(n, RXX.RX_RATE_RECV.max + 1, 'peer pertama ditolak tepat setelah jatahnya habis');
      const busy = { t: 'pg_rx', ok: false, err: 'busy' };
      for (const id of [rp.id, rf.id, NONE]) assert.deepStrictEqual(await rx(C, id, '🩷'), busy, 'busy tak bergantung pada izin lihat');
      assert.strictEqual((await rx(B, rp.id, '👍')).ok, true, 'peer lain tidak terpengaruh');
      assert.strictEqual((await ask(C, A, { t: 'pg_get', id: rp.id })).ok, true, 'pg_get peer yang kena batas pg_rx tetap jalan');
      for (let i = 0; i < 300; i++) A._pgRxLim.all.take('*', 1, Date.now()); assert.deepStrictEqual(await rx(B, rp.id, '👍'), busy, 'batas global habis = busy untuk semua'); A._pgRxLim = null; }
    // g. postingan penuh (256 orang): penonton baru dapat r null, sama dengan tak terlihat; tidak ada galat bocor
    { const full = ps.create({ text: 'penuh' }); for (let i = 1; i <= 256; i++) ps.rx.set(i.toString(16).padStart(16, '0'), full.id, '👍', 100 + i);
      assert.deepStrictEqual(await rx(C, full.id, '🩷'), NULL, 'penuh = null seperti tak terlihat'); assert.strictEqual(ps.reactionsFor(C.id, full.id).mine, ''); }
    ok("pg_rx: pasang / ganti / cabut idempotent, Teman tertutup untuk asing, diblokir / tak ada / folder belum ada = null yang sama, bentuk salah 'bad' sebelum relasi, tanda tangan menutup emoji + putar ulang ditolak, nonce dan laju (per peer + global) terpisah, postingan penuh = null, tanpa id pelaku");
  }

  console.log('\n' + pass + ' kelompok lulus');
  for (const n of all) await n.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
// Tes Halaman 5e: PENULIS menghapus komentarnya sendiri di halaman orang lain (pg_cmd, caps 'pgd'), dengan antrean untuk pemilik offline.
// Yang diuji: kanon tanda tangan (cid ikut tertutup), DelQueue murni (batas, persisten, berkas rusak), pemilik (hanya komentar milik pengirim terbukti, nisan, putus pertemanan tetap boleh, diblokir = gone, replay ditolak),
// peminta (validasi tanpa jaringan, self, old, offline -> antre -> terkirim otomatis, komentar yang menunggu disembunyikan), IPC pgCmtDelete, preload.js dan archne-api-http.js.
// Dua / tiga Core sungguhan. Moderasi pemilik: test/pagecmtrm.js; kirim komentar: test/pagecmtnet.js; antrean kirim: test/archne-pagecq.js.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { DelQueue, CD_TOTAL, CD_PEER, CD_TRIES } = require('../src/archne-pagecqd');
const { pgSignReq, pgVerifyReq } = require('../src/archne-pagestore');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pgcmtdel-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 });
function fake(core) {
  const handlers = {};
  register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core, send: () => {}, log: () => {} });
  return (n, ...a) => handlers[n]({}, ...a);
}
const code = async (p) => { try { await p; return null; } catch (e) { return e && e.code; } };
const hex = (n) => n.toString(16).padStart(16, '0');
const pick = (x) => JSON.parse(JSON.stringify({ t: x.t, ok: x.ok, r: x.r, err: x.err })); // balasan mentah membawa hi (hello pemilik); yang dibandingkan hanya isi jawabannya
const ids = (core, owner, post) => core.pageStore().commentsFor(owner, post).map((c) => c.id);

(async () => {
  // ---- A. kanon tanda tangan: cid ikut ditandatangani ----
  {
    const k = require('crypto').generateKeyPairSync('ed25519'), pub = k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const owner = hex(1), post = hex(2), cid = hex(3);
    const req = pgSignReq(k.privateKey, owner, { t: 'pg_cmd', id: post, cid, hi: { pub, id: require('crypto').createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16) } });
    assert.strictEqual(pgVerifyReq(req, owner).ok, true, 'permintaan sah');
    assert.strictEqual(pgVerifyReq(Object.assign({}, req, { cid: hex(4) }), owner).err, 'auth', 'cid tidak bisa diganti di jalan');
    assert.strictEqual(pgVerifyReq(Object.assign({}, req, { id: hex(5) }), owner).err, 'auth', 'id postingan tidak bisa diganti');
    assert.strictEqual(pgVerifyReq(Object.assign({}, req, { t: 'pg_cml' }), owner).err, 'auth', 'jenis permintaan tidak bisa ditukar');
    assert.strictEqual(pgVerifyReq(req, hex(9)).err, 'auth', 'tidak bisa diputar ulang ke pemilik lain');
    ok('kanon tanda tangan: pg_cmd menutup id postingan, cid, jenis dan pemilik');
  }

  // ---- B. DelQueue murni ----
  {
    const f = path.join(tmp, 'q', 'pgcd.json'), P = hex(0xa1), POST = hex(0xb1);
    const q = new DelQueue(f);
    assert.strictEqual(q.size, 0); assert.strictEqual(q.has(P), false);
    assert.strictEqual(q.add(P, POST, hex(0xc1), 100), 'queued'); assert.strictEqual(q.add(P, POST, hex(0xc1), 100), 'same', 'cid sama = same');
    assert.strictEqual(q.add(P, POST, hex(0xc2), 50), 'queued');
    for (const bad of [['x', POST, hex(1)], [P, 'x', hex(1)], [P, POST, 'x'], [P, POST, hex(0xab).toUpperCase()], [P, POST, 5]]) assert.throws(() => q.add(...bad), (e) => e.code === undefined, JSON.stringify(bad));
    assert.deepStrictEqual([...q.hidden(P, POST)].sort(), [hex(0xc1), hex(0xc2)]); assert.strictEqual(q.hidden(P, hex(0xb2)).size, 0);
    assert.deepStrictEqual(q.due(P, 0).map((e) => e.cid), [hex(0xc2), hex(0xc1)], 'tertua dulu');
    q.later(hex(0xc2), 1000, 500); assert.deepStrictEqual(q.due(P, 1000).map((e) => e.cid), [hex(0xc1)], 'ditunda'); assert.deepStrictEqual(q.due(P, 1500).map((e) => e.cid), [hex(0xc2), hex(0xc1)]);
    assert.strictEqual(q.retry(hex(0xc1), 0), 'retry'); for (let i = 0; i < CD_TRIES - 2; i++) q.retry(hex(0xc1), 0); assert.strictEqual(q.retry(hex(0xc1), 0), 'gave'); assert.strictEqual(q.size, 1, 'menyerah = dibuang');
    assert.strictEqual(q.retry(hex(0xc1), 0), null);
    // persisten + dimuat ulang
    const q2 = new DelQueue(f); assert.strictEqual(q2.size, 1); assert.deepStrictEqual([...q2.hidden(P, POST)], [hex(0xc2)]);
    // berkas rusak / entri cacat / versi asing
    fs.writeFileSync(f, '{bukan json'); assert.strictEqual(new DelQueue(f).size, 0);
    fs.writeFileSync(f, JSON.stringify({ v: 2, q: [{ peer: P, post: POST, cid: hex(1) }] })); assert.strictEqual(new DelQueue(f).size, 0, 'versi asing = kosong');
    fs.writeFileSync(f, JSON.stringify({ v: 1, q: [null, 5, { peer: P }, { peer: P, post: POST, cid: 'zz' }, { peer: P, post: POST, cid: hex(7), at: -5, tries: 99, nx: 'x' }, { peer: P, post: POST, cid: hex(7) }] }));
    { const q3 = new DelQueue(f); assert.strictEqual(q3.size, 1, 'cacat dibuang, ganda dibuang'); const e = q3.due(P, 0)[0]; assert.deepStrictEqual([e.at, e.tries, e.nx], [0, 0, 0], 'angka liar dijinakkan'); }
    // batas
    const qb = new DelQueue(path.join(tmp, 'qb', 'pgcd.json'));
    for (let i = 0; i < CD_PEER; i++) qb.add(P, POST, hex(0x1000 + i), 1);
    assert.throws(() => qb.add(P, POST, hex(0x2000), 1), (e) => e.code === 'qfull', 'batas per pemilik'); assert.strictEqual(qb.add(hex(0xa2), POST, hex(0x2001), 1), 'queued', 'pemilik lain masih bisa');
    for (let i = 0; qb.size < CD_TOTAL; i++) qb.add(hex(0xd000 + i), POST, hex(0x3000 + i), 1);
    assert.throws(() => qb.add(hex(0xe0e0), POST, hex(0x4000), 1), (e) => e.code === 'qfull', 'batas total');
    // umur
    const qe = new DelQueue(path.join(tmp, 'qe', 'pgcd.json')); qe.add(P, POST, hex(1), 0); qe.add(P, POST, hex(2), 8 * 864e5);
    assert.deepStrictEqual(qe.expire(8 * 864e5).map((e) => e.cid), [hex(1)], '7 hari lewat = dibuang'); assert.strictEqual(qe.size, 1);
    // gagal tulis memulihkan memori
    const qw = new DelQueue(path.join(tmp, 'qw', 'pgcd.json'), () => { throw new Error('disk penuh'); }); assert.throws(() => qw.add(P, POST, hex(1), 1), /disk penuh/); assert.strictEqual(qw.size, 0);
    ok('DelQueue: antre / same / validasi, tertua dulu, tunda, menyerah, persisten, berkas rusak, batas, umur, gagal tulis');
  }

  // ---- Core sungguhan ----
  const A = mk('A'), B = mk('B'), C = mk('C'); const a = fake(A), b = fake(B), c = fake(C);
  await A.start(); await B.start(); await C.start();
  try {
    const p1 = (await a('pgCreate', 'postingan publik', 'public')).post.id, pf = (await a('pgCreate', 'khusus teman', 'friends')).post.id;
    await A.addPeer('127.0.0.1', B.port); await B.addPeer('127.0.0.1', A.port); await A.addPeer('127.0.0.1', C.port); await C.addPeer('127.0.0.1', A.port);
    await until(() => A.isOnline(A.peers.get(B.id)) && B.isOnline(B.peers.get(A.id)) && A.isOnline(A.peers.get(C.id)) && C.isOnline(C.peers.get(A.id)), 8000, 'online');
    assert(B.peers.get(A.id).caps.includes('pgd'), "B mencatat caps 'pgd' milik A");

    // ---- C. pemilik: hanya komentar milik pengirim terbukti ----
    let r;
    const cb = (await B.pageComment(A.id, p1, 'komentar B')).c, cc = (await C.pageComment(A.id, p1, 'komentar C')).c;
    assert.deepStrictEqual(ids(A, A.id, p1).sort(), [cb.id, cc.id].sort());
    const acts = []; A.on('pgact', (x) => acts.push(x));
    {
      // C mencoba menghapus komentar B: 'none', komentar B tetap
      assert.deepStrictEqual(await C.pageCommentDelete(A.id, p1, cb.id), { st: 'none' }, 'komentar orang lain: none (tak dibedakan dari tidak ada)');
      assert(ids(A, A.id, p1).includes(cb.id), 'komentar B utuh');
      assert.deepStrictEqual(await B.pageCommentDelete(A.id, p1, hex(0xdead)), { st: 'none' }, 'id tak dikenal: none');
      assert.deepStrictEqual(await B.pageCommentDelete(A.id, hex(0xbeef), cb.id), { st: 'gone' }, 'postingan tak ada: gone');
      assert.deepStrictEqual(acts, [], 'tanpa penghapusan = tanpa pgact');
      // B menghapus komentarnya sendiri
      r = await B.pageCommentDelete(A.id, p1, cb.id); assert.deepStrictEqual(r, { st: 'removed' });
      assert.deepStrictEqual(ids(A, A.id, p1), [cc.id], 'tinggal komentar C');
      assert.deepStrictEqual(acts, [{ post: p1, kind: 'cmt' }], 'Halamanku terbuka di pemilik disegarkan (pgact)');
      const disk = JSON.parse(fs.readFileSync(path.join(A.opts.dataDir, 'pages', 'comments.json'), 'utf8'));
      assert(!JSON.stringify(disk.map).includes(cb.id), 'comments.json ikut berubah'); assert(disk.rm.includes(p1 + ':' + cb.id), 'nisan tercatat');
      // ulang = none; kirim ulang komentar yang sama persis ditolak oleh nisan (null = tak terbedakan)
      assert.deepStrictEqual(await B.pageCommentDelete(A.id, p1, cb.id), { st: 'none' }, 'ulang: none');
      const csig = require('../src/archne-pagecmt'); assert.strictEqual(A.pageStore().comment(B.id, p1, Object.assign({}, cb, csig.cmtVerify(cb, A.id, p1).c)), null, 'kirim ulang persis ditolak');
      // yang dilihat penonton lain
      assert.deepStrictEqual((await C.pageComments(A.id, p1)).items.map((x) => x.id), [cc.id]);
    }
    ok('pemilik: hanya komentar milik pengirim terbukti (orang lain / tak dikenal = none, postingan tak ada = gone), nisan + comments.json + pgact, ulang = none');

    // ---- D. replay dan bentuk cacat ----
    {
      const peer = B.peers.get(A.id);
      const x = await B.pageComment(A.id, p1, 'untuk replay'), req = B._pgSign(A.id, { t: 'pg_cmd', id: p1, cid: x.c.id });
      const r1 = await B._request(peer, req, 5000), r2 = await B._request(peer, req, 5000);
      assert.deepStrictEqual(pick(r1), { t: 'pg_cmd', ok: true, r: 'removed' }); assert.deepStrictEqual(pick(r2), { t: 'pg_cmd', ok: false, err: 'auth' }, 'permintaan yang sama persis dua kali = auth');
      for (const o of [{ t: 'pg_cmd', id: p1 }, { t: 'pg_cmd', cid: hex(1) }, { t: 'pg_cmd', id: 'zz', cid: hex(1) }, { t: 'pg_cmd', id: p1, cid: 5 }, { t: 'pg_cmd', id: p1, cid: hex(0xab).toUpperCase() }]) {
        const rr = await B._request(peer, B._pgSign(A.id, o), 5000); assert.deepStrictEqual(pick(rr), { t: 'pg_cmd', ok: false, err: 'bad' }, JSON.stringify(o));
      }
      assert.deepStrictEqual(pick(await B._request(peer, { t: 'pg_cmd', id: p1, cid: hex(1) }, 5000)), { t: 'pg_cmd', ok: false, err: 'auth' }, 'tanpa tanda tangan = auth');
    }
    ok('replay (nonce) = auth; id / cid cacat = bad; tanpa tanda tangan = auth');

    // ---- E. relasi: putus pertemanan tetap boleh menghapus; diblokir = gone ----
    {
      A.store.friends[B.id] = { st: 'ok' };
      const f = (await B.pageComment(A.id, pf, 'saat masih teman')).c; assert.deepStrictEqual(ids(A, A.id, pf), [f.id]);
      delete A.store.friends[B.id];
      assert.strictEqual((await B.pageComments(A.id, pf)), null, 'bukan teman lagi: tidak bisa membaca');
      assert.deepStrictEqual(await B.pageCommentDelete(A.id, pf, f.id), { st: 'removed' }, 'tetap bisa menghapus komentarnya sendiri (5c-3)');
      A.store.friends[B.id] = { st: 'ok' }; const f2 = (await B.pageComment(A.id, pf, 'lagi')).c; delete A.store.friends[B.id];
      A.store.blocked[B.id] = 1;
      assert.deepStrictEqual(await B.pageCommentDelete(A.id, pf, f2.id), { st: 'gone' }, 'diblokir pemilik: gone, komentar tak berubah');
      assert.deepStrictEqual(ids(A, A.id, pf), [f2.id]);
      delete A.store.blocked[B.id]; A.store.friends[B.id] = { st: 'ok' };
      assert.deepStrictEqual(await B.pageCommentDelete(A.id, pf, f2.id), { st: 'removed' }); delete A.store.friends[B.id];
    }
    ok('relasi: bukan teman lagi tetap boleh menghapus komentarnya; diblokir pemilik = gone tanpa mengubah apa pun');

    // ---- F. peminta: validasi tanpa jaringan, self, old, blokir, peer asing ----
    {
      const asked = []; const ask = B._pgAsk; B._pgAsk = async (...x) => { asked.push(x); return ask.apply(B, x); };
      try {
        for (const args of [[], [A.id], [A.id, p1], ['x', p1, hex(1)], [A.id, 'x', hex(1)], [A.id, p1, 'x'], [A.id, p1, 5], [5, p1, hex(1)], [A.id, p1, hex(0xab).toUpperCase()]]) assert.strictEqual(await code(B.pageCommentDelete(...args)), 'bad', JSON.stringify(args));
        assert.strictEqual(await code(B.pageCommentDelete(B.id, p1, hex(1))), 'self', 'halaman sendiri: pemilik memakai pageCommentRemove');
        assert.strictEqual(await code(B.pageCommentDelete(hex(0x77), p1, hex(1))), 'peer', 'peer tak dikenal');
        B.store.blocked[A.id] = 1; assert.strictEqual(await code(B.pageCommentDelete(A.id, p1, hex(1))), 'blocked'); delete B.store.blocked[A.id];
        const real = B.peers.get.bind(B.peers); B.peers.get = (x) => { const p = real(x); return x === A.id && p ? Object.assign({}, p, { caps: ['rx', 'pg', 'pgm', 'pgr', 'pgc'] }) : p; };
        try { const e = await B.pageCommentDelete(A.id, p1, hex(1)).catch((x) => x); assert.strictEqual(e.code, 'old', 'tanpa caps pgd'); assert(/penghapusan komentar/.test(e.message), 'pesan khusus, bukan "belum mendukung Halaman"'); } finally { B.peers.get = real; }
        assert.strictEqual(asked.length, 0, 'semua penolakan terjadi tanpa menyentuh jaringan');
        assert.strictEqual(B._pcdPeek(), null, 'tanpa antrean = tidak ada berkas pgcd.json'); assert.strictEqual(fs.existsSync(path.join(B.opts.dataDir, 'pgcd.json')), false);
      } finally { B._pgAsk = ask; }
    }
    ok('peminta: id cacat = bad, id sendiri = self, peer asing, diblokir, tanpa caps pgd = old (pesan khusus); tanpa jaringan dan tanpa berkas antrean');

    // ---- G. pemilik offline: antre, disembunyikan, terkirim otomatis ----
    {
      const mine = (await B.pageComment(A.id, p1, 'akan dihapus saat offline')).c, other = (await B.pageComment(A.id, p1, 'tetap ada')).c;
      const online = B.isOnline.bind(B), flush = B._pcdFlush.bind(B), sent = [];
      B.on('pgcd', (x) => sent.push(x));
      B._pcdFlush = async () => {}; // tahan pengiriman antrean selama pengujian
      B.isOnline = (p) => (p && p.id === A.id ? false : online(p));
      try {
        assert.deepStrictEqual(await B.pageCommentDelete(A.id, p1, mine.id), { st: 'queued' }, 'pemilik offline = diantre');
        assert.strictEqual(fs.existsSync(path.join(B.opts.dataDir, 'pgcd.json')), true, 'antrean persisten');
        assert.deepStrictEqual(await B.pageCommentDelete(A.id, p1, mine.id), { st: 'queued' }, 'ulang = tetap queued (same), tanpa ganda'); assert.strictEqual(B._pcdPeek().size, 1);
      } finally { B.isOnline = online; }
      assert(ids(A, A.id, p1).includes(mine.id), 'belum sampai ke pemilik');
      // selagi menunggu: pemilik sudah online lagi tetapi antrean belum jalan -> komentar disembunyikan dari tampilan penulis
      const pg = await B.pageComments(A.id, p1); assert(!pg.items.some((x) => x.id === mine.id), 'yang menunggu dihapus tidak ditampilkan'); assert(pg.items.some((x) => x.id === other.id), 'komentar lain tampil');
      assert.strictEqual(pg.count, ids(A, A.id, p1).length - 1, 'hitungan ikut dikurangi');
      assert.strictEqual((await C.pageComments(A.id, p1)).items.some((x) => x.id === mine.id), true, 'penonton lain masih melihatnya sampai pemilik menerima');
      // jalankan antrean: terkirim
      B._pcdFlush = flush;
      await until(() => !ids(A, A.id, p1).includes(mine.id), 6000, 'terkirim otomatis');
      await until(() => B._pcdPeek().size === 0, 3000, 'antrean kosong');
      assert.deepStrictEqual(sent.map((x) => [x.ev, x.why, x.cid]), [['sent', 'removed', mine.id]], 'event pgcd: sent/removed');
      assert(ids(A, A.id, p1).includes(other.id), 'komentar lain utuh');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(B.opts.dataDir, 'pgcd.json'), 'utf8')), { v: 1, q: [] }, 'berkas antrean kosong');
      assert.deepStrictEqual((await B.pageComments(A.id, p1)).items.filter((x) => x.by === B.id).map((x) => x.id), [other.id], 'tanpa penyembunyian lagi (memang sudah hilang); komentar C tak tersentuh');
    }
    ok('pemilik offline: diantre (persisten, tanpa ganda), disembunyikan dari penulis selagi menunggu, terkirim otomatis, antrean kosong, event pgcd');

    // ---- H. antrean: pemilik lama (tanpa pgd) = dibuang; gagal diproses = dihitung ----
    {
      const x = (await B.pageComment(A.id, p1, 'untuk antrean lama')).c;
      const online = B.isOnline.bind(B), flush = B._pcdFlush.bind(B), ev = [];
      B.on('pgcd', (e) => ev.push(e));
      B._pcdFlush = async () => {}; B.isOnline = (p) => (p && p.id === A.id ? false : online(p));
      try { assert.strictEqual((await B.pageCommentDelete(A.id, p1, x.id)).st, 'queued'); } finally { B.isOnline = online; }
      const real = B.peers.get.bind(B.peers); B.peers.get = (id) => { const p = real(id); return id === A.id && p ? Object.assign({}, p, { caps: ['rx', 'pg', 'pgm', 'pgr', 'pgc'] }) : p; };
      try { B._pcdFlush = flush; await until(() => ev.some((e) => e.cid === x.id), 4000, 'dibuang'); } finally { B.peers.get = real; }
      assert.deepStrictEqual(ev.filter((e) => e.cid === x.id).map((e) => [e.ev, e.why]), [['drop', 'old']], 'pemilik tanpa pgd: dibuang (old)'); assert.strictEqual(B._pcdPeek().size, 0);
      assert(ids(A, A.id, p1).includes(x.id), 'komentar tetap ada: hanya pemilik yang bisa menghapusnya');
      // kedaluwarsa
      B._pcdStore().add(A.id, p1, x.id, Date.now() - 8 * 864e5); const ev2 = []; B.on('pgcd', (e) => ev2.push(e)); B._pcdGc();
      assert.deepStrictEqual(ev2.map((e) => [e.ev, e.why]), [['drop', 'expired']]); assert.strictEqual(B._pcdPeek().size, 0);
    }
    ok('antrean: pemilik tanpa pgd = dibuang (old) dan komentar tetap ada; lewat 7 hari = expired');

    // ---- I. IPC ----
    {
      const mine = (await B.pageComment(A.id, p1, 'lewat IPC')).c;
      const calls = []; const real = B.pageCommentDelete; B.pageCommentDelete = (...x) => { calls.push(x); return real.apply(B, x); };
      try {
        for (const args of [[], [A.id], [A.id, p1], [5, p1, mine.id], [A.id, {}, mine.id], [A.id, p1, 'zz'], [[A.id], p1, mine.id], [A.id.toUpperCase(), p1, mine.id]]) { r = await b('pgCmtDelete', ...args); assert(r.ok === false && r.code === 'bad', JSON.stringify(args) + ' -> ' + JSON.stringify(r)); }
        assert.strictEqual(calls.length, 0, 'masukan cacat tidak sampai ke Core');
        r = await b('pgCmtDelete', B.id, p1, mine.id); assert(r.ok === false && r.code === 'self', JSON.stringify(r));
        r = await b('pgCmtDelete', hex(0x5), p1, mine.id); assert(r.ok === false && r.code === 'peer');
        r = await b('pgCmtDelete', A.id, p1, mine.id, 'liar', { x: 1 }); assert.deepStrictEqual(r, { ok: true, st: 'removed' }, JSON.stringify(r));
        assert.deepStrictEqual(calls[calls.length - 1], [A.id, p1, mine.id], 'argumen liar dibuang');
        assert.deepStrictEqual(await b('pgCmtDelete', A.id, p1, mine.id), { ok: true, st: 'none' }, 'ulang = none');
        // pemilik halaman tidak bisa memakai kanal ini untuk halamannya sendiri; moderasinya tetap pgCmtRemove
        r = await a('pgCmtDelete', A.id, p1, mine.id); assert(r.ok === false && r.code === 'self');
        // galat tak dikenal = pesan umum tanpa jalur
        B.pageCommentDelete = async () => { throw Object.assign(new Error('EACCES: /rahasia/jalur'), { code: 'EACCES' }); };
        r = await b('pgCmtDelete', A.id, p1, mine.id); assert(r.ok === false && !/rahasia/.test(JSON.stringify(r)), 'jalur tidak bocor: ' + JSON.stringify(r));
        // hasil tak dikenal dari Core dipaksa ke 'none'
        B.pageCommentDelete = async () => ({ st: 'aneh' }); assert.deepStrictEqual(await b('pgCmtDelete', A.id, p1, mine.id), { ok: true, st: 'none' });
        B.pageCommentDelete = async () => ({ st: 'queued' }); assert.deepStrictEqual(await b('pgCmtDelete', A.id, p1, mine.id), { ok: true, st: 'queued' });
      } finally { B.pageCommentDelete = real; }
      // preload.js sungguhan + archne-api-http.js
      const Module = require('module'); const pcalls = []; let exposed;
      const fakeElectron = { contextBridge: { exposeInMainWorld: (n, o) => { exposed = o; } }, ipcRenderer: { invoke: (...x) => { pcalls.push(x); return Promise.resolve('balasan'); }, on() {} }, webUtils: { getPathForFile: () => '' } };
      const load = Module._load; Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : load.call(this, req, ...rest); };
      const pp = require.resolve('../preload.js'); delete require.cache[pp];
      try { require(pp); } finally { Module._load = load; delete require.cache[pp]; }
      assert.strictEqual(await exposed.pgCmtDelete('a'.repeat(16), 'b'.repeat(16), 'c'.repeat(16)), 'balasan');
      assert.deepStrictEqual(pcalls, [['pgCmtDelete', 'a'.repeat(16), 'b'.repeat(16), 'c'.repeat(16)]], 'kanal dan ketiga argumen utuh');
      assert(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archne-api-http.js'), 'utf8').includes("'pgCmtDelete'"), 'archne-api-http.js mendaftarkan pgCmtDelete');
    }
    ok('IPC pgCmtDelete: validasi tanpa menyentuh Core, self / peer, hasil dipetakan, jalur tidak bocor; preload.js dan archne-api-http.js');
  } finally { try { await A.stop(); await B.stop(); await C.stop(); } catch {} }
  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

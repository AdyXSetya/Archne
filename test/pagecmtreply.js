'use strict';
// Tes Halaman 5f: BALASAN komentar (pohon). Komentar membawa `re` = id komentar induk; `re` ikut ditandatangani penulis (tag archne-pc2:), caps 'pgt'.
// Kelompok: A murni (tanda tangan, tag, pemeriksaan, tidak bisa dipindah / dilepas), B PageCmt (induk wajib ada, yatim tetap, berkas, ekspor / impor), C jaringan dengan tiga Core (pohon bertingkat dari beberapa orang,
// pemilik membalas lewat jalur lokal, noparent, penulis menghapus induk = balasan tetap, relasi), D caps (peer lama = old tanpa jaringan), E antrean (balasan antre, induk hilang = dibuang 'noparent'), F IPC + preload.
// Tampilan pohon: test/pagecmtreplyui.js. Komentar biasa: test/archne-pagecmt.js, test/pagecmtnet.js.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), crypto = require('crypto');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { cmtSign, cmtVerify, wireComments, PageCmt, CMT_TAG, CMT_TAG2 } = require('../src/archne-pagecmt');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pgcmtreply-'));
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
const ident = () => { const k = crypto.generateKeyPairSync('ed25519'); return { priv: k.privateKey, pub: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }; };
const pick = (x) => JSON.parse(JSON.stringify({ t: x.t, ok: x.ok, r: x.r, err: x.err }));
const list = (core, owner, post) => core.pageStore().commentsFor(owner, post);
const reOf = (core, owner, post) => Object.fromEntries(list(core, owner, post).map((c) => [c.text, c.re || null]));
// byte yang ditandatangani menurut aplikasi LAMA (sebelum 5f): hanya tag lama, tanpa `re`
const oldBytes = (owner, post, ts, text) => Buffer.from(CMT_TAG + owner + ':' + post + ':' + ts + ':' + JSON.stringify(text));

(async () => {
  // ---- A. murni: tanda tangan balasan ----
  {
    const X = ident(), Y = ident(), OWN = hex(1), POST = hex(2);
    const top = cmtSign(X.priv, X.pub, OWN, POST, 'induk', 1000);
    assert.strictEqual(top.re, undefined, 'komentar tingkat atas tanpa re'); assert(!('re' in top));
    assert.strictEqual(crypto.verify(null, oldBytes(OWN, POST, 1000, 'induk'), crypto.createPublicKey({ key: Buffer.from(X.pub, 'base64'), format: 'der', type: 'spki' }), Buffer.from(top.sig, 'base64')), true, 'komentar tingkat atas: byte tertandatangani sama persis dengan aplikasi lama');
    const rep = cmtSign(Y.priv, Y.pub, OWN, POST, 'balasan', 2000, top.id);
    assert.strictEqual(rep.re, top.id); assert.strictEqual(cmtVerify(rep, OWN, POST).ok, true); assert.strictEqual(cmtVerify(rep, OWN, POST).c.re, top.id, 'cmtVerify mempertahankan re');
    const keyY = crypto.createPublicKey({ key: Buffer.from(Y.pub, 'base64'), format: 'der', type: 'spki' });
    assert.strictEqual(crypto.verify(null, oldBytes(OWN, POST, 2000, 'balasan'), keyY, Buffer.from(rep.sig, 'base64')), false, 'aplikasi lama (tag lama) menolak balasan: tidak pernah tampil sebagai komentar biasa');
    assert.strictEqual(CMT_TAG2 === CMT_TAG, false);
    // tidak bisa diubah di jalan
    assert.strictEqual(cmtVerify(Object.assign({}, rep, { re: hex(0xaa) }), OWN, POST).why, 'auth', 'induk tidak bisa dipindah');
    const bare = Object.assign({}, rep); delete bare.re; assert.strictEqual(cmtVerify(bare, OWN, POST).why, 'auth', 'balasan tidak bisa dilepas jadi komentar tingkat atas');
    assert.strictEqual(cmtVerify(Object.assign({}, top, { re: hex(0xaa) }), OWN, POST).why, 'auth', 'komentar tingkat atas tidak bisa dijadikan balasan');
    assert.strictEqual(cmtVerify(rep, hex(9), POST).ok, false, 'tidak bisa diputar ke halaman lain'); assert.strictEqual(cmtVerify(rep, OWN, hex(7)).ok, false, 'dan tidak ke postingan lain');
    // bentuk re
    for (const bad of ['zz', 5, hex(0xab).toUpperCase(), '', null, {}]) assert.strictEqual(cmtVerify(Object.assign({}, rep, { re: bad }), OWN, POST).why, 'bad', 're cacat: ' + JSON.stringify(bad));
    assert.strictEqual(cmtVerify(Object.assign({}, rep, { re: rep.id }), OWN, POST).why, 'bad', 'membalas dirinya sendiri');
    for (const bad of ['zz', 5, hex(0xab).toUpperCase(), '']) assert.throws(() => cmtSign(Y.priv, Y.pub, OWN, POST, 'x', 1, bad), /tidak valid/);
    // balasan berbeda induk = id berbeda; sama persis = id sama (deterministik)
    assert.strictEqual(cmtSign(Y.priv, Y.pub, OWN, POST, 'balasan', 2000, top.id).id, rep.id); assert.notStrictEqual(cmtSign(Y.priv, Y.pub, OWN, POST, 'balasan', 2000, hex(0xcc)).id, rep.id);
    // wireComments membawa re
    const w = wireComments({ items: [top, rep], next: null, count: 2 }, {}, OWN, POST); assert.deepStrictEqual(w.items.map((c) => c.re || null), [null, top.id]); assert.strictEqual(w.skipped, 0);
    ok('tanda tangan balasan: tag lain + re tertutup (aplikasi lama menolak), tidak bisa dipindah / dilepas / ditempel, re cacat = bad, tingkat atas tak berubah');
  }

  // ---- B. PageCmt: induk wajib ada, yatim tetap, berkas, ekspor / impor ----
  {
    const X = ident(), Y = ident(), OWN = hex(1), POST = hex(2), POST2 = hex(3), file = path.join(tmp, 'cmtB', 'comments.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const s = new PageCmt(file, OWN), t = Date.now() - 10000;
    const top = cmtSign(X.priv, X.pub, OWN, POST, 'induk', t), r1 = cmtSign(Y.priv, Y.pub, OWN, POST, 'balas 1', t + 1000, top.id), r2 = cmtSign(X.priv, X.pub, OWN, POST, 'balas 2', t + 2000, r1.id);
    assert.throws(() => s.add(r1), (e) => e.code === 'noparent', 'induk belum ada'); assert.strictEqual(s.count(POST), 0, 'tidak ada yang tertulis');
    assert.strictEqual(s.add(top), 'added'); assert.strictEqual(s.add(r1), 'added'); assert.strictEqual(s.add(r2), 'added', 'balasan untuk balasan (bertingkat)'); assert.strictEqual(s.add(r1), 'same');
    assert.deepStrictEqual(s.list(POST).map((c) => c.re || null), [null, top.id, r1.id], 're tersimpan dan keluar di list');
    // induk di postingan LAIN tidak dihitung
    const r3 = cmtSign(Y.priv, Y.pub, OWN, POST2, 'salah postingan', t + 3000, top.id); assert.throws(() => s.add(r3), (e) => e.code === 'noparent', 'induk harus di postingan yang sama');
    // berkas: dimuat ulang tetap membawa re dan balasan diperiksa tanda tangannya
    const s2 = new PageCmt(file, OWN); assert.deepStrictEqual(s2.list(POST).map((c) => c.id), [top.id, r1.id, r2.id]); assert.strictEqual(s2.list(POST)[1].re, top.id);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.map[POST][1].re = hex(0xdd); fs.writeFileSync(file, JSON.stringify(raw));
    assert.deepStrictEqual(new PageCmt(file, OWN).list(POST).map((c) => c.id), [top.id, r2.id], 'berkas yang re-nya diubah tangan: balasan itu dibuang (tanda tangan), yang lain utuh');
    fs.writeFileSync(file, JSON.stringify({ v: 1, map: { [POST]: [top, r1, r2] } }));
    // induk dihapus: balasan TETAP (tanpa kaskade); nisan induk; balasan baru untuk induk itu ditolak
    const s3 = new PageCmt(file, OWN); assert.strictEqual(s3.remove(POST, top.id), true);
    assert.deepStrictEqual(s3.list(POST).map((c) => c.id), [r1.id, r2.id], 'balasan tetap ada (yatim)');
    const r4 = cmtSign(Y.priv, Y.pub, OWN, POST, 'balas yatim', t + 4000, top.id); assert.throws(() => s3.add(r4), (e) => e.code === 'noparent', 'induk sudah dihapus');
    assert.strictEqual(s3.add(cmtSign(X.priv, X.pub, OWN, POST, 'balas ke yatim', t + 5000, r1.id)), 'added', 'membalas anak dari induk yang dihapus tetap boleh (induknya sendiri masih ada)');
    const s4 = new PageCmt(file, OWN); assert.strictEqual(s4.list(POST).length, 3, 'yatim sah saat dibuka ulang (induk tidak diperiksa lagi)'); assert(s4.rm.has(POST + ':' + top.id));
    // ekspor / impor: balasan ikut dan tetap utuh; urutan impor bebas (yatim sementara tidak jadi masalah)
    const d = s4.dump(() => true), s5 = new PageCmt(path.join(tmp, 'cmtB2', 'comments.json'), OWN, (f, x) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, x); });
    const rr = s5.merge({ [POST]: d.map[POST].slice().reverse() }, [], {}); assert.strictEqual(rr.added, 3); assert.strictEqual(rr.bad, 0);
    assert.deepStrictEqual(s5.list(POST).map((c) => c.re || null), d.map[POST].map((c) => c.re || null), 'impor mempertahankan re');
    ok('PageCmt: induk wajib ada (noparent), induk postingan lain ditolak, balasan bertingkat, berkas diperiksa ulang, induk dihapus = balasan tetap (tanpa kaskade), ekspor / impor membawa re');
  }

  // ---- Core sungguhan ----
  const A = mk('A'), B = mk('B'), C = mk('C'); const a = fake(A), b = fake(B);
  await A.start(); await B.start(); await C.start();
  try {
    const p1 = (await a('pgCreate', 'postingan publik', 'public')).post.id, pf = (await a('pgCreate', 'khusus teman', 'friends')).post.id, p2 = (await a('pgCreate', 'postingan lain', 'public')).post.id;
    await A.addPeer('127.0.0.1', B.port); await B.addPeer('127.0.0.1', A.port); await A.addPeer('127.0.0.1', C.port); await C.addPeer('127.0.0.1', A.port);
    await until(() => A.isOnline(A.peers.get(B.id)) && B.isOnline(B.peers.get(A.id)) && A.isOnline(A.peers.get(C.id)) && C.isOnline(C.peers.get(A.id)), 8000, 'online');

    // ---- E0. caps ----
    assert(A.hello().caps.includes('pgt'), "pemilik mengumumkan 'pgt'"); assert(B.peers.get(A.id).caps.includes('pgt'), "B mencatat caps 'pgt' milik A");
    ok("caps 'pgt' diumumkan dan dicatat peer");

    // ---- C. pohon bertingkat dari beberapa orang ----
    // -komentar B / --balasan pemilik A / ---balasan B / --balasan C
    const acts = []; A.on('pgact', (x) => acts.push(x));
    const cB = (await B.pageComment(A.id, p1, 'komentar B')).c;
    assert.strictEqual(cB.re, undefined);
    const rA = await A.pageComment(A.id, p1, 'balasan pemilik', cB.id); assert.strictEqual(rA.st, 'added'); assert.strictEqual(rA.c.re, cB.id, 'pemilik membalas lewat jalur lokal');
    const rB = await B.pageComment(A.id, p1, 'balasan B untuk pemilik', rA.c.id); assert.strictEqual(rB.st, 'added'); assert.strictEqual(rB.c.re, rA.c.id, 'peminta jauh membalas balasan pemilik');
    const rC = await C.pageComment(A.id, p1, 'balasan C untuk B', cB.id); assert.strictEqual(rC.st, 'added');
    assert.deepStrictEqual(reOf(A, A.id, p1), { 'komentar B': null, 'balasan pemilik': cB.id, 'balasan B untuk pemilik': rA.c.id, 'balasan C untuk B': cB.id }, 'pemilik menyimpan pohon');
    assert(acts.length >= 3, 'Halamanku terbuka di pemilik disegarkan (pgact) untuk balasan jauh');
    // yang dilihat penonton: lewat jaringan, tanda tangan diperiksa, re utuh
    const got = await C.pageComments(A.id, p1); assert.strictEqual(got.skipped, 0); assert.strictEqual(got.count, 4);
    assert.deepStrictEqual(Object.fromEntries(got.items.map((c) => [c.text, c.re || null])), reOf(A, A.id, p1), 'penonton menerima pohon yang sama');
    // balasan baru dengan teks sama = komentar BARU (ts beda = tanda tangan beda = id beda), seperti komentar biasa
    const again = await B.pageComment(A.id, p1, 'balasan B untuk pemilik', rA.c.id); assert.notStrictEqual(again.c.id, rB.c.id, 'tanda tangan baru = id baru'); assert.strictEqual(list(A, A.id, p1).length, 5);
    ok('pohon: komentar B -> balasan pemilik (lokal) -> balasan B (jauh); balasan C untuk B; penonton menerima pohon utuh dan terverifikasi');

    // ---- C2. pesan mentah: re palsu / induk tidak ada / lintas postingan ----
    {
      const peer = B.peers.get(A.id), send = async (c, post) => pick(await B._request(peer, B._pgSign(A.id, { t: 'pg_cmt', id: post || p1, c }), 5000));
      const good = cmtSign(B.privKey, B.pub, A.id, p1, 'mentah', undefined, cB.id);
      assert.deepStrictEqual(await send(Object.assign({}, good, { re: rA.c.id })), { t: 'pg_cmt', ok: false, err: 'bad' }, 're diganti di jalan = bad (tanda tangan)');
      const noRe = Object.assign({}, good); delete noRe.re; assert.deepStrictEqual(await send(noRe), { t: 'pg_cmt', ok: false, err: 'bad' }, 're dilepas = bad');
      assert.deepStrictEqual(await send(Object.assign({}, good, { re: 'zz' })), { t: 'pg_cmt', ok: false, err: 'bad' }, 're cacat = bad');
      assert.deepStrictEqual(await send(cmtSign(B.privKey, B.pub, A.id, p1, 'induk fiktif', undefined, hex(0xfee1))), { t: 'pg_cmt', ok: true, r: 'noparent' }, 'induk tidak ada = noparent');
      const other = (await B.pageComment(A.id, p2, 'komentar di postingan lain')).c;
      assert.deepStrictEqual(await send(cmtSign(B.privKey, B.pub, A.id, p1, 'induk di postingan lain', undefined, other.id)), { t: 'pg_cmt', ok: true, r: 'noparent' }, 'induk di postingan lain = noparent');
      assert.deepStrictEqual(await send(good), { t: 'pg_cmt', ok: true, r: 'added' }, 'yang sah diterima');
    }
    ok('pesan mentah: re diganti / dilepas / cacat = bad, induk tidak ada atau di postingan lain = noparent, yang sah diterima');

    // ---- C3. peminta: noparent, validasi tanpa jaringan ----
    {
      const asked = []; const ask = B._pgAsk; B._pgAsk = async (...x) => { asked.push(x); return ask.apply(B, x); };
      try {
        for (const re of ['zz', 5, hex(0xab).toUpperCase(), {}]) assert.strictEqual(await code(B.pageComment(A.id, p1, 'x', re)), 'bad', 're cacat: ' + JSON.stringify(re));
        assert.strictEqual(asked.length, 0, 're cacat ditolak tanpa jaringan');
        assert.strictEqual(await code(B.pageComment(A.id, p1, 'x', hex(0xfee1))), 'noparent', 'jawaban noparent menjadi galat noparent'); assert.strictEqual(asked.length, 1);
        assert.strictEqual(await code(A.pageComment(A.id, p1, 'x', hex(0xfee1))), 'noparent', 'pemilik (lokal) juga');
        assert(/sudah tidak ada/.test((await B.pageComment(A.id, p1, 'x', hex(0xfee1)).catch((e) => e)).message));
      } finally { B._pgAsk = ask; }
    }
    ok('peminta: re cacat = bad tanpa jaringan; induk hilang = noparent (jauh dan lokal)');

    // ---- C4. induk dihapus: balasan tetap; membalas induk yang sudah hilang = noparent ----
    {
      const k = (await B.pageComment(A.id, p1, 'induk yang akan dihapus')).c, kr = (await C.pageComment(A.id, p1, 'anak induk itu', k.id)).c;
      assert.deepStrictEqual(await B.pageCommentDelete(A.id, p1, k.id), { st: 'removed' }, 'penulis menghapus induknya sendiri');
      const left = list(A, A.id, p1).map((c) => c.id); assert(!left.includes(k.id) && left.includes(kr.id), 'balasan orang lain tetap ada (tanpa kaskade)');
      assert.strictEqual((await C.pageComments(A.id, p1)).items.find((c) => c.id === kr.id).re, k.id, 'balasan yatim tetap membawa re ke induk yang sudah hilang');
      assert.strictEqual(await code(C.pageComment(A.id, p1, 'terlambat', k.id)), 'noparent', 'membalas induk yang sudah dihapus ditolak');
      // moderasi pemilik: sama
      const k2 = (await B.pageComment(A.id, p1, 'induk kedua')).c, kr2 = (await B.pageComment(A.id, p1, 'anak kedua', k2.id)).c;
      assert.strictEqual(A.pageCommentRemove(p1, k2.id), true); assert(list(A, A.id, p1).some((c) => c.id === kr2.id), 'moderasi induk tidak membuang balasan');
      assert.strictEqual(await code(B.pageComment(A.id, p1, 'terlambat 2', k2.id)), 'noparent');
    }
    ok('induk dihapus (penulis / pemilik): balasan tetap ada; balasan baru untuk induk itu = noparent');

    // ---- C5. relasi: privasi sama dengan komentar biasa ----
    {
      assert.strictEqual(await B.pageComment(A.id, pf, 'balas privat', cB.id), null, 'postingan Teman, bukan teman: null (tak dibedakan), bukan noparent');
      A.store.friends[B.id] = { st: 'ok' }; const fp = (await B.pageComment(A.id, pf, 'komentar teman')).c; const fq = await B.pageComment(A.id, pf, 'balas teman', fp.id); assert.strictEqual(fq.st, 'added'); delete A.store.friends[B.id];
      A.store.blocked[B.id] = 1; assert.strictEqual(await B.pageComment(A.id, p1, 'diblokir', cB.id), null, 'diblokir: null'); delete A.store.blocked[B.id];
    }
    ok('privasi: balasan mengikuti izin lihat postingan seperti komentar biasa (bukan teman / diblokir = null, tanpa membocorkan induk)');

    // ---- D. caps: pemilik lama (tanpa pgt) = old, tanpa jaringan ----
    {
      const asked = []; const ask = B._pgAsk; B._pgAsk = async (...x) => { asked.push(x); return ask.apply(B, x); };
      const real = B.peers.get.bind(B.peers); B.peers.get = (x) => { const p = real(x); return x === A.id && p ? Object.assign({}, p, { caps: ['rx', 'pg', 'pgm', 'pgr', 'pgc', 'pgd'] }) : p; };
      try {
        const e = await B.pageComment(A.id, p1, 'balasan ke peer lama', cB.id).catch((x) => x); assert.strictEqual(e.code, 'old'); assert(/balasan komentar/.test(e.message), 'pesan khusus balasan');
        assert.strictEqual(asked.length, 0, 'tanpa menyentuh jaringan');
        const ok1 = await B.pageComment(A.id, p1, 'komentar biasa ke peer lama'); assert.strictEqual(ok1.st, 'added', 'komentar BIASA tetap jalan ke peer lama');
        const q = await B.pageCommentQueue(A.id, p1, 'antre balasan', cB.id).catch((x) => x); assert.strictEqual(q.code, 'old', 'antrean: sama'); assert(/balasan komentar/.test(q.message));
        { const qq = B._pcqPeek(); assert(!qq || qq.size === 0, 'tidak ada yang diantrekan'); }
      } finally { B.peers.get = real; B._pgAsk = ask; }
    }
    ok("caps: pemilik tanpa 'pgt' = old (pesan khusus) tanpa jaringan dan tanpa antre; komentar biasa tetap jalan");

    // ---- E. antrean ----
    {
      const evs = []; B.on('pgcq', (e) => evs.push(e));
      const qd = await B.pageCommentQueue(A.id, p1, 'balasan lewat antrean', cB.id); assert.strictEqual(qd.st, 'queued'); assert.strictEqual(qd.c.id.length, 16);
      await until(() => list(A, A.id, p1).some((c) => c.text === 'balasan lewat antrean'), 8000, 'antrean terkirim');
      assert.strictEqual(list(A, A.id, p1).find((c) => c.text === 'balasan lewat antrean').re, cB.id, 'balasan dari antrean membawa re');
      await until(() => evs.some((e) => e.id === qd.c.id && e.ev === 'sent'), 5000, 'event sent');
      // induk hilang selagi menunggu: dibuang 'noparent'
      const k = (await B.pageComment(A.id, p1, 'induk antrean')).c;
      const realOn = B.isOnline; B.isOnline = (p) => (p && p.id === A.id ? false : realOn.call(B, p));
      let q2; try { q2 = await B.pageCommentQueue(A.id, p1, 'balasan yatim antrean', k.id); assert.strictEqual(B.pageCommentPending(A.id, p1).length, 1, 'menunggu'); assert.strictEqual(A.pageCommentRemove(p1, k.id), true); } finally { B.isOnline = realOn; }
      await until(() => evs.some((e) => e.id === q2.c.id && e.ev === 'drop' && e.why === 'noparent'), 8000, 'drop noparent');
      assert(!list(A, A.id, p1).some((c) => c.text === 'balasan yatim antrean'), 'tidak masuk'); assert.strictEqual(B.pageCommentPending(A.id, p1).length, 0, 'antrean bersih');
      for (const re of ['zz', 5]) assert.strictEqual(await code(B.pageCommentQueue(A.id, p1, 'x', re)), 'bad');
    }
    ok("antrean: balasan antre lalu terkirim membawa re; induk dihapus selagi menunggu = dibuang 'noparent'; re cacat = bad");

    // ---- F. IPC + preload ----
    {
      const r1 = await b('pgComment', A.id, p1, 'balasan via IPC', cB.id); assert.strictEqual(r1.ok, true); assert.deepStrictEqual(Object.keys(r1.comment.c).sort(), ['by', 'id', 're', 'text', 'ts'], 'hanya bidang ini; tanpa pub / sig / post'); assert.strictEqual(r1.comment.c.re, cB.id);
      const r0 = await b('pgComment', A.id, p1, 'tingkat atas via IPC'); assert.deepStrictEqual(Object.keys(r0.comment.c).sort(), ['by', 'id', 'text', 'ts'], 'komentar biasa tanpa re (bentuk lama persis)');
      const rl = await b('pgComments', A.id, p1, { limit: 100 }); const m = Object.fromEntries(rl.comments.items.map((c) => [c.text, c.re || null])); assert.strictEqual(m['balasan via IPC'], cB.id); assert.strictEqual(m['tingkat atas via IPC'], null);
      for (const re of ['zz', 5, hex(0xab).toUpperCase(), {}, true]) { const x = await b('pgComment', A.id, p1, 'x', re); assert.strictEqual(x.ok, false, 'bad: ' + JSON.stringify(re)); }
      const nf = await b('pgComment', A.id, p1, 'x', hex(0xfee1)); assert.deepStrictEqual([nf.ok, nf.code], [false, 'noparent'], 'noparent diteruskan sebagai kode galat');
      const rq = await b('pgCommentQueue', A.id, p1, 'antre via IPC', cB.id); assert.strictEqual(rq.ok, true); assert.strictEqual(rq.queued.c.re, cB.id);
      const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'); assert(/pgComment: \(peerId, postId, text, re\)/.test(pre) && /pgCommentQueue: \(peerId, postId, text, re\)/.test(pre), 'preload meneruskan re');
    }
    ok('IPC: re diteruskan dan keluar hanya pada balasan, re cacat = bad tanpa menyentuh Core, noparent = kode galat, antrean + preload');
  } finally {
    for (const c of [A, B, C]) { try { await c.stop(); } catch (e) {} }
  }
  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

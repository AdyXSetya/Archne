'use strict';
// Tes Halaman 5c-3: aturan privasi komentar (model Facebook) + nisan penghapusan. Penyimpanan (PageCmt / PageStore) dan dua-tiga Core sungguhan.
// Aturan: (1) menulis = izin lihat saat itu; (2) komentar yang sudah diterima TETAP ADA sampai pemilik menghapus (putus teman / blokir tidak membuangnya);
// (3) membaca = izin lihat saat ini; (4) yang dihapus pemilik tetap terhapus (kirim ulang persis sama ditolak, komentar baru boleh); nisan tahan restart, dibuang bersama postingan, terbatas.
// Dasar: test/archne-pagecmt.js (penyimpanan), test/pagecmtnet.js (jaringan), test/pagecmtrm.js (hapus, 5c-1), test/archne-pagecq.js (antrean 4c).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { PageCmt, CMT_RM_MAX, cmtSign } = require('../src/archne-pagecmt');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pgcmtpriv-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 });
const hex = (n) => n.toString(16).padStart(16, '0');
const file = (core) => path.join(core.opts.dataDir, 'pages', 'comments.json');
const raw = (core) => JSON.parse(fs.readFileSync(file(core), 'utf8'));

(async () => {
  // ---- A. PageCmt murni: nisan ----
  {
    const crypto = require('crypto'); const k = crypto.generateKeyPairSync('ed25519'), pub = k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const OWN = hex(1), P = hex(2), Q = hex(3), f = path.join(tmp, 'cm-a.json');
    const sign = (post, text, t) => cmtSign(k.privateKey, pub, OWN, post, text, t);
    const c1 = sign(P, 'satu', 1000), c2 = sign(P, 'dua', 2000), cq = sign(Q, 'di Q', 3000);
    let m = new PageCmt(f, OWN);
    assert.strictEqual(m.add(c1, 5000), 'added'); m.add(c2, 5000); m.add(cq, 5000);
    assert(!('rm' in raw0(f)), 'tanpa penghapusan: berkas tanpa field rm (bentuk lama persis)');
    assert.strictEqual(m.remove(P, c1.id), true);
    assert.strictEqual(m.add(c1, 5000), 'removed', 'kirim ulang persis sama = removed'); assert.strictEqual(m.count(P), 1, 'tidak masuk lagi'); assert.strictEqual(m.add(c2, 5000), 'same');
    assert.strictEqual(m.remove(P, c1.id), false, 'ulang = false, nisan tidak ganda'); assert.deepStrictEqual(raw0(f).rm, [P + ':' + c1.id]);
    assert.strictEqual(m.remove(P, 'f'.repeat(16)), false); assert.strictEqual(raw0(f).rm.length, 1, 'komentar yang tidak ada tidak diberi nisan');
    // komentar BARU (teks sama, ts beda = tanda tangan baru) boleh
    const c1b = sign(P, 'satu', 1001); assert.notStrictEqual(c1b.id, c1.id); assert.strictEqual(m.add(c1b, 5000), 'added', 'komentar baru dengan teks sama = id baru = boleh');
    // nisan terikat ke postingan: id sama di postingan lain tak ada (tanda tangan menutup id postingan), tapi kuncinya tetap per postingan
    assert.strictEqual(m.rm.has(Q + ':' + c1.id), false);
    // tahan restart; berkas yang diubah tangan tak bisa menghidupkan lagi komentar bernisan
    m = new PageCmt(f, OWN); assert.strictEqual(m.add(c1, 5000), 'removed', 'nisan tahan restart'); assert.deepStrictEqual(m.list(P).map((x) => x.id).sort(), [c1b.id, c2.id].sort());
    { const j = raw0(f); j.map[P].push(c1); fs.writeFileSync(f, JSON.stringify(j)); m = new PageCmt(f, OWN); assert(!m.list(P).some((x) => x.id === c1.id), 'komentar bernisan yang diselipkan ke berkas tidak dimuat'); }
    // nisan cacat di berkas diabaikan
    { const j = raw0(f); j.rm.push('bukan-nisan', 5, null, 'ZZ:YY'); fs.writeFileSync(f, JSON.stringify(j)); m = new PageCmt(f, OWN); assert.strictEqual(m.rm.size, 1); }
    // drop / retain membuang nisan
    m = new PageCmt(f, OWN); m.drop(P); assert.strictEqual(m.rm.size, 0); assert.deepStrictEqual(raw0(f).rm || [], [], 'nisan ikut dibuang bersama postingannya');
    m.add(c1, 5000); m.remove(P, c1.id) || 0; // c1 tak ada lagi setelah drop -> add menambah lagi (nisan sudah dibuang), lalu hapus
    assert.strictEqual(m.rm.size, 1); m.retain((id) => id === Q); assert.strictEqual(m.rm.size, 0, 'retain: nisan postingan yatim dibuang');
    ok('PageCmt: nisan menolak kirim ulang yang sama persis, komentar baru boleh, tahan restart, berkas ubahan tak menghidupkan, drop / retain ikut membuang');
    // gagal tulis: komentar kembali, nisan batal
    m = new PageCmt(path.join(tmp, 'cm-b.json'), OWN, (fl, s) => fs.writeFileSync(fl, s)); m.add(c1, 5000);
    const failing = new PageCmt(path.join(tmp, 'cm-c.json'), OWN, (() => { let n = 0; return (fl, s) => { if (n++ >= 1) throw Object.assign(new Error('x'), { code: 'EACCES' }); fs.writeFileSync(fl, s); }; })());
    failing.add(c1, 5000); assert.throws(() => failing.remove(P, c1.id), (e) => e.code === 'EACCES');
    assert.strictEqual(failing.count(P), 1, 'gagal tulis: komentar kembali'); assert.strictEqual(failing.rm.size, 0, 'gagal tulis: nisan dibatalkan'); assert.strictEqual(failing.add(c1, 5000), 'same');
    ok('gagal tulis saat menghapus: komentar kembali dan nisan dibatalkan (kirim ulang tidak ditolak palsu)');
    // batas: tertua lepas
    const big = new PageCmt(path.join(tmp, 'cm-d.json'), OWN, () => {});
    const keys = []; for (let i = 0; i < CMT_RM_MAX + 3; i++) keys.push(hex(2) + ':' + hex(100 + i));
    for (const kk of keys) big.rm.add(kk);
    const extra = sign(P, 'penutup', 9000); big.map[P] = [extra]; big.total = 1; big.remove(P, extra.id);
    assert.strictEqual(big.rm.size, CMT_RM_MAX, 'dibatasi'); assert(big.rm.has(P + ':' + extra.id) && !big.rm.has(keys[0]), 'yang terbaru masuk, yang tertua lepas');
    ok('batas nisan CMT_RM_MAX: penghapusan baru masuk, yang tertua dilepas');
  }
  function raw0(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }

  // ---- B. Core sungguhan: privasi lintas relasi ----
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D');
  await A.start(); await B.start(); await C.start(); await D.start();
  try {
    for (const X of [B, C, D]) { await A.addPeer('127.0.0.1', X.port); await X.addPeer('127.0.0.1', A.port); }
    await until(() => [B, C, D].every((X) => A.isOnline(A.peers.get(X.id)) && X.isOnline(X.peers.get(A.id))), 8000, 'online');
    const ps = A.pageStore(); A.store.friends[B.id] = { st: 'ok' }; A.store.friends[C.id] = { st: 'ok' };
    const pub = ps.create({ text: 'publik' }).id, frd = ps.create({ text: 'teman', priv: 'friends' }).id;

    // (1) menulis = izin lihat saat itu: D (publik biasa) tidak boleh berkomentar di postingan Teman, boleh di Publik
    assert.strictEqual(await D.pageComment(A.id, frd, 'D coba'), null, 'D tak bisa lihat postingan Teman: null');
    assert.strictEqual((await D.pageComment(A.id, pub, 'D publik')).st, 'added', 'D boleh di Publik');
    // B (teman) boleh di postingan Teman
    const rb = await B.pageComment(A.id, frd, 'B teman'); assert.strictEqual(rb.st, 'added');
    const rc = await C.pageComment(A.id, frd, 'C teman'); assert.strictEqual(rc.st, 'added');
    ok('(1) menulis = izin lihat: bukan-teman ditolak di postingan Teman, diterima di Publik; teman diterima di Teman');

    // (2) putus pertemanan dengan B: komentar B tetap ada dan terbaca teman lain (C)
    delete A.store.friends[B.id];
    let cl = await C.pageComments(A.id, frd); assert.deepStrictEqual(cl.items.map((x) => x.text).sort(), ['B teman', 'C teman'], 'B bukan teman lagi, komentarnya tetap');
    assert.strictEqual(A.pageStore().commentsFor(A.id, frd).length, 2, 'dan tetap di penyimpanan A'); assert(raw(A).map[frd].some((x) => x.id === rb.c.id), 'dan di comments.json');
    // (3) B sendiri kehilangan izin baca postingan Teman itu; komentar baru B juga ditolak
    assert.strictEqual(await B.pageComments(A.id, frd), null, 'B tak boleh membaca lagi (izin lihat saat ini)');
    assert.strictEqual(await B.pageComment(A.id, frd, 'B lagi'), null, 'B tak boleh menulis lagi');
    // blokir C: komentar C tetap ada (hanya pemilik yang menghapus)
    A.store.blocked[C.id] = 1; delete A.store.friends[C.id]; A.store.friends[B.id] = { st: 'ok' };
    cl = await B.pageComments(A.id, frd); assert.deepStrictEqual(cl.items.map((x) => x.text).sort(), ['B teman', 'C teman'], 'C diblokir, komentarnya tetap');
    assert.strictEqual(await C.pageComments(A.id, frd), null, 'C yang diblokir tak bisa membaca');
    // diblokir lalu dibuka: komentar tak berubah
    delete A.store.blocked[C.id]; assert.strictEqual(A.pageStore().commentsFor(A.id, frd).length, 2);
    ok('(2)(3) putus teman / blokir tidak membuang komentar yang sudah diterima; penulis yang kehilangan izin tak bisa membaca atau menulis lagi');

    // (4) pemilik menghapus komentar B: tetap terhapus walau B mengirim ulang persis sama (kirim langsung dan lewat antrean 4c)
    A.store.friends[B.id] = { st: 'ok' }; A.store.friends[C.id] = { st: 'ok' };
    const full = A.pageStore().commentsFor(A.id, frd).find((x) => x.id === rb.c.id); assert(full);
    assert.strictEqual(A.pageCommentRemove(frd, rb.c.id), true);
    let r = await B._pgAsk(A.id, { t: 'pg_cmt', id: frd, c: full }, 8000); assert.deepStrictEqual([r.ok, r.r], [true, null], 'kirim ulang persis sama = r:null (tak dibedakan dari tidak ada)');
    assert(!A.pageStore().commentsFor(A.id, frd).some((x) => x.id === rb.c.id), 'tidak masuk lagi');
    // komentar BARU dari B boleh (teks sama)
    await sleep(5); const nb = await B.pageComment(A.id, frd, 'B teman'); assert.strictEqual(nb.st, 'added'); assert.notStrictEqual(nb.c.id, rb.c.id, 'id baru');
    // antrean 4c: entri yang sama persis dijatuhkan sebagai 'gone'
    const evs = []; B.on('pgcq', (e) => evs.push(e));
    B._pcqStore().add(A.id, frd, full);
    await until(() => evs.some((e) => e.id === full.id), 8000, 'antrean menjatuhkan');
    const ev = evs.find((e) => e.id === full.id); assert.deepStrictEqual([ev.ev, ev.why], ['drop', 'gone'], JSON.stringify(ev)); assert(!A.pageStore().commentsFor(A.id, frd).some((x) => x.id === full.id));
    ok('(4) yang dihapus tetap terhapus: kirim ulang langsung = r:null, lewat antrean = "gone"; komentar baru dari orang yang sama tetap diterima');

    // nisan tahan restart Core A dan hilang bersama postingannya
    await A.stop(); const A2 = new Core({ dataDir: path.join(tmp, 'A'), downloadDir: path.join(tmp, 'A-dl'), name: 'A', discovery: false, tickMs: 100, syncMs: 150 });
    try {
      await A2.start(); assert.strictEqual(A2.id, A.id, 'identitas sama');
      const ps2 = A2.pageStore(); assert.strictEqual(ps2.cmt.add(full, Date.now()), 'removed', 'nisan tahan restart Core');
      assert.strictEqual(ps2.remove(frd), true); assert.strictEqual(ps2.cmt.rm.size, 0, 'postingan dihapus = nisannya ikut dibuang');
    } finally { try { await A2.stop(); } catch {} }
    ok('nisan tahan restart Core dan dibuang bersama postingannya');
  } finally { for (const X of [A, B, C, D]) { try { await X.stop(); } catch {} } }
  console.log('\n' + pass + ' tes lulus');
})().catch((e) => { console.error(e); process.exit(1); });

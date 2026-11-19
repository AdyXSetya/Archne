'use strict';
// Tes Halaman 5g: REAKSI pada KOMENTAR (bukan hanya postingan). Pesan jaringan baru pg_rc { id, cid, e } (caps 'pgk'); reaksi komentar ikut di jawaban pg_cml sebagai field `rx` di luar bagian yang ditandatangani.
// Kelompok: A murni (PageCmtRx), B PageStore (izin, komentar harus ada, pembuangan, berkas), C jaringan dengan tiga Core (reaksi, ganti, cabut, pemilik, who hanya lokal, relasi, laju, tanda tangan),
// D caps (peer lama = old tanpa jaringan), E validasi jawaban pemilik (wireCmtRx), F IPC + preload. Tampilan: test/pagecmtrxui.js. Reaksi postingan: test/archne-pagerx.js, test/rxcore.js.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { PageCmtRx, PageRx } = require('../src/archne-pagerx');
const { PageStore, wireCmtRx, pgSignReq, pgVerifyReq } = require('../src/archne-pagestore');
const { cmtSign } = require('../src/archne-pagecmt');
const RX = require('../src/archne-reactions');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pgcrx-'));
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
const pick = (x) => JSON.parse(JSON.stringify({ t: x.t, ok: x.ok, r: x.r, err: x.err }));
const J = (x) => JSON.parse(JSON.stringify(x));
const srt = (v) => Object.assign({}, v, { rx: v.rx.slice().sort((x, y) => (x.e < y.e ? -1 : 1)) }); // urutan chip pada jumlah sama tidak dijamin: bandingkan tanpa urutan

(async () => {
  // ---- A. murni: PageCmtRx ----
  {
    const f = path.join(tmp, 'A', 'cmtreactions.json'); fs.mkdirSync(path.dirname(f), { recursive: true });
    const r = new PageCmtRx(f), P = hex(1), C1 = hex(2), C2 = hex(3), U1 = hex(0x11), U2 = hex(0x12);
    assert.deepStrictEqual(r.view(P, C1, U1), { rx: [], mine: '' }, 'kosong');
    assert.strictEqual(r.set(U1, P, C1, '👍', 1000), 'applied'); assert.strictEqual(r.set(U1, P, C1, '👍', 1001), 'same', 'sama = tanpa tulis');
    assert.strictEqual(r.set(U2, P, C1, '🩷', 1002), 'applied'); assert.strictEqual(r.set(U2, P, C2, '👍', 1003), 'applied');
    assert.deepStrictEqual(r.view(P, C1, U1), { rx: [{ e: '👍', n: 1 }, { e: '🩷', n: 1 }], mine: '👍' }, 'tampilan penonton: jumlah + reaksiku');
    assert(!('who' in r.view(P, C1, U1)), 'penonton tidak pernah mendapat daftar pelaku');
    assert.deepStrictEqual(r.view(P, C2, U1), { rx: [{ e: '👍', n: 1 }], mine: '' }, 'tiap komentar punya reaksinya sendiri');
    assert.strictEqual(r.set(U1, P, C1, '🩷', 1004), 'applied'); assert.deepStrictEqual(r.view(P, C1, U1), { rx: [{ e: '🩷', n: 2 }], mine: '🩷' }, 'ganti emoji: satu reaksi per orang');
    assert.strictEqual(r.set(U1, P, C1, '', 1005), 'applied'); assert.deepStrictEqual(r.view(P, C1, U1), { rx: [{ e: '🩷', n: 1 }], mine: '' }, 'cabut');
    assert.deepStrictEqual(r.owner(P, C1, U1).who, [{ e: '🩷', by: [U2] }], 'owner(): daftar pelaku');
    assert.deepStrictEqual(Object.keys(r.many(P, [C1, C2, hex(9)], U1, false)).sort(), [C1, C2].sort(), 'many(): hanya komentar yang punya reaksi');
    assert(!('who' in r.many(P, [C1], U1, false)[C1]) && r.many(P, [C1], U1, true)[C1].who.length === 1, 'many(): who hanya bila diminta pemilik');
    // validasi
    for (const bad of [['zz', P, C1], [U1, 'zz', C1], [U1, P, 'zz'], [U1, P, '']]) assert.throws(() => r.set(bad[0], bad[1], bad[2], '👍'), /Id tidak valid/);
    for (const e of ['abc', '👍👍', 'x']) assert.throws(() => r.set(U1, P, C1, e), /Emoji tidak valid/, 'emoji: ' + e);
    // berkas: bertahan, dan tidak sama dengan berkas reaksi postingan
    const r2 = new PageCmtRx(f); assert.deepStrictEqual(r2.view(P, C1, U2), { rx: [{ e: '🩷', n: 1 }], mine: '🩷' }, 'dibuka ulang dari berkas');
    // kunci komentar tidak bentrok dengan kunci postingan (id + id)
    const pr = new PageRx(path.join(tmp, 'A', 'reactions.json')); pr.set(U1, P, '👍', 1); assert.deepStrictEqual(r2.view(P, P, U1), { rx: [], mine: '' }, 'reaksi postingan tidak tampak sebagai reaksi komentar');
    // pembuangan
    r.drop(P, C2); assert.deepStrictEqual(r.view(P, C2, U2), { rx: [], mine: '' }); assert.strictEqual(r.view(P, C1, U2).mine, '🩷', 'komentar lain tak tersentuh');
    r.set(U1, hex(7), C1, '👍'); assert.strictEqual(r.dropPost(P), 1, 'dropPost membuang semua komentar postingan itu'); assert.strictEqual(r.view(hex(7), C1, U1).mine, '👍', 'postingan lain tak tersentuh');
    r.set(U1, P, C1, '👍'); r.set(U1, P, C2, '👍'); assert(r.retain((p, c) => c === C1) >= 1, 'retain mengembalikan jumlah yang dibuang');
    assert.strictEqual(r.view(P, C2, U1).mine, '', 'retain: yang tak lolos dibuang'); assert.strictEqual(r.view(P, C1, U1).mine, '👍');
    // batas 256 orang per komentar
    const big = new PageCmtRx(path.join(tmp, 'A', 'big.json')), BP = hex(5), BC = hex(6);
    for (let i = 0; i < RX.RX_MAX_REG_PER_MSG; i++) big.set(hex(0x1000 + i), BP, BC, '👍', 10 + i);
    assert.throws(() => big.set(hex(0x9999), BP, BC, '👍', 9999), /Terlalu banyak/, 'orang ke-257 ditolak'); assert.strictEqual(big.view(BP, BC, hex(0x1000)).rx[0].n, RX.RX_MAX_REG_PER_MSG);
    assert.strictEqual(big.set(hex(0x1000), BP, BC, '', 20000), 'applied', 'yang sudah ada tetap bisa mencabut');
    ok('PageCmtRx: pasang / ganti / cabut / sama, tampilan penonton tanpa pelaku, owner() dengan pelaku, many(), validasi, berkas, kunci tak bentrok dengan postingan, drop / dropPost / retain, batas 256');
  }

  // ---- B. PageStore ----
  {
    const dir = path.join(tmp, 'B'), OWN = hex(0xa0), FR = hex(0xb0), PUB = hex(0xc0), BL = hex(0xd0);
    const lvl = { [OWN]: 'owner', [FR]: 'friend', [PUB]: 'public', [BL]: 'blocked' };
    const ps = new PageStore(dir, { relation: (id) => lvl[id] || 'public', ownerId: OWN });
    const crypto = require('crypto'), k = crypto.generateKeyPairSync('ed25519'), pub = k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const idOfPub = (p) => crypto.createHash('sha256').update(Buffer.from(p, 'base64')).digest('hex').slice(0, 16);
    const W = idOfPub(pub); lvl[W] = 'public';
    const post = ps.create({ text: 'publik' }), frd = ps.create({ text: 'teman', priv: 'friends' });
    const c1 = cmtSign(k.privateKey, pub, OWN, post.id, 'komentar satu'), c2 = cmtSign(k.privateKey, pub, OWN, frd.id, 'komentar di teman');
    assert.strictEqual(ps.comment(W, post.id, c1), 'added'); lvl[W] = 'friend'; assert.strictEqual(ps.comment(W, frd.id, c2), 'added'); lvl[W] = 'public';
    // izin
    assert.deepStrictEqual(ps.reactComment(PUB, post.id, c1.id, '👍'), { rx: [{ e: '👍', n: 1 }], mine: '👍' }, 'penonton publik bereaksi di postingan publik');
    assert.strictEqual(ps.reactComment(PUB, frd.id, c2.id, '👍'), null, 'postingan Teman: bukan teman = null');
    assert.strictEqual(ps.reactComment(PUB, frd.id, c2.id, 'bukan emoji'), null, 'null SEBELUM emoji diperiksa: galat emoji tidak membocorkan postingan Teman');
    assert.strictEqual(ps.reactComment(FR, frd.id, c2.id, '🩷').mine, '🩷', 'teman boleh');
    assert.strictEqual(ps.reactComment(BL, post.id, c1.id, '👍'), null, 'diblokir = null');
    assert.strictEqual(ps.reactComment(OWN, post.id, c1.id, '🤣').mine, '🤣', 'pemilik boleh bereaksi di komentar siapa pun');
    assert.strictEqual(ps.reactComment(PUB, post.id, hex(0xdead), '👍'), null, 'komentar tidak ada = null');
    assert.strictEqual(ps.reactComment(PUB, post.id, c2.id, '👍'), null, 'komentar milik postingan lain = null');
    assert.strictEqual(ps.reactComment('zz', post.id, c1.id, '👍'), null); assert.strictEqual(ps.reactComment(PUB, post.id, 'zz', '👍'), null);
    assert.throws(() => ps.reactComment(PUB, post.id, c1.id, 'bukan emoji'), /Emoji tidak valid/);
    // tampilan
    const fv = ps.commentReactionsFor(PUB, post.id, [c1.id]); assert.deepStrictEqual(fv[c1.id].rx.map((x) => x.e).sort(), ['🤣', '👍'].sort()); assert.strictEqual(fv[c1.id].mine, '👍'); assert(!('who' in fv[c1.id]), 'tanpa pelaku untuk penonton');
    assert.strictEqual(ps.commentReactionsFor(PUB, frd.id, [c2.id]), null, 'tak boleh melihat = null'); assert.strictEqual(ps.commentReactionsFor(BL, post.id, [c1.id]), null);
    const ov = ps.ownerCommentReactions(OWN, post.id, [c1.id]); assert(Array.isArray(ov[c1.id].who) && ov[c1.id].who.length === 2, 'pemilik mendapat pelaku'); assert.strictEqual(ov[c1.id].mine, '🤣');
    assert.strictEqual(ps.ownerCommentReactions(OWN, hex(0xbad), [c1.id]), null);
    // reaksi postingan tidak tercampur
    assert.deepStrictEqual(ps.rx.view(post.id, PUB), { rx: [], mine: '' }, 'reaksi komentar bukan reaksi postingan');
    // berkas dibuka ulang
    const ps2 = new PageStore(dir, { relation: (id) => lvl[id] || 'public', ownerId: OWN }); assert.strictEqual(ps2.commentReactionsFor(PUB, post.id, [c1.id])[c1.id].mine, '👍', 'bertahan di berkas');
    // komentar dihapus (pemilik / penulis) = reaksinya ikut hilang
    assert.strictEqual(ps.removeComment(post.id, c1.id), true); assert.deepStrictEqual(ps.crx.view(post.id, c1.id, PUB), { rx: [], mine: '' }, 'dihapus pemilik: reaksi ikut');
    const c3 = cmtSign(k.privateKey, pub, OWN, post.id, 'komentar tiga'); ps.comment(W, post.id, c3); ps.reactComment(PUB, post.id, c3.id, '👍');
    assert.strictEqual(ps.removeCommentBy(W, post.id, c3.id), 'removed'); assert.deepStrictEqual(ps.crx.view(post.id, c3.id, PUB), { rx: [], mine: '' }, 'dihapus penulis: reaksi ikut');
    // postingan dihapus = semua reaksi komentarnya ikut
    ps.reactComment(FR, frd.id, c2.id, '🩷'); assert.strictEqual(ps.remove(frd.id), true); assert.deepStrictEqual(ps.crx.view(frd.id, c2.id, FR), { rx: [], mine: '' }, 'postingan dihapus: reaksi komentarnya ikut');
    // yatim di berkas dibuang saat dibuka (komentar tidak ada)
    const f = path.join(dir, 'cmtreactions.json'), j = JSON.parse(fs.readFileSync(f, 'utf8')); const raw = new PageCmtRx(path.join(tmp, 'B', 'tmp.json')); raw.set(PUB, post.id, hex(0xdead), '👍'); Object.assign(j.map, raw.map); fs.writeFileSync(f, JSON.stringify(j));
    const ps3 = new PageStore(dir, { relation: (id) => lvl[id] || 'public', ownerId: OWN }); assert.deepStrictEqual(ps3.crx.view(post.id, hex(0xdead), PUB), { rx: [], mine: '' }, 'reaksi yatim dibuang saat dibuka');
    // berkas rusak = mulai kosong, tidak melempar
    fs.writeFileSync(f, '{rusak'); assert.doesNotThrow(() => new PageStore(dir, { relation: () => 'public', ownerId: OWN }));
    // komentar dimatikan (tanpa ownerId) = tidak ada yang bisa dinilai
    const off = new PageStore(path.join(tmp, 'B2'), { relation: () => 'owner' }); const op = off.create({ text: 'x' }); assert.strictEqual(off.reactComment(OWN, op.id, hex(1), '👍'), null); assert.strictEqual(off.commentReactionsFor(OWN, op.id, []), null);
    ok('PageStore: izin = izin lihat + komentar harus ada, null sebelum emoji, tanpa pelaku untuk penonton, pelaku untuk pemilik, berkas, dihapus (pemilik / penulis / postingan) = reaksi ikut, yatim dibuang, berkas rusak aman');
  }

  // ---- Core sungguhan ----
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D'); const a = fake(A);
  await A.start(); await B.start(); await C.start(); await D.start();
  try {
    const p1 = (await a('pgCreate', 'postingan publik', 'public')).post.id, pf = (await a('pgCreate', 'khusus teman', 'friends')).post.id;
    for (const X of [B, C, D]) { await A.addPeer('127.0.0.1', X.port); await X.addPeer('127.0.0.1', A.port); }
    await until(() => [B, C, D].every((X) => A.isOnline(A.peers.get(X.id)) && X.isOnline(X.peers.get(A.id))), 8000, 'online');
    A.store.friends[B.id] = { st: 'ok' }; A.store.blocked[D.id] = 1;

    // ---- C0. caps ----
    assert(A.hello().caps.includes('pgk') && B.peers.get(A.id).caps.includes('pgk'), "caps 'pgk' diumumkan dan dicatat");
    ok("caps 'pgk' diumumkan dan dicatat peer");

    // ---- C1. reaksi lewat jaringan ----
    const cB = (await B.pageComment(A.id, p1, 'komentar B')).c, cC = (await C.pageComment(A.id, p1, 'komentar C')).c;
    const acts = []; A.on('pgact', (x) => acts.push(x));
    assert.deepStrictEqual(await C.pageReactComment(A.id, p1, cB.id, '👍'), { rx: [{ e: '👍', n: 1 }], mine: '👍' }, 'C bereaksi pada komentar B');
    assert.deepStrictEqual(srt(await B.pageReactComment(A.id, p1, cB.id, '🩷')), srt({ rx: [{ e: '👍', n: 1 }, { e: '🩷', n: 1 }], mine: '🩷' }), 'B bereaksi pada komentarnya sendiri; mine = reaksi B');
    assert.strictEqual(acts.filter((x) => x.kind === 'rx' && x.post === p1).length, 2, "pgact kind 'rx' untuk tiap reaksi komentar (Halamanku terbuka menyegarkan diri)");
    const own = await A.pageReactComment(A.id, p1, cB.id, '👍'); assert.deepStrictEqual(srt(own).rx, srt({ rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }] }).rx, 'pemilik bereaksi lewat jalur lokal'); assert.strictEqual(own.mine, '👍');
    assert.deepStrictEqual(srt(await C.pageReactComment(A.id, p1, cB.id, '🤣')), srt({ rx: [{ e: '👍', n: 1 }, { e: '🩷', n: 1 }, { e: '🤣', n: 1 }], mine: '🤣' }), 'ganti emoji: satu reaksi per orang');
    assert.deepStrictEqual((await C.pageReactComment(A.id, p1, cB.id, '')).mine, '', 'cabut');
    await C.pageReactComment(A.id, p1, cB.id, '👍');
    // reaksi komentar tidak menyentuh reaksi postingan
    assert.deepStrictEqual(A.pageStore().rx.view(p1, C.id), { rx: [], mine: '' }, 'reaksi postingan tetap kosong');
    // yang dilihat penonton: field rx di pg_cml, viewer-spesifik, tanpa pelaku
    const gotC = await C.pageComments(A.id, p1), gotB = await B.pageComments(A.id, p1);
    assert.strictEqual(gotC.skipped, 0); assert(gotC.rx && gotC.rx[cB.id], 'rx menyertai halaman komentar'); assert(!gotC.rx[cC.id], 'komentar tanpa reaksi tidak muncul di rx');
    assert.deepStrictEqual(srt(J(gotC.rx[cB.id])), srt({ rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }], mine: '👍' }), 'C melihat jumlah dan reaksinya sendiri');
    assert.strictEqual(gotB.rx[cB.id].mine, '🩷', 'B melihat reaksinya sendiri (mine beda per penonton)'); assert(!('who' in gotC.rx[cB.id]) && !('who' in gotB.rx[cB.id]), 'penonton jauh tidak pernah mendapat pelaku');
    const loc = await A.pageComments(A.id, p1); assert(Array.isArray(loc.rx[cB.id].who) && loc.rx[cB.id].who.length === 2, 'jalur lokal pemilik membawa pelaku'); assert.deepStrictEqual(loc.rx[cB.id].who.map((w) => w.by.length).sort(), [1, 2], '👍 oleh C dan pemilik, 🩷 oleh B');
    // komentar itu sendiri tidak berubah (tanda tangan utuh)
    assert.deepStrictEqual(gotC.items.map((c) => c.id).sort(), [cB.id, cC.id].sort()); assert.strictEqual(gotC.items.find((c) => c.id === cB.id).sig, cB.sig);
    ok('jaringan: C / B / pemilik bereaksi, ganti, cabut; pgact rx; reaksi postingan tak tercampur; penonton menerima rx per-penonton tanpa pelaku, pemilik lokal dengan pelaku');

    // ---- C2. relasi, komentar hilang, validasi tanpa jaringan ----
    {
      const asked = []; const ask = C._pgAsk; C._pgAsk = async (...x) => { asked.push(x); return ask.apply(C, x); };
      try {
        assert.strictEqual(await C.pageReactComment(A.id, p1, hex(0xdead), '👍'), null, 'komentar tidak ada = null'); assert.strictEqual(asked.length, 1);
        assert.strictEqual(await code(C.pageReactComment(A.id, p1, cB.id, 'bukan emoji')), 'bad'); assert.strictEqual(await code(C.pageReactComment(A.id, p1, 'zz', '👍')), 'bad'); assert.strictEqual(await code(C.pageReactComment('zz', p1, cB.id, '👍')), 'bad'); assert.strictEqual(await code(C.pageReactComment(A.id, p1, cB.id, 5)), 'bad');
        assert.strictEqual(asked.length, 1, 'cacat ditolak tanpa jaringan');
      } finally { C._pgAsk = ask; }
      const cf = (await B.pageComment(A.id, pf, 'komentar teman')).c; // B teman
      assert.strictEqual((await B.pageReactComment(A.id, pf, cf.id, '👍')).mine, '👍', 'teman bereaksi di postingan Teman');
      assert.strictEqual(await C.pageReactComment(A.id, pf, cf.id, '👍'), null, 'bukan teman: null (sama dengan "tidak ada")');
      assert.strictEqual(await D.pageReactComment(A.id, p1, cB.id, '👍').catch(() => null), null, 'diblokir pemilik: null (atau galat peminta), tanpa bocoran'); // D diblokir A: jawaban r null
      // komentar dihapus pemilik: reaksi pada komentar itu ditolak (null)
      const gone = (await B.pageComment(A.id, p1, 'akan dihapus')).c; await C.pageReactComment(A.id, p1, gone.id, '👍');
      assert.strictEqual(A.pageCommentRemove(p1, gone.id), true); assert.strictEqual(await C.pageReactComment(A.id, p1, gone.id, '🩷'), null, 'komentar sudah dihapus = null');
      assert.deepStrictEqual(A.pageStore().crx.view(p1, gone.id, C.id), { rx: [], mine: '' }, 'reaksinya ikut terhapus di pemilik');
    }
    ok('relasi: teman ya, bukan teman / diblokir null; cacat = bad tanpa jaringan; komentar hilang = null dan reaksinya ikut hilang');

    // ---- C3. pesan mentah: tanda tangan menutup id, cid, e; bentuk; laju ----
    {
      const peer = C.peers.get(A.id), send = async (o, tamper) => { const s = C._pgSign(A.id, o); return pick(await C._request(peer, tamper ? Object.assign({}, s, tamper) : s, 5000)); };
      const base = { t: 'pg_rc', id: p1, cid: cB.id, e: '👍' };
      assert.deepStrictEqual(await send(base, { e: '🩷' }), { t: 'pg_rc', ok: false, err: 'auth' }, 'emoji diganti di jalan = auth');
      assert.deepStrictEqual(await send(base, { cid: cC.id }), { t: 'pg_rc', ok: false, err: 'auth' }, 'id komentar diganti di jalan = auth');
      assert.deepStrictEqual(await send(base, { id: pf }), { t: 'pg_rc', ok: false, err: 'auth' }, 'id postingan diganti di jalan = auth');
      const noCid = C._pgSign(A.id, { t: 'pg_rc', id: p1, e: '👍' }); assert.deepStrictEqual(pick(await C._request(peer, noCid, 5000)), { t: 'pg_rc', ok: false, err: 'bad' }, 'tanpa cid = bad');
      for (const o of [{ cid: 'zz' }, { cid: 5 }, { id: 'zz' }, { e: 'bukan emoji' }, { e: 5 }, { e: null }]) assert.deepStrictEqual(await send(Object.assign({}, base, o)), { t: 'pg_rc', ok: false, err: 'bad' }, 'bentuk salah: ' + JSON.stringify(o));
      const cab = await send(Object.assign({}, base, { e: '' })); assert.strictEqual(cab.ok, true); assert.strictEqual(cab.r.mine, '', 'cabut lewat pesan mentah dijawab dengan mine kosong');
      // putar ulang: pesan yang sama persis ditolak
      const s = C._pgSign(A.id, base); await C._request(peer, s, 5000); assert.deepStrictEqual(pick(await C._request(peer, s, 5000)), { t: 'pg_rc', ok: false, err: 'auth' }, 'putar ulang ditolak');
      // laju: ember pg_rx dipakai bersama (satu peer tidak mendapat jatah ganda)
      A._pgRxLim = null; A._pgSeenR = null; let busy = 0; for (let i = 0; i < RX.RX_RATE_RECV.max + 5; i++) { const r = await send(i % 2 ? Object.assign({}, base, { e: '🩷' }) : base); if (r.err === 'busy') busy++; }
      assert(busy >= 1, 'banjir pg_rc = busy'); assert(A._pgSeenR && A._pgSeenR.size > 0, 'nonce pg_rc masuk penampung reaksi sendiri (bersama pg_rx), bukan penampung pg_list'); A._pgRxLim = null; A._pgSeenR = null;
    }
    ok('pesan mentah: emoji / cid / id diganti = auth, tanpa cid atau bentuk salah = bad, putar ulang ditolak, banjir = busy (ember laju sama dengan pg_rx)');

    // ---- D. caps: pemilik lama ----
    {
      const peer = B.peers.get(A.id), caps = peer.caps, asked = []; const ask = B._pgAsk; B._pgAsk = async (...x) => { asked.push(x); return ask.apply(B, x); };
      try {
        peer.caps = caps.filter((c) => c !== 'pgk');
        const e = await B.pageReactComment(A.id, p1, cB.id, '👍').catch((x) => x); assert.strictEqual(e.code, 'old'); assert(/reaksi pada komentar/.test(e.message), 'pesan khusus'); assert.strictEqual(asked.length, 0, 'old tanpa menyentuh jaringan');
        assert.strictEqual(await code(B.pageReactComment(A.id, p1, cB.id, '👍')), 'old');
        assert.strictEqual((await B.pageComment(A.id, p1, 'komentar biasa tetap jalan')).st, 'added', 'komentar biasa ke pemilik tanpa pgk tetap jalan');
      } finally { peer.caps = caps; B._pgAsk = ask; }
    }
    ok("caps: pemilik tanpa 'pgk' = old (pesan khusus) tanpa jaringan; komentar biasa tidak terganggu");

    // ---- E. validasi jawaban pemilik: wireCmtRx ----
    {
      const ids = new Set([hex(1), hex(2)]);
      assert.strictEqual(wireCmtRx(null, ids), null); assert.strictEqual(wireCmtRx([], ids), null); assert.strictEqual(wireCmtRx('x', ids), null);
      assert.deepStrictEqual(wireCmtRx({ [hex(1)]: { rx: [{ e: '👍', n: 2 }], mine: '👍', extra: 1 }, [hex(2)]: { rx: [{ e: '🩷', n: 1 }] } }, ids), { [hex(1)]: { rx: [{ e: '👍', n: 2 }], mine: '👍' }, [hex(2)]: { rx: [{ e: '🩷', n: 1 }] } }, 'yang sah lolos, bidang lain dibuang');
      assert.deepStrictEqual(wireCmtRx({ [hex(9)]: { rx: [{ e: '👍', n: 1 }] } }, ids), {}, 'id yang bukan komentar halaman ini diabaikan');
      assert.deepStrictEqual(wireCmtRx({ zz: { rx: [{ e: '👍', n: 1 }] } }, ids), {}, 'kunci bukan 16 heks diabaikan');
      for (const bad of [{ rx: [{ e: 'x', n: 1 }] }, { rx: [{ e: '👍', n: 0 }] }, { rx: [{ e: '👍', n: 257 }] }, { rx: [{ e: '👍', n: 1.5 }] }, { rx: [] }, { rx: [{ e: '👍', n: 1 }, { e: '👍', n: 2 }] }, { rx: [{ e: '👍', n: 1 }], mine: 5 }, { rx: [{ e: '👍', n: 1 }], mine: '' }, null, 5]) assert.deepStrictEqual(wireCmtRx({ [hex(1)]: bad }, ids), {}, 'cacat diabaikan: ' + JSON.stringify(bad));
      assert.deepStrictEqual(Object.keys(wireCmtRx({ [hex(1)]: { rx: [{ e: 'x', n: 1 }] }, [hex(2)]: { rx: [{ e: '👍', n: 1 }] } }, ids)), [hex(2)], 'satu cacat tidak membatalkan yang lain');
      // pemilik nakal: rx cacat tidak membatalkan komentar yang sah, komentar palsu tetap dibuang
      const peer = C.peers.get(A.id), ask = C._pgAsk;
      C._pgAsk = async (pid, req, t) => { const r = await ask.call(C, pid, req, t); if (req.t === 'pg_cml') { r.r.rx = { [cB.id]: { rx: [{ e: 'x', n: -1 }] }, [hex(0xee)]: { rx: [{ e: '👍', n: 1 }] } }; } return r; };
      try { const g = await C.pageComments(A.id, p1); assert.strictEqual(g.items.length > 0, true); assert.strictEqual(g.rx, undefined, 'semua rx cacat = tanpa rx'); } finally { C._pgAsk = ask; }
    }
    ok('wireCmtRx: sah lolos, id asing / cacat diabaikan per komentar (tidak membatalkan halaman), pemilik nakal tidak merusak daftar komentar');

    // ---- F. IPC + preload ----
    {
      const c = fake(C), a2 = fake(A);
      assert.deepStrictEqual(J(await c('pgCmtReact', 'zz', p1, cB.id, '👍')).ok, false, 'peer cacat = bad'); assert.strictEqual((await c('pgCmtReact', C.id === A.id ? 'zz' : A.id, 'zz', cB.id, '👍')).ok, false); assert.strictEqual((await c('pgCmtReact', A.id, p1, 'zz', '👍')).ok, false);
      assert.strictEqual((await c('pgCmtReact', A.id, p1, cB.id, 5)).ok, false); assert.strictEqual((await c('pgCmtReact', A.id, p1, cB.id, 'x'.repeat(65))).ok, false, 'emoji terlalu panjang ditolak di IPC');
      const r1 = await c('pgCmtReact', A.id, p1, cB.id, '🤣'); assert.strictEqual(r1.ok, true); assert.deepStrictEqual(Object.keys(r1.react).sort(), ['mine', 'rx'], 'jalan jauh: hanya rx dan mine'); assert.strictEqual(r1.react.mine, '🤣');
      const r2 = await c('pgCmtReact', A.id, p1, hex(0xdead), '👍'); assert.deepStrictEqual(J(r2), { ok: true, react: null }, 'komentar tidak ada = react null');
      const r3 = await a2('pgCmtReact', A.id, p1, cB.id, '🩷'); assert.strictEqual(r3.ok, true); assert(Array.isArray(r3.react.who) && r3.react.who.length === 2 && r3.react.who.some((w) => w.e === '🩷' && w.by.includes(A.id) && w.by.includes(B.id)), 'halaman sendiri: pelaku ikut (🩷 oleh B dan pemilik, 🤣 oleh C)'); assert(r3.react.who.every((w) => typeof w.e === 'string' && w.by.every((i) => /^[0-9a-f]{16}$/.test(i))));
      const pg = await c('pgComments', A.id, p1, {}); assert.strictEqual(pg.ok, true); assert(pg.comments.rx && pg.comments.rx[cB.id].rx.length, 'pgComments membawa rx'); assert(!('who' in pg.comments.rx[cB.id]), 'penonton: tanpa who');
      assert.deepStrictEqual(Object.keys(pg.comments.items[0]).sort().filter((k) => !['re'].includes(k)), ['by', 'id', 'text', 'ts'], 'item komentar tetap hanya empat bidang');
      const pl = await a2('pgComments', A.id, p1, {}); assert(Array.isArray(pl.comments.rx[cB.id].who), 'halaman sendiri: who ada');
      const none = await c('pgComments', A.id, p1, {}); assert(pg.comments.items.length === none.comments.items.length);
      const old = await c('pgCmtReact', A.id, p1, cB.id, '👍'); assert.strictEqual(old.ok, true);
      // galat ber-code
      const peer = C.peers.get(A.id), caps = peer.caps; peer.caps = caps.filter((x) => x !== 'pgk'); const eo = await c('pgCmtReact', A.id, p1, cB.id, '👍'); peer.caps = caps;
      assert.strictEqual(eo.ok, false); assert.strictEqual(eo.code, 'old'); assert(/reactions on comments/.test(eo.err), 'pesan old khusus diteruskan');
      const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), http = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archne-api-http.js'), 'utf8');
      assert(pre.includes("pgCmtReact: (peerId, postId, cid, e) => ipcRenderer.invoke('pgCmtReact', peerId, postId, cid, e)") && http.includes("'pgCmtReact'"), 'terdaftar di preload dan api-http');
    }
    ok('IPC pgCmtReact: validasi, react null untuk komentar hilang, who hanya di halaman sendiri, pgComments membawa rx (item tetap 4 bidang), old membawa pesan khusus, preload + api-http');
  } finally { for (const X of [A, B, C, D]) await X.stop().catch(() => {}); }
  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

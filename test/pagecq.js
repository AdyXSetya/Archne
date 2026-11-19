'use strict';
// Tes Halaman 4c-1: antrean komentar untuk pemilik offline. A = penyimpanan murni (src/archne-pagecq.js), B = Core sungguhan: pemilik dimatikan, komentar diantrekan, pemilik dihidupkan lagi.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), crypto = require('crypto');
const { Core } = require('../src/archne-core');
const { cmtSign } = require('../src/archne-pagecmt');
const { CmtQueue, CQ_TOTAL, CQ_PEER, CQ_POST, CQ_TTL, CQ_TRIES, CQ_BACKOFF } = require('../src/archne-pagecq');
const { PG_ERR } = require('../src/core/archne-pgerr');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagecq-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
let pass = 0;
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const hex = (n) => n.toString(16).padStart(16, '0');
const ident = () => { const k = crypto.generateKeyPairSync('ed25519'); return { priv: k.privateKey, pub: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }; };
const by = (x, owner, post, text, now) => cmtSign(x.priv, x.pub, owner, post, text, now);
const code = async (p) => { try { await p; } catch (e) { return e.code; } return 'tidak melempar'; };
const codeS = (f) => { try { f(); } catch (e) { return e.code || 'Error'; } return 'tidak melempar'; };

(async () => {
  // ---- A. penyimpanan murni ----
  const X = ident(), OWN = hex(1), POST = hex(2), file = path.join(tmp, 'sub', 'pgcq.json');
  {
    const q = new CmtQueue(file);
    const c1 = by(X, OWN, POST, 'satu', 1000), c2 = by(X, OWN, POST, 'dua', 2000);
    assert.strictEqual(q.size, 0); assert.strictEqual(fs.existsSync(file), false, 'membuat objek tidak menulis berkas');
    assert.strictEqual(q.add(OWN, POST, c1, 50), 'queued'); assert.strictEqual(fs.existsSync(file), true, 'folder bersarang dibuat oleh penulis bawaan');
    assert.strictEqual(q.add(OWN, POST, c1, 99), 'same'); assert.strictEqual(q.size, 1, 'komentar sama persis = same, tanpa ganda');
    assert.strictEqual(q.add(OWN, POST, c2, 40), 'queued');
    assert.strictEqual(q.has(OWN), true); assert.strictEqual(q.has(hex(9)), false);
    assert.deepStrictEqual(q.pending(OWN, POST), [{ id: c2.id, ts: 2000, text: 'dua' }, { id: c1.id, ts: 1000, text: 'satu' }], 'tertua DIANTREKAN dulu (at), bukan ts');
    assert.deepStrictEqual(q.pending(OWN, hex(7)), []); assert.deepStrictEqual(q.pending(hex(9), POST), []);
    const q2 = new CmtQueue(file); assert.strictEqual(q2.size, 2, 'dibuka ulang dari berkas'); assert.deepStrictEqual(q2.pending(OWN, POST), q.pending(OWN, POST));
    // salinan: mengubah hasil due() tidak mengubah antrean
    const d = q.due(OWN, 100); assert.deepStrictEqual(d.map((e) => e.c.id), [c2.id, c1.id], 'urut at'); d[0].tries = 99; d[0].nx = 5e9; assert.strictEqual(q.due(OWN, 100).length, 2); assert.strictEqual(q.due(OWN, 100)[0].tries, 0);
    // at sama: id memutus seri
    const q3 = new CmtQueue(path.join(tmp, 'tie.json')), t1 = by(X, OWN, POST, 'a', 1), t2 = by(X, OWN, POST, 'b', 2); q3.add(OWN, POST, t1, 7); q3.add(OWN, POST, t2, 7);
    assert.deepStrictEqual(q3.due(OWN, 7).map((e) => e.c.id), [t1.id, t2.id].sort());
    ok('CmtQueue: add / same, tertua dulu, pending, buka ulang dari berkas, due mengembalikan salinan, seri at diputus id');
  }
  {
    const q = new CmtQueue(path.join(tmp, 'm.json')), c = by(X, OWN, POST, 'x', 1);
    q.add(OWN, POST, c, 10);
    assert.strictEqual(q.due(OWN, 9).length, 1, 'nx awal 0'); q.later(c.id, 100, 5000); assert.strictEqual(q.due(OWN, 5099).length, 0); assert.strictEqual(q.due(OWN, 5100).length, 1, 'nx <= sekarang = waktunya');
    assert.strictEqual(q.due(OWN, 5100)[0].tries, 0, 'later() tidak menghitung kegagalan'); q.later(c.id, 100); assert.strictEqual(q.due(OWN, 100 + CQ_BACKOFF - 1).length, 0); assert.strictEqual(q.due(OWN, 100 + CQ_BACKOFF).length, 1, 'jeda bawaan');
    q.later(hex(5), 1, 1); // id tak dikenal: tidak melempar
    const delays = []; for (let i = 1; i < CQ_TRIES; i++) { assert.strictEqual(q.retry(c.id, 0), 'retry'); delays.push(q.map.get(c.id).nx); assert.strictEqual(q.map.get(c.id).tries, i); }
    assert.deepStrictEqual(delays, [30e3, 60e3, 120e3, 240e3, 480e3].slice(0, CQ_TRIES - 1), 'jeda eksponensial');
    assert.strictEqual(q.retry(c.id, 0), 'gave', CQ_TRIES + ' kali = menyerah'); assert.strictEqual(q.size, 0, 'entri yang menyerah dibuang'); assert.strictEqual(q.retry(c.id, 0), null);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'm.json'), 'utf8')).q.length, 0, 'tersimpan');
    ok('later (tanpa hitungan) / retry (jeda eksponensial, menyerah, id tak dikenal) / done tersimpan');
  }
  {
    const q = new CmtQueue(path.join(tmp, 'e.json')), c = by(X, OWN, POST, 'tua', 1), c2 = by(X, OWN, POST, 'muda', 2);
    q.add(OWN, POST, c, 1000); q.add(OWN, POST, c2, 1000 + CQ_TTL);
    assert.deepStrictEqual(q.expire(1000 + CQ_TTL), [], 'tepat CQ_TTL belum kedaluwarsa'); const gone = q.expire(1001 + CQ_TTL);
    assert.deepStrictEqual(gone.map((e) => e.c.id), [c.id]); assert.strictEqual(q.size, 1); assert.strictEqual(q.done(c2.id).c.id, c2.id); assert.strictEqual(q.done(c2.id), null); assert.strictEqual(q.size, 0);
    ok('expire: batas tegas, mengembalikan yang dibuang; done mengembalikan entri atau null');
  }
  {
    const f = path.join(tmp, 'l.json'), mkq = () => new CmtQueue(f);
    const q = mkq();
    // batas per postingan / pemilik / total (kode qfull); bentuk tak sah = Error biasa
    for (let i = 0; i < CQ_POST; i++) q.add(OWN, POST, by(X, OWN, POST, 'p' + i, 10 + i), i);
    assert.strictEqual(codeS(() => q.add(OWN, POST, by(X, OWN, POST, 'lebih', 99), 1)), 'qfull', 'per postingan');
    const posts = [hex(10), hex(11), hex(12)]; let n = CQ_POST;
    for (const p of posts) for (let i = 0; i < CQ_POST && n < CQ_PEER; i++, n++) q.add(OWN, p, by(X, OWN, p, 'q' + n, 10 + n), n);
    assert.strictEqual(codeS(() => q.add(OWN, hex(13), by(X, OWN, hex(13), 'lebih', 99), 1)), 'qfull', 'per pemilik');
    for (let o = 2; o <= CQ_TOTAL / CQ_PEER; o++) for (let i = 0; i < CQ_PEER; i++) { const ow = hex(100 + o), p = hex(200 + i % 3); q.add(ow, p, by(X, ow, p, 'r' + i, 10 + i), i); }
    assert.strictEqual(q.size, CQ_TOTAL); assert.strictEqual(codeS(() => q.add(hex(999), hex(1), by(X, hex(999), hex(1), 'lebih', 99), 1)), 'qfull', 'total');
    assert.strictEqual(q.add(OWN, POST, by(X, OWN, POST, 'p0', 10), 1), 'same', 'same dijawab sebelum batas diperiksa'); // c yang sama persis (ts 10) sudah ada
    assert.strictEqual(mkq().size, CQ_TOTAL, 'penuh tersimpan utuh');
    // batas ditegakkan juga saat dibuka (berkas yang dibengkakkan tangan)
    const raw = JSON.parse(fs.readFileSync(f, 'utf8')); raw.q.push(...raw.q.slice(0, 5).map((e) => Object.assign({}, e))); fs.writeFileSync(f, JSON.stringify(raw)); assert.strictEqual(mkq().size, CQ_TOTAL, 'ganda dan lewat batas dibuang saat dibuka');
    assert.strictEqual(codeS(() => q.add('xyz', POST, by(X, OWN, POST, 'k', 1))), 'Error'); assert.strictEqual(codeS(() => q.add(OWN, 'xyz', by(X, OWN, POST, 'k', 1))), 'Error');
    assert.strictEqual(codeS(() => q.add(hex(55), POST, by(X, OWN, POST, 'k', 1))), 'Error', 'komentar untuk halaman lain ditolak (tanda tangan menutup pemilik)');
    assert.strictEqual(codeS(() => q.add(OWN, hex(77), by(X, OWN, POST, 'k', 1))), 'Error', 'komentar untuk postingan lain ditolak');
    assert.strictEqual(codeS(() => q.add(OWN, POST, Object.assign({}, by(X, OWN, POST, 'k', 1), { text: 'diganti' }))), 'Error', 'teks diubah = tanda tangan tak sah');
    assert.strictEqual(codeS(() => q.add(OWN, POST, null)), 'Error');
    for (const bad of [() => q.add('xyz', POST, by(X, OWN, POST, 'k', 1)), () => q.add(hex(55), POST, by(X, OWN, POST, 'k', 1)), () => q.add(OWN, POST, null), () => q.add(OWN, hex(77), by(X, OWN, POST, 'k', 1))]) assert.throws(bad, (e) => e instanceof Error && !(e instanceof TypeError) && /tidak (valid|sah)/.test(e.message) && e.code === undefined, 'galat yang disengaja, bukan TypeError kebetulan');
    ok('batas per postingan / pemilik / total (qfull), same lebih dulu dari batas, batas ikut ditegakkan saat dibuka, komentar tak sah / halaman lain / postingan lain ditolak');
  }
  {
    const f = path.join(tmp, 'v.json'), q = new CmtQueue(f), c = by(X, OWN, POST, 'asli', 5); q.add(OWN, POST, c, 3);
    const good = JSON.parse(fs.readFileSync(f, 'utf8')), put = (j) => fs.writeFileSync(f, typeof j === 'string' ? j : JSON.stringify(j)), size = () => new CmtQueue(f).size, ent = () => good.q[0];
    const mut = (fn) => { const j = JSON.parse(JSON.stringify(good)); fn(j.q[0]); return j; };
    put(good); assert.strictEqual(size(), 1);
    put(mut((e) => { e.c.text = 'diubah'; })); assert.strictEqual(size(), 0, 'teks diubah tangan dibuang');
    put(mut((e) => { e.peer = hex(8); })); assert.strictEqual(size(), 0, 'dialihkan ke pemilik lain dibuang');
    put(mut((e) => { e.post = hex(8); })); assert.strictEqual(size(), 0, 'dialihkan ke postingan lain dibuang');
    put(mut((e) => { e.peer = 'x'; })); assert.strictEqual(size(), 0); put(mut((e) => { e.c = null; })); assert.strictEqual(size(), 0);
    put(Object.assign({}, good, { v: 2 })); assert.strictEqual(size(), 0, 'versi asing = kosong'); put('{rusak'); assert.strictEqual(size(), 0); put({ v: 1, q: 'x' }); assert.strictEqual(size(), 0); put({ v: 1 }); assert.strictEqual(size(), 0); put('null'); assert.strictEqual(size(), 0);
    put({ v: 1, q: [null, 5, 'x', [], ent()] }); assert.strictEqual(size(), 1, 'entri sampah dilewati, yang sah tetap');
    for (const [k, bad] of [['at', -1], ['at', 'x'], ['tries', 99], ['tries', -2], ['nx', 1.5], ['nx', null]]) { put(mut((e) => { e[k] = bad; })); const e = [...new CmtQueue(f).map.values()][0]; assert.strictEqual(e[k], k === 'at' || k === 'tries' || k === 'nx' ? 0 : -1, k + ' tak wajar = 0'); }
    put(mut((e) => { e.evil = 1; e.c.evil = 1; })); { const e = [...new CmtQueue(f).map.values()][0]; assert.deepStrictEqual(Object.keys(e).sort(), ['at', 'c', 'nx', 'peer', 'post', 'tries'], 'bidang asing dibuang'); assert.deepStrictEqual(Object.keys(e.c).sort(), ['by', 'id', 'post', 'pub', 'sig', 'text', 'ts']); }
    ok('dibuka ulang: tiap entri diperiksa (teks / pemilik / postingan diubah, bentuk salah, versi asing, rusak), angka tak wajar = 0, bidang asing dibuang');
  }
  {
    let fail = false; const writes = [], q = new CmtQueue(path.join(tmp, 'w.json'), (f, s) => { if (fail) throw new Error('disk penuh'); writes.push(s); });
    const c = by(X, OWN, POST, 'w', 1), c2 = by(X, OWN, POST, 'w2', 2); q.add(OWN, POST, c, 1);
    fail = true; assert.throws(() => q.add(OWN, POST, c2, 2), /disk penuh/); assert.strictEqual(q.size, 1, 'gagal tulis memulihkan memori'); assert.strictEqual(q.pending(OWN, POST).length, 1);
    assert.doesNotThrow(() => q.later(c.id, 1)); assert.doesNotThrow(() => q.retry(c.id, 1)); assert.doesNotThrow(() => q.expire(1 + CQ_TTL + 5)); assert.strictEqual(q.size, 0, 'expire tetap membuang di memori');
    fail = false; q.add(OWN, POST, c, 1); fail = true; assert.strictEqual(q.done(c.id).c.id, c.id, 'done tidak melempar walau tulis gagal'); assert.strictEqual(q.size, 0);
    ok('gagal tulis: add memulihkan memori dan melempar; later / retry / expire / done tidak melempar');
  }

  {
    // batas ditegakkan juga saat berkas dibuka, satu per satu (berkas yang dibengkakkan tangan dengan entri SAH)
    const f = path.join(tmp, 'lim.json'), W = (list) => fs.writeFileSync(f, JSON.stringify({ v: 1, q: list })), E = (ow, p, i) => ({ peer: ow, post: p, c: by(X, ow, p, 'x' + i + '-' + ow.slice(-3) + p.slice(-3), 100 + i), at: i, tries: 0, nx: 0 });
    W(Array.from({ length: CQ_POST + 3 }, (_, i) => E(OWN, POST, i))); assert.strictEqual(new CmtQueue(f).size, CQ_POST, 'per postingan dibatasi saat dibuka');
    W(Array.from({ length: CQ_PEER + 5 }, (_, i) => E(OWN, hex(300 + Math.floor(i / 5)), i))); assert.strictEqual(new CmtQueue(f).size, CQ_PEER, 'per pemilik dibatasi saat dibuka (postingan berbeda, tiap postingan di bawah batasnya)');
    W(Array.from({ length: CQ_TOTAL + 10 }, (_, i) => E(hex(400 + Math.floor(i / 10)), hex(500 + (i % 10) % 3), i))); assert.strictEqual(new CmtQueue(f).size, CQ_TOTAL, 'total dibatasi saat dibuka (pemilik berbeda, tiap pemilik di bawah batasnya)');
    // due() hanya untuk pemilik yang diminta
    const q = new CmtQueue(path.join(tmp, 'due2.json')), o2 = hex(2), ca = by(X, OWN, POST, 'milik-1', 1), cb = by(X, o2, POST, 'milik-2', 2); q.add(OWN, POST, ca, 1); q.add(o2, POST, cb, 2);
    assert.deepStrictEqual(q.due(OWN, 9).map((e) => e.c.id), [ca.id]); assert.deepStrictEqual(q.due(o2, 9).map((e) => e.c.id), [cb.id]); assert.deepStrictEqual(q.due(hex(3), 9), []);
    ok('batas saat dibuka (per postingan / per pemilik / total, masing-masing sendiri-sendiri); due() hanya untuk pemilik yang diminta');
  }

  // ---- B. Core: A pemilik, B penulis, C tidak pernah memakai antrean ----
  const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, tickMs: 120 });
  let A = mk('A'); const B = mk('B'), C = mk('C');
  await A.start(); await B.start(); await C.start();
  await B.addPeer('127.0.0.1', A.port); await until(() => B.peers.has(A.id) && A.peers.has(B.id), 8000, 'saling kenal');
  const post = A.pageStore().create({ text: 'publik' }), frd = A.pageStore().create({ text: 'teman', priv: 'friends' });
  const ev = []; B.on('pgcq', (e) => ev.push(e));
  const offline = async () => { await A.stop(); B.peers.get(A.id).lastSeen = 0; await until(() => !B.isOnline(B.peers.get(A.id)), 3000, 'A offline'); };
  const online = async () => { A = mk('A'); await A.start(); await B.addPeer('127.0.0.1', A.port); await until(() => B.isOnline(B.peers.get(A.id)), 8000, 'A online lagi'); };
  const cqFile = path.join(tmp, 'B', 'pgcq.json');
  {
    assert.strictEqual(fs.existsSync(path.join(tmp, 'C', 'pgcq.json')), false); await sleep(400);
    assert.strictEqual(C._pcq == null, true, 'Core yang tak memakai antrean tidak memuatnya'); assert.strictEqual(fs.existsSync(path.join(tmp, 'C', 'pgcq.json')), false, 'dan tidak membuat berkas');
    assert.strictEqual(fs.existsSync(cqFile), false); assert.deepStrictEqual(B.pageCommentPending(A.id, post.id), [], 'tanpa antrean = kosong, tanpa membuat berkas'); assert.strictEqual(fs.existsSync(cqFile), false);
    assert.strictEqual(B.pageCommentCancel(A.id, hex(3)), false); assert.strictEqual(fs.existsSync(cqFile), false); assert.strictEqual(B._pcq == null, true, 'pending / cancel tidak memuat antrean');
    ok('malas: tanpa pemakaian tidak ada antrean di memori maupun berkas; pending / cancel tidak membuatnya');
  }
  {
    await offline();
    assert.strictEqual(await code(B.pageComment(A.id, post.id, 'langsung')), 'offline', 'jalur langsung tetap gagal saat offline');
    const t0 = Date.now(), r1 = await B.pageCommentQueue(A.id, post.id, '  halo  '); await sleep(5); await B.pageCommentQueue(A.id, post.id, 'kedua');
    assert.strictEqual(r1.st, 'queued'); assert.deepStrictEqual(Object.keys(r1.c).sort(), ['by', 'id', 'text', 'ts'], 'tanpa pub dan sig'); assert.strictEqual(r1.c.text, 'halo', 'teks dikanonkan'); assert.strictEqual(r1.c.by, B.id); assert(r1.c.ts >= t0 && r1.c.ts <= Date.now());
    assert.deepStrictEqual(B.pageCommentPending(A.id, post.id).map((x) => x.text), ['halo', 'kedua']); assert.deepStrictEqual(B.pageCommentPending(A.id, frd.id), [], 'postingan lain kosong');
    assert(fs.existsSync(cqFile), 'tersimpan di pgcq.json'); await sleep(500); assert.strictEqual(B.pageCommentPending(A.id, post.id).length, 2, 'tidak dikirim selagi pemilik offline'); assert.deepStrictEqual(ev, []);
    // bertahan walau antrean di memori dibuang (mis. aplikasi ditutup lalu dibuka)
    B._pcq = null; B._pcqNone = false; assert.deepStrictEqual(B.pageCommentPending(A.id, post.id).map((x) => x.text), ['halo', 'kedua'], 'dimuat ulang dari berkas');
    ok('offline: pageComment langsung = offline, antrean menyimpan komentar bertanda tangan (teks kanonis, tanpa pub / sig keluar), tidak terkirim, bertahan di berkas');
  }
  {
    await online();
    await until(() => ev.filter((e) => e.ev === 'sent').length === 2, 8000, 'dua komentar terkirim');
    assert.deepStrictEqual(ev.map((e) => e.ev + ':' + e.why + ':' + e.peer + ':' + e.post), [0, 1].map(() => 'sent:added:' + A.id + ':' + post.id), 'event sent, dengan hasil pemilik');
    const got = A.pageStore().commentsFor(B.id, post.id); assert.deepStrictEqual(got.map((c) => c.text), ['halo', 'kedua'], 'sampai di pemilik, urut');
    assert(got[0].ts < Date.now() - 100 && got[0].by === B.id, 'ts = waktu ditulis, bukan waktu terkirim; penulis terbukti B');
    assert.deepStrictEqual(B.pageCommentPending(A.id, post.id), [], 'antrean kosong'); assert.strictEqual(JSON.parse(fs.readFileSync(cqFile, 'utf8')).q.length, 0);
    assert.deepStrictEqual(ev.map((e) => e.id).sort(), got.map((c) => c.id).sort(), 'id event = id komentar');
    ok('pemilik online lagi: terkirim otomatis lewat tick, urut, ts asli, antrean kosong, event sent');
  }
  {
    // hasil lain dari pemilik: gone (postingan tak ada / Teman bukan untukmu), full
    ev.length = 0;
    await B.pageCommentQueue(A.id, hex(0xabc), 'tak ada'); await B.pageCommentQueue(A.id, frd.id, 'bukan temanmu');
    await until(() => ev.length === 2, 8000, 'dua gone'); assert.deepStrictEqual(ev.map((e) => e.ev + ':' + e.why).sort(), ['drop:gone', 'drop:gone'], 'tak ada / bukan untukmu tak dibedakan');
    assert.strictEqual(B.pageCommentPending(A.id, frd.id).length + B.pageCommentPending(A.id, hex(0xabc)).length, 0);
    ev.length = 0; const fp = A.pageStore().create({ text: 'penuh' }); for (let i = 0; i < 20; i++) A.pageStore().comment(B.id, fp.id, cmtSign(B.privKey, B.pub, A.id, fp.id, 'b' + i, 100 + i));
    await B.pageCommentQueue(A.id, fp.id, 'ke 21'); await until(() => ev.length === 1, 8000, 'full'); assert.strictEqual(ev[0].ev + ':' + ev[0].why, 'drop:full'); assert.strictEqual(B.pageCommentPending(A.id, fp.id).length, 0, 'full dibuang, bukan diulang');
    ok('pemilik menjawab null (tak ada / bukan temanmu) = drop gone, full = drop full; entri dibuang, tidak diulang');
  }
  {
    // galat sebelum antre
    const E = async (...a) => code(B.pageCommentQueue(...a));
    assert.strictEqual(await E(B.id, post.id, 'x'), 'self'); assert.strictEqual(await E('xyz', post.id, 'x'), 'bad'); assert.strictEqual(await E(A.id, 'xyz', 'x'), 'bad'); assert.strictEqual(await E(A.id, post.id, ''), 'bad'); assert.strictEqual(await E(A.id, post.id, '   '), 'bad'); assert.strictEqual(await E(A.id, post.id, 'x'.repeat(1001)), 'bad'); assert.strictEqual(await E(A.id, post.id, 5), 'bad'); assert.strictEqual(await E(A.id), 'bad');
    assert.strictEqual(await E(hex(0x77), post.id, 'x'), 'peer', 'peer tak dikenal');
    B.store.blocked[A.id] = 1; assert.strictEqual(await E(A.id, post.id, 'x'), 'blocked'); delete B.store.blocked[A.id];
    const caps = B.peers.get(A.id).caps; B.peers.get(A.id).caps = ['pg', 'pgm']; assert.strictEqual(await E(A.id, post.id, 'x'), 'old', 'hello dikenal tanpa pgc'); B.peers.get(A.id).caps = []; assert.strictEqual(await E(A.id, post.id, 'x'), 'old'); B.peers.get(A.id).caps = caps;
    assert.strictEqual(B.pageCommentPending(A.id, post.id).length, 0, 'galat tidak menaruh apa pun'); assert.strictEqual(codeS(() => B.pageCommentPending('x', post.id)), 'bad'); assert.strictEqual(codeS(() => B.pageCommentPending(A.id, 'x')), 'bad');
    assert.strictEqual(codeS(() => B.pageCommentCancel('x', hex(1))), 'bad'); assert.strictEqual(codeS(() => B.pageCommentCancel(A.id, 'x')), 'bad');
    ok('galat sebelum antre: self / bad (id, teks kosong, terlalu panjang, bukan string) / peer / blocked / old; tidak menaruh apa pun');
  }
  {
    // pemilik offline lagi: batas, batal, kedaluwarsa
    await offline(); ev.length = 0;
    const cap = 'f'.repeat(16); for (let i = 0; i < CQ_POST; i++) await B.pageCommentQueue(A.id, cap, 'k' + i);
    assert.strictEqual(await code(B.pageCommentQueue(A.id, cap, 'lebih')), 'qfull'); assert.strictEqual((await B.pageCommentQueue(A.id, hex(0xd), 'postingan lain')).st, 'queued', 'postingan lain masih boleh');
    try { await B.pageCommentQueue(A.id, cap, 'lebih'); } catch (e) { assert.strictEqual(e.message, PG_ERR.qfull); }
    const pend = B.pageCommentPending(A.id, cap); assert.strictEqual(pend.length, CQ_POST);
    assert.strictEqual(B.pageCommentCancel(A.id, pend[3].id), true); assert.strictEqual(B.pageCommentCancel(A.id, pend[3].id), false, 'sudah dibatalkan'); assert.strictEqual(B.pageCommentCancel(hex(0x99), pend[4].id), false, 'milik pemilik lain: tidak bisa dibatalkan lewat id pemilik salah'); assert.strictEqual(B.pageCommentPending(A.id, cap).length, CQ_POST - 1);
    assert.strictEqual((await B.pageCommentQueue(A.id, cap, 'muat lagi')).st, 'queued', 'batal membebaskan tempat');
    B._pcqStore().map.forEach((e) => { e.at = Date.now() - CQ_TTL - 1000; }); await until(() => ev.length === CQ_POST + 1, 4000, 'kedaluwarsa'); assert.strictEqual(ev.every((e) => e.ev === 'drop' && e.why === 'expired'), true, 'kedaluwarsa dibuang walau pemilik offline');
    assert.strictEqual(B._pcqStore().size, 0); assert.strictEqual(JSON.parse(fs.readFileSync(cqFile, 'utf8')).q.length, 0);
    ok('qfull per postingan (pesan jelas, postingan lain tetap boleh), batal (hanya milik pemilik itu), batal membebaskan tempat, kedaluwarsa dibuang walau pemilik offline');
  }
  {
    // jalur kegagalan dengan _pgAsk palsu: offline / busy tidak dihitung; auth / time / proto dihitung; bad / old dibuang; blocked berhenti; menyerah
    await online(); const real = B._pgAsk.bind(B); let calls = 0, mode = null;
    B._pgAsk = async (...a) => { calls++; if (mode instanceof Function) return mode(...a); if (mode) throw Object.assign(new Error(mode), { code: mode }); return real(...a); };
    const mkq = async (t) => (await B.pageCommentQueue(A.id, post.id, t)).c.id, ent = (id) => B._pcqStore().map.get(id), force = () => B._pcqStore().map.forEach((e) => { e.nx = 0; });
    mode = 'offline'; ev.length = 0; const a = await mkq('uji offline'); await sleep(500);
    assert(calls > 0, 'dicoba'); assert.strictEqual(ent(a).tries, 0, 'offline tidak dihitung'); assert(ent(a).nx > Date.now(), 'tetapi ditunda'); const c0 = calls; await sleep(450); assert.strictEqual(calls, c0, 'selama jeda tidak dicoba lagi');
    mode = 'busy'; force(); await sleep(400); assert.strictEqual(ent(a).tries, 0, 'busy tidak dihitung');
    for (const m of ['auth', 'time', 'proto', 'io']) { mode = m; ent(a).tries = 0; force(); const t = ent(a).tries; await until(() => ent(a).tries === 1, 3000, m); assert.strictEqual(t, 0); assert(ent(a).nx > Date.now(), m + ' dijeda'); }
    mode = 'blocked'; ent(a).tries = 0; force(); await sleep(400); assert.strictEqual(ent(a).tries, 0, 'blocked: berhenti tanpa menghitung'); assert(ent(a), 'entri tetap');
    mode = 'peer'; force(); await sleep(400); assert(ent(a), 'peer: entri tetap');
    mode = function () { return { r: 'aneh' }; }; ent(a).tries = 0; force(); await until(() => ent(a).tries === 1, 3000, 'jawaban aneh = dihitung');
    ent(a).tries = CQ_TRIES - 1; mode = 'auth'; force(); await until(() => ev.length === 1, 3000, 'menyerah'); assert.deepStrictEqual([ev[0].ev, ev[0].why, ev[0].id], ['drop', 'gave', a]); assert.strictEqual(ent(a), undefined);
    ev.length = 0; const b1 = await mkq('uji bad'); mode = 'bad'; await until(() => ev.length === 1, 3000, 'bad'); assert.strictEqual(ev[0].why, 'bad'); assert.strictEqual(ent(b1), undefined);
    ev.length = 0; const o1 = await mkq('uji old'); mode = 'old'; await until(() => ev.length === 1, 3000, 'old'); assert.strictEqual(ev[0].why, 'old'); assert.strictEqual(ent(o1), undefined);
    mode = null; B._pgAsk = real; ok('kegagalan: offline / busy ditunda tanpa hitungan, auth / time / proto / io dihitung dan dijeda, bad / old dibuang, blocked / peer berhenti dan entri tetap, jawaban aneh dihitung, menyerah setelah ' + CQ_TRIES + ' kali');
  }
  {
    // putaran dijalankan langsung (tick dimatikan): satu galat tingkat-pemilik menghentikan seluruh putaran, galat tingkat-entri tidak
    B._pcqTick = () => {}; const real = B._pgAsk.bind(B); let calls = 0, mode = null;
    B._pgAsk = async (...a) => { calls++; if (mode) throw Object.assign(new Error(mode), { code: mode }); return real(...a); };
    const fill = async (tag, n) => { B._pcqStore().map.clear(); for (let i = 0; i < n; i++) { await B.pageCommentQueue(A.id, post.id, tag + i); await sleep(3); } };
    const tries = () => [...B._pcqStore().map.values()].map((e) => e.tries);
    for (const m of ['offline', 'busy', 'auth', 'time', 'blocked', 'peer']) { mode = m; await fill('henti-' + m, 3); calls = 0; await B._pcqFlush(A.id); assert.strictEqual(calls, 1, m + ': satu galat menghentikan putaran'); }
    for (const m of ['proto', 'io']) { mode = m; await fill('terus-' + m, 3); calls = 0; await B._pcqFlush(A.id); assert.strictEqual(calls, 3, m + ': galat per entri, putaran jalan terus'); assert.deepStrictEqual(tries(), [1, 1, 1]); }
    mode = null;
    // 'same': pemilik sudah punya komentar itu (jawaban kiriman sebelumnya hilang) = terkirim, bukan galat
    const dup = A.pageStore().commentsFor(B.id, post.id)[0]; B._pcqStore().map.clear(); ev.length = 0; B._pcqStore().add(A.id, post.id, dup, Date.now()); calls = 0; await B._pcqFlush(A.id);
    assert.deepStrictEqual(ev.map((e) => e.ev + ':' + e.why + ':' + e.id), ['sent:same:' + dup.id], 'kirim ulang = same'); assert.strictEqual(B._pcqStore().size, 0);
    // hello pemilik sudah dikenal tanpa 'pgc' (versi lama): dibuang tanpa menyentuh jaringan
    const caps = B.peers.get(A.id).caps; B._pcqStore().add(A.id, post.id, cmtSign(B.privKey, B.pub, A.id, post.id, 'untuk versi lama', Date.now()), Date.now()); B.peers.get(A.id).caps = ['pg', 'pgm']; ev.length = 0; calls = 0; await B._pcqFlush(A.id);
    assert.strictEqual(calls, 0, 'tanpa permintaan ke pemilik lama'); assert.deepStrictEqual(ev.map((e) => e.ev + ':' + e.why), ['drop:old']); assert.strictEqual(B._pcqStore().size, 0); B.peers.get(A.id).caps = caps;
    // pemilik offline / tidak dikenal di tengah putaran: berhenti tanpa permintaan
    B._pcqStore().add(A.id, post.id, cmtSign(B.privKey, B.pub, A.id, post.id, 'offline di tengah', Date.now()), Date.now()); const ls = B.peers.get(A.id).lastSeen; B.peers.get(A.id).lastSeen = 0; calls = 0; await B._pcqFlush(A.id); assert.strictEqual(calls, 0, 'offline = tidak ada permintaan'); assert.strictEqual(B._pcqStore().size, 1); B.peers.get(A.id).lastSeen = ls;
    // maks 10 kiriman per putaran: 14 entri = 10 lalu 4
    { const bp2 = A.pageStore().create({ text: 'batch' }); B._pcqStore().map.clear(); for (let i = 0; i < 14; i++) { await B.pageCommentQueue(A.id, bp2.id, 'b' + i); await sleep(3); }
      calls = 0; await B._pcqFlush(A.id); assert.strictEqual(calls, 10, 'putaran pertama maks 10'); assert.strictEqual(B.pageCommentPending(A.id, bp2.id).length, 4);
      await B._pcqFlush(A.id); assert.strictEqual(calls, 14); assert.strictEqual(B.pageCommentPending(A.id, bp2.id).length, 0); }
    // diblokir: tidak ada permintaan; diblokir DI TENGAH putaran: putaran berhenti
    await fill('blokir-', 3); B.store.blocked[A.id] = 1; calls = 0; await B._pcqFlush(A.id); assert.strictEqual(calls, 0, 'diblokir = tanpa permintaan walau _pcqFlush dipanggil langsung'); delete B.store.blocked[A.id];
    B._pgAsk = async (...a) => { calls++; B.store.blocked[A.id] = 1; return real(...a); }; calls = 0; await B._pcqFlush(A.id); assert.strictEqual(calls, 1, 'diblokir di tengah putaran: berhenti'); assert.strictEqual(B.pageCommentPending(A.id, post.id).length, 3, 'semua entri tetap menunggu'); delete B.store.blocked[A.id];
    B._pcqStore().map.clear(); B._pgAsk = real; delete B._pcqTick;
    ok('putaran: maks 10 kiriman per putaran, diblokir (juga di tengah putaran) = berhenti; offline / busy / auth / time / blocked / peer menghentikan putaran (1 permintaan dari 3 entri), proto / io jalan terus dan menghitung; kirim ulang = sent same; pemilik tanpa pgc = drop old tanpa jaringan; pemilik offline = tanpa permintaan');
  }
  {
    // pemilik diblokir: tidak ada kiriman sama sekali; dibuka = lanjut
    const real = B._pgAsk.bind(B); let calls = 0; B._pgAsk = async (...a) => { calls++; return real(...a); };
    B.store.blocked[A.id] = 1; ev.length = 0; B._pcqStore().map.clear(); const id = await (async () => { delete B.store.blocked[A.id]; const r = await B.pageCommentQueue(A.id, post.id, 'saat diblokir'); B.store.blocked[A.id] = 1; return r.c.id; })();
    await sleep(600); assert.strictEqual(calls, 0, 'tidak ada permintaan ke pemilik yang diblokir'); assert(B._pcqStore().map.has(id));
    delete B.store.blocked[A.id]; await until(() => ev.length === 1, 8000, 'terkirim setelah dibuka'); assert.strictEqual(ev[0].ev + ':' + ev[0].why, 'sent:added'); B._pgAsk = real;
    ok('pemilik diblokir: tidak ada permintaan sama sekali; dibuka blokirnya = terkirim');
  }
  {
    // satu putaran per pemilik; batal selagi menunggu jawaban; maks CQ_BATCH per putaran
    const real = B._pgAsk.bind(B); let calls = 0, gate = null; B._pgAsk = async (...a) => { calls++; if (gate) await gate; return real(...a); };
    let open; gate = new Promise((r) => { open = r; }); ev.length = 0; B._pcqStore().map.clear();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await B.pageCommentQueue(A.id, post.id, 'putaran ' + i)).c.id);
    await until(() => calls === 1, 3000, 'permintaan pertama menggantung'); await Promise.all([B._pcqFlush(A.id), B._pcqFlush(A.id)].map((p) => Promise.race([p, sleep(200)]))); await sleep(400); assert.strictEqual(calls, 1, 'satu putaran per pemilik: tick dan panggilan langsung tidak menggandakan');
    assert.strictEqual(B.pageCommentCancel(A.id, ids[0]), true, 'dibatalkan selagi dikirim'); open(); gate = null;
    await until(() => ev.filter((e) => e.ev === 'sent').length === 2, 8000, 'sisanya terkirim');
    assert.strictEqual(ev.some((e) => e.id === ids[0]), false, 'yang dibatalkan selagi menunggu tidak mengirim event'); assert.strictEqual(B.pageCommentPending(A.id, post.id).length, 0);
    B._pgAsk = real; ok('satu putaran per pemilik; dibatalkan selagi dikirim = hasilnya diabaikan (pemilik mungkin sudah menerimanya: tak bisa ditarik)');
  }
  {
    // CQ_BATCH: lebih dari 10 entri jatuh tempo = dikirim bertahap (maks 10 per putaran), semuanya sampai tanpa ganda
    const bp = A.pageStore().create({ text: 'bertahap' }), many = 14;
    await offline(); ev.length = 0; B._pcqStore().map.clear();
    for (let i = 0; i < many; i++) await B.pageCommentQueue(A.id, bp.id, 'bertahap ' + i);
    let seen = 0; const real = B._pgAsk.bind(B); B._pgAsk = async (...a) => { seen++; return real(...a); };
    await online();
    await until(() => ev.filter((e) => e.ev === 'sent').length === many, 15000, 'semua terkirim');
    assert.strictEqual(B.pageCommentPending(A.id, bp.id).length, 0); assert.strictEqual(A.pageStore().commentsFor(B.id, bp.id).length, many, 'semua sampai, tanpa ganda'); assert.strictEqual(seen, many, 'tiap komentar dikirim sekali');
    B._pgAsk = real; ok(many + ' komentar menumpuk (> batch 10): terkirim semua lewat beberapa putaran, sekali per komentar, tanpa ganda');
  }
  for (const n of [A, B, C]) await n.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + pass + ' kelompok lulus');
})().catch((e) => { console.error(e); process.exit(1); });

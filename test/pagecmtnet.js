'use strict';
// Tes Halaman 4b-2: komentar lewat jaringan. Murni (wireComments, cmtPage, kanon tanda tangan), PEMILIK (pg_cmt / pg_cml lewat soket lokal), PEMINTA (pageComment / pageComments) dan caps 'pgc'.
// Penyimpanan dan tanda tangan komentar diuji di test/archne-pagecmt.js; di sini yang diuji adalah jalurnya.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), crypto = require('crypto');
const { Core } = require('../src/archne-core');
const { cmtSign, cmtPage, wireComments, CMT_PAGE_MAX, CMT_PER_AUTHOR, CMT_SKEW } = require('../src/archne-pagecmt');
const { pgSignReq } = require('../src/archne-pagestore');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagecmtnet-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); } throw new Error('timeout: ' + label); }
let pass = 0;
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const strip = (r) => { if (r) delete r.hi; return r; };
const code = async (p) => { try { await p; } catch (e) { return e.code; } return 'tidak melempar'; };
const hex = (n) => n.toString(16).padStart(16, '0');
const NONE = 'f'.repeat(16);
const { PG_ERR } = require('../src/core/archne-pgerr');
const msg = async (p) => { try { await p; } catch (e) { return e.message; } return 'tidak melempar'; };
// identitas palsu untuk menyusun komentar dari "orang lain" tanpa Core
const ident = () => { const k = crypto.generateKeyPairSync('ed25519'); return { priv: k.privateKey, pub: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }; };
const by = (x, owner, post, text, now) => cmtSign(x.priv, x.pub, owner, post, text, now);
const mine = (core, owner, post, text, now) => cmtSign(core.privKey, core.pub, owner, post, text, now);

(async () => {
  // ---- A. murni: cmtPage, wireComments, kanon tanda tangan ----
  const OWN = hex(1), POST = hex(2), X = ident(), Y = ident();
  const mkc = (i, who) => by(who || X, OWN, POST, 'k' + i, 1000 + i);
  {
    const L = [1, 2, 3, 4, 5].map((i) => mkc(i)).sort((a, b) => a.ts - b.ts);
    assert.deepStrictEqual(cmtPage(L, null, 2).items.map((c) => c.text), ['k1', 'k2']); assert.strictEqual(cmtPage(L, null, 2).next, L[1].ts + ':' + L[1].id);
    const p2 = cmtPage(L, cmtPage(L, null, 2).next, 2); assert.deepStrictEqual(p2.items.map((c) => c.text), ['k3', 'k4']); assert.strictEqual(p2.next, L[3].ts + ':' + L[3].id);
    const p3 = cmtPage(L, p2.next, 2); assert.deepStrictEqual(p3.items.map((c) => c.text), ['k5']); assert.strictEqual(p3.next, null, 'halaman terakhir tanpa next');
    assert.strictEqual(cmtPage(L, null, 5).next, null, 'tepat habis = tanpa next'); assert.strictEqual(cmtPage(L, null, 4).next !== null, true);
    assert.strictEqual(cmtPage(L, null, 0).items.length, 1, 'limit dipangkas ke 1'); assert.strictEqual(cmtPage(L, null, 9999).items.length, 5); assert.strictEqual(cmtPage(L, null, 1.5).items.length, 5, 'bukan bilangan bulat = bawaan');
    { const syn = Array.from({ length: 150 }, (_, i) => ({ ts: i + 1, id: hex(i) })); assert.strictEqual(cmtPage(syn, null, 9999).items.length, CMT_PAGE_MAX, 'dipangkas ke batas'); assert.strictEqual(cmtPage(syn, null).items.length, 50, 'bawaan 50'); assert.strictEqual(cmtPage(syn, null, 100).next !== null, true); }
    assert.throws(() => cmtPage(L, 'abc', 2), /Kursor/); assert.deepStrictEqual(cmtPage([], null, 5), { items: [], next: null });
    assert.strictEqual(cmtPage(L, '99999:' + 'f'.repeat(16), 2).items.length, 0, 'kursor di ujung = kosong');
    // seri ts diputus id
    const t1 = by(X, OWN, POST, 'a', 5000), t2 = by(Y, OWN, POST, 'b', 5000), T = [t1, t2].sort((a, b) => (a.id < b.id ? -1 : 1));
    assert.deepStrictEqual(cmtPage(T, T[0].ts + ':' + T[0].id, 5).items, [T[1]], 'seri ts: id memutus');
    ok('cmtPage: halaman, kursor maju ketat, limit dipangkas, seri ts diputus id, kursor jelek melempar');
  }
  {
    const L = [1, 2, 3, 4].map((i) => mkc(i));
    const w = (r, req, o, p) => wireComments(r, req, o || OWN, p || POST);
    const good = w({ items: L, next: null, count: 9 }, { limit: 10 });
    assert.deepStrictEqual(good.items, L); assert.strictEqual(good.count, 9); assert.strictEqual(good.skipped, 0); assert.strictEqual(good.next, null);
    assert.deepStrictEqual(w({ items: L.map((c) => Object.assign({ evil: 1 }, c)), next: null, count: 4 }, {}).items, L, 'bidang asing dibuang');
    // komentar palsu / bukan untuk sini DIBUANG dan dihitung, tidak menggagalkan halaman
    const forged = Object.assign({}, L[1], { text: 'diganti' }), other = by(X, hex(9), POST, 'halaman lain', 1050), otherPost = by(X, OWN, hex(7), 'postingan lain', 1060);
    const swap = Object.assign({}, L[0], { by: by(Y, OWN, POST, 'z', 1).by }); // penulis diganti: id cocok kunci gagal
    const r2 = w({ items: [L[0], forged, other, otherPost, swap, 'x', null, L[2]], next: null, count: 8 }, { limit: 10 });
    assert.deepStrictEqual(r2.items, [L[0], L[2]]); assert.strictEqual(r2.skipped, 6, 'enam komentar cacat dibuang dan dihitung');
    // urutan / ganda / sebelum kursor = jawaban cacat seluruhnya
    assert.strictEqual(w({ items: [L[1], L[0]], next: null, count: 2 }, {}), null, 'urutan terbalik'); assert.strictEqual(w({ items: [L[0], L[0]], next: null, count: 2 }, {}), null, 'ganda');
    assert.strictEqual(w({ items: [L[0], L[1]], next: null, count: 2 }, { after: L[0].ts + ':' + L[0].id }), null, 'tidak sesudah kursor'); assert.strictEqual(w({ items: [L[1]], next: null, count: 2 }, { after: L[0].ts + ':' + L[0].id }).items.length, 1);
    // jumlah / count
    assert.strictEqual(w({ items: L, next: null, count: 3 }, {}), null, 'count < jumlah item'); assert.strictEqual(w({ items: L, next: null, count: 501 }, {}), null, 'count > batas per postingan'); assert.strictEqual(w({ items: L, next: null, count: 4.5 }, {}), null);
    assert.strictEqual(w({ items: L, next: null, count: 4 }, { limit: 3 }), null, 'lebih banyak dari yang kuminta'); assert.strictEqual(w({ items: L, next: null, count: 4 }, { limit: 4 }) !== null, true); assert.strictEqual(w({ items: L, next: null, count: 4 }, {}) !== null, true, 'bawaan 50');
    const big = Array.from({ length: CMT_PAGE_MAX + 1 }, (_, i) => mkc(i)); assert.strictEqual(w({ items: big, next: null, count: 200 }, { limit: 9999 }), null, 'limit dipangkas ke batas');
    for (const bad of [null, 5, 'x', {}, { items: 'x', count: 0 }, { items: [], count: -1 }, { items: [], count: 'x' }, { count: 0 }]) assert.strictEqual(w(bad, {}), null, JSON.stringify(bad));
    // kursor next
    const c1 = L[0].ts + ':' + L[0].id, c3 = L[2].ts + ':' + L[2].id;
    assert.strictEqual(w({ items: L.slice(0, 3), next: c3, count: 9 }, { limit: 3 }).next, c3, 'next sah');
    assert.strictEqual(w({ items: L.slice(0, 3), next: c1, count: 9 }, { limit: 3 }), null, 'next mundur ke belakang item terakhir');
    assert.strictEqual(w({ items: L.slice(0, 2), next: c3, count: 9 }, { limit: 3 }).next, c3, 'next boleh lebih maju dari item terakhir (item cacat di ujung dibuang)');
    for (const nx of ['abc', 5, '1:2', {}]) assert.strictEqual(w({ items: L.slice(0, 3), next: nx, count: 9 }, {}), null, 'next jelek ' + JSON.stringify(nx));
    assert.strictEqual(w({ items: [], next: c3, count: 9 }, {}), null, 'next tanpa kemajuan (item kosong)');
    assert.strictEqual(w({ items: L.slice(1, 3), next: c1, count: 9 }, { after: c1 }), null, 'next tidak maju dari kursor yang kuminta'); assert.strictEqual(w({ items: [forged], next: c1, count: 9 }, { after: c1 }), null, 'next tidak maju walau semua item dibuang'); assert.strictEqual(w({ items: [forged], next: c3, count: 9 }, { after: c1 }).skipped, 1); assert.strictEqual(w({ items: L.slice(1, 3), next: c3, count: 9 }, { after: c1 }).next, c3);
    assert.strictEqual(w({ items: L.slice(0, 3), next: undefined, count: 9 }, {}).next, null);
    ok('wireComments: tanda tangan tiap komentar diperiksa (palsu / halaman lain / postingan lain dibuang), urutan, ganda, kursor, count, limit; bidang asing dibuang');
  }
  {
    const c = mkc(1), req = { t: 'pg_cmt', id: POST, c }, k = ident();
    const sg = (o) => pgSignReq(k.priv, OWN, o, 1e6, 'a'.repeat(16)).sig;
    assert.notStrictEqual(sg(req), sg({ t: 'pg_cmt', id: POST, c: mkc(2) }), 'id komentar ikut ditandatangani');
    assert.strictEqual(sg(req), sg({ t: 'pg_cmt', id: POST, c: Object.assign({}, c, { text: 'bebas' }) }), 'bidang lain komentar tertutup lewat id (tanda tangan penulis), bukan lewat kanon');
    assert.notStrictEqual(sg(req), sg({ t: 'pg_cmt', id: POST }), 'tanpa c berbeda'); assert.notStrictEqual(sg(req), sg({ t: 'pg_cmt', id: POST, c: 'x' }));
    assert.notStrictEqual(sg({ t: 'pg_cml', id: POST }), sg({ t: 'pg_get', id: POST }), 'pg_cml tak bisa dijadikan pg_get');
    assert.notStrictEqual(sg({ t: 'pg_cml', id: POST, after: '1:' + hex(1) }), sg({ t: 'pg_cml', id: POST }), 'after tertutup'); assert.notStrictEqual(sg({ t: 'pg_cml', id: POST, limit: 5 }), sg({ t: 'pg_cml', id: POST }), 'limit tertutup');
    ok('kanon tanda tangan: pg_cmt menutup id komentar, pg_cml menutup id / after / limit, jenis permintaan tidak bisa ditukar');
  }

  // ---- jaringan: A pemilik, B teman, C asing, D diblokir, E pemilik yang belum pernah memakai Halaman ----
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D'), E = mk('E');
  for (const n of [A, B, C, D, E]) await n.start();
  const ask = async (from, to, obj) => strip(await from._request(from.peers.get(to.id), from._pgSign(to.id, obj), 4000));
  for (const n of [B, C, D]) await n.addPeer('127.0.0.1', A.port);
  await E.addPeer('127.0.0.1', C.port);
  await until(() => [B, C, D].every((n) => n.peers.has(A.id) && A.peers.has(n.id)) && C.peers.has(E.id) && E.peers.has(C.id), 8000, 'peer saling kenal');
  A.store.friends[B.id] = { st: 'ok' }; A.store.blocked[D.id] = 1;
  const ps = A.pageStore(), pub = ps.create({ text: 'publik' }), frd = ps.create({ text: 'teman', priv: 'friends' });
  const cm = (from, id, c) => ask(from, A, { t: 'pg_cmt', id, c }), cl = (from, id, extra) => ask(from, A, Object.assign({ t: 'pg_cml', id }, extra));
  const BADW = { t: 'pg_cmt', ok: false, err: 'bad' }, BADL = { t: 'pg_cml', ok: false, err: 'bad' }, NULLW = { t: 'pg_cmt', ok: true, r: null }, NULLL = { t: 'pg_cml', ok: true, r: null };
  const reset = () => { A._pgCmtL = null; A._pgSeenC = null; };

  // ---- B. caps ----
  assert(A.hello().caps.includes('pgc') && B.peers.get(A.id).caps.includes('pgc'), "caps 'pgc' diumumkan dan dicatat");
  assert.deepStrictEqual(A.hello().caps, ['rx', 'pg', 'pgm', 'pgr', 'pgc', 'pgd', 'pgt', 'pgk']);
  ok("hello membawa caps 'pgc' dan peer mencatatnya");

  // ---- C. pemilik menerima pg_cmt ----
  {
    const c1 = mine(B, A.id, pub.id, 'komentar teman', Date.now());
    assert.deepStrictEqual(await cm(B, pub.id, c1), { t: 'pg_cmt', ok: true, r: 'added' });
    assert.deepStrictEqual(await cm(B, pub.id, c1), { t: 'pg_cmt', ok: true, r: 'same' }, 'kirim ulang persis = same');
    assert.deepStrictEqual(ps.commentsFor(A.id, pub.id), [c1], 'tersimpan lengkap dengan tanda tangannya');
    const cc = mine(C, A.id, pub.id, 'komentar asing', Date.now()); assert.strictEqual((await cm(C, pub.id, cc)).r, 'added', 'asing boleh di postingan Publik');
    assert.strictEqual((await cm(B, frd.id, mine(B, A.id, frd.id, 'di teman', Date.now()))).r, 'added', 'teman boleh di postingan Teman');
    // tak terlihat: semuanya null yang SAMA (asing di Teman, diblokir, tak ada), dan tidak tersimpan
    const cF = mine(C, A.id, frd.id, 'asing di teman', Date.now()), cD = mine(D, A.id, pub.id, 'diblokir', Date.now()), cN = mine(C, A.id, NONE, 'tak ada', Date.now());
    assert.deepStrictEqual(await cm(C, frd.id, cF), NULLW, 'Teman untuk asing'); assert.deepStrictEqual(await cm(D, pub.id, cD), NULLW, 'diblokir'); assert.deepStrictEqual(await cm(C, NONE, cN), NULLW, 'tidak ada');
    assert.strictEqual(ps.commentsFor(A.id, frd.id).length, 1); assert.strictEqual(ps.commentsFor(A.id, pub.id).length, 2);
    // pemilik belum punya halaman: null yang sama, folder tidak dibuat
    const Ec = mine(C, E.id, pub.id, 'x', Date.now()); assert.deepStrictEqual(await ask(C, E, { t: 'pg_cmt', id: pub.id, c: Ec }), NULLW); assert(!fs.existsSync(path.join(tmp, 'E', 'pages')), 'berkomentar tidak membuat folder halaman');
    ok("pg_cmt: tambah / same, tersimpan bertanda tangan, Teman tertutup untuk asing, diblokir / tak ada / folder belum ada = null yang sama dan tidak tersimpan");
  }

  // ---- D. bentuk dan tanda tangan: 'bad' / 'time' TIDAK bergantung pada relasi ----
  {
    const now = Date.now();
    const X1 = ident(), forgeSig = Object.assign({}, mine(B, A.id, pub.id, 'asli', now), { text: 'diganti' });
    const cases = {
      'penulis bukan pengirim': by(X1, A.id, pub.id, 'titipan', now), 'komentar sah penulis lain dititipkan lewat B': mine(C, A.id, pub.id, 'milik C', now),
      'untuk postingan lain': mine(B, A.id, hex(77), 'x', now), 'untuk halaman lain': mine(B, C.id, pub.id, 'x', now), 'tanda tangan rusak': forgeSig,
      'null': null, 'angka': 5, 'larik': [], 'tanpa bidang': {}, 'teks belum kanonis': Object.assign({}, mine(B, A.id, pub.id, 'x', now), { text: ' x ' }),
    };
    for (const [n, c] of Object.entries(cases)) {
      assert.deepStrictEqual(await cm(B, pub.id, c), BADW, 'Publik: ' + n); assert.deepStrictEqual(await cm(B, frd.id, c && typeof c === 'object' ? Object.assign({}, c, { post: frd.id }) : c), BADW, 'Teman: ' + n);
    }
    // sama untuk yang tak boleh melihat: bentuk salah dijawab SEBELUM relasi (C di postingan Teman, D diblokir, id tak ada)
    const bC = Object.assign({}, mine(C, A.id, frd.id, 'asing', now), { text: 'diganti' });
    assert.deepStrictEqual(await cm(C, frd.id, bC), BADW, 'tanda tangan rusak di Teman bagi asing = bad, bukan null'); assert.deepStrictEqual(await cm(D, pub.id, Object.assign({}, mine(D, A.id, pub.id, 'd', now), { text: 'e' })), BADW); assert.deepStrictEqual(await cm(C, NONE, Object.assign({}, mine(C, A.id, NONE, 'd', now), { text: 'e' })), BADW);
    for (const id of ['zz', 5, null, undefined, 'F'.repeat(16)]) assert.deepStrictEqual(await cm(B, id, mine(B, A.id, pub.id, 'x', now)), BADW, 'id jelek ' + String(id));
    // ts terlalu jauh di depan: time (juga tidak bergantung pada relasi); batas tepat masih lolos
    const far = mine(C, A.id, frd.id, 'depan', Date.now() + CMT_SKEW + 30e3); assert.deepStrictEqual(await cm(C, frd.id, far), { t: 'pg_cmt', ok: false, err: 'time' }, 'tak terlihat pun dijawab time, sama dengan yang terlihat');
    assert.deepStrictEqual(await cm(B, pub.id, mine(B, A.id, pub.id, 'depan', Date.now() + CMT_SKEW + 30e3)), { t: 'pg_cmt', ok: false, err: 'time' });
    assert.strictEqual((await cm(B, pub.id, mine(B, A.id, pub.id, 'hampir depan', Date.now() + CMT_SKEW - 30e3))).r, 'added', 'di dalam toleransi');
    assert.strictEqual((await cm(B, pub.id, mine(B, A.id, pub.id, 'masa lalu jauh', 5))).r, 'added', 'masa lalu tidak diperiksa');
    // penulis diperiksa lewat tanda tangan permintaan: hello salinan tanpa kunci
    const nosig = await new Promise((res) => { const s = require('net').connect(A.port, '127.0.0.1'); let b = ''; s.on('data', (d) => { b += d; if (b.includes('\n')) { s.destroy(); res(strip(JSON.parse(b))); } }); s.on('connect', () => s.write(JSON.stringify({ hi: B.hello(), t: 'pg_cmt', id: pub.id, c: mine(B, A.id, pub.id, 'tanpa tanda tangan', Date.now()) }) + '\n')); });
    assert.deepStrictEqual(nosig, { t: 'pg_cmt', ok: false, err: 'auth' }); assert(!ps.commentsFor(A.id, pub.id).some((x) => x.text === 'tanpa tanda tangan'));
    ok("pg_cmt: penulis harus pengirim terbukti, komentar harus untuk halaman + postingan ini dan bertanda tangan sah ('bad' sebelum relasi, sama untuk yang tak terlihat), ts di depan = 'time'");
  }

  // ---- E. tanda tangan permintaan menutup komentar; putar ulang; nonce terpisah ----
  {
    reset();
    const c = mine(B, A.id, pub.id, 'tertutup', Date.now()), other = mine(B, A.id, pub.id, 'tertukar', Date.now() + 1);
    const signed = B._pgSign(A.id, { t: 'pg_cmt', id: pub.id, c });
    const swapped = Object.assign({}, signed, { c: other }); assert.deepStrictEqual(strip(await B._request(B.peers.get(A.id), swapped, 4000)), { t: 'pg_cmt', ok: false, err: 'auth' }, 'komentar ditukar di jalan');
    assert.strictEqual((await ask(B, A, { t: 'pg_cml', id: pub.id })).r.items.some((x) => x.text === 'tertukar'), false);
    const r = strip(await B._request(B.peers.get(A.id), signed, 4000)); assert.strictEqual(r.r, 'added');
    assert.deepStrictEqual(strip(await B._request(B.peers.get(A.id), signed, 4000)), { t: 'pg_cmt', ok: false, err: 'auth' }, 'putar ulang');
    const asList = B._pgSign(A.id, { t: 'pg_cml', id: pub.id }); assert.strictEqual(strip(await B._request(B.peers.get(A.id), asList, 4000)).ok, true);
    assert.deepStrictEqual(strip(await B._request(B.peers.get(A.id), asList, 4000)), { t: 'pg_cml', ok: false, err: 'auth' }, 'putar ulang pg_cml');
    // pg_cml yang diubah jadi pg_cmt (dan sebaliknya) gagal: jenis tertutup
    const l2 = B._pgSign(A.id, { t: 'pg_cml', id: pub.id }); assert.deepStrictEqual(strip(await B._request(B.peers.get(A.id), Object.assign({}, l2, { t: 'pg_cmt', c }), 4000)), { t: 'pg_cmt', ok: false, err: 'auth' });
    const g = B._pgSign(A.id, { t: 'pg_get', id: pub.id }); assert.strictEqual(strip(await B._request(B.peers.get(A.id), Object.assign({}, g, { t: 'pg_cml' }), 4000)).err, 'auth', 'pg_get tak bisa dijadikan pg_cml');
    // penampung nonce sendiri
    const big = new Map(); for (let i = 0; i < 20000; i++) big.set('k' + i, Date.now() + 1e6);
    A._pgSeenC = new Map(big);
    assert.deepStrictEqual(await cl(B, pub.id), { t: 'pg_cml', ok: false, err: 'busy' }, 'nonce komentar penuh = busy'); assert.deepStrictEqual(await cm(B, pub.id, mine(B, A.id, pub.id, 'penuh', Date.now())), { t: 'pg_cmt', ok: false, err: 'busy' });
    assert.strictEqual((await ask(B, A, { t: 'pg_get', id: pub.id })).ok, true, 'pg_get tetap jalan'); assert.strictEqual((await ask(B, A, { t: 'pg_list' })).ok, true); assert.strictEqual((await ask(B, A, { t: 'pg_rx', id: pub.id, e: '👍' })).ok, true, 'pg_rx tetap jalan'); A._pgSeenC = null;
    A._pgSeen = new Map(big); assert.strictEqual((await cl(B, pub.id)).ok, true, 'nonce pg_list / pg_get penuh tidak mematikan komentar'); assert.strictEqual((await ask(B, A, { t: 'pg_get', id: pub.id })).err, 'busy'); A._pgSeen = null;
    A._pgSeenR = new Map(big); assert.strictEqual((await cl(B, pub.id)).ok, true, 'nonce pg_rx penuh tidak mematikan komentar'); A._pgSeenR = null;
    ok('tanda tangan permintaan menutup komentar dan jenis permintaan, putar ulang ditolak, nonce komentar di penampung sendiri');
  }

  // ---- F. laju ----
  {
    reset();
    const busy = { t: 'pg_cmt', ok: false, err: 'busy' }, T0 = Date.now();
    const send = (from, i) => cm(from, pub.id, mine(from, A.id, pub.id, 'laju ' + from.name + i, T0 + i));
    for (let i = 0; i < 30; i++) assert.strictEqual((await send(B, i)).ok, true, 'jatah tulis ke-' + (i + 1));
    for (let i = 30; i < 33; i++) assert.deepStrictEqual(await send(B, i), busy, 'jatah tulis per peer habis');
    assert.strictEqual((await send(C, 0)).r, 'added', 'peer lain tidak ikut terkena'); assert.strictEqual((await cl(B, pub.id)).ok, true, 'jatah baca terpisah dari tulis');
    // yang melewati jatahnya sendiri tidak memakan jatah global: 30 (B) + 1 (C) terpakai, sisa 69
    assert.strictEqual(A._pgCmtL.wa.take('*', 69, Date.now()), true, 'jatah global hanya terpakai oleh yang lolos'); assert.strictEqual(A._pgCmtL.wa.take('*', 1, Date.now()), false);
    assert.deepStrictEqual(await send(B, 40), busy, 'tulis sah sesudah jatah habis = busy'); assert.deepStrictEqual(await cm(B, pub.id, mine(B, A.id, hex(77), 'x', T0)), BADW, 'c.post bukan postingan yang diminta = bad, walau jatah habis (bentuk sebelum laju)'); assert.deepStrictEqual(await cm(B, pub.id, mine(C, A.id, pub.id, 'x', T0)), BADW, 'penulis bukan pengirim = bad walau jatah habis'); assert.deepStrictEqual(await cm(B, pub.id, null), BADW);
    assert.deepStrictEqual(await send(C, 1), busy, 'batas global tulis (semua peer)');
    assert.strictEqual((await cl(C, pub.id)).ok, true, 'baca punya jatah global sendiri');
    reset();
    assert.strictEqual((await cl(B, pub.id)).ok, true); assert.strictEqual(A._pgCmtL.rp.take(B.id, 118, Date.now()), true, 'jatah baca per peer: 119 terpakai'); // beruntun, batas global (100 / 10 dtk) lebih dulu tercapai daripada 120 / menit, jadi jatah per peer diisi langsung
    assert.strictEqual((await cl(B, pub.id)).ok, true, 'baca ke-120'); assert.deepStrictEqual(await cl(B, pub.id), { t: 'pg_cml', ok: false, err: 'busy' }, 'jatah baca per peer habis'); assert.strictEqual((await cl(C, pub.id)).ok, true, 'peer lain tidak ikut');
    assert.strictEqual(A._pgCmtL.ra.take('*', 97, Date.now()), true, 'baca B yang ditolak tidak memakan jatah global (3 lolos + 97 = 100)'); assert.strictEqual(A._pgCmtL.ra.take('*', 1, Date.now()), false);
    assert.deepStrictEqual(await cl(C, pub.id), { t: 'pg_cml', ok: false, err: 'busy' }, 'batas global baca');
    // urutan: bentuk salah dijawab bad walau jatah habis; busy sebelum tanda tangan komentar diperiksa
    assert.deepStrictEqual(await cl(C, 'zz'), BADL, 'bentuk salah sebelum laju');
    reset(); assert.deepStrictEqual(await cm(C, pub.id, null), BADW);
    for (let i = 0; i < 30; i++) await cm(C, pub.id, Object.assign({}, mine(C, A.id, pub.id, 'rusak', 1), { text: 'rusak' + i })); // tanda tangan rusak tetap memakan jatah
    assert.deepStrictEqual(await cm(C, pub.id, mine(C, A.id, pub.id, 'sah', Date.now())), busy, 'tanda tangan rusak tidak gratis: laju dihitung sebelum verifikasi');
    reset();
    ok('laju: tulis 30 / menit per peer + 100 / 10 dtk global, baca 120 / menit + 100 / 10 dtk, terpisah satu sama lain, yang kena batas sendiri tidak memakan jatah global, bentuk salah sebelum busy');
  }

  // ---- G. batas jumlah: 'full' hanya sesudah izin lihat ----
  {
    reset();
    const fp = ps.create({ text: 'batas' }), ff = ps.create({ text: 'batas teman', priv: 'friends' });
    for (let i = 0; i < CMT_PER_AUTHOR; i++) ps.comment(B.id, fp.id, mine(B, A.id, fp.id, 'b' + i, 100 + i));
    assert.deepStrictEqual(await cm(B, fp.id, mine(B, A.id, fp.id, 'ke dua puluh satu', Date.now())), { t: 'pg_cmt', ok: true, r: 'full' }, 'per penulis penuh = full (bukan null, bukan galat)');
    assert.strictEqual((await cm(C, fp.id, mine(C, A.id, fp.id, 'orang lain masih boleh', Date.now()))).r, 'added', 'penulis lain tidak terkena');
    assert.strictEqual((await cm(B, fp.id, mine(B, A.id, fp.id, 'b0', 100))).r, 'same', 'yang sudah ada tetap same, bukan full');
    for (let i = 0; i < CMT_PER_AUTHOR; i++) ps.comment(B.id, ff.id, mine(B, A.id, ff.id, 'f' + i, 100 + i));
    assert.deepStrictEqual(await cm(C, ff.id, mine(C, A.id, ff.id, 'asing', Date.now())), NULLW, 'asing di postingan Teman = null, tidak bisa menebak isinya lewat full');
    assert.strictEqual((await cm(B, ff.id, mine(B, A.id, ff.id, 'penuh teman', Date.now()))).r, 'full');
    // gagal tulis = null (tak dibedakan dari tak ada), dicatat ke log, penyimpanan tetap utuh
    const logs = []; const lg = A.opts.log; A.opts.log = (m) => logs.push(m); const w = ps.cmt.write; ps.cmt.write = () => { throw new Error('disk penuh'); };
    assert.deepStrictEqual(await cm(C, pub.id, mine(C, A.id, pub.id, 'gagal tulis', Date.now())), NULLW); assert(logs.some((m) => /pg_cmt: disk penuh/.test(m)), 'dicatat'); ps.cmt.write = w; A.opts.log = lg;
    assert(!ps.commentsFor(A.id, pub.id).some((x) => x.text === 'gagal tulis'), 'memori kembali seperti berkas');
    reset();
    ok("batas: 'full' (per penulis) hanya dijawab sesudah izin lihat, same tetap same, gagal tulis = null + log tanpa mengubah penyimpanan");
  }

  // ---- H. pemilik melayani pg_cml ----
  {
    reset();
    const lp = ps.create({ text: 'daftar' }), lf = ps.create({ text: 'daftar teman', priv: 'friends' }), t0 = Date.now() - 1e5;
    const own = [1, 2, 3, 4, 5, 6, 7].map((i) => [i, mine(i % 2 ? B : C, A.id, lp.id, 'k' + i, t0 + i * 10)]); for (const [, c] of own) ps.comment(c.by, lp.id, c, Date.now());
    const r = await cl(B, lp.id); assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.r.items.map((c) => c.text), ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'], 'tertua dulu'); assert.strictEqual(r.r.count, 7); assert.strictEqual(r.r.next, null);
    assert.deepStrictEqual(r.r.items[0], own[0][1], 'komentar utuh dengan tanda tangannya (bukti untuk peminta)');
    const p1 = (await cl(B, lp.id, { limit: 3 })).r; assert.deepStrictEqual(p1.items.map((c) => c.text), ['k1', 'k2', 'k3']); assert.strictEqual(p1.count, 7, 'count = seluruh komentar'); assert(p1.next);
    const p2 = (await cl(B, lp.id, { limit: 3, after: p1.next })).r; assert.deepStrictEqual(p2.items.map((c) => c.text), ['k4', 'k5', 'k6']);
    const p3 = (await cl(B, lp.id, { limit: 3, after: p2.next })).r; assert.deepStrictEqual(p3.items.map((c) => c.text), ['k7']); assert.strictEqual(p3.next, null);
    assert.strictEqual((await cl(B, lp.id, { limit: 0 })).r.items.length, 1, 'limit dipangkas'); assert.strictEqual((await cl(B, lp.id, { limit: 1.5 })).r.items.length, 7, 'bukan bulat = bawaan'); assert.strictEqual((await cl(B, lp.id, { limit: 'x' })).r.items.length, 7);
    assert.strictEqual((await cl(B, lp.id, { limit: 100000 })).r.items.length, 7);
    assert.deepStrictEqual(await cl(B, lp.id, { after: 'abc' }), BADL, 'kursor jelek'); assert.deepStrictEqual(await cl(B, lp.id, { after: 5 }), BADL); assert.deepStrictEqual(await cl(B, lp.id, { after: '1:zz' }), BADL);
    for (const id of ['zz', 5, null]) assert.deepStrictEqual(await cl(B, id), BADL, 'id jelek ' + String(id));
    // kosong vs tak terlihat: berbeda (kosong = daftar kosong; tak terlihat = null), dan tak terlihat seragam
    const ep = ps.create({ text: 'tanpa komentar' }); assert.deepStrictEqual(await cl(C, ep.id), { t: 'pg_cml', ok: true, r: { items: [], next: null, count: 0 } });
    ps.comment(B.id, lf.id, mine(B, A.id, lf.id, 'rahasia teman', Date.now()), Date.now());
    assert.deepStrictEqual(await cl(C, lf.id), NULLL, 'Teman untuk asing'); assert.deepStrictEqual(await cl(D, lp.id), NULLL, 'diblokir'); assert.deepStrictEqual(await cl(C, NONE), NULLL, 'tidak ada'); assert(!JSON.stringify(await cl(C, lf.id)).includes('rahasia'), 'tidak bocor');
    assert.strictEqual((await cl(B, lf.id)).r.items[0].text, 'rahasia teman', 'teman melihat'); assert.deepStrictEqual(await ask(C, E, { t: 'pg_cml', id: lp.id }), NULLL, 'folder belum ada'); assert(!fs.existsSync(path.join(tmp, 'E', 'pages')));
    // pemilik menyembunyikan satu komentar: hilang seketika; komentar di Publik terlihat oleh siapa pun yang boleh melihat postingan, termasuk komentar penulis lain
    assert.strictEqual(ps.removeComment(lp.id, own[2][1].id), true); assert.deepStrictEqual((await cl(C, lp.id)).r.items.map((c) => c.text), ['k1', 'k2', 'k4', 'k5', 'k6', 'k7']);
    // jawaban terbesar yang mungkin: 100 komentar berteks 1000 karakter 3-byte (batas per halaman) tetap jauh di bawah 1 MB, jadi tidak perlu pemotong byte; paging melintasi 320 komentar tanpa celah / ulang
    const bp = ps.create({ text: 'besar' }), authors = Array.from({ length: 16 }, ident), long = '字'.repeat(999), tt = Date.now() - 1e5;
    let n = 0; for (const a of authors) for (let i = 0; i < CMT_PER_AUTHOR; i++, n++) { const c = by(a, A.id, bp.id, long + String.fromCharCode(0x4e00 + n), tt + n); ps.comment(c.by, bp.id, c, Date.now()); }
    const bg = (await cl(B, bp.id, { limit: 100 })).r; assert.strictEqual(bg.items.length, 100); assert.strictEqual(bg.count, 320); const sz = Buffer.byteLength(JSON.stringify(bg)); assert(sz > 250e3 && sz < 400e3, 'ukuran terbesar ' + sz);
    const quotes = ps.create({ text: 'kutip' }); for (let i = 0; i < 100; i++) { const c = by(authors[i % 16], A.id, quotes.id, '"'.repeat(999) + String.fromCharCode(0x4e00 + i), tt + i); if (ps.cmt.count(quotes.id) < 100) try { ps.comment(c.by, quotes.id, c, Date.now()); } catch {} }
    assert(Buffer.byteLength(JSON.stringify((await cl(B, quotes.id, { limit: 100 })).r)) < 400e3, 'karakter yang di-escape JSON pun di bawah batas');
    const got = []; let cur = null; for (let i = 0; i < 10; i++) { const g = (await cl(B, bp.id, Object.assign({ limit: 100 }, cur ? { after: cur } : {}))).r; got.push(...g.items); cur = g.next; if (!cur) break; } assert.strictEqual(got.length, 320, 'seluruh 320 komentar terambil lewat paging'); assert.strictEqual(new Set(got.map((c) => c.id)).size, 320); assert.deepStrictEqual(got.map((c) => c.id), ps.commentsFor(A.id, bp.id).map((c) => c.id), 'urutan sama dengan penyimpanan');
    reset();
    ok('pg_cml: tertua dulu, paging dengan kursor, limit dipangkas, kosong beda dari tak terlihat, tak terlihat seragam null, penyembunyian berlaku seketika, jawaban terbesar jauh di bawah 1 MB dan paging menyambung tanpa celah');
  }

  // ---- I. peminta ----
  {
    reset();
    const rp = ps.create({ text: 'peminta' }), rf = ps.create({ text: 'peminta teman', priv: 'friends' });
    const r1 = await B.pageComment(A.id, rp.id, '  halo \n\n\n\n dunia  '); assert.strictEqual(r1.st, 'added'); assert.strictEqual(r1.c.text, 'halo\n\ndunia', 'teks dikanonkan sebelum ditandatangani'); assert.strictEqual(r1.c.by, B.id); assert.strictEqual(r1.c.post, rp.id);
    assert.deepStrictEqual(ps.commentsFor(A.id, rp.id), [r1.c], 'yang tersimpan di pemilik = yang kutandatangani');
    const ts = Date.now(); const sent = []; { const sg = B._pgSign; B._pgSign = (o, obj) => { sent.push(obj); return sg.call(B, o, obj); }; await B.pageComment(A.id, rp.id, 'kirim'); B._pgSign = sg; }
    assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].t, 'pg_cmt'); assert.strictEqual(sent[0].id, rp.id); assert.strictEqual(sent[0].c.text, 'kirim'); assert(Math.abs(sent[0].c.ts - ts) < 5000);
    assert.deepStrictEqual(Object.keys(sent[0]).sort(), ['c', 'id', 't']);
    assert.strictEqual((await C.pageComment(A.id, rp.id, 'asing')).st, 'added'); assert.strictEqual(await C.pageComment(A.id, rf.id, 'asing teman'), null, 'Teman untuk asing = null'); assert.strictEqual(await C.pageComment(A.id, NONE, 'x'), null, 'tidak ada = null');
    assert.strictEqual(await D.pageComment(A.id, rp.id, 'diblokir'), null, 'diblokir pemilik = null biasa, bukan galat'); assert.strictEqual((await B.pageComment(A.id, rf.id, 'teman boleh')).st, 'added');
    // teks / id jelek = bad TANPA jaringan
    { let hit = 0; const rq = B._request; B._request = (...a) => { hit++; return rq.apply(B, a); };
      for (const t of ['', '   ', '\n\n', 'x'.repeat(1001), 5, null, undefined, {}]) assert.strictEqual(await code(B.pageComment(A.id, rp.id, t)), 'bad', 'teks ' + String(t).slice(0, 10));
      for (const [pid, id] of [['zz', rp.id], [A.id, 'zz'], [5, rp.id], [A.id, null]]) assert.strictEqual(await code(B.pageComment(pid, id, 'x')), 'bad'); assert.strictEqual((await B.pageComment(A.id, rp.id, 'x'.repeat(1000))).st, 'added', 'tepat 1000 boleh'); assert.strictEqual(hit, 1, 'hanya yang sah menyentuh jaringan'); B._request = rq; }
    assert.strictEqual(await code(B.pageComment('f'.repeat(16), rp.id, 'x')), 'peer'); B.store.blocked[A.id] = 1; assert.strictEqual(await code(B.pageComment(A.id, rp.id, 'x')), 'blocked'); assert.strictEqual(await code(B.pageComments(A.id, rp.id)), 'blocked'); delete B.store.blocked[A.id];
    // full: dilempar sebagai galat ber-code (beda dari null)
    const fp = ps.create({ text: 'penuh' }); for (let i = 0; i < CMT_PER_AUTHOR; i++) ps.comment(B.id, fp.id, mine(B, A.id, fp.id, 'b' + i, 100 + i)); assert.strictEqual(await code(B.pageComment(A.id, fp.id, 'lagi')), 'full'); assert.strictEqual(await msg(B.pageComment(A.id, fp.id, 'lagi2')), PG_ERR.full, 'pesan galat full dari pgerr'); assert(PG_ERR.full && PG_ERR.full.length > 20); assert.strictEqual((await C.pageComment(A.id, fp.id, 'orang lain')).st, 'added');
    // caps: tanpa 'pgc' = old tanpa menyentuh jaringan; tanpa caps sama sekali tetap dicoba
    { const real = B.peers.get.bind(B.peers); let hit = 0; const rq = B._request; B._request = (...a) => { hit++; return rq.apply(B, a); };
      B.peers.get = (x) => { const p = real(x); return x === A.id && p ? Object.assign({}, p, { caps: ['rx', 'pg', 'pgm', 'pgr'] }) : p; };
      assert.strictEqual(await code(B.pageComment(A.id, rp.id, 'x')), 'old'); assert.strictEqual(await code(B.pageComments(A.id, rp.id)), 'old'); assert.strictEqual(hit, 0, 'tanpa jaringan');
      B.peers.get = (x) => { const p = real(x); return x === A.id && p ? Object.assign({}, p, { caps: undefined }) : p; };
      assert.strictEqual((await B.pageComment(A.id, rp.id, 'tanpa caps tetap dicoba')).st, 'added'); assert(hit >= 1); delete B.peers.get; B._request = rq; }
    // milik sendiri: lokal, tanpa jaringan, tidak membuat folder
    { let hit = 0; const rq = A._request; A._request = (...a) => { hit++; return rq.apply(A, a); };
      const o = await A.pageComment(A.id, rf.id, 'pemilik di postingan Teman sendiri'); assert.strictEqual(o.st, 'added'); assert.strictEqual(o.c.by, A.id); assert(ps.commentsFor(A.id, rf.id).some((x) => x.id === o.c.id));
      assert.strictEqual(await A.pageComment(A.id, NONE, 'x'), null, 'tak ada = null'); assert.strictEqual(await code(A.pageComment(A.id, rp.id, '')), 'bad');
      const ownFull = ps.create({ text: 'penuh pemilik' }); for (let i = 0; i < CMT_PER_AUTHOR; i++) await A.pageComment(A.id, ownFull.id, 'p' + i + Math.random()); assert.strictEqual(await code(A.pageComment(A.id, ownFull.id, 'ke 21')), 'full'); assert.strictEqual(await msg(A.pageComment(A.id, ownFull.id, 'ke 22')), PG_ERR.full, 'pesan sama untuk milik sendiri'); assert.strictEqual(hit, 0, 'tanpa jaringan'); A._request = rq; }
    { const F = mk('F'); await F.start(); assert.strictEqual(await F.pageComment(F.id, rp.id, 'x'), null); assert.strictEqual(await F.pageComments(F.id, rp.id), null); assert(!fs.existsSync(path.join(tmp, 'F', 'pages')), 'komentar lokal tidak membuat folder halaman'); await F.stop(); }
    reset();
    ok("pageComment: teks dikanonkan lalu ditandatangani, yang terkirim = c bertanda tangan, null untuk tak terlihat, 'bad' tanpa jaringan, 'full' dilempar, caps 'pgc' (old tanpa jaringan), milik sendiri lokal tanpa folder");
  }

  // ---- J. peminta membaca; pemilik tidak dipercaya ----
  {
    reset();
    const jp = ps.create({ text: 'baca' }), jf = ps.create({ text: 'baca teman', priv: 'friends' }), t0 = Date.now() - 1e5;
    for (let i = 1; i <= 7; i++) { const c = mine(i % 2 ? B : C, A.id, jp.id, 'j' + i, t0 + i * 10); ps.comment(c.by, jp.id, c, Date.now()); }
    ps.comment(B.id, jf.id, mine(B, A.id, jf.id, 'teman saja', Date.now()), Date.now());
    const all = await C.pageComments(A.id, jp.id); assert.deepStrictEqual(all.items.map((c) => c.text), ['j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7']); assert.strictEqual(all.count, 7); assert.strictEqual(all.skipped, 0); assert.strictEqual(all.next, null); assert.deepStrictEqual(all.items, ps.commentsFor(A.id, jp.id));
    const got = []; let cur = null, pages = 0; do { const g = await C.pageComments(A.id, jp.id, { limit: 3, after: cur || undefined }); got.push(...g.items); cur = g.next; pages++; } while (cur); assert.strictEqual(pages, 3); assert.deepStrictEqual(got, all.items, 'paging menyambung');
    assert.strictEqual(await C.pageComments(A.id, jf.id), null, 'Teman untuk asing = null'); assert.strictEqual(await C.pageComments(A.id, NONE), null); assert.strictEqual(await D.pageComments(A.id, jp.id), null, 'diblokir = null biasa');
    assert.strictEqual((await B.pageComments(A.id, jf.id)).items[0].text, 'teman saja'); assert.deepStrictEqual(await C.pageComments(A.id, ps.create({ text: 'kosong' }).id), { items: [], next: null, count: 0, skipped: 0 });
    { let hit = 0; const rq = C._request; C._request = (...a) => { hit++; return rq.apply(C, a); }; for (const o of [{ after: 'abc' }, { after: 5 }, { after: '1:zz' }]) assert.strictEqual(await code(C.pageComments(A.id, jp.id, o)), 'bad'); assert.strictEqual(hit, 0, 'kursor jelek ditolak tanpa jaringan'); C._request = rq; }
    for (const o of [{ after: 'abc' }, { after: 5 }]) assert.strictEqual(await code(A.pageComments(A.id, jp.id, o)), 'bad', 'juga untuk milik sendiri'); for (const [pid, id] of [['zz', jp.id], [A.id, 'zz']]) assert.strictEqual(await code(C.pageComments(pid, id)), 'bad');
    { const sent = [], sg = C._pgSign; C._pgSign = (o, obj) => { sent.push(obj); return sg.call(C, o, obj); }; await C.pageComments(A.id, jp.id, { limit: 5000 }); await C.pageComments(A.id, jp.id); await C.pageComments(A.id, jp.id, { limit: 0, after: all.items[0].ts + ':' + all.items[0].id }); C._pgSign = sg;
      assert.deepStrictEqual(sent.map((s) => [s.limit, s.after]), [[CMT_PAGE_MAX, undefined], [50, undefined], [1, all.items[0].ts + ':' + all.items[0].id]], 'limit dipangkas sebelum dikirim'); assert(sent.every((s) => s.t === 'pg_cml' && s.id === jp.id)); }
    // lokal
    { const l = await A.pageComments(A.id, jf.id, { limit: 5 }); assert.strictEqual(l.items.length, 1); assert.strictEqual(l.skipped, 0); assert.strictEqual(await A.pageComments(A.id, NONE), null); const l2 = await A.pageComments(A.id, jp.id, { limit: 3 }); assert.strictEqual(l2.items.length, 3); assert(l2.next); assert.strictEqual((await A.pageComments(A.id, jp.id, { after: l2.next })).items.length, 4); }
    // pemilik nakal: jawaban dibuat sendiri lewat _pgHandle
    const real = A._pgHandle.bind(A), reply = (v) => { A._pgHandle = (o, rid) => (o.t === 'pg_cml' || o.t === 'pg_cmt' ? v : real(o, rid)); }, back = () => { A._pgHandle = real; };
    const Xi = ident(), good = ps.commentsFor(A.id, jp.id); const asW = (r) => ({ t: 'pg_cmt', ok: true, r }), asL = (r) => ({ t: 'pg_cml', ok: true, r });
    { // komentar sah milik X yang ditandatangani untuk halaman + postingan ini LOLOS (pemilik boleh meneruskan komentar asli; pemalsuan atas nama orang tidak mungkin)
      const sx = by(Xi, A.id, jp.id, 'asli dari X', t0 + 15), forged = Object.assign({}, good[1], { text: 'dipalsukan pemilik' });
      reply(asL({ items: [good[0], forged, sx], next: null, count: 3 })); const r = await C.pageComments(A.id, jp.id); assert.deepStrictEqual(r.items.map((c) => c.text), ['j1', 'asli dari X'], 'yang dipalsukan dibuang, yang sah lolos'); assert.strictEqual(r.skipped, 1);
      reply(asL({ items: [by(Xi, hex(9), jp.id, 'halaman lain', 1), by(Xi, A.id, hex(9), 'postingan lain', 2)], next: null, count: 2 })); const r2 = await C.pageComments(A.id, jp.id); assert.deepStrictEqual([r2.items.length, r2.skipped], [0, 2], 'diputar ulang dari halaman / postingan lain = dibuang'); }
    for (const [n, v] of Object.entries({ 'urutan terbalik': asL({ items: [good[1], good[0]], next: null, count: 2 }), 'ganda': asL({ items: [good[0], good[0]], next: null, count: 2 }), 'count kurang': asL({ items: good.slice(0, 3), next: null, count: 2 }), 'count melewati batas': asL({ items: [], next: null, count: 501 }),
      'terlalu banyak (limit 3)': asL({ items: good.slice(0, 4), next: null, count: 7 }), 'next jelek': asL({ items: good.slice(0, 2), next: 'x', count: 7 }), 'next tanpa item': asL({ items: [], next: good[0].ts + ':' + good[0].id, count: 7 }), 'bukan objek': asL('x'), 'tanpa items': asL({ next: null, count: 0 }),
      'next mundur': asL({ items: good.slice(0, 3), next: good[0].ts + ':' + good[0].id, count: 7 }) })) {
      reply(v); assert.strictEqual(await code(C.pageComments(A.id, jp.id, { limit: 3 })), 'proto', 'proto: ' + n); }
    reply(asL(null)); assert.strictEqual(await C.pageComments(A.id, jp.id), null, 'null = tak terlihat');
    for (const e of ['busy', 'auth', 'time', 'bad']) { reply({ t: 'pg_cml', ok: false, err: e }); assert.strictEqual(await code(C.pageComments(A.id, jp.id)), e, 'diteruskan: ' + e); } reply({ t: 'pg_cml', ok: false, err: 'aneh' }); assert.strictEqual(await code(C.pageComments(A.id, jp.id)), 'proto'); reply({ t: 'pg_get', ok: true }); assert.strictEqual(await code(C.pageComments(A.id, jp.id)), 'proto', 'jenis jawaban salah');
    // pageComment: status dari pemilik
    reply(asW('added')); assert.strictEqual((await C.pageComment(A.id, jp.id, 'aku')).st, 'added'); reply(asW('same')); assert.strictEqual((await C.pageComment(A.id, jp.id, 'aku')).st, 'same'); reply(asW(null)); assert.strictEqual(await C.pageComment(A.id, jp.id, 'aku'), null); reply(asW('full')); assert.strictEqual(await code(C.pageComment(A.id, jp.id, 'aku')), 'full');
    for (const v of ['ok', '', 5, true, {}, undefined]) { reply(asW(v)); assert.strictEqual(await code(C.pageComment(A.id, jp.id, 'aku')), 'proto', 'status aneh ' + String(v)); }
    for (const e of ['busy', 'auth', 'time', 'bad']) { reply({ t: 'pg_cmt', ok: false, err: e }); assert.strictEqual(await code(C.pageComment(A.id, jp.id, 'aku')), e); } back();
    // pemilik offline
    { const Z = mk('Z'); await Z.start(); await Z.addPeer('127.0.0.1', A.port); await until(() => Z.peers.has(A.id), 8000, 'Z kenal A'); await A.stop(); Z.peers.get(A.id).lastSeen = 0; assert.strictEqual(await code(Z.pageComment(A.id, jp.id, 'x')), 'offline'); assert.strictEqual(await code(Z.pageComments(A.id, jp.id)), 'offline'); await Z.stop(); }
    ok("pageComments: paging, null untuk tak terlihat, limit dipangkas sebelum dikirim, tiap komentar diperiksa tanda tangannya (palsu / halaman lain / postingan lain dibuang), jawaban cacat 'proto', galat diteruskan, pageComment menolak status aneh, offline");
  }

  for (const n of [B, C, D, E]) await n.stop();
  console.log('\n' + pass + ' kelompok lulus');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

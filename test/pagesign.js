'use strict';
// Tes Halaman 1c-3b: tanda tangan permintaan. Murni (pgSignReq / pgVerifyReq) + jaringan sungguhan (soket lokal) untuk pemalsuan, putar ulang, jam, dan peminta yang sah.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), crypto = require('crypto');
const { Core } = require('../src/archne-core');
const { pgSignReq, pgVerifyReq, PG_SKEW } = require('../src/archne-pagestore');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagesign-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); } throw new Error('timeout: ' + label); }
let pass = 0;
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const strip = (r) => { if (r) delete r.hi; return r; };
const code = async (p) => { try { await p; } catch (e) { return e.code; } return 'tidak melempar'; };

(async () => {
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D'); // A pemilik, B teman, C orang asing (juga pemalsu), D diblokir
  for (const n of [A, B, C, D]) await n.start();
  for (const n of [B, C, D]) await n.addPeer('127.0.0.1', A.port);
  await until(() => [B, C, D].every((n) => n.peers.has(A.id) && A.peers.has(n.id)), 8000, 'saling kenal');
  const ps = A.pageStore();
  const pub = ps.create({ text: 'publik' }), frd = ps.create({ text: 'RAHASIA teman', priv: 'friends' });
  A.store.friends[B.id] = { st: 'ok' }; A.store.blocked[D.id] = 1;
  const raw = async (from, to, obj, hi) => strip(await from._request(from.peers.get(to.id), hi ? Object.assign({}, obj, { hi }) : obj, 4000));
  // _request menimpa hi dengan hello sendiri, jadi untuk meniru hello teman kita kirim lewat soket langsung
  const net = require('net');
  const sendRaw = (to, o) => new Promise((res) => {
    const s = net.connect(to.port, '127.0.0.1'); let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.destroy(); try { res(strip(JSON.parse(buf))); } catch { res(null); } } });
    s.on('error', () => res(null)); s.on('connect', () => s.write(JSON.stringify(o) + '\n'));
    setTimeout(() => { s.destroy(); res(null); }, 4000);
  });

  // 1. murni: tanda tangan sah lolos; setiap bidang yang diubah membatalkannya
  {
    const owner = A.id, now = 1e12, hi = B.hello();
    const req = Object.assign({ hi }, pgSignReq(B.privKey, owner, { t: 'pg_list', after: '5:' + 'a'.repeat(16), limit: 7 }, now, 'ab'.repeat(8)));
    const v = pgVerifyReq(req, owner, now);
    assert.deepStrictEqual(v, { ok: true, rid: B.id, key: B.id + ':' + 'ab'.repeat(8) });
    const tamper = (f) => { const r = JSON.parse(JSON.stringify(req)); f(r); return pgVerifyReq(r, owner, now); };
    for (const [name, f] of [['t', (r) => { r.t = 'pg_get'; }], ['after', (r) => { r.after = '6:' + 'a'.repeat(16); }], ['limit', (r) => { r.limit = 8; }], ['id', (r) => { r.id = 'c'.repeat(16); }], ['ts', (r) => { r.ts++; }], ['n', (r) => { r.n = 'cd'.repeat(8); }], ['sig', (r) => { r.sig = r.sig.slice(0, -4) + 'AAAA'; }]]) {
      assert.strictEqual(tamper(f).ok, false, 'bidang ' + name + ' diubah harus gagal');
    }
    assert.strictEqual(pgVerifyReq(req, C.id, now).ok, false, 'permintaan untuk A tidak berlaku untuk C (id pemilik ikut ditandatangani)');
    ok('tanda tangan murni: sah lolos; mengubah t / after / limit / id / ts / nonce / sig / pemilik membatalkannya');
  }

  // 2. murni: kunci harus cocok dengan id; jam; bentuk
  {
    const now = 1e12, base = pgSignReq(B.privKey, A.id, { t: 'pg_list' }, now, '11'.repeat(8));
    // memakai id teman tetapi kunci sendiri
    const forged = Object.assign({ hi: Object.assign({}, B.hello(), { pub: C.pub }) }, pgSignReq(C.privKey, A.id, { t: 'pg_list' }, now, '22'.repeat(8)));
    assert.deepStrictEqual(pgVerifyReq(forged, A.id, now), { ok: false, err: 'auth' }, 'id teman + kunci penyerang ditolak');
    assert.deepStrictEqual(pgVerifyReq(Object.assign({ hi: B.hello() }, base), A.id, now + PG_SKEW + 1), { ok: false, err: 'time' });
    assert.deepStrictEqual(pgVerifyReq(Object.assign({ hi: B.hello() }, base), A.id, now - PG_SKEW - 1), { ok: false, err: 'time' });
    assert.strictEqual(pgVerifyReq(Object.assign({ hi: B.hello() }, base), A.id, now + PG_SKEW).ok, true, 'tepat di batas masih sah');
    for (const bad of [null, {}, { hi: B.hello() }, { hi: B.hello(), sig: 5, n: 'x', ts: now }, Object.assign({ hi: { id: B.id } }, base), Object.assign({ hi: B.hello() }, base, { n: 'zz' }), Object.assign({ hi: B.hello() }, base, { ts: 1.5 })]) {
      assert.deepStrictEqual(pgVerifyReq(bad, A.id, now), { ok: false, err: 'auth' }, JSON.stringify(bad).slice(0, 60));
    }
    ok('kunci harus cocok dengan id; jam +-PG_SKEW; bentuk cacat = auth tanpa melempar');
  }

  // 3. jaringan: peminta sah (teman) dapat isi Teman; asing hanya Publik
  {
    const rb = await B.pageList(A.id), rc = await C.pageList(A.id);
    assert.deepStrictEqual(rb.items.map((p) => p.id), [frd.id, pub.id]);
    assert.deepStrictEqual(rc.items.map((p) => p.id), [pub.id]);
    assert.strictEqual((await B.pagePost(A.id, frd.id)).text, 'RAHASIA teman');
    assert.strictEqual(await C.pagePost(A.id, frd.id), null);
    ok('peminta sah: teman melihat Teman, asing hanya Publik, lewat pageList / pagePost');
  }

  // 4. jaringan: PEMALSUAN. C menyalin hello B (publik di LAN) dan mengaku B, tetapi tanpa kunci B
  {
    const hiB = B.hello();
    const unsigned = await sendRaw(A, { hi: hiB, t: 'pg_list' });
    assert.deepStrictEqual(unsigned, { t: 'pg_list', ok: false, err: 'auth' }, 'hello teman tanpa tanda tangan ditolak');
    const forged = await sendRaw(A, Object.assign({ hi: hiB }, pgSignReq(C.privKey, A.id, { t: 'pg_list' })));
    assert.deepStrictEqual(forged, { t: 'pg_list', ok: false, err: 'auth' }, 'hello teman + tanda tangan kunci C ditolak');
    const forgedGet = await sendRaw(A, Object.assign({ hi: hiB }, pgSignReq(C.privKey, A.id, { t: 'pg_get', id: frd.id })));
    assert.deepStrictEqual(forgedGet, { t: 'pg_get', ok: false, err: 'auth' });
    assert(![unsigned, forged, forgedGet].some((r) => JSON.stringify(r).includes('RAHASIA')), 'tidak ada bocoran');
    // pemalsu juga tidak bisa lolos dengan tanda tangan sah miliknya sendiri tetapi hi teman: sudah diuji di atas; dengan hi sendiri hanya jadi asing
    const own = await sendRaw(A, Object.assign({ hi: C.hello() }, pgSignReq(C.privKey, A.id, { t: 'pg_list' })));
    assert.deepStrictEqual(own.items.map((p) => p.id), [pub.id]);
    ok('pemalsuan: hello teman tanpa / dengan tanda tangan salah ditolak seragam; tanda tangan milik sendiri = asing biasa');
  }

  // 5. jaringan: putar ulang ditolak; permintaan baru tetap jalan; jam jauh = 'time'
  {
    const hi = B.hello(), req = Object.assign({ hi }, pgSignReq(B.privKey, A.id, { t: 'pg_list' }));
    const r1 = await sendRaw(A, req), r2 = await sendRaw(A, req);
    assert.strictEqual(r1.ok, true); assert.strictEqual(r1.items.length, 2);
    assert.deepStrictEqual(r2, { t: 'pg_list', ok: false, err: 'auth' }, 'persis sama dikirim lagi = putar ulang');
    const stale = await sendRaw(A, Object.assign({ hi }, pgSignReq(B.privKey, A.id, { t: 'pg_list' }, Date.now() - 10 * 60e3)));
    assert.deepStrictEqual(stale, { t: 'pg_list', ok: false, err: 'time' });
    // putar ulang ke pemilik lain gagal karena id pemilik ikut ditandatangani
    const toC = await sendRaw(C, req); assert.strictEqual(toC.ok, false);
    ok('putar ulang ditolak; jam jauh = time; permintaan untuk A tidak berlaku di C');
  }

  // 6. cache nonce: kedaluwarsa digugurkan, penuh = busy, dan peminta jujur dapat error ber-kode
  {
    A._pgSeen = new Map([['x:1', Date.now() - 1]]);
    await B.pageList(A.id); assert(!A._pgSeen.has('x:1'), 'entri kedaluwarsa digugurkan'); assert.strictEqual(A._pgSeen.size, 1);
    const big = new Map(); const exp = Date.now() + 1e6; for (let i = 0; i < 20000; i++) big.set('k' + i, exp); A._pgSeen = big;
    assert.strictEqual(await code(B.pageList(A.id)), 'busy', 'cache penuh = busy, bukan membuang entri lama');
    A._pgSeen = null;
    assert.strictEqual((await B.pageList(A.id)).items.length, 2, 'pulih setelah cache bersih');
    // peminta lama (tanpa tanda tangan) mendapat auth; jam peminta bergeser = 'time'
    const orig = B._pgSign; B._pgSign = (owner, obj) => pgSignReq(B.privKey, String(owner), obj, Date.now() + 10 * 60e3); // jam peminta maju 10 menit
    const c = await code(B.pageList(A.id)); B._pgSign = orig;
    assert.strictEqual(c, 'time', 'jam peminta maju 10 menit');
    B._pgSign = (owner, obj) => obj; // peminta versi 1c-3 (tidak menandatangani)
    const c2 = await code(B.pageList(A.id)); B._pgSign = orig;
    assert.strictEqual(c2, 'auth', 'peminta tanpa tanda tangan');
    ok('cache nonce: gugur saat kedaluwarsa, penuh = busy, pulih; selisih jam dilaporkan sebagai time');
  }

  // 7. relasi memakai identitas TERBUKTI: diblokir tetap kosong; blokir mengalahkan teman; hasilnya sama dengan sebelumnya
  {
    const EMPTY = { t: 'pg_list', ok: true, items: [], next: null, count: 0 };
    const rd = await D.pageList(A.id); assert.deepStrictEqual({ items: rd.items, count: rd.count }, { items: [], count: 0 });
    A.store.blocked[B.id] = 1; assert.strictEqual((await B.pageList(A.id)).count, 0); delete A.store.blocked[B.id];
    assert.strictEqual((await B.pageList(A.id)).count, 2);
    // pemalsu mengaku D (diblokir) tanpa tanda tangan: auth, bukan kosong, jadi tidak ada beda perlakuan yang bisa ditebak dari relasi
    const forgedD = await sendRaw(A, { hi: D.hello(), t: 'pg_list' });
    const forgedB = await sendRaw(A, { hi: B.hello(), t: 'pg_list' });
    assert.deepStrictEqual(forgedD, forgedB, 'ditolak sama persis, terlepas dari relasi');
    assert.notDeepStrictEqual(forgedD, EMPTY);
    ok('blokir / teman memakai identitas terbukti; penolakan auth identik untuk semua klaim palsu');
  }

  // 8. (4a-3) pg_rx: emoji ikut ditandatangani (id sudah di bidang ke-4), jadi emoji / id / jenis tidak bisa diganti di jalan; pg_get dan pg_rx dengan id sama tidak bertukar tanda tangan
  {
    const owner = A.id, now = 1e12, hi = B.hello(), id = 'a'.repeat(16);
    const req = Object.assign({ hi }, pgSignReq(B.privKey, owner, { t: 'pg_rx', id, e: '\u{1F44D}' }, now, 'ab'.repeat(8)));
    assert.strictEqual(pgVerifyReq(req, owner, now).ok, true);
    const tamper = (f) => { const r = JSON.parse(JSON.stringify(req)); f(r); return pgVerifyReq(r, owner, now).ok; };
    assert.strictEqual(tamper((r) => { r.e = '\u{1F62D}'; }), false, 'emoji diganti');
    assert.strictEqual(tamper((r) => { r.e = ''; }), false, 'reaksi dicabut di jalan');
    assert.strictEqual(tamper((r) => { delete r.e; }), false, 'emoji dibuang');
    assert.strictEqual(tamper((r) => { r.id = 'b'.repeat(16); }), false, 'id diganti');
    assert.strictEqual(tamper((r) => { r.t = 'pg_get'; }), false, 'jenis ditukar ke pg_get');
    const cab = Object.assign({ hi }, pgSignReq(B.privKey, owner, { t: 'pg_rx', id, e: '' }, now, 'cd'.repeat(8)));
    assert.strictEqual(pgVerifyReq(cab, owner, now).ok, true); assert.notStrictEqual(cab.sig, req.sig);
    const old = Object.assign({ hi }, pgSignReq(B.privKey, owner, { t: 'pg_get', id }, now, 'ef'.repeat(8)));
    assert.strictEqual(pgVerifyReq(Object.assign({}, old, { t: 'pg_rx', e: '\u{1F44D}' }), owner, now).ok, false, 'tanda tangan pg_get tidak bisa dijadikan pg_rx');
    ok('pg_rx: tanda tangan menutup emoji, id, dan jenis; cabut (e kosong) bertanda tangan sendiri; pg_get tak bisa dijadikan pg_rx');
  }

  console.log('\n' + pass + ' kelompok lulus');
  for (const n of [A, B, C, D]) await n.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
// Tes Halaman 1c-3: sisi PEMINTA (pageAvail / pageList / pagePost) + validator jawaban peer (wirePost / wireList). Jaringan sungguhan (soket lokal) untuk alur normal; pemilik palsu untuk jawaban cacat.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { wirePost, wireList } = require('../src/archne-pagestore');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagefetch-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); } throw new Error('timeout: ' + label); }
let pass = 0;
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const code = async (p) => { try { await p; } catch (e) { return e.code; } return 'tidak melempar'; };
const P = (n, ts, extra) => Object.assign({ v: 1, id: n.toString(16).padStart(16, '0'), ts, kind: 'text', text: 't' + n, priv: 'public' }, extra);

(async () => {
  // ---- A. validator murni ----
  {
    const p = P(1, 100);
    assert.deepStrictEqual(wirePost(Object.assign({ evil: 1, __proto__: { x: 1 } }, p)), p, 'bidang asing dibuang');
    for (const bad of [null, 5, 'x', {}, P(1, 100, { v: 2 }), P(1, 100, { kind: 'image' }), P(1, 100, { id: 'zz' }), P(1, 100, { text: '' }), P(1, 100, { text: 5 }), P(1, 0), P(1, 1.5), P(1, 100, { priv: 'secret' }),
      P(1, 100, { trunc: 2 }), P(1, 100, { trunc: 'x' }), P(1, 100, { text: 'x'.repeat(1500001) })]) assert.strictEqual(wirePost(bad), null, JSON.stringify(bad).slice(0, 80));
    assert.strictEqual(wirePost(P(1, 100, { trunc: 99 })).trunc, 99);
    assert.strictEqual(wirePost(P(1, 100, { text: 'x'.repeat(1500000), trunc: 1700000 })).trunc, 1700000);
    ok('wirePost: bidang asing dibuang, bentuk cacat / jenis tak dikenal / trunc salah ditolak');
  }
  {
    const a = P(3, 300), b = P(2, 200), c = P(1, 100);
    const good = wireList({ items: [a, b, c], next: null, count: 9 }, { limit: 10 });
    assert.deepStrictEqual(good.items.map((x) => x.id), [a.id, b.id, c.id]); assert.strictEqual(good.count, 9); assert.strictEqual(good.skipped, 0);
    // jenis baru / cacat dilewati, tidak menggagalkan halaman
    const mixed = wireList({ items: [a, P(9, 250, { kind: 'image' }), b], next: null, count: 3 }, { limit: 10 });
    assert.deepStrictEqual(mixed.items.map((x) => x.id), [a.id, b.id]); assert.strictEqual(mixed.skipped, 1);
    const cur = (p) => p.ts + ':' + p.id;
    // kursor maju: next wajar
    assert.strictEqual(wireList({ items: [a], next: cur(a), count: 3 }, { limit: 1 }).next, cur(a));
    // seri ts: urut id naik
    const t1 = P(5, 500), t2 = P(6, 500);
    assert.strictEqual(wireList({ items: [t1, t2], next: null, count: 2 }, {}).items.length, 2);
    // semua yang cacat -> null
    const bads = {
      'bukan objek': null, 'items bukan array': { items: 'x', count: 0 }, 'count negatif': { items: [], count: -1 }, 'count pecahan': { items: [], count: 1.5 },
      'lebih dari limit': { items: [a, b], count: 2, limit: 1 }, 'urutan terbalik': { items: [c, a], count: 2 }, 'duplikat': { items: [a, a], count: 2 },
      'next bukan kursor': { items: [a], next: 'x', count: 1 }, 'next bukan string': { items: [a], next: 5, count: 1 }, 'next mundur dari item terakhir': { items: [a, b], next: cur(a), count: 3 },
    };
    for (const [k, r] of Object.entries(bads)) assert.strictEqual(wireList(r, { limit: (r && r.limit) || 10 }), null, k);
    // item harus setelah kursor yang kuminta; next harus maju dari kursor
    assert.strictEqual(wireList({ items: [a], next: null, count: 1 }, { after: cur(b), limit: 10 }), null, 'item sebelum kursor');
    assert.strictEqual(wireList({ items: [], next: cur(b), count: 1 }, { after: cur(b), limit: 10 }), null, 'next tidak maju (putaran tak berujung)');
    assert.strictEqual(wireList({ items: [], next: cur(a), count: 1 }, { after: cur(b), limit: 10 }), null, 'next mundur');
    assert.notStrictEqual(wireList({ items: [c], next: null, count: 1 }, { after: cur(b), limit: 10 }), null, 'item sesudah kursor sah');
    assert.notStrictEqual(wireList({ items: [], next: cur(c), count: 1 }, { after: cur(b), limit: 10 }), null, 'next maju tanpa item (berkas rusak dilewati) sah');
    ok('wireList: urutan, duplikat, limit, count, dan kursor maju diperiksa; item tak dikenal dilewati');
  }

  // ---- B. lewat jaringan ----
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D'), E = mk('E'); // A pemilik, B teman A, C asing, D diblokir A, E tidak punya halaman
  const all = [A, B, C, D, E];
  for (const n of all) await n.start();
  for (const n of [B, C, D, E]) await n.addPeer('127.0.0.1', A.port);
  await until(() => [B, C, D, E].every((n) => n.peers.has(A.id) && A.peers.has(n.id)), 8000, 'peer saling kenal');
  const ps = A.pageStore();
  const posts = [];
  for (let i = 0; i < 7; i++) posts.push(ps.create({ text: 'post ' + i, priv: i % 3 === 1 ? 'friends' : 'public' }));
  A.store.friends[B.id] = { st: 'ok' }; A.store.blocked[D.id] = 1;
  const vis = (list) => list.slice().reverse(); // terbaru dulu
  const pubIds = vis(posts).filter((p) => p.priv === 'public').map((p) => p.id), allIds = vis(posts).map((p) => p.id);

  // 1. pageAvail
  {
    assert.deepStrictEqual(B.pageAvail(A.id), { ok: true });
    assert.deepStrictEqual(B.pageAvail(B.id), { ok: false, why: 'self' });
    assert.deepStrictEqual(B.pageAvail('f'.repeat(16)), { ok: false, why: 'peer' });
    assert.deepStrictEqual(B.pageAvail('../x'), { ok: false, why: 'peer' });
    ok('pageAvail: ok untuk pemilik online yang mendukung; self / peer tak dikenal ditolak');
  }

  // 2. pageList: asing = Publik, teman = semua; paging sampai habis lewat kursor; isi sama dengan milik pemilik
  {
    const walk = async (who, limit) => { const ids = []; let after, count; for (let i = 0; i < 20; i++) { const r = await who.pageList(A.id, { after, limit }); ids.push(...r.items.map((p) => p.id)); count = r.count; if (!r.next) break; after = r.next; } return { ids, count }; };
    const c = await walk(C, 2), b = await walk(B, 3);
    assert.deepStrictEqual(c.ids, pubIds); assert.strictEqual(c.count, pubIds.length);
    assert.deepStrictEqual(b.ids, allIds); assert.strictEqual(b.count, allIds.length);
    const r = await B.pageList(A.id); assert.strictEqual(r.items.length, 7); assert.deepStrictEqual(r.items[0], posts[6], 'isi postingan utuh apa adanya');
    assert.strictEqual((await B.pageList(A.id, { limit: 999 })).items.length, 7);
    assert.strictEqual((await B.pageList(A.id, { limit: 'x' })).items.length, 7, 'limit aneh = bawaan');
    ok('pageList: asing = Publik, teman = semua; kursor menyusuri semua tanpa celah/ganda; count ikut disaring');
  }

  // 3. pagePost
  {
    const frd = posts.find((p) => p.priv === 'friends'), pub = posts.find((p) => p.priv === 'public');
    assert.deepStrictEqual(await C.pagePost(A.id, pub.id), pub);
    assert.strictEqual(await C.pagePost(A.id, frd.id), null, 'Teman tak terlihat orang asing');
    assert.strictEqual(await C.pagePost(A.id, 'f'.repeat(16)), null, 'tidak ada');
    assert.deepStrictEqual(await B.pagePost(A.id, frd.id), frd);
    ok('pagePost: Publik terbuka, Teman hanya teman, "bukan untukmu" = "tidak ada" = null');
  }

  // 4. diblokir pemilik: tak bisa dibedakan dari pemilik tanpa halaman
  {
    const d = await D.pageList(A.id), e = await C.pageList(A.id);
    assert.deepStrictEqual(d, { items: [], next: null, count: 0, skipped: 0 });
    assert.strictEqual(await D.pagePost(A.id, posts[0].id), null);
    await C.addPeer('127.0.0.1', E.port); await until(() => C.peers.has(E.id), 8000, 'C-E');
    assert.deepStrictEqual(await C.pageList(E.id), d, 'sama persis dengan pemilik yang belum punya halaman');
    assert(e.items.length);
    ok('diblokir pemilik: hasil kosong identik dengan "pemilik tanpa halaman"');
  }

  // 5. kesalahan di sisi peminta, tanpa menyentuh jaringan
  {
    let dialed = 0; const orig = B._request; B._request = function () { dialed++; return orig.apply(this, arguments); };
    assert.strictEqual(await code(B.pageList(B.id)), 'self');
    assert.strictEqual(await code(B.pageList('f'.repeat(16))), 'peer');
    assert.strictEqual(await code(B.pageList(A.id, { after: 'xx' })), 'bad');
    assert.strictEqual(await code(B.pageList(A.id, { after: 5 })), 'bad');
    assert.strictEqual(await code(B.pagePost(A.id, '../../x')), 'bad');
    assert.strictEqual(await code(B.pagePost(A.id, 5)), 'bad');
    // aku memblokir pemilik
    B.store.blocked[A.id] = 1;
    assert.strictEqual(await code(B.pageList(A.id)), 'blocked'); assert.strictEqual(B.pageAvail(A.id).why, 'blocked');
    delete B.store.blocked[A.id];
    // pemilik offline (tidak terdengar kabarnya lagi): gagal seketika
    const pa = B.peers.get(A.id), seen = pa.lastSeen; pa.lastSeen = 0;
    assert.deepStrictEqual(B.pageAvail(A.id), { ok: false, why: 'offline' });
    assert.strictEqual(await code(B.pageList(A.id)), 'offline'); assert.strictEqual(await code(B.pagePost(A.id, posts[0].id)), 'offline');
    pa.lastSeen = seen;
    // versi lama: hello dikenal tanpa caps 'pg'
    const caps = pa.caps; pa.caps = ['rx'];
    assert.deepStrictEqual(B.pageAvail(A.id), { ok: false, why: 'old' }); assert.strictEqual(await code(B.pageList(A.id)), 'old');
    pa.caps = undefined; assert.deepStrictEqual(B.pageAvail(A.id), { ok: true }, 'caps belum dikenal: boleh mencoba');
    pa.caps = caps;
    assert.strictEqual(dialed, 0, 'tidak satu pun dari ini menyentuh jaringan');
    B._request = orig;
    ok('self / peer / bad / blocked / offline / old gagal seketika, tanpa koneksi; caps tak dikenal boleh dicoba');
  }

  // 6. pemilik hilang di tengah gulir: 'offline', lalu lanjut dengan kursor yang sama
  {
    const r1 = await B.pageList(A.id, { limit: 3 }); assert(r1.next);
    const orig = B._request; B._request = async () => null; // koneksi putus / tak dijawab
    assert.strictEqual(await code(B.pageList(A.id, { after: r1.next, limit: 3 })), 'offline');
    B._request = orig;
    const r2 = await B.pageList(A.id, { after: r1.next, limit: 3 });
    assert.deepStrictEqual(r1.items.concat(r2.items).map((p) => p.id), allIds.slice(0, 6));
    // pemilik betul-betul mati (soket ditutup) tetapi masih tampak online: error koneksi = 'offline'
    const X = mk('X'); await X.start(); await X.addPeer('127.0.0.1', B.port); await until(() => B.peers.has(X.id), 8000, 'B-X');
    await X.stop();
    assert(B.isOnline(B.peers.get(X.id)), 'masih tampak online');
    assert.strictEqual(await code(B.pageList(X.id)), 'offline');
    ok('pemilik hilang di tengah gulir: offline, lalu kursor yang sama dilanjutkan; soket mati = offline');
  }

  // 7. pemilik nakal / cacat: semua jadi 'proto' (atau diabaikan), tidak ada yang lolos
  {
    const reply = (v) => { A._pgHandle = () => v; };
    const good = { t: 'pg_list', ok: true, items: [], next: null, count: 0 };
    const cases = [
      [{ t: 'pg_get', ok: true, post: null }, 'proto', 'tipe balasan salah'],
      [{ t: 'pg_list', ok: false, err: 'meledak' }, 'proto', 'ok:false dengan kode tak dikenal'],
      [{ t: 'pg_list', ok: false, err: 'auth' }, 'auth', 'ok:false auth diteruskan'], [{ t: 'pg_list', ok: false, err: 'time' }, 'time', 'ok:false time diteruskan'], [{ t: 'pg_list', ok: false, err: 'busy' }, 'busy', 'ok:false busy diteruskan'],
      [{ t: 'pg_list', ok: false, err: 'bad' }, 'bad', 'bad'],
      [{ t: 'pg_list' }, 'proto', 'tanpa ok'],
      [Object.assign({}, good, { items: 'x' }), 'proto', 'items bukan array'],
      [Object.assign({}, good, { count: -5 }), 'proto', 'count salah'],
      [Object.assign({}, good, { items: [P(1, 100), P(2, 200)], count: 2 }), 'proto', 'urutan terbalik'],
      [Object.assign({}, good, { next: '999:' + 'a'.repeat(16), count: 1 }), 'proto', 'tidak ada kemajuan'],
    ];
    for (const [v, want, label] of cases) {
      reply(v);
      if (label === 'tidak ada kemajuan') {
        // next sama dengan kursor yang kuminta: tidak maju
        assert.strictEqual(await code(B.pageList(A.id, { after: '999:' + 'a'.repeat(16) })), want, label);
      } else assert.strictEqual(await code(B.pageList(A.id)), want, label);
    }
    reply({ t: 'pg_list', ok: true, items: [P(3, 300, { evil: 'x', kind: 'text' })], next: null, count: 1 });
    assert.deepStrictEqual((await B.pageList(A.id)).items[0], P(3, 300), 'bidang asing dibuang');
    reply({ t: 'pg_get', ok: true, post: P(4, 400) });
    assert.strictEqual(await code(B.pagePost(A.id, P(5, 1).id)), 'proto', 'postingan lain dari yang diminta');
    reply({ t: 'pg_get', ok: true, post: { v: 1, id: P(5, 1).id, ts: 1, kind: 'text', text: '', priv: 'public' } });
    assert.strictEqual(await code(B.pagePost(A.id, P(5, 1).id)), 'proto', 'postingan cacat');
    reply({ t: 'pg_get', ok: true, post: P(5, 500, { text: 'z'.repeat(40), trunc: 99 }) });
    assert.strictEqual((await B.pagePost(A.id, P(5, 1).id)).trunc, 99, 'trunc sah diteruskan');
    delete A._pgHandle;
    ok('pemilik cacat/nakal: jenis salah, count, urutan, kursor mundur, id tertukar, postingan kosong semuanya ditolak');
  }

  // 8. teks panjang lewat peminta: pratinjau + trunc di daftar, utuh di pagePost, terpotong pada batas
  {
    const long = ps.create({ text: 'q'.repeat(50000) }), huge = ps.create({ text: 'h'.repeat(1700000) });
    const l = await C.pageList(A.id, { limit: 2 });
    assert.deepStrictEqual(l.items.map((p) => p.id), [huge.id, long.id]);
    assert(l.items.every((p) => p.text.length === 20000 && p.trunc > 20000));
    assert.strictEqual((await C.pagePost(A.id, long.id)).text.length, 50000);
    const h = await C.pagePost(A.id, huge.id); assert.strictEqual(h.text.length, 1500000); assert.strictEqual(h.trunc, 1700000);
    ok('teks panjang: pratinjau + trunc di daftar, utuh di pagePost, terpotong di batas dengan trunc');
  }

  // 9. (4a-4) pageReact: peminta -> pg_rx bertanda tangan; milik sendiri lokal tanpa jaringan; caps 'pgr'; jawaban pemilik tidak dipercaya
  {
    const pp = ps.create({ text: 'target reaksi' }), pf = ps.create({ text: 'target teman', priv: 'friends' }), NONE = 'e'.repeat(16);
    const sums = (r) => r.rx.reduce((a, x) => a + x.n, 0);
    // a. alur normal; emoji dikanonkan sebelum dikirim; hasil = keadaan sesudahnya
    assert.deepStrictEqual(await B.pageReact(A.id, pp.id, '👍'), { rx: [{ e: '👍', n: 1 }], mine: '👍' });
    assert.deepStrictEqual(await B.pageReact(A.id, pp.id, '👍'), { rx: [{ e: '👍', n: 1 }], mine: '👍' }, 'idempotent');
    assert.deepStrictEqual(await C.pageReact(A.id, pp.id, ' 🩷 '), { rx: [{ e: '👍', n: 1 }, { e: '🩷', n: 1 }], mine: '🩷' }, 'emoji dikanonkan (spasi dibuang), asing boleh di postingan Publik');
    { const sent = [], sg = C._pgSign; C._pgSign = (o, obj) => { sent.push(obj); return sg.call(C, o, obj); }; await C.pageReact(A.id, pp.id, ' 🩷 '); C._pgSign = sg;
      assert.deepStrictEqual(sent, [{ t: 'pg_rx', id: pp.id, e: '🩷' }], 'di kabel: emoji kanonis, tanpa bidang lain'); }
    assert.strictEqual((await B.pageReact(A.id, pp.id, '😭')).mine, '😭'); assert.strictEqual(sums(await B.pageReact(A.id, pp.id, '')), 1, 'cabut'); 
    assert.strictEqual(ps.reactionsFor(B.id, pp.id).mine, '', 'tercatat di pemilik');
    await B.pageReact(A.id, pp.id, '👍'); assert.strictEqual((await B.pagePost(A.id, pp.id)).mine, '👍', 'terlihat lewat pagePost');
    // b. tak terlihat = null yang sama; tak ada yang tercatat
    assert.strictEqual(await C.pageReact(A.id, pf.id, '👍'), null, 'Teman untuk asing'); assert.strictEqual(await C.pageReact(A.id, NONE, '👍'), null, 'tidak ada');
    assert.strictEqual(await B.pageReact(A.id, pf.id, '🥺') && 1, 1, 'teman boleh'); assert.strictEqual(ps.rx.view(pf.id, C.id).rx.length, 1);
    assert.strictEqual(await code(D.pageReact(A.id, pp.id, '👍')), 'tidak melempar', 'diblokir oleh pemilik: null biasa, bukan galat'); assert.strictEqual(await D.pageReact(A.id, pp.id, '👍'), null); assert.strictEqual(ps.rx.view(pp.id, D.id).mine, '');
    // c. bentuk salah / kode galat tanpa jaringan
    for (const [pid, id, e] of [['zz', pp.id, '👍'], [A.id, 'zz', '👍'], [A.id, pp.id, 'abc'], [A.id, pp.id, '<b>'], [A.id, pp.id, 5], [A.id, pp.id, null], [A.id, pp.id, '👍👍'], [5, pp.id, '👍']]) assert.strictEqual(await code(B.pageReact(pid, id, e)), 'bad', 'bad: ' + String(e));
    assert.strictEqual(await code(B.pageReact('f'.repeat(16), pp.id, '👍')), 'peer'); B.store.blocked[A.id] = 1; assert.strictEqual(await code(B.pageReact(A.id, pp.id, '👍')), 'blocked'); delete B.store.blocked[A.id];
    // d. caps: pemilik yang hello-nya tanpa 'pgr' = old, tanpa menyentuh jaringan; yang tanpa caps sama sekali tetap dicoba
    { const p = B.peers.get(A.id), keep = p.caps; let hit = 0; const rq = B._request; B._request = (...a) => { hit++; return rq.apply(B, a); };
      p.caps = ['rx', 'pg', 'pgm']; assert.strictEqual(await code(B.pageReact(A.id, pp.id, '👍')), 'old'); assert.strictEqual(hit, 0, 'tanpa jaringan');
      p.caps = keep; B._request = rq; }
    // e. milik sendiri: tanpa jaringan, lewat PageStore.react (pemilik boleh bereaksi di postingannya sendiri, termasuk Teman)
    { let hit = 0; const rq = A._request; A._request = (...a) => { hit++; return rq.apply(A, a); };
      const r = await A.pageReact(A.id, pf.id, '🩷'); assert.strictEqual(r.mine, '🩷'); assert.deepStrictEqual(r, ps.reactionsFor(A.id, pf.id)); assert.strictEqual(hit, 0, 'tanpa jaringan');
      assert.strictEqual((await A.pageReact(A.id, pf.id, '')).mine, ''); assert.strictEqual(await A.pageReact(A.id, NONE, '👍'), null, 'tidak ada = null');
      assert.strictEqual(await code(A.pageReact(A.id, pf.id, 'abc')), 'bad'); A._request = rq; }
    { const full = ps.create({ text: 'penuh' }); for (let i = 1; i <= 256; i++) ps.rx.set(i.toString(16).padStart(16, '0'), full.id, '👍', 100 + i); assert.strictEqual(await C.pageReact(A.id, full.id, '🩷'), null, 'penuh = null'); assert.strictEqual(await A.pageReact(A.id, full.id, '🩷'), null, 'penuh bagi pemilik pun null (tanpa galat)'); }
    // f. pemilik nakal / cacat: jawaban ditolak 'proto'; busy / auth diteruskan; jawaban jujur lolos
    { const real = A._pgHandle.bind(A), reply = (v) => { A._pgHandle = (o, rid) => (o.t === 'pg_rx' ? v : real(o, rid)); };
      const good = { rx: [{ e: '👍', n: 3 }], mine: '👍' };
      reply({ t: 'pg_rx', ok: true, r: good }); assert.deepStrictEqual(await B.pageReact(A.id, pp.id, '👍'), good, 'jawaban sah diteruskan (jumlah dari pemilik)');
      reply({ t: 'pg_rx', ok: true, r: Object.assign({ evil: 1, __proto__: { x: 1 } }, good) }); assert.deepStrictEqual(await B.pageReact(A.id, pp.id, '👍'), good, 'bidang asing dibuang');
      for (const bad of [{ rx: [{ e: '👍', n: 3 }], mine: '🩷' }, { rx: [{ e: '👍', n: 3 }] }, { rx: [], mine: '👍' }, { rx: [{ e: 'x', n: 1 }], mine: '' }, { rx: [{ e: '👍', n: 0 }], mine: '👍' }, { rx: [{ e: '👍', n: 257 }], mine: '👍' }, { rx: [{ e: '👍', n: 1 }, { e: '👍', n: 1 }], mine: '👍' }, { rx: 'x', mine: '👍' }, { rx: new Array(13).fill(0).map((_, i) => ({ e: ['👍', '🩷', '😭', '🥺', '🔥', '🎉', '😂', '😮', '😡', '👏', '🙏', '💯', '👀'][i], n: 1 })), mine: '👍' }, 5, 'x', [], { mine: '' }]) {
        reply({ t: 'pg_rx', ok: true, r: bad }); assert.strictEqual(await code(B.pageReact(A.id, pp.id, '👍')), 'proto', 'cacat: ' + JSON.stringify(bad).slice(0, 60));
      }
      reply({ t: 'pg_rx', ok: true, r: { rx: [], mine: '' } }); assert.deepStrictEqual(await B.pageReact(A.id, pp.id, ''), { rx: [], mine: '' }, 'cabut: kosong sah');
      reply({ t: 'pg_rx', ok: true, r: { rx: [{ e: '👍', n: 1 }], mine: '👍' } }); assert.strictEqual(await code(B.pageReact(A.id, pp.id, '')), 'proto', 'cabut tetapi pemilik mengaku masih ada reaksiku');
      reply({ t: 'pg_get', ok: true, post: null }); assert.strictEqual(await code(B.pageReact(A.id, pp.id, '👍')), 'proto', 'jenis balasan salah');
      for (const err of ['busy', 'auth', 'time', 'bad']) { reply({ t: 'pg_rx', ok: false, err }); assert.strictEqual(await code(B.pageReact(A.id, pp.id, '👍')), err); }
      reply({ t: 'pg_rx', ok: false, err: 'aneh' }); assert.strictEqual(await code(B.pageReact(A.id, pp.id, '👍')), 'proto');
      reply({ t: 'pg_rx', ok: true, r: null }); assert.strictEqual(await B.pageReact(A.id, pp.id, '👍'), null);
      A._pgHandle = real; }
    ok("pageReact: alur normal + idempotent + emoji dikanonkan, tak terlihat = null, bentuk salah 'bad' tanpa jaringan, caps tanpa 'pgr' = old, milik sendiri lokal tanpa jaringan, postingan penuh = null, jawaban cacat / tak cocok = proto, galat pemilik diteruskan");
  }

  console.log('\n' + pass + ' kelompok lulus');
  for (const n of all) await n.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

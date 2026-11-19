'use strict';
// Tes Halaman 4b-3: jembatan IPC komentar (src/archne-ipc-pages.js: pgComment, pgComments) dengan Electron palsu + dua Core sungguhan.
// Yang diuji: validasi masukan (tanpa menyentuh Core), jalur lokal pemilik, jalur jauh, tak terlihat = null yang sama, penyaringan bidang (hanya id / by / ts / text),
// pemetaan galat (kode Core diteruskan, galat sistem tanpa jalur lokal, 'full' beda dari null), dan preload.js sungguhan. Penyimpanan / tanda tangan: test/archne-pagecmt.js; jaringan: test/pagecmtnet.js.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { cleanText } = require('../src/archne-pagestore');
const { PG_ERR } = require('../src/core/archne-pgerr');
const { CMT_PER_AUTHOR } = require('../src/archne-pagecmt');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pgcmtipc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 });
function fake(core) {
  const handlers = {};
  register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core, send: () => {}, log: () => {} });
  return (n, ...a) => handlers[n]({}, ...a);
}
const pe = (code, msg) => Object.assign(new Error(msg), { code }); // galat ber-code seperti pgErr
const KEYS = ['by', 'id', 'text', 'ts']; // terurut abjad, untuk dibandingkan dengan Object.keys(...).sort()

(async () => {
  const A = mk('A'), B = mk('B'); const a = fake(A), b = fake(B);
  await A.start(); await B.start();
  try {
    const p1 = (await a('pgCreate', 'postingan publik', 'public')).post.id, pf = (await a('pgCreate', 'rahasia teman', 'friends')).post.id;
    await A.addPeer('127.0.0.1', B.port); await B.addPeer('127.0.0.1', A.port);
    await until(() => A.isOnline(A.peers.get(B.id)) && B.isOnline(B.peers.get(A.id)), 6000, 'online');
    const NONE = 'bbbbbbbbbbbbbbbb';
    let r;

    // ---- 1. validasi: masukan cacat = bad dan Core tidak dipanggil ----
    {
      const calls = []; const rc = A.pageComment, rs = A.pageComments, bc = B.pageComment, bs = B.pageComments;
      A.pageComment = B.pageComment = async (...x) => { calls.push(['c', x]); return null; }; A.pageComments = B.pageComments = async (...x) => { calls.push(['s', x]); return null; };
      try {
        for (const args of [[], ['xyz', p1, 'x'], [A.id, 'bukanhex', 'x'], [A.id, p1, 5], [A.id, p1, null], [A.id, p1], [A.id, p1, 'x'.repeat(4097)], [{}, p1, 'x'], [A.id.toUpperCase(), p1, 'x'], [A.id, [p1], 'x'], [A.id, p1 + 'a', 'x'], [A.id, null, 'x']]) {
          r = await b('pgComment', ...args); assert(r.ok === false && r.code === 'bad', 'pgComment bad: ' + JSON.stringify(args) + ' -> ' + JSON.stringify(r));
        }
        for (const args of [[], ['xyz', p1], [A.id, 'bukanhex'], [A.id, p1, 'x'], [A.id, p1, { after: 'ngawur' }], [A.id, p1, { after: 5 }], [A.id, p1, { limit: 1.5 }], [A.id, p1, { limit: '5' }], [{}, p1], [A.id.toUpperCase(), p1], [A.id, [p1]], [A.id, p1, { after: '12:abc' }]]) {
          r = await b('pgComments', ...args); assert(r.ok === false && r.code === 'bad', 'pgComments bad: ' + JSON.stringify(args) + ' -> ' + JSON.stringify(r));
        }
        assert.strictEqual(calls.length, 0, 'masukan cacat tidak pernah sampai ke Core: ' + JSON.stringify(calls));
        // yang sah sampai ke Core dengan argumen utuh dan HANYA after / limit (bidang liar dibuang)
        { calls.length = 0; await b('pgComment', A.id, p1, 'x'.repeat(4096)); assert.strictEqual(calls.length, 1, 'tepat di batas kasar (4096) masih sampai ke Core; Core yang memutuskan 1000'); calls.length = 0; }
        { calls.length = 0; await b('pgComment', A.id, p1, '  halo\n\n  dunia  '); assert.deepStrictEqual(calls, [['c', [A.id, p1, '  halo\n\n  dunia  ']]], 'teks diteruskan MENTAH: yang mengkanonkan dan menandatangani Core, bukan jembatan'); calls.length = 0; }
        await b('pgComment', A.id, p1, 'halo'); await b('pgComments', A.id, p1, { after: '5:' + 'a'.repeat(16), limit: 7, liar: 1 }); await b('pgComments', A.id, p1);
        assert.deepStrictEqual(calls, [['c', [A.id, p1, 'halo']], ['s', [A.id, p1, { after: '5:' + 'a'.repeat(16), limit: 7 }]], ['s', [A.id, p1, {}]]], 'argumen utuh, bidang liar dibuang: ' + JSON.stringify(calls));
      } finally { A.pageComment = rc; A.pageComments = rs; B.pageComment = bc; B.pageComments = bs; }
      // teks yang tak sah menurut Core (kosong, > 1000 setelah dikanonkan) juga bad, tanpa menulis apa pun
      for (const t of ['', '   ', '\n\n', 'x'.repeat(1001)]) { r = await a('pgComment', A.id, p1, t); assert(r.ok === false && r.code === 'bad', 'teks tak sah menurut Core: ' + t.length + ' -> ' + JSON.stringify(r)); }
      r = await a('pgComments', A.id, p1); assert.deepStrictEqual(r, { ok: true, comments: { items: [], next: null, count: 0, skipped: 0 } }, 'terlihat tetapi belum ada komentar = daftar kosong (null hanya untuk yang tak terlihat / tak ada)');
    }
    ok('validasi: id / teks / opsi cacat = bad tanpa menyentuh Core; sah diteruskan utuh tanpa bidang liar; teks kosong dan > 1000 = bad');

    // ---- 2. pemilik, lokal ----
    let own;
    {
      r = await a('pgComment', A.id, p1, '  halo   dunia  '); assert(r.ok && r.comment && r.comment.st === 'added', JSON.stringify(r)); own = r.comment.c;
      assert.deepStrictEqual(Object.keys(own).sort(), KEYS, 'hanya id / by / ts / text: ' + Object.keys(own)); assert.strictEqual(own.by, A.id); assert.strictEqual(own.text, cleanText('  halo   dunia  ')); assert(/^[0-9a-f]{16}$/.test(own.id) && Number.isSafeInteger(own.ts));
      r = await a('pgComments', A.id, p1); assert(r.ok && r.comments, JSON.stringify(r));
      assert.deepStrictEqual(r.comments, { items: [own], next: null, count: 1, skipped: 0 }, 'daftar lokal: persis satu, tanpa pub / sig');
      assert.deepStrictEqual(await a('pgComment', A.id, NONE, 'x'), { ok: true, comment: null }, 'postingan tidak ada = null');
      assert.deepStrictEqual(await a('pgComments', A.id, NONE), { ok: true, comments: null }, 'sama untuk daftar');
      r = await a('pgComment', A.id, pf, 'pemilik di postingan Teman'); assert(r.ok && r.comment && r.comment.st === 'added', 'pemilik boleh di postingan Teman sendiri');
    }
    ok('pemilik lokal: komentar dikanonkan + ditandatangani (id sendiri), keluar hanya id / by / ts / text, daftar sama persis, tak ada = null');

    // ---- 3. jarak jauh + halaman ----
    {
      r = await b('pgComment', A.id, p1, 'dari B satu'); assert(r.ok && r.comment && r.comment.st === 'added' && r.comment.c.by === B.id, JSON.stringify(r)); assert.deepStrictEqual(Object.keys(r.comment.c).sort(), KEYS);
      const c1 = r.comment.c;
      await sleep(3); r = await b('pgComment', A.id, p1, 'dari B dua'); assert(r.ok && r.comment.st === 'added'); const c2 = r.comment.c;
      await sleep(3); r = await a('pgComment', A.id, p1, 'pemilik membalas'); assert(r.ok); const c3 = r.comment.c;
      const all = [own, c1, c2, c3].sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
      const viaA = (await a('pgComments', A.id, p1)).comments, viaB = (await b('pgComments', A.id, p1)).comments;
      assert.deepStrictEqual(viaA.items, all, 'pemilik melihat keempatnya, tertua dulu'); assert.deepStrictEqual(viaB, { items: all, next: null, count: 4, skipped: 0 }, 'penonton jauh melihat yang sama, terverifikasi (skipped 0)');
      // halaman: limit 3 lalu sisanya, tanpa tumpang tindih, kursor dari next
      let pg = (await b('pgComments', A.id, p1, { limit: 3 })).comments; assert(pg.items.length === 3 && typeof pg.next === 'string' && pg.count === 4, JSON.stringify(pg));
      const pg2 = (await b('pgComments', A.id, p1, { after: pg.next, limit: 3 })).comments; assert(pg2.items.length === 1 && pg2.next === null && pg2.count === 4, JSON.stringify(pg2));
      assert.deepStrictEqual(pg.items.concat(pg2.items), all, 'halaman bersambung tanpa celah atau ganda');
      // limit 1 dari awal sampai habis
      const seen = []; let cur; for (let i = 0; i < 6; i++) { const q = (await b('pgComments', A.id, p1, cur ? { after: cur, limit: 1 } : { limit: 1 })).comments; seen.push(...q.items); if (!q.next) break; cur = q.next; }
      assert.deepStrictEqual(seen, all, 'limit 1 sampai habis = daftar penuh');
      // pgGet / pgList tidak berubah bentuk karena komentar (belum ada jumlah komentar di sana)
      const post = (await b('pgGet', A.id, p1)).post; assert(post && !('comments' in post) && !('cmt' in post), 'pgGet tidak membawa komentar (4b-4+): ' + Object.keys(post));
    }
    ok('jauh: B menulis (by = id B), A dan B melihat daftar yang sama berurutan, halaman bersambung tanpa celah, limit 1 sampai habis, pgGet tak berubah');

    // ---- 4. tak terlihat: null yang sama ----
    {
      const before = (await a('pgComments', A.id, pf)).comments.count;
      assert.deepStrictEqual(await b('pgComment', A.id, pf, 'tembus?'), { ok: true, comment: null }, 'postingan Teman untuk asing = null');
      assert.deepStrictEqual(await b('pgComments', A.id, pf), { ok: true, comments: null });
      assert.deepStrictEqual(await b('pgComment', A.id, NONE, 'x'), { ok: true, comment: null }, 'tidak ada = null, sama persis');
      assert.deepStrictEqual(await b('pgComments', A.id, NONE), { ok: true, comments: null });
      assert.strictEqual((await a('pgComments', A.id, pf)).comments.count, before, 'tidak ada yang tertulis');
      // blokir: B memblokir A -> galat ber-code (bukan null), tanpa jaringan
      B.blockUser(A.id);
      try { r = await b('pgComment', A.id, p1, 'x'); assert(r.ok === false && r.code === 'blocked' && r.err === PG_ERR.blocked, JSON.stringify(r)); r = await b('pgComments', A.id, p1); assert(r.ok === false && r.code === 'blocked', JSON.stringify(r)); } finally { B.unblockUser(A.id); }
      await until(() => B.isOnline(B.peers.get(A.id)), 4000, 'online lagi');
      r = await b('pgComments', 'cccccccccccccccc', p1); assert(r.ok === false && r.code === 'peer', JSON.stringify(r));
    }
    ok('tak terlihat: Teman-untuk-asing dan tak ada = null yang sama, tidak menulis apa pun; diblokir = blocked, peer tak dikenal = peer');

    // ---- 5. penyaringan bidang ----
    {
      const rc = B.pageComment, rs = B.pageComments;
      const rich = { id: 'a'.repeat(16), by: 'b'.repeat(16), ts: 123, text: 'isi', pub: 'PUB', sig: 'SIG', post: p1, who: [1], path: '/rahasia' };
      try {
        B.pageComment = async () => ({ st: 'same', c: rich, path: '/x', extra: 1 }); r = await b('pgComment', A.id, p1, 'x');
        assert.deepStrictEqual(r, { ok: true, comment: { st: 'same', c: { id: 'a'.repeat(16), by: 'b'.repeat(16), ts: 123, text: 'isi' } } }, 'hanya st + empat bidang: ' + JSON.stringify(r));
        B.pageComment = async () => ({ st: 'aneh', c: rich }); assert.strictEqual((await b('pgComment', A.id, p1, 'x')).comment.st, 'added', 'st tak dikenal = added (Core sudah menolak status lain dengan proto)');
        B.pageComment = async () => null; assert.deepStrictEqual(await b('pgComment', A.id, p1, 'x'), { ok: true, comment: null });
        B.pageComment = async () => ({ st: 'added' }); assert.deepStrictEqual(await b('pgComment', A.id, p1, 'x'), { ok: true, comment: null }, 'tanpa komentar = null, tidak melempar');
        B.pageComments = async () => ({ items: [rich, rich], next: 'x', count: 'banyak', skipped: undefined, lain: 1 });
        r = await b('pgComments', A.id, p1); assert.deepStrictEqual(r, { ok: true, comments: { items: [{ id: 'a'.repeat(16), by: 'b'.repeat(16), ts: 123, text: 'isi' }, { id: 'a'.repeat(16), by: 'b'.repeat(16), ts: 123, text: 'isi' }], next: 'x', count: 0, skipped: 0 } }, 'bidang liar dibuang, angka cacat = 0: ' + JSON.stringify(r));
        B.pageComments = async () => ({ items: 'bukan larik', next: 5, count: 3, skipped: 2 }); r = await b('pgComments', A.id, p1); assert.deepStrictEqual(r, { ok: true, comments: { items: [], next: null, count: 3, skipped: 2 } }, 'items bukan larik = [], next bukan string = null');
        B.pageComments = async () => null; assert.deepStrictEqual(await b('pgComments', A.id, p1), { ok: true, comments: null });
      } finally { B.pageComment = rc; B.pageComments = rs; }
    }
    ok('penyaringan: hanya st + id / by / ts / text (tanpa pub / sig / post / jalur), st tak dikenal = added, null dan komentar hilang = null, items / next / count / skipped cacat dinormalkan');

    // ---- 6. galat ----
    {
      const rc = B.pageComment, rs = B.pageComments;
      try {
        for (const c of ['full', 'offline', 'old', 'blocked', 'proto', 'busy', 'auth', 'time', 'bad', 'peer', 'self']) {
          B.pageComment = async () => { throw pe(c, 'galat ' + c); }; B.pageComments = async () => { throw pe(c, 'galat ' + c); };
          for (const r2 of [await b('pgComment', A.id, p1, 'x'), await b('pgComments', A.id, p1)]) assert.deepStrictEqual([r2.ok, r2.code, r2.err], [false, c, 'galat ' + c], 'kode Core diteruskan: ' + c);
        }
        // galat sistem: pesan memuat jalur -> umum
        const leak = "EACCES: permission denied, open '/home/x/rahasia/comments.json'";
        for (const fn of ['pageComment', 'pageComments']) {
          B[fn] = async () => { throw pe('EACCES', leak); };
          r = await (fn === 'pageComment' ? b('pgComment', A.id, p1, 'x') : b('pgComments', A.id, p1)); assert.deepStrictEqual([r.ok, r.code, r.err], [false, 'EACCES', 'Failed to process the comment'], 'jalur tidak bocor: ' + JSON.stringify(r)); assert(!/home|rahasia/.test(JSON.stringify(r)));
          B[fn] = async () => { throw pe('ENOSPC', "ENOSPC: no space left on device, write '/tmp/x'"); };
          r = await (fn === 'pageComment' ? b('pgComment', A.id, p1, 'x') : b('pgComments', A.id, p1)); assert.deepStrictEqual([r.ok, r.code, r.err], [false, 'ENOSPC', 'Storage is full']);
          for (const e of [new Error('gagal di /rahasia/x'), pe('kecil', 'x /rahasia'), pe(5, 'x /rahasia'), pe(12345, 'x /rahasia'), pe(['full'], 'x /rahasia'), pe({ toString: () => 'full' }, 'x /rahasia'), pe('TERLALU_PANJANG_UNTUK_KODE_SISTEM', 'x /rahasia'), null, 'teks']) {
            B[fn] = async () => { throw e; };
            r = await (fn === 'pageComment' ? b('pgComment', A.id, p1, 'x') : b('pgComments', A.id, p1)); assert.deepStrictEqual([r.ok, r.code, r.err], [false, 'io', 'Failed to process the comment'], 'tanpa code sah = io: ' + String(e));
          }
        }
      } finally { B.pageComment = rc; B.pageComments = rs; }
      // 'full' sungguhan (lokal, tanpa jaringan): batas per penulis = CMT_PER_AUTHOR; BEDA dari null
      const p2 = (await a('pgCreate', 'untuk batas', 'public')).post.id; let n = 0;
      for (; n < CMT_PER_AUTHOR; n++) { r = await a('pgComment', A.id, p2, 'k' + n); assert(r.ok && r.comment, 'komentar ke-' + (n + 1)); }
      r = await a('pgComment', A.id, p2, 'kelebihan'); assert.deepStrictEqual([r.ok, r.code, r.err], [false, 'full', PG_ERR.full], 'batas tercapai = full, bukan null: ' + JSON.stringify(r));
      assert.strictEqual((await a('pgComments', A.id, p2)).comments.count, CMT_PER_AUTHOR, 'yang ke-21 tidak tertulis');
      // pemilik lama: old tanpa menyentuh jaringan
      let asked = 0; const ask = B._pgAsk; B._pgAsk = async () => { asked++; throw new Error('tidak boleh'); };
      const real = B.peers.get.bind(B.peers); B.peers.get = (x) => { const p = real(x); return x === A.id && p ? Object.assign({}, p, { caps: ['pg'] }) : p; };
      try {
        r = await b('pgComment', A.id, p1, 'x'); assert(r.ok === false && r.code === 'old', JSON.stringify(r)); r = await b('pgComments', A.id, p1); assert(r.ok === false && r.code === 'old', JSON.stringify(r));
        assert.strictEqual(asked, 0, 'old = tanpa jaringan');
      } finally { delete B.peers.get; B._pgAsk = ask; }
    }
    ok('galat: kode Core diteruskan apa adanya, galat sistem tanpa jalur lokal (EACCES / ENOSPC / tanpa code = io), full sungguhan = galat beda dari null, pemilik lama = old tanpa jaringan');

    // ---- 7. preload.js sungguhan + api-http ----
    {
      const Module = require('module'), calls = []; let exposed = null;
      const fakeElectron = { contextBridge: { exposeInMainWorld: (n, o) => { exposed = o; } }, ipcRenderer: { invoke: (...x) => { calls.push(x); return Promise.resolve('balasan'); }, on() {} }, webUtils: { getPathForFile: () => '' } };
      const load = Module._load; Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : load.call(this, req, ...rest); };
      const pp = require.resolve('../preload.js'); delete require.cache[pp];
      try { require(pp); } finally { Module._load = load; delete require.cache[pp]; }
      assert.strictEqual(typeof exposed.pgComment, 'function'); assert.strictEqual(typeof exposed.pgComments, 'function');
      assert.strictEqual(await exposed.pgComment('a'.repeat(16), 'b'.repeat(16), 'halo'), 'balasan'); assert.strictEqual(await exposed.pgComments('a'.repeat(16), 'b'.repeat(16), { after: '1:' + 'c'.repeat(16), limit: 5 }), 'balasan');
      assert.deepStrictEqual(calls, [['pgComment', 'a'.repeat(16), 'b'.repeat(16), 'halo'], ['pgComments', 'a'.repeat(16), 'b'.repeat(16), { after: '1:' + 'c'.repeat(16), limit: 5 }]], 'kanal dan semua argumen utuh');
      const http = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archne-api-http.js'), 'utf8'); assert(http.includes("'pgComment'") && http.includes("'pgComments'"), 'archne-api-http.js mendaftarkan keduanya (jalur HTTP diuji di archne-rpc.js)');
    }
    ok('preload.js sungguhan: api.pgComment / api.pgComments meneruskan semua argumen ke kanal masing-masing; archne-api-http.js mendaftarkan keduanya');
  } finally { try { await A.stop(); await B.stop(); } catch {} }
  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

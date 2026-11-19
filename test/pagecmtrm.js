'use strict';
// Tes Halaman 5c-1: moderasi komentar oleh pemilik (Core.pageCommentRemove + IPC pgCmtRemove + preload + api-http) dengan Electron palsu + dua Core sungguhan.
// Yang diuji: validasi masukan (tanpa menyentuh Core), hapus lokal (komentar orang lain DAN komentar sendiri), penonton jauh melihatnya hilang saat memuat ulang,
// berkas comments.json ikut berubah, tak ada = removed:false yang sama untuk semua sebab (tanpa membuat folder halaman), tidak ada jalan ke halaman orang lain,
// gagal tulis = galat tanpa jalur dan keadaan tidak berubah, kirim ulang ditolak (5c-3, rinci di test/pagecmtpriv.js), preload.js sungguhan, archne-api-http.js.
// Penyimpanan: test/archne-pagecmt.js; jaringan: test/pagecmtnet.js; IPC baca / tulis komentar: test/pagecmtipc.js.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pgcmtrm-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 });
function fake(core) {
  const handlers = {};
  register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core, send: () => {}, log: () => {} });
  return (n, ...a) => handlers[n]({}, ...a);
}
const pe = (code, msg) => Object.assign(new Error(msg), { code });
const stored = (core) => { try { return JSON.parse(fs.readFileSync(path.join(core.opts.dataDir, 'pages', 'comments.json'), 'utf8')).map; } catch { return {}; } };

(async () => {
  const A = mk('A'), B = mk('B'), C = mk('C'); const a = fake(A), b = fake(B), c = fake(C);
  await A.start(); await B.start(); await C.start();
  try {
    const p1 = (await a('pgCreate', 'postingan publik', 'public')).post.id, pf = (await a('pgCreate', 'rahasia teman', 'friends')).post.id;
    await A.addPeer('127.0.0.1', B.port); await B.addPeer('127.0.0.1', A.port);
    await until(() => A.isOnline(A.peers.get(B.id)) && B.isOnline(B.peers.get(A.id)), 6000, 'online');
    const NONE = 'bbbbbbbbbbbbbbbb';
    let r;

    // ---- 1. validasi: masukan cacat = bad dan Core tidak dipanggil ----
    {
      const calls = []; const rm = A.pageCommentRemove; A.pageCommentRemove = (...x) => { calls.push(x); return false; };
      try {
        for (const args of [[], [p1], [p1, 5], [5, p1], [null, p1], [p1, null], ['xyz', p1], [p1, 'bukanhex'], [{}, p1], [p1, {}], [[p1], p1], [p1, [NONE]], [p1.toUpperCase(), NONE], [p1, NONE.toUpperCase()], [p1 + 'a', NONE], [p1, NONE + 'a'], ['', ''], [p1, '']]) {
          r = await a('pgCmtRemove', ...args); assert(r.ok === false && r.code === 'bad', 'bad: ' + JSON.stringify(args) + ' -> ' + JSON.stringify(r));
        }
        assert.strictEqual(calls.length, 0, 'masukan cacat tidak pernah sampai ke Core');
        r = await a('pgCmtRemove', p1, NONE, 'liar', { x: 1 }); assert.deepStrictEqual(r, { ok: true, removed: false });
        assert.deepStrictEqual(calls, [[p1, NONE]], 'sah diteruskan persis (postId, cid), argumen liar dibuang');
      } finally { A.pageCommentRemove = rm; }
      // Core sendiri juga menolak (lapisan kedua), tanpa menyentuh berkas
      for (const args of [[], [p1], [p1, 5], ['x', NONE], [NONE, 'x']]) assert.throws(() => A.pageCommentRemove(...args), (e) => e.code === 'bad', 'Core: ' + JSON.stringify(args));
    }
    ok('validasi: id cacat / bukan string / kurang argumen = bad (IPC dan Core), tanpa menyentuh Core; sah diteruskan persis (postId, cid)');

    // ---- 2. hapus lokal ----
    let own, cb1, cb2, cb3;
    {
      r = await a('pgComment', A.id, p1, 'komentar pemilik'); own = r.comment.c;
      await sleep(3); r = await b('pgComment', A.id, p1, 'dari B satu'); cb1 = r.comment.c;
      await sleep(3); r = await b('pgComment', A.id, p1, 'dari B dua'); cb2 = r.comment.c;
      await sleep(3); r = await b('pgComment', A.id, p1, 'dari B tiga'); cb3 = r.comment.c;
      r = await a('pgComment', A.id, pf, 'di postingan Teman'); const cf = r.comment.c;
      assert.strictEqual((await a('pgComments', A.id, p1)).comments.count, 4);

      r = await a('pgCmtRemove', p1, cb2.id); assert.deepStrictEqual(r, { ok: true, removed: true }, JSON.stringify(r));
      const left = (await a('pgComments', A.id, p1)).comments; assert.deepStrictEqual(left.items.map((x) => x.id), [own.id, cb1.id, cb3.id], 'tinggal tiga, urutan terjaga'); assert.strictEqual(left.count, 3);
      r = await a('pgCmtRemove', p1, cb2.id); assert.deepStrictEqual(r, { ok: true, removed: false }, 'kedua kali = removed:false (aman diulang / klik ganda)');
      // komentar pemilik sendiri juga bisa dibuang; postingan lain tidak tersentuh
      r = await a('pgCmtRemove', p1, own.id); assert.deepStrictEqual(r, { ok: true, removed: true });
      assert.deepStrictEqual((await a('pgComments', A.id, p1)).comments.items.map((x) => x.id), [cb1.id, cb3.id]);
      assert.deepStrictEqual((await a('pgComments', A.id, pf)).comments.items.map((x) => x.id), [cf.id], 'postingan lain tak tersentuh');
      // id komentar dari postingan LAIN tidak bisa dibuang lewat postingan ini
      r = await a('pgCmtRemove', p1, cf.id); assert.deepStrictEqual(r, { ok: true, removed: false }, 'cid milik postingan lain = tidak ada di sini');
      assert.strictEqual((await a('pgComments', A.id, pf)).comments.count, 1);
      // berkas ikut berubah (bukan hanya memori)
      const m = stored(A); assert.deepStrictEqual((m[p1] || []).map((x) => x.id), [cb1.id, cb3.id], 'comments.json sesuai'); assert.deepStrictEqual(m[pf].map((x) => x.id), [cf.id]);
      // sampai habis: kunci postingan hilang dari berkas
      assert.strictEqual((await a('pgCmtRemove', p1, cb1.id)).removed, true); assert.strictEqual((await a('pgCmtRemove', p1, cb3.id)).removed, true);
      assert.deepStrictEqual(await a('pgComments', A.id, p1), { ok: true, comments: { items: [], next: null, count: 0, skipped: 0 } }, 'terlihat, kosong (bukan null)');
      assert(!(p1 in stored(A)), 'tanpa komentar tersisa = kunci postingan dibuang dari berkas');
    }
    ok('lokal: komentar orang lain dan milik sendiri terbuang, urutan sisa terjaga, ulang = removed:false, cid dari postingan lain tidak kena, comments.json ikut berubah');

    // ---- 3. penonton jauh melihat hilang saat memuat ulang; tak ada jejak di postingan ----
    {
      for (const t of ['satu', 'dua', 'tiga']) { await sleep(3); r = await b('pgComment', A.id, p1, 'B ' + t); assert(r.ok && r.comment); }
      const before = (await b('pgComments', A.id, p1)).comments; assert.strictEqual(before.count, 3);
      const dua = before.items.find((x) => x.text === 'B dua');
      assert.deepStrictEqual(await a('pgCmtRemove', p1, dua.id), { ok: true, removed: true });
      const after = (await b('pgComments', A.id, p1)).comments;
      assert.deepStrictEqual(after, { items: before.items.filter((x) => x.id !== dua.id), next: null, count: 2, skipped: 0 }, 'B memuat ulang: yang dibuang tidak ada, tidak ada yang dianggap palsu (skipped 0)');
      const post = (await b('pgGet', A.id, p1)).post; assert(post && !('comments' in post), 'pgGet tak berubah bentuk');
    }
    ok('jauh: penonton yang memuat ulang tidak lagi melihat komentar yang dibuang (pemilik = sumber), sisanya utuh dan terverifikasi');

    // ---- 4. tak ada = removed:false yang sama; tanpa membuat folder ----
    {
      for (const [pid, cid] of [[NONE, NONE], [NONE, (await a('pgComments', A.id, p1)).comments.items[0].id], [p1, NONE], [pf, NONE]]) assert.deepStrictEqual(await a('pgCmtRemove', pid, cid), { ok: true, removed: false }, 'sama untuk semua sebab: ' + pid + ' ' + cid);
      const dir = path.join(tmp, 'C', 'pages'); assert(!fs.existsSync(dir), 'syarat awal: C belum punya folder halaman');
      assert.deepStrictEqual(await c('pgCmtRemove', NONE, NONE), { ok: true, removed: false }); assert(!fs.existsSync(dir), 'menghapus tidak membuat folder halaman');
    }
    ok('tak ada: postingan / komentar tak dikenal, cid dari postingan lain = removed:false yang sama; folder halaman tidak dibuat');

    // ---- 5. hanya halaman sendiri: tidak ada jalan ke halaman orang lain ----
    {
      const keep = (await a('pgComments', A.id, p1)).comments.items.map((x) => x.id); assert(keep.length >= 1);
      for (const cid of keep) assert.deepStrictEqual(await b('pgCmtRemove', p1, cid), { ok: true, removed: false }, 'B memanggil dengan id postingan + komentar A: B tidak punya postingan itu');
      assert.deepStrictEqual((await a('pgComments', A.id, p1)).comments.items.map((x) => x.id), keep, 'komentar di halaman A tidak tersentuh');
      // moderasi pemilik (pageCommentRemove / removeComment) tidak punya jalur jaringan. Sejak 5e satu-satunya pesan hapus adalah pg_cmd milik PENULIS, yang hanya lewat removeCommentBy (komentar milik pengirim terbukti; rinci: test/pagecmtdel.js)
      assert.strictEqual(typeof A._pgCmtHandle, 'function'); const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'archne-pages-cmt.js'), 'utf8');
      assert(!/t\s*===\s*'pg_cr|pg_crm/.test(src), 'tidak ada tipe pesan hapus oleh pemilik di jaringan');
      const h = src.slice(src.indexOf('  _pgCmdHandle(o, rid) {'), src.indexOf('  _pgCmtHandle(o, rid) {')); assert(h.includes('removeCommentBy(') && !/removeComment\(/.test(h), 'handler pg_cmd memakai removeCommentBy, bukan moderasi pemilik');
    }
    ok('hanya milik sendiri: pemanggilan oleh B terhadap id postingan A tak berefek; tidak ada pesan jaringan untuk moderasi pemilik');

    // ---- 6. kirim ulang: sejak 5c-3 yang dihapus tetap terhapus (rinci: test/pagecmtpriv.js) ----
    {
      const mine = (await a('pgComments', A.id, p1)).comments.items[0];
      const full = A.pageStore().commentsFor(A.id, p1).find((x) => x.id === mine.id); assert(full && full.sig, 'komentar lengkap (dengan tanda tangan) ada di penyimpanan');
      assert.strictEqual((await a('pgCmtRemove', p1, mine.id)).removed, true);
      assert.strictEqual(A.pageStore().comment(full.by, p1, full), null, 'komentar bertanda tangan yang sama persis, dikirim ulang penulisnya, ditolak (nisan)');
      assert.strictEqual((await a('pgComments', A.id, p1)).comments.items.some((x) => x.id === mine.id), false);
      assert.deepStrictEqual(await a('pgCmtRemove', p1, mine.id), { ok: true, removed: false }, 'sudah tidak ada');
    }
    ok('kirim ulang komentar yang sama persis sesudah dihapus = ditolak (5c-3)');

    // ---- 7. gagal tulis: galat tanpa jalur, keadaan tidak berubah ----
    {
      r = await a('pgComment', A.id, p1, 'untuk uji gagal tulis'); const t = r.comment.c;
      const cmt = A.pageStore().cmt, w = cmt.write;
      try {
        cmt.write = () => { throw pe('EACCES', "EACCES: permission denied, open '/home/x/rahasia/comments.json'"); };
        r = await a('pgCmtRemove', p1, t.id); assert.deepStrictEqual([r.ok, r.code, r.err], [false, 'EACCES', 'Failed to process the comment'], JSON.stringify(r)); assert(!/home|rahasia/.test(JSON.stringify(r)), 'jalur tidak bocor');
        cmt.write = () => { throw pe('ENOSPC', "ENOSPC: no space left on device, write '/tmp/x'"); };
        r = await a('pgCmtRemove', p1, t.id); assert.deepStrictEqual([r.ok, r.code, r.err], [false, 'ENOSPC', 'Storage is full']);
        assert.strictEqual((await a('pgComments', A.id, p1)).comments.items.some((x) => x.id === t.id), true, 'gagal tulis: komentar tetap ada di memori (kembali seperti di berkas)');
      } finally { cmt.write = w; }
      assert.deepStrictEqual(await a('pgCmtRemove', p1, t.id), { ok: true, removed: true }, 'sesudah pulih, berhasil');
      // galat lain dari Core dipetakan sama seperti kanal komentar lain
      const rm = A.pageCommentRemove;
      try {
        for (const e of [new Error('gagal di /rahasia/x'), pe('kecil', 'x /rahasia'), pe(5, 'x /rahasia'), null, 'teks']) {
          A.pageCommentRemove = () => { throw e; }; r = await a('pgCmtRemove', p1, NONE); assert.deepStrictEqual([r.ok, r.code, r.err], [false, 'io', 'Failed to process the comment'], 'tanpa code sah = io: ' + String(e));
        }
        A.pageCommentRemove = () => { throw pe('bad', 'Permintaan tidak valid'); }; r = await a('pgCmtRemove', p1, NONE); assert.deepStrictEqual([r.ok, r.code], [false, 'bad']);
        for (const v of [undefined, null, 0, 1, 'true', {}]) { A.pageCommentRemove = () => v; r = await a('pgCmtRemove', p1, NONE); assert.deepStrictEqual(r, { ok: true, removed: false }, 'hasil bukan true persis = removed:false: ' + String(v)); }
        A.pageCommentRemove = () => true; assert.deepStrictEqual(await a('pgCmtRemove', p1, NONE), { ok: true, removed: true });
      } finally { A.pageCommentRemove = rm; }
    }
    ok('gagal tulis: EACCES / ENOSPC tanpa jalur lokal dan komentar tetap ada; galat tak dikenal = io; hasil Core dinormalkan ke boolean persis');

    // ---- 8. preload.js sungguhan + api-http ----
    {
      const Module = require('module'), calls = []; let exposed = null;
      const fakeElectron = { contextBridge: { exposeInMainWorld: (n, o) => { exposed = o; } }, ipcRenderer: { invoke: (...x) => { calls.push(x); return Promise.resolve('balasan'); }, on() {} }, webUtils: { getPathForFile: () => '' } };
      const load = Module._load; Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : load.call(this, req, ...rest); };
      const pp = require.resolve('../preload.js'); delete require.cache[pp];
      try { require(pp); } finally { Module._load = load; delete require.cache[pp]; }
      assert.strictEqual(typeof exposed.pgCmtRemove, 'function'); assert.strictEqual(await exposed.pgCmtRemove('a'.repeat(16), 'b'.repeat(16)), 'balasan');
      assert.deepStrictEqual(calls, [['pgCmtRemove', 'a'.repeat(16), 'b'.repeat(16)]], 'kanal dan kedua argumen utuh');
      const http = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archne-api-http.js'), 'utf8'); assert(http.includes("'pgCmtRemove'"), 'archne-api-http.js mendaftarkan pgCmtRemove (jalur HTTP diuji di archne-rpc.js)');
    }
    ok('preload.js sungguhan: api.pgCmtRemove meneruskan (postId, cid) ke kanalnya; archne-api-http.js mendaftarkannya');
  } finally { try { await A.stop(); await B.stop(); await C.stop(); } catch {} }
  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

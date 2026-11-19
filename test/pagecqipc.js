'use strict';
// Tes Halaman 4c-2 (fase 1): jembatan IPC antrean komentar (src/archne-ipc-pages.js: pgCommentQueue, pgCommentPending, pgCommentCancel, event pgcq) dengan Electron palsu + dua Core sungguhan.
// Yang diuji: validasi (tanpa menyentuh Core), jalur sukses (pemilik dimatikan, antre, pending, batal, hidup lagi), penyaringan bidang, pemetaan galat (qfull, galat sistem tanpa jalur), preload.js.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { PG_ERR } = require('../src/core/archne-pgerr');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pgcqipc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 });
function fake(core) {
  const handlers = {}, sent = [];
  const reg = register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core, send: (ch, p) => { sent.push([ch, p]); }, log: () => {} });
  const f = (n, ...a) => handlers[n]({}, ...a); f.sent = sent; f.reg = reg;
  return f;
}
const pe = (code, msg) => Object.assign(new Error(msg), { code });
const KEYS = ['by', 'id', 'text', 'ts'];

(async () => {
  const A = mk('A'), B = mk('B'); const a = fake(A), b = fake(B);
  await A.start(); await B.start();
  try {
    const p1 = (await a('pgCreate', 'postingan publik', 'public')).post.id;
    await A.addPeer('127.0.0.1', B.port); await B.addPeer('127.0.0.1', A.port);
    await until(() => A.isOnline(A.peers.get(B.id)) && B.isOnline(B.peers.get(A.id)), 6000, 'online');
    const NONE = 'bbbbbbbbbbbbbbbb';
    let r;

    // ---- 1. validasi: cacat = bad dan Core tidak dipanggil ----
    {
      const calls = []; const q = B.pageCommentQueue, p = B.pageCommentPending, c = B.pageCommentCancel;
      B.pageCommentQueue = async (...x) => { calls.push(['q', x]); return null; }; B.pageCommentPending = (...x) => { calls.push(['p', x]); return []; }; B.pageCommentCancel = (...x) => { calls.push(['c', x]); return false; };
      try {
        for (const args of [[], [A.id], [A.id, p1], [A.id, p1, 5], [A.id, p1, null], [A.id, p1, 'x'.repeat(4097)], ['zz', p1, 'x'], [A.id, 'zz', 'x'], [5, p1, 'x'], [A.id.toUpperCase(), p1, 'x']]) {
          r = await b('pgCommentQueue', ...args); assert(r.ok === false && r.code === 'bad', 'queue bad: ' + JSON.stringify(args) + ' -> ' + JSON.stringify(r));
        }
        for (const args of [[], [A.id], ['zz', p1], [A.id, 'zz'], [A.id, 5], [{}, p1]]) {
          r = await b('pgCommentPending', ...args); assert(r.ok === false && r.code === 'bad', 'pending bad: ' + JSON.stringify(args));
          r = await b('pgCommentCancel', ...args); assert(r.ok === false && r.code === 'bad', 'cancel bad: ' + JSON.stringify(args));
        }
        assert.strictEqual(calls.length, 0, 'Core tidak dipanggil: ' + JSON.stringify(calls));
        await b('pgCommentQueue', A.id, p1, '  halo  '); await b('pgCommentPending', A.id, p1); await b('pgCommentCancel', A.id, p1);
        assert.deepStrictEqual(calls, [['q', [A.id, p1, '  halo  ']], ['p', [A.id, p1]], ['c', [A.id, p1]]], 'sah diteruskan utuh');
      } finally { B.pageCommentQueue = q; B.pageCommentPending = p; B.pageCommentCancel = c; }
    }
    ok('validasi: id / teks cacat = bad tanpa menyentuh Core; sah diteruskan utuh');

    // ---- 2. jalur sukses: pemilik offline -> antre -> pending -> batal; antre lagi -> terkirim saat online ----
    {
      r = await b('pgCommentQueue', B.id, p1, 'x'); assert(r.ok === false && r.code === 'self', 'id sendiri = self: ' + JSON.stringify(r));
      assert.deepStrictEqual(await b('pgCommentPending', A.id, p1), { ok: true, pending: [] }, 'awal kosong');
      assert.deepStrictEqual(await b('pgCommentCancel', A.id, NONE), { ok: true, cancelled: false });
      r = await b('pgCommentQueue', A.id, p1, '  satu   batal  '); assert(r.ok && r.queued && r.queued.st === 'queued', JSON.stringify(r));
      const c1 = r.queued.c; assert.deepStrictEqual(Object.keys(c1).sort(), KEYS); assert.strictEqual(c1.by, B.id); assert.strictEqual(c1.text, 'satu batal');
      r = await b('pgCommentPending', A.id, p1); assert(r.ok && r.pending.length === 1 && r.pending[0].id === c1.id, JSON.stringify(r));
      assert.deepStrictEqual(Object.keys(r.pending[0]).sort(), ['id', 'text', 'ts'], 'pending hanya id / ts / text');
      assert.deepStrictEqual(await b('pgCommentCancel', NONE, c1.id), { ok: true, cancelled: false }, 'pemilik lain tidak membatalkan');
      assert.deepStrictEqual(await b('pgCommentCancel', A.id, c1.id), { ok: true, cancelled: true });
      assert.deepStrictEqual(await b('pgCommentPending', A.id, p1), { ok: true, pending: [] }, 'sesudah batal kosong');
      assert.deepStrictEqual(await b('pgCommentCancel', A.id, c1.id), { ok: true, cancelled: false }, 'batal dua kali = false');
      // antre lagi, tunggu terkirim oleh tick
      r = await b('pgCommentQueue', A.id, p1, 'dua terkirim'); assert(r.ok && r.queued.st === 'queued'); const c2 = r.queued.c;
      await until(async () => ((await a('pgComments', A.id, p1)).comments.items || []).some((x) => x.id === c2.id), 8000, 'komentar sampai ke pemilik');
      await until(async () => (await b('pgCommentPending', A.id, p1)).pending.length === 0, 4000, 'pending kosong setelah terkirim');
      const got = (await a('pgComments', A.id, p1)).comments.items.find((x) => x.id === c2.id);
      assert.deepStrictEqual(got, c2, 'komentar di pemilik sama dengan yang diantrekan (ts = saat ditulis)');
    }
    ok('sukses: self ditolak, antre = queued, pending hanya id / ts / text, batal (hanya pemilik yang benar, sekali), antrean terkirim otomatis dan pending kosong');

    // ---- 3. galat Core diteruskan; galat sistem tanpa jalur ----
    {
      const q = B.pageCommentQueue, p = B.pageCommentPending, c = B.pageCommentCancel;
      try {
        for (const code of ['qfull', 'blocked', 'old', 'peer', 'self', 'bad']) {
          B.pageCommentQueue = async () => { throw pe(code, 'galat ' + code); };
          r = await b('pgCommentQueue', A.id, p1, 'x'); assert.deepStrictEqual([r.ok, r.code, r.err], [false, code, 'galat ' + code], 'kode diteruskan: ' + code);
        }
        B.pageCommentPending = () => { throw pe('bad', 'cacat'); }; r = await b('pgCommentPending', A.id, p1); assert.deepStrictEqual([r.ok, r.code], [false, 'bad']);
        B.pageCommentCancel = () => { throw pe('bad', 'cacat'); }; r = await b('pgCommentCancel', A.id, p1); assert.deepStrictEqual([r.ok, r.code], [false, 'bad']);
        const leak = "EACCES: permission denied, open '/home/x/rahasia/pgcq.json'";
        B.pageCommentQueue = async () => { throw pe('EACCES', leak); }; r = await b('pgCommentQueue', A.id, p1, 'x');
        assert.deepStrictEqual([r.ok, r.code, r.err], [false, 'EACCES', 'Failed to process the comment'], 'jalur lokal tidak bocor: ' + JSON.stringify(r));
        B.pageCommentPending = () => { throw pe('EACCES', leak); }; r = await b('pgCommentPending', A.id, p1); assert.strictEqual(r.err, 'Failed to process the comment');
        B.pageCommentCancel = () => { throw pe('ENOSPC', "ENOSPC: no space left, write '/tmp/x'"); }; r = await b('pgCommentCancel', A.id, p1); assert.deepStrictEqual([r.code, r.err], ['ENOSPC', 'Storage is full']);
        assert(PG_ERR.qfull && /menunggu/.test(PG_ERR.qfull), 'pesan qfull ada');
      } finally { B.pageCommentQueue = q; B.pageCommentPending = p; B.pageCommentCancel = c; }
    }
    ok('galat: qfull / blocked / old / peer / self / bad diteruskan beserta pesannya, galat sistem tanpa jalur lokal, ENOSPC = Penyimpanan penuh');

    // ---- 4. penyaringan bidang ----
    {
      const q = B.pageCommentQueue, p = B.pageCommentPending;
      const rich = { id: 'a'.repeat(16), by: 'b'.repeat(16), ts: 5, text: 'isi', pub: 'PUB', sig: 'SIG', post: p1 };
      try {
        B.pageCommentQueue = async () => ({ st: 'same', c: rich, path: '/x' }); r = await b('pgCommentQueue', A.id, p1, 'x');
        assert.deepStrictEqual(r, { ok: true, queued: { st: 'same', c: { id: 'a'.repeat(16), by: 'b'.repeat(16), ts: 5, text: 'isi' } } }, JSON.stringify(r));
        B.pageCommentQueue = async () => ({ st: 'aneh', c: rich }); assert.strictEqual((await b('pgCommentQueue', A.id, p1, 'x')).queued.st, 'queued', 'st tak dikenal = queued');
        B.pageCommentQueue = async () => null; assert.deepStrictEqual(await b('pgCommentQueue', A.id, p1, 'x'), { ok: true, queued: null });
        B.pageCommentPending = () => [rich, { id: 'c'.repeat(16), ts: 6, text: 't', sig: 'S' }]; r = await b('pgCommentPending', A.id, p1);
        assert.deepStrictEqual(r, { ok: true, pending: [{ id: 'a'.repeat(16), ts: 5, text: 'isi' }, { id: 'c'.repeat(16), ts: 6, text: 't' }] }, JSON.stringify(r));
        B.pageCommentPending = () => 'bukan larik'; assert.deepStrictEqual(await b('pgCommentPending', A.id, p1), { ok: true, pending: [] });
      } finally { B.pageCommentQueue = q; B.pageCommentPending = p; }
    }
    ok('penyaringan: hanya st + id / by / ts / text dan pending id / ts / text (tanpa pub / sig / post / jalur), st tak dikenal = queued, bukan larik = kosong');

    // ---- 5. preload.js sungguhan memuat tiga kanal ----
    {
      const src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
      for (const n of ['pgCommentQueue', 'pgCommentPending', 'pgCommentCancel']) assert(new RegExp("^\\s{2}" + n + ": .*ipcRenderer\\.invoke\\('" + n + "'", 'm').test(src), 'preload: ' + n);
    }
    ok('preload.js: tiga kanal diteruskan ke ipcRenderer.invoke dengan nama yang sama');

    // ---- 6. event pgcq ke renderer (4c-2 fase 2) ----
    {
      const cq = (f) => f.sent.filter(([ch]) => ch === 'pgcq').map(([, p]) => p);
      // sukses nyata: komentar yang diantrekan terkirim -> satu event sent
      b.sent.length = 0;
      r = await b('pgCommentQueue', A.id, p1, 'untuk event'); assert(r.ok && r.queued); const cid = r.queued.c.id;
      await until(() => cq(b).some((e) => e.id === cid), 8000, 'event sent');
      let ev = cq(b).filter((e) => e.id === cid); assert.strictEqual(ev.length, 1, 'tepat satu event per komentar');
      assert.deepStrictEqual(ev[0], { ev: 'sent', peerId: A.id, postId: p1, id: cid, why: 'added' }, JSON.stringify(ev[0]));
      assert.deepStrictEqual(Object.keys(ev[0]).sort(), ['ev', 'id', 'peerId', 'postId', 'why'], 'hanya lima bidang, tanpa teks');
      assert.strictEqual(cq(a).length, 0, 'event milik B tidak muncul di jembatan A');
      // drop nyata: postingan tidak ada di pemilik -> drop gone
      b.sent.length = 0;
      r = await b('pgCommentQueue', A.id, NONE, 'ke postingan hilang'); assert(r.ok && r.queued); const gid = r.queued.c.id;
      await until(() => cq(b).some((e) => e.id === gid), 8000, 'event drop');
      ev = cq(b).filter((e) => e.id === gid); assert.deepStrictEqual(ev, [{ ev: 'drop', peerId: A.id, postId: NONE, id: gid, why: 'gone' }], JSON.stringify(ev));
      assert.deepStrictEqual(await b('pgCommentPending', A.id, NONE), { ok: true, pending: [] }, 'yang di-drop hilang dari pending');
      // penyaringan: event cacat tidak disiarkan, why tak dikenal = '', bidang liar dibuang
      b.sent.length = 0; const H = 'c'.repeat(16);
      B.emit('pgcq', { ev: 'aneh', peer: A.id, post: p1, id: H, why: 'gone' }); B.emit('pgcq', { ev: 'sent', peer: 'zz', post: p1, id: H, why: 'added' });
      B.emit('pgcq', { ev: 'sent', peer: A.id, post: 5, id: H }); B.emit('pgcq', { ev: 'sent', peer: A.id, post: p1, id: null }); B.emit('pgcq', null); B.emit('pgcq', 'x');
      assert.strictEqual(cq(b).length, 0, 'event cacat tidak diteruskan: ' + JSON.stringify(cq(b)));
      B.emit('pgcq', { ev: 'drop', peer: A.id, post: p1, id: H, why: '/jalur/rahasia', text: 'isi', c: { sig: 'S' }, tries: 3 });
      assert.deepStrictEqual(cq(b), [{ ev: 'drop', peerId: A.id, postId: p1, id: H, why: '' }], 'why tak dikenal = kosong, bidang liar dibuang');
      for (const why of ['added', 'same', 'gone', 'full', 'bad', 'old', 'self', 'expired', 'gave']) { b.sent.length = 0; B.emit('pgcq', { ev: 'drop', peer: A.id, post: p1, id: H, why }); assert.strictEqual(cq(b)[0].why, why, 'why dikenal diteruskan: ' + why); }
      // toRenderer yang melempar tidak merusak Core; dispose melepas pendengar
      const n0 = B.listenerCount('pgcq'); assert(n0 >= 1); b.reg.dispose(); assert.strictEqual(B.listenerCount('pgcq'), n0 - 1, 'dispose melepas pendengar pgcq');
      b.sent.length = 0; B.emit('pgcq', { ev: 'sent', peer: A.id, post: p1, id: H, why: 'added' }); assert.strictEqual(cq(b).length, 0, 'setelah dispose tidak ada event');
    }
    ok('event pgcq: sent (why added) dan drop (why gone) nyata dari antrean, tepat satu per komentar, lima bidang tanpa teks, event cacat tidak disiarkan, why tak dikenal = kosong, dispose melepas pendengar');

    // ---- 7. preload.js dan archne-api-http.js memuat onPgCq ----
    {
      const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), api = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archne-api-http.js'), 'utf8');
      assert(/^\s{2}onPgCq: .*ipcRenderer\.on\('pgcq'/m.test(pre), 'preload onPgCq'); assert(/addEventListener\('pgcq'/.test(api) && /api\.onPgCq = /.test(api), 'api-http onPgCq');
    }
    ok('preload.js dan archne-api-http.js: onPgCq mendengarkan event pgcq');
  } finally { try { await A.stop(); } catch {} try { await B.stop(); } catch {} }
  console.log('\n' + pass + ' tes OK'); process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

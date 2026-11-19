'use strict';
// Tes 5d-6 (IPC): kanal cadangan halaman (src/archne-ipc-pages.js: pgArcExport, pgArcOpen, pgArcImport, pgArcCancel, pgArcState, event pgarc) lewat src/archne-ipc.js dengan Electron palsu + Core sungguhan.
// Yang dicek: dialog hanya di proses utama (renderer tidak pernah menerima / mengirim jalur), pratinjau tidak menulis, token satu kali pakai, satu pekerjaan sekaligus, pembatalan, komentar mengikuti identitas, galat tanpa jalur lokal.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), crypto = require('crypto');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { ArcReader } = require('../src/archne-pagearc');
const { cmtSign } = require('../src/archne-pagecmt');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagearcipc-'));
let pass = 0; const ok = (s) => { pass++; console.log('  OK  ' + s); };
const out = (n) => path.join(tmp, n);
const mkCore = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false });
const rnd = (n, seed) => { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; } return b; };
const snap = (dir) => { const r = []; (function w(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), s = fs.statSync(f); if (s.isDirectory()) w(f); else r.push(path.relative(dir, f) + ':' + s.size + ':' + s.mtimeMs); } })(dir); return r; };
function ident() {
  const k = crypto.generateKeyPairSync('ed25519'), pub = k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { priv: k.privateKey, pub };
}
function mkIpc(core, deps) {
  const h = {}, sent = [];
  const ipc = register({ ipcMain: { handle: (n, fn) => { h[n] = fn; } }, core, send: (ch, p) => sent.push([ch, p]), log: () => {}, ...deps });
  return { call: (n, ...a) => h[n]({}, ...a), sent, ipc, ev: () => sent.filter((x) => x[0] === 'pgarc').map((x) => x[1]) };
}
async function final(I, job) { // tunggu event akhir pekerjaan
  for (let i = 0; i < 4000; i++) { const e = I.ev().find((x) => x.job === job && x.phase !== 'progress'); if (e) return e; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('event akhir tidak datang');
}
const noPath = (o) => assert(!JSON.stringify(o).includes(tmp) && !/[\\/]archne-pagearcipc/.test(JSON.stringify(o)), 'tanpa jalur lokal: ' + JSON.stringify(o).slice(0, 200));

(async () => {
  const A = mkCore('A'), B = mkCore('B'); await A.start(); await B.start();
  let pickSaveTo = '', pickArcTo = '';
  const deps = { pickSave: async () => pickSaveTo, pickArc: async () => pickArcTo };
  const IA = mkIpc(A, deps), IB = mkIpc(B, deps), IN = mkIpc(B, {});
  try {
    const ps = A.pageStore(), U = ident();
    const f1 = (await ps.addFiles([{ src: (() => { const f = out('l.bin'); fs.writeFileSync(f, rnd(300000, 5)); return f; })() }]))[0];
    const p1 = ps.create({ text: 'satu', files: [f1] }), p2 = ps.create({ text: 'dua' }), p3 = ps.create({ text: 'tiga' });
    const c1 = cmtSign(U.priv, U.pub, A.id, p1.id, 'komentar', Date.now() - 1000), c2 = cmtSign(U.priv, U.pub, A.id, p2.id, 'lagi', Date.now() - 500);
    ps.cmt.add(c1); ps.cmt.add(c2);

    // 1. ketersediaan: canArchive mengikuti dialog; tanpa dialog = nodialog; masukan cacat = bad
    {
      assert.strictEqual((await IA.call('getSettings')).canArchive, true); assert.strictEqual((await IN.call('getSettings')).canArchive, false);
      for (const n of ['pgArcExport', 'pgArcOpen']) { const r = await IN.call(n); assert.deepStrictEqual([r.ok, r.code], [false, 'nodialog'], n); }
      for (const o of ['x', 7, [], { comments: 1 }, { comments: 'ya' }]) assert.strictEqual((await IA.call('pgArcExport', o)).code, 'bad', JSON.stringify(o));
      for (const t of [null, 5, 'zz', 'x'.repeat(16)]) assert(['bad', 'gone'].includes((await IA.call('pgArcImport', t)).code), String(t));
      assert.strictEqual((await IA.call('pgArcImport', 'a'.repeat(16), { comments: 'x' })).code, 'bad');
      assert.strictEqual((await IA.call('pgArcImport', 'a'.repeat(16))).code, 'gone', 'token tak dikenal');
      assert.strictEqual((await IA.call('pgArcCancel', 5)).code, 'bad'); assert.deepStrictEqual(await IA.call('pgArcCancel', 'a'.repeat(16)), { ok: true, cancelled: false });
      assert.deepStrictEqual(await IA.call('pgArcState'), { ok: true, run: null });
    }
    ok('canArchive mengikuti dialog; tanpa dialog nodialog; masukan cacat bad; token / job tak dikenal tak berbahaya');

    // 2. ekspor: dibatalkan di dialog = tanpa pekerjaan; ekstensi ditambah; hasil hanya angka dan nama; komentar hanya bila dicentang
    {
      pickSaveTo = ''; assert.deepStrictEqual(await IA.call('pgArcExport', {}), { ok: true, job: null });
      pickSaveTo = out('cadangan'); // tanpa ekstensi
      const r = await IA.call('pgArcExport'); assert(r.ok && /^[0-9a-f]{16}$/.test(r.job) && r.name === 'cadangan.archpg', JSON.stringify(r)); noPath(r);
      const st = await IA.call('pgArcState'); assert(st.run === null || st.run.job === r.job, 'state: pekerjaan ini atau sudah selesai');
      const e = await final(IA, r.job);
      assert.deepStrictEqual([e.kind, e.phase], ['export', 'done']); noPath(e);
      assert.deepStrictEqual(Object.keys(e).sort(), ['job', 'kind', 'phase', 'result']);
      assert.deepStrictEqual([e.result.posts, e.result.files, e.result.skipped, e.result.comments, e.result.name], [3, 1, 0, null, 'cadangan.archpg']);
      assert(fs.existsSync(out('cadangan.archpg')) && !fs.existsSync(out('cadangan.archpg.tmp')));
      let rd = await ArcReader.open(out('cadangan.archpg')); assert(!rd.has('comments')); await rd.close();
      for (const x of IA.ev().filter((y) => y.phase === 'progress')) { assert.deepStrictEqual(Object.keys(x).sort(), ['bytes', 'job', 'kind', 'phase', 'posts', 'total', 'totalBytes']); assert(x.bytes <= x.totalBytes); }
      pickSaveTo = out('dgn-komentar.archpg');
      const r2 = await IA.call('pgArcExport', { comments: true }), e2 = await final(IA, r2.job);
      assert.deepStrictEqual([e2.phase, e2.result.comments], ['done', { items: 2, tombs: 0 }]);
      rd = await ArcReader.open(out('dgn-komentar.archpg')); assert(rd.has('comments')); await rd.close();
      assert.strictEqual(await IA.call('pgArcState').then((x) => x.run), null, 'selesai: tak ada pekerjaan');
    }
    ok('ekspor: dialog batal = tanpa pekerjaan, ekstensi ditambah, hasil hanya angka + nama, komentar hanya bila dicentang');

    // 3. satu pekerjaan sekaligus; pembatalan: tak ada berkas tujuan dan tak ada sisa
    {
      const big = out('besar.bin'); fs.writeFileSync(big, rnd(40 * 1024 * 1024, 9));
      const [fb] = await ps.addFiles([{ src: big }]); ps.create({ text: 'besar', files: [fb] });
      pickSaveTo = out('batal.archpg');
      const r = await IA.call('pgArcExport');
      assert.strictEqual((await IA.call('pgArcExport')).code, 'busy'); assert.strictEqual((await IA.call('pgArcOpen')).code, 'busy');
      assert.strictEqual((await IA.call('pgArcImport', 'a'.repeat(16))).code, 'busy');
      assert.deepStrictEqual(await IA.call('pgArcCancel', r.job), { ok: true, cancelled: true });
      const e = await final(IA, r.job); assert.strictEqual(e.phase, 'cancel');
      assert(!fs.existsSync(out('batal.archpg')) && !fs.existsSync(out('batal.archpg.tmp')), 'tak ada sisa');
      assert.deepStrictEqual(await IA.call('pgArcCancel', r.job), { ok: true, cancelled: false }, 'sudah selesai');
      pickSaveTo = out('lagi.archpg'); const r2 = await IA.call('pgArcExport'); assert.strictEqual((await final(IA, r2.job)).phase, 'done', 'bisa mulai lagi sesudahnya');
      ps.remove(ps.list({ limit: 1 }).items[0].id); // buang postingan besar
    }
    ok('satu pekerjaan sekaligus (busy), batal bersih tanpa sisa, bisa mulai lagi');

    // 4. impor ke identitas BEDA: pratinjau tanpa tulis, token satu kali pakai, komentar tidak dibawa, hasil tanpa jalur
    {
      const pb = B.pageStore(), dir = pb.dir, before = snap(dir);
      pickArcTo = out('dgn-komentar.archpg');
      const o = await IB.call('pgArcOpen');
      assert(o.ok && /^[0-9a-f]{16}$/.test(o.token) && o.name === 'dgn-komentar.archpg'); noPath(o);
      const s = o.summary;
      assert.deepStrictEqual([s.counts.total, s.counts.new, s.counts.same, s.ownerMatch], [3, 3, 0, false]);
      assert.deepStrictEqual([s.comments.present, s.comments.restorable, s.comments.items, s.comments.plan], [true, false, 2, null]);
      assert.deepStrictEqual(snap(dir), before, 'pratinjau tidak menulis apa pun');
      assert.strictEqual(pb.list({ limit: 50 }).items.length, 0);
      const g = await IB.call('pgArcImport', o.token, { comments: true });
      assert(g.ok && /^[0-9a-f]{16}$/.test(g.job)); noPath(g);
      const e = await final(IB, g.job);
      assert.deepStrictEqual([e.kind, e.phase, e.result.imported, e.result.same, e.result.aborted], ['import', 'done', 3, 0, false]); noPath(e);
      assert.deepStrictEqual([e.result.comments.status, e.result.comments.why, e.result.comments.items], ['skipped', 'owner', 2]);
      assert.strictEqual(pb.list({ limit: 50 }).items.length, 3); assert.strictEqual(pb.cmt.total, 0);
      assert.strictEqual((await IB.call('pgArcImport', o.token)).code, 'gone', 'token sudah dipakai');
      // impor ulang: semua sudah ada
      const o2 = await IB.call('pgArcOpen'); assert.deepStrictEqual([o2.summary.counts.new, o2.summary.counts.same], [0, 3]);
      const e2 = await final(IB, (await IB.call('pgArcImport', o2.token)).job); assert.deepStrictEqual([e2.result.imported, e2.result.same], [0, 3]);
    }
    ok('identitas beda: pratinjau tanpa tulis, impor sukses, komentar tidak dibawa, token satu kali pakai, ulang = semua sudah ada');

    // 5. identitas SAMA lewat IPC: komentar dipulihkan; opsi comments:false menundanya
    {
      pickArcTo = out('dgn-komentar.archpg');
      const ids = ps.list({ limit: 50 }).items.map((p) => p.id), had = ids.length;
      for (const id of ids) ps.remove(id); assert.strictEqual(ps.cmt.total, 0);
      let o = await IA.call('pgArcOpen'); assert.deepStrictEqual([o.summary.counts.new, o.summary.ownerMatch, o.summary.comments.restorable, o.summary.comments.plan.added], [3, true, true, 2]);
      let e = await final(IA, (await IA.call('pgArcImport', o.token, { comments: false })).job);
      assert.deepStrictEqual([e.result.imported, e.result.comments.status, e.result.comments.why], [3, 'skipped', 'off']); assert.strictEqual(ps.cmt.total, 0);
      o = await IA.call('pgArcOpen'); assert.deepStrictEqual([o.summary.counts.new, o.summary.counts.same, o.summary.comments.plan.added], [0, 3, 2], 'komentar masih menunggu');
      e = await final(IA, (await IA.call('pgArcImport', o.token, { comments: true })).job);
      assert.deepStrictEqual([e.result.imported, e.result.same, e.result.comments.status, e.result.comments.added], [0, 3, 'done', 2]);
      assert.strictEqual(ps.cmt.count(p1.id), 1); assert.strictEqual(ps.cmt.count(p2.id), 1);
      assert.strictEqual(ps.list({ limit: 50 }).items.length, had);
    }
    ok('identitas sama: komentar menunggu bila dimatikan, dipulihkan pada impor berikutnya');

    // 6. berkas buruk / hilang: galat tanpa jalur lokal
    {
      fs.writeFileSync(out('sampah.archpg'), rnd(500, 3));
      pickArcTo = out('sampah.archpg'); let r = await IA.call('pgArcOpen'); assert(!r.ok && r.code === 'bad'); noPath(r);
      pickArcTo = out('tidak-ada.archpg'); r = await IA.call('pgArcOpen'); assert(!r.ok && r.err === 'Failed to read or write the archive file' && /^[A-Z0-9_]{2,20}$/.test(r.code)); noPath(r);
      pickArcTo = 'relatif/arsip.archpg'; r = await IA.call('pgArcOpen'); assert(!r.ok && r.code === 'bad');
      pickSaveTo = path.join(tmp, 'tidak', 'ada', 'folder', 'x.archpg'); const x = await IA.call('pgArcExport'); const e = await final(IA, x.job);
      assert.strictEqual(e.phase, 'error'); noPath(e); assert.strictEqual(e.err, 'Failed to read or write the archive file');
      assert.deepStrictEqual(await IA.call('pgArcState'), { ok: true, run: null }, 'galat melepas pekerjaan');
    }
    ok('berkas buruk, hilang, jalur relatif, tujuan tak bisa ditulis: galat jelas tanpa jalur lokal, pekerjaan dilepas');

    // 7. dispose menghentikan pekerjaan yang berjalan
    {
      pickSaveTo = out('dispose.archpg'); const big = ps.list({ limit: 1 }).items;
      const r = await IA.call('pgArcExport'); IA.ipc.dispose();
      const e = await final(IA, r.job); assert(['cancel', 'done'].includes(e.phase));
    }
    ok('dispose menghentikan pekerjaan yang berjalan');
    console.log('\n' + pass + ' kelompok tes lulus');
  } finally { try { await A.stop(); await B.stop(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });

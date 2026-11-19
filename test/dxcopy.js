'use strict';
// Tes Kirim Langsung dari HP (salinan sementara): /dxupload menyalin berkas ke <dataDir>/dxout/<job>/<acak>/<nama>, dxSend menawarkannya,
// dan salinan dihapus saat sesi selesai / ditolak / dibatalkan / gagal ditawarkan, atau yatim saat start. Hanya aktif bila canDirectCopy.
const os = require('os'), path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const { startHeadless } = require('../src/archne-headless');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-dxcopy-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(10); } throw new Error('timeout: ' + label); }
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
function req(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString() })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const left = (root) => { const out = []; (function w(d) { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const p = path.join(d, x.name); if (x.isDirectory()) w(p); else out.push(p); } })(root); return out; };

(async () => {
  const app = await startHeadless({ dataDir: path.join(tmp, 'A'), downloadDir: path.join(tmp, 'A-dl'), name: 'HP', canDirectCopy: true });
  const A = app.core, port = app.rpc.port, SP = '/s/' + app.rpc.token + '/';
  const B = new Core({ dataDir: path.join(tmp, 'B'), downloadDir: path.join(tmp, 'B-dl'), name: 'PC', discovery: false, tickMs: 100, syncMs: 150 });
  await B.start(); await A.addPeer('127.0.0.1', B.port); await B.addPeer('127.0.0.1', A.port);
  await until(() => A.isOnline(A.peers.get(B.id)) && B.isOnline(B.peers.get(A.id)), 4000, 'peer online');
  const JSONH = { 'content-type': 'application/json' }, BIN = { 'content-type': 'application/octet-stream' };
  const up = async (job, name, data) => { const r = await req(port, 'POST', SP + 'dxupload?job=' + job + '&name=' + encodeURIComponent(name), { headers: BIN, body: data }); return { status: r.status, path: r.status === 200 ? JSON.parse(r.body).path : null }; };
  const rpc = async (name, ...a) => JSON.parse((await req(port, 'POST', SP + 'rpc/' + name, { headers: JSONH, body: JSON.stringify(a) })).body);
  const root = A._dxTmpRoot();

  // ---- 1. state + unggah ----
  const stt = await rpc('state');
  assert(stt.canDirectCopy === true && !stt.canDirect, 'state: canDirectCopy menyala, canDirect (pemilih berpath) tetap mati');
  const u1 = await up('jobA1', 'foto asli.jpg', Buffer.from('isi-satu'));
  assert.strictEqual(u1.status, 200); assert(A._dxIsTmp(u1.path) && path.basename(u1.path) === 'foto asli.jpg', 'nama asli dipertahankan (penerima melihat nama ini)');
  assert.strictEqual(fs.readFileSync(u1.path, 'utf8'), 'isi-satu');
  assert.strictEqual((await req(port, 'POST', SP + 'dxupload?job=../x&name=a', { headers: BIN, body: 'x' })).status, 400, 'job tak sah ditolak');
  assert.strictEqual((await req(port, 'POST', SP + 'dxupload?job=jobA1&name=a', { headers: JSONH, body: 'x' })).status, 415);
  const nameTrick = await up('jobA1', '../../lolos.txt', Buffer.from('x')); assert(A._dxIsTmp(nameTrick.path) && !fs.existsSync(path.join(tmp, 'lolos.txt')) && !fs.existsSync(path.join(path.dirname(root), 'lolos.txt')), 'nama berisi ../ tidak lolos dari dxout');
  ok('state canDirectCopy; /dxupload menyimpan di dxout/<job>/<acak>/<nama asli>; job/tipe/nama jahat ditolak atau dibersihkan');

  // ---- 2. kirim -> terima -> salinan dihapus ----
  const u2 = await up('jobB', 'laporan.txt', Buffer.from('halo dari HP'));
  const sendRes = await rpc('dxSend', 'jobB', B.id, [u2.path]);
  assert(sendRes.ok, JSON.stringify(sendRes));
  assert(fs.existsSync(u2.path), 'selama belum selesai, salinan ada (penerima menariknya dari sini)');
  await until(() => B.directState().in.some((x) => x.id === sendRes.id), 3000, 'tawaran sampai');
  await B.directAccept(sendRes.id);
  await until(() => (B.directState().in.find((x) => x.id === sendRes.id) || {}).state === 'done', 15000, 'selesai');
  assert.strictEqual(fs.readFileSync(path.join(B._directDir(), 'laporan.txt'), 'utf8'), 'halo dari HP');
  await until(() => !fs.existsSync(u2.path), 3000, 'salinan dihapus setelah selesai');
  assert(!fs.existsSync(path.dirname(u2.path)) && !fs.existsSync(path.join(root, 'jobB')), 'folder acak dan folder job ikut dibersihkan');
  ok('kirim dari salinan: penerima menerima isi yang sama dan salinan (beserta foldernya) dihapus begitu selesai');

  // ---- 3. ditolak penerima ----
  const u3 = await up('jobC', 'tolak.bin', Buffer.from('x'.repeat(1000)));
  const r3 = await rpc('dxSend', 'jobC', B.id, [u3.path]); assert(r3.ok);
  await until(() => B.directState().in.some((x) => x.id === r3.id), 3000);
  await B.directDecline(r3.id);
  await until(() => !fs.existsSync(u3.path), 3000, 'dihapus setelah ditolak');
  ok('ditolak penerima: salinan dihapus');

  // ---- 4. dibatalkan pengirim ----
  const u4 = await up('jobD', 'batal.bin', Buffer.from('y'.repeat(1000)));
  const r4 = await rpc('dxSend', 'jobD', B.id, [u4.path]); assert(r4.ok);
  await A.directCancelOut(r4.id);
  assert(!fs.existsSync(u4.path), 'dibatalkan pengirim: salinan dihapus');
  ok('dibatalkan pengirim: salinan dihapus');

  // ---- 5. gagal ditawarkan (peer offline/diblokir): salinan dihapus ----
  const u5 = await up('jobE', 'gagal.bin', Buffer.from('z'));
  const r5 = await rpc('dxSend', 'jobE', 'f'.repeat(16), [u5.path]);
  assert(r5.ok === false && !fs.existsSync(u5.path), 'tawaran gagal: salinan dihapus');
  ok('tawaran gagal: salinan dihapus');

  // ---- 6. batal saat masih menyalin: dxCancelScan membuang folder job ----
  const u6 = await up('jobF', 'setengah.bin', Buffer.from('q'));
  assert(fs.existsSync(u6.path));
  assert.strictEqual(await rpc('dxCancelScan', 'jobF'), false);
  await until(() => !fs.existsSync(path.join(root, 'jobF')), 3000, 'folder job dibuang');
  // job yang SUDAH punya sesi tidak boleh ikut terhapus (dxCancelScan hanya membuang saat belum terdaftar)
  ok('batal saat menyalin: salinan job dibuang');

  // ---- 7. start ulang: salinan yatim dibuang, yang dirujuk sesi aktif dipertahankan ----
  const keep = await up('jobG', 'masih.bin', Buffer.from('k'.repeat(500)));
  const rk = await rpc('dxSend', 'jobG', B.id, [keep.path]); assert(rk.ok);
  const orphan = await up('jobH', 'yatim.bin', Buffer.from('o'));
  await app.stop();
  assert(fs.existsSync(orphan.path) && fs.existsSync(keep.path));
  const app2 = await startHeadless({ dataDir: path.join(tmp, 'A'), downloadDir: path.join(tmp, 'A-dl'), name: 'HP', canDirectCopy: true });
  assert(!fs.existsSync(orphan.path), 'yatim dibuang saat start');
  assert(fs.existsSync(keep.path), 'salinan yang masih dirujuk sesi aktif tidak disentuh');
  await app2.stop();
  ok('start ulang: salinan yatim dibuang, yang dipakai sesi aktif tetap');

  // ---- 8. tanpa canDirectCopy: endpoint tidak ada ----
  const plain = await startHeadless({ dataDir: path.join(tmp, 'P'), downloadDir: path.join(tmp, 'P-dl'), name: 'PC' });
  const rp = await req(plain.rpc.port, 'POST', '/s/' + plain.rpc.token + '/dxupload?job=j&name=a', { headers: BIN, body: 'x' });
  assert.notStrictEqual(rp.status, 200, 'PC/Termux tanpa canDirectCopy tidak membuka /dxupload');
  const sp = JSON.parse((await req(plain.rpc.port, 'POST', '/s/' + plain.rpc.token + '/rpc/state', { headers: JSONH, body: '[]' })).body);
  assert(!sp.canDirectCopy, 'state tanpa canDirectCopy');
  await plain.stop();
  ok('tanpa canDirectCopy: /dxupload tidak tersedia dan state tidak menawarkannya');

  await B.stop();
  console.log('\n' + pass + ' tes salinan sementara lulus');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

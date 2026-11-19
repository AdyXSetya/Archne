'use strict';
// Tes jembatan IPC Kirim Langsung (v0.24.0, step 2a): src/archne-ipc-direct.js dengan Electron palsu + dua Core sungguhan.
// Yang dicek: validasi masukan, kirim lewat dxSend -> tawaran muncul di penerima -> dxAccept -> selesai (isi sama),
// dialog folder hanya dari proses utama, batalkan pemindaian, tolak, hapus catatan, buka folder lewat id, event dxprog.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-dxipc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(20); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 });
const f = (...n) => path.join(tmp, ...n);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function fake(core, extra) {
  const handlers = {}, sent = [], shellCalls = [];
  const ipcMain = { handle: (n, fn) => { handlers[n] = fn; } };
  const shell = { showItemInFolder: (p) => shellCalls.push(['show', p]), openPath: async (p) => { shellCalls.push(['open', p]); return ''; } };
  const api = register(Object.assign({ ipcMain, core, shell, send: (ch, p) => sent.push([ch, p]), log: () => {} }, extra));
  return { handlers, sent, shellCalls, api, call: (n, ...a) => handlers[n]({}, ...a) };
}

(async () => {
  const A = mk('A'), B = mk('B');
  const picked = { dir: f('pilihan-dir'), calls: 0 };
  const ua = fake(A, { pickItems: async (k) => (k === 'folder' ? [f('src', 'Folder')] : [f('src', 'satu.txt'), 42, 'relatif.txt']) });
  const ub = fake(B, { pickDir: async () => { picked.calls++; return picked.dir; } });
  await A.start(); await B.start();
  await A.addPeer('127.0.0.1', B.port); await B.addPeer('127.0.0.1', A.port);
  await until(() => A.isOnline(A.peers.get(B.id)) && B.isOnline(B.peers.get(A.id)), 5000, 'online');

  fs.mkdirSync(f('src', 'Folder', 'sub'), { recursive: true });
  fs.writeFileSync(f('src', 'satu.txt'), 'isi satu');
  fs.writeFileSync(f('src', 'Folder', 'sub', 'x.bin'), crypto.randomBytes(200000));
  fs.writeFileSync(f('src', 'Folder', 'y.txt'), 'y');

  // ---- 1. semua kanal terdaftar ----
  for (const n of ['dxState', 'dxPick', 'dxSend', 'dxCancelScan', 'dxAccept', 'dxDecline', 'dxPause', 'dxResume', 'dxCancel', 'dxCancelOut', 'dxRemove', 'dxChooseDir', 'dxOpenDir']) assert.strictEqual(typeof ua.handlers[n], 'function', n);
  const s0 = await ua.call('dxState');
  assert(s0 && Array.isArray(s0.in) && Array.isArray(s0.out) && typeof s0.dir === 'string');
  ok('13 kanal terdaftar; dxState mengembalikan { dir, in, out }');

  // ---- 2. dxPick menyaring hasil dialog ----
  assert.deepStrictEqual(await ua.call('dxPick', 'files'), [f('src', 'satu.txt')]);
  assert.deepStrictEqual(await ua.call('dxPick', 'folder'), [f('src', 'Folder')]);
  assert.deepStrictEqual(await ub.call('dxPick', 'files'), [], 'tanpa pickItems -> kosong');
  ok('dxPick: hanya string absolut yang lolos; tanpa dialog -> larik kosong');

  // ---- 3. validasi dxSend ----
  const R = (r) => r && r.ok === false;
  assert(R(await ua.call('dxSend', 'bad job!', B.id, [f('src', 'satu.txt')])));
  assert(R(await ua.call('dxSend', 'j1', '', [f('src', 'satu.txt')])));
  assert(R(await ua.call('dxSend', 'j1', B.id, [])));
  assert(R(await ua.call('dxSend', 'j1', B.id, 'bukan-larik')));
  assert(R(await ua.call('dxSend', 'j1', B.id, ['relatif.txt'])), 'path relatif ditolak');
  assert(R(await ua.call('dxSend', 'j1', B.id, [f('src', 'satu.txt'), 7])));
  assert(R(await ua.call('dxSend', 'j1', B.id, Array(1001).fill(f('src', 'satu.txt')))));
  const nope = await ua.call('dxSend', 'j1', 'ffffffffffffffff', [f('src', 'satu.txt')]);
  assert(R(nope) && nope.code === 'peer', 'peer tak dikenal');
  assert.strictEqual(A._dxOut.size, 0, 'tidak ada sesi tersisa dari masukan buruk');
  ok('dxSend menolak id job buruk, tujuan kosong, larik kosong/terlalu besar, path relatif, peer asing');

  // ---- 4. kirim folder + berkas -> terima (folder bawaan) ----
  const r1 = await ua.call('dxSend', 'job-1', B.id, [f('src', 'Folder'), f('src', 'satu.txt')]);
  assert(r1.ok && /^[0-9a-f]{32}$/.test(r1.id), JSON.stringify(r1));
  assert.strictEqual(ua.api.direct.jobs.size, 0, 'job dibersihkan setelah selesai');
  await until(async () => (await ub.call('dxState')).in.some((x) => x.id === r1.id && x.state === 'offered'), 5000, 'tawaran tiba');
  const acc = await ub.call('dxAccept', r1.id);
  assert(acc.ok, JSON.stringify(acc));
  assert.strictEqual(picked.calls, 0, 'tanpa choose, dialog folder tidak dibuka');
  await until(async () => (await ub.call('dxState')).in.find((x) => x.id === r1.id).state === 'done', 15000, 'selesai');
  const inb = (await ub.call('dxState')).in.find((x) => x.id === r1.id);
  const dest = path.join(B._directDir(), 'Folder');
  assert.strictEqual(sha(path.join(dest, 'sub', 'x.bin')), sha(f('src', 'Folder', 'sub', 'x.bin')));
  assert.strictEqual(fs.readFileSync(path.join(B._directDir(), 'satu.txt'), 'utf8'), 'isi satu');
  assert(ub.sent.some(([ch, p]) => ch === 'dxprog' && p.id === r1.id && p.dir === 'in'), 'event dxprog sampai ke renderer penerima');
  await until(() => ua.sent.some(([ch, p]) => ch === 'dxprog' && p.id === r1.id && p.dir === 'out'), 5000, 'event dxprog sampai ke renderer pengirim'); // dx_done tiba di pengirim sedikit setelah penerima selesai
  ok('dxSend -> dxAccept -> selesai, isi identik; dxprog mengalir di kedua sisi');

  // ---- 5. buka folder hasil lewat id (path dari Core) ----
  const od = await ub.call('dxOpenDir', r1.id);
  assert(od.ok);
  assert.deepStrictEqual(ub.shellCalls[ub.shellCalls.length - 1], ['open', inb.dir]);
  assert(R(await ub.call('dxOpenDir', 'zzz')), 'id buruk ditolak');
  assert(R(await ub.call('dxOpenDir', 'a'.repeat(32))), 'sesi tak ada');
  const od2 = await ub.call('dxOpenDir');
  assert(od2.ok && ub.shellCalls[ub.shellCalls.length - 1][1] === B._directDir());
  ok('dxOpenDir: folder dari catatan Core; id buruk/tidak ada ditolak; tanpa id -> folder bawaan');

  // ---- 6. dxAccept dengan choose -> folder dari dialog proses utama ----
  const r2 = await ua.call('dxSend', 'job-2', B.id, [f('src', 'Folder', 'y.txt')]);
  await until(async () => (await ub.call('dxState')).in.some((x) => x.id === r2.id && x.state === 'offered'), 5000, 'tawaran 2');
  assert(R(await ua.call('dxAccept', r2.id, true)), 'tanpa pickDir -> gagal, bukan menulis ke mana-mana');
  const acc2 = await ub.call('dxAccept', r2.id, true);
  assert(acc2.ok && picked.calls === 1);
  await until(async () => (await ub.call('dxState')).in.find((x) => x.id === r2.id).state === 'done', 10000, 'selesai 2');
  assert.strictEqual(fs.readFileSync(path.join(picked.dir, 'y.txt'), 'utf8'), 'y');
  ok('dxAccept(choose): tujuan hanya dari dialog proses utama; tanpa dialog tidak ada tebakan');

  // ---- 7. dialog folder dibatalkan -> tawaran tetap menunggu ----
  const r3 = await ua.call('dxSend', 'job-3', B.id, [f('src', 'satu.txt')]);
  await until(async () => (await ub.call('dxState')).in.some((x) => x.id === r3.id && x.state === 'offered'), 5000, 'tawaran 3');
  const ub2 = fake(B, { pickDir: async () => '' });
  const cn = await ub2.call('dxAccept', r3.id, true);
  assert(R(cn) && cn.code === 'abort');
  assert.strictEqual((await ub.call('dxState')).in.find((x) => x.id === r3.id).state, 'offered', 'masih menunggu keputusan');
  ok('dialog folder dibatalkan -> tawaran tetap "offered"');

  // ---- 8. tolak + hapus catatan + id buruk ----
  assert.deepStrictEqual(await ub.call('dxDecline', r3.id), { ok: true });
  await until(() => A._dxOut.get(r3.id) && A._dxOut.get(r3.id).state === 'declined', 5000, 'pengirim tahu ditolak');
  for (const n of ['dxDecline', 'dxPause', 'dxResume', 'dxCancel', 'dxCancelOut', 'dxRemove', 'dxAccept']) assert(R(await ub.call(n, '../../etc')), n + ' id buruk');
  assert.deepStrictEqual(await ua.call('dxRemove', r3.id), { ok: true });
  assert.strictEqual(A._dxOut.has(r3.id), false);
  ok('dxDecline -> pengirim melihat "declined"; semua kanal ber-id menolak id buruk; dxRemove menghapus catatan');

  // ---- 9. batalkan pemindaian ----
  const big = f('src', 'Banyak'); fs.mkdirSync(big, { recursive: true });
  for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(big, 'f' + i + '.txt'), 'x');
  const pr = ua.call('dxSend', 'job-big', B.id, [big]);
  assert.strictEqual(await ua.call('dxCancelScan', 'tidak-ada'), false);
  assert.strictEqual(await ua.call('dxCancelScan', 'job-big'), true);
  const rc = await pr;
  assert(R(rc) && rc.code === 'abort', JSON.stringify(rc));
  assert.strictEqual(ua.api.direct.jobs.size, 0);
  assert.strictEqual([...A._dxOut.values()].filter((s) => s.name === 'Banyak').length, 0, 'tidak ada tawaran terkirim');
  ok('dxCancelScan membatalkan pemindaian; tidak ada tawaran yang bocor ke penerima');

  // ---- 10. pengiriman keluar dibatalkan pengirim ----
  const r4 = await ua.call('dxSend', 'job-4', B.id, [f('src', 'satu.txt')]);
  assert(r4.ok);
  assert.deepStrictEqual(await ua.call('dxCancelOut', r4.id), { ok: true });
  assert.strictEqual(A._dxOut.has(r4.id), false);
  ok('dxCancelOut membatalkan tawaran keluar');

  // ---- 11. dispose menghentikan pekerjaan ----
  assert.doesNotThrow(() => ua.api.dispose());
  ok('dispose() aman');


  // ---- 12. (2c) state: penanda LAN per peer + canDirect ----
  const stA = await ua.call('state'), stB = await ub.call('state');
  assert.strictEqual(stA.peers.find((p) => p.id === B.id).lan, true, 'peer loopback = LAN');
  assert.strictEqual(stA.canDirect, true, 'ada pickItems -> canDirect');
  assert.strictEqual(stB.canDirect, false, 'tanpa pickItems (mis. Android) -> canDirect false');
  A.peers.get(B.id).ip = '8.8.8.8';
  assert.strictEqual((await ua.call('state')).peers.find((p) => p.id === B.id).lan, false, 'IP publik bukan LAN');
  A.peers.get(B.id).ip = 'rtc:' + B.id;
  assert.strictEqual((await ua.call('state')).peers.find((p) => p.id === B.id).lan, false, 'lewat rtc: bukan LAN');
  A.peers.get(B.id).ip = '127.0.0.1';
  ok('state: peers[].lan mengikuti aturan LAN Core; canDirect hanya bila ada pemilih berpath');

  // ---- 13. (2d) folder terima dari Pengaturan: dialog proses utama, renderer tidak bisa mengirim path ----
  assert.strictEqual(typeof ub.handlers.dxChooseDir, 'function');
  const gs = await ub.call('getSettings');
  assert.strictEqual(gs.ok, true); assert.strictEqual(gs.canDirect, false, 'ub tanpa pickItems'); assert.strictEqual(gs.canPickDir, true);
  assert.deepStrictEqual(gs.direct, { dir: B._directDir(), def: path.join(B._downloadDir(), 'file_transfer'), custom: false });
  const gsa = await ua.call('getSettings'); assert.strictEqual(gsa.canDirect, true); assert.strictEqual(gsa.canPickDir, false, 'ua tanpa pickDir');
  // renderer tidak boleh menetapkan path; hanya null/'default'
  for (const v of ['/tmp/jahat', 'relatif', 42, {}]) { const r = await ub.call('setSettings', { directDir: v }); assert(R(r) && r.code === 'bad' && r.key === 'directDir', 'ditolak: ' + JSON.stringify(v)); }
  assert.strictEqual(B._settings.directDir, undefined);
  assert.strictEqual(R(await ua.call('dxChooseDir')), true); assert.strictEqual((await ua.call('dxChooseDir')).code, 'nodialog');
  // dialog dibatalkan: tidak ada perubahan
  const cancelled = fake(B, { pickDir: async () => '' });
  assert.strictEqual((await cancelled.call('dxChooseDir')).code, 'abort'); assert.strictEqual(B._settings.directDir, undefined);
  // dialog memilih folder: Core menyimpan, dialog dibuka dengan folder sekarang sebagai awal
  const newDir = f('terima-baru'); let startAt = null;
  const chooser = fake(B, { pickDir: async (def) => { startAt = def; return newDir; } });
  const cd = await chooser.call('dxChooseDir');
  assert(cd.ok && cd.direct.dir === newDir && cd.direct.custom === true && cd.canPickDir === true, JSON.stringify(cd));
  assert.strictEqual(startAt, path.join(B._downloadDir(), 'file_transfer')); assert.strictEqual(B._directDir(), newDir); assert((await ub.call('dxState')).dir === newDir);
  // folder tak bisa ditulisi -> galat jelas, pengaturan lama bertahan
  fs.writeFileSync(f('berkas-biasa'), 'x');
  const bad = fake(B, { pickDir: async () => f('berkas-biasa', 'sub') });
  const rb = await bad.call('dxChooseDir'); assert(R(rb) && rb.code === 'dir' && /not writable/.test(rb.err), JSON.stringify(rb)); assert.strictEqual(B._directDir(), newDir);
  // tawaran berikutnya masuk ke folder baru; reset lewat setSettings(null) kembali ke bawaan
  const r5 = await ua.call('dxSend', 'job-5', B.id, [f('src', 'satu.txt')]);
  await until(async () => (await ub.call('dxState')).in.some((x) => x.id === r5.id && x.state === 'offered'), 5000, 'tawaran 5');
  assert((await ub.call('dxAccept', r5.id, false)).ok);
  await until(async () => (await ub.call('dxState')).in.find((x) => x.id === r5.id).state === 'done', 10000, 'selesai 5');
  assert.strictEqual(fs.readFileSync(path.join(newDir, 'satu.txt'), 'utf8'), 'isi satu', 'diterima di folder dari Pengaturan');
  const rs = await ub.call('setSettings', { directDir: null });
  assert(rs.ok && rs.direct.custom === false && B._directDir() === path.join(B._downloadDir(), 'file_transfer'));
  assert.strictEqual((await ub.call('dxState')).in.find((x) => x.id === r5.id).dir, newDir, 'transfer yang sudah selesai tetap mencatat foldernya');
  ok('(2d) getSettings.direct + canDirect/canPickDir; renderer tak bisa menetapkan path; dxChooseDir (batal, tak bisa ditulisi, sukses) dan tawaran berikutnya masuk ke folder baru');

  await A.stop(); await B.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + pass + ' lulus');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

'use strict';
// Tes pembersihan berkas (v0.7.0 tahap 3, langkah 3b): clearChat, batal kirim, grup dihapus, dan sapuan saat aplikasi dibuka.
// Yang dijaga: sisa unduhan (.part/.pk/.out) dan salinan kompres kiriman tidak menumpuk, sedangkan berkas hasil unduhan di folder
// unduhan dan berkas asli pengguna tidak pernah ikut terhapus.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-clean-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 }, o));
const f = (n) => path.join(tmp, n);
const code = (c) => (e) => e && e.code === c;
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
const hex = (n) => crypto.randomBytes(n).toString('hex');
const age = (p, days) => { const t = (Date.now() - days * 864e5) / 1000; fs.utimesSync(p, t, t); };

(async () => {
  const A = mk('A'), B = mk('B');
  await A.start(); await B.start();
  await A.addPeer('127.0.0.1', B.port);
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 4000, 'jaringan');

  let s = 7; const lines = [];
  for (let i = 0; i < 30000; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; lines.push('INFO user=' + (s % 500) + ' GET /api/item/' + (s % 9000) + ' 200\n'); }
  fs.writeFileSync(f('log.txt'), lines.join(''));
  fs.writeFileSync(f('rand.bin'), crypto.randomBytes(3 * 1048576));
  const T0 = 1700000000;
  fs.utimesSync(f('rand.bin'), T0, T0);
  const gotMsg = (c, id) => until(() => c.store.msgs[id], 4000, 'pesan sampai');
  const inDir = (c) => ls(path.join(c.opts.dataDir, 'in'));
  const outDir = (c) => ls(path.join(c.opts.dataDir, 'out'));
  const msgOf = (c, id) => c.getState().messages.find((m) => m.id === id);
  const serve = A._serveFile.bind(A);
  const stall = () => { A._serveFile = (sock, o, ip) => { let n = 0; const w = sock.write.bind(sock); sock.write = (c, ...a) => { n += c.length; return n > 600000 ? false : w(c, ...a); }; return serve(sock, o, ip); }; };
  const unstall = () => { A._serveFile = serve; };

  // ---- 1. clearChat: sisa unduhan di chat itu dibuang, chat lain dan berkas hasil unduhan tidak disentuh ----
  const m1 = await A.sendFile(f('log.txt'), 'public');           // akan diterima penuh dan tersimpan
  await gotMsg(B, m1.id);
  const r1 = await B.receiveFile(m1.id);
  const m2 = await A.sendFile(f('log.txt'), 'public');           // hanya .pk (unduh tanpa unpack)
  await gotMsg(B, m2.id);
  await B.fetchPacked(m2.id);
  const m3 = await A.sendFile(f('rand.bin'), 'public');          // sedang diunduh saat chat dibersihkan
  await gotMsg(B, m3.id);
  const m4 = await A.sendFile(f('log.txt'), B.id);               // DM: chat lain
  await gotMsg(B, m4.id);
  await B.fetchPacked(m4.id);
  stall();
  const dl3 = B.receiveFile(m3.id);
  const part3 = B._inPaths(m3.id).part;
  await until(() => fs.existsSync(part3) && fs.statSync(part3).size >= 500000, 4000, 'sebagian terunduh');
  assert.deepStrictEqual(inDir(B), [m2.id + '.pk', m3.id + '.part', m4.id + '.pk'].sort());
  assert(B.store.got[m1.id] && msgOf(B, m3.id).file.rx);
  B.clearChat('public');
  await assert.rejects(dl3, code('abort'));
  await B.flushCleanup();
  unstall();
  assert.deepStrictEqual(inDir(B), [m4.id + '.pk'], 'hanya sisa DM yang tertinggal');
  assert(!B.store.got[m1.id] && !B._prog[m3.id] && !B.store.got[m3.id]);
  assert(fs.existsSync(r1.path), 'berkas hasil unduhan tidak disentuh');
  assert(!B.getState().messages.some((m) => m.id === m1.id || m.id === m3.id));
  B.clearChat(A.id);
  await B.flushCleanup();
  assert.deepStrictEqual(inDir(B), []);
  assert(fs.existsSync(r1.path));
  ok('clearChat: unduhan yang berjalan dihentikan, .part/.pk chat itu dibuang, chat lain utuh, berkas hasil unduhan tidak disentuh');

  // ---- 2. clearChat di pengirim: salinan kompres dibuang, berkas asli utuh ----
  assert(A.store.files[m1.id].staged && fs.existsSync(A.store.files[m1.id].path));
  const staged1 = A.store.files[m1.id].path;
  assert(outDir(A).length >= 3);
  A.clearChat('public');
  await A.flushCleanup();
  assert(!A.store.files[m1.id] && !A.store.files[m2.id] && !A.store.files[m3.id]);
  assert(!fs.existsSync(staged1));
  assert(A.store.files[m4.id], 'DM tidak ikut dibersihkan');
  assert(fs.existsSync(f('log.txt')) && fs.existsSync(f('rand.bin')), 'berkas asli pengguna utuh');
  A.clearChat(B.id);
  await A.flushCleanup();
  assert.deepStrictEqual(outDir(A), []);
  assert.deepStrictEqual(Object.keys(A.store.files), []);
  ok('clearChat di pengirim: catatan kirim dan salinan kompres (out/) dibuang, berkas asli utuh, chat lain tidak ikut');

  // ---- 3. pengirim membatalkan pesan saat penerima sedang mengunduh ----
  const m5 = await A.sendFile(f('rand.bin'), 'public');
  await gotMsg(B, m5.id);
  stall();
  const dl5 = B.receiveFile(m5.id);
  const part5 = B._inPaths(m5.id).part;
  await until(() => fs.existsSync(part5) && fs.statSync(part5).size >= 500000, 4000, 'sebagian terunduh');
  const gotBefore = ls(B.opts.downloadDir);
  A.deleteMessage(m5.id);
  await until(() => !B.store.msgs[m5.id], 4000, 'B menerima pembatalan');
  await assert.rejects(dl5, (e) => e.code === 'abort' || e.code === 'gone');
  await B.flushCleanup();
  unstall();
  assert.deepStrictEqual(inDir(B), []);
  assert(!B._prog[m5.id] && !B.store.got[m5.id]);
  assert.deepStrictEqual(ls(B.opts.downloadDir), gotBefore);
  ok('batal kirim di tengah unduhan: unduhan berhenti seketika, .part dibuang, tidak ada catatan basi');

  // ---- 4. pesan yang dibatalkan setelah tersimpan: catatan got dibuang, berkas pengguna tetap ----
  const m6 = await A.sendFile(f('log.txt'), 'public');
  await gotMsg(B, m6.id);
  const r6 = await B.receiveFile(m6.id);
  assert(B.store.got[m6.id]);
  A.deleteMessage(m6.id);
  await until(() => !B.store.msgs[m6.id], 4000, 'B menerima pembatalan');
  await B.flushCleanup();
  assert(!B.store.got[m6.id] && fs.existsSync(r6.path));
  ok('batal kirim setelah tersimpan: catatan got dibuang, berkas di folder unduhan tetap ada');

  // ---- 5. grup dihapus dari perangkat (dikeluarkan): sisa unduhan grup dibuang ----
  const gr = A.createGroup('G', [B.id]);
  await until(() => B.getState().groups.length === 1, 4000, 'grup');
  const gk = 'g:' + gr.id;
  const m7 = await A.sendFile(f('log.txt'), gk);
  await gotMsg(B, m7.id);
  await B.fetchPacked(m7.id);
  const m8 = await A.sendFile(f('log.txt'), 'public');            // di luar grup: tidak boleh ikut hilang
  await gotMsg(B, m8.id);
  await B.fetchPacked(m8.id);
  assert.deepStrictEqual(inDir(B), [m7.id + '.pk', m8.id + '.pk'].sort());
  A.removeMember(gr.id, B.id);
  await until(() => B.getState().groups.length === 0, 6000, 'B dikeluarkan');
  await B.flushCleanup();
  assert.deepStrictEqual(inDir(B), [m8.id + '.pk']);
  assert(A.store.files[m7.id]);
  ok('dikeluarkan dari grup: sisa unduhan grup dibuang, unduhan chat lain utuh');

  // ---- 6. sapuan saat aplikasi dibuka ----
  await B.receiveFile(m8.id);                                      // m8 tuntas, .pk hilang, got ada
  const live = await A.sendFile(f('log.txt'), 'public');           // tawaran hidup dengan .pk segar: harus tetap
  await gotMsg(B, live.id);
  await B.fetchPacked(live.id);
  const old = await A.sendFile(f('log.txt'), 'public');            // tawaran hidup dengan .part kedaluwarsa: harus dibuang
  await gotMsg(B, old.id);
  const hid = await A.sendFile(f('log.txt'), 'public');            // tawaran yang chat-nya dibersihkan (mis. aplikasi mati sebelum selesai)
  await gotMsg(B, hid.id);
  B.store.hidden[hid.id] = 1;
  B.store.got['f'.repeat(32)] = { path: path.join(B.opts.downloadDir, 'tidak-ada.bin'), name: 'tidak-ada.bin', ts: 1 }; // pesannya tak ada
  const gone = hex(16), orphan = hex(16), junk = hex(16);
  const inD = path.join(B.opts.dataDir, 'in');
  fs.mkdirSync(inD, { recursive: true });
  const put = (dir, name, data = 'x') => { const p = path.join(dir, name); fs.writeFileSync(p, data); return p; };
  put(inD, old.id + '.part'); age(path.join(inD, old.id + '.part'), 8);
  put(inD, hid.id + '.pk');
  put(inD, orphan + '.pk'); put(inD, orphan + '.part');
  put(inD, live.id + '.out'); put(inD, live.id + '.out.part');
  put(inD, 'catatan.txt');                                          // bukan buatan kita: dibiarkan
  const gotKeep = B.store.got[m8.id];
  assert(gotKeep && fs.existsSync(gotKeep.path));
  const gotLost = B.store.got[m1.id] = { path: path.join(B.opts.downloadDir, 'sudah-dihapus.txt'), name: 'sudah-dihapus.txt', ts: 1 };
  B.store.got[gone] = { path: r6.path, name: path.basename(r6.path), ts: 1 };  // pesannya sudah tidak ada, tapi berkasnya milik pengguna
  const lostPath = gotLost.path;
  await B.stop();
  const B2 = mk('B'); await B2.start();
  assert.deepStrictEqual(inDir(B2), ['catatan.txt', live.id + '.pk'].sort());
  assert(B2.store.got[m8.id] && !B2.store.got[m1.id] && !B2.store.got['f'.repeat(32)] && !B2.store.got[gone]);
  assert(fs.existsSync(r6.path), 'berkas pengguna tidak disentuh walau catatannya dibuang');
  assert(!fs.existsSync(lostPath));
  const r = await B2.receiveFile(live.id);                         // .pk segar yang dipertahankan memang bisa dipakai
  assert.strictEqual(fs.readFileSync(r.path, 'utf8'), fs.readFileSync(f('log.txt'), 'utf8'));
  ok('sapuan in/ dan got: .out, .part kedaluwarsa, sisa tawaran hilang/dibersihkan dibuang; .pk segar dan berkas asing dipertahankan; berkas pengguna utuh');

  // ---- 7. sapuan out/ di pengirim: salinan kompres yatim dibuang, yang dipakai dipertahankan ----
  const mine = await A.sendFile(f('log.txt'), 'public');
  const keepPath = A.store.files[mine.id].path;
  const outD = path.join(A.opts.dataDir, 'out');
  const o1 = put(outD, hex(12) + '.br'), o2 = put(outD, hex(12) + '.br.part'), o3 = put(outD, 'milik-lain.txt');
  A.store.files[hex(16)] = { path: put(outD, hex(12) + '.br'), staged: true, meta: A.store.files[mine.id].meta, mtime: 0 }; // pesannya tak ada
  A.store.files[hex(16)] = { path: f('rand.bin'), staged: false, meta: A.store.files[mine.id].meta, mtime: 0 };            // pesannya tak ada, berkas asli
  A._saveNow(); await A.stop();
  const A2 = mk('A'); await A2.start();
  assert(fs.existsSync(keepPath) && A2.store.files[mine.id]);
  assert(!fs.existsSync(o1) && !fs.existsSync(o2) && fs.existsSync(o3));
  assert.deepStrictEqual(Object.keys(A2.store.files).filter((k) => k !== mine.id && A2.store.msgs[k] === undefined), [], 'catatan kirim tanpa pesan dibuang');
  assert(fs.existsSync(f('rand.bin')), 'berkas asli pengguna utuh');
  const staged = Object.values(A2.store.files).filter((x) => x.staged).map((x) => path.basename(x.path)).sort();
  assert(staged.includes(path.basename(keepPath)) && staged.length >= 2, 'tawaran sah lain tetap punya salinan');
  assert.deepStrictEqual(outDir(A2).filter((n) => n.endsWith('.br') || n.endsWith('.part')), staged, 'out/ berisi persis salinan yang masih dicatat');
  ok('sapuan out/: salinan kompres tanpa catatan dibuang, yang masih dipakai tetap, berkas asli dan berkas asing tidak disentuh');

  await A2.stop(); await B2.stop();
  console.log(`\n${pass} tes lulus`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

'use strict';
// Tes penerimaan berkas (v0.7.0 tahap 3, langkah 3a): unduh -> unpack -> cocokkan hash -> simpan ke folder unduhan,
// event progres, nama kembar tidak menimpa, berkas rusak/dibatalkan/ditarik pengirim tidak meninggalkan sisa.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const Pack = require('../src/archne-pack');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-recv-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 });
const f = (n) => path.join(tmp, n);
const code = (c) => (e) => e && e.code === c;
const same = (a, b) => Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);

(async () => {
  const A = mk('A'), B = mk('B'), C = mk('C');
  for (const c of [A, B, C]) await c.start();
  await A.addPeer('127.0.0.1', B.port); await A.addPeer('127.0.0.1', C.port); await B.addPeer('127.0.0.1', C.port);
  await until(() => A.getState().peers.filter((p) => p.online).length === 2 && B.getState().peers.some((p) => p.id === C.id), 4000, 'jaringan');

  let s = 7; const lines = [];
  for (let i = 0; i < 30000; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; lines.push('INFO user=' + (s % 500) + ' GET /api/item/' + (s % 9000) + ' 200\n'); }
  fs.writeFileSync(f('log.txt'), lines.join(''));
  fs.writeFileSync(f('rand.bin'), crypto.randomBytes(3 * 1048576));
  const T0 = 1700000000; // mtime bulat (detik): tidak ada pembulatan milidetik yang membuat server mengira berkas berubah
  fs.utimesSync(f('rand.bin'), T0, T0);
  const gotMsg = (c, id) => until(() => c.store.msgs[id], 4000, 'pesan sampai');
  const inDir = (c) => ls(path.join(c.opts.dataDir, 'in'));
  const msgOf = (c, id) => c.getState().messages.find((m) => m.id === id);

  // ---- 1. publik terkompres: tersimpan identik, event dan progres benar, tidak ada sisa ----
  const m1 = await A.sendFile(f('log.txt'), 'public');
  await gotMsg(B, m1.id);
  const ev = [];
  B.on('file', (e) => ev.push(e));
  const cb = [];
  const r1 = await B.receiveFile(m1.id, { onProgress: (p) => cb.push(p) });
  assert.strictEqual(path.dirname(r1.path), B.opts.downloadDir);
  assert.strictEqual(path.basename(r1.path), 'log.txt');
  assert(same(f('log.txt'), r1.path), 'isi identik');
  const phases = ev.map((e) => e.phase).filter((p, i, a) => p !== a[i - 1]);
  assert.deepStrictEqual(phases, ['download', 'unpack', 'done']);
  for (const ph of ['download', 'unpack']) {
    const d = ev.filter((e) => e.id === m1.id && e.phase === ph).map((e) => e.done);
    assert(d.length >= 2 && d.every((v, i) => !i || v >= d[i - 1]), 'progres ' + ph + ' naik');
  }
  assert.strictEqual(ev.filter((e) => e.phase === 'unpack').pop().total, r1.meta.size);
  assert.strictEqual(cb[cb.length - 1].phase, 'done');
  assert.deepStrictEqual(inDir(B), [], 'folder in/ bersih: tidak ada .part/.pk/.out');
  const st1 = msgOf(B, m1.id);
  assert(st1.file.saved && st1.file.saved.path === r1.path && !st1.file.rx);
  const again = await B.receiveFile(m1.id);
  assert(again.cached && again.path === r1.path, 'sudah tersimpan: tidak diunduh lagi');
  ok('publik: log terkompres ' + r1.meta.psize + ' -> ' + r1.meta.size + ' byte tersimpan identik; event download/unpack/done, folder in/ bersih');

  // ---- 2. DM raw + nama kembar: berkas yang sudah ada tidak tertimpa ----
  fs.mkdirSync(B.opts.downloadDir, { recursive: true });
  fs.writeFileSync(path.join(B.opts.downloadDir, 'rand.bin'), 'MILIK PENGGUNA');
  const m2 = await A.sendFile(f('rand.bin'), B.id);
  await gotMsg(B, m2.id);
  const r2 = await B.receiveFile(m2.id);
  assert.strictEqual(path.basename(r2.path), 'rand (1).bin');
  assert.strictEqual(fs.readFileSync(path.join(B.opts.downloadDir, 'rand.bin'), 'utf8'), 'MILIK PENGGUNA');
  assert(same(f('rand.bin'), r2.path));
  const m2b = await A.sendFile(f('rand.bin'), B.id);
  await gotMsg(B, m2b.id);
  assert.strictEqual(path.basename((await B.receiveFile(m2b.id)).path), 'rand (2).bin');
  assert.deepStrictEqual(inDir(B), []);
  ok('DM: byte identik; nama kembar jadi "rand (1).bin", "rand (2).bin", berkas pengguna tidak tertimpa');

  // ---- 3. grup: anggota menerima ----
  await A.createGroup('G', [B.id]);
  await until(() => A.getState().groups.length && B.getState().groups.length, 4000, 'grup');
  const gid = 'g:' + A.getState().groups[0].id;
  const m3 = await A.sendFile(f('log.txt'), gid);
  await gotMsg(B, m3.id);
  const r3 = await B.receiveFile(m3.id);
  assert(same(f('log.txt'), r3.path));
  ok('grup: berkas terkompres + terenkripsi sampai, identik');

  // ---- 4. berkas diganti isinya di pengirim (ukuran + mtime sama): hash gagal, tidak ada hasil, tidak ada sisa, lalu pulih ----
  const orig = fs.readFileSync(f('rand.bin'));
  const m4 = await A.sendFile(f('rand.bin'), B.id);
  await gotMsg(B, m4.id);
  const bad = Buffer.from(orig); bad[1000] ^= 1;
  fs.writeFileSync(f('rand.bin'), bad); fs.utimesSync(f('rand.bin'), T0, T0);
  const dlBefore = ls(B.opts.downloadDir);
  await assert.rejects(B.receiveFile(m4.id), code('hash'));
  assert.deepStrictEqual(ls(B.opts.downloadDir), dlBefore, 'tidak ada berkas baru di folder unduhan');
  assert.deepStrictEqual(inDir(B), [], 'bentuk terkemas yang rusak dibuang');
  assert(!B.store.got[m4.id]);
  const e4 = msgOf(B, m4.id).file.rx;
  assert(e4 && e4.phase === 'error' && e4.code === 'hash');
  fs.writeFileSync(f('rand.bin'), orig); fs.utimesSync(f('rand.bin'), T0, T0);
  const r4 = await B.receiveFile(m4.id);
  assert(same(f('rand.bin'), r4.path));
  assert(!msgOf(B, m4.id).file.rx);
  ok('berkas rusak: ditolak "hash", tidak ada hasil/sisa; setelah pengirim pulih, percobaan ulang berhasil');

  // ---- 5. dibatalkan di tengah unduhan: .part disimpan, cancelFile, lalu dilanjutkan ----
  const m5 = await A.sendFile(f('rand.bin'), B.id);
  await gotMsg(B, m5.id);
  const serve = A._serveFile.bind(A);
  A._serveFile = (sock, o, ip) => { let n = 0; const w = sock.write.bind(sock); sock.write = (c, ...a) => { n += c.length; return n > 600000 ? false : w(c, ...a); }; return serve(sock, o, ip); };
  const dl5 = B.receiveFile(m5.id);
  const part5 = B._inPaths(m5.id).part;
  await until(() => fs.existsSync(part5) && fs.statSync(part5).size >= 500000, 4000, 'sebagian terunduh');
  assert.strictEqual(B.cancelFile(m5.id), true);
  await assert.rejects(dl5, code('abort'));
  assert(fs.existsSync(part5) && fs.statSync(part5).size >= 500000, '.part disimpan');
  assert.strictEqual(B.cancelFile(m5.id), false, 'tidak ada yang berjalan lagi');
  A._serveFile = serve;
  const r5 = await B.receiveFile(m5.id);
  assert(same(f('rand.bin'), r5.path));
  assert.deepStrictEqual(inDir(B), []);
  ok('batal: .part disimpan, panggilan berikutnya melanjutkan dan selesai identik');

  // ---- 6. panggilan serentak berbagi satu proses ----
  const m6 = await A.sendFile(f('log.txt'), 'public');
  await gotMsg(B, m6.id);
  let served = 0;
  A._serveFile = (sock, o, ip) => { served++; return serve(sock, o, ip); };
  const [x, y] = await Promise.all([B.receiveFile(m6.id), B.receiveFile(m6.id)]);
  assert.strictEqual(x.path, y.path); assert.strictEqual(served, 1);
  A._serveFile = serve;
  ok('dua panggilan serentak: satu unduhan, satu berkas');

  // ---- 7. pengirim membatalkan pesan saat penerima sedang unpack: hasil dibuang ----
  const m7 = await A.sendFile(f('log.txt'), 'public');
  await gotMsg(B, m7.id);
  const realUnpack = Pack.unpack;
  Pack.unpack = async (...a) => { const r = await realUnpack(...a); delete B.store.msgs[m7.id]; return r; }; // pembatalan tiba tepat setelah unpack
  const before7 = ls(B.opts.downloadDir);
  await assert.rejects(B.receiveFile(m7.id), code('gone'));
  Pack.unpack = realUnpack;
  assert.deepStrictEqual(ls(B.opts.downloadDir), before7);
  assert.deepStrictEqual(inDir(B), []);
  assert(!B.store.got[m7.id]);
  ok('ditarik pengirim saat unpack: tidak ada berkas di folder unduhan, tidak ada sisa');

  // ---- 8. berkas hasil unduhan dihapus pengguna: boleh diunduh lagi ----
  fs.rmSync(r1.path);
  const r8 = await B.receiveFile(m1.id);
  assert(!r8.cached && same(f('log.txt'), r8.path));
  ok('berkas dihapus pengguna: catatan basi dibuang, diunduh ulang');

  // ---- 9. penolakan: pesan sendiri, id sampah, bukan tawaran ----
  await assert.rejects(A.receiveFile(m1.id), /tidak ditemukan/);
  await assert.rejects(B.receiveFile('zzz'), /tidak ditemukan/);
  const plain = A.sendText('halo', 'public'); await gotMsg(B, plain.id);
  await assert.rejects(B.receiveFile(plain.id), /tidak ditemukan/);
  ok('menolak: tawaran milik sendiri, id sampah, pesan biasa');

  // ---- 10. pihak ketiga (C bukan tujuan DM): tawaran tidak bisa dibuka, tidak menghubungi pengirim, tidak ada berkas ----
  const m10 = await A.sendFile(f('log.txt'), B.id);
  await gotMsg(B, m10.id);
  C.store.msgs[m10.id] = JSON.parse(JSON.stringify(A.store.msgs[m10.id])); // salinan DM yang bocor ke C
  let served10 = 0;
  A._serveFile = (sock, o, ip) => { served10++; return serve(sock, o, ip); };
  await assert.rejects(C.receiveFile(m10.id), /tidak ditemukan/);
  assert.strictEqual(served10, 0);
  A._serveFile = serve;
  assert.deepStrictEqual(ls(C.opts.downloadDir), []);
  ok('pihak ketiga: tawaran DM tidak terbuka baginya, pengirim tidak dihubungi, tidak ada berkas (sisi server "denied" diuji di xfer)');

  // ---- 11. sisa berkas setelah restart: .pk lengkap dipakai lagi tanpa unduh ulang ----
  const m11 = await A.sendFile(f('log.txt'), 'public');
  await gotMsg(B, m11.id);
  await B.fetchPacked(m11.id); // hanya unduh, belum unpack (seolah aplikasi mati sebelum unpack)
  let served11 = 0;
  A._serveFile = (sock, o, ip) => { served11++; return serve(sock, o, ip); };
  const r11 = await B.receiveFile(m11.id);
  assert.strictEqual(served11, 0, 'tidak menghubungi pengirim');
  assert(same(f('log.txt'), r11.path));
  A._serveFile = serve;
  ok('.pk lengkap dari sesi sebelumnya langsung di-unpack tanpa unduh ulang');

  await A.stop(); await B.stop(); await C.stop();
  console.log(`\n${pass} tes lulus`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

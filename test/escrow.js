'use strict';
// Tes titipan byte berkas di kurir (v0.7.0 tahap 4a): penyimpanan saja, belum ada jaringan.
// Data tiruan: byte "tersegel" hanyalah byte acak (kurir memang tidak bisa membedakannya).
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const Xfer = require('../src/archne-xfer');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-escrow-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false }, o));
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
const escDir = (c) => path.join(c.opts.dataDir, 'esc');
const MB = 1048576;

(async () => {
  const A = mk('A'), C = mk('C'), B = mk('B', { escQuota: 3 * MB, escPerSender: 2 * MB });
  const A2 = mk('A2'); // pengirim kedua, untuk batas per pengirim
  await A.start(); await C.start(); await B.start(); await A2.start();
  await A.addPeer('127.0.0.1', C.port); await A2.addPeer('127.0.0.1', C.port);
  await until(() => A.peers.get(C.id) && A.peers.get(C.id).xpub && A2.peers.get(C.id) && A2.peers.get(C.id).xpub, 5000, 'A kenal C');
  const dm = (from, text) => { const m = from._makeMsg(C.id, 'e1', text); assert.strictEqual(B._ingest(m), 'carried'); return m; };
  const wl = (psize) => Xfer.wireLen(0, psize);
  const bytes = (n) => crypto.randomBytes(n);
  const full = async (id, psize, step = 100000) => {
    const all = bytes(wl(psize)); let off = 0, r;
    while (off < all.length) { const b = all.subarray(off, off + step); r = await B._escWrite(id, off, b); assert(r.ok, JSON.stringify(r)); off += b.length; }
    return { all, r };
  };

  // ---- 1. syarat reservasi ----
  const m1 = dm(A, 'dm 1');
  assert.deepStrictEqual(B._escReserve('f'.repeat(32), 1000), { ok: false, code: 'nocustody' });
  assert.strictEqual(B._escReserve('xyz', 1000).code, 'bad');
  for (const bad of [0, -5, 1.5, NaN, '100']) assert.strictEqual(B._escReserve(m1.id, bad).code, 'bad');
  assert.strictEqual(B._escReserve(m1.id, 100 * MB + 1).code, 'big');
  const inv = A.createGroup('Tim', [C.id]);
  const invMsg = Object.values(A.store.msgs).find((m) => m.kind === 'ginv');
  assert.strictEqual(B._ingest(invMsg), 'carried');
  assert.strictEqual(B._escReserve(invMsg.id, 1000).code, 'kind');
  assert.strictEqual(Object.keys(B.store.esc).length, 0);
  ok('syarat: pesannya harus sedang dititipkan, harus DM (bukan undangan), ukuran sah dan di bawah 100 MB (batas atas titipan)');

  // ---- 2. tulis berurutan, resume, selesai ----
  const P = 300000, W = wl(P);
  let r = B._escReserve(m1.id, P);
  assert.deepStrictEqual(r, { ok: true, have: 0, done: false });
  const all = bytes(W);
  assert((await B._escWrite(m1.id, 0, all.subarray(0, 100000))).ok);
  assert.deepStrictEqual(await B._escWrite(m1.id, 0, all.subarray(0, 10)), { ok: false, code: 'range', have: 100000 });
  assert.deepStrictEqual(await B._escWrite(m1.id, 150000, all.subarray(150000, 160000)), { ok: false, code: 'range', have: 100000 });
  assert.strictEqual((await B._escWrite(m1.id, 100000, bytes(W))).code, 'over');
  assert.strictEqual(B._escFile(m1.id), null);
  assert.deepStrictEqual(ls(escDir(B)), [m1.id + '.bin.part']);
  assert.deepStrictEqual(B._escReserve(m1.id, P), { ok: true, have: 100000, done: false }); // tanya ulang = resume
  assert.strictEqual(B._escReserve(m1.id, P + 1).code, 'bad');
  let off = 100000;
  while (off < W) { const b = all.subarray(off, off + 90000); r = await B._escWrite(m1.id, off, b); assert(r.ok); off += b.length; }
  assert(r.done && r.have === W);
  assert.deepStrictEqual(ls(escDir(B)), [m1.id + '.bin']);
  assert(fs.readFileSync(B._escFile(m1.id)).equals(all), 'byte identik');
  assert.strictEqual((await B._escWrite(m1.id, W, bytes(1))).code, 'range');
  ok('tulis berurutan: off salah ditolak, resume dari `have`, lengkap -> .bin, byte identik');

  // ---- 3. kuota dan batas per pengirim ----
  assert.deepStrictEqual(B.escUsage(), { used: P, count: 1, quota: 3 * MB });
  const m2 = dm(A, 'dm 2');
  assert.strictEqual(B._escReserve(m2.id, 2 * MB).code, 'sender'); // A sudah 300 KB; 300 KB + 2 MB > 2 MB
  assert(B._escReserve(m2.id, 1.5 * MB).ok);
  const m3 = dm(A2, 'dm 3');
  assert(B._escReserve(m3.id, 1 * MB).ok); // pengirim lain tetap dapat jatah
  const m4 = dm(A2, 'dm 4');
  assert.strictEqual(B._escReserve(m4.id, 0.5 * MB).code, 'quota'); // 300 KB + 1.5 MB + 1 MB = 2.8 MB; + 0.5 MB > 3 MB
  assert.strictEqual(B.escUsage().count, 3);
  ok('batas per pengirim dan kuota total bekerja; pengirim lain tidak ikut terblokir');

  // ---- 4. dibuang: tanda terima ----
  await full(m3.id, 1 * MB, 400000);
  assert(B._escFile(m3.id));
  await C._ingest(m3, true); // C menerima langsung
  const rc = C._myRcpt(m3);
  assert(rc && B._addRcpt(rc));
  assert(!B.store.custody[m3.id], 'titipan pesan dibuang saat tanda terima pesan');
  assert(B.store.esc[m3.id] && B._escFile(m3.id), 'byte berkas bertahan: penerima baru bisa mengambilnya setelah menerima tawaran');
  assert.strictEqual(B._escReserve(m3.id, 1000).code, 'nocustody');
  // tanda terima BERKAS (ditandatangani penerima) yang membuang byte
  C.store.msgs[m3.id] = m3; C._makeFileRcpt(m3);
  const fr = C.store.freceipts[m3.id];
  assert(fr && B._addFileRcpt(fr));
  await B.flushCleanup();
  assert(!B.store.esc[m3.id] && !ls(escDir(B)).includes(m3.id + '.bin'));
  ok('tanda terima pesan membuang titipan pesan saja; byte berkas baru dibuang oleh tanda terima berkas penerima');

  // ---- 5. dibuang: kedaluwarsa (titipan pesan 14 hari, byte berkas 7 hari) ----
  B.store.esc[m1.id].at = Date.now() - 8 * 864e5;
  B._gc(); await B.flushCleanup();
  assert(!B.store.esc[m1.id] && B.store.custody[m1.id], 'berkas kedaluwarsa, titipan pesan tetap');
  assert.deepStrictEqual(ls(escDir(B)).filter((n) => n.startsWith(m1.id)), []);
  B.store.custody[m2.id].at = Date.now() - 15 * 864e5;
  B._gc(); await B.flushCleanup();
  assert(!B.store.custody[m2.id] && B.store.esc[m2.id], 'titipan pesan tersingkir, byte berkas bertahan sampai kedaluwarsanya sendiri');
  B.store.esc[m2.id].at = Date.now() - 8 * 864e5;
  B._gc(); await B.flushCleanup();
  assert(!B.store.esc[m2.id]);
  assert.deepStrictEqual(ls(escDir(B)), []);
  ok('kedaluwarsa 7 hari membuang byte berkas saja; titipan pesan yang tersingkir tidak membawa byte berkasnya');

  // ---- 6. dibuang saat sedang menulis ----
  const m5 = dm(A, 'dm 5');
  assert(B._escReserve(m5.id, 500000).ok);
  const pend = B._escWrite(m5.id, 0, bytes(200000));
  B._escDrop(m5.id);
  const res = await pend;
  await B.flushCleanup();
  assert(res.ok === false && res.code === 'gone', 'tulisan yang terlanjur jalan tidak dihitung setelah dibuang: ' + JSON.stringify(res));
  assert(!B.store.esc[m5.id]);
  assert.deepStrictEqual(ls(escDir(B)), []);
  assert.strictEqual((await B._escWrite(m5.id, 0, bytes(10))).code, 'gone');
  ok('dibuang di tengah penulisan: tidak ada sisa di disk, penulisan berikutnya ditolak (gone)');

  // ---- 7. sapuan saat aplikasi dibuka + bertahan lewat restart ----
  const m6 = dm(A, 'dm 6'), m7 = dm(A, 'dm 7');
  assert(B._escReserve(m6.id, 100000).ok);
  await B._escWrite(m6.id, 0, bytes(60000)); // belum lengkap
  assert(B._escReserve(m7.id, 100000).ok);
  await full(m7.id, 100000);
  await B.stop();
  const ed = escDir(B);
  const stray = [crypto.randomBytes(16).toString('hex') + '.bin', crypto.randomBytes(16).toString('hex') + '.bin.part'];
  for (const n of stray) fs.writeFileSync(path.join(ed, n), 'yatim');
  fs.writeFileSync(path.join(ed, 'catatan-saya.txt'), 'bukan buatan kita');
  fs.appendFileSync(path.join(ed, m6.id + '.bin.part'), Buffer.alloc(5000)); // sisa tulisan yang terputus: ukuran disk > catatan
  const B2 = mk('B', { escQuota: 3 * MB, escPerSender: 2 * MB });
  await B2.start();
  assert.deepStrictEqual(ls(ed), ['catatan-saya.txt', m6.id + '.bin.part', m7.id + '.bin'].sort());
  assert.strictEqual(B2.store.esc[m6.id].have, 65000, 'jumlah byte disamakan dengan isi disk');
  assert(B2._escFile(m7.id) && !B2._escFile(m6.id));
  const r2 = B2._escReserve(m6.id, 100000);
  assert(r2.ok && r2.have === 65000);
  ok('restart: rekaman bertahan, berkas yatim disapu, berkas asing dibiarkan, `have` disesuaikan dengan disk');

  // rekaman rusak: berkas lengkap hilang / titipan pesan hilang / ukuran tidak cocok
  await B2.stop();
  fs.rmSync(path.join(ed, m7.id + '.bin'));
  const B3 = mk('B', { escQuota: 3 * MB, escPerSender: 2 * MB });
  await B3.start();
  assert(!B3.store.esc[m7.id] && B3.store.esc[m6.id]);
  await B3.stop();
  const sf = JSON.parse(fs.readFileSync(path.join(B3.opts.dataDir, 'store.json'), 'utf8'));
  fs.rmSync(path.join(B3.opts.dataDir, 'custody', m6.id.slice(0, 2), m6.id + '.json')); // sejak 0.22.1 titipan pesan = satu berkas per pesan di custody/
  delete sf.esc[m6.id].to; delete sf.esc[m6.id].from; // rekaman dari versi lama (tanpa tujuan) dan titipannya sudah tidak ada
  fs.writeFileSync(path.join(B3.opts.dataDir, 'store.json'), JSON.stringify(sf));
  const B4 = mk('B', { escQuota: 3 * MB, escPerSender: 2 * MB });
  await B4.start();
  assert.deepStrictEqual(Object.keys(B4.store.esc), []);
  assert.deepStrictEqual(ls(ed), ['catatan-saya.txt']);
  ok('sapuan membuang rekaman yang berkasnya hilang atau titipan pesannya sudah tidak ada');

  // ---- 8. tidak bocor ke tempat lain ----
  assert(!B4.getState().messages.some((m) => m.id === m6.id), 'titipan tidak tampil di chat kurir');
  assert(!/esc/.test(JSON.stringify(B4.getState())), 'getState tidak memuat titipan berkas');
  ok('titipan berkas tidak tampil di chat kurir dan tidak ada di getState');

  console.log(`\nSEMUA TES TITIPAN BERKAS LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e.stack || e.message); process.exit(1); });

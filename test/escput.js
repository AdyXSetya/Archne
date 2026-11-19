'use strict';
// Tes dorongan berkas ke kurir (v0.7.0 tahap 4, langkah 4b-1): esc_q + file_put, resume, otentikasi pengirim, penolakan, pembuangan.
const os = require('os'), path = require('path'), fs = require('fs'), net = require('net'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const Xfer = require('../src/archne-xfer');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-escput-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 600000, escPush: false }, o)); // sinkronisasi hanya manual (_syncFrom di offer): tanda terima tidak boleh sampai ke A lebih dulu dari barisan tes // dorongan manual saja: penjadwal otomatis (4b-2) diuji di escauto.js
const f = (n) => path.join(tmp, n);
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
const escDir = (c) => path.join(c.opts.dataDir, 'esc');
const code = (c) => (e) => e && e.code === c;
const PTAG = 'archne-put1:';

// Permintaan mentah ke kurir (meniru klien yang jujur atau nakal).
function raw(core, head, body, opts = {}) {
  const sock = net.connect({ host: '127.0.0.1', port: core.port });
  let buf = '';
  const reply = new Promise((res) => {
    const t = setTimeout(() => res({ timeout: true }), 4000);
    sock.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(t); try { res(JSON.parse(buf.slice(0, i))); } catch { res({ garbled: buf }); } } });
    sock.on('close', () => { clearTimeout(t); if (buf.indexOf('\n') < 0) res({ closed: true }); });
    sock.on('error', () => {});
  });
  sock.on('connect', () => { sock.write(JSON.stringify(Object.assign({ t: 'file_put' }, head)) + '\n'); if (body && body.length) sock.write(body); });
  return { sock, reply };
}

(async () => {
  const A = mk('A'), B = mk('B'), C = mk('C'), X = mk('X');
  await A.start(); await B.start(); await C.start(); await X.start();
  await A.addPeer('127.0.0.1', B.port); await A.addPeer('127.0.0.1', C.port); await X.addPeer('127.0.0.1', B.port);
  await until(() => A.getState().peers.filter((p) => p.online).length === 2 && X.getState().peers.some((p) => p.online), 5000, 'jaringan');
  await C.stop(); // penerima offline: berkas hanya bisa lewat kurir

  fs.writeFileSync(f('rand.bin'), crypto.randomBytes(3 * 1048576 + 12345));
  const T0 = 1700000000; fs.utimesSync(f('rand.bin'), T0, T0);
  const offer = async (name = 'rand.bin') => {
    const m = await A.sendFile(f(name), C.id);
    await B._syncFrom(B.peers.get(A.id));
    assert(B.store.custody[m.id], 'B memegang tawaran');
    return m;
  };
  // plaintext hasil buka segel .bin di kurir (memakai kunci A) -> harus sama dengan berkas asli
  const open = (m, file) => new Promise((res, rej) => {
    const key = A._fileKey(m), total = A.store.files[m.id].meta.psize, chunks = [];
    const op = new Xfer.Opener(key, total, 0);
    op.on('data', (c) => chunks.push(c)); op.on('end', () => res(Buffer.concat(chunks))); op.on('error', rej);
    fs.createReadStream(file).pipe(op);
  });
  const sign = (id, psize, nonce) => crypto.sign(null, Buffer.from(PTAG + id + ':' + psize + ':' + nonce), A.privKey).toString('base64');
  const head = (m, off = 0, o = {}) => {
    const psize = A.store.files[m.id].meta.psize, q = B._escQuery({ id: m.id, psize });
    assert(q.ok, JSON.stringify(q));
    return Object.assign({ id: m.id, psize, off, nonce: q.nonce, sig: sign(m.id, psize, q.nonce), hi: A.hello() }, o);
  };
  const sealedAll = (m) => new Promise((res, rej) => {
    const total = A.store.files[m.id].meta.psize, chunks = [];
    const s = new Xfer.Sealer(A._fileKey(m), total, 0);
    s.on('data', (c) => chunks.push(c)); s.on('end', () => res(Buffer.concat(chunks))); s.on('error', rej);
    fs.createReadStream(A.store.files[m.id].path).pipe(s);
  });

  // ---- 1. dorong penuh ----
  const m1 = await offer();
  const r1 = await A.pushToCourier(m1.id, B.id);
  const wl = Xfer.wireLen(0, A.store.files[m1.id].meta.psize);
  assert.deepStrictEqual(r1, { have: wl, done: true });
  assert(B._escFile(m1.id) && B.store.esc[m1.id].done);
  assert((await open(m1, B._escFile(m1.id))).equals(fs.readFileSync(f('rand.bin'))), 'kurir menyimpan byte tersegel yang benar');
  assert.deepStrictEqual(ls(escDir(B)), [m1.id + '.bin']);
  ok('dorong penuh: byte di kurir bisa dibuka dengan kunci DM dan identik dengan berkas asli');

  // sudah lengkap: dorong ulang tidak mengirim byte
  let sent = 0;
  assert.deepStrictEqual(await A.pushToCourier(m1.id, B.id, { onBytes: () => sent++ }), { have: wl, done: true });
  assert.strictEqual(sent, 0);
  ok('dorong ulang pada berkas yang sudah lengkap tidak mengirim byte');

  // ---- 2. putus di tengah, lalu resume dari batas potongan ----
  const m2 = await offer();
  const ac = new AbortController();
  await assert.rejects(A.pushToCourier(m2.id, B.id, { signal: ac.signal, onBytes: (n) => { if (n > 1000000) ac.abort(); } }), code('abort'));
  await until(() => B._putIn.size === 0, 3000, 'slot dilepas');
  const e2 = B.store.esc[m2.id];
  assert(e2 && !e2.done && e2.have > 0 && e2.have < wl, 'sebagian tersimpan: ' + (e2 && e2.have));
  const have2 = e2.have, seg = Xfer.SEG + Xfer.TAG;
  const firstBytes = [];
  const r2 = await A.pushToCourier(m2.id, B.id, { onBytes: (n) => firstBytes.push(n) });
  assert(r2.done);
  assert(firstBytes[0] > Xfer.SEG * Math.floor(have2 / seg), 'lanjut dari tengah, bukan mulai ulang: ' + firstBytes[0] + ' vs have ' + have2);
  assert((await open(m2, B._escFile(m2.id))).equals(fs.readFileSync(f('rand.bin'))));
  ok('putus di tengah: sebagian tersimpan, dorongan berikutnya lanjut dari batas potongan dan hasil akhir benar');

  // ---- 3. otentikasi: hanya pengirim pesan yang bisa mengisi slot ----
  const m3 = await offer();
  const psize3 = A.store.files[m3.id].meta.psize;
  // penyamar X: tanda tangan dengan kunci sendiri
  let q = B._escQuery({ id: m3.id, psize: psize3 });
  let r = await raw(B, { id: m3.id, psize: psize3, off: 0, nonce: q.nonce, sig: crypto.sign(null, Buffer.from(PTAG + m3.id + ':' + psize3 + ':' + q.nonce), X.privKey).toString('base64'), hi: X.hello() }, Buffer.alloc(100)).reply;
  assert.deepStrictEqual([r.ok, r.err], [false, 'auth']);
  // nonce dipakai ulang (head asli disalin penyadap)
  const h = head(m3);
  const first = raw(B, h, null);        // pemakaian pertama: sah, kurir menunggu byte; kita tutup setelah slotnya terlihat
  await until(() => B._putIn.size === 1, 3000, 'slot pemakaian pertama');
  first.sock.destroy();
  r = await raw(B, h, Buffer.alloc(10)).reply;
  assert.deepStrictEqual([r.ok, r.err], [false, 'auth']);
  // nonce untuk id lain, nonce kedaluwarsa, nonce asing
  const other = B._escQuery({ id: m1.id, psize: A.store.files[m1.id].meta.psize });
  r = await raw(B, Object.assign(head(m3), { nonce: other.nonce }), null).reply;
  assert.strictEqual(r.err, 'auth');
  const h4 = head(m3); B._escNonce.get(h4.nonce).exp = Date.now() - 1;
  assert.strictEqual((await raw(B, h4, null).reply).err, 'auth');
  assert.strictEqual((await raw(B, Object.assign(head(m3), { nonce: 'ab'.repeat(16) }), null).reply).err, 'auth');
  await until(() => B._putIn.size === 0, 3000, 'slot');
  assert(!B._escFile(m3.id));
  ok('penyamar, nonce dipakai ulang, nonce id lain, kedaluwarsa, dan asing: semua ditolak (auth)');

  // ---- 4. penolakan lain ----
  const bad = async (hd, body, want) => { const x = await raw(B, hd, body).reply; assert.strictEqual(x.err, want, JSON.stringify(x)); return x; };
  await bad(head(m3, 12345), null, 'range');                                   // off tak sejajar / tidak sama dengan have
  await bad(head(m3, 0, { psize: psize3 + 1 }), null, 'bad'); // slot sudah direservasi dengan psize asli; psize lain ditolak
  await bad({ id: 'zz', psize: 5, off: 0, nonce: 'x', sig: 'y' }, null, 'bad');
  await bad({ id: m3.id, psize: 1.5, off: 0, nonce: 'x', sig: 'y' }, null, 'bad');
  const nocust = 'e'.repeat(32);
  assert.strictEqual(B._escQuery({ id: nocust, psize: 100 }).err, 'nocustody');
  // berlebih: kirim lebih dari yang didaftarkan
  const x = await raw(B, head(m3), Buffer.alloc(wl + 100, 1)).reply;
  assert.strictEqual(x.err, 'over');
  await until(() => B._putIn.size === 0, 3000, 'slot');
  assert(!B._escFile(m3.id));
  // undangan grup dan pesan non-DM tidak bisa
  await assert.rejects(A.pushToCourier(m3.id, C.id), code('bad'));          // tujuan = penerima: tidak perlu kurir
  await assert.rejects(A.pushToCourier('f'.repeat(32), B.id), code('gone')); // bukan tawaran milik kita
  const gmsg = (() => { const g = A.createGroup('Tim', [B.id]); return g; })();
  await assert.rejects(A.pushToCourier(m3.id, X.id), (e) => e.code === 'net' || e.code === 'nocustody'); // X online tapi tidak memegang titipan
  ok('off salah, psize beda, id rusak, byte berlebih, tujuan sebagai kurir, bukan tawaran, kurir tanpa titipan: ditolak dengan kode yang tepat');

  // ---- 5. satu slot per berkas; dibuang saat sedang masuk ----
  const m5 = await offer();
  const h5 = head(m5), h5b = head(m5);
  const slow = raw(B, h5, null);                  // slot 1 terbuka, menunggu byte
  await until(() => B._putIn.size === 1, 3000, 'slot 1');
  assert.strictEqual((await raw(B, h5b, null).reply).err, 'busy');
  // kirim sebagian, lalu titipan dibuang (mis. tanda terima tiba)
  const part = await sealedAll(m5);
  slow.sock.write(part.subarray(0, 300000));
  await sleep(150);
  B._escDrop(m5.id);
  slow.sock.write(part.subarray(300000, 700000));
  const dead = await slow.reply;
  assert(dead.err === 'gone' || dead.closed, JSON.stringify(dead));
  await until(() => B._putIn.size === 0, 3000, 'slot');
  await B.flushCleanup();
  assert(!B.store.esc[m5.id] && !ls(escDir(B)).some((n) => n.startsWith(m5.id)));
  ok('satu unggahan per berkas (busy); byte dibuang di tengah unggahan: unggahan dihentikan dan tidak ada sisa');

  // ---- 6. pengirim membatalkan pesan saat dorongan berjalan ----
  const m6 = await offer();
  const p6 = A.pushToCourier(m6.id, B.id, { onBytes: () => {} });
  await sleep(5);
  A.deleteMessage(m6.id);
  await assert.rejects(p6, code('abort'));
  ok('batal kirim menghentikan dorongan yang sedang berjalan');

  // ---- 7. kuota kurir ----
  const Q = mk('Q', { escQuota: 1000000 });
  await Q.start(); await A.addPeer('127.0.0.1', Q.port);
  await until(() => A.isOnline(A.peers.get(Q.id)), 4000, 'Q online');
  const m7 = await offer();
  await Q._syncFrom(Q.peers.get(A.id));
  assert(Q.store.custody[m7.id]);
  await assert.rejects(A.pushToCourier(m7.id, Q.id), code('quota'));
  assert.deepStrictEqual(ls(escDir(Q)), []);
  ok('kuota kurir penuh: ditolak sebelum satu byte pun dikirim');

  // ---- 8. setelah tanda terima: ditolak ----
  const m8 = await offer();
  const rcp = (() => { C._ingest(m8, true); return C._myRcpt(m8); })();
  assert(B._addRcpt(rcp));
  await assert.rejects(A.pushToCourier(m8.id, B.id), code('nocustody')); // kurir sudah membuang titipan saat tanda terima tiba
  assert(A._addRcpt(rcp));                                               // pengirim akhirnya tahu: tidak perlu menghubungi kurir sama sekali
  let asked = 0; const rq = B._escQuery.bind(B); B._escQuery = (o) => { asked++; return rq(o); };
  await assert.rejects(A.pushToCourier(m8.id, B.id), code('receipt'));
  assert.strictEqual(asked, 0);
  ok('pesan yang sudah diterima tujuan tidak didorong lagi (kurir menolak; pengirim yang sudah tahu bahkan tidak bertanya)');

  console.log(`\nSEMUA TES DORONG KE KURIR LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e.stack || e.message); process.exit(1); });

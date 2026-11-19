'use strict';
// Tes transfer berkas (v0.7.0 tahap 3, langkah 2): unduh, resume, putus di tengah, akses, berkas berubah, batas koneksi, server curang,
// dan (2b) enkripsi per potongan untuk DM/grup: ciphertext di kabel, penyamar, penurunan ke polos, potongan diubah/ditukar/ditambah.
const os = require('os'), path = require('path'), fs = require('fs'), net = require('net'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const Xfer = require('../src/archne-xfer');
const Pack = require('../src/archne-pack');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-xfer-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, tickMs: 100, syncMs: 150 });
const f = (n) => path.join(tmp, n);
const code = (c) => (e) => e && e.code === c;
const same = (a, b) => Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;

// Permintaan mentah tanpa Core penerima: dipakai untuk menguji sisi server saja.
function rawGet(peer, req) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port: peer.port });
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d) => { buf += d; });
    s.on('close', () => res(buf.split('\n')[0]));
    s.on('error', () => {});
    s.write(JSON.stringify(req) + '\n');
  });
}

(async () => {
  const A = mk('A'), B = mk('B'), C = mk('C');
  for (const c of [A, B, C]) await c.start();
  await A.addPeer('127.0.0.1', B.port); await A.addPeer('127.0.0.1', C.port); await B.addPeer('127.0.0.1', C.port);
  await until(() => A.getState().peers.filter((p) => p.online).length === 2 && B.getState().peers.some((p) => p.id === C.id), 4000, 'jaringan');

  let s = 7; const lines = [];
  for (let i = 0; i < 30000; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; lines.push('INFO user=' + (s % 500) + ' GET /api/item/' + (s % 9000) + ' 200\n'); }
  fs.writeFileSync(f('log.txt'), lines.join(''));
  fs.writeFileSync(f('rand.bin'), crypto.randomBytes(3 * 1048576));
  const gotMsg = (c, id) => until(() => c.store.msgs[id], 4000, 'pesan sampai');

  // ---- 1. publik, terkompres: unduh lalu unpack = identik dengan aslinya ----
  const m1 = await A.sendFile(f('log.txt'), 'public');
  await gotMsg(B, m1.id);
  const prog = [];
  const r1 = await B.fetchPacked(m1.id, { onProgress: (p) => prog.push(p.done) });
  assert.strictEqual(fs.statSync(r1.path).size, A.store.files[m1.id].meta.psize);
  assert(prog.length && prog.every((v, i) => !i || v >= prog[i - 1]) && prog[prog.length - 1] === r1.meta.psize, 'progres naik dan berakhir di psize');
  await Pack.unpack(r1.path, f('log.out'), r1.meta, { kind: 'public' });
  assert(same(f('log.txt'), f('log.out')));
  assert(!fs.existsSync(B._inPaths(m1.id).part), 'tidak ada .part tersisa');
  assert((await B.fetchPacked(m1.id)).path === r1.path, 'sudah lengkap: tidak diunduh lagi');
  ok('publik: log terkompres ' + r1.meta.psize + ' dari ' + r1.meta.size + ' byte, unduh + unpack identik, progres naik');

  // ---- 2. DM raw: byte persis sama; peer lain (C) ditolak ----
  const m2 = await A.sendFile(f('rand.bin'), B.id);
  await gotMsg(B, m2.id);
  const r2 = await B.fetchPacked(m2.id);
  assert(same(f('rand.bin'), r2.path));
  const asC = (id, o) => rawGet(A, Object.assign({ t: 'file_get', id, off: 0, hi: C.hello() }, o));
  assert.strictEqual(JSON.parse(await asC(m2.id)).err, 'denied');
  assert.strictEqual(JSON.parse(await rawGet(A, { t: 'file_get', id: m2.id, off: 0 })).err, 'denied');
  assert.strictEqual(JSON.parse(await asC(m1.id)).ok, true, 'berkas publik boleh diambil siapa saja');
  ok('DM raw: byte identik; peer ketiga dan peminta tanpa identitas ditolak, publik terbuka untuk semua');

  // ---- 3. grup: anggota boleh, bukan anggota ditolak ----
  await A.createGroup('G', [B.id]);
  await until(() => A.getState().groups.length && B.getState().groups.length, 4000, 'grup');
  const gid = 'g:' + A.getState().groups[0].id;
  const m3 = await A.sendFile(f('rand.bin'), gid);
  await gotMsg(B, m3.id);
  assert(same(f('rand.bin'), (await B.fetchPacked(m3.id)).path));
  assert.strictEqual(JSON.parse(await asC(m3.id)).err, 'denied');
  ok('grup: anggota mengunduh, bukan anggota ditolak');

  // ---- 4. resume dari .part yang sudah ada ----
  // DM (tersegel): .part dibulatkan turun ke batas potongan, karena nonce/AAD terikat nomor potongan.
  const m4 = await A.sendFile(f('rand.bin'), B.id);
  await gotMsg(B, m4.id);
  const { part } = B._inPaths(m4.id);
  fs.mkdirSync(path.dirname(part), { recursive: true });
  const cut = 1234567, aligned = cut - (cut % Xfer.SEG);
  fs.writeFileSync(part, fs.readFileSync(f('rand.bin')).subarray(0, cut));
  const offs = []; const orig = A._serveFile.bind(A);
  A._serveFile = (sock, o, ip) => { offs.push(o.off); return orig(sock, o, ip); };
  const first = [];
  const r4 = await B.fetchPacked(m4.id, { onProgress: (p) => first.push(p.done) });
  assert.deepStrictEqual(offs, [aligned], 'klien meminta mulai dari batas potongan terdekat di bawah ukuran .part');
  assert(first[0] > aligned && same(f('rand.bin'), r4.path));
  // publik (polos): lanjut persis dari ukuran .part, tanpa pembulatan
  fs.writeFileSync(f('pub.bin'), crypto.randomBytes(2 * 1048576));
  const m4b = await A.sendFile(f('pub.bin'), 'public');
  await gotMsg(B, m4b.id);
  fs.writeFileSync(B._inPaths(m4b.id).part, fs.readFileSync(f('pub.bin')).subarray(0, cut));
  offs.length = 0;
  assert(same(f('pub.bin'), (await B.fetchPacked(m4b.id)).path));
  assert.deepStrictEqual(offs, [cut]);
  ok('resume: DM .part ' + cut + ' byte dilanjutkan dari batas potongan ' + aligned + '; publik dari ' + cut + '; hasil identik');

  // ---- 5. koneksi diputus server di tengah jalan: coba ulang otomatis, lanjut dari yang sudah ada ----
  const m5 = await A.sendFile(f('rand.bin'), B.id);
  await gotMsg(B, m5.id);
  offs.length = 0; let cutDone = false;
  A._serveFile = (sock, o, ip) => {
    offs.push(o.off);
    if (!cutDone) {
      cutDone = true; let n = 0; const w = sock.write.bind(sock);
      sock.write = (c, ...a) => { n += c.length; if (n > 600000) { sock.destroy(); return false; } return w(c, ...a); };
    }
    return orig(sock, o, ip);
  };
  const r5 = await B.fetchPacked(m5.id, { retryMs: 50 });
  assert(offs.length >= 2 && offs[0] === 0 && offs[1] > 0 && offs[1] % Xfer.SEG === 0, 'percobaan kedua melanjutkan di batas potongan, bukan dari nol: ' + offs);
  assert(same(f('rand.bin'), r5.path));
  ok('putus di tengah: otomatis lanjut dari byte terakhir (offset ' + offs[1] + '), hasil identik');

  // ---- 6. batal lewat AbortSignal: .part disimpan, panggilan berikutnya melanjutkan ----
  const m6 = await A.sendFile(f('rand.bin'), B.id);
  await gotMsg(B, m6.id);
  // server sengaja berhenti menulis setelah ~600 KB (tanpa menutup), supaya pembatalan pasti terjadi di tengah unduhan
  A._serveFile = (sock, o, ip) => {
    let n = 0; const w = sock.write.bind(sock);
    sock.write = (c, ...a) => { n += c.length; return n > 600000 ? false : w(c, ...a); };
    return orig(sock, o, ip);
  };
  const ac = new AbortController();
  const dlp = B.fetchPacked(m6.id, { signal: ac.signal });
  const inFile = B._inPaths(m6.id).part;
  await until(() => fs.existsSync(inFile) && fs.statSync(inFile).size >= 500000, 4000, 'sebagian terunduh');
  ac.abort();
  await assert.rejects(dlp, code('abort'));
  A._serveFile = orig;
  const left = fs.statSync(inFile).size;
  assert(left > 0 && left < 3 * 1048576);
  assert(same(f('rand.bin'), (await B.fetchPacked(m6.id)).path));
  ok('batal: .part (' + left + ' byte) disimpan lalu dilanjutkan di panggilan berikutnya');

  // ---- 7. berkas asli berubah / hilang setelah ditawarkan ----
  fs.writeFileSync(f('mut.bin'), crypto.randomBytes(500000));
  const m7 = await A.sendFile(f('mut.bin'), B.id);
  await gotMsg(B, m7.id);
  fs.appendFileSync(f('mut.bin'), 'x');
  await assert.rejects(B.fetchPacked(m7.id), code('changed'));
  fs.writeFileSync(f('mut2.bin'), crypto.randomBytes(500000));
  const m7b = await A.sendFile(f('mut2.bin'), B.id);
  await gotMsg(B, m7b.id);
  const t0 = new Date(Date.now() + 5000); fs.utimesSync(f('mut2.bin'), t0, t0); // ukuran sama, mtime beda
  await assert.rejects(B.fetchPacked(m7b.id), code('changed'));
  fs.writeFileSync(f('mut3.bin'), crypto.randomBytes(500000));
  const m7c = await A.sendFile(f('mut3.bin'), B.id);
  await gotMsg(B, m7c.id);
  fs.rmSync(f('mut3.bin'));
  await assert.rejects(B.fetchPacked(m7c.id), code('changed'));
  assert(!fs.existsSync(B._inPaths(m7.id).part));
  ok('berkas asli berubah (ukuran / mtime) atau hilang: ditolak "changed", tidak ada sisa .part');

  // ---- 8. dibatalkan pengirim: tidak bisa diambil lagi, sisa unduhan penerima dibuang ----
  const m8 = await A.sendFile(f('rand.bin'), B.id);
  await gotMsg(B, m8.id);
  fs.mkdirSync(path.dirname(B._inPaths(m8.id).part), { recursive: true });
  fs.writeFileSync(B._inPaths(m8.id).part, 'sisa');
  A.deleteMessage(m8.id);
  assert.strictEqual(JSON.parse(await rawGet(A, { t: 'file_get', id: m8.id, off: 0, hi: B.hello() })).err, 'gone');
  await until(() => !B.store.msgs[m8.id] && !fs.existsSync(B._inPaths(m8.id).part), 4000, 'penerima membuang pesan dan sisa unduhan');
  await assert.rejects(B.fetchPacked(m8.id), /tidak ditemukan/);
  ok('batal kirim: server menjawab "gone", penerima membuang sisa unduhan');

  // ---- 9. permintaan sampah tidak membuat server jatuh ----
  for (const bad of [{ id: 'xyz', off: 0 }, { id: m2.id, off: -1 }, { id: m2.id, off: 1.5 }, { id: m2.id, off: '0' }, { id: m2.id }, {}]) {
    assert.strictEqual(JSON.parse(await rawGet(A, Object.assign({ t: 'file_get', hi: B.hello() }, bad))).err, 'bad');
  }
  assert.strictEqual(JSON.parse(await rawGet(A, { t: 'file_get', id: m2.id, off: 3 * 1048576 + 1, hi: B.hello() })).err, 'range');
  assert.strictEqual(JSON.parse(await rawGet(A, { t: 'file_get', id: crypto.randomBytes(16).toString('hex'), off: 0, hi: B.hello() })).err, 'gone');
  for (const junk of ['null', '5', '"x"', '[1]']) await new Promise((r) => { const c = net.connect(A.port, '127.0.0.1', () => { c.write(junk + '\n'); setTimeout(() => { c.destroy(); r(); }, 50); }); });
  assert.strictEqual(JSON.parse(await asC(m1.id)).ok, true, 'server masih hidup');
  const r9 = await rawGet(A, { t: 'file_get', id: m2.id, off: 3 * 1048576, hi: B.hello() }); // offset = ukuran: nol byte
  assert.strictEqual(JSON.parse(r9).len, 0);
  ok('permintaan sampah (id/off aneh, JSON null/angka) ditolak rapi, server tetap hidup; off = ukuran berarti 0 byte');

  // ---- 10. batas koneksi: 3 per IP, tuntas dan bebas lagi setelah koneksi ditutup ----
  const held = [];
  for (let i = 0; i < 3; i++) {
    await new Promise((res) => {
      const c = net.connect({ host: '127.0.0.1', port: A.port }, () => { c.write(JSON.stringify({ t: 'file_get', id: m2.id, off: 0, hi: B.hello() }) + '\n'); c.pause(); res(); });
      c.on('error', () => {}); held.push(c);
    });
  }
  await until(() => A._up.size === 3, 2000, '3 slot terpakai');
  assert.strictEqual(JSON.parse(await asC(m1.id)).err, 'busy');
  held.forEach((c) => c.destroy());
  await until(() => A._up.size === 0, 3000, 'slot dilepas');
  assert.strictEqual(JSON.parse(await asC(m1.id)).ok, true);
  ok('maksimal 3 unduhan serentak per IP: yang ke-4 "busy", slot dilepas saat koneksi ditutup');

  // ---- 11. server curang: klien tidak percaya header ----
  const fake = (handler) => new Promise((res) => { const srv = net.createServer((c) => { c.on('error', () => {}); c.once('data', () => handler(c)); }); srv.listen(0, '127.0.0.1', () => res(srv)); });
  const dl = async (srv, total, part) => { try { return await Xfer.download({ ip: '127.0.0.1', port: srv.address().port }, { id: 'x' }, part, total); } finally { srv.close(); } };
  const P = (n) => f('fake-' + n + '.part');
  let srv = await fake((c) => { c.write(JSON.stringify({ t: 'file', ok: true, off: 0, len: 10 }) + '\n'); c.write(Buffer.alloc(50, 1)); });
  await assert.rejects(dl(srv, 10, P(1)), code('proto'));
  assert(fs.statSync(P(1)).size <= 10, 'tidak menulis lebih dari yang dijanjikan');
  srv = await fake((c) => { c.write(JSON.stringify({ t: 'file', ok: true, off: 5, len: 10 }) + '\n'); c.end(Buffer.alloc(10)); });
  await assert.rejects(dl(srv, 10, P(2)), code('proto'));
  srv = await fake((c) => { c.write(JSON.stringify({ t: 'file', ok: true, off: 0, len: 99 }) + '\n'); c.end(Buffer.alloc(99)); });
  await assert.rejects(dl(srv, 10, P(3)), code('proto'));
  srv = await fake((c) => { c.write(JSON.stringify({ t: 'file', ok: true, off: 0, len: 10 }) + '\n'); c.end(Buffer.alloc(4)); });
  await assert.rejects(dl(srv, 10, P(4)), code('net'));
  assert.strictEqual(fs.statSync(P(4)).size, 4, 'yang sudah diterima disimpan untuk resume');
  srv = await fake((c) => c.end('x'.repeat(Xfer.HEAD_MAX + 100)));
  await assert.rejects(dl(srv, 10, P(5)), code('proto'));
  srv = await fake((c) => c.end(JSON.stringify({ t: 'file', ok: false, err: '../../etc' }) + '\n'));
  await assert.rejects(dl(srv, 10, P(6)), code('proto'));
  srv = await fake((c) => c.end('bukan json\n'));
  await assert.rejects(dl(srv, 10, P(7)), code('proto'));
  ok('server curang: byte berlebih, offset/len salah, header raksasa, JSON rusak, kode error asing: semuanya ditolak, tanpa menulis lebih dari yang diminta');

  // ---- 12. enkripsi per potongan (2b) ----
  const rawBuf = (peer, req) => new Promise((res) => {
    const c = net.connect({ host: '127.0.0.1', port: peer.port }); const bufs = [];
    c.on('data', (d) => bufs.push(d)); c.on('close', () => res(Buffer.concat(bufs))); c.on('error', () => {});
    c.write(JSON.stringify(req) + '\n');
  });
  const split = (b) => { const i = b.indexOf(10); return { head: JSON.parse(b.subarray(0, i).toString()), body: b.subarray(i + 1) }; };
  const SEG = Xfer.SEG;
  fs.writeFileSync(f('enc.bin'), crypto.randomBytes(5 * SEG - 1234)); // 5 potongan, yang terakhir pendek
  const mE = await A.sendFile(f('enc.bin'), B.id);
  await gotMsg(B, mE.id);
  const psE = A.store.files[mE.id].meta.psize, plain = fs.readFileSync(f('enc.bin'));
  assert.strictEqual(psE, plain.length, 'acak: mode raw');

  // a. kabel: DM = ciphertext + tag (panjang persis wireLen), tidak ada potongan plaintext di dalamnya; publik = polos
  const wire = split(await rawBuf(A, { t: 'file_get', id: mE.id, off: 0, hi: B.hello() }));
  assert.strictEqual(wire.head.enc, 1);
  assert.strictEqual(wire.body.length, Xfer.wireLen(0, psE));
  assert.strictEqual(wire.body.length, psE + 5 * Xfer.TAG);
  assert(wire.body.indexOf(plain.subarray(0, 256)) < 0 && wire.body.indexOf(plain.subarray(SEG, SEG + 256)) < 0, 'plaintext tidak muncul di kabel');
  const pw = split(await rawBuf(A, { t: 'file_get', id: m4b.id, off: 0 }));
  assert(!pw.head.enc && Buffer.compare(pw.body, fs.readFileSync(f('pub.bin'))) === 0, 'publik tetap polos');
  const gw = split(await rawBuf(A, { t: 'file_get', id: m3.id, off: 0, hi: B.hello() }));
  assert.strictEqual(gw.head.enc, 1);
  assert(gw.body.indexOf(fs.readFileSync(f('rand.bin')).subarray(0, 256)) < 0, 'grup juga tersegel');

  // b. penyamar: C mengaku B dan lolos pemeriksaan identitas, tapi hanya mendapat ciphertext yang tidak bisa dibuka dengan kuncinya
  const peer = { ip: '127.0.0.1', port: A.port }, bad = (n) => f('enc-' + n + '.part');
  const asB = { id: mE.id, hi: B.hello() };
  await assert.rejects(Xfer.download(peer, asB, bad('c'), psE, { key: Xfer.fileKey(C._pairKey(A.id), A.id, mE.id) }), code('crypt'));
  assert.strictEqual(fs.statSync(bad('c')).size, 0, 'tidak ada byte yang ditulis dengan kunci salah');
  await assert.rejects(Xfer.download(peer, asB, bad('c2'), psE, { key: Xfer.fileKey(B._keyFor(B.store.msgs[mE.id]), B.id, mE.id) }), code('crypt')); // salah konteks (pengirim) juga gagal
  const goodKey = B._fileKey(B.store.msgs[mE.id]);
  assert(goodKey && goodKey.length === 32);
  assert.notDeepStrictEqual(goodKey, B._fileKey(B.store.msgs[m2.id]), 'kunci berbeda per berkas');

  // c. penurunan ke polos: pengirim palsu menjawab tanpa enc untuk berkas DM -> ditolak, tanpa menulis byte
  srv = await fake((c) => { c.write(JSON.stringify({ t: 'file', ok: true, off: 0, len: psE }) + '\n'); c.end(plain); });
  await assert.rejects(Xfer.download({ ip: '127.0.0.1', port: srv.address().port }, asB, bad('d'), psE, { key: goodKey }), code('proto'));
  srv.close();
  assert.strictEqual(fs.statSync(bad('d')).size, 0, 'penurunan ke polos: tidak ada byte masuk ke berkas');
  // kebalikannya: berkas publik tidak boleh dijawab terenkripsi
  srv = await fake((c) => { c.write(JSON.stringify({ t: 'file', ok: true, off: 0, len: 10, enc: 1, wl: 26 }) + '\n'); c.end(Buffer.alloc(26)); });
  await assert.rejects(dl(srv, 10, bad('e')), code('proto'));

  // d. perantara jahat: ubah satu bit / tukar urutan / tambah byte / potong. Potongan yang lolos tetap ditulis, yang rusak tidak.
  const mitm = (mutate) => new Promise((res) => {
    const sv = net.createServer((c) => {
      c.on('error', () => {}); const u = net.connect(A.port, '127.0.0.1'); u.on('error', () => c.destroy()); const bufs = [];
      c.once('data', (d) => u.write(d)); u.on('data', (d) => bufs.push(d));
      u.on('end', () => { const all = Buffer.concat(bufs), i = all.indexOf(10); c.end(Buffer.concat([all.subarray(0, i + 1), mutate(Buffer.from(all.subarray(i + 1)))])); });
    }); sv.listen(0, '127.0.0.1', () => res(sv));
  });
  const via = async (mutate, n) => { const sv = await mitm(mutate); try { return await Xfer.download({ ip: '127.0.0.1', port: sv.address().port }, asB, bad(n), psE, { key: goodKey }); } finally { sv.close(); } };
  const FR = SEG + Xfer.TAG;
  await assert.rejects(via((b) => { b[FR + 100] ^= 1; return b; }, 'flip'), code('crypt'));
  const fz = fs.statSync(bad('flip')).size;
  assert(fz <= SEG && fz % SEG === 0, 'potongan yang diubah tidak pernah ditulis, .part tetap sejajar potongan: ' + fz);
  assert(Buffer.compare(fs.readFileSync(bad('flip')), plain.subarray(0, fz)) === 0, 'yang tertulis = plaintext asli');
  await assert.rejects(via((b) => { b[b.length - 1] ^= 1; return b; }, 'tag'), code('crypt'));
  const tz = fs.statSync(bad('tag')).size;
  assert(tz <= 4 * SEG && tz % SEG === 0, 'potongan terakhir dengan tag rusak tidak ditulis: ' + tz);
  await assert.rejects(via((b) => { const x = Buffer.from(b.subarray(0, FR)); b.copy(b, 0, FR, 2 * FR); x.copy(b, FR); return b; }, 'swap'), code('crypt'));
  assert.strictEqual(fs.statSync(bad('swap')).size, 0, 'potongan ditukar: tidak ada yang lolos (potongan 0 pun gagal)');
  await assert.rejects(via((b) => Buffer.concat([b, Buffer.alloc(5)]), 'extra'), code('proto'));
  await assert.rejects(via((b) => b.subarray(0, 2 * FR + 500), 'cut'), code('net'));
  assert.strictEqual(fs.statSync(bad('cut')).size, 2 * SEG, 'putus di tengah potongan: hanya potongan utuh yang disimpan, siap resume');
  // dari .part sejajar itu, unduhan lanjut dan hasilnya identik dengan aslinya
  fs.copyFileSync(bad('cut'), B._inPaths(mE.id).part); // (folder in sudah ada dari tes sebelumnya)
  offs.length = 0; A._serveFile = (sock, o, ip) => { offs.push(o.off); return orig(sock, o, ip); };
  assert(same(f('enc.bin'), (await B.fetchPacked(mE.id)).path));
  assert.deepStrictEqual(offs, [2 * SEG]);
  A._serveFile = orig;

  // e. server menolak offset tak sejajar untuk DM/grup (tapi publik boleh), dan menolak bila kunci tidak ada
  assert.strictEqual(JSON.parse(await rawGet(A, { t: 'file_get', id: mE.id, off: 100, hi: B.hello() })).err, 'range');
  assert.strictEqual(JSON.parse(await rawGet(A, { t: 'file_get', id: m3.id, off: SEG + 1, hi: B.hello() })).err, 'range');
  assert.strictEqual(split(await rawBuf(A, { t: 'file_get', id: mE.id, off: SEG, hi: B.hello() })).body.length, Xfer.wireLen(SEG, psE));
  assert.strictEqual(JSON.parse(await rawGet(A, { t: 'file_get', id: m4b.id, off: 100 })).ok, true);
  const pk0 = A._pairKey.bind(A);
  A._pairKey = () => null;
  assert.strictEqual(JSON.parse(await rawGet(A, { t: 'file_get', id: mE.id, off: 0, hi: B.hello() })).err, 'nokey');
  A._pairKey = pk0;
  assert.strictEqual(JSON.parse(await rawGet(A, { t: 'file_get', id: mE.id, off: 0, hi: B.hello() })).ok, true);
  const mN = await A.sendFile(f('enc.bin'), B.id);
  await gotMsg(B, mN.id); B._offerOf(B.store.msgs[mN.id]); // isi cache teks supaya tawaran tetap terbaca saat kunci dicabut
  const bk0 = B._pairKey.bind(B); B._pairKey = () => null;
  await assert.rejects(B.fetchPacked(mN.id), code('nokey'));
  B._pairKey = bk0;

  // f. ukuran di sekitar batas potongan: tepat kelipatan, +/-1, sangat kecil
  for (const n of [1, SEG - 1, SEG, SEG + 1, 2 * SEG, 3 * SEG + 7]) {
    fs.writeFileSync(f('sz.bin'), crypto.randomBytes(n));
    const mz = await A.sendFile(f('sz.bin'), gid);
    await gotMsg(B, mz.id);
    assert(same(f('sz.bin'), (await B.fetchPacked(mz.id)).path), 'ukuran ' + n);
  }
  ok('enkripsi per potongan: kabel = ciphertext (DM/grup), penyamar tak bisa membuka, penurunan ke polos ditolak, potongan diubah/ditukar/ditambah ditolak sebelum ditulis, resume sejajar, offset tak sejajar dan kunci hilang ditolak, ukuran batas potongan lolos');

  // ---- 13. pengirim offline: gagal rapi dengan batas coba ulang ----
  const m12 = await A.sendFile(f('rand.bin'), B.id);
  await gotMsg(B, m12.id);
  await A.stop();
  const t1 = Date.now();
  await assert.rejects(B.fetchPacked(m12.id, { retries: 2, retryMs: 20 }), code('net'));
  assert(Date.now() - t1 < 5000);
  ok('pengirim mati: gagal "net" setelah coba ulang terbatas, tidak menggantung');

  await B.stop(); await C.stop();
  console.log(`\n${pass} tes lulus`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

'use strict';
// Tes dorongan otomatis ke kurir + pencabutan (v0.7.0 tahap 4, langkah 4b-2).
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const Xfer = require('../src/archne-xfer');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-escauto-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150, escBackoff: 0.02 }, o));
const f = (n) => path.join(tmp, n);
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
const escFiles = (c) => ls(path.join(c.opts.dataDir, 'esc'));
const online = (c, n) => c.getState().peers.filter((p) => p.online).length >= n;
const mesh = async (cores, n) => { await until(() => cores.every((c) => online(c, n)), 6000, 'jaringan'); };
const plain = fs.readFileSync.bind(fs);

(async () => {
  fs.writeFileSync(f('rand.bin'), crypto.randomBytes(1500000));
  const T0 = 1700000000; fs.utimesSync(f('rand.bin'), T0, T0);
  // plaintext hasil buka segel byte di kurir, memakai kunci DM pengirim
  const open = (sender, m, core) => new Promise((res, rej) => {
    const total = sender.store.files[m.id].meta.psize, chunks = [];
    const op = new Xfer.Opener(sender._fileKey(m), total, 0);
    op.on('data', (c) => chunks.push(c)); op.on('end', () => res(Buffer.concat(chunks))); op.on('error', rej);
    fs.createReadStream(core._escFile(m.id)).pipe(op);
  });
  const holders = (cs, id) => cs.filter((c) => c.store.esc[id] && c.store.esc[id].done);

  // ---- 1. dorongan otomatis, dua replika, dibuang begitu penerima menerima ----
  const A = mk('A'), K1 = mk('K1'), K2 = mk('K2'), K3 = mk('K3'), C = mk('C');
  const all1 = [A, K1, K2, K3, C];
  for (const c of all1) await c.start();
  for (const c of [K1, K2, K3, C]) await A.addPeer('127.0.0.1', c.port);
  await until(() => online(A, 4) && A.peers.get(C.id).xpub, 6000, 'A kenal semua');
  await C.stop();
  const m1 = await A.sendFile(f('rand.bin'), C.id);
  await until(() => holders([K1, K2, K3], m1.id).length === 2, 12000, 'dua kurir memegang berkas');
  await sleep(1200); // kurir ketiga tidak boleh ikut: cukup dua replika
  const hs = holders([K1, K2, K3], m1.id);
  assert.strictEqual(hs.length, 2);
  assert.strictEqual(Object.keys(A.store.files[m1.id].pushed).length, 2);
  assert((await open(A, m1, hs[0])).equals(plain(f('rand.bin'))) && (await open(A, m1, hs[1])).equals(plain(f('rand.bin'))));
  const noneYet = [K1, K2, K3].find((c) => !hs.includes(c));
  assert(!noneYet.store.esc[m1.id] && !escFiles(noneYet).length);
  ok('berkas didorong otomatis ke tepat dua kurir (byte benar); kurir ketiga tidak dibebani');

  const C2 = mk('C'); // penerima online lagi; hanya bertemu A
  await C2.start(); await C2.addPeer('127.0.0.1', A.port);
  await until(() => A.getState().messages.find((m) => m.id === m1.id).status === 'delivered', 8000, 'terkirim');
  await sleep(800);
  assert.strictEqual(holders([K1, K2, K3], m1.id).length, 2, 'tanda terima PESAN tidak membuang byte: penerima belum mengambil berkasnya');
  await C2.receiveFile(m1.id); // berkas diambil langsung dari pengirim; tanda terima berkas dibuat penerima
  await until(() => A.store.freceipts[m1.id], 8000, 'pengirim membawa tanda terima berkas');
  await until(() => [K1, K2, K3].every((c) => !c.store.esc[m1.id] && !escFiles(c).length), 10000, 'kurir membuang berkas');
  assert(plain(C2.store.got[m1.id].path).equals(plain(f('rand.bin'))));
  ok('tanda terima pesan tidak membuang byte; setelah penerima memegang berkasnya, tanda terima berkas lewat pengirim membuang byte di semua kurir');
  await Promise.all(all1.filter((c) => c !== C).concat([C2]).map((c) => c.stop()));

  // ---- 2. kurir yang menolak tidak dihujani permintaan ----
  const A2 = mk('A2'), Q = mk('Q', { escQuota: 1000000 }), E = mk('E');
  for (const c of [A2, Q, E]) await c.start();
  await A2.addPeer('127.0.0.1', Q.port); await A2.addPeer('127.0.0.1', E.port);
  await until(() => online(A2, 2) && A2.peers.get(E.id).xpub, 5000, 'A2 kenal');
  await E.stop();
  const results = [];
  const qq = Q._escQuery.bind(Q); Q._escQuery = (o) => { const r = qq(o); results.push(r.ok ? 'ok' : r.err); return r; };
  const m2 = await A2.sendFile(f('rand.bin'), E.id);
  await until(() => results.includes('quota'), 8000, 'kurir menjawab quota');
  await sleep(2000);
  assert.strictEqual(results.filter((x) => x === 'quota').length, 1, 'hanya sekali bertanya: ' + results.join(','));
  assert(!Q.store.esc[m2.id] && !escFiles(Q).length);
  assert(results.slice(0, results.indexOf('quota')).every((x) => x === 'nocustody'));
  ok('kurir tanpa titipan dicoba ulang dengan jeda; kurir yang kuotanya penuh hanya ditanya sekali (jeda panjang)');
  await Promise.all([A2, Q].map((c) => c.stop()));

  // ---- 3. bertahan lewat restart; catatan basi dicek ulang tanpa byte ----
  const A3 = mk('A3'), K = mk('K'), F = mk('F');
  for (const c of [A3, K, F]) await c.start();
  await A3.addPeer('127.0.0.1', K.port); await A3.addPeer('127.0.0.1', F.port);
  await until(() => online(A3, 2) && A3.peers.get(F.id).xpub, 5000, 'A3 kenal');
  await F.stop();
  const m3 = await A3.sendFile(f('rand.bin'), F.id);
  await until(() => A3.store.files[m3.id].pushed && A3.store.files[m3.id].pushed[K.id], 10000, 'terdorong ke K');
  await A3.stop();
  let asks = 0; const kq = K._escQuery.bind(K); K._escQuery = (o) => { asks++; return kq(o); };
  const A3b = mk('A3');
  await A3b.start(); await A3b.addPeer('127.0.0.1', K.port);
  await until(() => online(A3b, 1), 4000, 'A3 online lagi');
  await sleep(1500);
  assert.strictEqual(asks, 0, 'tidak bertanya lagi setelah restart');
  ok('kurir yang sudah lengkap dicatat dan tidak dihubungi lagi setelah restart');
  A3b.store.files[m3.id].pushed[K.id] = Date.now() - 7 * 864e5; // basi
  let sent = 0; const putOrig = Xfer.put; Xfer.put = (...a) => { sent++; return putOrig(...a); };
  await until(() => A3b.store.files[m3.id].pushed[K.id] > Date.now() - 5000, 6000, 'dicek ulang');
  Xfer.put = putOrig;
  assert(asks >= 1 && sent === 0, `dicek ulang tanpa kirim byte: asks=${asks} sent=${sent}`);
  ok('catatan yang sudah basi dicek ulang ke kurir (masih memegang -> diperbarui tanpa byte)');

  // ---- 4. pencabutan langsung ----
  assert(K.store.esc[m3.id].done);
  const psize3 = A3b.store.files[m3.id].meta.psize;
  A3b.deleteMessage(m3.id);
  assert(A3b.store.revokes[m3.id], 'pencabutan dibuat saat batal kirim');
  await until(() => !K.store.esc[m3.id] && K.store.revokes[m3.id], 6000, 'K membuang');
  await K.flushCleanup();
  assert(!escFiles(K).length);
  assert.strictEqual(K._escQuery({ id: m3.id, psize: psize3 }).err, 'gone');
  assert.strictEqual(K._escReserve(m3.id, psize3).code, 'gone');
  ok('batal kirim: kurir membuang byte berkas lewat sinkronisasi dan menolak dorongan berikutnya');

  // clear chat juga mencabut
  const m3b = await A3b.sendFile(f('rand.bin'), F.id);
  await until(() => K.store.esc[m3b.id] && K.store.esc[m3b.id].done, 10000, 'm3b di K');
  A3b.clearChat(F.id);
  await until(() => !K.store.esc[m3b.id], 6000, 'K membuang setelah clear chat');
  ok('Bersihkan chat di pengirim juga mencabut titipan berkas');

  // pencabutan palsu
  const X = mk('X'); await X.start();
  const fake = (id, by, pub, key, tag = 'archne-revoke1:') => ({ id, by, pub, sig: crypto.sign(null, Buffer.from(tag + id), key).toString('base64') });
  const m3c = await A3b.sendFile(f('rand.bin'), F.id);
  await until(() => K.store.esc[m3c.id] && K.store.esc[m3c.id].done, 10000, 'm3c di K');
  const nRv = Object.keys(K.store.revokes).length;
  assert.strictEqual(K._addRevoke(fake(m3c.id, X.id, X.pub, X.privKey)), false);                       // pencabut bukan pengirim pesan
  assert.strictEqual(K._addRevoke(fake(m3c.id, A3b.id, A3b.pub, X.privKey)), false);                   // tanda tangan palsu
  assert.strictEqual(K._addRevoke(fake(m3c.id, A3b.id, A3b.pub, A3b.privKey, 'archne-rcpt1:')), false); // tag lain
  assert.strictEqual(K._addRevoke(fake('d'.repeat(32), X.id, X.pub, X.privKey)), false);                // bukan titipan kita
  assert.strictEqual(Object.keys(K.store.revokes).length, nRv);
  assert(K.store.esc[m3c.id] && K._escQuery({ id: m3c.id, psize: A3b.store.files[m3c.id].meta.psize }).ok);
  ok('pencabutan palsu (pengirim lain, tanda tangan/tag salah, bukan titipan kita) diabaikan dan tidak disimpan');
  await Promise.all([A3b, K, X].map((c) => c.stop()));

  // ---- 5. pencabutan dibawa peer lain ke kurir yang offline saat itu ----
  const A4 = mk('A4'), K4 = mk('K4'), D = mk('D'), G = mk('G');
  for (const c of [A4, K4, D, G]) await c.start();
  for (const c of [K4, D, G]) await A4.addPeer('127.0.0.1', c.port);
  await D.addPeer('127.0.0.1', K4.port);
  await until(() => online(A4, 3) && A4.peers.get(G.id).xpub, 6000, 'jaringan 5');
  await G.stop();
  const m4 = await A4.sendFile(f('rand.bin'), G.id);
  await until(() => holders([K4, D], m4.id).length === 2, 12000, 'K4 dan D memegang berkas');
  const k4Dir = K4.opts.dataDir;
  await K4.stop();                                  // K4 mati sebelum pesan dibatalkan
  A4.deleteMessage(m4.id);
  await until(() => D.store.revokes[m4.id], 8000, 'D menerima pencabutan dari A4');
  await until(() => !D.store.esc[m4.id], 3000, 'D membuang');
  await A4.stop();                                  // pengirim hilang untuk selamanya
  const K4b = new Core({ dataDir: k4Dir, downloadDir: f('K4-dl'), name: 'K4', discovery: false, tickMs: 100, syncMs: 150 });
  await K4b.start();
  assert(K4b.store.esc[m4.id] && K4b.store.esc[m4.id].done, 'K4 masih memegang berkas saat bangun');
  assert(!K4b.store.revokes[m4.id]);
  await K4b.addPeer('127.0.0.1', D.port);           // K4 hanya bertemu D
  await until(() => !K4b.store.esc[m4.id] && K4b.store.revokes[m4.id], 8000, 'K4 menerima pencabutan lewat D');
  await K4b.flushCleanup();
  assert(!escFiles(K4b).length);
  ok('kurir yang offline saat pesan dibatalkan menerima pencabutan lewat peer lain, tanpa bertemu pengirim');

  console.log(`\nSEMUA TES DORONG OTOMATIS + PENCABUTAN LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e.stack || e.message); process.exit(1); });

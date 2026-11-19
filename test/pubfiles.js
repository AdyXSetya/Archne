'use strict';
// Tes berkas publik/grup saat pengirim offline (v0.7.1): sync lebih cepat, peer yang sudah mengunduh ikut melayani (seed),
// dan kolam kurir khusus publik (terpisah dari kolam DM, penuh -> LRU).
const os = require('os'), path = require('path'), fs = require('fs'), net = require('net'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const Xfer = require('../src/archne-xfer');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pubfiles-'));
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
const seedFiles = (c) => ls(path.join(c.opts.dataDir, 'seed'));
const escFiles = (c) => ls(path.join(c.opts.dataDir, 'esc'));
const online = (c, n) => c.getState().peers.filter((p) => p.online).length >= n;
const FAST = { retries: 0, retryMs: 0 };
const holds = (c, id) => !!(c.store.esc[id] && c.store.esc[id].done);
const rawGet = (core, id, hi, off = 0) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port: core.port }, () => s.write(JSON.stringify({ t: 'file_get', id, off, hi }) + '\n'));
  let buf = Buffer.alloc(0), done = false;
  const fin = (v) => { if (!done) { done = true; s.destroy(); res(v); } };
  s.on('data', (d) => { buf = Buffer.concat([buf, d]); const i = buf.indexOf(10); if (i >= 0) { try { fin(JSON.parse(buf.subarray(0, i).toString())); } catch { fin(null); } } });
  s.on('error', () => fin(null)); s.on('close', () => fin(null));
});
const MB = 1048576;

(async () => {
  fs.writeFileSync(f('rand.bin'), crypto.randomBytes(1500000));              // tidak terkompres: mode raw
  fs.writeFileSync(f('text.txt'), 'baris teks yang berulang-ulang\n'.repeat(60000)); // terkompres: mode br (psize < size)
  const origRand = fs.readFileSync(f('rand.bin')), origText = fs.readFileSync(f('text.txt'));
  const connect = async (a, ...others) => {
    for (const o of others) await a.addPeer('127.0.0.1', o.port);
    await until(() => online(a, others.length) && others.every((o) => o.peers.get(a.id) && o.peers.get(a.id).xpub), 6000, 'saling kenal');
  };

  // ---- 1. sync: interval bawaan 8 dtk, dan peer yang baru offline memicu sync langsung ----
  {
    const A = new Core({ dataDir: path.join(tmp, 'p1A'), name: 'p1A', discovery: false, tickMs: 100 }); // syncMs bawaan
    const B = mk('p1B', { syncMs: 60000 });
    await A.start(); await B.start(); await A.addPeer('127.0.0.1', B.port);
    await until(() => A._sy.get(B.id), 4000, 'jadwal sync A-B');
    const wait = A._sy.get(B.id).next - Date.now();
    assert(wait > 0 && wait <= 8000 * 1.2 + 200, 'interval bawaan 8 dtk (±20%): ' + wait);
    await B.stop(); await A.stop();

    const X = mk('p1X', { syncMs: 60000 }), Y = mk('p1Y', { syncMs: 60000 }), Z = mk('p1Z', { syncMs: 60000 });
    await X.start(); await Y.start(); await Z.start();
    await connect(X, Y, Z);
    await until(() => X._sy.get(Y.id) && X._on.get(Z.id) === true, 4000, 'X sudah mencatat Z online');
    let calls = 0; const orig = X._syncFrom.bind(X); X._syncFrom = (p) => { if (p.id === Y.id) calls++; return orig(p); };
    await sleep(500);
    assert.strictEqual(calls, 0, 'jadwal berkala 60 dtk: belum ada sync');
    await Z.stop();
    X.peers.get(Z.id).lastSeen = 0; // Z dianggap baru saja offline
    await until(() => calls >= 1, 2000, 'sync segera setelah Z offline');
    ok('sync bawaan 8 dtk; peer yang baru offline membuat peer lain langsung disinkronkan (tanpa menunggu jadwal)');
    await X.stop(); await Y.stop();
  }

  // ---- 2. publik: peer yang sudah mengunduh ikut melayani walau pengirim offline (raw dan br), lalu ikut jadi seed ----
  {
    const A = mk('p2A', { escPush: false }), B = mk('p2B', { escPush: false }), C = mk('p2C', { escPush: false });
    await A.start(); await B.start(); await C.start();
    await connect(A, B);
    const mr = await A.sendFile(f('rand.bin'), 'public'), mt = await A.sendFile(f('text.txt'), 'public');
    await until(() => B.store.msgs[mr.id] && B.store.msgs[mt.id], 4000, 'B menerima tawaran');
    assert.strictEqual(B.getState().messages.find((m) => m.id === mt.id).file.mode, 'br', 'berkas teks memang terkompres');
    const r1 = await B.receiveFile(mr.id), r2 = await B.receiveFile(mt.id);
    assert(fs.readFileSync(r1.path).equals(origRand) && fs.readFileSync(r2.path).equals(origText));
    assert(B.store.seeds[mr.id] && B.store.seeds[mt.id], 'B menyimpan salinan seed');
    assert.deepStrictEqual(seedFiles(B), [mr.id + '.pk', mt.id + '.pk'].sort());
    assert.strictEqual(B.store.seeds[mt.id].psize, B.getState().messages.find((m) => m.id === mt.id).file.psize, 'seed = bentuk terkemas (psize)');
    assert(!fs.existsSync(B._inPaths(mr.id).pk), '.pk dipindah jadi seed, tidak ada salinan ganda');
    await A.stop(); // pengirim offline
    await connect(C, B);
    await until(() => C.store.msgs[mr.id] && C._holdersOf(mr.id).includes(B.id) && C._holdersOf(mt.id).includes(B.id), 6000, 'B mengumumkan seed ke C');
    assert(!C.isOnline(C.peers.get(A.id)));
    const st = C.getState().messages.find((m) => m.id === mr.id);
    assert.strictEqual(st.file.held, 1, 'kartu C: tersedia di 1 peer lain');
    const q1 = await C.receiveFile(mr.id, FAST), q2 = await C.receiveFile(mt.id, FAST);
    assert(fs.readFileSync(q1.path).equals(origRand) && fs.readFileSync(q2.path).equals(origText), 'identik dengan aslinya (hash terverifikasi)');
    assert(C.store.seeds[mr.id] && C.store.seeds[mt.id], 'C ikut jadi seed');
    ok('publik: pengirim offline, berkas (raw dan terkompres) diambil dari peer yang sudah mengunduh; pengunduh baru ikut menjadi seed');

    // peminta sembarang boleh (publik), offset resume sembarang boleh, offset di luar ukuran ditolak
    const h = await rawGet(B, mr.id, { id: 'f'.repeat(16) }, 12345);
    assert(h && h.ok && h.off === 12345 && !h.enc, 'publik: polos, resume dari offset mana pun');
    const h2 = await rawGet(B, mr.id, { id: 'f'.repeat(16) }, 99 * MB);
    assert(h2 && h2.ok === false && h2.err === 'range');
    ok('seed publik dilayani polos ke siapa saja, resume dari offset mana pun, offset di luar ukuran ditolak');

    // ---- 3. pemegang yang memberi data salah: ditandai, tidak dicoba lagi; pengirim tetap sumber yang benar ----
    const D = mk('p2D', { escPush: false });
    await D.start();
    const fd = fs.openSync(B._seedPath(mr.id), 'r+'); const bb = Buffer.alloc(1); fs.readSync(fd, bb, 0, 1, 777); bb[0] ^= 0xff; fs.writeSync(fd, bb, 0, 1, 777); fs.closeSync(fd);
    fs.rmSync(path.join(C.opts.dataDir, 'seed'), { recursive: true, force: true }); delete C.store.seeds[mr.id]; delete C.store.seeds[mt.id]; // hanya B yang jadi sumber
    await connect(D, B);
    await until(() => D.store.msgs[mr.id] && D._holdersOf(mr.id).includes(B.id), 6000, 'D tahu B memegang');
    await assert.rejects(() => D.receiveFile(mr.id, FAST), (e) => ['hash', 'corrupt', 'size'].includes(e.code));
    assert(D._bad.get(mr.id) && D._bad.get(mr.id).has(B.id), 'B ditandai memberi data salah');
    assert(!D._holdersOf(mr.id).includes(B.id), 'B tidak lagi dipakai untuk berkas ini');
    assert(!fs.existsSync(D._inPaths(mr.id).pk), 'data rusak dibuang');
    const A2 = mk('p2A', { escPush: false }); await A2.start(); await A2.addPeer('127.0.0.1', D.port); // identitas A sama (dataDir sama)
    await until(() => D.isOnline(D.peers.get(A.id)), 6000, 'pengirim online lagi');
    const d1 = await D.receiveFile(mr.id, FAST);
    assert(fs.readFileSync(d1.path).equals(origRand), 'pengirim asli melayani dengan benar');
    ok('data salah dari pemegang terdeteksi lewat SHA-256 tawaran: pemegangnya ditandai, unduhan dibuang, pengirim asli tetap bisa dipakai');
    await Promise.all([A2, B, C, D].map((c) => c.stop()));
  }

  // ---- 4. grup: anggota yang sudah mengunduh melayani anggota lain (tersegel); bukan anggota ditolak ----
  {
    const A = mk('p4A', { escPush: false }), B = mk('p4B', { escPush: false }), C = mk('p4C', { escPush: false });
    await A.start(); await B.start(); await C.start();
    await connect(A, B, C);
    await connect(B, C);
    const g = A.createGroup('Tim', [B.id, C.id]);
    await until(() => B.store.groups[g.id] && C.store.groups[g.id], 6000, 'undangan grup');
    const m = await A.sendFile(f('rand.bin'), 'g:' + g.id);
    await until(() => B.store.msgs[m.id] && C.store.msgs[m.id], 6000, 'tawaran grup sampai');
    const r = await B.receiveFile(m.id);
    assert(fs.readFileSync(r.path).equals(origRand));
    assert(B.store.seeds[m.id], 'anggota B menyimpan seed grup');
    await until(() => C._holdersOf(m.id).includes(B.id), 6000, 'B mengumumkan seed ke C');
    await A.stop();
    C.peers.get(A.id).lastSeen = 0; // A sudah berhenti; jangan menunggu 12 dtk sampai C menganggapnya offline
    const c1 = await C.receiveFile(m.id, FAST);
    assert(fs.readFileSync(c1.path).equals(origRand), 'C mengambil dari B, byte tersegel diverifikasi per potongan');
    const hx = await rawGet(B, m.id, { id: 'e'.repeat(16) });
    assert(hx && hx.ok === false && hx.err === 'denied', 'bukan anggota grup: ditolak');
    const hm = await rawGet(B, m.id, { id: C.id });
    assert(hm && hm.ok && hm.enc === 1, 'anggota: dilayani tersegel');
    ok('grup: anggota yang sudah mengunduh melayani anggota lain saat pengirim offline (tersegel, diverifikasi per potongan); bukan anggota ditolak');
    await Promise.all([B, C].map((c) => c.stop()));
  }

  // ---- 5. DM tidak di-seed; seed ikut dibuang saat pesan dibatalkan / chat dibersihkan; batas kuota seed (LRU) ----
  {
    const A = mk('p5A', { escPush: false }), B = mk('p5B', { escPush: false, seedQuota: 2.5 * MB });
    await A.start(); await B.start(); await connect(A, B);
    const dm = await A.sendFile(f('rand.bin'), B.id);
    await until(() => B.store.msgs[dm.id], 4000, 'DM sampai');
    await B.receiveFile(dm.id);
    assert.deepStrictEqual(Object.keys(B.store.seeds), []);
    assert.deepStrictEqual(seedFiles(B), [], 'DM tidak di-seed');

    fs.writeFileSync(f('a1.bin'), crypto.randomBytes(MB)); fs.writeFileSync(f('a2.bin'), crypto.randomBytes(MB)); fs.writeFileSync(f('a3.bin'), crypto.randomBytes(MB));
    const ms = [];
    for (const n of ['a1.bin', 'a2.bin', 'a3.bin']) { const m = await A.sendFile(f(n), 'public'); ms.push(m); await until(() => B.store.msgs[m.id], 4000, 'tawaran'); await B.receiveFile(m.id); await sleep(5); }
    assert.deepStrictEqual(Object.keys(B.store.seeds).sort(), [ms[1].id, ms[2].id].sort(), 'kuota 2,5 MB: yang paling lama dibuang');
    await B.flushCleanup();
    assert.deepStrictEqual(seedFiles(B), [ms[1].id + '.pk', ms[2].id + '.pk'].sort());

    A.deleteMessage(ms[1].id); // batal kirim
    await until(() => !B.store.seeds[ms[1].id], 6000, 'seed dibuang saat pesan dibatalkan');
    B.clearChat('public');
    assert.deepStrictEqual(Object.keys(B.store.seeds), []);
    await B.flushCleanup();
    assert.deepStrictEqual(seedFiles(B), [], 'bersihkan chat membuang seed');
    ok('DM tidak di-seed; kuota seed membuang yang paling lama; batal kirim dan bersihkan chat membuang seed dan berkasnya');
    await A.stop(); await B.stop();
  }

  // ---- 6. kolam kurir publik: pengirim menitipkan polos, penerima baru mengambil walau pengirim dan pengunduh lain tidak ada ----
  {
    const A = mk('p6A'), K = mk('p6K'), D = mk('p6D');
    await A.start(); await K.start(); await D.start();
    await connect(A, K);
    const m = await A.sendFile(f('text.txt'), 'public');
    await until(() => holds(K, m.id), 15000, 'kurir memegang berkas publik');
    const e = K.store.esc[m.id];
    assert.strictEqual(e.to, 'public');
    assert.strictEqual(e.wl, e.psize, 'publik: polos, tanpa segel');
    assert.deepStrictEqual(K.escUsage(), { used: 0, count: 0, quota: 500 * MB }, 'kolam DM tidak tersentuh');
    assert.deepStrictEqual(K.escUsagePub(), { used: e.psize, count: 1, quota: 500 * MB });
    assert(fs.readFileSync(K._escPaths(m.id).bin).length === e.psize);
    await until(() => A.getState().messages.find((x) => x.id === m.id).file.pushed >= 1, 6000, 'kartu pengirim: dipegang peer lain');
    await A.stop();
    await connect(D, K);
    await until(() => D.store.msgs[m.id] && D._holdersOf(m.id).includes(K.id), 6000, 'K mengumumkan ke D');
    const r = await D.receiveFile(m.id, FAST);
    assert(fs.readFileSync(r.path).equals(origText));
    ok('kurir publik: berkas publik dititipkan polos ke kolam publik (kolam DM tak tersentuh) dan diambil penerima baru saat pengirim offline');
    await K.stop(); await D.stop();
  }

  // ---- 7. kolam publik penuh: LRU (tidak menolak yang baru); per pengirim tidak saling menggusur; tidak bolak-balik ----
  {
    const K = mk('p7K', { pubQuota: 2.5 * MB, pubPerSender: 1.2 * MB, escReplicas: 1 });
    const A1 = mk('p7A1', { escReplicas: 1 }), A2 = mk('p7A2', { escReplicas: 1 });
    await K.start(); await A1.start(); await A2.start();
    await connect(A1, K); await connect(A2, K);
    fs.writeFileSync(f('b1.bin'), crypto.randomBytes(MB)); fs.writeFileSync(f('b2.bin'), crypto.randomBytes(MB)); fs.writeFileSync(f('b3.bin'), crypto.randomBytes(MB));
    const m2 = await A2.sendFile(f('b3.bin'), 'public');
    await until(() => holds(K, m2.id), 12000, 'berkas A2 dipegang');
    const n1 = await A1.sendFile(f('b1.bin'), 'public');
    await until(() => holds(K, n1.id), 12000, 'berkas A1 #1 dipegang');
    const n2 = await A1.sendFile(f('b2.bin'), 'public');
    await until(() => holds(K, n2.id), 12000, 'berkas A1 #2 dipegang');
    assert(!K.store.esc[n1.id], 'per pengirim 1,2 MB: berkas lama A1 digusur oleh berkas barunya sendiri');
    assert(holds(K, m2.id), 'berkas A2 tidak digusur oleh A1');
    assert(K.escUsagePub().used <= 2.5 * MB && K.escUsage().used === 0);
    await sleep(1500); // tidak ada dorong ulang berkas yang tergusur
    assert(!K.store.esc[n1.id], 'berkas yang tergusur tidak didorong ulang bolak-balik');
    ok('kolam publik penuh: yang lama dibuang (LRU) alih-alih menolak; batas per pengirim hanya menggusur milik pengirim itu sendiri; tidak didorong ulang bolak-balik');

    // kuota total: LRU lintas pengirim
    const K2 = mk('p7K2', { pubQuota: 2.5 * MB, pubPerSender: 2.5 * MB, escReplicas: 1 });
    await K2.start(); await connect(A1, K2);
    await A1.stop(); await A2.stop(); await K.stop();
    const B1 = mk('p7B1', { escReplicas: 1 }); await B1.start(); await connect(B1, K2);
    const ids = [];
    for (const n of ['b1.bin', 'b2.bin', 'b3.bin']) { const m = await B1.sendFile(f(n), 'public'); ids.push(m.id); await until(() => holds(K2, m.id), 12000, 'dipegang ' + n); await sleep(20); }
    assert.deepStrictEqual(Object.keys(K2.store.esc).sort(), [ids[1], ids[2]].sort(), 'kuota total: yang paling lama tidak dipakai digusur');
    await K2.flushCleanup();
    assert.deepStrictEqual(escFiles(K2), [ids[1] + '.bin', ids[2] + '.bin'].sort());
    ok('kuota total kolam publik: yang paling lama tidak dipakai digusur, berkasnya ikut terhapus dari disk');

    // ---- 8. batal kirim mencabut titipan publik; kedaluwarsa 3 hari (di sini dipercepat) ----
    B1.deleteMessage(ids[2]);
    await until(() => !K2.store.esc[ids[2]], 8000, 'pencabutan titipan publik');
    await K2.flushCleanup();
    assert.deepStrictEqual(escFiles(K2), [ids[1] + '.bin']);
    ok('batal kirim berkas publik mencabut titipannya di kurir publik');
    await B1.stop(); await K2.stop();

    const T = mk('p8T', { pubTtlMs: 600 }), S = mk('p8S', { escReplicas: 1 });
    await T.start(); await S.start(); await connect(S, T);
    const tm = await S.sendFile(f('b1.bin'), 'public');
    await until(() => holds(T, tm.id), 12000, 'dipegang sebentar');
    await until(() => !T.store.esc[tm.id], 8000, 'kedaluwarsa kolam publik');
    ok('titipan kolam publik kedaluwarsa sesuai TTL kolam publik');
    await S.stop(); await T.stop();
  }

  // ---- 9. keamanan kolam publik: hanya pengirim asli, ukuran harus sama dengan tawaran, polos/tersegel tidak tertukar ----
  {
    const A = mk('p9A', { escPush: false }), K = mk('p9K'), X = mk('p9X', { escPush: false });
    await A.start(); await K.start(); await X.start();
    await connect(A, K); await connect(X, K);
    const m = await A.sendFile(f('rand.bin'), 'public');
    await until(() => K.store.msgs[m.id], 4000, 'K punya tawaran');
    const psize = A.store.files[m.id].meta.psize, kp = X.peers.get(K.id);
    const q0 = await X._request(kp, { t: 'esc_q', id: m.id, psize: psize + 1 });
    assert(q0 && q0.ok === false && q0.err === 'bad', 'ukuran harus sama dengan tawaran: ' + JSON.stringify(q0));
    const q = await X._request(kp, { t: 'esc_q', id: m.id, psize });
    assert(q && q.ok && q.wl === psize, 'publik: wl = psize (polos)');
    const sig = (n) => crypto.sign(null, Buffer.from('archne-put1:' + m.id + ':' + psize + ':' + n), X.privKey).toString('base64');
    await assert.rejects(() => Xfer.put(kp, { id: m.id, psize, off: 0, nonce: q.nonce, sig: sig(q.nonce), hi: X.hello(), plain: 1 }, f('rand.bin'), 0, null, psize), (e) => e.code === 'auth');
    assert(!K.store.esc[m.id], 'penyusup tidak bisa mengisi slot dengan tanda tangannya sendiri');
    const ak = A.peers.get(K.id);
    const qa = await A._request(ak, { t: 'esc_q', id: m.id, psize });
    assert(qa && qa.ok, 'pengirim asli lolos esc_q: ' + JSON.stringify(qa));
    const asig = crypto.sign(null, Buffer.from('archne-put1:' + m.id + ':' + psize + ':' + qa.nonce), A.privKey).toString('base64');
    await assert.rejects(() => Xfer.put(ak, { id: m.id, psize, off: 0, nonce: qa.nonce, sig: asig, hi: A.hello() }, f('rand.bin'), 0, crypto.randomBytes(32), psize), (e) => e.code === 'bad');
    ok('kolam publik: ukuran harus sama dengan tawaran bertanda tangan; hanya pengirim asli bisa mengisi; dorongan tersegel untuk berkas publik ditolak');

    // seed lama tanpa rekaman dibuang saat aplikasi dibuka
    const stray = path.join(tmp, 'p9Z', 'seed'); fs.mkdirSync(stray, { recursive: true });
    const orphan = path.join(stray, crypto.randomBytes(16).toString('hex') + '.pk'); fs.writeFileSync(orphan, 'x');
    const Z = mk('p9Z', { escPush: false }); await Z.start();
    assert(!fs.existsSync(orphan), 'sisa seed tanpa rekaman disapu');
    ok('sisa berkas seed tanpa rekaman disapu saat aplikasi dibuka');
    await Promise.all([A, K, X, Z].map((c) => c.stop()));
  }

  console.log(`\nSEMUA TES BERKAS PUBLIK LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('\nTES GAGAL: ' + e.stack); process.exit(1); });

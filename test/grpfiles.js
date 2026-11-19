'use strict';
// Tes titipan berkas GRUP di anggota (v0.7.2): pengirim mendorong byte tersegel ke anggota grup yang online (walau belum menekan Terima),
// anggota lain mengambil dari mereka saat pengirim offline. Kolam sendiri (500 MB total, 50 MB per berkas/pengirim, 3 hari, LRU).
const os = require('os'), path = require('path'), fs = require('fs'), net = require('net'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const Xfer = require('../src/archne-xfer');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-grpfiles-'));
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
  fs.writeFileSync(f('rand.bin'), crypto.randomBytes(1500000));
  const orig = fs.readFileSync(f('rand.bin'));
  const connect = async (a, ...others) => {
    for (const o of others) await a.addPeer('127.0.0.1', o.port);
    await until(() => online(a, others.length) && others.every((o) => o.peers.get(a.id) && o.peers.get(a.id).xpub), 6000, 'saling kenal');
  };
  const group = async (A, ...ms) => {
    const g = A.createGroup('Tim', ms.map((x) => x.id));
    await until(() => ms.every((x) => x.store.groups[g.id]), 8000, 'undangan grup');
    return g;
  };

  // ---- 1. anggota yang belum menekan Terima ikut memegang; pengirim offline; anggota lain tetap bisa mengunduh ----
  {
    const A = mk('g1A'), B = mk('g1B'), C = mk('g1C'), D = mk('g1D');
    await A.start(); await B.start(); await C.start(); await D.start();
    await connect(A, B, C, D); await connect(B, C, D); await connect(C, D);
    const g = await group(A, B, C, D);
    const m = await A.sendFile(f('rand.bin'), 'g:' + g.id);
    const ms = [B, C, D];
    await until(() => ms.filter((c) => holds(c, m.id)).length >= 2, 15000, 'dua anggota memegang titipan');
    const holders = ms.filter((c) => holds(c, m.id)), N = ms.find((c) => !holds(c, m.id));
    assert(N, 'tepat dua pemegang, satu anggota belum memegang');
    for (const c of ms) assert(!c.store.seeds[m.id] && !c.store.got[m.id], 'tidak ada yang menekan Terima');
    const e = holders[0].store.esc[m.id], psize = A.store.files[m.id].meta.psize;
    assert(e.to === 'g:' + g.id && e.wl === Xfer.wireLen(0, psize), 'rekaman titipan grup: tersegel');
    const bin = fs.readFileSync(holders[0]._escPaths(m.id).bin);
    assert(bin.length === e.wl && !bin.includes(orig.subarray(1000, 1064)), 'yang disimpan anggota hanya byte tersegel, bukan isi polos');
    assert(A.getState().messages.find((x) => x.id === m.id).file.pushed >= 2, 'kartu pengirim: dipegang >= 2 peer lain');
    assert.deepStrictEqual([holders[0].escUsage().used, holders[0].escUsagePub().used], [0, 0], 'kolam DM dan publik tidak tersentuh');
    assert.strictEqual(holders[0].escUsageGrp().used, psize);
    await sleep(600);
    assert(ms.filter((c) => holds(c, m.id)).length === 2, 'tidak didorong ke pemegang ketiga');
    ok('berkas grup didorong ke 2 anggota online tanpa menunggu mereka menekan Terima; yang disimpan hanya byte tersegel di kolam grup');

    // pemegang menekan Terima: seed menggantikan titipan (tidak ada salinan ganda)
    const H1 = holders[0], H2 = holders[1];
    const r = await H1.receiveFile(m.id);
    assert(fs.readFileSync(r.path).equals(orig));
    assert(H1.store.seeds[m.id] && !H1.store.esc[m.id], 'seed menggantikan titipan grup');
    await H1.flushCleanup();
    assert.deepStrictEqual(escFiles(H1), []);
    ok('pemegang yang menerima berkas: salinan seed menggantikan titipan, tidak ada dua salinan di disk');

    // pengirim dan pemegang pertama offline: yang belum punya mengunduh dari pemegang kedua (hanya titipan, belum Terima)
    await until(() => N._holdersOf(m.id).includes(H2.id) && N._holdersOf(m.id).includes(H1.id), 8000, 'N tahu pemegangnya');
    assert.strictEqual(N.getState().messages.find((x) => x.id === m.id).file.held, 2);
    await A.stop(); await H1.stop();
    assert(!H2.store.seeds[m.id] && holds(H2, m.id), 'H2 hanya pemegang titipan');
    const q = await N.receiveFile(m.id, FAST);
    assert(fs.readFileSync(q.path).equals(orig), 'identik dengan aslinya (tag tiap potongan terverifikasi)');
    assert(N.store.seeds[m.id], 'pengunduh baru ikut menjadi seed');
    ok('pengirim dan satu pemegang offline: anggota lain mengunduh dari anggota yang hanya memegang titipan');
    await Promise.all([B, C, D].map((c) => c.stop()));
  }

  // ---- 2. keamanan: hanya anggota yang dilayani dan dititipi; hanya pengirim asli yang mengisi; tersegel saja ----
  {
    const A = mk('g2A', { escPush: false }), K = mk('g2K', { escPush: false }), X = mk('g2X', { escPush: false }), M2 = mk('g2M', { escPush: false });
    await A.start(); await K.start(); await X.start(); await M2.start();
    await connect(A, K, X, M2); await connect(M2, K); await connect(X, K);
    const g = await group(A, K, M2); // X bukan anggota
    const m = await A.sendFile(f('rand.bin'), 'g:' + g.id);
    await until(() => K.store.msgs[m.id] && M2.store.msgs[m.id], 6000, 'tawaran sampai ke anggota');
    assert(!X.store.msgs[m.id], 'bukan anggota tidak menerima tawaran grup');
    const psize = A.store.files[m.id].meta.psize;
    const r = await A.pushToCourier(m.id, K.id);
    assert(r.done && holds(K, m.id));
    await assert.rejects(() => A.pushToCourier(m.id, X.id), (e) => e.code === 'bad');
    ok('berkas grup hanya bisa dititipkan ke sesama anggota grup');

    const h1 = await rawGet(K, m.id, { id: X.id });
    assert(h1 && h1.ok === false && h1.err === 'denied', 'bukan anggota ditolak: ' + JSON.stringify(h1));
    const h2 = await rawGet(K, m.id, { id: M2.id });
    assert(h2 && h2.ok && h2.enc, 'anggota dilayani tersegel: ' + JSON.stringify(h2));
    const h3 = await rawGet(K, m.id, { id: M2.id }, 12345);
    assert(h3 && h3.ok === false && h3.err === 'range', 'offset harus sejajar potongan tersegel');
    ok('titipan grup hanya dilayani ke anggota, tersegel, resume sejajar potongan');

    const kp = M2.peers.get(K.id);
    const q0 = await M2._request(kp, { t: 'esc_q', id: m.id, psize: psize + 1 });
    assert(q0 && q0.ok === false && q0.err === 'bad', 'ukuran harus sama dengan tawaran');
    const q = await M2._request(kp, { t: 'esc_q', id: m.id, psize });
    assert(q && q.ok && q.wl === Xfer.wireLen(0, psize), 'grup: wl tersegel');
    const sig = (n, who) => crypto.sign(null, Buffer.from('archne-put1:' + m.id + ':' + psize + ':' + n), who.privKey).toString('base64');
    await assert.rejects(() => Xfer.put(kp, { id: m.id, psize, off: 0, nonce: q.nonce, sig: sig(q.nonce, M2), hi: M2.hello() }, f('rand.bin'), 0, crypto.randomBytes(32), psize), (e) => e.code === 'auth');
    const ak = A.peers.get(K.id), qa = await A._request(ak, { t: 'esc_q', id: m.id, psize });
    await assert.rejects(() => Xfer.put(ak, { id: m.id, psize, off: 0, nonce: qa.nonce, sig: sig(qa.nonce, A), hi: A.hello(), plain: 1 }, f('rand.bin'), 0, null, psize), (e) => e.code === 'bad');
    ok('anggota lain tidak bisa mengisi titipan dengan tanda tangannya sendiri; dorongan polos untuk berkas grup ditolak');
    await Promise.all([A, K, X, M2].map((c) => c.stop()));
  }

  // ---- 3. batas: 50 MB per berkas (dikecilkan di tes), kolam sendiri, LRU alih-alih menolak ----
  {
    const A = mk('g3A', { escReplicas: 1 }), K = mk('g3K', { grpQuota: 2.5 * MB, grpPerSender: 2.5 * MB }), S = mk('g3S', { grpPerSender: 1 * MB, escPush: false });
    await A.start(); await K.start(); await S.start();
    await connect(A, K, S);
    const g = await group(A, K, S);
    fs.writeFileSync(f('g1.bin'), crypto.randomBytes(MB)); fs.writeFileSync(f('g2.bin'), crypto.randomBytes(MB)); fs.writeFileSync(f('g3.bin'), crypto.randomBytes(MB));
    const big = await A.sendFile(f('rand.bin'), 'g:' + g.id);
    await until(() => S.store.msgs[big.id], 6000, 'S punya tawaran');
    await assert.rejects(() => A.pushToCourier(big.id, S.id), (e) => e.code === 'big');
    assert(!S.store.esc[big.id]);
    ok('berkas lebih besar dari batas kolam grup ditolak (big), tidak disimpan');

    const ids = [];
    for (const n of ['g1.bin', 'g2.bin', 'g3.bin']) { const m = await A.sendFile(f(n), 'g:' + g.id); ids.push(m.id); await until(() => holds(K, m.id), 12000, 'dipegang ' + n); await sleep(20); }
    assert.deepStrictEqual(Object.keys(K.store.esc).filter((k) => k !== big.id).sort(), [ids[1], ids[2]].sort(), 'kuota total: yang paling lama tidak dipakai digusur');
    assert(K.escUsageGrp().used <= 2.5 * MB && K.escUsage().used === 0 && K.escUsagePub().used === 0, 'kolam terpisah dari DM dan publik');
    await sleep(1200);
    assert(!K.store.esc[ids[0]], 'yang tergusur tidak didorong ulang bolak-balik');
    await K.flushCleanup();
    assert(!escFiles(K).includes(ids[0] + '.bin'), 'berkas yang digusur terhapus dari disk');
    ok('kolam grup penuh: yang paling lama tidak dipakai digusur (LRU), tidak didorong ulang, kolam DM dan publik tidak terganggu');
    await Promise.all([A, K, S].map((c) => c.stop()));
  }

  // ---- 4. pencabutan saat batal kirim, dan kedaluwarsa ----
  {
    const A = mk('g4A', { escReplicas: 1 }), K = mk('g4K'), T = mk('g4T', { grpTtlMs: 600 });
    await A.start(); await K.start(); await T.start();
    await connect(A, K, T);
    const g = await group(A, K, T);
    const m = await A.sendFile(f('rand.bin'), 'g:' + g.id);
    await until(() => holds(K, m.id) || holds(T, m.id), 12000, 'dipegang');
    const H = holds(K, m.id) ? K : T;
    if (H === K) { A.deleteMessage(m.id); await until(() => !K.store.esc[m.id], 8000, 'pencabutan'); await K.flushCleanup(); assert.deepStrictEqual(escFiles(K), []); }
    else await until(() => !T.store.esc[m.id], 8000, 'kedaluwarsa');
    ok('titipan grup dibuang saat pengirim membatalkan atau kedaluwarsa menurut TTL kolam grup');
    // jalur yang tidak terpilih diuji langsung
    T.store.esc['a'.repeat(32)] = { psize: 10, wl: 10 + Xfer.TAG, have: 0, done: false, at: Date.now() - 4 * 864e5, from: A.id, to: 'g:xyz' };
    assert(T._escExpire(Date.now()) === true && !T.store.esc['a'.repeat(32)], 'titipan grup yang sudah tua / pesannya tidak ada dibuang');
    ok('titipan grup yatim (tanpa pesan tawaran) dibuang');
    await Promise.all([A, K, T].map((c) => c.stop()));
  }

  console.log(`\nSEMUA TES TITIPAN BERKAS GRUP LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('\nTES GAGAL: ' + e.stack); process.exit(1); });

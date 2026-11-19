'use strict';
// Tes penerima mengambil berkas dari kurir (v0.7.0 tahap 4, langkah 4c).
const os = require('os'), path = require('path'), fs = require('fs'), net = require('net'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const Xfer = require('../src/archne-xfer');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-escfetch-'));
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
const plain = fs.readFileSync.bind(fs);
const code = (c) => (e) => e && e.code === c;
const FAST = { retries: 0, retryMs: 0 };
const holds = (c, id) => !!(c.store.esc[id] && c.store.esc[id].done);
// permintaan file_get mentah; hasilnya baris header pertama
const rawGet = (core, id, hi, off = 0) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port: core.port }, () => s.write(JSON.stringify({ t: 'file_get', id, off, hi }) + '\n'));
  let buf = Buffer.alloc(0), done = false;
  const fin = (v) => { if (!done) { done = true; s.destroy(); res(v); } };
  s.on('data', (d) => { buf = Buffer.concat([buf, d]); const i = buf.indexOf(10); if (i >= 0) { try { fin(JSON.parse(buf.subarray(0, i).toString())); } catch { fin(null); } } });
  s.on('error', () => fin(null)); s.on('close', () => fin(null));
});
const spy = (core) => { const offs = []; const o = core._serveEsc.bind(core); core._serveEsc = (sock, q, ...r) => { offs.push(q.off); return o(sock, q, ...r); }; return offs; };
const flip = (file, pos) => { const fd = fs.openSync(file, 'r+'); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, pos); b[0] ^= 0xff; fs.writeSync(fd, b, 0, 1, pos); fs.closeSync(fd); };

(async () => {
  fs.writeFileSync(f('rand.bin'), crypto.randomBytes(1500000));
  fs.utimesSync(f('rand.bin'), 1700000000, 1700000000);
  const orig = plain(f('rand.bin'));

  // Penyiapan: A kirim ke C yang sedang offline; tiap kurir yang diminta memegang semua berkas; lalu C hidup lagi.
  // Hasil: { A, Ks, C2, msgs } dengan A masih hidup (pemanggil yang menghentikannya bila perlu).
  async function setup(tag, nK, nMsg) {
    const A = mk(tag + 'A'), Ks = Array.from({ length: nK }, (_, i) => mk(tag + 'K' + (i + 1))), C = mk(tag + 'C');
    for (const c of [A, ...Ks, C]) await c.start();
    for (const c of [...Ks, C]) await A.addPeer('127.0.0.1', c.port);
    await until(() => online(A, nK + 1) && A.peers.get(C.id).xpub, 6000, tag + ' A kenal semua');
    await C.stop();
    const msgs = [];
    for (let i = 0; i < nMsg; i++) msgs.push(await A.sendFile(f('rand.bin'), C.id));
    await until(() => Ks.every((k) => msgs.every((m) => holds(k, m.id))), 20000, tag + ' kurir memegang semua berkas');
    const C2 = mk(tag + 'C'); // identitas sama dengan C
    return { A, Ks, C2, msgs };
  }

  // ---- 1. pengirim offline: penerima mengambil dari kurir; tanda terima berkas membuang byte ----
  {
    const { A, Ks: [K], C2, msgs: [m] } = await setup('s1', 1, 1);
    const offs = spy(K);
    await A.stop();
    await C2.start(); await C2.addPeer('127.0.0.1', K.port);
    await until(() => C2.store.msgs[m.id] && C2._holdersOf(m.id).includes(K.id), 8000, 'kurir mengumumkan');
    assert(!C2.isOnline(C2.peers.get(A.id)), 'pengirim tidak online bagi C');
    const r = await C2.receiveFile(m.id, FAST);
    assert(plain(r.path).equals(orig));
    assert(offs.length >= 1 && offs[0] === 0, 'dilayani kurir dari awal: ' + offs);
    assert((await C2.receiveFile(m.id)).cached);
    await until(() => !K.store.esc[m.id] && !escFiles(K).length, 8000, 'kurir membuang byte setelah tanda terima berkas');
    assert(K.store.freceipts[m.id]);
    ok('pengirim offline: berkas utuh dan identik diambil dari kurir; tanda terima berkas membuang byte di kurir');
    await Promise.all([K, C2].map((c) => c.stop()));
  }

  // ---- 2. resume lintas sumber; jawaban final pengirim tidak diakali; akses hanya tujuan ----
  {
    const { A, Ks: [K], C2, msgs: [mr, mg] } = await setup('s2', 1, 2);
    const offs = spy(K);
    await C2.start(); await C2.addPeer('127.0.0.1', A.port); await C2.addPeer('127.0.0.1', K.port);
    await until(() => [mr, mg].every((m) => C2.store.msgs[m.id] && C2._holdersOf(m.id).includes(K.id)) && C2.isOnline(C2.peers.get(A.id)), 8000, 'C kenal A dan kurir');
    // pengirim putus di tengah unduhan -> sisanya dari kurir, mulai dari batas potongan
    const so = Xfer.serve;
    Xfer.serve = (sock, ...a) => { const p = so(sock, ...a); const t = setInterval(() => { if (sock.bytesWritten > 400000) { clearInterval(t); sock.destroy(); } }, 3); sock.once('close', () => clearInterval(t)); return p; };
    let r;
    try { r = await C2.receiveFile(mr.id, FAST); } finally { Xfer.serve = so; }
    assert(plain(r.path).equals(orig));
    const resumed = offs.filter((o) => o > 0);
    assert(resumed.length === 1 && resumed[0] % Xfer.SEG === 0, 'kurir melanjutkan dari batas potongan: ' + offs);
    ok('pengirim putus di tengah: sisa diambil dari kurir (resume sejajar potongan), hasil identik');

    // pengirim menjawab "gone" (berkas dicabut dari daftar kirimnya): final, kurir tidak dipakai
    const before = offs.length;
    delete A.store.files[mg.id];
    await assert.rejects(C2.receiveFile(mg.id, FAST), code('gone'));
    assert.strictEqual(offs.length, before, 'kurir tidak ditanya');
    ok('pengirim menjawab "gone": final, tidak dialihkan ke kurir');

    // akses di kurir: hanya tujuan pesan; belum lengkap / tidak ada / dicabut -> gone; offset tidak sejajar -> range
    const X = mk('s2X'); await X.start();
    assert.deepStrictEqual((await rawGet(K, mg.id, X.hello())).err, 'denied');
    assert.strictEqual((await rawGet(K, 'a'.repeat(32), C2.hello())).err, 'gone');
    assert.strictEqual((await rawGet(K, mg.id, C2.hello(), 1000)).err, 'range');
    const h = await rawGet(K, mg.id, C2.hello(), 0);
    assert(h && h.ok && h.enc === 1 && h.wl === Xfer.wireLen(0, A.store.files[mr.id].meta.psize), JSON.stringify(h));
    const ann = (c) => K._handle({ t: 'sync_req', have: [], hi: c.hello() }, '127.0.0.1').eh;
    assert.deepStrictEqual(ann(X), []);
    assert(ann(C2).includes(mg.id));
    ok('kurir hanya melayani dan mengumumkan ke tujuan pesan; id tak dikenal gone, offset tidak sejajar range');

    // pencabutan setelah titipan pesan dibuang: byte tetap bisa dicabut, lalu ditolak
    K._addRcpt(C2._myRcpt(C2.store.msgs[mg.id])); // (sering sudah tercatat: kurir mengantar tawarannya langsung ke C)
    assert(!K.store.custody[mg.id] && K.store.esc[mg.id], 'titipan pesan dibuang, byte bertahan');
    A.store.files[mg.id] = { path: f('rand.bin'), staged: false, meta: A.store.files[mr.id].meta, mtime: 0, escTouched: true };
    A._makeRevoke(mg.id);
    assert(K._addRevoke(A.store.revokes[mg.id]));
    assert(!K.store.esc[mg.id]);
    assert.strictEqual((await rawGet(K, mg.id, C2.hello())).err, 'gone');
    ok('pencabutan sah tetap diterima setelah titipan pesan dibuang (pemilik dari catatan byte): byte dibuang, layanan gone');

    // tanda terima berkas palsu: diabaikan, byte tidak terbuang
    const sign = (who, id, by) => ({ id, by, pub: who.pub, sig: crypto.sign(null, Buffer.from('archne-frcpt1:' + id + ':' + by), who.privKey).toString('base64') });
    const K2x = mk('s2K2'); await K2x.start();
    const mm = A._makeMsg(C2.id, 'e1', 'x'); assert.strictEqual(K2x._ingest(mm), 'carried');
    assert(K2x._escReserve(mm.id, 1000).ok);
    const good = (() => { C2.store.msgs[mm.id] = mm; C2._makeFileRcpt(mm); return C2.store.freceipts[mm.id]; })();
    assert(!K2x._addFileRcpt(sign(X, mm.id, C2.id)), 'tanda tangan orang lain atas nama tujuan');
    assert(!K2x._addFileRcpt(sign(X, mm.id, X.id)), 'penandatangan bukan tujuan pesan');
    assert(!K2x._addFileRcpt(Object.assign({}, good, { sig: Buffer.from('x'.repeat(64)).toString('base64') })), 'tanda tangan rusak');
    assert(!K2x._addFileRcpt(Object.assign({}, good, { id: 'b'.repeat(32) })), 'bukan byte yang kupegang');
    assert(!K2x.store.freceipts[mm.id] && !K2x.store.freceipts['b'.repeat(32)] && K2x.store.esc[mm.id]);
    assert(K2x._addFileRcpt(good) && !K2x.store.esc[mm.id]);
    ok('tanda terima berkas palsu (penanda tangan lain, bukan tujuan, rusak, bukan berkas yang dipegang) diabaikan dan tidak disimpan; yang sah membuang byte');
    await Promise.all([A, K, C2, X, K2x].map((c) => c.stop()));
  }

  // ---- 3. kurir nakal: byte diubah -> ditolak, pindah ke kurir lain; semua nakal -> crypt; kabar tanda terima lewat kurir lain ----
  {
    const { A, Ks: [K1, K2], C2, msgs: [ma, mb] } = await setup('s3', 2, 2);
    const offs2 = spy(K2);
    await K1.addPeer('127.0.0.1', K2.port);
    await A.stop();
    await C2.start(); await C2.addPeer('127.0.0.1', K1.port); await C2.addPeer('127.0.0.1', K2.port);
    await until(() => [ma, mb].every((m) => C2.store.msgs[m.id] && C2._holdersOf(m.id).length === 2), 8000, 'dua kurir mengumumkan');
    const bin = (k, m) => path.join(k.opts.dataDir, 'esc', m.id + '.bin');
    flip(bin(K1, ma), 100000);                       // potongan kedua rusak di K1
    flip(bin(K1, mb), 100000); flip(bin(K2, mb), 70000);
    for (const m of [ma, mb]) C2._holders.get(m.id).set(K1.id, Date.now() + 5000); // K1 dicoba lebih dulu
    const r = await C2.receiveFile(ma.id, FAST);
    assert(plain(r.path).equals(orig), 'tidak ada byte rusak yang lolos');
    assert(offs2.includes(Xfer.SEG), 'K2 melanjutkan dari potongan yang rusak di K1: ' + offs2);
    ok('kurir yang mengubah byte ditolak (crypt), kurir berikutnya melanjutkan dari potongan terakhir yang sah');

    await assert.rejects(C2.receiveFile(mb.id, FAST), code('crypt'));
    assert(!C2.store.got[mb.id] && ls(C2.opts.downloadDir).length === 1, 'tidak ada berkas rusak di folder unduhan');
    ok('semua kurir mengubah byte: gagal dengan crypt, tidak ada berkas rusak yang disimpan');

    // K2 mendapat tanda terima berkas dari K1 (pembawa) tanpa bertemu penerima
    await until(() => !K1.store.esc[ma.id] && !K2.store.esc[ma.id], 8000, 'kedua kurir membuang berkas ma');
    assert(K1.store.freceipts[ma.id] && K2.store.freceipts[ma.id]);
    assert(K1.store.esc[mb.id] && K2.store.esc[mb.id], 'berkas yang belum diterima tetap dipegang');
    ok('tanda terima berkas menyebar antarkurir; berkas lain yang belum diterima tidak tersentuh');
    await Promise.all([K1, K2, C2].map((c) => c.stop()));
  }

  console.log(`\nSEMUA TES AMBIL DARI KURIR LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e.stack || e.message); process.exit(1); });

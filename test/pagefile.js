'use strict';
// Tes Halaman 3a-5a: sisi PEMINTA lampiran (pageFileGet). Jaringan sungguhan (soket lokal) antara pemilik A dan peminta B (teman) / C (asing) / D (diblokir);
// pemilik nakal disimulasikan dengan membungkus _pgAsk peminta. Sisi pemilik (pg_media untuk lampiran) diuji di pageserve.js (grup 12).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { FILE_CHUNK } = require('../src/archne-pagestore');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagefile-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); } throw new Error('timeout: ' + label); }
let pass = 0;
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-unduhan'), name: n, discovery: false });
const code = async (p) => { try { await p; } catch (e) { return e.code; } return 'tidak melempar'; };
const rnd = (n, seed) => { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; } return b; };
const dlDir = (c) => path.join(c._downloadDir(), 'halaman');
const listDl = (c) => { try { return fs.readdirSync(dlDir(c)).sort(); } catch { return []; } };

(async () => {
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D');
  const all = [A, B, C, D];
  for (const n of all) await n.start();
  for (const n of [B, C, D]) await n.addPeer('127.0.0.1', A.port);
  await until(() => [B, C, D].every((n) => n.peers.has(A.id) && A.peers.has(n.id)), 8000, 'peer saling kenal');
  A.store.friends[B.id] = { st: 'ok' }; A.store.blocked[D.id] = 1;

  const big = rnd(FILE_CHUNK * 2 + 777, 5); // 3 potongan (512K, 512K, sisa)
  const src = path.join(tmp, 'laporan.pdf'); fs.writeFileSync(src, big);
  const ps = A.pageStore();
  const [fP, fF, fN] = await ps.addFiles([{ src }, { src }, { src }]);
  const pub = ps.create({ text: 'publik', files: [fP] }), frd = ps.create({ text: 'teman', priv: 'friends', files: [fF] });
  const asks = { n: 0, hook: null, gate: null, fail: null };
  for (const n of [A, B, C, D]) { const real = n._pgAsk.bind(n); n._pgAsk = async (...a) => { const isM = a[1] && a[1].t === 'pg_media'; if (isM) { asks.n++; if (asks.gate) await asks.gate(); } if (isM && asks.fail && asks.fail(a[1])) throw Object.assign(new Error('sibuk'), { code: 'busy' }); const r = await real(...a); return asks.hook && isM ? asks.hook(r, a[1]) : r; }; }
  const heard = (c) => { const log = []; return { log, onProgress: (h, t) => log.push([h, t]) }; };

  // 1. unduh dari jauh: asing dan teman, isi identik, progres naik sampai total, tanpa sisa .part, tujuan <unduhan>/halaman
  {
    for (const who of [C, B]) {
      const h = heard(); asks.n = 0;
      const r = await who.pageFileGet(A.id, pub.id, fP.id, h);
      assert.deepStrictEqual({ name: r.name, size: r.size }, { name: 'laporan.pdf', size: big.length });
      assert.strictEqual(path.dirname(r.path), dlDir(who)); assert(fs.readFileSync(r.path).equals(big), 'isi identik');
      assert.deepStrictEqual(h.log.map((x) => x[0]), [FILE_CHUNK, FILE_CHUNK * 2, big.length], 'progres per potongan'); assert(h.log.every((x) => x[1] === big.length));
      assert.strictEqual(asks.n, 3, '3 permintaan potongan'); assert.deepStrictEqual(listDl(who), ['laporan.pdf'], 'tanpa .part');
    }
    // nama bentrok: (1), (2); berkas yang sudah ada tidak ditimpa
    const r2 = await C.pageFileGet(A.id, pub.id, fP.id); assert.strictEqual(r2.name, 'laporan (1).pdf');
    assert.deepStrictEqual(listDl(C), ['laporan (1).pdf', 'laporan.pdf']);
    ok('unduh jauh: asing dan teman, isi identik, progres per potongan, tujuan <unduhan>/halaman, tanpa .part, nama bentrok diberi (n)');
  }

  // 2. milik sendiri disalin dari PageStore lokal tanpa jaringan; privasi: postingan Teman hanya untuk teman
  {
    asks.n = 0; const r = await A.pageFileGet(A.id, pub.id, fP.id); assert(fs.readFileSync(r.path).equals(big)); assert.strictEqual(asks.n, 0, 'tanpa jaringan');
    assert((await B.pageFileGet(A.id, frd.id, fF.id)).size === big.length, 'teman boleh');
    for (const [who, post, f] of [[C, frd, fF], [D, pub, fP], [C, pub, fF], [C, { id: 'bbbbbbbbbbbbbbbb' }, fP], [C, pub, { id: 'cccccccccccccccc' }]]) assert.strictEqual(await who.pageFileGet(A.id, post.id, f.id), null);
    ok('milik sendiri tanpa jaringan; asing/diblokir/postingan tak ada/lampiran postingan lain/id asing = null (tak dibedakan)');
  }

  // 3. argumen cacat dan peer tak dikenal; id gambar tidak bisa diunduh sebagai lampiran
  {
    for (const [a, b, c2] of [['x', pub.id, fP.id], [A.id, '../x', fP.id], [A.id, pub.id, 5], [A.id, pub.id, undefined], [null, null, null]]) assert.strictEqual(await code(C.pageFileGet(a, b, c2)), 'bad');
    assert.strictEqual(await code(C.pageFileGet('dddddddddddddddd', pub.id, fP.id)), 'peer');
    assert.strictEqual(await code(A.pageFileGet(A.id, 'bad', 'bad')), 'bad');
    ok('argumen cacat = bad; peer tak dikenal = peer');
  }

  // 4. nama jahat dari pemilik: tidak bisa keluar dari folder tujuan
  {
    const before = new Set(fs.readdirSync(tmp));
    const evil = ps.create({ text: 'jahat', files: [{ ...fN, name: '../../evil.txt' }] });
    const r = await C.pageFileGet(A.id, evil.id, fN.id);
    assert.strictEqual(path.dirname(r.path), dlDir(C), 'tetap di folder tujuan'); assert(!r.name.includes('/') && !r.name.includes('\\') && !r.name.startsWith('.'), r.name);
    const cn = ps.create({ text: 'cn', files: [{ ...fN, name: 'CON.txt' }] }); assert.strictEqual((await C.pageFileGet(A.id, cn.id, fN.id)).name, '_CON.txt');
    assert.deepStrictEqual(new Set(fs.readdirSync(tmp)), before, 'tidak ada berkas baru di luar folder unduhan'); assert(!fs.existsSync(path.join(tmp, 'evil.txt')));
    ps.remove(evil.id); ps.remove(cn.id);
    ok('nama berpemisah jalur / titik di depan / nama khusus Windows dibersihkan, tidak keluar dari folder');
  }

  // 5. pemilik nakal: tiap jawaban cacat = proto, 'gone' bila hilang di tengah jalan; tidak ada .part atau tempat nama tersisa
  {
    const before = listDl(C);
    const cases = {
      'total salah': [(r) => (r.chunk ? { ...r, chunk: { ...r.chunk, total: r.chunk.total + 1 } } : r), 'proto'],
      'off salah': [(r) => ({ ...r, chunk: { ...r.chunk, off: r.chunk.off + 1 } }), 'proto'],
      'panjang kurang': [(r) => ({ ...r, chunk: { ...r.chunk, b64: r.chunk.b64.slice(0, 40) } }), 'proto'],
      'panjang lebih': [(r) => ({ ...r, chunk: { ...r.chunk, b64: r.chunk.b64 + 'AAAA' } }), 'proto'],
      'bukan base64': [(r) => ({ ...r, chunk: { ...r.chunk, b64: '!!!' + r.chunk.b64.slice(3) } }), 'proto'],
      'b64 bukan string': [(r) => ({ ...r, chunk: { ...r.chunk, b64: 5 } }), 'proto'],
      'chunk bukan objek': [(r) => ({ ...r, chunk: 'x' }), 'proto'],
      'chunk undefined': [(r) => ({ ...r, chunk: undefined }), 'proto'],
      'hilang di awal': [() => ({ t: 'pg_media', ok: true, chunk: null }), 'gone'],
    };
    for (const [name, [fn, want]] of Object.entries(cases)) {
      asks.hook = (r) => fn(r); assert.strictEqual(await code(C.pageFileGet(A.id, pub.id, fP.id)), want, name);
      assert.deepStrictEqual(listDl(C), before, 'tanpa sisa: ' + name);
    }
    let n = 0; asks.hook = (r) => (++n === 2 ? { ...r, chunk: null } : r); // hilang di tengah jalan
    assert.strictEqual(await code(C.pageFileGet(A.id, pub.id, fP.id)), 'gone'); assert.deepStrictEqual(listDl(C), before, 'tanpa sisa: hilang di tengah');
    n = 0; asks.hook = (r) => (++n === 3 ? { ...r, chunk: { ...r.chunk, total: r.chunk.total - 1 } } : r); // pemilik berubah pikiran di potongan terakhir
    assert.strictEqual(await code(C.pageFileGet(A.id, pub.id, fP.id)), 'proto'); assert.deepStrictEqual(listDl(C), before);
    asks.hook = null;
    ok('pemilik nakal: total/off/panjang/base64/bentuk salah = proto, hilang = gone (awal dan tengah), tanpa .part atau tempat nama tersisa');
  }

  // 6. batalkan: signal dihormati antar potongan; sisa dibuang
  {
    const before = listDl(C), ac = new AbortController(); asks.n = 0;
    const e = await code(C.pageFileGet(A.id, pub.id, fP.id, { signal: ac.signal, onProgress: (h) => { if (h >= FILE_CHUNK) ac.abort(); } }));
    assert.strictEqual(e, 'cancel'); assert.strictEqual(asks.n, 1, 'berhenti segera: tidak meminta potongan kedua'); assert.deepStrictEqual(listDl(C), before, 'dibatalkan = tanpa sisa');
    const pre = new AbortController(); pre.abort(); asks.n = 0;
    assert.strictEqual(await code(C.pageFileGet(A.id, pub.id, fP.id, { signal: pre.signal })), 'cancel'); assert.strictEqual(asks.n, 0, 'dibatalkan sebelum mulai: tanpa permintaan'); assert.deepStrictEqual(listDl(C), before);
    const r = await C.pageFileGet(A.id, pub.id, fP.id, { onProgress: () => { throw new Error('galat UI'); } }); assert(fs.readFileSync(r.path).equals(big), 'galat di onProgress diabaikan');
    ok('dibatalkan di tengah / sebelum mulai = cancel, tanpa sisa; galat di onProgress tidak menggagalkan unduhan');
  }

  // 6b. pemilik sibuk: 'busy' dicoba ulang beberapa kali lalu menyerah dengan busy; sisa dibuang
  {
    const before = listDl(C); let n = 0; asks.fail = () => ++n <= 2; asks.n = 0;
    const r = await C.pageFileGet(A.id, pub.id, fP.id); assert(fs.readFileSync(r.path).equals(big), 'berhasil setelah dicoba ulang'); assert.strictEqual(asks.n, 3 + 2, '2 gagal + 3 potongan');
    fs.rmSync(r.path); asks.fail = () => true; asks.n = 0;
    assert.strictEqual(await code(C.pageFileGet(A.id, pub.id, fP.id)), 'busy'); assert.strictEqual(asks.n, 4, 'menyerah setelah 4 percobaan'); asks.fail = null;
    assert.deepStrictEqual(listDl(C), before, 'tanpa sisa');
    ok('pemilik sibuk: dicoba ulang (sembuh = berhasil), terus sibuk = busy setelah 4 percobaan, tanpa sisa');
  }

  // 7. batas unduhan bersamaan: PG_DL_MAX = 3, yang keempat 'many'; selesai = slot kembali
  {
    let release; const gate = new Promise((r) => { release = r; }); asks.gate = () => gate;
    const run = [1, 2, 3].map(() => C.pageFileGet(A.id, pub.id, fP.id)); await sleep(300);
    assert.strictEqual(await code(C.pageFileGet(A.id, pub.id, fP.id)), 'many', 'keempat ditolak');
    release(); asks.gate = null; const res = await Promise.all(run); assert.strictEqual(new Set(res.map((r) => r.path)).size, 3, 'tiga unduhan, tiga nama berbeda');
    assert.strictEqual(C._pgDl.size, 0, 'slot dikembalikan'); await C.pageFileGet(A.id, pub.id, fP.id);
    ok('maksimal 3 unduhan bersamaan: keempat many, nama tiga unduhan serentak berbeda, slot kembali setelah selesai');
  }

  // 8. disk penuh di tengah jalan: pesan jelas, sisa dibuang
  {
    const before = listDl(B), real = fs.promises.open; let calls = 0;
    fs.promises.open = async (...a) => { const h = await real(...a); if (a[1] === 'w') { const w = h.write.bind(h); h.write = (...x) => { if (++calls === 2) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); return w(...x); }; } return h; };
    let err; try { await B.pageFileGet(A.id, pub.id, fP.id); } catch (e) { err = e; } finally { fs.promises.open = real; }
    assert(err && err.code === 'ENOSPC' && err.message === 'Penyimpanan penuh'); assert.deepStrictEqual(listDl(B), before, 'tanpa sisa');
    ok('disk penuh = Penyimpanan penuh (ENOSPC), sisa dibuang');
  }

  // 9. pemilik tanpa pgm (versi lama) = old
  {
    // balasan pg_get membawa hello yang memulihkan caps, jadi caps diturunkan tepat SESUDAH pagePost (sebelum potongan pertama)
    const realPost = C.pagePost.bind(C); C.pagePost = async (...x) => { const r = await realPost(...x); C.peers.get(A.id).caps = ['pg']; return r; }; // objek peer diganti tiap balasan: ambil yang berlaku sekarang
    try { assert.strictEqual(await code(C.pageFileGet(A.id, pub.id, fP.id)), 'old'); } finally { delete C.pagePost; }
    assert.deepStrictEqual(listDl(C).filter((n) => n.endsWith('.part')), [], 'tanpa .part');
    ok("pemilik tanpa caps 'pgm' = old");
  }

  console.log('\n' + pass + ' kelompok lulus');
  for (const n of all) await n.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

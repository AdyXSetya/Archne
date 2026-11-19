'use strict';
// Tes Halaman 2d-3: sisi PEMINTA gambar penuh (pageMedia + token penyaji media). Jaringan sungguhan (soket lokal) antara pemilik A dan peminta B/C/D;
// pemilik nakal disimulasikan dengan membungkus _pgAsk peminta (jawaban asli lalu diubah). Sisi pemilik (pg_media) diuji di pageserve.js.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { MEDIA_CHUNK, PAGE_MEDIA_MAX } = require('../src/archne-pagestore');
const MS = require('../src/archne-mediaserve');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagemedia-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); } throw new Error('timeout: ' + label); }
let pass = 0;
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const code = async (p) => { try { await p; } catch (e) { return e.code; } return 'tidak melempar'; };
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
const pngDim = (w, h) => { const b = Buffer.from(png); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const rnd = (n, seed) => { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; } return b; };
// Baca semua byte lewat penyaji media, persis seperti <img> (tanpa Range) atau dengan Range.
async function slurp(core, tok, range) {
  const p = MS.plan(core, tok, range); if (p.from === undefined) return p;
  const parts = []; for await (const b of MS.chunks(core, tok, p.from, p.to)) parts.push(b);
  return { status: p.status, headers: p.headers, body: Buffer.concat(parts) };
}

(async () => {
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D');
  const all = [A, B, C, D];
  for (const n of all) await n.start();
  for (const n of [B, C, D]) await n.addPeer('127.0.0.1', A.port);
  await until(() => [B, C, D].every((n) => n.peers.has(A.id) && A.peers.has(n.id)), 8000, 'peer saling kenal');
  A.store.friends[B.id] = { st: 'ok' }; A.store.blocked[D.id] = 1;

  const big = Buffer.concat([png, rnd(MEDIA_CHUNK * 2 + 4321, 7)]); // 3 blok (512K, 512K, sisa)
  const file = path.join(tmp, 'besar.png'); fs.writeFileSync(file, big);
  const ps = A.pageStore();
  const [mP, mF] = await ps.addMedias([{ src: file }, { src: file }]);
  const pub = ps.create({ text: 'publik', media: [mP] }), frd = ps.create({ text: 'teman', priv: 'friends', media: [mF] });
  // hitung permintaan pg_media yang benar-benar keluar dari peminta; `hook` (opsional) mengubah jawaban
  const asks = { n: 0, hook: null };
  for (const n of [A, B, C]) { const real = n._pgAsk.bind(n); n._pgAsk = async (...a) => { if (a[1] && a[1].t === 'pg_media') asks.n++; const r = await real(...a); return asks.hook && a[1].t === 'pg_media' ? asks.hook(r, a[1]) : r; }; }
  const want = () => big;

  // 1. gambar milik sendiri: dibaca dari PageStore lokal lewat token yang sama
  {
    const r = await A.pageMedia(A.id, pub.id, mP.id);
    assert.strictEqual(r.mime, 'image/png'); assert.strictEqual(r.total, big.length); assert.match(r.tok, /^[0-9a-f]{32}$/);
    assert.deepStrictEqual(A.mediaSrcInfo(r.tok), { mime: 'image/png', total: big.length });
    const s = await slurp(A, r.tok); assert.strictEqual(s.status, 200); assert(s.body.equals(want()), 'isi identik');
    assert.strictEqual(await A.pageMedia(A.id, pub.id, mF.id), null, 'media postingan lain = null');
    ok('gambar sendiri: token dari PageStore lokal, isi identik, id media postingan lain = null');
  }

  // 2. peminta jauh: asing dan teman merakit gambar utuh lewat penyaji media; Range melintasi batas blok; tidak ada berkas di disk peminta
  {
    for (const who of [C, B]) {
      asks.n = 0;
      const r = await who.pageMedia(A.id, pub.id, mP.id);
      assert.deepStrictEqual({ mime: r.mime, total: r.total }, { mime: 'image/png', total: big.length });
      const s = await slurp(who, r.tok); assert.strictEqual(s.status, 200); assert.strictEqual(s.headers['content-length'], String(big.length)); assert.strictEqual(s.headers['content-type'], 'image/png');
      assert(s.body.equals(want()), 'rakitan identik');
      assert.strictEqual(asks.n, 3, '1 permintaan per blok (blok pertama dipakai ulang dari pageMedia): ' + asks.n);
      assert(who._ptok.get(r.tok).blocks.size <= 2, 'memori dibatasi: paling banyak 2 blok tersimpan');
      const a = MEDIA_CHUNK - 1000, z = MEDIA_CHUNK + 1000, rg = await slurp(who, r.tok, `bytes=${a}-${z}`);
      assert.strictEqual(rg.status, 206); assert(rg.body.equals(big.subarray(a, z + 1)), 'Range melintasi batas blok');
      assert.strictEqual((await slurp(who, r.tok, `bytes=-100`)).body.length, 100, 'Range akhir');
      assert.strictEqual((await slurp(who, r.tok, `bytes=${big.length}-`)).status, 416);
    }
    assert(!fs.existsSync(path.join(tmp, 'C', 'pages')), 'peminta tidak menyimpan apa pun ke disk');
    ok('peminta: asing dan teman merakit identik lewat penyaji; 3 permintaan untuk 3 blok; Range lintas blok; tanpa berkas di disk');
  }

  // 3. privasi: jawaban "tidak ada" seragam
  {
    assert.strictEqual((await B.pageMedia(A.id, frd.id, mF.id)).total, big.length, 'teman boleh');
    for (const [who, post, m] of [[C, frd, mF], [D, pub, mP], [C, pub, mF], [C, { id: 'bbbbbbbbbbbbbbbb' }, mP]]) assert.strictEqual(await who.pageMedia(A.id, post.id, m.id), null);
    assert.strictEqual(await code(C.pageMedia('zz', pub.id, mP.id)), 'bad'); assert.strictEqual(await code(C.pageMedia(A.id, '../x', mP.id)), 'bad'); assert.strictEqual(await code(C.pageMedia(A.id, pub.id, 5)), 'bad');
    assert.strictEqual(await code(C.pageMedia('cccccccccccccccc', pub.id, mP.id)), 'peer'); // peer tidak dikenal
    ok('privasi: Teman hanya teman; asing / diblokir / id salah = null; argumen cacat = bad; peer tak dikenal = peer');
  }

  // 4. pembacaan bersamaan atas satu blok berbagi satu permintaan; token tak dikenal / kedaluwarsa = null
  {
    const r = await C.pageMedia(A.id, pub.id, mP.id); asks.n = 0;
    const [x, y] = await Promise.all([C.mediaSrcRead(r.tok, MEDIA_CHUNK + 10, 1000), C.mediaSrcRead(r.tok, MEDIA_CHUNK + 5000, 1000)]);
    assert(x.equals(big.subarray(MEDIA_CHUNK + 10, MEDIA_CHUNK + 1010)) && y.equals(big.subarray(MEDIA_CHUNK + 5000, MEDIA_CHUNK + 6000))); assert.strictEqual(asks.n, 1, 'satu permintaan untuk dua pembacaan');
    assert.strictEqual(await C.mediaSrcRead('0'.repeat(32), 0, 10), null); assert.strictEqual(C.mediaSrcInfo('0'.repeat(32)), null); assert.strictEqual(C.mediaSrcLive(r.tok), false);
    assert.strictEqual(await C.mediaSrcRead(r.tok, big.length, 10), null, 'di luar berkas'); assert.strictEqual(await C.mediaSrcRead(r.tok, -1, 10), null);
    C._ptok.get(r.tok).exp = Date.now() - 1; assert.strictEqual(C.mediaSrcInfo(r.tok), null); assert.strictEqual(await C.mediaSrcRead(r.tok, 0, 10), null, 'kedaluwarsa');
    assert.strictEqual(MS.plan(C, r.tok, undefined).status, 404);
    // batas 16 token: yang tertua disingkirkan, token chat (_mtok) tidak tersentuh
    C._mtok = new Map([['a'.repeat(32), { id: 'x', total: 5, mime: 'video/mp4', exp: Date.now() + 1e6 }]]);
    const toks = []; for (let i = 0; i < 17; i++) toks.push((await C.pageMedia(A.id, pub.id, mP.id)).tok);
    assert.strictEqual(C.mediaSrcInfo(toks[0]), null, 'tertua tersingkir'); assert(C.mediaSrcInfo(toks[16]) && C.mediaSrcInfo(toks[1])); assert.strictEqual(C._ptok.size, 16);
    assert.deepStrictEqual(C.mediaSrcInfo('a'.repeat(32)), { mime: 'video/mp4', total: 5 }, 'token media chat tetap berlaku'); C._mtok = null;
    ok('bacaan bersamaan berbagi satu permintaan; token tak dikenal / kedaluwarsa / di luar berkas = null; batas 16 token; token chat tak tersentuh');
  }

  // 5. 'busy' dari pemilik dicoba ulang sebentar; terus-menerus busy = berhenti
  {
    let k = 0; asks.hook = (r) => { if (k++ < 2) { throw Object.assign(new Error('sibuk'), { code: 'busy' }); } return r; };
    const r = await C.pageMedia(A.id, pub.id, mP.id); assert.strictEqual(r.total, big.length, 'berhasil setelah dua kali busy'); assert(k >= 3);
    asks.hook = () => { throw Object.assign(new Error('sibuk'), { code: 'busy' }); };
    assert.strictEqual(await code(C.pageMedia(A.id, pub.id, mP.id)), 'busy', 'awal: busy diteruskan sesudah beberapa percobaan');
    asks.hook = null; const r2 = await C.pageMedia(A.id, pub.id, mP.id);
    asks.hook = () => { throw Object.assign(new Error('sibuk'), { code: 'busy' }); };
    assert.strictEqual(await C.mediaSrcRead(r2.tok, MEDIA_CHUNK + 1, 10), null, 'di tengah aliran: null');
    asks.hook = null; assert((await C.mediaSrcRead(r2.tok, MEDIA_CHUNK + 1, 10)).equals(big.subarray(MEDIA_CHUNK + 1, MEDIA_CHUNK + 11)), 'kegagalan tidak disimpan: coba lagi berhasil');
    ok("busy: dicoba ulang lalu berhasil / diteruskan; gagal di tengah aliran = null dan tidak tersimpan");
  }

  // 6. pemilik nakal: tiap jawaban cacat jadi 'proto' (blok pertama) atau null (blok berikutnya); tidak ada byte palsu yang disajikan
  {
    const real = (r) => r.chunk;
    const mut = (f) => (r) => Object.assign({}, r, { chunk: f(Object.assign({}, real(r))) });
    const first = [
      ['mime tak cocok dengan isi', mut((c) => Object.assign(c, { mime: 'image/jpeg' }))],
      ['isi bukan gambar', mut((c) => Object.assign(c, { b64: Buffer.alloc(c.b64.length / 4 * 3 | 0, 1).toString('base64') }))],
      ['bom piksel (panjang dan mime benar, hanya dimensi yang salah)', () => ({ t: 'pg_media', ok: true, chunk: { mime: 'image/png', total: png.length, off: 0, b64: pngDim(60000, 60000).toString('base64') } })],
      ['b64 berisi baris baru (panjang hasil decode tetap benar)', () => { const q = png.toString('base64'); return { t: 'pg_media', ok: true, chunk: { mime: 'image/png', total: png.length, off: 0, b64: q.slice(0, 20) + '\n' + q.slice(20) } }; }],
      ['kontrol: gambar sah kecil diterima bila bersih', null],
      ['mime tak dikenal', mut((c) => Object.assign(c, { mime: 'image/svg+xml' }))],
      ['b64 terlalu panjang', mut((c) => Object.assign(c, { b64: c.b64 + 'AAAA'.repeat(100) }))],
      ['b64 mengandung karakter terlarang', mut((c) => Object.assign(c, { b64: '<script>' + c.b64.slice(8) }))],
      ['panjang kurang', mut((c) => Object.assign(c, { b64: c.b64.slice(0, 400) }))],
      ['total melebihi 2 GiB', mut((c) => Object.assign(c, { total: PAGE_MEDIA_MAX + 1 }))],
      ['total nol', mut((c) => Object.assign(c, { total: 0 }))],
      ['off salah', mut((c) => Object.assign(c, { off: 5 }))],
      ['chunk bukan objek', () => ({ t: 'pg_media', ok: true, chunk: 'x' })],
      ['tanpa chunk', () => ({ t: 'pg_media', ok: true })],
    ];
    for (const [label, h] of first) {
      if (h === null) { asks.hook = () => ({ t: 'pg_media', ok: true, chunk: { mime: 'image/png', total: png.length, off: 0, b64: png.toString('base64') } }); const g = await C.pageMedia(A.id, pub.id, mP.id); assert.strictEqual(g.total, png.length, label); continue; }
      asks.hook = h; assert.strictEqual(await code(C.pageMedia(A.id, pub.id, mP.id)), 'proto', label);
    }
    asks.hook = null; const r = await C.pageMedia(A.id, pub.id, mP.id), blk1 = MEDIA_CHUNK + 3;
    const later = [
      ['blok berikut: total berubah', mut((c) => Object.assign(c, { total: c.total + 1 }))],
      ['blok berikut: mime berubah', mut((c) => Object.assign(c, { mime: 'image/gif' }))],
      ['blok berikut: panjang salah', mut((c) => Object.assign(c, { b64: c.b64.slice(0, 1000) }))],
      ['blok berikut: off salah', mut((c) => Object.assign(c, { off: 0 }))],
    ];
    for (const [label, h] of later) { asks.hook = h; assert.strictEqual(await C.mediaSrcRead(r.tok, blk1, 10), null, label); }
    assert.strictEqual(C._ptok.get(r.tok).blocks.has(1), false, 'blok cacat tidak disimpan');
    asks.hook = null; assert((await C.mediaSrcRead(r.tok, blk1, 10)).equals(big.subarray(blk1, blk1 + 10)), 'pulih setelah jawaban baik');
    ok('pemilik nakal: 14 bentuk cacat pada blok pertama (dan satu kontrol sah) = proto; 4 pada blok berikutnya = null, tidak disimpan, pulih sesudahnya');
  }

  // 7. video (3c-5): peminta merakit video dari blok pemilik; kontainer blok pertama diperiksa terhadap mime; cache video 6 blok LRU untuk seek
  {
    const { PAGE_VIDEO_MAX } = require('../src/archne-pagestore');
    const mp4 = (n, seed) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), rnd(n, seed)]);
    const vbin = mp4(MEDIA_CHUNK * 2 + 777, 11), wbin = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....webm'), rnd(300, 5)]);
    const vp = path.join(tmp, 'v.mp4'), wp = path.join(tmp, 'w.webm'), fp = path.join(tmp, 'v.bin'); fs.writeFileSync(vp, vbin); fs.writeFileSync(wp, wbin); fs.writeFileSync(fp, rnd(500, 3));
    const [vA, vW, vN] = await ps.addVideos([{ src: vp }, { src: wp }, { src: wp }]), [fN] = await ps.addFiles([{ src: fp }]);
    const pubV = ps.create({ text: 'v publik', videos: [vA] }), frdV = ps.create({ text: 'v teman', priv: 'friends', videos: [vW] }), ndV = ps.create({ text: 'v nodl', videos: [vN], files: [fN], nodl: true });
    A._pgMediaRate = new Map();
    const blocks = (who, r) => [...who._ptok.get(r.tok).blocks.keys()];
    // 3d-b1: grup ini menguji perakitan, bukan batas stream (itu grup 7b): sebelum tiap pageMedia peminta, semua token video dianggap sudah diam
    const realPM = new Map(); for (const n of [B, C]) { const f = n.pageMedia; realPM.set(n, f); n.pageMedia = function (...x) { for (const e of (this._ptok || new Map()).values()) e.last = 0; return f.apply(this, x); }; }

    // a. milik sendiri: dibaca dari PageStore lokal lewat token yang sama
    {
      const r = await A.pageMedia(A.id, pubV.id, vA.id);
      assert.deepStrictEqual({ mime: r.mime, total: r.total }, { mime: 'video/mp4', total: vbin.length });
      const s = await slurp(A, r.tok); assert.strictEqual(s.headers['content-type'], 'video/mp4'); assert(s.body.equals(vbin), 'isi identik');
      assert.strictEqual(await A.pageMedia(A.id, pubV.id, mP.id), null, 'id gambar postingan lain = null');
    }
    // b. asing dan teman: rakitan utuh identik; 3 permintaan; seek acak (ekor dulu, lalu tengah, lalu awal) identik
    for (const who of [C, B]) {
      A._pgMediaRate = new Map(); asks.n = 0;
      const r = await who.pageMedia(A.id, pubV.id, vA.id);
      assert.deepStrictEqual({ mime: r.mime, total: r.total }, { mime: 'video/mp4', total: vbin.length });
      const s = await slurp(who, r.tok); assert.strictEqual(s.status, 200); assert.strictEqual(s.headers['content-type'], 'video/mp4'); assert(s.body.equals(vbin), 'rakitan identik');
      assert.strictEqual(asks.n, 3, '1 permintaan per blok: ' + asks.n);
      const r2 = await who.pageMedia(A.id, pubV.id, vA.id); asks.n = 0;
      for (const [a, z] of [[vbin.length - 500, vbin.length - 1], [MEDIA_CHUNK - 50, MEDIA_CHUNK + 50], [0, 99]]) { const g = await slurp(who, r2.tok, `bytes=${a}-${z}`); assert.strictEqual(g.status, 206); assert(g.body.equals(vbin.subarray(a, z + 1)), 'seek ' + a); }
      assert.strictEqual((await slurp(who, r2.tok, 'bytes=-100')).body.length, 100);
      assert.strictEqual(asks.n, 2, 'seek ekor (blok 2) dan tengah (blok 1) = 2 permintaan; blok 0 sudah di cache dari pageMedia, awal dan -100 dilayani cache: ' + asks.n);
    }
    // c. cache video 6 blok (LRU): semua 3 blok tetap tersimpan dan dibaca ulang tanpa permintaan baru; gambar tetap 2 blok dan LRU
    {
      const r = await C.pageMedia(A.id, pubV.id, vA.id); await slurp(C, r.tok); asks.n = 0;
      assert.strictEqual(blocks(C, r).length, 3, 'video menyimpan semua 3 blok (batas 6)');
      for (const o of [vbin.length - 5, 5, MEDIA_CHUNK + 5, 7]) await C.mediaSrcRead(r.tok, o, 3);
      assert.strictEqual(asks.n, 0, 'bacaan ulang dari cache, tanpa permintaan');
      const e = C._ptok.get(r.tok); e.blocks.clear(); asks.n = 0; // 8 blok sintetis dilewati: pakai urutan akses untuk menguji LRU
      for (const o of [0, MEDIA_CHUNK, 0, MEDIA_CHUNK * 2]) await C.mediaSrcRead(r.tok, o + 1, 3);
      assert.deepStrictEqual(blocks(C, r).sort(), [0, 1, 2], 'video: 6 cukup untuk 3 blok'); assert.deepStrictEqual(blocks(C, r), [1, 0, 2], 'urutan = urutan pakai (0 disentuh ulang)');
      const ri = await C.pageMedia(A.id, pub.id, mP.id); asks.n = 0;
      for (const o of [0, MEDIA_CHUNK, 0, MEDIA_CHUNK * 2]) await C.mediaSrcRead(ri.tok, o + 1, 3);
      assert.deepStrictEqual(blocks(C, ri), [0, 2], 'gambar: LRU, blok 1 yang paling lama tak dipakai tersingkir (bukan blok 0)');
      asks.n = 0; await C.mediaSrcRead(ri.tok, 9, 3); assert.strictEqual(asks.n, 0, 'blok 0 masih di cache');
    }
    // d. privasi seragam; nodl tidak menutup video; argumen cacat
    {
      A._pgMediaRate = new Map();
      assert.strictEqual((await B.pageMedia(A.id, frdV.id, vW.id)).mime, 'video/webm', 'teman: webm');
      for (const who of [C, D]) assert.strictEqual(await who.pageMedia(A.id, frdV.id, vW.id), null, 'asing / diblokir = null');
      assert.strictEqual(await D.pageMedia(A.id, pubV.id, vA.id), null, 'diblokir juga untuk video publik');
      assert.strictEqual(await C.pageMedia(A.id, pubV.id, vW.id), null, 'id video postingan lain = null');
      assert.strictEqual((await C.pageMedia(A.id, ndV.id, vN.id)).mime, 'video/webm', 'nodl: video tetap terbaca');
      assert.strictEqual(await code(C.pageMedia(A.id, pubV.id, 'zz')), 'bad');
    }
    // e. pemilik nakal: blok pertama video harus punya kontainer yang cocok dengan mime; batas ukuran video; blok berikut harus konsisten
    {
      A._pgMediaRate = new Map();
      const forge = (mime, bytes, total) => () => ({ t: 'pg_media', ok: true, chunk: { mime, total: total || bytes.length, off: 0, b64: bytes.toString('base64') } });
      const small = mp4(40, 1), smallW = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....webm'), rnd(30, 2)]), mkv = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....matroska'), rnd(30, 3)]);
      const cases = [
        ['mp4 diklaim, isi acak', forge('video/mp4', rnd(64, 9))],
        ['mp4 diklaim, isi webm', forge('video/mp4', smallW)],
        ['webm diklaim, isi mp4', forge('video/webm', small)],
        ['webm diklaim, isi mkv', forge('video/webm', mkv)],
        ['video diklaim, isi PNG', forge('video/mp4', png)],
        ['gambar diklaim, isi mp4', forge('image/png', small)],
        ['mime video tak dikenal', forge('video/quicktime', small)],
        ['mime audio', forge('audio/mp4', small)],
        ['total melebihi batas video', (r) => Object.assign({}, r, { chunk: Object.assign({}, r.chunk, { total: PAGE_VIDEO_MAX + 1 }) })],
        ['total nol', (r) => Object.assign({}, r, { chunk: Object.assign({}, r.chunk, { total: 0 }) })],
        ['off salah', (r) => Object.assign({}, r, { chunk: Object.assign({}, r.chunk, { off: 5 }) })],
        ['panjang tidak sesuai total', forge('video/mp4', small, 41)],
      ];
      for (const [label, h] of cases) { asks.hook = h; assert.strictEqual(await code(C.pageMedia(A.id, pubV.id, vA.id)), 'proto', label); }
      asks.hook = forge('video/mp4', small); assert.strictEqual((await C.pageMedia(A.id, pubV.id, vA.id)).total, small.length, 'kontrol: mp4 kecil yang sah diterima');
      asks.hook = forge('video/webm', smallW); assert.strictEqual((await C.pageMedia(A.id, pubV.id, vA.id)).mime, 'video/webm', 'kontrol: webm sah diterima');
      asks.hook = null; const r = await C.pageMedia(A.id, pubV.id, vA.id), blk = MEDIA_CHUNK + 3;
      const mut = (f) => (x) => Object.assign({}, x, { chunk: f(Object.assign({}, x.chunk)) });
      for (const [label, h] of [['berikut: mime berubah ke webm', mut((c) => Object.assign(c, { mime: 'video/webm' }))], ['berikut: mime jadi gambar', mut((c) => Object.assign(c, { mime: 'image/png' }))], ['berikut: total berubah', mut((c) => Object.assign(c, { total: c.total + 1 }))], ['berikut: panjang salah', mut((c) => Object.assign(c, { b64: c.b64.slice(0, 800) }))]]) {
        asks.hook = h; assert.strictEqual(await C.mediaSrcRead(r.tok, blk, 10), null, label);
      }
      assert.strictEqual(blocks(C, r).includes(1), false, 'blok cacat tidak disimpan');
      asks.hook = null; assert((await C.mediaSrcRead(r.tok, blk, 10)).equals(vbin.subarray(blk, blk + 10)), 'pulih sesudah jawaban baik');
    }
    // f. pemilik tanpa 'pgm' = old, juga untuk video
    {
      const pa = C.peers.get(A.id), caps = pa.caps; pa.caps = ['rx', 'pg'];
      assert.strictEqual(await code(C.pageMedia(A.id, pubV.id, vA.id)), 'old'); pa.caps = caps;
    }
    ok('video: milik sendiri dan jauh identik (3 blok, seek acak); cache video 6 blok LRU (gambar tetap 2); privasi seragam, nodl tidak menutup; 12 bentuk cacat blok pertama = proto, 4 pada blok berikut = null; tanpa pgm = old');
    for (const [n, f] of realPM) n.pageMedia = f;
  }

  // 7b. batas stream video bersamaan (3d-b1): 2 aktif per pemilik, 3 per Core; aktif = dibuat / dibaca < 15 dtk; token yang ada tidak pernah ditolak; gambar dan video sendiri tidak dihitung
  {
    const mp4 = (n, seed) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), rnd(n, seed)]);
    const sp = path.join(tmp, 's.mp4'); fs.writeFileSync(sp, mp4(2000, 21));
    const vs = await ps.addVideos([{ src: sp }, { src: sp }, { src: sp }, { src: sp }]);
    const post = ps.create({ text: 'banyak video', videos: vs });
    A._pgMediaRate = new Map(); C._ptok = new Map();
    const get = (i) => C.pageMedia(A.id, post.id, vs[i].id), age = (r, ms) => { C._ptok.get(r.tok).last -= ms; };
    const live = () => [...C._ptok.values()].filter((e) => e.vid).length;

    // a. dua aktif dari satu pemilik lolos, yang ketiga 'streams' tanpa meninggalkan token; pembacaan token yang ada tidak ditolak; gambar dan video sendiri tidak dihitung
    const r1 = await get(0), r2 = await get(1);
    asks.n = 0; assert.strictEqual(await code(get(2)), 'streams'); assert.strictEqual(asks.n, 1, 'hanya blok pertama yang sempat diminta');
    assert.strictEqual(live(), 2, 'tidak ada token tersisa dari yang ditolak');
    assert.strictEqual((await C.mediaSrcRead(r1.tok, 0, 8)).length, 8, 'token yang sudah ada tetap terbaca');
    assert.strictEqual((await C.pageMedia(A.id, pub.id, mP.id)).mime, 'image/png', 'gambar tidak dibatasi');
    for (let i = 0; i < 3; i++) assert.strictEqual((await A.pageMedia(A.id, post.id, vs[i].id)).mime, 'video/mp4', 'video sendiri tidak dibatasi');
    assert.strictEqual(e1(await C.mediaSrcRead(r2.tok, 0, 8)), 8);
    function e1(b) { return b && b.length; }

    // b. video yang diam > 15 dtk keluar dari hitungan; yang baru dibaca masuk lagi
    age(r1, 16000); const r3 = await get(2);
    assert.strictEqual(await code(get(3)), 'streams', 'r2 dan r3 aktif');
    age(r2, 16000); age(r3, 16000);
    assert.strictEqual((await C.mediaSrcRead(r1.tok, 0, 8)).length, 8, 'token diam masih terbaca');
    const r4 = await get(3);
    assert.strictEqual(await code(get(0)), 'streams', 'r1 (baru dibaca) dan r4 aktif: bacaan mengaktifkan lagi');
    ok('video jauh: 2 aktif per pemilik, ketiga = streams (hanya 1 blok terambil, tanpa token); token ada tetap terbaca; gambar dan video sendiri bebas; diam 15 dtk = keluar, dibaca = masuk lagi');

    // c. batas per Core (3) lintas pemilik, dan token kedaluwarsa tidak dihitung
    C._ptok = new Map(); const now = Date.now(), fk = (i, o) => C._ptok.set(String(i).repeat(32), Object.assign({ vid: true, self: false, peerId: String(i).repeat(16), exp: now + 1e6, last: now }, o));
    fk(1); fk(2); const rr = await get(0); assert.strictEqual(rr.mime, 'video/mp4', 'dua pemilik lain + satu ini = 3: lolos');
    assert.strictEqual(await code(get(1)), 'streams', 'ke-4 dalam Core (pemilik ini baru 1) ditolak oleh batas Core');
    C._ptok.get('1'.repeat(32)).exp = now - 1; assert.strictEqual((await get(1)).mime, 'video/mp4', 'token kedaluwarsa tidak dihitung');
    ok('batas 3 per Core lintas pemilik; token kedaluwarsa tidak dihitung');
    C._ptok = new Map();
  }

  // 8. pemilik versi lama (belum 'pgm'), lalu pemilik hilang di tengah aliran
  {
    const pa = C.peers.get(A.id), caps = pa.caps; pa.caps = ['rx', 'pg'];
    assert.strictEqual(await code(C.pageMedia(A.id, pub.id, mP.id)), 'old'); pa.caps = caps;
    const r = await C.pageMedia(A.id, pub.id, mP.id);
    assert((await C.mediaSrcRead(r.tok, 10, 10)).equals(big.subarray(10, 20)), 'blok pertama tersimpan');
    await A.stop();
    assert((await C.mediaSrcRead(r.tok, 20, 10)).equals(big.subarray(20, 30)), 'blok yang sudah ada tetap terbaca');
    assert.strictEqual(await C.mediaSrcRead(r.tok, MEDIA_CHUNK * 2 + 1, 10), null, 'pemilik offline: aliran berhenti');
    const s = await slurp(C, r.tok); assert(s.body.length < big.length && s.body.equals(big.subarray(0, s.body.length)), 'sebagian yang sampai tetap benar, tidak ada byte rusak');
    ok("pemilik tanpa 'pgm' = old; pemilik offline di tengah aliran: blok tersimpan tetap terbaca, sisanya null, tanpa byte rusak");
  }

  console.log('\n' + pass + ' kelompok lulus');
  for (const n of all) await n.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

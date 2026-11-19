'use strict';
// Tes jembatan IPC Halaman (1c-4a): src/archne-ipc-pages.js dengan Electron palsu + dua Core sungguhan.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { FILE_CHUNK } = require('../src/archne-pagestore');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pgipc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(20); } throw new Error('timeout: ' + label); }
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 });
// Peer `id` di mata `core` tampak versi lama (caps ['pg']). hello berkala mengganti objek peer dan memulihkan caps kapan saja, jadi bukan caps yang diubah, melainkan pembacaan peers.get yang dibungkus. Kembalian: fungsi pemulih.
function oldPeer(core, id) { const real = core.peers.get.bind(core.peers); core.peers.get = (x) => { const p = real(x); return x === id && p ? Object.assign({}, p, { caps: ['pg'] }) : p; }; return () => { delete core.peers.get; }; }
function fake(core) {
  const handlers = {}, sent = [];
  register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core, send: (ch, p) => sent.push([ch, p]), log: () => {} });
  const f = (n, ...a) => handlers[n]({}, ...a);
  f.sent = sent; // [kanal, muatan] yang sampai ke renderer
  return f;
}

(async () => {
  const A = mk('A'), B = mk('B'); const a = fake(A), b = fake(B);
  await A.start(); await B.start();
  try {
    // pemilik
    let r = await a('pgCreate', 'halo dunia', 'public'); assert(r.ok && r.post.text === 'halo dunia'); const id1 = r.post.id;
    r = await a('pgCreate', 'rahasia teman', 'friends'); assert(r.ok);
    r = await a('pgMine', {}); assert(r.ok && r.items.length === 2); ok('pemilik: buat + daftar milik sendiri');
    // validasi
    for (const [n, args] of [['pgCreate', [42]], ['pgCreate', ['x', 5]], ['pgCreate', ['x', 'ngawur']], ['pgMine', ['x']], ['pgMine', [{ after: 'ngawur' }]], ['pgMine', [{ limit: 1.5 }]], ['pgRemove', ['../x']], ['pgList', ['xyz', {}]], ['pgGet', [B.id, 'bukanhex']]]) {
      r = await a(n, ...args); assert(r.ok === false && r.err, n + ' harus ditolak'); }
    r = await a('pgAvail', 'xyz'); assert(r.ok === false && r.why === 'peer'); ok('masukan tak sah ditolak');
    // gambar (2a-3)
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
    const img = path.join(tmp, 'gb.png'); fs.writeFileSync(img, png); const txt = path.join(tmp, 'x.png'); fs.writeFileSync(txt, 'bukan gambar, hanya teks');
    const mdir = path.join(A._pagesDir(), 'media'), nm = () => (fs.existsSync(mdir) ? fs.readdirSync(mdir).length : 0);
    r = await a('pgCreate', 'ada gambar', 'public', [{ src: img }]); assert(r.ok && r.post.media && r.post.media[0].mime === 'image/png' && nm() === 1);
    const mid = r.post.id; r = await a('pgRemove', mid); assert(r.ok && nm() === 0);
    for (const args of [['x', 'public', 42], ['x', 'public', 'string-bukan-larik.png'], ['x', 'public', [{ src: 'relatif.png' }]], ['x', 'public', [{ src: txt }]], ['x', 'public', [{ src: path.join(tmp, 'tak-ada.png') }]], ['x', 'ngawur', [{ src: img }]]]) { r = await a('pgCreate', ...args); assert(r.ok === false && r.err); }
    assert.strictEqual(nm(), 0, 'gagal tidak meninggalkan salinan yatim'); r = await a('pgMine', {}); assert.strictEqual(r.items.length, 2, 'gagal tidak membuat postingan');
    ok('pgCreate dengan gambar: tersimpan, hapus ikut membuang, input cacat ditolak tanpa sisa');
    // thumbnail (2b-2)
    const jpg = (w, h) => { const b = Buffer.alloc(24); Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]).copy(b); return b.toString('base64'); }; // SOI + SOF0 saja: cukup untuk jpegSize
    const th = jpg(200, 150);
    r = await a('pgCreate', 'ada thumbnail', 'public', [{ src: img, th }]); assert(r.ok && r.post.media[0].th === th); const tid = r.post.id;
    r = await a('pgMine', {}); assert.strictEqual(r.items.find((p) => p.id === tid).media[0].th, th, 'th tersimpan dan ikut pgMine');
    r = await a('pgCreate', 'th tak sah diabaikan', 'public', [{ src: img, th: jpg(900, 900) }]); assert(r.ok && r.post.media[0].th === undefined && nm() === 2, 'th >320 px: postingan jadi tanpa thumbnail'); const tid2 = r.post.id;
    for (const bd of [42, 'x'.repeat(16385)]) { r = await a('pgCreate', 'x', 'public', [{ src: img, th: bd }]); assert(r.ok === false && r.code === 'bad'); }
    assert.strictEqual(nm(), 2, 'th cacat tidak meninggalkan salinan yatim'); r = await a('pgCreate', 'tanpa gambar', 'public', []); assert(r.ok && !r.post.media, 'larik kosong = postingan teks'); const e1 = r.post.id; r = await a('pgCreate', 'tanpa gambar 2', 'public', null); assert(r.ok && !r.post.media, 'null = postingan teks'); const e2 = r.post.id;
    for (const id of [tid, tid2, e1, e2]) await a('pgRemove', id); assert.strictEqual(nm(), 0);
    ok('pgCreate dengan th: tersimpan; th tak sah diabaikan; bukan string/terlalu panjang ditolak tanpa sisa');
    // banyak gambar (2c)
    {
      const img2 = path.join(tmp, 'gb2.png'), img3 = path.join(tmp, 'gb3.png'); fs.writeFileSync(img2, png); fs.writeFileSync(img3, png);
      const th2 = jpg(100, 80), n0 = nm(), cnt0 = (await a('pgMine', {})).items.length;
      r = await a('pgCreate', 'tiga gambar', 'friends', [{ src: img, th }, { src: img2 }, { src: img3, th: th2 }]);
      assert(r.ok && r.post.media.length === 3 && nm() === n0 + 3, 'tiga gambar tersimpan'); const trid = r.post.id;
      assert.deepStrictEqual(r.post.media.map((m) => m.name), ['gb.png', 'gb2.png', 'gb3.png'], 'urutan = urutan masukan');
      assert.deepStrictEqual(r.post.media.map((m) => m.th), [th, undefined, th2], 'th per gambar');
      assert.strictEqual(r.post.priv, 'friends');
      r = await a('pgMine', {}); assert.strictEqual(r.items.find((p) => p.id === trid).media.length, 3, 'pgMine membawa ketiganya');
      // batas: 10 boleh, 11 ditolak sebelum menyentuh apa pun
      const many = (k) => Array.from({ length: k }, () => ({ src: img }));
      r = await a('pgCreate', 'sepuluh', 'public', many(10)); assert(r.ok && r.post.media.length === 10 && nm() === n0 + 13); const tenId = r.post.id;
      r = await a('pgCreate', 'sebelas', 'public', many(11)); assert(r.ok === false && r.code === 'bad' && /maksimal 10/.test(r.err) && nm() === n0 + 13, 'lebih dari 10 ditolak tanpa salinan');
      // satu entri cacat di antara yang baik: tidak ada yang tersisa
      for (const bad of [[{ src: img }, { src: txt }, { src: img2 }], [{ src: img }, { src: 'relatif.png' }], [{ src: img }, null], [{ src: img }, 'teks'], [{ src: img }, { src: img, th: 5 }], [{ src: img }, { src: '' }], [{ th }]]) {
        r = await a('pgCreate', 'cacat', 'public', bad); assert(r.ok === false && r.err, 'harus ditolak: ' + JSON.stringify(bad));
      }
      r = await a('pgCreate', 'x', 'public', [{ src: img }, { src: txt }]); assert(/Image 2: /.test(r.err), 'pesan menyebut gambar ke berapa: ' + r.err);
      r = await a('pgCreate', '   ', 'public', [{ src: img }, { src: img2 }]); assert(r.ok === false, 'teks kosong ditolak');
      assert.strictEqual(nm(), n0 + 13, 'tidak ada salinan yatim dari kegagalan apa pun');
      assert.strictEqual((await a('pgMine', {})).items.length, cnt0 + 2, 'hanya dua postingan yang jadi');
      // bidang tambahan di entri tidak diteruskan
      r = await a('pgCreate', 'bidang lain', 'public', [{ src: img, name: '../../evil', mime: 'text/html', id: 'x' }]); assert(r.ok && r.post.media[0].name === 'gb.png' && r.post.media[0].mime === 'image/png', 'hanya src/th yang dipakai'); const xtra = r.post.id;
      for (const id of [trid, tenId, xtra]) await a('pgRemove', id);
      assert.strictEqual(nm(), n0, 'hapus postingan membuang semua salinan gambarnya');
    }
    ok('pgCreate banyak gambar: berurutan, th per gambar, batas 10, satu cacat = tidak ada yang tersisa, bidang liar diabaikan, hapus membuang semuanya');
    // lampiran (3a-6): pgCreate(text, priv, images, files)
    {
      const fdir = path.join(A._pagesDir(), 'files'), nf = () => (fs.existsSync(fdir) ? fs.readdirSync(fdir).length : 0);
      const f1 = path.join(tmp, 'laporan.pdf'), f2 = path.join(tmp, 'data.zip'), empty = path.join(tmp, 'kosong.bin'), dirp = path.join(tmp, 'folder');
      fs.writeFileSync(f1, 'isi laporan'); fs.writeFileSync(f2, Buffer.alloc(1000, 7)); fs.writeFileSync(empty, ''); fs.mkdirSync(dirp, { recursive: true });
      const n0 = nf(), m0 = nm(), c0 = (await a('pgMine', {})).items.length;
      r = await a('pgCreate', 'ada lampiran', 'friends', null, [{ src: f1 }, { src: f2 }]);
      assert(r.ok && r.post.files.length === 2 && nf() === n0 + 2 && r.post.priv === 'friends', JSON.stringify(r));
      assert.deepStrictEqual(r.post.files.map((x) => [x.name, x.size]), [['laporan.pdf', 11], ['data.zip', 1000]], 'urutan + nama + ukuran dari berkas'); assert(!r.post.media, 'lampiran bukan gambar');
      const fid = r.post.id; r = await a('pgMine', {}); assert.strictEqual(r.items.find((p) => p.id === fid).files.length, 2, 'pgMine membawa lampiran');
      r = await a('pgRemove', fid); assert(r.ok && nf() === n0, 'hapus postingan membuang salinan lampiran');
      // gambar + lampiran sekaligus
      r = await a('pgCreate', 'keduanya', 'public', [{ src: img }], [{ src: f1 }]); assert(r.ok && r.post.media.length === 1 && r.post.files.length === 1 && nm() === m0 + 1 && nf() === n0 + 1); const bid = r.post.id;
      r = await a('pgRemove', bid); assert(r.ok && nm() === m0 && nf() === n0);
      // kosong / null = postingan teks
      for (const v of [[], null, undefined]) { r = await a('pgCreate', 'tanpa lampiran', 'public', null, v); assert(r.ok && !r.post.files, 'tanpa lampiran: ' + JSON.stringify(v)); await a('pgRemove', r.post.id); }
      // bidang liar diabaikan
      r = await a('pgCreate', 'liar', 'public', null, [{ src: f1, name: '../../evil', size: 1, id: 'x' }]); assert(r.ok && r.post.files[0].name === 'laporan.pdf' && r.post.files[0].size === 11); await a('pgRemove', r.post.id);
      // 10 boleh, 11 ditolak sebelum menyentuh apa pun
      const many = (k) => Array.from({ length: k }, () => ({ src: f1 }));
      r = await a('pgCreate', 'sepuluh', 'public', null, many(10)); assert(r.ok && r.post.files.length === 10 && nf() === n0 + 10); await a('pgRemove', r.post.id);
      r = await a('pgCreate', 'sebelas', 'public', null, many(11)); assert(r.ok === false && r.code === 'bad' && /maksimal 10/.test(r.err) && nf() === n0);
      // cacat: tidak ada postingan dan tidak ada salinan yatim (gambar maupun lampiran)
      const cases = [['bukan larik', 'x.pdf'], ['angka', 42], ['relatif', [{ src: 'relatif.pdf' }]], ['entri null', [{ src: f1 }, null]], ['entri string', [{ src: f1 }, 'teks']], ['src kosong', [{ src: f1 }, { src: '' }]], ['tanpa src', [{ name: 'x' }]], ['src bukan string', [{ src: 5 }]], ['src terlalu panjang', [{ src: '/' + 'a'.repeat(4100) }]],
        ['relatif tapi ada', [{ src: 'package.json' }]], ['tak ada', [{ src: f1 }, { src: path.join(tmp, 'tak-ada.bin') }]], ['berkas kosong', [{ src: f1 }, { src: empty }]], ['folder', [{ src: f1 }, { src: dirp }]]];
      for (const [nmx, fl] of cases) { r = await a('pgCreate', 'cacat', 'public', [{ src: img }], fl); assert(r.ok === false && r.err, 'harus ditolak: ' + nmx); if (nmx === 'relatif tapi ada') assert.strictEqual(r.code, 'bad', 'jalur relatif ditolak di jembatan, bukan dibaca dari cwd Core'); assert(nf() === n0 && nm() === m0, 'tanpa sisa (' + nmx + '): berkas ' + nf() + ' gambar ' + nm()); }
      r = await a('pgCreate', 'x', 'public', null, [{ src: f1 }, { src: empty }]); assert(/File 2: /.test(r.err), 'pesan menyebut berkas ke berapa: ' + r.err);
      r = await a('pgCreate', '   ', 'public', [{ src: img }], [{ src: f1 }]); assert(r.ok === false && nf() === n0 && nm() === m0, 'teks kosong: gambar dan lampiran yang sempat disalin dibuang');
      r = await a('pgCreate', 'x', 'ngawur', [{ src: img }], [{ src: f1 }]); assert(r.ok === false && nf() === n0 && nm() === m0, 'privasi tak sah: tanpa sisa');
      assert.strictEqual((await a('pgMine', {})).items.length, c0, 'tidak ada postingan dari kegagalan apa pun');
    }
    ok('pgCreate dengan lampiran: berurutan + nama/ukuran dari berkas, bersama gambar, batas 10, bidang liar diabaikan, hapus membuang salinan, cacat apa pun = tanpa postingan dan tanpa sisa');
    // jarak jauh
    await A.addPeer('127.0.0.1', B.port); await B.addPeer('127.0.0.1', A.port);
    await until(() => A.isOnline(A.peers.get(B.id)) && B.isOnline(B.peers.get(A.id)), 5000, 'online');
    r = await b('pgAvail', A.id); assert(r.ok === true);
    r = await b('pgList', A.id, { limit: 10 }); assert(r.ok && r.items.length === 1 && r.items[0].id === id1); ok('peer melihat postingan publik saja');
    r = await b('pgGet', A.id, id1); assert(r.ok && r.post && r.post.text === 'halo dunia'); ok('pgGet postingan utuh');
    // gambar penuh (2d-4): pgImage hanya mengembalikan token penyaji
    {
      r = await a('pgCreate', 'gambar publik', 'public', [{ src: img }]); assert(r.ok); const pubP = r.post.id, pubM = r.post.media[0].id;
      r = await a('pgCreate', 'gambar teman', 'friends', [{ src: img }]); assert(r.ok); const frP = r.post.id, frM = r.post.media[0].id;
      r = await b('pgImage', A.id, pubP, pubM);
      assert(r.ok && r.image && Object.keys(r).sort().join() === 'image,ok' && Object.keys(r.image).sort().join() === 'mime,tok,total', 'hanya tok/mime/total yang keluar');
      assert(/^[0-9a-f]{32}$/.test(r.image.tok) && r.image.mime === 'image/png' && r.image.total === png.length);
      const ms = require('../src/archne-mediaserve'), pl = ms.plan(B, r.image.tok, undefined);
      assert.strictEqual(pl.status, 200); assert.strictEqual(pl.headers['content-type'], 'image/png'); assert.strictEqual(pl.headers['content-length'], String(png.length));
      assert(Buffer.compare(await B.mediaSrcRead(r.image.tok, 0, png.length), png) === 0, 'byte lewat token = berkas asli');
      r = await b('pgImage', A.id, frP, frM); assert(r.ok === true && r.image === null, 'bukan teman: tak dibedakan dari tidak ada');
      r = await b('pgImage', A.id, pubP, '0123456789abcdef'); assert(r.ok === true && r.image === null, 'id gambar tak dikenal = null');
      r = await a('pgImage', A.id, frP, frM); assert(r.ok && r.image && r.image.total === png.length, 'pemilik membuka gambarnya sendiri (juga yang Teman)');
      for (const args of [[], ['xyz', pubP, pubM], [A.id, 'bukanhex', pubM], [A.id, pubP, '../../x'], [A.id, pubP, 42], [A.id, null, pubM], [{}, pubP, pubM]]) { r = await b('pgImage', ...args); assert(r.ok === false && r.code === 'bad', 'harus ditolak: ' + JSON.stringify(args)); }
      { // pemilik versi lama (caps 'pg' tanpa 'pgm'): galat ber-code 'old' sampai ke renderer, bukan null
        const undo = oldPeer(B, A.id);
        try { r = await b('pgImage', A.id, pubP, pubM); assert(r.ok === false && r.code === 'old' && r.err, 'old: ' + JSON.stringify(r)); } finally { undo(); }
        r = await b('pgImage', A.id, pubP, pubM); assert(r.ok && r.image, 'caps pulih = berhasil lagi');
      }
      await a('pgRemove', pubP); await a('pgRemove', frP);
      r = await b('pgImage', A.id, pubP, pubM); assert(r.ok === true && r.image === null, 'postingan dihapus = null');
    }
    { // Core tiruan: penjaga di jembatan berdiri sendiri (Core.pageMedia juga memeriksa, jadi tes dengan Core asli tidak bisa membedakannya)
      const calls = []; let ans = { tok: 'a'.repeat(32), mime: 'image/png', total: 9, path: '/etc/passwd', peerId: 'x' };
      const h = {}; require('../src/archne-ipc-pages').registerPages({ ipcMain: { handle: (n, fn) => { h[n] = fn; } }, core: { pageMedia: async (...x) => { calls.push(x); return ans; } } });
      const H16 = '0123456789abcdef', g = (...x) => h.pgImage({}, ...x);
      for (const args of [[], ['xyz', H16, H16], [H16, 'bukanhex', H16], [H16, H16, 'bukanhex'], [H16, H16, H16 + 'a'], [H16, H16, 42], [H16, null, H16], [{}, H16, H16], [H16.toUpperCase(), H16, H16], [H16, H16, '../../x']]) { r = await g(...args); assert(r.ok === false && r.code === 'bad', JSON.stringify(args)); }
      assert.strictEqual(calls.length, 0, 'masukan cacat tidak pernah sampai ke Core');
      r = await g(H16, H16, H16); assert.deepStrictEqual(r, { ok: true, image: { tok: 'a'.repeat(32), mime: 'image/png', total: 9 } }, 'bidang lain dari Core tidak ikut keluar');
      assert.deepStrictEqual(calls, [[H16, H16, H16]]); ans = null; r = await g(H16, H16, H16); assert.deepStrictEqual(r, { ok: true, image: null });
    }
    ok('pgImage: hanya token (tok/mime/total) yang lewat, byte sama, Teman tersembunyi, id cacat ditolak, milik sendiri bisa dibuka');

    // video (3c-6): pgCreate opts.videos (pemilik) + pgVideo (peminta) + klien api-http
    {
      const { VIDEOS_MAX } = require('../src/archne-pagestore');
      const cnt = (d) => { const f = path.join(A.opts.dataDir, 'pages', d); return fs.existsSync(f) ? fs.readdirSync(f).filter((n) => !n.endsWith('.tmp')).length : 0; };
      const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(3000, 7)]), webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....webm'), Buffer.alloc(500, 9)]);
      const v1 = path.join(tmp, 'a.mp4'), v2 = path.join(tmp, 'b.webm'), fake = path.join(tmp, 'palsu.mp4'), mkv = path.join(tmp, 'c.mkv'), f9 = path.join(tmp, 'lamp.bin');
      fs.writeFileSync(v1, mp4); fs.writeFileSync(v2, webm); fs.writeFileSync(fake, 'ini teks, bukan video'); fs.writeFileSync(mkv, mp4); fs.writeFileSync(f9, 'lampiran');
      const c0 = () => [cnt('videos'), cnt('media'), cnt('files')], base = c0(), n0 = (await a('pgMine', {})).items.length;
      // a. sukses: dua video berurutan bersama gambar + lampiran + nodl; bidang liar di entri diabaikan (jenis dari isi, nama/ukuran dari berkas)
      r = await a('pgCreate', 'berbideo', 'public', [{ src: img }], [{ src: f9 }], { nodl: true, videos: [{ src: v1, name: '../../evil', mime: 'text/html', size: 1, id: 'x' }, { src: v2 }] });
      assert(r.ok, JSON.stringify(r)); const vp = r.post;
      assert.deepStrictEqual(vp.videos.map((v) => [v.mime, v.name, v.size]), [['video/mp4', 'a.mp4', mp4.length], ['video/webm', 'b.webm', webm.length]]);
      assert(vp.media.length === 1 && vp.files.length === 1 && vp.nodl === true);
      assert.deepStrictEqual(c0(), [base[0] + 2, base[1] + 1, base[2] + 1], 'tiga jenis salinan ada');
      // b. opts tanpa video = seperti sebelumnya
      for (const o of [null, {}, { videos: [] }, { videos: null }, { nodl: false }]) { r = await a('pgCreate', 'biasa', 'public', null, null, o); assert(r.ok && !r.post.videos, JSON.stringify(o)); await a('pgRemove', r.post.id); }
      // c. bentuk cacat ditolak SEBELUM menyalin apa pun (gambar dan lampiran di panggilan yang sama juga tidak disalin)
      const snap = c0();
      const bads = [['bukan larik', 'a.mp4'], ['objek', { src: v1 }], ['5 video', Array.from({ length: VIDEOS_MAX + 1 }, () => ({ src: v1 }))], ['item null', [null]], ['item string', [v1]], ['src relatif', [{ src: 'a.mp4' }]], ['src bukan string', [{ src: 5 }]], ['src kosong', [{ src: '' }]], ['src terlalu panjang', [{ src: '/' + 'a'.repeat(4100) + '.mp4' }]], ['satu cacat di antara yang sah', [{ src: v1 }, { src: 'rel.mp4' }]]];
      for (const [label, vv] of bads) { r = await a('pgCreate', 'cacat', 'public', [{ src: img }], [{ src: f9 }], { videos: vv }); assert(r.ok === false && r.code === 'bad', label + ': ' + JSON.stringify(r)); assert.deepStrictEqual(c0(), snap, label + ': tanpa salinan'); }
      assert(/maksimal 4/.test((await a('pgCreate', 'x', 'public', null, null, { videos: bads[2][1] })).err), 'pesan menyebut batas');
      r = await a('pgCreate', 'x', 'public', null, null, [{ src: v1 }]); assert(r.ok === false && r.code === 'bad', 'opts larik = bad');
      // d. gagal sesudah menyalin: isi bukan video / ekstensi tak didukung / teks atau privasi tak sah = tidak ada yang tersisa (video, gambar, lampiran)
      r = await a('pgCreate', 'x', 'public', [{ src: img }], [{ src: f9 }], { videos: [{ src: v1 }, { src: fake }] }); assert(r.ok === false && /Video 2: /.test(r.err), r.err); assert.deepStrictEqual(c0(), snap, 'video ke-2 cacat');
      r = await a('pgCreate', 'x', 'public', null, null, { videos: [{ src: mkv }] }); assert(r.ok === false && /mp4 or webm/.test(r.err), r.err); assert.deepStrictEqual(c0(), snap, 'mkv');
      r = await a('pgCreate', 'x', 'public', null, null, { videos: [{ src: path.join(tmp, 'tidak-ada.mp4') }] }); assert(r.ok === false); assert.deepStrictEqual(c0(), snap, 'berkas hilang');
      for (const [t, pv] of [['   ', 'public'], ['x', 'ngawur']]) { r = await a('pgCreate', t, pv, [{ src: img }], [{ src: f9 }], { videos: [{ src: v1 }] }); assert(r.ok === false, 'teks / privasi tak sah'); assert.deepStrictEqual(c0(), snap, 'teks / privasi tak sah: salinan video, gambar, lampiran dibuang'); }
      assert.strictEqual((await a('pgMine', {})).items.length, n0 + 1, 'kegagalan tidak membuat postingan');
      // e. pgVideo jarak jauh
      r = await a('pgCreate', 'video teman', 'friends', null, null, { videos: [{ src: v2 }] }); assert(r.ok); const fv = r.post;
      r = await b('pgVideo', A.id, vp.id, vp.videos[0].id);
      assert(r.ok && Object.keys(r).sort().join() === 'ok,video' && Object.keys(r.video).sort().join() === 'mime,tok,total', 'hanya tok/mime/total yang keluar');
      assert(/^[0-9a-f]{32}$/.test(r.video.tok) && r.video.mime === 'video/mp4' && r.video.total === mp4.length, 'nodl tidak menutup video');
      const msv = require('../src/archne-mediaserve'), pl = msv.plan(B, r.video.tok, 'bytes=0-9'); assert.strictEqual(pl.status, 206); assert.strictEqual(pl.headers['content-type'], 'video/mp4');
      assert((await B.mediaSrcRead(r.video.tok, 0, mp4.length)).equals(mp4), 'byte lewat token = berkas asli');
      r = await b('pgVideo', A.id, vp.id, vp.videos[1].id); assert(r.ok && r.video.mime === 'video/webm' && r.video.total === webm.length, 'webm');
      r = await b('pgVideo', A.id, fv.id, fv.videos[0].id); assert(r.ok === true && r.video === null, 'bukan teman: tak dibedakan dari tidak ada');
      r = await b('pgVideo', A.id, vp.id, '0123456789abcdef'); assert(r.ok === true && r.video === null, 'id video tak dikenal = null');
      r = await a('pgVideo', A.id, fv.id, fv.videos[0].id); assert(r.ok && r.video && r.video.total === webm.length, 'pemilik membuka videonya sendiri (juga yang Teman)');
      { const t0 = B._ptok ? B._ptok.size : 0; r = await b('pgVideo', A.id, vp.id, vp.media[0].id); assert(r.ok === false && r.code === 'bad' && /video/i.test(r.err), 'id gambar bukan video: ' + JSON.stringify(r)); assert.strictEqual(B._ptok ? B._ptok.size : 0, t0, 'token gambar tidak tersisa'); }
      for (const args of [[], ['xyz', vp.id, vp.videos[0].id], [A.id, 'bukanhex', vp.videos[0].id], [A.id, vp.id, '../../x'], [A.id, vp.id, 42], [A.id, null, vp.videos[0].id], [{}, vp.id, vp.videos[0].id]]) { r = await b('pgVideo', ...args); assert(r.ok === false && r.code === 'bad', 'harus ditolak: ' + JSON.stringify(args)); }
      { const undo = oldPeer(B, A.id); try { r = await b('pgVideo', A.id, vp.id, vp.videos[0].id); assert(r.ok === false && r.code === 'old' && r.err, 'old: ' + JSON.stringify(r)); } finally { undo(); } }
      // f. hapus postingan membuang semua salinannya; sesudahnya pgVideo = null
      await a('pgRemove', vp.id); await a('pgRemove', fv.id); assert.deepStrictEqual(c0(), base, 'hapus membuang salinan video, gambar, lampiran');
      r = await b('pgVideo', A.id, vp.id, vp.videos[0].id); assert(r.ok === true && r.video === null, 'postingan dihapus = null');
      // g. Core tiruan: penjaga jembatan berdiri sendiri; id gambar dibuang tokennya tanpa menyentuh token sah
      { const calls = []; let ans = { tok: 'a'.repeat(32), mime: 'video/mp4', total: 9, path: '/etc/passwd', peerId: 'x' }; const ptok = new Map([[ans.tok, 1]]);
        const h = {}; require('../src/archne-ipc-pages').registerPages({ ipcMain: { handle: (n, fn) => { h[n] = fn; } }, core: { pageMedia: async (...x) => { calls.push(x); return ans; }, _ptok: ptok } });
        const H16 = '0123456789abcdef', g = (...x) => h.pgVideo({}, ...x);
        for (const args of [[], ['xyz', H16, H16], [H16, 'bukanhex', H16], [H16, H16, 'bukanhex'], [H16, H16, H16 + 'a'], [H16, H16, 42], [H16, null, H16], [{}, H16, H16], [H16.toUpperCase(), H16, H16], [H16, H16, '../../x']]) { r = await g(...args); assert(r.ok === false && r.code === 'bad', JSON.stringify(args)); }
        assert.strictEqual(calls.length, 0, 'masukan cacat tidak pernah sampai ke Core');
        r = await g(H16, H16, H16); assert.deepStrictEqual(r, { ok: true, video: { tok: 'a'.repeat(32), mime: 'video/mp4', total: 9 } }, 'bidang lain dari Core tidak ikut keluar'); assert.deepStrictEqual(calls, [[H16, H16, H16]]);
        for (const m of ['image/png', 'audio/mp4', 'video/quicktime', 'VIDEO/MP4', undefined]) { ans = { tok: 'b'.repeat(32), mime: m, total: 9 }; ptok.set(ans.tok, 1); r = await g(H16, H16, H16); assert(r.ok === false && r.code === 'bad', 'mime ' + m); assert(!ptok.has('b'.repeat(32)) && ptok.has('a'.repeat(32)), 'hanya token yang salah dibuang: ' + m); }
        ans = null; r = await g(H16, H16, H16); assert.deepStrictEqual(r, { ok: true, video: null });
      }
      // g2. PageStore tiruan: hanya { src } yang diteruskan ke addVideos (jenis/nama/ukuran DIPUTUSKAN PageStore dari berkasnya), hasilnya masuk create sebagai videos
      { const seen = {}, ps = { addVideos: async (l) => { seen.v = l; return [{ id: 'aaaaaaaaaaaaaaaa', mime: 'video/mp4', size: 3, name: 'a.mp4' }]; }, create: (spec) => { seen.spec = spec; return spec; }, dropVideo: () => {} };
        const h = {}; require('../src/archne-ipc-pages').registerPages({ ipcMain: { handle: (n, fn) => { h[n] = fn; } }, core: { pageStore: () => ps } });
        r = await h.pgCreate({}, 'x', 'public', null, null, { videos: [{ src: '/a/a.mp4', name: 'x', mime: 'text/html', size: 9, id: 'zz', th: 'q' }], nodl: true });
        assert(r.ok, JSON.stringify(r)); assert.deepStrictEqual(seen.v, [{ src: '/a/a.mp4' }], 'hanya src yang diteruskan ke PageStore'); assert.strictEqual(seen.spec.videos.length, 1); assert.strictEqual(seen.spec.videos[0].mime, 'video/mp4'); assert.strictEqual(seen.spec.nodl, true); assert.strictEqual(seen.spec.media, undefined); assert.strictEqual(seen.spec.files, undefined);
      }
      // g3. preload.js (Electron): pgVideo dan opts pgCreate diteruskan ke kanal yang benar (tes paritas nama di archne-rpc.js hanya satu arah)
      { const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
        assert(/^\s{2}pgVideo: \(peerId, postId, videoId\) => ipcRenderer\.invoke\('pgVideo', peerId, postId, videoId\),$/m.test(pre), 'preload: pgVideo meneruskan tiga argumen ke kanal pgVideo');
        assert(/^\s{2}pgCreate: \(text, priv, images, files, opts\) => ipcRenderer\.invoke\('pgCreate', text, priv, images, files, opts\),$/m.test(pre), 'preload: pgCreate meneruskan opts (tempat videos)');
      }
      // h. klien api-http (Android / peramban): File video diunggah PALING AKHIR ke shared/, lalu pgCreate menerima path di opts.videos
      { const vmx = require('vm'), fcalls = []; const hctx = { location: { pathname: '/s/ab12/' }, document: {}, JSON, encodeURIComponent, Array, Promise, String, Object, Error }; hctx.window = hctx; let failName = null;
        hctx.fetch = async (u, o) => { fcalls.push({ u, o }); if (/upload/.test(u)) { const nm = decodeURIComponent(u.split('name=')[1]); return { ok: nm !== failName, status: 500, json: async () => ({ path: '/data/shared/ab-' + nm }) }; } return { ok: true, json: async () => ({ ok: true, post: { id: 'p9' } }) }; };
        vmx.createContext(hctx); vmx.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archne-api-http.js'), 'utf8'), hctx);
        const gf = { size: 3, name: 'foto.png' }, ff = { size: 4, name: 'lamp.pdf' }, vf = { size: 5, name: 'klip.mp4' }, vf2 = { size: 6, name: 'dua.webm' }, body = (i) => JSON.parse(fcalls[i].o.body), U = '/s/ab12/upload?name=';
        const o1 = { nodl: true, videos: [{ src: vf }, { src: vf2 }] };
        await hctx.api.pgCreate('hai', 'public', [{ src: gf }], [{ src: ff }], o1);
        assert.deepStrictEqual(fcalls.map((c) => c.u), [U + 'foto.png', U + 'lamp.pdf', U + 'klip.mp4', U + 'dua.webm', '/s/ab12/rpc/pgCreate'], 'urutan unggah: gambar, lampiran, video; lalu pgCreate');
        assert.deepStrictEqual(body(4), ['hai', 'public', [{ src: '/data/shared/ab-foto.png' }], [{ src: '/data/shared/ab-lamp.pdf' }], { nodl: true, videos: [{ src: '/data/shared/ab-klip.mp4' }, { src: '/data/shared/ab-dua.webm' }] }]);
        assert(o1.videos[0].src === vf, 'opts pemanggil tidak diubah');
        fcalls.length = 0; await hctx.api.pgCreate('hai', 'public', null, null, { nodl: true }); assert.strictEqual(fcalls.length, 1, 'tanpa video: tanpa unggah'); assert.deepStrictEqual(body(0), ['hai', 'public', [], null, { nodl: true }]);
        fcalls.length = 0; await hctx.api.pgCreate('hai', 'public', null, null, { videos: [{ src: '/x/a.mp4' }] }); assert.strictEqual(fcalls.length, 1, 'path string diteruskan apa adanya'); assert.deepStrictEqual(body(0)[4], { videos: [{ src: '/x/a.mp4' }] });
        fcalls.length = 0; failName = 'klip.mp4'; r = await hctx.api.pgCreate('hai', 'public', null, null, { videos: [{ src: vf }, { src: vf2 }] }); failName = null;
        assert(r.ok === false && /Gagal menyiapkan video/.test(r.err) && !fcalls.some((c) => /rpc\/pgCreate/.test(c.u)), 'unggah video gagal: pgCreate tidak dipanggil');
        r = await hctx.api.pgCreate('hai', 'public', null, null, { videos: [{ src: { name: 'x' } }] }); assert(r.ok === false && r.err === 'Video tidak valid');
        fcalls.length = 0; await hctx.api.pgVideo('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'); assert.strictEqual(fcalls[0].u, '/s/ab12/rpc/pgVideo'); assert.deepStrictEqual(body(0), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'], 'pgVideo terjangkau lewat RPC');
      }
    }
    ok('video (3c-6): pgCreate opts.videos (urutan, jenis dari isi, bidang liar diabaikan, cacat bentuk ditolak tanpa salinan, gagal sesudah menyalin tidak menyisakan video / gambar / lampiran); pgVideo (token saja, Teman tersembunyi, nodl tidak menutup, id gambar = bad tanpa token sisa, old, hapus = null); klien api-http mengunggah video paling akhir');

    // unduh lampiran (3a-5b): pgFileGet / pgFileCancel + event pgdl
    {
      const big = Buffer.alloc(FILE_CHUNK * 2 + 100); for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 255;
      const fsrc = path.join(tmp, 'laporan.pdf'); fs.writeFileSync(fsrc, big);
      const ps = A.pageStore(), [fPub, fFr] = await ps.addFiles([{ src: fsrc }, { src: fsrc }]);
      const pubP = ps.create({ text: 'lampiran publik', files: [fPub] }).id, frP = ps.create({ text: 'lampiran teman', priv: 'friends', files: [fFr] }).id;
      const ev = (id) => b.sent.filter(([ch, p]) => ch === 'pgdl' && p.id === id).map(([, p]) => p);
      const final = (id) => ev(id).filter((p) => p.phase !== 'progress');
      const dl = path.join(B._downloadDir(), 'halaman'), ls = () => (fs.existsSync(dl) ? fs.readdirSync(dl).sort() : []);
      const slow = (ms) => { const real = B._pgFileChunk.bind(B); B._pgFileChunk = async (...x) => { await sleep(ms); return real(...x); }; return () => { delete B._pgFileChunk; }; };
      // 1. unduh sampai selesai: balasan hanya { ok, id }; event membawa tag + progres naik + SATU kejadian akhir; tanpa jalur lokal; isi identik
      let restore = slow(150);
      r = await b('pgFileGet', A.id, pubP, fPub.id);
      assert(r.ok && Object.keys(r).sort().join() === 'id,ok' && /^[0-9a-f]{16}$/.test(r.id), JSON.stringify(r));
      const id1 = r.id; await until(() => final(id1).length === 1, 10000, 'selesai'); restore();
      let es = ev(id1), fin = es[es.length - 1];
      assert.deepStrictEqual(fin, { id: id1, peerId: A.id, postId: pubP, fileId: fPub.id, phase: 'done', name: 'laporan.pdf', size: big.length }, 'kejadian akhir: hanya nama dan ukuran: ' + JSON.stringify(fin));
      const prog = es.filter((p) => p.phase === 'progress'); assert(prog.length >= 1, 'ada progres'); assert(prog.every((p) => p.id === id1 && p.peerId === A.id && p.postId === pubP && p.fileId === fPub.id && p.total === big.length && Object.keys(p).length === 7), 'progres membawa tag + done/total');
      assert(prog.every((p, i) => i === 0 || p.done > prog[i - 1].done) && prog[prog.length - 1].done <= big.length, 'progres naik');
      assert(!JSON.stringify(b.sent).includes(tmp.replace(/\\/g, '\\\\')) && !JSON.stringify(b.sent).includes('.part'), 'tidak ada jalur lokal di event');
      assert.deepStrictEqual(ls(), ['laporan.pdf']); assert(Buffer.compare(fs.readFileSync(path.join(dl, 'laporan.pdf')), big) === 0, 'isi identik');
      assert.strictEqual(final(id1).length, 1, 'tepat satu kejadian akhir');
      // 2. klik ganda: unduhan yang sama yang masih berjalan = id sama; setelah selesai = unduhan baru (nama (1))
      restore = slow(150);
      const [d1, d2] = [await b('pgFileGet', A.id, pubP, fPub.id), await b('pgFileGet', A.id, pubP, fPub.id)];
      assert(d1.ok && d2.ok && d1.id === d2.id && d1.id !== id1, 'id sama selagi berjalan');
      await until(() => final(d1.id).length === 1, 10000, 'unduhan kedua'); restore();
      assert.strictEqual(final(d1.id)[0].name, 'laporan (1).pdf'); assert.strictEqual(final(d1.id).length, 1);
      r = await b('pgFileGet', A.id, pubP, fPub.id); assert(r.ok && r.id !== d1.id && r.id !== id1, 'selesai = id baru'); await until(() => final(r.id).length === 1, 10000, 'unduhan ketiga'); assert.strictEqual(final(r.id)[0].name, 'laporan (2).pdf');
      for (const f of ls()) fs.rmSync(path.join(dl, f), { force: true });
      // 3. batal: pgFileCancel -> kejadian akhir error/cancel, tanpa .part atau berkas; batal lagi / id tak dikenal = ok, cancelled:false
      restore = slow(300);
      r = await b('pgFileGet', A.id, pubP, fPub.id); assert(r.ok); const cid = r.id; await sleep(100);
      const cr = await b('pgFileCancel', cid); assert.deepStrictEqual(cr, { ok: true, cancelled: true });
      await until(() => final(cid).length === 1, 10000, 'batal'); restore();
      assert(final(cid)[0].phase === 'error' && final(cid)[0].code === 'cancel', JSON.stringify(final(cid)));
      assert.deepStrictEqual(ls(), [], 'batal tidak meninggalkan .part atau berkas');
      assert.deepStrictEqual(await b('pgFileCancel', cid), { ok: true, cancelled: false }); assert.deepStrictEqual(await b('pgFileCancel', '0123456789abcdef'), { ok: true, cancelled: false });
      for (const x of [undefined, 42, 'xyz', '../../x', 'ABCDEF0123456789', {}]) { r = await b('pgFileCancel', x); assert(r.ok === false && r.code === 'bad', 'pgFileCancel menolak ' + JSON.stringify(x)); }
      // 4. tidak untuk saya (postingan Teman, penonton bukan teman) / tidak ada: ok + kejadian 'none', sama untuk keduanya
      r = await b('pgFileGet', A.id, frP, fFr.id); assert(r.ok); await until(() => final(r.id).length === 1, 5000, 'none teman'); assert.strictEqual(final(r.id)[0].phase, 'none');
      r = await b('pgFileGet', A.id, pubP, '0123456789abcdef'); assert(r.ok); await until(() => final(r.id).length === 1, 5000, 'none tak ada'); assert.strictEqual(final(r.id)[0].phase, 'none');
      assert.deepStrictEqual(ls(), [], 'none tidak menulis apa pun');
      // 5. masukan cacat ditolak sebelum menyentuh Core dan tanpa event
      const n0 = b.sent.length;
      for (const args of [[], ['xyz', pubP, fPub.id], [A.id, 'bukanhex', fPub.id], [A.id, pubP, '../../x'], [A.id, pubP, 42], [A.id, null, fPub.id], [{}, pubP, fPub.id], [A.id.toUpperCase(), pubP, fPub.id], [A.id, pubP, fPub.id + 'a']]) { r = await b('pgFileGet', ...args); assert(r.ok === false && r.code === 'bad', 'harus ditolak: ' + JSON.stringify(args)); }
      assert.strictEqual(b.sent.length, n0, 'penolakan tidak menyiarkan event');
      // 6. pemilik versi lama: galat Core 'old' ikut ke renderer sebagai balasan langsung
      { const undo = oldPeer(B, A.id);
        try { r = await b('pgFileGet', A.id, pubP, fPub.id); assert(r.ok === true); await until(() => final(r.id).length === 1, 5000, 'old'); assert(final(r.id)[0].phase === 'error' && final(r.id)[0].code === 'old', JSON.stringify(final(r.id))); } finally { undo(); } }
      assert.deepStrictEqual(ls(), [], 'old tidak meninggalkan berkas');
      // 7. milik sendiri: pemilik mengunduh lampirannya sendiri (tanpa jaringan), termasuk yang Teman
      r = await a('pgFileGet', A.id, frP, fFr.id); assert(r.ok); await until(() => a.sent.some(([ch, p]) => ch === 'pgdl' && p.id === r.id && p.phase !== 'progress'), 8000, 'milik sendiri');
      assert.strictEqual(a.sent.filter(([ch, p]) => ch === 'pgdl' && p.id === r.id && p.phase !== 'progress').length, 1);
      assert.strictEqual(a.sent.find(([ch, p]) => ch === 'pgdl' && p.id === r.id && p.phase !== 'progress')[1].phase, 'done');
      await a('pgRemove', pubP); await a('pgRemove', frP);
    }
    { // Core tiruan: penjaga di jembatan berdiri sendiri
      const H16 = '0123456789abcdef', sent = [], h = {}; let behave = null; const calls = [];
      const reg = require('../src/archne-ipc-pages').registerPages({ ipcMain: { handle: (n, fn) => { h[n] = fn; } }, toRenderer: (ch, p) => sent.push([ch, p]), core: { pageFileGet: (...x) => { calls.push(x); return behave(...x); } } });
      const g = (...x) => h.pgFileGet({}, ...x), pe = (c, m) => Object.assign(new Error(m), { code: c });
      const evs = () => sent.filter(([ch]) => ch === 'pgdl').map(([, p]) => p);
      // a. argumen sampai ke Core apa adanya + { onProgress, signal }; hanya name/size yang keluar (path dan bidang lain tidak)
      behave = async () => { await sleep(20); return { path: '/etc/rahasia/x.txt', name: 'x.txt', size: 3, peerId: 'bocor', extra: 1 }; };
      r = await g(H16, H16, H16); assert(r.ok && /^[0-9a-f]{16}$/.test(r.id)); await until(() => evs().length === 1, 2000, 'done tiruan');
      assert.deepStrictEqual(evs()[0], { id: r.id, peerId: H16, postId: H16, fileId: H16, phase: 'done', name: 'x.txt', size: 3 }); assert(!JSON.stringify(sent).includes('/etc/rahasia'));
      assert(calls.length === 1 && calls[0].slice(0, 3).join() === [H16, H16, H16].join() && typeof calls[0][3].onProgress === 'function' && calls[0][3].signal && typeof calls[0][3].signal.aborted === 'boolean');
      // b. galat langsung ('many') = balasan gagal, TANPA event; galat sistem berisi jalur dibersihkan; ENOSPC dan kode dikenal tetap
      sent.length = 0; behave = async () => { throw pe('many', 'Terlalu banyak unduhan'); };
      r = await g(H16, H16, H16); assert.deepStrictEqual(r, { ok: false, err: 'Terlalu banyak unduhan', code: 'many' }); await sleep(30); assert.strictEqual(sent.length, 0, 'galat langsung tidak disiarkan');
      behave = async () => { await sleep(20); throw pe('EACCES', "EACCES: permission denied, open '/home/budi/Unduhan/halaman/x.part'"); };
      r = await g(H16, H16, H16); assert(r.ok); await until(() => evs().length === 1, 2000, 'galat sistem');
      assert.deepStrictEqual(evs()[0], { id: r.id, peerId: H16, postId: H16, fileId: H16, phase: 'error', err: 'Failed to save the file', code: 'EACCES' }); assert(!JSON.stringify(sent).includes('/home/budi'));
      sent.length = 0; behave = async () => { await sleep(20); throw pe('ENOSPC', 'ENOSPC: no space left on device, write /x/y.part'); };
      r = await g(H16, H16, H16); await until(() => evs().length === 1, 2000, 'ENOSPC'); assert.strictEqual(evs()[0].err, 'Storage is full'); assert(!JSON.stringify(sent).includes('/x/y'));
      sent.length = 0; behave = async () => { await sleep(20); throw new Error('tanpa kode di /rahasia/z'); };
      r = await g(H16, H16, H16); await until(() => evs().length === 1, 2000, 'tanpa kode'); assert.deepStrictEqual([evs()[0].err, evs()[0].code], ['Failed to save the file', 'io']);
      // c. selesai sebelum balasan: balasan ok, kejadian akhir tetap disiarkan (setelahnya)
      sent.length = 0; behave = async () => ({ path: '/p', name: 'c.txt', size: 1 });
      r = await g(H16, H16, H16); assert(r.ok); await until(() => evs().length === 1, 2000, 'cepat'); assert.strictEqual(evs()[0].phase, 'done'); assert.strictEqual(evs()[0].id, r.id);
      sent.length = 0; behave = async () => null; r = await g(H16, H16, H16); assert(r.ok); await until(() => evs().length === 1, 2000, 'null'); assert.strictEqual(evs()[0].phase, 'none');
      // d. progres dibatasi (banjir 200 panggilan = beberapa event saja), progres sebelum balasan dibuang, dan semuanya membawa tag
      sent.length = 0; behave = async (p, q, f, o) => { o.onProgress(1, 100); await sleep(30); for (let i = 1; i <= 200; i++) o.onProgress(i, 200); await sleep(20); return null; };
      r = await g(H16, H16, H16); await until(() => evs().some((p) => p.phase === 'none'), 3000, 'banjir');
      const pr = evs().filter((p) => p.phase === 'progress'); assert(pr.length >= 1 && pr.length <= 3, 'progres dibatasi: ' + pr.length); assert(pr.every((p) => p.total === 200 && p.id === r.id), 'progres sebelum balasan (total 100) dibuang');
      // e. batal + dispose: signal Core ikut abort; dispose membatalkan semua yang berjalan
      sent.length = 0; calls.length = 0; behave = (p, q, f, o) => new Promise((res, rej) => o.signal.addEventListener('abort', () => rej(pe('cancel', 'Dibatalkan'))));
      r = await g(H16, H16, H16); assert(r.ok); assert.deepStrictEqual(await h.pgFileCancel({}, r.id), { ok: true, cancelled: true }); await until(() => evs().length === 1, 2000, 'cancel tiruan');
      assert.deepStrictEqual([evs()[0].phase, evs()[0].code], ['error', 'cancel']); assert.deepStrictEqual(await h.pgFileCancel({}, r.id), { ok: true, cancelled: false }, 'selesai = tak ada lagi');
      sent.length = 0; const q1 = await g(H16, H16, H16), q2 = await g('fedcba9876543210', H16, H16); assert(q1.ok && q2.ok && q1.id !== q2.id);
      reg.dispose(); await until(() => evs().length === 2, 2000, 'dispose'); assert(evs().every((p) => p.phase === 'error' && p.code === 'cancel'), 'dispose membatalkan semua'); assert.deepStrictEqual(await h.pgFileCancel({}, q1.id), { ok: true, cancelled: false });
      // f. masukan cacat tidak pernah sampai ke Core
      calls.length = 0; for (const args of [[], ['xyz', H16, H16], [H16, 'bukanhex', H16], [H16, H16, 'bukanhex'], [H16, H16, H16 + 'a'], [H16, H16, 42], [H16, null, H16], [{}, H16, H16], [H16.toUpperCase(), H16, H16]]) { r = await g(...args); assert(r.ok === false && r.code === 'bad', JSON.stringify(args)); }
      assert.strictEqual(calls.length, 0);
    }
    ok('pgFileGet/pgFileCancel: id unduhan + event pgdl (tag, progres naik dan dibatasi, satu kejadian akhir), tanpa jalur lokal, klik ganda = id sama, batal bersih, none tak dibedakan, galat langsung tanpa event, dispose membatalkan, masukan cacat ditolak');
    // reaksi (4a-5): pgReact(peerId, postId, e) -> { ok:true, react: { rx, mine } | null }
    {
      const E1 = { rx: [{ e: '👍', n: 1 }], mine: '👍' };
      r = await b('pgReact', A.id, id1, '👍'); assert.deepStrictEqual(r, { ok: true, react: E1 }, 'peminta jauh');
      assert.deepStrictEqual(await b('pgReact', A.id, id1, '👍'), { ok: true, react: E1 }, 'idempotent');
      r = await b('pgReact', A.id, id1, ' 🩷 '); assert.deepStrictEqual(r.react, { rx: [{ e: '🩷', n: 1 }], mine: '🩷' }, 'dikanonkan, mengganti reaksi lama: ' + JSON.stringify(r));
      r = await b('pgReact', A.id, id1, ''); assert.deepStrictEqual(r, { ok: true, react: { rx: [], mine: '' } }, 'cabut');
      await b('pgReact', A.id, id1, '😭'); assert.strictEqual((await b('pgGet', A.id, id1)).post.mine, '😭', 'terlihat lewat pgGet');
      r = await a('pgReact', A.id, id1, '👍'); assert(r.ok && r.react.mine === '👍' && r.react.rx.length === 2, 'milik sendiri (lokal): ' + JSON.stringify(r));
      const fr = (await a('pgMine', {})).items.find((p) => p.text === 'rahasia teman');
      assert.deepStrictEqual(await b('pgReact', A.id, fr.id, '👍'), { ok: true, react: null }, 'Teman untuk asing = null biasa');
      assert.deepStrictEqual(await b('pgReact', A.id, 'bbbbbbbbbbbbbbbb', '👍'), { ok: true, react: null }, 'tidak ada = null, sama');
      assert.strictEqual((await a('pgReact', A.id, fr.id, '🥺')).react.mine, '🥺', 'pemilik boleh di postingan Teman sendiri');
      // 4a-7: pgMine membawa rx / mine / who (daftar pelaku) HANYA untuk pemilik; peminta jauh tidak pernah menerima who
      {
        const find = (arr, e) => arr.find((w) => w.e === e), mp = async () => (await a('pgMine', {})).items;
        let items = await mp(); const p1 = items.find((p) => p.id === id1), pf = items.find((p) => p.id === fr.id);
        assert.deepStrictEqual(p1.rx.map((x) => x.e).sort(), ['👍', '😭'].sort()); assert.strictEqual(p1.mine, '👍', 'mine = reaksi pemilik');
        assert.deepStrictEqual(find(p1.who, '👍').by, [A.id]); assert.deepStrictEqual(find(p1.who, '😭').by, [B.id]); assert.deepStrictEqual(p1.who.map((w) => w.e), p1.rx.map((x) => x.e), 'who sejajar rx');
        assert.deepStrictEqual(pf.who, [{ e: '🥺', by: [A.id] }]); assert.strictEqual(pf.mine, '🥺', 'postingan Teman: pemilik melihat reaksinya sendiri');
        const nr = (await a('pgCreate', 'tanpa reaksi', 'public')).post; items = await mp(); const q = items.find((p) => p.id === nr.id);
        assert(!('rx' in q) && !('mine' in q) && !('who' in q), 'tanpa reaksi = tanpa field');
        // peminta jauh: tanpa who / by, juga dari pgList
        const g = (await b('pgGet', A.id, id1)).post, l = (await b('pgList', A.id, {})).items.find((p) => p.id === id1);
        for (const [n, x] of [['pgGet', g], ['pgList', l]]) { assert(x && x.rx && !('who' in x) && !JSON.stringify(x).includes('"by"') && !JSON.stringify(x).includes(A.id), n + ': tanpa pelaku'); }
        // pgReact ke id sendiri membawa who terbaru; ke peer jauh tidak
        r = await a('pgReact', A.id, id1, '🩷'); assert(r.ok && r.react.mine === '🩷', JSON.stringify(r)); assert.deepStrictEqual(find(r.react.who, '🩷').by, [A.id]); assert(!find(r.react.who, '👍'), 'reaksi lama pemilik pindah'); assert.deepStrictEqual(find(r.react.who, '😭').by, [B.id]);
        assert.deepStrictEqual(r.react.who.map((w) => w.e), r.react.rx.map((x) => x.e), 'who sejajar rx');
        r = await b('pgReact', A.id, id1, '🩷'); assert.deepStrictEqual(Object.keys(r.react).sort(), ['mine', 'rx'], 'jalur jauh: hanya rx dan mine');
        items = await mp(); assert.deepStrictEqual(find(items.find((p) => p.id === id1).who, '🩷').by.slice().sort(), [A.id, B.id].sort(), 'reaksi peer jauh tampil di daftar pemilik');
        r = await a('pgReact', A.id, id1, ''); assert(r.ok && r.react.mine === ''); assert.deepStrictEqual(find(r.react.who, '🩷').by, [B.id], 'cabut: hanya aku yang hilang dari daftar, peer jauh tetap');
        assert.deepStrictEqual(await a('pgReact', A.id, 'bbbbbbbbbbbbbbbb', '👍'), { ok: true, react: null }, 'tidak ada = null, tanpa who');
        // who tidak pernah ikut ke jalur jauh walau id postingan kebetulan juga ada di penyimpanan peminta sendiri (B.pageReact dipalsukan; B punya postingan beridentik dengan yang diminta)
        { const bp = (await b('pgCreate', 'milik B', 'public')).post; await b('pgReact', B.id, bp.id, '👍'); const real = B.pageReact; B.pageReact = async () => ({ rx: [{ e: '🥺', n: 1 }], mine: '🥺' });
          try { r = await b('pgReact', A.id, bp.id, '🥺'); assert.deepStrictEqual(r, { ok: true, react: { rx: [{ e: '🥺', n: 1 }], mine: '🥺' } }, 'jalur jauh: persis rx + mine, tanpa who: ' + JSON.stringify(r)); } finally { B.pageReact = real; }
          r = await b('pgReact', B.id, bp.id, '😭'); assert(r.ok && Array.isArray(r.react.who), 'pembanding: reaksi ke id sendiri memang membawa who'); await b('pgRemove', bp.id); }
        await a('pgRemove', nr.id); await a('pgReact', A.id, id1, '👍'); await b('pgReact', A.id, id1, '😭'); // pulihkan keadaan untuk tes berikutnya
      }
      // masukan cacat: ditolak di jembatan (tanpa menyentuh Core) atau oleh Core, selalu bad
      const real = B.pageReact; let n = 0; B.pageReact = function (...x) { n++; return real.apply(this, x); };
      for (const args of [['xyz', id1, '👍'], [A.id, 'bukanhex', '👍'], [A.id, id1, 5], [A.id, id1, null], [A.id, id1], [A.id, id1, '👍'.repeat(40)], [{}, id1, '👍'], [A.id.toUpperCase(), id1, '👍'], [], [A.id, [id1], '👍']]) { r = await b('pgReact', ...args); assert(r.ok === false && r.code === 'bad', 'bad: ' + JSON.stringify(args) + ' -> ' + JSON.stringify(r)); }
      assert.strictEqual(n, 0, 'cacat bentuk tidak pernah sampai ke Core');
      for (const e of ['abc', '<b>', '👍👍']) { r = await b('pgReact', A.id, id1, e); assert(r.ok === false && r.code === 'bad', 'emoji tak sah ke Core: ' + e); }
      assert.strictEqual(n, 3);
      // galat Core diteruskan dengan kode; hasil Core dipangkas ke rx/mine saja
      const pe = (c, m) => Object.assign(new Error(m), { code: c });
      for (const c of ['offline', 'old', 'blocked', 'proto', 'busy', 'auth', 'time']) { B.pageReact = async () => { throw pe(c, 'galat ' + c); }; r = await b('pgReact', A.id, id1, '👍'); assert.deepStrictEqual([r.ok, r.code, r.err], [false, c, 'galat ' + c]); }
      B.pageReact = async () => ({ rx: [{ e: '👍', n: 2, by: ['a'.repeat(16)], path: '/x' }], mine: '👍', path: '/rahasia', by: ['q'] });
      assert.deepStrictEqual(await b('pgReact', A.id, id1, '👍'), { ok: true, react: { rx: [{ e: '👍', n: 2 }], mine: '👍' } }, 'bidang lain tidak keluar');
      B.pageReact = real;
    }
    ok('pgReact: { rx, mine } sesudah perubahan (jauh, idempotent, dikanonkan, ganti, cabut, terlihat di pgGet), milik sendiri lokal, tak terlihat / tak ada = null yang sama, masukan cacat = bad tanpa menyentuh Core, kode galat Core diteruskan, hanya rx / mine yang keluar');
    // preload.js sungguhan dengan electron palsu: pgReact meneruskan ketiga argumen apa adanya ke kanal 'pgReact' (4a-5)
    {
      const Module = require('module'), calls = []; let exposed = null;
      const fakeElectron = { contextBridge: { exposeInMainWorld: (n, o) => { exposed = o; } }, ipcRenderer: { invoke: (...x) => { calls.push(x); return Promise.resolve('balasan'); }, on() {} }, webUtils: { getPathForFile: () => '' } };
      const load = Module._load; Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : load.call(this, req, ...rest); };
      const pp = require.resolve('../preload.js'); delete require.cache[pp];
      try { require(pp); } finally { Module._load = load; delete require.cache[pp]; }
      assert.strictEqual(typeof exposed.pgReact, 'function', 'preload mengekspos pgReact');
      assert.strictEqual(await exposed.pgReact('a'.repeat(16), 'b'.repeat(16), '🩷'), 'balasan');
      assert.deepStrictEqual(calls, [['pgReact', 'a'.repeat(16), 'b'.repeat(16), '🩷']], 'kanal dan ketiga argumen utuh');
      assert(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archne-api-http.js'), 'utf8').includes("'pgReact'"), 'archne-api-http.js mendaftarkan pgReact (jalur HTTP diuji di archne-rpc.js)');
    }
    ok('preload.js sungguhan: api.pgReact(peerId, postId, e) -> invoke(\'pgReact\', peerId, postId, e) utuh');
    r = await a('pgRemove', id1); assert(r.ok && r.removed === true);
    r = await b('pgGet', A.id, id1); assert(r.ok && r.post === null); ok('hapus: hilang di peer');
    r = await b('pgList', B.id, {}); assert(r.ok === false && r.code === 'self'); ok('halaman sendiri via pgList = self');
  } finally { try { await A.stop(); await B.stop(); } catch {} }
  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

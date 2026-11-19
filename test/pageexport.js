'use strict';
// Tes 5d-2: ekspor halaman ke arsip (src/archne-pageexport.js) dengan Core dan PageStore sungguhan. Impor menyusul di 5d-3/4.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { ArcReader, ArcError } = require('../src/archne-pagearc');
const { exportPages } = require('../src/archne-pageexport');
const { FILE_CHUNK, MEDIA_CHUNK } = require('../src/archne-pagestore');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pageexport-'));
let pass = 0; const ok = (s) => { pass++; console.log('  OK  ' + s); };
const rnd = (n, seed) => { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; } return b; };
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
const mp4 = (n, seed) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), rnd(n, seed)]);
const wr = (n, b) => { const f = path.join(tmp, n); fs.writeFileSync(f, b); return f; };
const code = async (p) => { try { await p; } catch (e) { return e.code || e.message; } return 'tidak melempar'; };
const out = (n) => path.join(tmp, n);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const snap = (dir) => { const r = []; (function w(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), s = fs.statSync(f); if (s.isDirectory()) w(f); else r.push(path.relative(dir, f) + ':' + s.size + ':' + s.mtimeMs); } })(dir); return r; };

(async () => {
  const A = new Core({ dataDir: path.join(tmp, 'A'), downloadDir: path.join(tmp, 'A-unduhan'), name: 'A', discovery: false });
  await A.start();
  try {
    const ps = A.pageStore();
    // bahan: gambar besar (3 blok), lampiran besar, video, teks saja
    const imgB = Buffer.concat([png, rnd(MEDIA_CHUNK * 2 + 4321, 7)]), fileB = rnd(FILE_CHUNK * 2 + 777, 5), vidB = mp4(MEDIA_CHUNK + 999, 11);
    const [m1] = await ps.addMedias([{ src: wr('g.png', imgB) }]), [f1] = await ps.addFiles([{ src: wr('l.pdf', fileB) }]), [v1] = await ps.addVideos([{ src: wr('v.mp4', vidB) }]);
    const [f2] = await ps.addFiles([{ src: wr('k.bin', rnd(300, 3)) }]);
    const pText = ps.create({ text: 'hanya teks' });
    const pAll = ps.create({ text: 'lengkap', media: [m1], files: [f1], videos: [v1], nodl: true });
    const pFrd = ps.create({ text: 'untuk teman', priv: 'friends', files: [f2] });
    const pShare = ps.create({ text: 'berbagi lampiran', files: [f2] }); // f2 dirujuk dua postingan
    const order = ps.list({ limit: 50 }).items.map((p) => p.id);
    assert.strictEqual(order.length, 4);

    // 1. ekspor penuh: isi persis sama dengan store, urutan tampil terjaga, tiap berkas tepat satu salinan, progres naik sampai total
    {
      const prog = []; const r = await exportPages(ps, out('1.arc'), { onProgress: (p) => prog.push(p) });
      assert.deepStrictEqual({ posts: r.posts, media: r.media, files: r.files, videos: r.videos, skipped: r.skipped }, { posts: 4, media: 1, files: 2, videos: 1, skipped: [] });
      assert.strictEqual(r.bytes, imgB.length + fileB.length + vidB.length + 300); assert.strictEqual(r.size, fs.statSync(out('1.arc')).size);
      const rd = await ArcReader.open(out('1.arc'));
      assert.strictEqual(rd.meta.kind, 'archne-pages'); assert.strictEqual(rd.meta.fmt, 1); assert.strictEqual(rd.meta.owner, A.id, 'pemilik = id Core');
      assert.deepStrictEqual(rd.meta.posts, order, 'urutan tampil (terbaru dulu)'); assert.deepStrictEqual(rd.meta.counts, { posts: 4, media: 1, files: 2, videos: 1, bytes: r.bytes });
      assert.strictEqual(rd.entries.length, 4 + 1 + 2 + 1, 'empat postingan + empat berkas (f2 hanya SATU salinan)');
      for (const id of order) assert.deepStrictEqual(JSON.parse((await rd.readBuffer('post/' + id)).toString()), ps.get(id), 'postingan identik: ' + id);
      assert.strictEqual(JSON.parse((await rd.readBuffer('post/' + pAll.id)).toString()).nodl, true, 'nodl ikut');
      assert.strictEqual(JSON.parse((await rd.readBuffer('post/' + pFrd.id)).toString()).priv, 'friends', 'priv ikut');
      for (const [n, b] of [['media/' + m1.id, imgB], ['file/' + f1.id, fileB], ['video/' + v1.id, vidB]]) assert.strictEqual(rd.info(n).hash, sha(b), 'hash ' + n);
      await rd.verifyAll(); await rd.close();
      assert(prog.length > 3 && prog.every((p, i) => !i || (p.bytes >= prog[i - 1].bytes && p.posts >= prog[i - 1].posts)), 'progres tidak pernah mundur');
      const last = prog[prog.length - 1];
      assert(last.bytes === r.bytes && last.posts === 4, 'progres akhir = total');
    }
    ok('ekspor penuh: postingan identik, urutan terjaga, berkas bersama hanya satu salinan, hash cocok, progres naik');

    // 2. ekspor tidak mengubah store
    { const before = snap(path.join(tmp, 'A')); await exportPages(ps, out('2.arc')); assert.deepStrictEqual(snap(path.join(tmp, 'A')), before, 'store tidak berubah'); }
    ok('ekspor hanya membaca: folder halaman tidak berubah');

    // 3. subset dan masukan tidak sah; exportTo
    {
      const r = await ps.exportTo(out('3.arc'), { ids: [pShare.id, pText.id] });
      assert.strictEqual(r.posts, 2); const rd = await ArcReader.open(out('3.arc'));
      assert.deepStrictEqual(rd.meta.posts, order.filter((i) => i === pShare.id || i === pText.id), 'urutan tampil, bukan urutan permintaan');
      assert.deepStrictEqual(rd.names().sort(), ['file/' + f2.id, 'post/' + pShare.id, 'post/' + pText.id].sort()); await rd.close();
      assert.strictEqual(await code(exportPages(ps, out('3b.arc'), { ids: ['../x'] })), 'bad'); assert.strictEqual(await code(exportPages(ps, out('3c.arc'), { ids: 'x' })), 'bad');
      assert.strictEqual(await code(exportPages({}, out('3d.arc'))), 'bad');
      const r0 = await exportPages(ps, out('3e.arc'), { ids: ['0123456789abcdef'] }); assert.strictEqual(r0.posts, 0, 'id tak dikenal = tidak ada yang diekspor');
      assert(!fs.existsSync(out('3b.arc')) && !fs.existsSync(out('3b.arc.tmp')), 'masukan tak sah tidak meninggalkan berkas');
    }
    ok('subset id (urutan tampil), masukan tak sah ditolak tanpa sisa, PageStore.exportTo');

    // 4. postingan yang tak bisa diekspor utuh dilewati dan dilaporkan; yang lain selesai; tanpa sisa yatim yang dirujuk
    {
      const [fx] = await ps.addFiles([{ src: wr('x.bin', rnd(FILE_CHUNK * 2 + 10, 9)) }]), [fy] = await ps.addFiles([{ src: wr('y.bin', rnd(FILE_CHUNK * 2 + 20, 8)) }]);
      const pMiss = ps.create({ text: 'berkas hilang', files: [fx] }), pChg = ps.create({ text: 'berkas berubah', files: [fy] }), pGone = ps.create({ text: 'dihapus saat ekspor' });
      fs.unlinkSync(ps.filePath(fx)); // hilang
      let first = true; // berubah saat disalin: tumbuh setelah potongan pertama
      const fyPath = ps.filePath(fy);
      const realGet = ps.get.bind(ps), seen = {}; ps.get = (id) => { seen[id] = (seen[id] || 0) + 1; return id === pGone.id && seen[id] > 1 ? null : realGet(id); };
      let r;
      try { r = await exportPages(ps, out('4.arc'), { onProgress: (p) => { if (p.id === pChg.id && first) { first = false; fs.appendFileSync(fyPath, 'tumbuh'); } } }); } finally { ps.get = realGet; }
      const why = {}; for (const s of r.skipped) why[s.id] = s.why;
      assert.deepStrictEqual(why, { [pMiss.id]: 'missing', [pChg.id]: 'changed', [pGone.id]: 'gone' }, 'alasan dilewati');
      assert.strictEqual(r.posts, 4, 'empat postingan lama tetap ikut');
      const rd = await ArcReader.open(out('4.arc'));
      assert.deepStrictEqual(rd.meta.posts, order, 'daftar hanya yang utuh'); assert.deepStrictEqual(rd.meta.counts, { posts: 4, media: 1, files: 2, videos: 1, bytes: r.bytes }, 'hitungan tidak memuat sisa yatim');
      assert(!rd.has('post/' + pMiss.id) && !rd.has('post/' + pChg.id), 'tak ada entri postingan yang dilewati');
      await rd.verifyAll(); await rd.close();
      ps.remove(pMiss.id); ps.remove(pChg.id); ps.remove(pGone.id);
    }
    ok('dilewati dan dilaporkan: berkas hilang, berubah saat disalin, dihapus saat ekspor; arsip tetap sah dan hitungannya benar');

    // 5. batal: arsip sebagian dibuang, berkas tujuan lama tidak tersentuh
    {
      fs.writeFileSync(out('5.arc'), 'LAMA');
      const ac = new AbortController();
      assert.strictEqual(await code(exportPages(ps, out('5.arc'), { signal: ac.signal, onProgress: (p) => { if (p.bytes > FILE_CHUNK) ac.abort(); } })), 'abort');
      assert.strictEqual(fs.readFileSync(out('5.arc'), 'utf8'), 'LAMA', 'berkas lama utuh'); assert(!fs.existsSync(out('5.arc.tmp')), 'tmp dibuang');
      const ac2 = new AbortController(); ac2.abort();
      assert.strictEqual(await code(exportPages(ps, out('5b.arc'), { signal: ac2.signal })), 'abort'); assert(!fs.existsSync(out('5b.arc')) && !fs.existsSync(out('5b.arc.tmp')));
      assert.strictEqual(await code(exportPages(ps, path.join(tmp, 'tidak', 'ada', 'x.arc'))), 'ENOENT', 'tujuan tak bisa ditulis = galat apa adanya');
    }
    ok('batal (di tengah dan sebelum mulai): tmp dibuang, berkas lama utuh; tujuan tak bisa ditulis melempar');

    // 6. store kosong
    {
      const B = new Core({ dataDir: path.join(tmp, 'B'), downloadDir: path.join(tmp, 'B-unduhan'), name: 'B', discovery: false }); await B.start();
      try {
        const r = await B.pageStore().exportTo(out('6.arc')); assert.deepStrictEqual([r.posts, r.skipped.length], [0, 0]);
        const rd = await ArcReader.open(out('6.arc')); assert.deepStrictEqual(rd.meta.posts, []); assert.strictEqual(rd.meta.owner, B.id); assert.strictEqual(rd.entries.length, 0); await rd.close();
      } finally { await B.stop(); }
    }
    ok('halaman kosong menghasilkan arsip sah tanpa entri');

    // 7. tanpa komentar di arsip (5d-5 belum ada) dan pemilik bisa diganti lewat opts
    { const r = await exportPages(ps, out('7.arc'), { owner: 'ab'.repeat(8), ids: [pText.id] }); const rd = await ArcReader.open(out('7.arc')); assert.strictEqual(rd.meta.owner, 'ab'.repeat(8)); assert(!rd.names().some((n) => /^(cmt|comments)/.test(n)), 'belum ada komentar'); await rd.close(); assert.strictEqual(r.posts, 1); }
    ok('belum ada komentar / nisan di arsip (menunggu 5d-5); opts.owner diutamakan');
  } finally { try { await A.stop(); } catch {} }
  console.log('\n' + pass + ' tes lulus');
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

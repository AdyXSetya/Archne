'use strict';
// Tes 5d-4: impor tahap TULIS (importArchive / PageStore.importFrom / adoptPost) dengan Core sungguhan. Ekspor dari A, impor ke B.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { PageStore, FILE_CHUNK, MEDIA_CHUNK } = require('../src/archne-pagestore');
const { ArcWriter } = require('../src/archne-pagearc');
const { importArchive, inspectArchive } = require('../src/archne-pageimport');
const { sniffImage } = require('../src/archne-mediacheck');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pageimport-'));
let pass = 0; const ok = (s) => { pass++; console.log('  OK  ' + s); };
const rnd = (n, seed) => { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; } return b; };
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
const mp4 = (n, seed) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), rnd(n, seed)]);
const wr = (n, b) => { const f = path.join(tmp, n); fs.writeFileSync(f, b); return f; };
const out = (n) => path.join(tmp, n);
const mkCore = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false });
const snap = (dir) => { const r = []; (function w(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), s = fs.statSync(f); if (s.isDirectory()) w(f); else r.push(path.relative(dir, f) + ':' + s.size + ':' + s.mtimeMs); } })(dir); return r; };
const files = (dir) => { const r = []; (function w(d) { try { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) w(f); else r.push(path.relative(dir, f)); } } catch {} })(dir); return r.sort(); };
const J = (o) => Buffer.from(JSON.stringify(o));
const H = (n) => n.toString(16).padStart(16, '0');
const post = (id, x) => Object.assign({ v: 1, id, ts: 1700000000000, kind: 'text', text: 'halo ' + id, priv: 'public' }, x || {});
async function mk(name, entries, meta) {
  const w = await ArcWriter.create(out(name));
  for (const n of Object.keys(entries)) await w.addBuffer(n, entries[n]);
  await w.finish(Object.assign({ kind: 'archne-pages', fmt: 1, owner: null, posts: Object.keys(entries).filter((n) => /^post\//.test(n)).map((n) => n.slice(5)) }, meta || {}));
  return out(name);
}
const med = (i, b, x) => Object.assign({ id: i, mime: 'image/png', size: b.length, name: 'a.png' }, x || {});
const fl = (i, b) => ({ id: i, name: 'b.bin', size: b.length });
const ids = (ps) => ps.list({ limit: 50 }).items.map((p) => p.id);

(async () => {
  const A = mkCore('A'), B = mkCore('B'); await A.start(); await B.start();
  try {
    const ps = A.pageStore(), pb = B.pageStore();
    // JPEG dengan 1,3 MB segmen APP1 sebelum SOF: sniff butuh > 1 MiB byte awal (store menyalin dengan kepala 4 MiB; impor harus sama)
    const seg = Buffer.concat([Buffer.from([0xff, 0xe1, 0xff, 0xff]), rnd(65533, 2)]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), ...new Array(20).fill(seg), Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 4, 0, 4, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), rnd(1000, 4)]);
    assert(sniffImage(jpg.slice(0, 1048576)) === null && sniffImage(jpg.slice(0, 4194304)), 'bahan uji: jpeg butuh lebih dari 1 MiB kepala');
    const imgB = Buffer.concat([png, rnd(MEDIA_CHUNK + 4321, 7)]), fileB = rnd(FILE_CHUNK + 777, 5), vidB = mp4(MEDIA_CHUNK + 999, 11);
    const [m1, mj] = await ps.addMedias([{ src: wr('g.png', imgB) }, { src: wr('h.jpg', jpg) }]), [f1] = await ps.addFiles([{ src: wr('l.pdf', fileB) }]), [v1] = await ps.addVideos([{ src: wr('v.mp4', vidB) }]);
    const pAll = ps.create({ text: 'lengkap\nbaris dua', media: [m1, mj], files: [f1], videos: [v1], nodl: true });
    const pText = ps.create({ text: 'hanya teks', priv: 'friends' });
    const pShare = ps.create({ text: 'berbagi', files: [f1] });
    await ps.exportTo(out('real.arc'));

    // 1. A -> B: isi identik, urutan sama, lampiran byte-per-byte, bertahan restart; ulang = semua "same" tanpa tulis
    {
      const prog = []; const r = await pb.importFrom(out('real.arc'), { onProgress: (p) => prog.push(p) });
      assert.deepStrictEqual([r.imported.length, r.same.length, r.conflict.length, r.bad.length, r.failed.length, r.aborted], [3, 0, 0, 0, 0, false]);
      assert.deepStrictEqual(r.blobs, { written: 4, reuse: 0, bytes: imgB.length + jpg.length + fileB.length + vidB.length }, 'lampiran bersama ditulis sekali');
      assert.deepStrictEqual(ids(pb), ids(ps), 'urutan tampil sama'); for (const id of ids(ps)) assert.deepStrictEqual(pb.get(id), ps.get(id), 'postingan identik');
      for (const [k, e, b] of [['media', m1, imgB], ['media', mj, jpg], ['files', f1, fileB], ['videos', v1, vidB]]) assert(fs.readFileSync(pb.blobFile(k, e)).equals(b), 'lampiran identik: ' + k);
      assert(prog.length && prog.every((p, i) => !i || p.bytes >= prog[i - 1].bytes) && prog[prog.length - 1].posts === 3 && prog[prog.length - 1].bytes === r.blobs.bytes, 'progres sampai total');
      assert(files(path.join(tmp, 'B')).every((f) => !f.endsWith('.tmp')), 'tidak ada sisa .tmp');
      const before = snap(path.join(tmp, 'B')); const r2 = await pb.importFrom(out('real.arc'));
      assert.deepStrictEqual([r2.imported.length, r2.same.length, r2.blobs.written], [0, 3, 0]); assert.deepStrictEqual(snap(path.join(tmp, 'B')), before, 'impor ulang tidak menulis apa pun');
      await B.stop(); const B2 = mkCore('B'); await B2.start(); // restart: indeks tertulis (flush) dan postingan terbaca
      try { const pb2 = B2.pageStore(); assert.deepStrictEqual(ids(pb2), ids(ps)); assert.deepStrictEqual(pb2.get(pAll.id), ps.get(pAll.id)); const r3 = await pb2.importFrom(out('real.arc')); assert.strictEqual(r3.same.length, 3); } finally { await B2.stop(); }
    }
    ok('A -> B: isi, urutan, nodl, priv, lampiran (jpeg berkepala > 1 MiB juga) identik; bertahan restart; impor ulang idempoten dan tidak menulis');

    // 2. ts asli dipertahankan dan disisipkan berurutan di antara postingan yang sudah ada; ts masa depan ditolak
    {
      const T = new PageStore(path.join(tmp, 'T2'), { ownerId: H(9) }); const mine = T.create({ text: 'milik sendiri' }); // ts = sekarang
      const e = {}, now = Date.now(), tss = { [H(1)]: 1000, [H(2)]: 5000, [H(3)]: 5000, [H(4)]: now + 3600e3, [H(5)]: now + 3 * 86400e3 };
      for (const id of Object.keys(tss)) e['post/' + id] = J(post(id, { ts: tss[id] }));
      const r = await importArchive(T, await mk('ts.arc', e));
      assert.deepStrictEqual(r.bad, [{ id: H(5), why: 'ts' }], 'ts > 1 hari ke depan ditolak'); assert.strictEqual(r.imported.length, 4);
      assert.deepStrictEqual(ids(T), [H(4), mine.id, H(2), H(3), H(1)], 'urutan: ts menurun; seri (5000) dipecah id');
      const n = T.create({ text: 'baru' }); assert(n.ts > T.get(H(4)).ts, 'postingan baru tetap di atas');
      assert.strictEqual(ids(new PageStore(path.join(tmp, 'T2'), { ownerId: H(9) })).join(), ids(T).join(), 'urutan sama setelah muat ulang');
    }
    ok('ts asli dipertahankan, disisipkan berurutan (seri dipecah id); ts masa depan ditolak; postingan baru tetap di atas');

    // 3. gagal per postingan: hash rusak, isi bukan jenisnya; lampiran yatim dibuang; lampiran yang sudah sah dari postingan lain tetap
    {
      const T = new PageStore(path.join(tmp, 'T3'), { ownerId: H(9) }), okB = Buffer.from('lampiran sah'), badImg = Buffer.concat([Buffer.from('GIF89a......'), rnd(png.length - 12, 1)]);
      const e = {
        ['post/' + H(1)]: J(post(H(1), { files: [fl(H(50), okB)] })), ['file/' + H(50)]: okB,
        ['post/' + H(2)]: J(post(H(2), { files: [fl(H(50), okB)], media: [med(H(51), png)] })), ['media/' + H(51)]: badImg,        // isi bukan png; lampiran sah H(50) dipakai bersama
        ['post/' + H(3)]: J(post(H(3), { files: [fl(H(52), okB)] })), ['file/' + H(52)]: okB,
        ['post/' + H(4)]: J(post(H(4), { text: 'tanpa lampiran' })),
      };
      const f = await mk('f3.arc', e);
      // balik satu bit isi file/H(52) di arsip (manifest tetap): hash gagal saat disalin
      const { ArcReader } = require('../src/archne-pagearc'); const rd = await ArcReader.open(f); const en = rd.entries.find((x) => x.n === 'file/' + H(52)); await rd.close();
      const bytes = fs.readFileSync(f); bytes[en.o] ^= 1; fs.writeFileSync(f, bytes);
      const r = await importArchive(T, f);
      assert.deepStrictEqual(r.imported, [H(1), H(4)]); assert.deepStrictEqual(r.failed, [{ id: H(2), why: 'content' }, { id: H(3), why: 'hash' }]);
      assert(!T.has(H(2)) && !T.has(H(3)), 'postingan gagal tidak masuk');
      assert.deepStrictEqual(files(path.join(tmp, 'T3')).filter((x) => !x.startsWith('p' + path.sep) && x !== 'index.json'), ['files' + path.sep + H(50)], 'hanya lampiran milik postingan sah; yang gagal dibersihkan (tanpa .tmp)');
      assert(fs.readFileSync(T.blobFile('files', { id: H(50) })).equals(okB), 'lampiran bersama dengan postingan sah tetap utuh');
    }
    ok('gagal per postingan (isi bukan jenisnya, hash rusak): tidak masuk, lampiran barunya dibuang, lampiran sah milik postingan lain tetap');

    // 4. conflict / bad / same tidak pernah menimpa atau masuk
    {
      const dirT = path.join(tmp, 'T4'); fs.mkdirSync(path.join(dirT, 'p', '00'), { recursive: true });
      const own = post(H(7), { text: 'versi lokal' }); fs.mkdirSync(path.join(dirT, 'p', H(7).slice(0, 2)), { recursive: true }); fs.writeFileSync(path.join(dirT, 'p', H(7).slice(0, 2), H(7) + '.json'), JSON.stringify(own));
      const T = new PageStore(dirT, { ownerId: H(9) });
      const e = { ['post/' + H(7)]: J(post(H(7), { text: 'versi arsip' })), ['post/' + H(8)]: J(post(H(8), { bogus: 1 })), ['post/' + H(9)]: J(post(H(9))) };
      const before = fs.readFileSync(path.join(dirT, 'p', H(7).slice(0, 2), H(7) + '.json'), 'utf8');
      const r = await importArchive(T, await mk('c4.arc', e));
      assert.deepStrictEqual([r.imported, r.conflict, r.bad], [[H(9)], [{ id: H(7), why: 'id' }], [{ id: H(8), why: 'post' }]]);
      assert.strictEqual(fs.readFileSync(path.join(dirT, 'p', H(7).slice(0, 2), H(7) + '.json'), 'utf8'), before, 'versi lokal tidak ditimpa'); assert(!T.has(H(8)));
    }
    ok('bentrok tidak menimpa, cacat tidak masuk, hanya yang baru diimpor');

    // 5. batal di tengah: yang sudah selesai tetap, yang sedang disalin dibuang tanpa sisa; ulangi = melengkapi sisanya
    {
      const T = new PageStore(path.join(tmp, 'T5'), { ownerId: H(9) }), big = rnd(MEDIA_CHUNK * 3, 6), e = {};
      for (let i = 1; i <= 3; i++) { e['post/' + H(i)] = J(post(H(i), { ts: 1000 + i, files: [fl(H(60 + i), big)] })); e['file/' + H(60 + i)] = rnd(big.length, i); }
      const f = await mk('b5.arc', e), ac = new AbortController();
      const r = await importArchive(T, f, { signal: ac.signal, onProgress: (p) => { if (p.posts === 1 && p.bytes > big.length + MEDIA_CHUNK) ac.abort(); } });
      assert.strictEqual(r.aborted, true); assert.deepStrictEqual(r.imported, [H(1)]); assert.strictEqual(T.count(), 1);
      assert.deepStrictEqual(files(path.join(tmp, 'T5')).filter((x) => x.startsWith('files')), ['files' + path.sep + H(61)], 'lampiran postingan yang dibatalkan dibuang, tanpa .tmp');
      assert.strictEqual(new PageStore(path.join(tmp, 'T5'), { ownerId: H(9) }).count(), 1, 'indeks tertulis walau dibatalkan');
      const r2 = await importArchive(T, f); assert.deepStrictEqual([r2.imported.length, r2.same.length, r2.aborted], [2, 1, false]); assert.strictEqual(T.count(), 3);
      const ac2 = new AbortController(); ac2.abort(); const T6 = new PageStore(path.join(tmp, 'T6'), { ownerId: H(9) });
      const r3 = await importArchive(T6, f, { signal: ac2.signal }).catch((x) => x.code); assert(r3 === 'abort' || (r3 && r3.aborted), 'dibatalkan sebelum mulai'); assert.strictEqual(T6.count(), 0);
    }
    ok('batal: yang selesai tetap, yang berjalan dibuang tanpa sisa, indeks tertulis; mengulang melengkapi sisanya');

    // 6. galat tak terduga di tengah: berhenti, e.partial berisi yang sudah masuk, lampiran postingan itu dibersihkan, indeks tetap tertulis
    {
      const T = new PageStore(path.join(tmp, 'T7'), { ownerId: H(9) }), e = {}, b = Buffer.from('xyz');
      for (let i = 1; i <= 3; i++) { e['post/' + H(i)] = J(post(H(i), { ts: 1000 + i, files: [fl(H(70 + i), b)] })); e['file/' + H(70 + i)] = b; }
      const real = T.adoptPost.bind(T); let n = 0; T.adoptPost = (p, o) => { if (++n === 2) throw Object.assign(new Error('disk penuh'), { code: 'ENOSPC' }); return real(p, o); };
      let err; try { await importArchive(T, await mk('e6.arc', e)); } catch (x) { err = x; }
      assert(err && err.code === 'ENOSPC' && err.partial && err.partial.imported.length === 1, 'galat dilempar dengan hasil sementara');
      assert.deepStrictEqual(files(path.join(tmp, 'T7')).filter((x) => x.startsWith('files')), ['files' + path.sep + H(71)]);
      assert.strictEqual(new PageStore(path.join(tmp, 'T7'), { ownerId: H(9) }).count(), 1);
    }
    ok('galat tak terduga: berhenti, e.partial ada, lampiran yang baru dibuang, yang sudah masuk tetap');

    // 7. adoptPost langsung: urutan, duplikat, lampiran belum ada, bentuk tak sah, gagal tulis indeks = batal; defer aman dari crash
    {
      const dir = path.join(tmp, 'T8'), T = new PageStore(dir, { ownerId: H(9) });
      T.adoptPost(post(H(1), { ts: 50 })); T.adoptPost(post(H(2), { ts: 70 })); T.adoptPost(post(H(3), { ts: 60 })); assert.deepStrictEqual(ids(T), [H(2), H(3), H(1)]);
      assert.throws(() => T.adoptPost(post(H(1))), /sudah ada/); assert.throws(() => T.adoptPost(post(H(4), { files: [fl(H(80), Buffer.from('x'))] })), /belum disalin/);
      assert.throws(() => T.adoptPost({ v: 1 }), /tidak valid/); assert.throws(() => T.adoptPost(post(H(5), { priv: 'x' })), /tidak valid/); assert.strictEqual(T.count(), 3);
      const real = T._saveIdx; T._saveIdx = () => { throw new Error('indeks gagal'); };
      assert.throws(() => T.adoptPost(post(H(6), { ts: 80 })), /indeks gagal/); T._saveIdx = real;
      assert(!T.has(H(6)) && ids(T).length === 3 && !fs.existsSync(path.join(dir, 'p', H(6).slice(0, 2), H(6) + '.json')), 'gagal tulis indeks membatalkan seluruhnya');
      T.adoptPost(post(H(7), { ts: 90 }), { defer: true }); // indeks belum ditulis
      const T2 = new PageStore(dir, { ownerId: H(9) }); assert.deepStrictEqual(ids(T2), [H(7), H(2), H(3), H(1)], 'tanpa flush pun, muat ulang menemukan postingan dari isi folder');
    }
    ok('adoptPost: sisip berurutan, tolak duplikat / lampiran belum ada / bentuk tak sah, gagal indeks = batal, defer aman dari crash');

    // 8. ke store tanpa Core (opts.owner) dan masukan tak sah
    {
      const T = new PageStore(path.join(tmp, 'T9')); const r = await importArchive(T, out('real.arc'), { owner: A.id }); assert.strictEqual(r.ownerMatch, true); assert.strictEqual(r.imported.length, 3);
      assert.strictEqual(await importArchive({}, out('real.arc')).catch((e) => e.code), 'bad'); assert.strictEqual(await importArchive(T, out('tidak-ada.arc')).catch((e) => e.code), 'ENOENT');
      const rep = await inspectArchive(T, out('real.arc')); assert.deepStrictEqual(rep.counts, { total: 3, new: 0, same: 3, conflict: 0, bad: 0 }, 'pemeriksaan sesudah impor: semua "same"');
    }
    ok('store tanpa Core (owner lewat opts); masukan tak sah ditolak; sesudah impor, pemeriksaan melaporkan semua "same"');
  } finally { for (const c of [A, B]) { try { await c.stop(); } catch {} } }
  console.log('\n' + pass + ' tes lulus');
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

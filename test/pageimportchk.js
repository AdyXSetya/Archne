'use strict';
// Tes 5d-3: impor tahap periksa / dry-run (src/archne-pageimport.js). Arsip asli dari Core sungguhan (pageexport) + arsip jahat buatan tangan (ArcWriter).
// Pada setiap pemeriksaan, store tujuan TIDAK BOLEH berubah satu byte pun.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { PageStore, FILE_CHUNK, MEDIA_CHUNK } = require('../src/archne-pagestore');
const { ArcWriter, ArcReader } = require('../src/archne-pagearc');
const { inspectArchive, canonPost } = require('../src/archne-pageimport');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pageimportchk-'));
let pass = 0; const ok = (s) => { pass++; console.log('  OK  ' + s); };
const rnd = (n, seed) => { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; } return b; };
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
const mp4 = (n, seed) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), rnd(n, seed)]);
const wr = (n, b) => { const f = path.join(tmp, n); fs.writeFileSync(f, b); return f; };
const out = (n) => path.join(tmp, n);
const code = async (p) => { try { await p; } catch (e) { return e.code || e.message; } return 'tidak melempar'; };
const snap = (dir) => { const r = []; (function w(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), s = fs.statSync(f); if (s.isDirectory()) w(f); else r.push(path.relative(dir, f) + ':' + s.size + ':' + s.mtimeMs); } })(dir); return r; };
const J = (o) => Buffer.from(JSON.stringify(o));
const H = (n) => n.toString(16).padStart(16, '0');
const post = (id, x) => Object.assign({ v: 1, id, ts: 1700000000000, kind: 'text', text: 'halo', priv: 'public' }, x || {});
// arsip buatan tangan: entries = { nama: Buffer }, meta menimpa bawaan { kind, fmt, owner:null, posts }
async function mk(name, entries, meta) {
  const w = await ArcWriter.create(out(name));
  for (const n of Object.keys(entries)) await w.addBuffer(n, entries[n]);
  await w.finish(Object.assign({ kind: 'archne-pages', fmt: 1, owner: null, posts: Object.keys(entries).filter((n) => /^post\//.test(n)).map((n) => n.slice(5)) }, meta || {}));
  return out(name);
}
const only = (r) => r.posts.map((p) => p.status + (p.why ? ':' + p.why : '')).join(',');

(async () => {
  const A = new Core({ dataDir: path.join(tmp, 'A'), downloadDir: path.join(tmp, 'A-dl'), name: 'A', discovery: false }); await A.start();
  try {
    const ps = A.pageStore();
    const imgB = Buffer.concat([png, rnd(MEDIA_CHUNK + 4321, 7)]), fileB = rnd(FILE_CHUNK + 777, 5), vidB = mp4(MEDIA_CHUNK + 999, 11);
    const [m1] = await ps.addMedias([{ src: wr('g.png', imgB) }]), [f1] = await ps.addFiles([{ src: wr('l.pdf', fileB) }]), [v1] = await ps.addVideos([{ src: wr('v.mp4', vidB) }]);
    const pAll = ps.create({ text: 'lengkap', media: [m1], files: [f1], videos: [v1], nodl: true });
    const pText = ps.create({ text: 'hanya teks', priv: 'friends' });
    const pShare = ps.create({ text: 'berbagi', files: [f1] });
    await ps.exportTo(out('real.arc'));
    const T0 = new PageStore(path.join(tmp, 'T0'), { ownerId: H(0xabc) }); // tujuan kosong

    // 1. arsip asli ke store kosong: semua baru, lampiran dihitung SEKALI, store tujuan tidak berubah
    {
      const before = snap(path.join(tmp, 'T0')), prog = [];
      const r = await inspectArchive(T0, out('real.arc'), { onProgress: (p) => prog.push(p) });
      assert.deepStrictEqual(r.counts, { total: 3, new: 3, same: 0, conflict: 0, bad: 0 }); assert.deepStrictEqual(r.posts.map((p) => p.id), ps.list({ limit: 50 }).items.map((p) => p.id), 'urutan tampil');
      assert.deepStrictEqual(r.blobs, { new: 3, reuse: 0, bytesNew: imgB.length + fileB.length + vidB.length }, 'f1 dirujuk dua postingan: satu kali'); assert.strictEqual(r.extra, 0);
      assert.strictEqual(r.owner, A.id); assert.strictEqual(r.ownerMatch, false); assert.strictEqual(r.verified, true); assert(r.created > 0);
      assert(r.posts.every((p) => p.ts > 0 && (p.priv === 'public' || p.priv === 'friends')));
      const last = prog[prog.length - 1]; assert.strictEqual(last.bytes, imgB.length + fileB.length + vidB.length, 'f1 dibaca sekali saja'); assert.strictEqual(last.totalBytes, last.bytes);
      assert(prog.every((p, i) => !i || p.bytes >= prog[i - 1].bytes), 'progres tidak mundur');
      assert.deepStrictEqual(snap(path.join(tmp, 'T0')), before, 'store tujuan tidak berubah'); assert.strictEqual(T0.count(), 0);
    }
    ok('arsip asli ke store kosong: semua baru, lampiran bersama dihitung sekali, progres benar, store tidak tersentuh');

    // 2. ke store asal sendiri: semua "sama", pemilik cocok, tak ada yang perlu disalin
    {
      const before = snap(path.join(tmp, 'A'));
      const r = await inspectArchive(ps, out('real.arc')); assert.deepStrictEqual(r.counts, { total: 3, new: 0, same: 3, conflict: 0, bad: 0 }); assert.strictEqual(r.ownerMatch, true);
      assert.deepStrictEqual(r.blobs, { new: 0, reuse: 0, bytesNew: 0 }); assert.deepStrictEqual(snap(path.join(tmp, 'A')), before);
    }
    ok('ke store yang sama: semua "same", pemilik cocok, tidak ada lampiran baru');

    // 3. bentrok: id sama isi beda; lampiran id sama isi beda (bentrok) dan isi sama (dipakai ulang)
    {
      const dirC = path.join(tmp, 'T1'), seg = (id) => path.join(dirC, 'p', id.slice(0, 2)); fs.mkdirSync(seg(pText.id), { recursive: true });
      fs.writeFileSync(path.join(seg(pText.id), pText.id + '.json'), JSON.stringify(Object.assign({}, ps.get(pText.id), { text: 'versi lain' }))); // id sama, isi beda
      fs.mkdirSync(path.join(dirC, 'files'), { recursive: true }); fs.writeFileSync(path.join(dirC, 'files', f1.id), rnd(fileB.length, 99)); // lampiran f1: ukuran sama, isi beda
      const T1 = new PageStore(dirC, { ownerId: A.id }); assert(T1.has(pText.id));
      const before = snap(dirC), r = await inspectArchive(T1, out('real.arc'));
      const st = {}; for (const p of r.posts) st[p.id] = p.status + ':' + p.why;
      assert.deepStrictEqual(st, { [pAll.id]: 'conflict:blob', [pText.id]: 'conflict:id', [pShare.id]: 'conflict:blob' }); assert.deepStrictEqual(snap(dirC), before);
      // isi lampiran sama persis di tujuan: dipakai ulang, tidak dihitung sebagai byte baru
      fs.writeFileSync(path.join(dirC, 'files', f1.id), fileB); const T1b = new PageStore(dirC, { ownerId: A.id });
      const r2 = await inspectArchive(T1b, out('real.arc')); const s2 = {}; for (const p of r2.posts) s2[p.id] = p.status + ':' + p.why;
      assert.deepStrictEqual(s2, { [pAll.id]: 'new:null', [pText.id]: 'conflict:id', [pShare.id]: 'new:null' });
      assert.deepStrictEqual(r2.blobs, { new: 2, reuse: 1, bytesNew: imgB.length + vidB.length }, 'f1 dipakai ulang');
    }
    ok('bentrok: id postingan sama isi beda, lampiran id sama isi beda; lampiran identik dipakai ulang');

    // 4. cacat per postingan: tiap satu dilaporkan "bad" dengan alasannya; yang lain tetap diperiksa
    {
      const ia = H(1), ib = H(2), ic = H(3), id = H(4), ie = H(5), iff = H(6), ig = H(7), ih = H(8), ii = H(9), ij = H(10), ik = H(11), il = H(12), good = H(13);
      const med = (i, b, x) => Object.assign({ id: i, mime: 'image/png', size: b.length, name: 'a.png' }, x || {});
      const e = {};
      e['post/' + good] = J(post(good));
      e['post/' + ia] = J(post(ia, { zzz: 1 }));                                   // bidang asing
      e['post/' + ib] = J(post(ib, { text: 'a‮b' }));                         // teks belum bersih
      e['post/' + ic] = J(post(ic, { priv: 'rahasia' }));                          // privasi tak sah
      e['post/' + id] = J(post(id, { media: [med(H(100), png)] }));                // lampiran tidak ada di arsip
      e['post/' + ie] = J(post(ie, { media: [med(H(101), png, { size: 5 })] })); e['media/' + H(101)] = png; // ukuran beda
      e['post/' + iff] = J(post(iff, { media: [med(H(102), png)] })); e['media/' + H(102)] = Buffer.concat([Buffer.from('GIF89a......'), rnd(png.length - 12, 1)]); // ukuran sama, isi bukan png
      e['post/' + ig] = J(post(ig, { videos: [{ id: H(103), mime: 'video/mp4', size: 40, name: 'v.mp4' }] })); e['video/' + H(103)] = rnd(40, 3); // video palsu
      e['post/' + ih] = Buffer.from('{bukan json');
      e['post/' + ii] = J(post(ii, { id: H(99) }));                                // id di dalam tidak cocok dengan nama
      e['post/' + ij] = J(post(ij, { nodl: false }));                              // nodl false tidak pernah ditulis
      e['post/' + ik] = J(post(ik, { files: [{ id: H(104), name: ' spasi.txt ', size: 3 }] })); e['file/' + H(104)] = Buffer.from('abc'); // lampiran tidak ternormalisasi
      e['post/' + il] = J(post(il, { text: '' }));
      const f = await mk('bad.arc', e, { posts: [good, ia, ib, ic, id, ie, iff, ig, ih, ii, ij, ik, il, H(200)] }); // H(200): ada di daftar, tak ada di arsip
      const r = await inspectArchive(T0, f);
      assert.deepStrictEqual(r.posts.map((p) => p.status + ':' + p.why), ['new:null', 'bad:post', 'bad:post', 'bad:post', 'bad:noblob', 'bad:size', 'bad:content', 'bad:content', 'bad:post', 'bad:post', 'bad:post', 'bad:post', 'bad:post', 'bad:nopost']);
      assert.deepStrictEqual(r.counts, { total: 14, new: 1, same: 0, conflict: 0, bad: 13 });
      assert.deepStrictEqual(r.blobs, { new: 0, reuse: 0, bytesNew: 0 }, 'lampiran postingan cacat tidak dihitung');
    }
    ok('13 bentuk cacat per postingan (bidang asing, teks kotor, privasi, lampiran hilang / ukuran / isi, JSON rusak, id, nodl, tak ternormalisasi, kosong, tak ada di arsip); yang sah tetap lolos');

    // 5. hash lampiran rusak: terdeteksi saat verify, lolos bila verify:false (dilaporkan)
    {
      const bytes = fs.readFileSync(out('real.arc')); const rd = await ArcReader.open(out('real.arc')); const e = rd.entries.find((x) => x.n === 'file/' + f1.id); await rd.close();
      bytes[e.o + 10] ^= 1; fs.writeFileSync(out('flip.arc'), bytes);
      const r = await inspectArchive(T0, out('flip.arc')); const st = {}; for (const p of r.posts) st[p.id] = p.status + ':' + p.why;
      assert.deepStrictEqual(st, { [pAll.id]: 'bad:hash', [pText.id]: 'new:null', [pShare.id]: 'bad:hash' }, 'dua postingan merujuk berkas rusak itu');
      const r2 = await inspectArchive(T0, out('flip.arc'), { verify: false }); assert.strictEqual(r2.verified, false); assert.strictEqual(r2.counts.bad, 0, 'tanpa verify tidak membaca isi');
    }
    ok('satu bit lampiran terbalik: semua postingan perujuk "bad:hash"; verify:false melewati dan dilaporkan verified=false');

    // 6. kelebihan entri diabaikan dan dihitung; arsip rusak menyeluruh melempar
    {
      const e = { ['post/' + H(1)]: J(post(H(1))), 'file/sisa': Buffer.from('yatim'), ['post/' + H(2)]: J(post(H(2))) };
      const r = await inspectArchive(T0, await mk('extra.arc', e, { posts: [H(1)] })); assert.deepStrictEqual([r.counts.total, r.extra], [1, 2], 'entri di luar daftar diabaikan');
      assert.strictEqual(await code(inspectArchive(T0, await mk('k1.arc', {}, { kind: 'lain' }))), 'bad');
      assert.strictEqual(await code(inspectArchive(T0, await mk('k2.arc', {}, { fmt: 2 }))), 'bad');
      assert.strictEqual(await code(inspectArchive(T0, await mk('k3.arc', {}, { owner: 'xyz' }))), 'bad');
      assert.strictEqual(await code(inspectArchive(T0, await mk('k4.arc', {}, { posts: 'x' }))), 'bad');
      assert.strictEqual(await code(inspectArchive(T0, await mk('k5.arc', {}, { posts: [H(1), H(1)] }))), 'bad', 'id ganda di daftar');
      assert.strictEqual(await code(inspectArchive(T0, await mk('k6.arc', {}, { posts: ['../x'] }))), 'bad');
      assert.strictEqual(await code(inspectArchive(T0, wr('bukan.arc', Buffer.from('bukan arsip, hanya teks biasa yang cukup panjang untuk melewati ukuran minimum berkas')))), 'bad');
      assert.strictEqual(await code(inspectArchive(T0, out('tidak-ada.arc'))), 'ENOENT'); assert.strictEqual(await code(inspectArchive({}, out('real.arc'))), 'bad');
      const r0 = await inspectArchive(T0, await mk('kosong.arc', {}, { posts: [] })); assert.deepStrictEqual([r0.counts.total, r0.ownerMatch], [0, null]);
    }
    ok('entri di luar daftar diabaikan dan dihitung; meta tak sah / arsip bukan arsip / berkas tak ada melempar; arsip kosong sah');

    // 7. pembatalan
    {
      const ac = new AbortController(); assert.strictEqual(await code(inspectArchive(T0, out('real.arc'), { signal: ac.signal, onProgress: (p) => { if (p.bytes > FILE_CHUNK) ac.abort(); } })), 'abort');
      const ac2 = new AbortController(); ac2.abort(); assert.strictEqual(await code(inspectArchive(T0, out('real.arc'), { signal: ac2.signal })), 'abort');
    }
    ok('pembatalan di tengah dan sebelum mulai');

    // 8. canonPost langsung
    {
      const id = H(5), good = post(id, { media: [{ id: H(6), mime: 'image/png', size: 5, name: 'a.png' }] });
      assert.deepStrictEqual(canonPost(good, id), good); assert.strictEqual(canonPost(good, H(6)), null, 'id tidak cocok');
      for (const bad of [null, [], 'x', Object.assign({}, good, { kind: 'foto' }), Object.assign({}, good, { v: 2 }), Object.assign({}, good, { ts: 1.5 }), Object.assign({}, good, { ts: 0 })]) assert.strictEqual(canonPost(bad, id), null);
    }
    ok('canonPost: bentuk sah kembali persis; bentuk tak sah null');
  } finally { try { await A.stop(); } catch {} }
  console.log('\n' + pass + ' tes lulus');
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

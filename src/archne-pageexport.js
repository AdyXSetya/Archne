'use strict';
// 5d-2: ekspor halaman ke arsip (format di archne-pagearc.js). Bawaan: hanya POSTINGAN + LAMPIRAN (gambar, video, berkas). 5d-5: opts.comments = true menambah entri `comments` (komentar bertanda tangan + nisan
// untuk postingan yang ikut diekspor saja).
// Tanpa ?. / ?? (Node 12 di Android).
//
// Isi arsip:
//   post/<id>    JSON postingan persis seperti di store (termasuk priv, nodl, daftar media/files/videos)
//   media/<id>   byte gambar     file/<id>   byte lampiran     video/<id>   byte video      (id = id berkas di store; HEX16, unik per postingan)
//   comments     (hanya bila opts.comments) JSON { v:1, owner, map:{ postId:[komentar] }, rm:['postId:cid'] }; tanda tangan komentar menutup id pemilik, jadi hanya sah bagi identitas yang sama (lihat impor)
//   meta         { kind:'archne-pages', fmt:1, owner, posts:[id ...] (urutan tampil, terbaru dulu), counts:{ posts, media, files, videos, bytes }, comments?:{ items, tombs } }
// SATU-SATUNYA daftar yang sah adalah meta.posts: entri di luar daftar itu (sisa postingan yang gagal di tengah) diabaikan oleh impor (5d-3/4).
//
// Postingan yang tidak bisa diekspor utuh (dihapus saat ekspor berjalan, berkas lampiran hilang / ukurannya tak cocok / berubah saat disalin) DILEWATI dan
// dilaporkan di `skipped`; ekspor tetap selesai untuk yang lain. Daftar id diambil di awal (snapshot): postingan baru sesudahnya tidak ikut.
// Pembatalan (opts.signal) atau galat tak terduga = arsip sebagian dibuang, berkas tujuan lama tidak tersentuh.
const fs = require('fs');
const { ArcWriter, ArcError } = require('./archne-pagearc');

const KIND = 'archne-pages';
const HEX16 = /^[0-9a-f]{16}$/;
const CMT_ENTRY_MAX = 64 * 1024 * 1024; // batas keras entri komentar (CMT_STORE_MAX komentar x ~4,5 KB terburuk)
const sizeOf = (p) => { let n = 0; for (const k of ['media', 'files', 'videos']) if (p[k]) for (const e of p[k]) n += e.size; return n; };

// store: PageStore. file: tujuan. opts: { ids (subset; bawaan semua), owner, signal, onProgress({ posts, total, bytes, totalBytes, id }) }
async function exportPages(store, file, opts) {
  opts = opts || {};
  if (!store || typeof store.get !== 'function' || !Array.isArray(store.idx)) throw new ArcError('bad', 'store tidak valid');
  let ids = store.idx.map((e) => e.id); // terbaru dulu
  if (opts.ids != null) {
    if (!Array.isArray(opts.ids) || opts.ids.some((i) => !HEX16.test(String(i)))) throw new ArcError('bad', 'daftar id tidak valid');
    const want = new Set(opts.ids);
    ids = ids.filter((i) => want.has(i));
  }
  const owner = opts.owner != null ? opts.owner : (store.cmt ? store.cmt.owner : null);
  if (opts.comments) {
    if (!store.cmt) throw new ArcError('bad', 'komentar dimatikan di store ini');
    if (owner !== store.cmt.owner) throw new ArcError('bad', 'pemilik arsip harus sama dengan pemilik komentar');
  }
  const w = await ArcWriter.create(file);
  try {
    const posts = [], skipped = [], blobs = new Map(); // blobs: nama entri -> ukuran, HANYA yang dirujuk postingan yang ikut (untuk hitungan)
    // total byte perkiraan dari metadata (murah: satu pembacaan JSON per postingan); hanya untuk progres.
    let totalBytes = 0, prog = 0;
    for (const id of ids) { const p = store.get(id); if (p) totalBytes += sizeOf(p); }
    const say = (id) => { if (typeof opts.onProgress === 'function') opts.onProgress({ posts: posts.length, total: ids.length, bytes: prog, totalBytes, id }); };
    for (const id of ids) {
      if (opts.signal && opts.signal.aborted) throw new ArcError('abort', 'dibatalkan');
      const p = store.get(id);
      if (!p) { skipped.push({ id, why: 'gone' }); continue; }
      // periksa SEMUA lampiran ada dan ukurannya cocok SEBELUM menulis apa pun, supaya kegagalan biasa tidak meninggalkan sisa
      const att = [];
      let miss = false;
      for (const [k, pre, pathOf] of [['media', 'media/', (e) => store.mediaPath(e)], ['files', 'file/', (e) => store.filePath(e)], ['videos', 'video/', (e) => store.videoPath(e)]]) {
        if (!p[k]) continue;
        for (const e of p[k]) {
          const f = pathOf(e); let st = null;
          try { st = f ? fs.statSync(f) : null; } catch {}
          if (!st || !st.isFile() || st.size !== e.size) { miss = true; break; }
          att.push({ name: pre + e.id, f, size: e.size, k });
        }
        if (miss) break;
      }
      if (miss) { skipped.push({ id, why: 'missing' }); continue; }
      try {
        for (const a of att) {
          if (w.has(a.name)) continue; // berkas yang sama dirujuk postingan lain: cukup satu salinan
          await w.addFile(a.name, a.f, { signal: opts.signal, expectSize: a.size, onBytes: (n) => { prog += n; say(id); } });
        }
        await w.addBuffer('post/' + id, Buffer.from(JSON.stringify(p)));
      } catch (e) {
        if (e instanceof ArcError && (e.code === 'abort' || e.code === 'limit' || e.code === 'dead')) throw e;
        // berkas berubah / hilang saat disalin: lewati postingan ini; byte yang sudah masuk jadi sisa yatim (diabaikan impor)
        skipped.push({ id, why: e && e.code === 'size' ? 'changed' : 'io' });
        continue;
      }
      posts.push(id);
      for (const a of att) blobs.set(a.name, a.size);
      say(id);
    }
    let cm = null;
    if (opts.comments) {
      const d = store.cmt.dump(new Set(posts));
      let items = 0; for (const k of Object.keys(d.map)) items += d.map[k].length;
      const buf = Buffer.from(JSON.stringify({ v: 1, owner: store.cmt.owner, map: d.map, rm: d.rm }));
      if (buf.length > CMT_ENTRY_MAX) throw new ArcError('limit', 'komentar terlalu besar untuk satu arsip');
      await w.addBuffer('comments', buf);
      cm = { items, tombs: d.rm.length };
    }
    const counts = { posts: posts.length, media: 0, files: 0, videos: 0, bytes: 0 };
    for (const [n, sz] of blobs) { counts[n.startsWith('media/') ? 'media' : n.startsWith('file/') ? 'files' : 'videos']++; counts.bytes += sz; }
    const fin = await w.finish(Object.assign({ kind: KIND, fmt: 1, owner, posts, counts }, cm ? { comments: cm } : {}));
    return { file, size: fin.size, posts: posts.length, media: counts.media, files: counts.files, videos: counts.videos, bytes: counts.bytes, skipped, comments: cm };
  } catch (e) { await w.abort(); throw e; }
}

module.exports = { exportPages, KIND, CMT_ENTRY_MAX };

'use strict';
// 5d-3: impor tahap PERIKSA (dry-run). Membaca arsip (archne-pageexport.js / archne-pagearc.js) dan melaporkan apa yang AKAN terjadi bila diimpor. TIDAK menulis apa pun ke store.
// Tahap tulis (5d-4) memakai canonPost() dan aturan yang sama, dan memeriksa ulang terhadap store saat itu (store bisa berubah sejak dry-run).
// Arsip = masukan tidak dipercaya: tiap postingan dibangun ulang ke bentuk kanonik (hanya bidang yang dikenal, teks sudah bersih, lampiran ternormalisasi)
// dan harus SAMA PERSIS dengan isi arsip; isi tiap lampiran diperiksa hash-nya dan (gambar / video) jenisnya dari byte-nya, sama seperti saat disalin ke store.
// 5d-5: komentar + nisan (entri `comments`) HANYA dipulihkan bila id pemilik arsip = id pemilik store (tanda tangan komentar menutup id pemilik; di identitas lain semuanya gagal cmtVerify).
// Beda / tidak diketahui = postingan tetap diimpor, komentar dilaporkan tidak dibawa (comments.status 'skipped', why 'owner'). Komentar hanya untuk postingan yang berstatus new / same;
// tiap komentar diverifikasi ulang (PageCmt.merge), yang gagal dibuang dan dihitung. Nisan dari arsip tidak pernah menghapus komentar yang hidup, dan nisan lokal menang atas komentar arsip.
// Tanpa ?. / ?? (Node 12 di Android).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ArcReader, ArcError } = require('./archne-pagearc');
const { KIND, CMT_ENTRY_MAX } = require('./archne-pageexport');
const { CMT_STORE_MAX, CMT_RM_MAX } = require('./archne-pagecmt');
const { cleanText, normMedia, normFiles, normVideos, normAttach, WIRE_TEXT_MAX, PAGE_PRIV, COPY_CHUNK } = require('./archne-pagestore');
const { sniffImage, pixelsOk, sniffAv, playMime } = require('./archne-mediacheck');

const HEX16 = /^[0-9a-f]{16}$/;
const POSTS_MAX = 100000;
const POST_MAX = 8 * 1024 * 1024; // byte JSON satu postingan (teks <= WIRE_TEXT_MAX karakter + 10 thumbnail)
const MEDIA_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const TS_SKEW = 24 * 3600 * 1000; // ts di masa depan (> 1 hari) ditolak: create() memberi postingan baru ts = terbaru + 1, jadi satu ts masa depan akan menyeret semua postingan berikutnya
const KEYS = ['v', 'id', 'ts', 'kind', 'text', 'priv', 'media', 'files', 'videos', 'nodl'];
const PREFIX = { media: 'media/', files: 'file/', videos: 'video/' };

// JSON dengan kunci terurut: pembanding yang tidak bergantung urutan kunci.
function canon(x) {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
  return JSON.stringify(x);
}

// Bentuk kanonik sebuah postingan dari arsip, atau null bila tidak sah / tidak persis kanonik (bidang asing, teks belum bersih, lampiran tak ternormalisasi).
function canonPost(p, id) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.id !== id || !HEX16.test(String(id))) return null;
  if (Object.keys(p).some((k) => KEYS.indexOf(k) < 0)) return null;
  if (p.v !== 1 || p.kind !== 'text' || typeof p.text !== 'string' || p.text.length > WIRE_TEXT_MAX) return null;
  if (!Number.isSafeInteger(p.ts) || p.ts <= 0 || PAGE_PRIV.indexOf(p.priv) < 0) return null;
  if (p.nodl !== undefined && p.nodl !== true) return null;
  let text; try { text = cleanText(p.text); } catch { return null; }
  const att = normAttach(p.media, p.files, p.videos);
  if (att === null) return null;
  const c = { v: 1, id, ts: p.ts, kind: 'text', text, priv: p.priv };
  if (att.media) c.media = att.media;
  if (att.files) c.files = att.files;
  if (att.videos) c.videos = att.videos;
  if (p.nodl === true) c.nodl = true;
  return canon(c) === canon(p) ? c : null;
}
// Daftar lampiran sebuah postingan kanonik: [{ k, e, name }]
function blobsOf(c) {
  const out = [];
  for (const k of ['media', 'files', 'videos']) if (c[k]) for (const e of c[k]) out.push({ k, e, name: PREFIX[k] + e.id });
  return out;
}

// Kumpulkan byte awal lampiran (sampai COPY_CHUNK, sama dengan yang diperiksa store saat menyalin; jpeg dengan EXIF besar tetap muat) lalu periksa jenisnya.
// feed(chunk) -> false bila sudah pasti cacat (boleh menghentikan baca lebih awal); end() -> hasil akhir untuk lampiran yang lebih pendek dari batas.
function headCheck(b) {
  const need = Math.min(b.e.size, COPY_CHUNK), parts = []; let got = 0, done = false;
  const run = () => { done = true; return headOk(b.k, b.e, Buffer.concat(parts)); };
  return {
    feed(c) { if (done) return true; const take = Math.min(c.length, need - got); parts.push(Buffer.from(c.slice(0, take))); got += take; return got >= need ? run() : true; },
    end() { return done || run(); },
  };
}

async function hashFile(f, signal) {
  const h = crypto.createHash('sha256'), buf = Buffer.alloc(1024 * 1024), fh = await fs.promises.open(f, 'r');
  try {
    for (let at = 0; ;) {
      if (signal && signal.aborted) throw new ArcError('abort', 'dibatalkan');
      const r = await fh.read(buf, 0, buf.length, at);
      if (!r.bytesRead) break;
      h.update(buf.slice(0, r.bytesRead)); at += r.bytesRead;
    }
  } finally { await fh.close().catch(() => {}); }
  return h.digest('hex');
}

// Isi lampiran sesuai jenisnya? (gambar: byte awal = jenis yang diklaim dan dimensi wajar; video: kontainer cocok nama dan jenis). Lampiran umum: tanpa syarat.
function headOk(k, e, head) {
  if (k === 'media') { const i = sniffImage(head); return !!i && i.mime === e.mime && MEDIA_MIMES.indexOf(i.mime) >= 0 && pixelsOk(i); }
  if (k === 'videos') return playMime(e.name, sniffAv(head)) === e.mime;
  return true;
}

// Entri `comments` arsip -> { map, rm } (bentuk saja; tanda tangan diperiksa PageCmt.merge). Melempar fail(why) bila tidak sah / tidak cocok dengan meta (jumlah, pemilik).
async function loadComments(rd, signal) {
  const m = rd.meta, info = rd.info('comments');
  if (!m.comments || !info) throw fail(info ? 'nometa' : 'nocmt');
  let j;
  try { j = JSON.parse((await rd.readBuffer('comments', CMT_ENTRY_MAX)).toString('utf8')); } catch (e) { if (e instanceof ArcError && e.code === 'abort') throw e; throw fail(e instanceof ArcError && (e.code === 'limit' || e.code === 'hash') ? e.code : 'cmt'); }
  if (!j || typeof j !== 'object' || j.v !== 1 || j.owner !== m.owner || !j.map || typeof j.map !== 'object' || Array.isArray(j.map) || !Array.isArray(j.rm)) throw fail('cmt');
  let items = 0;
  for (const k of Object.keys(j.map)) { if (!HEX16.test(k) || !Array.isArray(j.map[k])) throw fail('cmt'); items += j.map[k].length; }
  if (items > CMT_STORE_MAX || j.rm.length > CMT_RM_MAX) throw fail('limit');
  if (items !== m.comments.items || j.rm.length !== m.comments.tombs) throw fail('count');
  return { map: j.map, rm: j.rm, items, tombs: j.rm.length };
}

// store: PageStore. file: arsip. opts: { verify (bawaan true: baca dan hash SEMUA lampiran yang dirujuk), signal, onProgress({ posts, total, bytes, totalBytes }) }
// Melempar ArcError untuk arsip yang rusak secara keseluruhan (kode 'bad' / 'hash' / 'abort'); cacat per postingan dilaporkan di posts[].status = 'bad'.
async function inspectArchive(store, file, opts) {
  opts = opts || {};
  if (!store || typeof store.has !== 'function' || typeof store.get !== 'function') throw new ArcError('bad', 'store tidak valid');
  const verify = opts.verify !== false, sig = opts.signal;
  const rd = await ArcReader.open(file);
  try {
    const m = rd.meta;
    if (m.kind !== KIND || m.fmt !== 1) throw new ArcError('bad', 'bukan arsip halaman (kind / fmt)');
    if (m.owner !== null && !HEX16.test(String(m.owner))) throw new ArcError('bad', 'meta: pemilik tidak valid');
    if (!Array.isArray(m.posts) || m.posts.length > POSTS_MAX || m.posts.some((i) => !HEX16.test(String(i))) || new Set(m.posts).size !== m.posts.length) throw new ArcError('bad', 'meta: daftar postingan tidak valid');
    if (m.comments !== undefined && (!m.comments || typeof m.comments !== 'object' || !Number.isSafeInteger(m.comments.items) || m.comments.items < 0 || !Number.isSafeInteger(m.comments.tombs) || m.comments.tombs < 0)) throw new ArcError('bad', 'meta: komentar tidak valid');
    const me = opts.owner != null ? opts.owner : (store.cmt ? store.cmt.owner : null);
    const posts = [], listed = new Set(), blobCache = new Map(); // blobCache: nama -> { ok, why }
    let totalBytes = 0, doneBytes = 0;
    if (verify) { const seen = new Set(); for (const e of rd.entries) if (!/^post\//.test(e.n) && !seen.has(e.n)) { seen.add(e.n); totalBytes += e.s; } } // total kasar untuk progres
    const say = (n) => { if (typeof opts.onProgress === 'function') opts.onProgress({ posts: n, total: m.posts.length, bytes: doneBytes, totalBytes }); };

    // satu lampiran: ada di arsip, ukuran sama, hash utuh, jenis isi sah. Hasil di-cache (lampiran dibagi beberapa postingan).
    async function checkBlob(b) {
      const key = b.name + ':' + b.e.size + ':' + (b.e.mime || '');
      const hit = blobCache.get(key); if (hit) return hit;
      let res;
      const info = rd.info(b.name);
      if (!info) res = { ok: false, why: 'noblob' };
      else if (info.size !== b.e.size) res = { ok: false, why: 'size' };
      else if (!verify) res = { ok: true, hash: info.hash };
      else {
        const hc = headCheck(b); let good = true;
        try {
          await rd.read(b.name, (c) => { if (good && !hc.feed(c)) good = false; doneBytes += c.length; say(posts.length); }, { signal: sig });
          res = good && hc.end() ? { ok: true, hash: info.hash } : { ok: false, why: 'content' };
        } catch (e) { if (e instanceof ArcError && e.code === 'hash') res = { ok: false, why: 'hash' }; else throw e; }
      }
      blobCache.set(key, res); return res;
    }
    // lampiran yang SUDAH ada di store: sama (ukuran + hash) = dipakai ulang; beda = bentrok
    const storeHash = new Map();
    async function storeBlob(b, hash) {
      const f = b.k === 'media' ? store.mediaPath(b.e) : b.k === 'files' ? store.filePath(b.e) : store.videoPath(b.e);
      if (!f) return 'none';
      if (fs.statSync(f).size !== b.e.size) return 'clash';
      let h = storeHash.get(f); if (!h) { h = await hashFile(f, sig); storeHash.set(f, h); }
      return h === hash ? 'reuse' : 'clash';
    }

    const newBlobs = new Map(), reuse = new Set();
    for (const id of m.posts) {
      if (sig && sig.aborted) throw new ArcError('abort', 'dibatalkan');
      listed.add('post/' + id);
      const row = { id, status: 'bad', why: null, ts: null, priv: null };
      posts.push(row);
      const info = rd.info('post/' + id);
      if (!info) { row.why = 'nopost'; continue; }
      if (info.size > POST_MAX) { row.why = 'big'; continue; }
      let c = null;
      try { c = canonPost(JSON.parse((await rd.readBuffer('post/' + id, POST_MAX)).toString('utf8')), id); } catch (e) { if (e instanceof ArcError && e.code === 'abort') throw e; c = null; }
      if (!c) { row.why = 'post'; continue; }
      row.ts = c.ts; row.priv = c.priv;
      if (c.ts > Date.now() + TS_SKEW) { row.why = 'ts'; continue; }
      const bl = blobsOf(c);
      for (const b of bl) listed.add(b.name);
      let why = null; const res = [];
      for (const b of bl) { const r = await checkBlob(b); res.push(r); if (!r.ok && !why) why = r.why; }
      if (why) { row.why = why; continue; }
      if (store.has(id)) {
        let same = false; try { same = canon(store.get(id)) === canon(c); } catch {}
        row.status = same ? 'same' : 'conflict'; row.why = same ? null : 'id';
        continue;
      }
      let clash = false; const mine = [];
      for (let i = 0; i < bl.length; i++) {
        const s = await storeBlob(bl[i], res[i].hash);
        if (s === 'clash') { clash = true; break; }
        mine.push([bl[i], s]);
      }
      if (clash) { row.status = 'conflict'; row.why = 'blob'; continue; }
      row.status = 'new';
      for (const [b, s] of mine) { if (s === 'reuse') reuse.add(b.name); else newBlobs.set(b.name, b.e.size); }
      say(posts.length);
    }
    say(posts.length);
    // komentar (5d-5): hanya dibaca bila ada; dry-run menghitung rencana PERSIS seperti tahap tulis (PageCmt.merge dry) tanpa mengubah apa pun
    const ownerMatch = m.owner === null || me === null ? null : m.owner === me;
    const cm = { present: false, status: 'none', why: null, items: 0, tombs: 0, restorable: false, plan: null };
    if (m.comments !== undefined || rd.has('comments')) {
      cm.present = true; listed.add('comments');
      try {
        const d = await loadComments(rd, sig);
        cm.status = 'ok'; cm.items = d.items; cm.tombs = d.tombs;
        cm.restorable = ownerMatch === true && !!store.cmt && store.cmt.owner === m.owner;
        if (cm.restorable) {
          const el = new Set(); for (const r of posts) if (r.status === 'new' || r.status === 'same') el.add(r.id);
          cm.plan = store.cmt.merge(d.map, d.rm, { dry: true, has: (id) => el.has(id) });
        }
      } catch (e) { if (e instanceof ArcError && e.code === 'abort') throw e; if (!e || !e.why) throw e; cm.status = 'bad'; cm.why = e.why; }
    }
    const counts = { total: posts.length, new: 0, same: 0, conflict: 0, bad: 0 };
    for (const r of posts) counts[r.status]++;
    let bytesNew = 0; for (const sz of newBlobs.values()) bytesNew += sz;
    let extra = 0; for (const e of rd.entries) if (!listed.has(e.n)) extra++;
    return {
      owner: m.owner, ownerMatch, comments: cm, created: rd.created, verified: verify,
      posts, counts, blobs: { new: newBlobs.size, reuse: reuse.size, bytesNew }, extra, size: rd.size,
    };
  } finally { await rd.close(); }
}

const fail = (why) => Object.assign(new ArcError('bad', why), { why });
// Salin satu lampiran dari arsip ke <final>.tmp (hash dan jenis isi diperiksa), lalu ganti nama. Gagal = tmp dibuang, final tidak ada.
async function copyBlob(rd, b, f, signal, onBytes) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp', hc = headCheck(b), fh = await fs.promises.open(tmp, 'w');
  let closed = false;
  try {
    await rd.read(b.name, async (c) => {
      if (!hc.feed(c)) throw fail('content');
      await fh.write(c, 0, c.length); onBytes(c.length);
    }, { signal });
    if (!hc.end()) throw fail('content');
    await fh.sync(); await fh.close(); closed = true;
    await fs.promises.rename(tmp, f);
  } catch (e) {
    if (!closed) await fh.close().catch(() => {});
    await fs.promises.unlink(tmp).catch(() => {});
    if (e instanceof ArcError && e.code === 'hash') throw fail('hash');
    throw e;
  }
}

// Tahap komentar (5d-5), SESUDAH postingan. Tidak dijalankan bila dibatalkan (impor ulang melengkapinya: postingan jadi 'same', komentar digabung).
// -> { status: 'none' | 'skipped' (why: 'abort' | 'off' | 'owner') | 'bad' (why) | 'done', items, tombs, + hitungan PageCmt.merge }
async function restoreComments(store, rd, report, opts, res) {
  const c = report.comments;
  if (!c.present) return { status: 'none' };
  const base = { items: c.items, tombs: c.tombs };
  if (res.aborted) return Object.assign({ status: 'skipped', why: 'abort' }, base);
  if (opts.comments === false || !store.cmt) return Object.assign({ status: 'skipped', why: 'off' }, base);
  if (report.ownerMatch !== true || store.cmt.owner !== report.owner) return Object.assign({ status: 'skipped', why: 'owner' }, base);
  if (c.status !== 'ok') return { status: 'bad', why: c.why };
  const d = await loadComments(rd, opts.signal), el = new Set();
  for (const id of res.imported.concat(res.same)) if (store.has(id)) el.add(id);
  return Object.assign({ status: 'done' }, base, store.cmt.merge(d.map, d.rm, { has: (id) => el.has(id) }));
}

// Tahap TULIS (5d-4). Hanya postingan berstatus 'new' pada pemeriksaan (diulang tepat sebelum menulis) yang masuk; 'same' dilewati, 'conflict' / 'bad' TIDAK PERNAH menimpa apa pun.
// Tiap postingan atomik: lampiran disalin ke .tmp (hash + jenis isi diperiksa) lalu diganti nama, baru postingan diterima store; gagal di tengah = lampiran yang baru dibuat
// untuk postingan itu dibuang, postingan lain tidak terpengaruh. Impor bisa diulang (yang sudah masuk jadi 'same'), jadi pembatalan / galat aman.
// Indeks ditulis SEKALI di akhir (aman dari crash: _load mencocokkan indeks dengan isi folder). opts: { signal, onProgress({ posts, total, bytes, totalBytes }), owner }.
// -> { imported:[id], same:[id], conflict:[{id,why}], bad:[{id,why}], failed:[{id,why}], aborted, blobs:{ written, reuse, bytes }, ownerMatch, total, comments }  (comments: lihat restoreComments; opts.comments === false = jangan pulihkan komentar)
// Galat tak terduga (disk penuh dll.) dilempar dengan e.partial = hasil sementara. Postingan BARU tidak diumumkan ke teman (impor hanya mengisi store).
async function importArchive(store, file, opts) {
  opts = opts || {};
  if (!store || typeof store.adoptPost !== 'function' || typeof store.blobFile !== 'function') throw new ArcError('bad', 'store tidak valid');
  const sig = opts.signal;
  const report = await inspectArchive(store, file, { verify: false, signal: sig, owner: opts.owner });
  const res = { imported: [], same: [], conflict: [], bad: [], failed: [], aborted: false, blobs: { written: 0, reuse: 0, bytes: 0 }, ownerMatch: report.ownerMatch, total: report.counts.total, comments: { status: report.comments.present ? 'pending' : 'none' } };
  const todo = [];
  for (const r of report.posts) {
    if (r.status === 'new') todo.push(r.id);
    else if (r.status === 'same') res.same.push(r.id);
    else res[r.status].push({ id: r.id, why: r.why });
  }
  const rd = await ArcReader.open(file), written = new Set(), hashes = new Map();
  let doneBytes = 0, err = null;
  const totalBytes = report.blobs.bytesNew;
  const say = () => { if (typeof opts.onProgress === 'function') opts.onProgress({ posts: res.imported.length, total: todo.length, bytes: doneBytes, totalBytes }); };
  try {
    for (const id of todo) {
      if (sig && sig.aborted) { res.aborted = true; break; }
      const c = canonPost(JSON.parse((await rd.readBuffer('post/' + id, POST_MAX)).toString('utf8')), id);
      if (!c) { res.bad.push({ id, why: 'post' }); continue; }
      if (store.has(id)) { // berubah sejak pemeriksaan
        let same = false; try { same = canon(store.get(id)) === canon(c); } catch {}
        if (same) res.same.push(id); else res.conflict.push({ id, why: 'id' });
        continue;
      }
      const created = [];
      let jr = false; // jurnal lampiran (5d-7) sudah ditulis untuk postingan ini
      try {
        const want = blobsOf(c).map((b) => store.blobFile(b.k, b.e)).filter((f) => !written.has(f) && !fs.existsSync(f));
        if (want.length && typeof store.journalBlobs === 'function') { store.journalBlobs(id, want); jr = true; } // crash sesudah ini: start berikutnya membuang lampiran tanpa postingan
        for (const b of blobsOf(c)) {
          const f = store.blobFile(b.k, b.e), info = rd.info(b.name);
          if (written.has(f)) continue; // sudah ditulis oleh postingan lain pada impor ini (hash-nya sudah terbukti)
          if (fs.existsSync(f)) { // sudah ada: harus identik
            let h = hashes.get(f); if (!h) { h = fs.statSync(f).size === b.e.size ? await hashFile(f, sig) : ''; hashes.set(f, h); }
            if (h !== info.hash) throw fail('blob');
            written.add(f); res.blobs.reuse++; continue;
          }
          await copyBlob(rd, b, f, sig, (n) => { doneBytes += n; say(); });
          created.push([f, b.e.size]); written.add(f);
        }
        if (store.has(id)) throw Object.assign(new Error('exists'), { exists: true }); // id muncul di store selagi lampiran disalin (tanpa await sampai adoptPost, jadi adoptPost tidak bisa lagi menolak 'sudah ada')
        store.adoptPost(c, { defer: true });
        if (jr) store.journalClear();
      } catch (e) {
        let keep = new Set();
        if (e && e.exists) { try { for (const b of blobsOf(store.get(id) || {})) keep.add(store.blobFile(b.k, b.e)); } catch {} } // lampiran yang dipakai postingan yang sudah ada tidak boleh dibuang
        for (const [f] of created) { if (keep.has(f)) continue; try { fs.unlinkSync(f); } catch {} written.delete(f); }
        if (jr) store.journalClear();
        if (e && e.exists) {
          let same = false; try { same = canon(store.get(id)) === canon(c); } catch {}
          if (same) res.same.push(id); else res.conflict.push({ id, why: 'id' });
          continue;
        }
        if (e instanceof ArcError && e.code === 'abort') { res.aborted = true; break; }
        if (e && e.why) { res.failed.push({ id, why: e.why }); continue; }
        throw e;
      }
      for (const [, sz] of created) { res.blobs.written++; res.blobs.bytes += sz; }
      res.imported.push(id); say();
    }
  } catch (e) { err = e; }
  if (res.imported.length) { try { store.flush(); } catch (e) { if (!err) err = e; } }
  if (!err && sig && sig.aborted) res.aborted = true;
  if (!err) { try { res.comments = await restoreComments(store, rd, report, opts, res); } catch (e) { err = e; } }
  await rd.close();
  if (err) { err.partial = res; throw err; }
  say();
  return res;
}

module.exports = { importArchive, inspectArchive, canonPost, blobsOf, canon, POSTS_MAX, POST_MAX };

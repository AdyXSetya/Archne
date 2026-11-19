'use strict';
// Pustaka Halaman (langkah 1a + 1b): penyimpanan postingan milik pemilik perangkat plus penyaring privasi untuk penonton. Murni lokal: tanpa jaringan, tanpa UI, tidak menyentuh Core, store.json, atau primary.json.
// Satu folder sendiri (dir), isinya:
//   index.json            = cache kecil urutan tampil { v, posts: [{ id, ts, priv }] }. BUKAN sumber kebenaran: hilang / rusak / tertinggal -> dibangun ulang dari berkas postingan saat dibuka.
//   p/<2 hex>/<id>.json   = satu berkas per postingan { v, id, ts, kind, text, priv }. Ini sumber kebenaran. Ditulis atomik (.tmp lalu rename), seperti custody-store.
// Urutan aman terhadap crash: buat = tulis berkas dulu, baru indeks; hapus = buang berkas dulu, baru indeks. Sisa yang menggantung dirapikan saat dibuka.
//   id   = 16 hex acak (hanya pemilik yang membuat, jadi cukup unik; tidak perlu berawalan ID siapa pun)
//   ts   = waktu buat (ms), dijamin naik ketat per pustaka (tidak pernah sama, tidak mundur) supaya urutan dan kursor halaman stabil
//   media = opsional, [{ id, mime, size, name, th? }] maksimal MEDIA_MAX (10, 2c), urutan larik = urutan tampil, id tidak boleh ganda. Berkasnya disalin addMedia / addMedias ke media/<id>.<ext>; remove ikut membuang semuanya.
//          Bentuk berkas tidak berubah dari 2a (larik sudah ada), jadi v tetap 1 dan postingan 1-gambar lama tetap sah.
//   files = opsional (3a-1), [{ id, name, size }] maksimal FILES_MAX (10): berkas lampiran untuk diunduh, BUKAN gambar (gambar tetap di `media`). Berkasnya disalin addFiles (3a-2) ke files/<id> (tanpa ekstensi: isi tidak dipercaya, tidak pernah dijalankan/dibuka dari sini); remove ikut membuang. Peer lama tidak mengenal field ini dan mengabaikannya (postingan tetap tampil tanpa lampiran).
//   videos = opsional (3c-1), [{ id, mime, size, name }] maksimal VIDEOS_MAX (4), mime video/mp4 | video/webm: video yang DIPUTAR dari pemilik (Range), BUKAN gambar dan BUKAN lampiran (terpisah dari `media` dan `files`, jadi peer lama tetap membaca postingan dan hanya tidak melihat video). Id tidak boleh sama dengan id gambar / lampiran di postingan yang sama. Berkasnya disalin addVideos (3c-2) ke videos/<id> (tanpa ekstensi); jenisnya ditentukan dari ekstensi DAN isi (sniffAv), bukan dari klaim. remove ikut membuang. Pembacaan potongan (3c-3) dan layanan jaringan menyusul.
//   nodl  = opsional (3b), hanya `true` yang disimpan: pemilik mematikan unduhan LAMPIRAN (files) postingan ini. Tanpa field = unduhan boleh (postingan lama tetap sah, v tetap 1). readFileFor menolak penonton selain pemilik, jadi penegakannya di sisi pemilik, bukan hanya tombol yang disembunyikan. Gambar (`media`) tidak terpengaruh: gambar ditampilkan, bukan diunduh. Diubah kapan saja lewat setDl (menulis ulang berkas postingan; indeks tidak berubah).
//   reactions.json = reaksi per postingan (4a-1, src/archne-pagerx.js): pemilik yang mencatat; tampil ke penonton hanya { rx: [{ e, n }], mine }. remove ikut membuang reaksinya.
//   kind = 'text' (jenis lain menyusul di tahap berikutnya; v dinaikkan bila bentuk berkas berubah)
//   priv = 'public' (bawaan) | 'friends'. Penyaringan untuk penonton ada di listFor / getFor / countFor (langkah 1b).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { sniffImage, pixelsOk, playKind, sniffAv, playMime } = require('./archne-mediacheck');
const { jpegSize, TH_DIM } = require('./archne-fileoffer');
const { PageRx, PageCmtRx } = require('./archne-pagerx');
const { PageCmt } = require('./archne-pagecmt');
const RX = require('./archne-reactions');
const { ek } = require('./core/archne-ecode'); // i18n (E5): galat berkunci, diterjemahkan di perbatasan (errText)

// Teks postingan TIDAK dibatasi panjangnya (keputusan pemilik: postingan bukan chat, bisa berupa cerita panjang). Hanya tidak boleh kosong.
const PAGE_PRIV = ['public', 'friends'];
const PAGE_LIST_DEF = 10, PAGE_LIST_MAX = 50;
const HEX16 = /^[0-9a-f]{16}$/;
const CURSOR = /^(\d+):([0-9a-f]{16})$/;

// ---- pembersihan teks ----
// Sama dengan chat (kontrol, pemisah baris aneh, pembalik arah dibuang; baris baru dipertahankan, tiga baris kosong jadi satu),
// kecuali ZWNJ/ZWJ (U+200C/200D) DIPERTAHANKAN: tanpa keduanya emoji majemuk dan sebagian aksara (Persia, India) rusak.
const BAD = /[\u0000-\u0009\u000b-\u001f\u007f\u0085\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
function cleanText(s) {
  if (typeof s !== 'string') throw new Error('Teks postingan tidak valid');
  const t = s.replace(/\r\n?/g, '\n').replace(BAD, ' ').split('\n').map((l) => l.replace(/ +/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!t) throw ek('e.pg.textEmpty', null, 'Teks postingan kosong');
  return t;
}
// Awalan "Gambar ke-N: " untuk daftar berisi lebih dari satu. Galat dasar (berkunci atau polos) dibungkus: `why` diterjemahkan oleh errText; code ikut diteruskan.
function nth(e, key, idPre, n) {
  if (!e || typeof e.message !== 'string') return e;
  return ek(key, { n, why: e }, idPre + n + ': ' + e.message, e.code);
}

// ---- berkas ----
const postFile = (dir, id) => path.join(dir, 'p', id.slice(0, 2), id + '.json');
function writeAtomic(f, s) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', s);
  fs.renameSync(f + '.tmp', f);
}
// Baca persis buf.length byte dari posisi pos (readSync bisa mengembalikan lebih sedikit); mengembalikan jumlah yang terbaca (< buf.length = berkas habis).
function readFull(fd, buf, pos) {
  let got = 0;
  while (got < buf.length) { const r = fs.readSync(fd, buf, got, buf.length - got, pos + got); if (r <= 0) break; got += r; }
  return got;
}
const JRNL_RE = /^(media|files|videos)[\\/][A-Za-z0-9._-]{1,200}$/;
const lsDir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
// Gambar postingan (tahap 2a-1, banyak gambar di 2c): media = [{ id, mime, size, name, th? }], maksimal MEDIA_MAX isi. Hanya metadata; berkasnya disalin addMedia.
// MEDIA_MAX = 10: 10 thumbnail x 7000 karakter = ~70 KB per postingan, jauh di bawah PG_LIST_BYTES; halaman pg_list yang melebihi PG_LIST_BYTES dipendekkan oleh pemilik (next menunjuk postingan terakhir yang ikut).
// Peer versi lama (batas 1) menganggap postingan >1 gambar cacat dan MELEWATINYA (dihitung di `skipped`), bukan menggagalkan halaman.
// normMedia: undefined = tidak ada media (sah); null = cacat (termasuk id ganda); selain itu larik bersih.
const MEDIA_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], MEDIA_MAX = 10, MEDIA_NAME_MAX = 120;
const PAGE_MEDIA_MAX = 2 * 1024 * 1024 * 1024; // batas ukuran SATU gambar (2d-6): 2 GiB. Tanpa batas total per postingan: gambar tidak pernah dimuat utuh ke memori (disalin dan dikirim berpotongan).
const COPY_CHUNK = 4 * 1024 * 1024; // potongan salin ke penyimpanan halaman; potongan PERTAMA juga kepala yang diperiksa sniffImage (jpeg dengan EXIF besar tetap muat)
const VIDEO_CHUNK = 512 * 1024; // potongan byte video (3c-3): sama dengan gambar dan lampiran; akses acak (Range / seek) = potongan dari posisi mana pun
const FILE_CHUNK = 512 * 1024; // potongan byte lampiran (3a-3): sama dengan gambar, jadi pg_media memakai satu ukuran untuk keduanya
const MEDIA_CHUNK = 512 * 1024; // potongan byte gambar per permintaan (2d): ~700 KB sebagai base64, jauh di bawah batas baris jaringan 8 MB
// Thumbnail (2b-1): th = JPEG base64 opsional di entri media, sisi terpanjang <= TH_DIM, <= PG_TH_MAX karakter (10 postingan per halaman tetap jauh di bawah 1 MB).
const PG_TH_MAX = 7000;
function thOk(t) {
  if (typeof t !== 'string' || !t || t.length > PG_TH_MAX || t.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return false;
  const sz = jpegSize(Buffer.from(t, 'base64'));
  return !!sz && sz.w <= TH_DIM && sz.h <= TH_DIM;
}
function normMediaOne(e) {
  if (!e || typeof e !== 'object' || !HEX16.test(String(e.id)) || !MEDIA_MIME.includes(e.mime)) return null;
  if (!Number.isSafeInteger(e.size) || e.size <= 0 || e.size > PAGE_MEDIA_MAX || typeof e.name !== 'string') return null;
  const name = e.name.replace(BAD, '').replace(/[\r\n\u2028\u2029]/g, '').trim();
  if (!name || name.length > MEDIA_NAME_MAX) return null;
  if (e.th !== undefined && !thOk(e.th)) return null;
  return e.th === undefined ? { id: e.id, mime: e.mime, size: e.size, name } : { id: e.id, mime: e.mime, size: e.size, name, th: e.th };
}
function normMedia(m) {
  if (m === undefined || m === null) return undefined;
  if (!Array.isArray(m) || m.length > MEDIA_MAX) return null;
  if (!m.length) return undefined;
  const out = [], seen = new Set();
  for (const e of m) {
    const n = normMediaOne(e);
    if (!n || seen.has(n.id)) return null; // satu berkas tidak boleh dirujuk dua kali dalam satu postingan
    seen.add(n.id); out.push(n);
  }
  return out;
}
// Berkas lampiran (3a-1): files = [{ id, name, size }]. Tanpa mime: berkas bisa apa saja, jadi jenisnya tidak dipercaya dan tidak disimpan (kartu berkas memutuskan dari nama di sisi penonton).
// Id tidak boleh bentrok dengan id gambar di postingan yang sama (dicek di normAttach), supaya satu id selalu menunjuk satu berkas.
// normFiles: undefined = tidak ada (sah); null = cacat (termasuk id ganda); selain itu larik bersih.
const FILES_MAX = 10, PAGE_FILE_MAX = 2 * 1024 * 1024 * 1024;
function normFileOne(e) {
  if (!e || typeof e !== 'object' || !HEX16.test(String(e.id))) return null;
  if (!Number.isSafeInteger(e.size) || e.size <= 0 || e.size > PAGE_FILE_MAX || typeof e.name !== 'string') return null;
  const name = e.name.replace(BAD, '').replace(/[\r\n\u2028\u2029]/g, '').trim();
  if (!name || name.length > MEDIA_NAME_MAX) return null;
  return { id: e.id, name, size: e.size };
}
function normFiles(f) {
  if (f === undefined || f === null) return undefined;
  if (!Array.isArray(f) || f.length > FILES_MAX) return null;
  if (!f.length) return undefined;
  const out = [], seen = new Set();
  for (const e of f) {
    const n = normFileOne(e);
    if (!n || seen.has(n.id)) return null;
    seen.add(n.id); out.push(n);
  }
  return out;
}
// Video (3c-1): videos = [{ id, mime, size, name }]. Mime hanya yang diputar pemutar bawaan (mp4/webm; sama dengan VID_FMT di mediacheck); isi sebenarnya diperiksa saat disalin (3c-2) dan oleh peminta (3c-5), bukan dipercaya dari metadata.
// Nama dan ukuran memakai aturan lampiran (normFileOne), jadi batas ukuran satu video = PAGE_VIDEO_MAX = PAGE_FILE_MAX (2 GiB).
// normVideos: undefined = tidak ada (sah); null = cacat (termasuk id ganda); selain itu larik bersih.
const VIDEOS_MAX = 4, PAGE_VIDEO_MAX = PAGE_FILE_MAX, VIDEO_MIME = ['video/mp4', 'video/webm'];
function normVideoOne(e) {
  const b = normFileOne(e);
  if (!b || !VIDEO_MIME.includes(e.mime)) return null;
  return { id: b.id, mime: e.mime, size: b.size, name: b.name };
}
function normVideos(v) {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > VIDEOS_MAX) return null;
  if (!v.length) return undefined;
  const out = [], seen = new Set();
  for (const e of v) {
    const n = normVideoOne(e);
    if (!n || seen.has(n.id)) return null;
    seen.add(n.id); out.push(n);
  }
  return out;
}
// Media + files + videos sekaligus: undefined di tiap sisi = tidak ada; null = ada yang cacat ATAU id sama muncul di dua daftar berbeda.
function normAttach(m, f, v) {
  const media = normMedia(m), files = normFiles(f), videos = normVideos(v);
  if (media === null || files === null || videos === null) return null;
  const seen = new Set();
  for (const list of [media, files, videos]) if (list) for (const e of list) { if (seen.has(e.id)) return null; seen.add(e.id); }
  return { media, files, videos };
}
const MEDIA_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const okMeta = (e) => !!e && typeof e === 'object' && HEX16.test(String(e.id)) && Number.isSafeInteger(e.ts) && e.ts > 0 && PAGE_PRIV.includes(e.priv);
// Postingan sah: id cocok dengan nama berkas (dicek pemanggil lewat argumen id), bentuk v1 jenis text.
function okPost(p, id) {
  return !!p && typeof p === 'object' && p.v === 1 && p.id === id && p.kind === 'text' && typeof p.text === 'string' && p.text.length > 0
    && Number.isSafeInteger(p.ts) && p.ts > 0 && PAGE_PRIV.includes(p.priv) && normAttach(p.media, p.files, p.videos) !== null
    && (p.nodl === undefined || p.nodl === true); // nodl hanya boleh tidak ada atau true (false tidak pernah ditulis)
}
const metaOf = (p) => ({ id: p.id, ts: p.ts, priv: p.priv });
// Urutan tampil: ts menurun (terbaru di atas), seri dipecah dengan id. Dipakai bersama oleh pengurutan dan kursor.
const after = (e, ts, id) => e.ts < ts || (e.ts === ts && e.id > id);

const mediaDir = (dir) => path.join(dir, 'media');
const filesDir = (dir) => path.join(dir, 'files');
const attFile = (dir, id) => path.join(filesDir(dir), id);
const videosDir = (dir) => path.join(dir, 'videos');
const vidFile = (dir, id) => path.join(videosDir(dir), id);
const mediaFile = (dir, e) => path.join(mediaDir(dir), e.id + MEDIA_EXT[e.mime]);

class PageStore {
  // opts.relation(peerId) -> 'owner' | 'friend' | 'public' | 'blocked' (lihat coreRelation). Tanpa relation, semua penonton dianggap 'public'
  // (paling ketat yang masih melayani: postingan Teman tidak pernah bocor karena lupa memasang relation).
  constructor(dir, opts) {
    if (typeof dir !== 'string' || !dir) throw new Error('Folder halaman tidak valid');
    if (opts && opts.relation != null && typeof opts.relation !== 'function') throw new Error('relation harus fungsi');
    this.relation = (opts && opts.relation) || null;
    this.dir = dir;
    this.idxFile = path.join(dir, 'index.json');
    fs.mkdirSync(path.join(dir, 'p'), { recursive: true });
    this.meta = new Map(); // id -> { id, ts, priv }
    this.idx = [];         // urutan tampil (terbaru dulu)
    this._load();
    this.rx = new PageRx(path.join(dir, 'reactions.json'), writeAtomic);
    this.rx.retain((id) => this.meta.has(id)); // reaksi yatim (postingan sudah tak ada) dibuang
    // 4b-1: komentar ditandatangani. Tanda tangan menutup id PEMILIK, jadi opts.ownerId (id Core ini) wajib; tanpanya komentar dimatikan (comment / commentsFor = null), bukan ditebak.
    this.cmt = opts && opts.ownerId != null ? new PageCmt(path.join(dir, 'comments.json'), opts.ownerId, writeAtomic) : null;
    if (this.cmt) this.cmt.retain((id) => this.meta.has(id)); // komentar yatim dibuang
    // 5g: reaksi komentar (cmtreactions.json). Yatim (postingan / komentarnya sudah tidak ada) dibuang; komentar dimatikan (tanpa ownerId) = tidak ada yang bisa dinilai, jadi tidak ada yang dibuang.
    this.crx = new PageCmtRx(path.join(dir, 'cmtreactions.json'), writeAtomic);
    if (this.cmt) this.crx.retain((pid, cid) => this.meta.has(pid) && this.cmt.list(pid).some((c) => c.id === cid));
  }

  // Muat indeks lalu cocokkan dengan isi folder: yang berkasnya hilang dibuang, yang berkasnya ada tapi tak terindeks dibaca dan ditambahkan.
  _load() {
    let saved = null;
    try { const j = JSON.parse(fs.readFileSync(this.idxFile, 'utf8')); if (j && j.v === 1 && Array.isArray(j.posts)) saved = j.posts; } catch {}
    for (const e of saved || []) if (okMeta(e)) this.meta.set(e.id, metaOf(e));
    for (const d of [mediaDir(this.dir), filesDir(this.dir), videosDir(this.dir)]) // sisa salinan berkas yang terputus oleh crash (gambar: 5d-7; sebelumnya hanya lampiran dan video)
      for (const n of lsDir(d)) if (n.endsWith('.tmp')) { try { fs.unlinkSync(path.join(d, n)); } catch {} }
    const onDisk = this._scan();
    this._recoverJournal(onDisk);
    let dirty = !saved;
    for (const id of [...this.meta.keys()]) if (!onDisk.has(id)) { this.meta.delete(id); dirty = true; }
    for (const id of onDisk) {
      if (this.meta.has(id)) continue;
      const p = this._read(id);
      if (p) { this.meta.set(id, metaOf(p)); dirty = true; } // berkas rusak di sini diabaikan (tidak dihapus, siapa tahu bisa dipulihkan manual)
    }
    this.idx = [...this.meta.values()].sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1));
    if (dirty) this._saveIdx();
  }
  // 5d-7: jurnal lampiran impor. Sebelum menyalin lampiran SATU postingan, impor mencatat (id postingan + berkas yang akan dibuat); dihapus setelah postingan diterima atau lampiran dibuang.
  // Crash di sela itu meninggalkan lampiran tanpa postingan: saat start, bila postingan di jurnal TIDAK ada di disk, berkas yang tercatat dibuang. Hanya jalur di media/ files/ videos/ yang disentuh.
  journalBlobs(id, files) {
    const rel = [];
    for (const f of files) { const r = path.relative(this.dir, f); if (!JRNL_RE.test(r)) throw new Error('Jalur lampiran tidak sah'); rel.push(r.split(path.sep).join('/')); }
    writeAtomic(path.join(this.dir, 'import.journal'), JSON.stringify({ v: 1, id, files: rel }));
  }
  journalClear() { try { fs.unlinkSync(path.join(this.dir, 'import.journal')); } catch {} }
  _recoverJournal(onDisk) {
    const jf = path.join(this.dir, 'import.journal');
    let j = null;
    try { j = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch {}
    if (j && j.v === 1 && /^[0-9a-f]{16}$/.test(String(j.id)) && Array.isArray(j.files) && !onDisk.has(j.id)) {
      for (const r of j.files) {
        if (typeof r !== 'string' || !JRNL_RE.test(r.split('/').join(path.sep)) || r.indexOf('..') >= 0) continue;
        const f = path.join(this.dir, r);
        try { fs.unlinkSync(f); } catch {}
        try { fs.unlinkSync(f + '.tmp'); } catch {}
      }
    }
    try { fs.unlinkSync(jf); } catch {}
  }
  // Id yang berkasnya ada. Sisa .tmp dari crash dibuang.
  _scan() {
    const ids = new Set(), root = path.join(this.dir, 'p');
    for (const seg of lsDir(root)) {
      const sd = path.join(root, seg);
      for (const name of lsDir(sd)) {
        if (name.endsWith('.tmp')) { try { fs.unlinkSync(path.join(sd, name)); } catch {} continue; }
        const m = /^([0-9a-f]{16})\.json$/.exec(name);
        if (m && m[1].slice(0, 2) === seg) ids.add(m[1]);
      }
    }
    return ids;
  }
  _read(id) {
    try { const p = JSON.parse(fs.readFileSync(postFile(this.dir, id), 'utf8')); return okPost(p, id) ? p : null; } catch { return null; }
  }
  _saveIdx() { writeAtomic(this.idxFile, JSON.stringify({ v: 1, posts: this.idx })); }

  count() { return this.idx.length; }
  has(id) { return HEX16.test(String(id)) && this.meta.has(id); }

  // Salin satu gambar ke <dir>/media/<id>.<ext> (2a-2). Isi diperiksa dari byte-nya (mediacheck), bukan dari nama/ekstensi.
  // Mengembalikan entri media { id, mime, size, name } untuk diberikan ke create({ media: [entri] }).
  // Jika create gagal / dibatalkan, pemanggil memanggil dropMedia(id) supaya salinan tidak yatim.
  // th (opsional, 2b-1): thumbnail JPEG base64 dari renderer pemilik; bila tidak sah DIABAIKAN (postingan tetap jadi, hanya tanpa thumbnail).
  addMedia(srcPath, th) {
    const job = this._beginCopy(srcPath, th);
    try { while (this._copyStep(job)); return this._endCopy(job); } catch (e) { throw this._abortCopy(job, e); }
  }
  // Salinan berpotongan (2d-6): berkas tidak pernah dimuat utuh ke memori, jadi gambar sampai PAGE_MEDIA_MAX (2 GiB) aman.
  // _beginCopy memeriksa jalur, ukuran, dan isi dari POTONGAN PERTAMA yang kemudian ditulis apa adanya (byte yang diperiksa = byte yang disalin), lalu membuka berkas sementara <id>.<ext>.tmp.
  // _copyStep menyalin satu potongan (true = masih ada), _endCopy memastikan jumlah byte dan ukuran sumber tidak berubah lalu me-rename, _abortCopy menutup dan membuang berkas sementara.
  _beginCopy(srcPath, th) {
    if (typeof srcPath !== 'string' || !srcPath) throw new Error('Jalur gambar tidak valid');
    const st = fs.statSync(srcPath);
    if (!st.isFile() || st.size <= 0) throw ek('e.pg.imgBad', null, 'Berkas gambar tidak valid');
    if (st.size > PAGE_MEDIA_MAX) throw ek('e.pg.imgBig', null, 'Gambar terlalu besar (maksimal 2 GB)');
    const job = { fd: fs.openSync(srcPath, 'r'), wfd: null, tmp: null, size: st.size, done: 0 };
    try {
      const first = Buffer.alloc(Math.min(st.size, COPY_CHUNK));
      if (readFull(job.fd, first, 0) !== first.length) throw ek('e.pg.imgChgRead', null, 'Berkas gambar berubah saat dibaca');
      const info = sniffImage(first);
      if (!info || !MEDIA_EXT[info.mime]) throw ek('e.pg.imgType', null, 'Bukan gambar yang didukung (jpg, png, webp, gif)');
      if (!pixelsOk(info)) throw ek('e.pg.imgDim', null, 'Dimensi gambar terlalu besar');
      let id; do { id = crypto.randomBytes(8).toString('hex'); } while (fs.existsSync(mediaFile(this.dir, { id, mime: info.mime })));
      const raw = path.basename(srcPath).slice(0, MEDIA_NAME_MAX), t = thOk(th) ? th : undefined;
      const entry = normMedia([{ id, mime: info.mime, size: st.size, name: raw || 'gambar', th: t }]) || normMedia([{ id, mime: info.mime, size: st.size, name: 'gambar' + MEDIA_EXT[info.mime], th: t }]);
      job.f = mediaFile(this.dir, entry[0]); job.tmp = job.f + '.tmp'; job.entry = entry[0];
      fs.mkdirSync(path.dirname(job.f), { recursive: true });
      job.wfd = fs.openSync(job.tmp, 'w');
      fs.writeSync(job.wfd, first); job.done = first.length;
    } catch (e) { throw this._abortCopy(job, e); }
    return job;
  }
  _copyStep(job) {
    if (job.done >= job.size) return false;
    const b = Buffer.alloc(Math.min(COPY_CHUNK, job.size - job.done));
    if (readFull(job.fd, b, job.done) !== b.length) throw (job.chg ? job.chg() : ek('e.pg.imgChgCopy', null, 'Berkas gambar berubah saat disalin'));
    fs.writeSync(job.wfd, b); job.done += b.length;
    return job.done < job.size;
  }
  _endCopy(job) {
    if (job.done !== job.size || fs.fstatSync(job.fd).size !== job.size) throw (job.chg ? job.chg() : ek('e.pg.imgChgCopy', null, 'Berkas gambar berubah saat disalin'));
    fs.closeSync(job.wfd); job.wfd = null; fs.closeSync(job.fd); job.fd = null;
    fs.renameSync(job.tmp, job.f);
    return job.entry;
  }
  _abortCopy(job, e) {
    for (const k of ['fd', 'wfd']) if (job[k] !== null && job[k] !== undefined) { try { fs.closeSync(job[k]); } catch {} job[k] = null; }
    if (job.tmp) try { fs.unlinkSync(job.tmp); } catch {}
    return e && e.code === 'ENOSPC' ? ek('e.io.full', null, 'Penyimpanan penuh', 'ENOSPC') : e;
  }
  // Beberapa gambar sekaligus (2c). list = [{ src, th? }] (maksimal MEDIA_MAX). SEMUA atau TIDAK SAMA SEKALI: satu gagal = yang sudah tersalin dibuang lagi, lalu melempar
  // (pesan diberi awalan "Gambar ke-N" bila lebih dari satu). Async hanya untuk memberi napas ke event loop antar gambar: addMedia menyalin sinkron (potongan 4 MB) sampai 2 GiB per gambar; di sini tiap potongan diselingi setImmediate,
  // dan proses utama juga melayani jaringan peer. Mengembalikan larik entri media (urutan = urutan list) untuk create({ media }); gagal sesudahnya = dropMedia tiap entri.
  async addMedias(list) {
    if (!Array.isArray(list) || list.length > MEDIA_MAX) throw new Error('Daftar gambar tidak valid');
    const out = [];
    try {
      for (let i = 0; i < list.length; i++) {
        if (i) await new Promise((r) => setImmediate(r));
        const it = list[i];
        try {
          if (!it || typeof it !== 'object') throw ek('e.pg.imgInvalid', null, 'Gambar tidak valid');
          const job = this._beginCopy(it.src, it.th);
          try { while (this._copyStep(job)) await new Promise((r) => setImmediate(r)); out.push(this._endCopy(job)); } catch (e2) { throw this._abortCopy(job, e2); }
        } catch (e) { throw list.length > 1 ? nth(e, 'e.pg.imgN', 'Gambar ke-', i + 1) : e; }
      }
    } catch (e) { for (const m of out) this.dropMedia(m.id); throw e; }
    return out;
  }
  // Berkas lampiran (3a-2). list = [{ src }] (maksimal FILES_MAX). Seperti addMedias: SEMUA atau TIDAK SAMA SEKALI, berpotongan (COPY_CHUNK, tidak pernah dimuat utuh), event loop diberi napas tiap potongan.
  // Tanpa sniff jenis: berkas bisa apa saja, disalin apa adanya ke files/<id> (tanpa ekstensi). Berkas kosong, bukan berkas biasa, atau > PAGE_FILE_MAX ditolak. Mengembalikan [{ id, name, size }] untuk create({ files });
  // gagal sesudahnya = dropFile tiap entri. Nama: nama dasar sumber; bila terlalu panjang, ekstensinya dipertahankan (kartu berkas memutuskan ikon dari ekstensi).
  async addFiles(list) {
    if (!Array.isArray(list) || list.length > FILES_MAX) throw ek('e.pg.fileList', null, 'Daftar berkas tidak valid');
    const out = [];
    try {
      for (let i = 0; i < list.length; i++) {
        if (i) await new Promise((r) => setImmediate(r));
        const it = list[i];
        try {
          if (!it || typeof it !== 'object') throw ek('e.pg.fileInvalid', null, 'Berkas tidak valid');
          const job = this._beginFileCopy(it.src);
          try { while (this._copyStep(job)) await new Promise((r) => setImmediate(r)); out.push(this._endCopy(job)); } catch (e2) { throw this._abortCopy(job, e2); }
        } catch (e) { throw list.length > 1 ? nth(e, 'e.pg.fileN', 'Berkas ke-', i + 1) : e; }
      }
    } catch (e) { for (const m of out) this.dropFile(m.id); throw e; }
    return out;
  }
  _beginFileCopy(srcPath) {
    if (typeof srcPath !== 'string' || !srcPath) throw new Error('Jalur berkas tidak valid');
    const st = fs.statSync(srcPath);
    if (!st.isFile()) throw ek('e.pg.notRegular', null, 'Bukan berkas biasa');
    if (st.size <= 0) throw ek('e.pg.fileEmpty', null, 'Berkas kosong');
    if (st.size > PAGE_FILE_MAX) throw ek('e.pg.fileBig', null, 'Berkas terlalu besar (maksimal 2 GB)');
    const job = { fd: fs.openSync(srcPath, 'r'), wfd: null, tmp: null, size: st.size, done: 0, chg: () => ek('e.pg.fileChgCopy', null, 'Berkas berubah saat disalin') };
    try {
      const first = Buffer.alloc(Math.min(st.size, COPY_CHUNK));
      if (readFull(job.fd, first, 0) !== first.length) throw ek('e.pg.fileChgRead', null, 'Berkas berubah saat dibaca');
      let id; do { id = crypto.randomBytes(8).toString('hex'); } while (fs.existsSync(attFile(this.dir, id)));
      let name = path.basename(srcPath);
      if (name.length > MEDIA_NAME_MAX) { const ext = path.extname(name); name = ext.length <= 20 ? name.slice(0, MEDIA_NAME_MAX - ext.length) + ext : name.slice(0, MEDIA_NAME_MAX); }
      const entry = normFiles([{ id, name, size: st.size }]) || normFiles([{ id, name: 'berkas', size: st.size }]);
      job.f = attFile(this.dir, id); job.tmp = job.f + '.tmp'; job.entry = entry[0];
      fs.mkdirSync(filesDir(this.dir), { recursive: true });
      job.wfd = fs.openSync(job.tmp, 'w');
      fs.writeSync(job.wfd, first); job.done = first.length;
    } catch (e) { throw this._abortCopy(job, e); }
    return job;
  }
  // Buang salinan berkas lampiran yang tidak dipakai postingan mana pun. Tidak melempar.
  dropFile(id) { if (HEX16.test(String(id))) try { fs.unlinkSync(attFile(this.dir, id)); } catch {} }
  // Jalur salinan sebuah entri files bila ada, selain itu null.
  filePath(e) { const n = normFiles([e]); if (!n) return null; const f = attFile(this.dir, n[0].id); return fs.existsSync(f) ? f : null; }
  // Video (3c-2). list = [{ src }] (maksimal VIDEOS_MAX). SEMUA atau TIDAK SAMA SEKALI, berpotongan (tidak pernah dimuat utuh), event loop diberi napas tiap potongan; pesan diberi awalan "Video ke-N" bila lebih dari satu.
  // Jenis: ekstensi nama berkas harus mp4/m4v/webm DAN kepala berkas (potongan pertama, yang juga disalin) harus kontainer yang cocok (playKind/sniffAv/playMime di mediacheck); mime diambil dari isi, bukan dari klaim.
  // Tanpa memeriksa isi lebih jauh (kodek, rusak di tengah): itu urusan pemutar. Mengembalikan [{ id, mime, size, name }] untuk create({ videos }); gagal sesudahnya = dropVideo tiap entri.
  async addVideos(list) {
    if (!Array.isArray(list) || list.length > VIDEOS_MAX) throw ek('e.pg.vidList', null, 'Daftar video tidak valid');
    const out = [];
    try {
      for (let i = 0; i < list.length; i++) {
        if (i) await new Promise((r) => setImmediate(r));
        const it = list[i];
        try {
          if (!it || typeof it !== 'object') throw ek('e.pg.vidInvalid', null, 'Video tidak valid');
          const job = this._beginVideoCopy(it.src);
          try { while (this._copyStep(job)) await new Promise((r) => setImmediate(r)); out.push(this._endCopy(job)); } catch (e2) { throw this._abortCopy(job, e2); }
        } catch (e) { throw list.length > 1 ? nth(e, 'e.pg.vidN', 'Video ke-', i + 1) : e; }
      }
    } catch (e) { for (const m of out) this.dropVideo(m.id); throw e; }
    return out;
  }
  _beginVideoCopy(srcPath) {
    if (typeof srcPath !== 'string' || !srcPath) throw new Error('Jalur video tidak valid');
    const st = fs.statSync(srcPath);
    if (!st.isFile()) throw ek('e.pg.notRegular', null, 'Bukan berkas biasa');
    if (st.size <= 0) throw ek('e.pg.vidEmpty', null, 'Video kosong');
    if (st.size > PAGE_VIDEO_MAX) throw ek('e.pg.vidBig', null, 'Video terlalu besar (maksimal 2 GB)');
    const base = path.basename(srcPath), pk = playKind(base);
    if (!pk || pk.kind !== 'vid') throw ek('e.pg.vidType', null, 'Bukan video yang didukung (mp4 atau webm)');
    const job = { fd: fs.openSync(srcPath, 'r'), wfd: null, tmp: null, size: st.size, done: 0, chg: () => ek('e.pg.vidChgCopy', null, 'Video berubah saat disalin') };
    try {
      const first = Buffer.alloc(Math.min(st.size, COPY_CHUNK));
      if (readFull(job.fd, first, 0) !== first.length) throw ek('e.pg.vidChgRead', null, 'Video berubah saat dibaca');
      const mime = playMime(base, sniffAv(first));
      if (!VIDEO_MIME.includes(mime)) throw ek('e.pg.vidBody', null, 'Isi berkas bukan video mp4 atau webm');
      let id; do { id = crypto.randomBytes(8).toString('hex'); } while (fs.existsSync(vidFile(this.dir, id)));
      let name = base;
      if (name.length > MEDIA_NAME_MAX) { const ext = path.extname(name); name = ext.length <= 20 ? name.slice(0, MEDIA_NAME_MAX - ext.length) + ext : name.slice(0, MEDIA_NAME_MAX); }
      const entry = normVideos([{ id, mime, size: st.size, name }]); // nama selalu memuat ekstensi (playKind lolos), jadi tak pernah kosong setelah dibersihkan
      if (!entry) throw ek('e.pg.vidInvalid', null, 'Video tidak valid');
      job.f = vidFile(this.dir, id); job.tmp = job.f + '.tmp'; job.entry = entry[0];
      fs.mkdirSync(videosDir(this.dir), { recursive: true });
      job.wfd = fs.openSync(job.tmp, 'w');
      fs.writeSync(job.wfd, first); job.done = first.length;
    } catch (e) { throw this._abortCopy(job, e); }
    return job;
  }
  // Buang salinan video yang tidak dipakai postingan mana pun. Tidak melempar.
  dropVideo(id) { if (HEX16.test(String(id))) try { fs.unlinkSync(vidFile(this.dir, id)); } catch {} }
  // Jalur salinan sebuah entri videos bila ada, selain itu null.
  videoPath(e) { const n = normVideos([e]); if (!n) return null; const f = vidFile(this.dir, n[0].id); return fs.existsSync(f) ? f : null; }
  // Buang salinan gambar yang tidak dipakai postingan mana pun (pembersihan setelah create gagal). Tidak melempar.
  dropMedia(id) {
    if (!HEX16.test(String(id))) return;
    for (const mime of MEDIA_MIME) try { fs.unlinkSync(mediaFile(this.dir, { id, mime })); } catch {}
  }
  // Jalur berkas gambar sebuah entri media bila ada, selain itu null.
  mediaPath(e) { const n = normMedia([e]); if (!n) return null; const f = mediaFile(this.dir, n[0]); return fs.existsSync(f) ? f : null; }

  // Potongan byte gambar untuk penonton (2d-1). Syarat sama dengan getFor: relasi dilihat pada tiap panggilan, postingan Teman tidak terbaca orang lain, diblokir ditolak.
  // null untuk SEMUA kegagalan (postingan tidak ada / bukan untukmu / diblokir / id media bukan milik postingan itu / berkas hilang atau ukurannya tak cocok / off di luar berkas / argumen cacat),
  // jadi jawabannya tidak membocorkan apa pun. len dipangkas ke MEDIA_CHUNK dan ke sisa berkas. Berhasil: { mime, total, off, b } (b = Buffer, tidak pernah kosong).
  readMediaFor(peerId, postId, mediaId, off, len) {
    if (typeof mediaId !== 'string' || !HEX16.test(mediaId)) return null;
    const p = this.getFor(peerId, postId);
    const e = p && p.media ? p.media.find((m) => m.id === mediaId) : null;
    const r = e ? this._readChunk(this.mediaPath(e), e.size, off, len) : null;
    return r ? { mime: e.mime, total: e.size, off: r.off, b: r.b } : null;
  }
  // Potongan byte berkas lampiran untuk penonton (3a-3). Aturan sama dengan readMediaFor (privasi dilihat tiap panggilan, SEMUA kegagalan = null, len dipangkas ke FILE_CHUNK dan ke sisa berkas),
  // tetapi hanya mencari di `files` postingan itu: id gambar tidak bisa dipakai di sini dan sebaliknya. Tanpa mime (jenisnya tidak dipercaya). Berhasil: { total, off, b }.
  readFileFor(peerId, postId, fileId, off, len) {
    if (typeof fileId !== 'string' || !HEX16.test(fileId)) return null;
    const p = this.getFor(peerId, postId);
    if (p && p.nodl && this.levelOf(peerId) !== 'owner') return null; // unduhan dimatikan (3b): hanya pemilik yang masih boleh membaca lampirannya sendiri; jawabannya null, sama dengan "tidak ada"
    const e = p && p.files ? p.files.find((m) => m.id === fileId) : null;
    const r = e ? this._readChunk(this.filePath(e), e.size, off, len) : null;
    return r ? { total: e.size, off: r.off, b: r.b } : null;
  }
  // Potongan byte video untuk penonton (3c-3). Aturan sama dengan readMediaFor (relasi dilihat tiap panggilan, SEMUA kegagalan = null dan tak terbedakan, len dipangkas ke VIDEO_CHUNK dan ke sisa berkas),
  // tetapi hanya mencari di `videos` postingan itu: id gambar / lampiran tidak bisa dipakai di sini dan sebaliknya. off boleh di mana saja (pemutar melompat). `nodl` TIDAK berlaku: video diputar, bukan diunduh (seperti gambar).
  // Berhasil: { mime, total, off, b } (mime dari metadata yang disahkan saat disalin; peminta tetap memeriksa isinya sendiri).
  readVideoFor(peerId, postId, videoId, off, len) {
    if (typeof videoId !== 'string' || !HEX16.test(videoId)) return null;
    const p = this.getFor(peerId, postId);
    const e = p && p.videos ? p.videos.find((m) => m.id === videoId) : null;
    const r = e ? this._readChunk(this.videoPath(e), e.size, off, len) : null;
    return r ? { mime: e.mime, total: e.size, off: r.off, b: r.b } : null;
  }
  // Baca satu potongan dari berkas f yang ukurannya HARUS persis size (berubah = null). null untuk argumen cacat, off di luar berkas, atau kegagalan baca apa pun.
  _readChunk(f, size, off, len) {
    if (!f || !Number.isSafeInteger(off) || off < 0 || !Number.isSafeInteger(len) || len < 1) return null;
    let fd = null;
    try {
      fd = fs.openSync(f, 'r');
      if (fs.fstatSync(fd).size !== size || off >= size) return null;
      const n = Math.min(len, MEDIA_CHUNK, size - off), b = Buffer.alloc(n);
      let got = 0;
      while (got < n) { const r = fs.readSync(fd, b, got, n - got, off + got); if (r <= 0) return null; got += r; }
      return { off, b };
    } catch { return null; } finally { if (fd !== null) try { fs.closeSync(fd); } catch {} }
  }

  // Buat postingan teks. spec: { text, priv? }. Mengembalikan postingan utuh.
  create(spec) {
    spec = spec || {};
    const text = cleanText(spec.text);
    const priv = spec.priv == null ? 'public' : spec.priv;
    if (!PAGE_PRIV.includes(priv)) throw new Error('Privasi postingan tidak valid');
    let id; do { id = crypto.randomBytes(8).toString('hex'); } while (this.meta.has(id));
    const ts = Math.max(Date.now(), this.idx.length ? this.idx[0].ts + 1 : 0);
    const att = normAttach(spec.media, spec.files, spec.videos);
    if (att === null) throw new Error('Media atau berkas postingan tidak valid');
    const media = att.media, files = att.files, videos = att.videos;
    if (media) for (const e of media) { const f = this.mediaPath(e); if (!f || fs.statSync(f).size !== e.size) throw ek('e.pg.imgNotCopied', null, 'Berkas gambar belum disalin'); }
    if (files) for (const e of files) { const f = this.filePath(e); if (!f || fs.statSync(f).size !== e.size) throw ek('e.pg.fileNotCopied', null, 'Berkas lampiran belum disalin'); }
    if (videos) for (const e of videos) { const f = this.videoPath(e); if (!f || fs.statSync(f).size !== e.size) throw ek('e.pg.vidNotCopied', null, 'Berkas video belum disalin'); }
    if (spec.nodl != null && typeof spec.nodl !== 'boolean') throw new Error('Pengaturan unduhan tidak valid');
    const post = { v: 1, id, ts, kind: 'text', text, priv };
    if (media) post.media = media;
    if (files) post.files = files;
    if (videos) post.videos = videos;
    if (spec.nodl === true) post.nodl = true;
    writeAtomic(postFile(this.dir, id), JSON.stringify(post));
    this.meta.set(id, metaOf(post)); this.idx.unshift(metaOf(post));
    try { this._saveIdx(); } catch (e) { // indeks gagal ditulis: batalkan seluruhnya supaya memori, indeks, dan berkas tetap searah
      this.meta.delete(id); this.idx.shift();
      try { fs.unlinkSync(postFile(this.dir, id)); } catch {}
      throw e;
    }
    return post;
  }

  // Baca satu postingan; null bila id tidak sah / tidak ada / berkasnya rusak. id divalidasi HEX16 dulu, jadi tidak bisa keluar dari folder.
  get(id) { return this.has(id) ? this._read(id) : null; }

  // Nyalakan / matikan unduhan lampiran sebuah postingan (3b). allow harus boolean persis. Mengembalikan nodl yang berlaku sekarang (boolean), atau null bila postingan tidak ada / rusak.
  // Berlaku seketika: readFileFor membaca berkas postingan pada tiap panggilan, jadi potongan berikutnya dari unduhan yang sedang berjalan pun ditolak. Hanya berkas postingan yang ditulis ulang (atomik); indeks tidak memuat nodl.
  setDl(id, allow) {
    if (typeof allow !== 'boolean') throw new Error('Pengaturan unduhan tidak valid');
    const p = this.get(id);
    if (!p) return null;
    if (allow) delete p.nodl; else p.nodl = true;
    writeAtomic(postFile(this.dir, id), JSON.stringify(p));
    return !allow;
  }

  // 5d-4: terima postingan JADI dari impor (bentuk kanonik dari pageimport.canonPost; ts ASLI dipertahankan, jadi disisipkan sesuai urutan, bukan di atas).
  // Lampiran-nya harus sudah ada di store dengan ukuran yang cocok (seperti create). opts.defer: indeks belum ditulis (panggil flush() sesudah satu gelombang);
  // aman dari crash karena _load mencocokkan indeks dengan isi folder. Gagal tulis indeks (tanpa defer) = batal seluruhnya, seperti create.
  adoptPost(post, opts) {
    if (!post || typeof post !== 'object' || !okPost(post, post.id)) throw new Error('Postingan tidak valid');
    if (this.meta.has(post.id)) throw ek('e.pg.postExists', null, 'Postingan sudah ada');
    for (const [k, fn] of [['media', 'mediaPath'], ['files', 'filePath'], ['videos', 'videoPath']]) {
      if (post[k]) for (const e of post[k]) { const f = this[fn](e); if (!f || fs.statSync(f).size !== e.size) throw ek('e.pg.attNotCopied', null, 'Lampiran postingan belum disalin'); }
    }
    writeAtomic(postFile(this.dir, post.id), JSON.stringify(post));
    const m = metaOf(post);
    this.meta.set(post.id, m);
    let lo = 0, hi = this.idx.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (after(this.idx[mid], post.ts, post.id)) hi = mid; else lo = mid + 1; }
    this.idx.splice(lo, 0, m);
    if (!(opts && opts.defer)) {
      try { this._saveIdx(); } catch (e) {
        this.meta.delete(post.id); this.idx.splice(lo, 1);
        try { fs.unlinkSync(postFile(this.dir, post.id)); } catch {}
        throw e;
      }
    }
    return post;
  }
  flush() { this._saveIdx(); }
  // Jalur berkas lampiran di store (ada atau belum): k = 'media' | 'files' | 'videos'.
  blobFile(k, e) { return k === 'media' ? mediaFile(this.dir, e) : k === 'files' ? attFile(this.dir, e.id) : vidFile(this.dir, e.id); }
  // 5d-4: impor dari arsip (lihat archne-pageimport.js). opts: { signal, onProgress, owner }
  importFrom(file, opts) { return require('./archne-pageimport').importArchive(this, file, opts); }

  // 5d-2: ekspor ke arsip (lihat archne-pageexport.js). opts: { ids, signal, onProgress }; pemilik komentar diambil dari store ini.
  exportTo(file, opts) { return require('./archne-pageexport').exportPages(this, file, opts); }

  // Hapus satu postingan; true bila ada yang dihapus. Berkas dibuang dulu, baru indeks.
  remove(id) {
    if (!this.has(id)) return false;
    const old = this._read(id);
    try { fs.unlinkSync(postFile(this.dir, id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.meta.delete(id);
    this.rx.drop(id);
    if (this.cmt) this.cmt.drop(id);
    this.crx.dropPost(id); // 5g
    const i = this.idx.findIndex((e) => e.id === id);
    if (i >= 0) this.idx.splice(i, 1);
    this._saveIdx();
    if (old && old.media) for (const e of old.media) this.dropMedia(e.id);
    if (old && old.videos) for (const e of old.videos) this.dropVideo(e.id);
    if (old && old.files) for (const e of old.files) this.dropFile(e.id); // berkas gambar dan lampiran dibuang terakhir: gagal di sini paling-paling meninggalkan yatim, bukan rujukan menggantung
    return true;
  }

  // Daftar terbaru dulu, berhalaman dengan kursor. opts: { limit (1..50, bawaan 10), after (kursor dari next) }.
  // Mengembalikan { items, next }: next = kursor untuk halaman berikutnya, atau null bila sudah habis. Ini tampilan PEMILIK (semua postingan).
  list(opts) { return this._page(this.idx, opts); }

  // Tingkat penonton: 'owner' | 'friend' | 'public' | 'blocked'. Id yang bukan 16 hex dianggap tidak sah (null).
  levelOf(peerId) {
    if (!HEX16.test(String(peerId))) return null;
    let r = 'public';
    if (this.relation) { try { r = this.relation(peerId); } catch { r = 'blocked'; } } // relation rusak: tutup, jangan buka
    return r === 'owner' || r === 'friend' || r === 'public' || r === 'blocked' ? r : 'blocked';
  }
  // Entri yang boleh dilihat tingkat itu. Penyaringan terjadi SEBELUM halaman dipotong, jadi jumlah, halaman, dan kursor tidak membocorkan postingan Teman.
  _visible(level) {
    if (level === 'owner') return this.idx;
    if (level === 'friend') return this.idx; // teman melihat Publik dan Teman
    if (level === 'public') return this.idx.filter((e) => e.priv === 'public');
    return [];
  }
  // Tampilan penonton. Mengembalikan null bila ditolak (diblokir / id tidak sah): pemanggil harus menjawab sama seperti "tidak ada layanan",
  // tanpa memberi tahu bahwa dia diblokir (selaras Core: dibuang diam-diam). Selain itu { items, next } seperti list().
  listFor(peerId, opts) {
    const lv = this.levelOf(peerId);
    if (!lv || lv === 'blocked') return null;
    return this._page(this._visible(lv), opts);
  }
  // Satu postingan untuk penonton. null untuk "tidak ada", "bukan untukmu", dan "diblokir" sekaligus, supaya keberadaan postingan Teman tidak bisa ditebak.
  getFor(peerId, id) {
    const lv = this.levelOf(peerId);
    if (!lv || lv === 'blocked' || !this.has(id)) return null;
    if (lv === 'public' && this.meta.get(id).priv !== 'public') return null;
    return this._read(id);
  }
  // Reaksi (4a-1). Izin = izin MELIHAT postingan (sama dengan getFor): tidak ada / bukan untukmu / diblokir / id tidak sah = null, tak terbedakan (juga SEBELUM emoji diperiksa, jadi galat emoji tidak membocorkan postingan Teman).
  _canSee(peerId, id) {
    const lv = this.levelOf(peerId);
    if (!lv || lv === 'blocked' || !this.has(id)) return false;
    return !(lv === 'public' && this.meta.get(id).priv !== 'public');
  }
  // Pasang reaksi penonton `peerId` (id terbukti; pemilik boleh bereaksi pada postingannya sendiri): e = emoji atau '' (cabut). -> { rx: [{ e, n }], mine } sesudahnya, atau null. Emoji tak sah / postingan penuh melempar Error.
  react(peerId, postId, e, now) {
    if (!this._canSee(peerId, postId)) return null;
    this.rx.set(peerId, postId, e, now);
    return this.rx.view(postId, peerId);
  }
  // Keadaan reaksi satu postingan untuk penonton (null bila tidak boleh melihat).
  reactionsFor(peerId, postId) { return this._canSee(peerId, postId) ? this.rx.view(postId, peerId) : null; }
  // 4a-2: tambahkan keadaan reaksi untuk penonton `peerId` (id TERBUKTI) ke postingan yang akan dikirim: rx = [{ e, n }] dan mine = reaksinya sendiri; kosong = tanpa field (postingan tanpa reaksi sama persis dengan dulu).
  // Pemanggil sudah memastikan penonton boleh melihat postingannya (getFor / listFor); yang keluar hanya jumlah dan reaksi penonton itu sendiri, tak pernah daftar pelaku.
  withRx(peerId, p) {
    const v = this.rx.view(p.id, peerId);
    if (!v.rx.length && !v.mine) return p;
    const o = Object.assign({}, p);
    if (v.rx.length) o.rx = v.rx;
    if (v.mine) o.mine = v.mine;
    return o;
  }
  // 4a-7, KHUSUS PEMILIK (pgMine / pgReact milik sendiri): tambahkan rx, mine (reaksi pemilik sendiri), dan who = [{ e, by: [id] }] (siapa yang bereaksi) ke postingan; tanpa reaksi = objek yang sama persis.
  // Jangan dipakai untuk penonton: wire (wirePost / wireRx) tidak membawa who, dan withRx tetap satu-satunya jalan ke peer jauh.
  ownerRx(me, p) {
    const v = this.rx.owner(p.id, me);
    if (!v.rx.length) return p;
    const o = Object.assign({}, p, { rx: v.rx, who: v.who });
    if (v.mine) o.mine = v.mine;
    return o;
  }
  // Keadaan reaksi satu postingan untuk pemilik: { rx, mine, who } atau null (tidak ada postingan).
  ownerReactionsOf(me, postId) { return this.has(postId) ? this.rx.owner(postId, me) : null; }
  // 4b-1: komentar bertanda tangan. Izin menulis = izin MELIHAT postingan (_canSee; pemilik boleh berkomentar di postingannya sendiri); tidak ada / bukan untukmu / diblokir / id tak sah / komentar dimatikan = null,
  // tak terbedakan dan SEBELUM komentarnya diperiksa (komentar cacat tidak membocorkan postingan Teman). Sesudah diterima komentar bertahan sampai pemilik menghapusnya, apa pun yang terjadi pada relasi penulis (lihat ATURAN PRIVASI di archne-pagecmt.js); komentar yang pernah dihapus pemilik ditolak (null) bila dikirim ulang persis sama. Penulis (`c.by`) HARUS pengirim terbukti (peerId) dan `c.post` HARUS postingan ini, kalau tidak melempar Error:
  // tanda tangan yang sah milik orang lain tidak boleh dititipkan lewat pengirim lain. -> 'added' | 'same'. Melempar juga untuk tanda tangan tak sah / terlalu panjang / batas (lihat archne-pagecmt.js).
  comment(peerId, postId, c, now) {
    if (!this.cmt || !this._canSee(peerId, postId)) return null;
    if (!c || typeof c !== 'object' || c.by !== peerId || c.post !== postId) throw new Error('Komentar bukan milik pengirim atau bukan untuk postingan ini');
    const r = this.cmt.add(c, now);
    return r === 'removed' ? null : r; // 5c-3: pemilik pernah menghapus komentar ini = tampak sama dengan "tidak ada / bukan untukmu" (tak membocorkan moderasi ke penulis; antrean 4c menjatuhkannya sebagai 'gone')
  }
  // Komentar satu postingan untuk penonton, tertua dulu, lengkap dengan bukti tanda tangannya (null bila tidak boleh melihat).
  commentsFor(peerId, postId) { return this.cmt && this._canSee(peerId, postId) ? this.cmt.list(postId) : null; }
  // KHUSUS PEMILIK (moderasi lokal; pemanggil sudah memastikan dia pemilik): buang satu komentar. -> true bila ada.
  removeComment(postId, cid) { const r = !!this.cmt && this.has(postId) && this.cmt.remove(postId, cid); if (r) this.crx.drop(postId, cid); return r; } // 5g: reaksinya ikut hilang
  // 5e: PENULIS menghapus komentarnya sendiri. peerId = id terbukti (tanda tangan permintaan). -> 'removed' | 'none' (komentar tidak ada ATAU bukan milik peerId: tak dibedakan) | null (tidak ada postingan / diblokir / tanpa identitas / komentar dimatikan).
  // Tidak butuh izin LIHAT (putus pertemanan tidak mengunci penulis dari komentarnya sendiri; aturan privasi 5c-3), hanya tidak diblokir. Bukti penulis = c.by (id dari kunci yang menandatangani komentar) sama dengan peerId terbukti. Id-nya dicatat sebagai nisan (PageCmt.remove), jadi kirim ulang ditolak.
  removeCommentBy(peerId, postId, cid) {
    const lv = this.levelOf(peerId);
    if (!this.cmt || !lv || lv === 'blocked' || !this.has(postId)) return null;
    const c = this.cmt.list(postId).find((x) => x.id === cid);
    if (!c || c.by !== peerId) return 'none';
    if (!this.cmt.remove(postId, cid)) return 'none';
    this.crx.drop(postId, cid); // 5g
    return 'removed';
  }
  // 5g: reaksi pada komentar. Izin = izin MELIHAT postingannya (_canSee; pemilik boleh) DAN komentarnya masih ada; selain itu null, tak terbedakan (juga SEBELUM emoji diperiksa, jadi galat emoji tidak membocorkan postingan Teman).
  // e = emoji atau '' (cabut). -> { rx: [{ e, n }], mine } sesudahnya, atau null. Emoji tak sah / komentar penuh melempar Error.
  reactComment(peerId, postId, cid, e, now) {
    if (!this.cmt || !this._canSee(peerId, postId) || !HEX16.test(String(cid)) || !this.cmt.list(postId).some((c) => c.id === cid)) return null;
    this.crx.set(peerId, postId, cid, e, now);
    return this.crx.view(postId, cid, peerId);
  }
  // Reaksi untuk sekumpulan komentar satu postingan (halaman pg_cml): { cid: { rx, mine } } hanya yang punya reaksi; null bila tidak boleh melihat. Tak pernah membawa daftar pelaku.
  commentReactionsFor(peerId, postId, cids) { return this.cmt && this._canSee(peerId, postId) ? this.crx.many(postId, cids, peerId, false) : null; }
  // KHUSUS PEMILIK (kanal lokal): sama dengan di atas tetapi dengan who = [{ e, by: [id] }] dan mine = reaksi pemilik sendiri. Postingan tidak ada = null.
  ownerCommentReactions(me, postId, cids) { return this.cmt && this.has(postId) ? this.crx.many(postId, cids, me, true) : null; }
  ownerCommentReactionsOf(me, postId, cid) { return this.cmt && this.has(postId) ? this.crx.owner(postId, cid, me) : null; }
  // Jumlah postingan yang terlihat oleh penonton (null bila ditolak). Postingan Teman tidak ikut dihitung untuk yang bukan teman.
  countFor(peerId) {
    const lv = this.levelOf(peerId);
    return !lv || lv === 'blocked' ? null : this._visible(lv).length;
  }

  _page(entries, opts) {
    opts = opts || {};
    const limit = Math.min(PAGE_LIST_MAX, Math.max(1, Number.isInteger(opts.limit) ? opts.limit : PAGE_LIST_DEF));
    let start = 0;
    if (opts.after != null) {
      const m = CURSOR.exec(String(opts.after));
      if (!m) throw new Error('Kursor tidak valid');
      const ts = Number(m[1]), id = m[2];
      start = entries.findIndex((e) => after(e, ts, id));
      if (start < 0) start = entries.length;
    }
    const slice = entries.slice(start, start + limit);
    const items = [];
    for (const e of slice) { const p = this._read(e.id); if (p) items.push(p); } // berkas rusak dilewati, tidak menggagalkan halaman
    const last = slice[slice.length - 1];
    return { items, next: slice.length && start + limit < entries.length ? last.ts + ':' + last.id : null };
  }
}

// ---- validasi jawaban dari peer jauh (1c-3) ----
// Jawaban peer TIDAK dipercaya: hanya bidang yang dikenal yang diambil, bentuknya diperiksa, dan kursornya harus selalu maju (peer nakal tidak bisa membuat pemuat berputar).
// Postingan yang bentuknya tidak dikenali (jenis baru dari versi yang lebih baru, atau rusak) DILEWATI dan dihitung di `skipped`, bukan menggagalkan seluruh halaman.
const WIRE_TEXT_MAX = 1500000; // sama dengan batas pg_get di pemilik
// Reaksi dari pemilik (4a-2; tidak dipercaya). Hiasan, bukan isi: bentuk cacat = DIABAIKAN (postingan tetap tampil tanpa reaksi), bukan alasan menyembunyikan postingan.
// rx: larik <= RX_SHOW_MAX { e (emoji kanonis), n (bulat 1..RX_MAX_REG_PER_MSG) } tanpa emoji ganda; mine: emoji kanonis, hanya bermakna bila rx sah. Bidang lain di dalam entri dibuang.
function wireRx(p) {
  if (!Array.isArray(p.rx) || !p.rx.length || p.rx.length > RX.RX_SHOW_MAX) return null;
  const seen = new Set(), rx = [];
  for (const x of p.rx) {
    if (!x || typeof x !== 'object' || typeof x.e !== 'string' || RX.cleanEmoji(x.e) !== x.e || seen.has(x.e) || !Number.isSafeInteger(x.n) || x.n < 1 || x.n > RX.RX_MAX_REG_PER_MSG) return null;
    seen.add(x.e); rx.push({ e: x.e, n: x.n });
  }
  const o = { rx };
  if (p.mine !== undefined) { if (typeof p.mine === 'string' && p.mine && RX.cleanEmoji(p.mine) === p.mine) o.mine = p.mine; else return null; }
  return o;
}
// Keadaan reaksi hasil pg_rx dari pemilik (4a-4; tidak dipercaya). Berbeda dengan hiasan di postingan: ini hasil sebuah TINDAKAN, jadi bentuk cacat = ditolak (null), bukan diabaikan.
// { rx: larik 0..RX_SHOW_MAX (aturan wireRx), mine: '' atau emoji kanonis yang juga ada di rx }. rx kosong hanya sah dengan mine ''. Mengembalikan { rx, mine } baru (bidang lain dibuang) atau null.
function wireRxState(r) {
  if (!r || typeof r !== 'object' || typeof r.mine !== 'string') return null;
  if (Array.isArray(r.rx) && !r.rx.length) return r.mine === '' ? { rx: [], mine: '' } : null;
  const w = wireRx({ rx: r.rx, mine: r.mine === '' ? undefined : r.mine });
  if (!w || (w.mine && !w.rx.some((x) => x.e === w.mine))) return null;
  return { rx: w.rx, mine: w.mine || '' };
}
// 5g: reaksi komentar dari pemilik (pg_cml, field `rx` di samping `items`; tidak dipercaya). Hiasan: bentuk cacat PER KOMENTAR = diabaikan, tidak membatalkan halamannya.
// m = { cid: { rx, mine? } }; hanya cid yang ada di `ids` (komentar halaman ini) dan 16 heks yang diambil; rx / mine lewat wireRx. Mengembalikan { cid: { rx, mine? } } baru (mungkin kosong), atau null bila m bukan objek.
function wireCmtRx(m, ids) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const want = ids instanceof Set ? ids : new Set(ids || []), out = {};
  for (const cid of Object.keys(m)) {
    if (!HEX16.test(cid) || !want.has(cid) || !m[cid] || typeof m[cid] !== 'object') continue; // nilai bukan objek (null / angka) = diabaikan; wireRx tidak boleh melihatnya
    const w = wireRx(m[cid]); if (!w) continue;
    out[cid] = w.mine ? { rx: w.rx, mine: w.mine } : { rx: w.rx };
  }
  return out;
}
function wirePost(p) {
  if (!p || typeof p !== 'object' || p.v !== 1 || p.kind !== 'text') return null;
  if (!HEX16.test(String(p.id)) || typeof p.text !== 'string' || !p.text.length || p.text.length > WIRE_TEXT_MAX) return null;
  if (!Number.isSafeInteger(p.ts) || p.ts <= 0 || !PAGE_PRIV.includes(p.priv)) return null;
  const o = { v: 1, id: p.id, ts: p.ts, kind: 'text', text: p.text, priv: p.priv };
  const att = normAttach(p.media, p.files, p.videos); if (att === null) return null; if (att.media) o.media = att.media; if (att.files) o.files = att.files; if (att.videos) o.videos = att.videos;
  const rxo = wireRx(p); if (rxo) { o.rx = rxo.rx; if (rxo.mine) o.mine = rxo.mine; } // 4a-2
  if (p.nodl === true) o.nodl = true; // 3b: hanya true yang dikenali; nilai lain (peer nakal / versi lain) dianggap tidak ada, karena pemilik sendiri yang menegakkannya
  if (p.trunc !== undefined) { if (!Number.isSafeInteger(p.trunc) || p.trunc <= p.text.length) return null; o.trunc = p.trunc; }
  return o;
}
// r = isi pg_list dari peer; req = { after?, limit } yang kuminta. Mengembalikan { items, next, count, skipped } atau null bila jawabannya cacat.
function wireList(r, req) {
  req = req || {};
  if (!r || typeof r !== 'object' || !Array.isArray(r.items) || r.items.length > PAGE_LIST_MAX) return null;
  if (!Number.isSafeInteger(r.count) || r.count < 0) return null;
  const lim = Math.min(PAGE_LIST_MAX, Math.max(1, Number.isInteger(req.limit) ? req.limit : PAGE_LIST_DEF));
  if (r.items.length > lim) return null; // lebih banyak dari yang kuminta
  const items = [];
  let skipped = 0, prev = req.after != null ? CURSOR.exec(String(req.after)) : null;
  prev = prev ? { ts: Number(prev[1]), id: prev[2] } : null;
  for (const raw of r.items) {
    const p = wirePost(raw);
    if (!p) { skipped++; continue; }
    if (prev && !after(p, prev.ts, prev.id)) return null; // urutan salah / ulang / sebelum kursor
    items.push(p); prev = p;
  }
  let next = null;
  if (r.next != null) {
    const m = typeof r.next === 'string' ? CURSOR.exec(r.next) : null;
    if (!m) return null;
    const c = { ts: Number(m[1]), id: m[2] };
    const from = req.after != null ? CURSOR.exec(String(req.after)) : null;
    if (from && !after(c, Number(from[1]), from[2])) return null; // kursor harus maju dari yang kuminta
    if (items.length && after(items[items.length - 1], c.ts, c.id)) return null; // dan tidak boleh mundur ke belakang item terakhir
    next = r.next;
  }
  return { items, next, count: r.count, skipped };
}

// Penghubung ke Core (tanpa mengubah Core): core.id, core.isBlocked(id), core.fstate(id) === 'ok' (pertemanan saling setuju; 'in'/'out' belum dihitung teman).
function coreRelation(core) {
  return (id) => {
    if (id === core.id) return 'owner';
    if (core.isBlocked(id)) return 'blocked';
    return core.fstate(id) === 'ok' ? 'friend' : 'public';
  };
}

// ---- tanda tangan permintaan (1c-3b): murni, tanpa jaringan ----
// Masalah yang ditutup: `hi.id` di permintaan hanyalah klaim. Hello disiarkan terbuka di LAN, jadi siapa pun bisa menyalin hello seorang teman dan mengaku sebagai dia.
// Peminta menandatangani (kunci identitasnya) tag + id PEMILIK + waktu + nonce + isi permintaan; pemilik memeriksa dengan kunci publik dari hello, yang harus cocok dengan id
// (id = hash kunci publik, jadi kunci itu tidak bisa diganti). Id pemilik ikut ditandatangani: permintaan untuk A tidak bisa diputar ulang ke B.
// Yang TIDAK ditutup: jalur belum dienkripsi, jadi penyadap pasif di jalur jaringan tetap bisa membaca isi postingan Teman. Tanda tangan hanya menutup PEMALSUAN identitas.
const PGTAG = 'archne-pg1:', PG_SKEW = 120e3; // toleransi selisih jam (ms) antara peminta dan pemilik
// Bentuk 4 bidang tetap untuk pg_list / pg_get (tanda tangan peer lama tetap sah). pg_media (2d-2) menambah mid, off, len di belakangnya, jadi tidak satu bidang pun bisa diubah di jalan.
const pgCanon = (o) => {
  const a = [o.t, o.after == null ? null : o.after, o.limit == null ? null : o.limit, o.id == null ? null : o.id];
  if (o.mid != null || o.off != null || o.len != null) a.push(o.mid == null ? null : o.mid, o.off == null ? null : o.off, o.len == null ? null : o.len);
  if (o.t === 'pg_rx') a.push(o.e == null ? null : o.e); // 4a-3: emoji ikut ditandatangani (id sudah di bidang ke-4), jadi tidak bisa diganti di jalan
  if (o.t === 'pg_cmt') a.push(o.c && typeof o.c === 'object' && typeof o.c.id === 'string' ? o.c.id : null); // 4b-2: id komentar (= hash tanda tangan penulisnya, yang menutup teks) ikut ditandatangani; pg_cml cukup dengan id / after / limit
  if (o.t === 'pg_rc') a.push(o.cid == null ? null : o.cid, o.e == null ? null : o.e); // 5g: reaksi komentar: id komentar DAN emoji ikut ditandatangani (id postingan sudah di bidang ke-4), jadi tidak satu pun bisa diganti di jalan
  if (o.t === 'pg_cmd') a.push(o.cid == null ? null : o.cid); // 5e: id komentar yang dihapus ikut ditandatangani penulis (id postingan sudah di bidang ke-4), jadi tidak bisa diganti di jalan
  return JSON.stringify(a);
};
const pgIdFromPub = (pub) => crypto.createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16);
// Kembalikan salinan `obj` yang memuat { ts, n, sig }. now / nonce hanya untuk tes.
function pgSignReq(privKey, ownerId, obj, now, nonce) {
  const o = Object.assign({}, obj, { ts: now == null ? Date.now() : now, n: nonce || crypto.randomBytes(8).toString('hex') });
  o.sig = crypto.sign(null, Buffer.from(PGTAG + ownerId + ':' + o.ts + ':' + o.n + ':' + pgCanon(o)), privKey).toString('base64');
  return o;
}
// Periksa permintaan. Hasil: { ok:true, rid, key } (key = rid:nonce untuk cache anti-putar-ulang oleh pemanggil) | { ok:false, err:'auth' | 'time' }.
// Urutan: bentuk -> id cocok kunci -> jam -> tanda tangan. Hasilnya tidak bergantung pada relasi apa pun (blokir / teman), jadi tidak bisa dipakai menebaknya.
function pgVerifyReq(o, ownerId, now) {
  const AUTH = { ok: false, err: 'auth' };
  try {
    const hi = o && o.hi;
    if (!hi || typeof hi.pub !== 'string' || hi.pub.length > 200 || typeof hi.id !== 'string' || !HEX16.test(hi.id) || pgIdFromPub(hi.pub) !== hi.id) return AUTH;
    if (typeof o.sig !== 'string' || o.sig.length > 200 || typeof o.n !== 'string' || !HEX16.test(o.n) || !Number.isSafeInteger(o.ts)) return AUTH;
    const key = crypto.createPublicKey({ key: Buffer.from(hi.pub, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, Buffer.from(PGTAG + ownerId + ':' + o.ts + ':' + o.n + ':' + pgCanon(o)), key, Buffer.from(o.sig, 'base64'))) return AUTH;
    if (Math.abs((now == null ? Date.now() : now) - o.ts) > PG_SKEW) return { ok: false, err: 'time' }; // tanda tangan sah tetapi basi / jam beda: kasih tahu, jangan diam
    return { ok: true, rid: hi.id, key: hi.id + ':' + o.n };
  } catch { return AUTH; }
}

module.exports = { okPost, normAttach, COPY_CHUNK, normMedia, normFiles, normVideos, VIDEOS_MAX, PAGE_VIDEO_MAX, VIDEO_MIME, FILES_MAX, PAGE_FILE_MAX, MEDIA_MIME, MEDIA_MAX, MEDIA_CHUNK, FILE_CHUNK, VIDEO_CHUNK, PAGE_MEDIA_MAX, pgSignReq, pgVerifyReq, PGTAG, PG_SKEW, PageStore, cleanText, coreRelation, wirePost, wireList, wireRxState, wireCmtRx, WIRE_TEXT_MAX, PAGE_PRIV, PAGE_LIST_DEF, PAGE_LIST_MAX };

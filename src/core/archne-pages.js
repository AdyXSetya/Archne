'use strict';
// src/core/archne-pages.js — Halaman: menyambungkan PageStore ke Core (1c-1), melayani permintaan dari peer jauh (1c-2, sisi PEMILIK), dan meminta halaman peer jauh (1c-3, sisi PEMINTA). IPC di src/archne-ipc-pages.js (1c-4a); UI: tombol di profil + layar (1c-4b) dan feed berhalaman + kotak tulis (1c-4c), renderer/js/archne-pages.js.
// Penyimpanan di <dataDir>/pages (folder sendiri; BUKAN bagian store.json / primary.json, jadi tidak ikut tersimpan atau termigrasi bersama store).
// Dibuat malas (saat pertama dipakai), jadi Core yang tidak memakai Halaman tidak membuat folder apa pun. Satu instance per Core.
// Penyaring privasi memakai relasi LANGSUNG dari Core pada tiap panggilan (coreRelation: id sendiri = pemilik, diblokir mengalahkan teman, hanya fstate 'ok' = teman),
// jadi memutus pertemanan atau memblokir berlaku seketika, tanpa cache.
//
// Tanda tangan permintaan (1c-3b): `hi.id` hanyalah klaim (hello disiarkan terbuka di LAN), jadi tiap permintaan membawa { ts, n, sig } = tanda tangan kunci identitas peminta atas
//   'archne-pg1:' + id PEMILIK + ts + n + [t, after, limit, id]. Pemilik (_pgGate) memeriksa: kunci di hello cocok dengan id, jam +-2 menit, tanda tangan sah, nonce belum pernah dipakai.
//   Gagal = { ok:false, err:'auth' | 'time' | 'busy' } yang tidak bergantung pada relasi (blokir / teman), jadi tidak bisa dipakai menebaknya. Blokir dan teman memakai id TERBUKTI.
//   Belum ada enkripsi jalur: penyadap pasif di jaringan tetap bisa membaca isi Teman; tanda tangan hanya menutup PEMALSUAN identitas dan putar ulang.
// Protokol (satu baris JSON per arah, lewat _handle -> _pgGate -> _pgHandle):
//   { t:'pg_list', after?, limit? } -> { t:'pg_list', ok:true, items:[post], next, count }
//        items = halaman terbaru-dulu yang boleh dilihat peminta; next = kursor halaman berikutnya (atau null); count = jumlah postingan yang terlihat olehnya.
//        Teks lebih dari PG_PREVIEW karakter dipotong dan diberi `trunc` (= panjang asli); ambil utuh lewat pg_get.
//        Postingan bergambar membawa `media: [{id, mime, size, name, th?}]` sampai 10 gambar (metadata + thumbnail kecil; 2a-4, 2c); isi gambar penuh tidak ikut di balasan ini (di-stream di 2d).
//        Satu jawaban dibatasi ~PG_LIST_BYTES byte (baris jaringan maksimal 8 MB): bila lebih, halaman dipendekkan dan next menunjuk ke postingan terakhir yang ikut.
//   { t:'pg_get', id }              -> { t:'pg_get', ok:true, post }  (post = null untuk "tidak ada", "bukan untukmu", dan "diblokir" sekaligus)
//        Teks lebih dari PG_GET_CHARS karakter dipotong dan diberi `trunc` (batas aman satu baris jaringan; cerita sepanjang itu tidak diharapkan).
//   { t:'pg_media', id, mid, off, len } -> { t:'pg_media', ok:true, chunk:{ mime, total, off, b64 } | null }  (2d-2) potongan byte gambar ATAU (3a-4) berkas lampiran ATAU (3c-4) video `mid` milik postingan `id` (gambar dan video: chunk membawa `mime`; lampiran: tanpa `mime`; video tetap terbaca walau `nodl`), <= MEDIA_CHUNK byte (len dipangkas); chunk null = tidak ada / bukan untukmu / diblokir / off di luar berkas.
//        Tanda tangan menutup id, mid, off, len. Terlalu cepat (> PG_MEDIA_RATE potongan per detik per peer) = { ok:false, err:'busy' }. Pemilik tanpa 'pgm' di caps tidak mengenal t ini.
//   { t:'pg_rx', id, e }            -> { t:'pg_rx', ok:true, r:{ rx:[{e,n}], mine } | null }  (4a-3, src/core/archne-pages-rx.js) pasang keadaan reaksi penonton (e = emoji, '' = cabut; idempotent); r = keadaan sesudahnya, atau null = tidak ada / bukan untukmu / diblokir / postingan penuh, tak dibedakan. Tanda tangan menutup id DAN e. Caps 'pgr'.
//        Salah bentuk (id / emoji) = 'bad', DICEK SEBELUM relasi; terlalu cepat (RX_RATE_RECV per peer, ditambah batas global) = 'busy'. Nonce di penampung sendiri.
//   { t:'pg_rc', id, cid, e }       -> { t:'pg_rc', ok:true, r:{ rx:[{e,n}], mine } | null }  (5g, src/core/archne-pages-rx.js, caps 'pgk') reaksi penonton pada SATU KOMENTAR; aturan sama dengan pg_rx. Tanda tangan permintaan menutup id, cid, dan e. r null = postingan tak terlihat / komentar tidak ada / diblokir / komentar penuh: tak dibedakan.
//   { t:'pg_cmt', id, c } / { t:'pg_cml', id, after?, limit? } (4b-2, src/core/archne-pages-cmt.js): komentar bertanda tangan penulis; nonce di penampung sendiri (_pgSeenC); caps 'pgc'.
//   5f: pg_cmt boleh membawa c.re (id komentar induk; balasan / pohon); caps 'pgt'. Tanda tangan permintaan tetap menutup c.id, dan c.id = hash tanda tangan penulis yang menutup `re`.
//   { t:'pg_cmd', id, cid } (5e, src/core/archne-pages-cmt.js): penulis menghapus komentarnya sendiri; permintaan ditandatangani penulis (tanda tangan menutup id postingan DAN cid); nonce di penampung _pgSeenC; caps 'pgd'.
//   Salah bentuk (kursor / id) -> { ok:false, err:'bad' }, DICEK SEBELUM relasi dilihat, jadi jawabannya sama untuk semua peminta.
// Diblokir, tanpa identitas, atau pemilik belum punya halaman = jawaban KOSONG yang sama persis (ok:true, tanpa item, count 0), tidak ada yang menandakan diblokir.
// Permintaan dari orang asing tidak membuat folder halaman bila pemilik belum pernah memakai Halaman.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PageStore, coreRelation, wireList, wirePost, wireRxState, pgSignReq, pgVerifyReq, PG_SKEW, WIRE_TEXT_MAX, PAGE_LIST_DEF, PAGE_LIST_MAX, MEDIA_CHUNK, FILE_CHUNK, MEDIA_MIME, PAGE_MEDIA_MAX, VIDEO_MIME, PAGE_VIDEO_MAX } = require('../archne-pagestore');
const RX = require('../archne-reactions');
const { safeName } = require('../archne-fileoffer');
const { sniffImage, pixelsOk, sniffAv } = require('../archne-mediacheck');
const { HEX16 } = require('./archne-constants');

const PG_LIST_BYTES = 1e6, PG_PREVIEW = 20000, PG_GET_CHARS = WIRE_TEXT_MAX;
const PG_SEEN_MAX = 20000; // nonce yang diingat (anti putar ulang); penuh = tolak 'busy', bukan membuang yang lama
// pg_media (2d-2): satu gambar 2 GB = ~4100 potongan bertanda tangan, jadi nonce-nya diingat di penampung SENDIRI (bukan menghabiskan jatah pg_list/pg_get semua peer).
// Satu peer paling banyak PG_MEDIA_RATE potongan per PG_MEDIA_WIN ms (= ~24 MB/dtk) supaya bacaan berkas tidak memonopoli proses pemilik; ~11,6 ribu nonce per peer per jendela tanda tangan, jadi PG_SEEN_MEDIA_MAX cukup untuk ~8 peer yang menguras penuh.
const PG_SEEN_MEDIA_MAX = 100000, PG_MEDIA_RATE = 48, PG_MEDIA_WIN = 1000;
const PG_SEEN_RX_MAX = 20000; // nonce pg_rx (4a-3) dan pg_cmt / pg_cml (4b-2, penampung masing-masing), terpisah dari pg_list / pg_get dan pg_media
const PG_T_LIST = 10000, PG_T_GET = 20000; // batas waktu peminta (ms); jawaban daftar <= ~1 MB, pg_get bisa sampai beberapa MB
// Peminta gambar (2d-3): token sendiri (_ptok), terpisah dari token media chat (_mtok); dibaca penyaji media lewat mediaSrcRead.
const PG_T_MEDIA = 15000, PG_PTOK_MAX = 16, PG_PTOK_TTL = 2 * 3600e3, PG_BLOCKS_KEEP = 2, PG_BUSY_TRIES = 4, PG_BUSY_WAIT = 300;
// Video (3c-5): pemutar melompat (seek) dan sering membaca ekor berkas (moov mp4) lalu kembali ke awal, jadi cache blok video lebih besar (6 x 512 KB = 3 MB per token, paling banyak 16 token) dan LRU.
const PG_VBLOCKS_KEEP = 6, VID_SNIFF = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
const PG_DL_MAX = 3; // unduhan lampiran berjalan bersamaan per Core
// Batas stream video bersamaan (3d-b1), hanya video dari pemilik JAUH (video sendiri dibaca dari disk lokal, tanpa jaringan). Stream "aktif" = token video yang dibuat atau dibaca penyaji dalam PG_VSTREAM_IDLE ms terakhir; video yang dijeda berhenti membaca dan keluar dari hitungan sendiri.
// Paling banyak pgStreamMax aktif per Core dan pgStreamPeer per pemilik; lewat = 'streams' (pageMedia saja). Token yang SUDAH ada tidak pernah ditolak bacaannya (video yang sedang jalan tidak dipotong); gambar tidak dibatasi (kecil, satu per satu).
const PG_VSTREAM_IDLE = 15000; // 5a-2: batas Core / pemilik bukan konstanta lagi: pengaturan pgStreamMax / pgStreamPeer (bawaan 3 / 2), dibaca tiap panggilan lewat _pgStreamLimits() (archne-settings.js)
function pgStreams(map, peerId, now) {
  let all = 0, own = 0;
  if (map) for (const v of map.values()) if (v.vid && !v.self && v.exp > now && now - v.last < PG_VSTREAM_IDLE) { all++; if (v.peerId === peerId) own++; }
  return { all, own };
}
const B64 = /^[A-Za-z0-9+/]*={0,2}$/, B64_MAX = Math.ceil(MEDIA_CHUNK / 3) * 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { pgErr } = require('./archne-pgerr');
const { ek } = require('./archne-ecode');
const CURSOR = /^\d+:[0-9a-f]{16}$/;
// Potong teks di n karakter (tidak memutus pasangan surrogate); beri tahu panjang asli lewat `trunc`.
function clip(p, n) {
  if (p.text.length <= n) return p;
  let k = n;
  const c = p.text.charCodeAt(k - 1);
  if (c >= 0xd800 && c <= 0xdbff) k--;
  return Object.assign({}, p, { text: p.text.slice(0, k), trunc: p.text.length });
}

module.exports = {
  _pagesDir() { return path.join(this.opts.dataDir, 'pages'); },
  // 5a-1: PageStore untuk MELAYANI peer jauh, atau null = "tidak ada". Null bila pemilik menonaktifkan layanan (pengaturan pagesServe) ATAU belum pernah memakai Halaman (jangan membuat folder hanya karena ada yang bertanya).
  // Dibaca tiap panggilan, jadi berlaku seketika. Jawabannya SAMA dengan pemilik tanpa halaman, sehingga peminta tidak bisa membedakan "dimatikan" dari "kosong". Jalur pemilik sendiri (peerId = id sendiri) tidak lewat sini.
  _pgServePs() {
    if (this._settings && this._settings.pagesServe === false) return null;
    return (this._pages || fs.existsSync(this._pagesDir())) ? this.pageStore() : null;
  },
  pageStore() {
    if (!this._pages) this._pages = new PageStore(this._pagesDir(), { relation: coreRelation(this), ownerId: this.id });
    return this._pages;
  },
  // Gerbang (1c-3b): identitas peminta HARUS dibuktikan dengan tanda tangan; `hi.id` saja tidak dipercaya. Tanpa bukti sah = {ok:false, err:'auth'|'time'|'busy'}, sama untuk semua peminta.
  // Sesudah lolos, rid yang diteruskan ke _pgHandle adalah id terbukti, jadi blokir dan teman memakai identitas yang tak bisa dipalsukan.
  _pgGate(o) {
    const v = pgVerifyReq(o, this.id);
    if (!v.ok) return { t: o.t, ok: false, err: v.err };
    const now = Date.now(), media = o.t === 'pg_media', rx = o.t === 'pg_rx' || o.t === 'pg_rc', cm = o.t === 'pg_cmt' || o.t === 'pg_cml' || o.t === 'pg_cmd';
    const seen = media ? (this._pgSeenM || (this._pgSeenM = new Map())) : rx ? (this._pgSeenR || (this._pgSeenR = new Map())) : cm ? (this._pgSeenC || (this._pgSeenC = new Map())) : (this._pgSeen || (this._pgSeen = new Map())); // pg_rx (4a-3) punya penampung nonce sendiri: banjir reaksi tidak membuat pg_list / pg_get 'busy'
    if (seen.size) for (const [k, exp] of seen) { if (exp > now) break; seen.delete(k); } // Map berurutan menurut waktu masuk, kedaluwarsa seragam: cukup gugurkan dari depan
    if (seen.has(v.key)) return { t: o.t, ok: false, err: 'auth' }; // putar ulang
    if (seen.size >= (media ? PG_SEEN_MEDIA_MAX : rx || cm ? PG_SEEN_RX_MAX : PG_SEEN_MAX)) return { t: o.t, ok: false, err: 'busy' };
    seen.set(v.key, now + 2 * PG_SKEW + 1000); // tanda tangan hanya sah +-PG_SKEW, jadi 2x itu cukup
    return this._pgHandle(o, v.rid);
  },
  // Pembatas laju pg_media per peer (jendela tetap). Tanpa identitas (rid null) = satu ember bersama.
  _pgMediaOk(rid) {
    const now = Date.now(), m = this._pgMediaRate || (this._pgMediaRate = new Map()), k = rid || '-';
    if (m.size > 2000) for (const [id, e] of m) if (now - e.t0 >= PG_MEDIA_WIN) m.delete(id);
    let e = m.get(k);
    if (!e || now - e.t0 >= PG_MEDIA_WIN) { e = { t0: now, n: 0 }; m.set(k, e); }
    return ++e.n <= PG_MEDIA_RATE;
  },
  // Tanda tangani permintaan ke pemilik `ownerId`.
  _pgSign(ownerId, obj) { return pgSignReq(this.privKey, String(ownerId), obj); },
  // Layani pg_list / pg_get dari peer (rid = id peminta dari hello, atau null). Selalu mengembalikan balasan (tidak pernah null).
  _pgHandle(o, rid) {
    if (o.t === 'pg_rx') return this._pgRxHandle(o, rid); // 4a-3, src/core/archne-pages-rx.js
    if (o.t === 'pg_rc') return this._pgRcHandle(o, rid); // 5g, src/core/archne-pages-rx.js
    if (o.t === 'pg_cmt' || o.t === 'pg_cml' || o.t === 'pg_cmd') return this._pgCmtHandle(o, rid); // 4b-2, src/core/archne-pages-cmt.js
    const isList = o.t === 'pg_list', isMedia = o.t === 'pg_media';
    const bad = { t: o.t, ok: false, err: 'bad' };
    if (isMedia) {
      if (typeof o.id !== 'string' || !HEX16.test(o.id) || typeof o.mid !== 'string' || !HEX16.test(o.mid) || !Number.isSafeInteger(o.off) || o.off < 0 || !Number.isSafeInteger(o.len) || o.len < 1) return bad;
      if (!this._pgMediaOk(rid)) return { t: o.t, ok: false, err: 'busy' }; // laju dihitung per id TERBUKTI dan sama untuk semua relasi (tidak membocorkan blokir)
      const ps = this._pgServePs();
      // mid bisa id gambar (chunk membawa mime), id berkas lampiran (3a-4, chunk TANPA mime), atau id video (3c-4, chunk membawa mime video). Id ketiganya tidak pernah sama dalam satu postingan (normAttach), jadi urutan mencari tidak mengubah hasil.
      let chunk = null;
      if (ps) {
        const c = ps.readMediaFor(rid, o.id, o.mid, o.off, o.len);
        if (c) chunk = { mime: c.mime, total: c.total, off: c.off, b64: c.b.toString('base64') };
        else {
          const f = ps.readFileFor(rid, o.id, o.mid, o.off, o.len);
          if (f) chunk = { total: f.total, off: f.off, b64: f.b.toString('base64') };
          else { const v = ps.readVideoFor(rid, o.id, o.mid, o.off, o.len); if (v) chunk = { mime: v.mime, total: v.total, off: v.off, b64: v.b.toString('base64') }; }
        }
      }
      return { t: 'pg_media', ok: true, chunk }; // null = tidak ada / bukan untukmu / diblokir / rentang di luar berkas, tak dibedakan
    }
    if (isList) { if (o.after != null && !(typeof o.after === 'string' && CURSOR.test(o.after))) return bad; }
    else if (typeof o.id !== 'string' || !HEX16.test(o.id)) return bad;
    const ps = this._pgServePs(); // jangan membuat folder hanya karena ada yang bertanya
    if (!isList) {
      const p = ps ? ps.getFor(rid, o.id) : null;
      return { t: 'pg_get', ok: true, post: p ? ps.withRx(rid, clip(p, PG_GET_CHARS)) : null };
    }
    const empty = { t: 'pg_list', ok: true, items: [], next: null, count: 0 };
    if (!ps) return empty;
    const pg = ps.listFor(rid, { after: o.after == null ? undefined : o.after, limit: Number.isInteger(o.limit) ? o.limit : undefined });
    if (!pg) return empty; // diblokir / tanpa identitas
    const items = [];
    let bytes = 0, cut = false;
    for (const p of pg.items) {
      const w = ps.withRx(rid, clip(p, PG_PREVIEW)), n = Buffer.byteLength(JSON.stringify(w));
      if (items.length && bytes + n > PG_LIST_BYTES) { cut = true; break; }
      items.push(w); bytes += n;
    }
    const last = items[items.length - 1];
    return { t: 'pg_list', ok: true, items, next: cut ? last.ts + ':' + last.id : pg.next, count: ps.countFor(rid) };
  },

  // ---- sisi PEMINTA (1c-3): stateless dan tanpa cache; tiap panggilan satu koneksi pendek ke pemilik ----
  // Apakah halaman peer ini bisa dibuka sekarang? { ok:true } atau { ok:false, why } dengan why: 'self' | 'peer' | 'blocked' | 'offline' | 'old'.
  // Tombol "Halaman" di profil cukup mengikuti ok (pemilik online dan mendukung); tidak ada cache offline. Tidak menyentuh jaringan.
  pageAvail(peerId) {
    const id = String(peerId);
    if (id === this.id) return { ok: false, why: 'self' };
    const p = HEX16.test(id) ? this.peers.get(id) : null;
    if (!p) return { ok: false, why: 'peer' };
    if (this.isBlocked(p.id)) return { ok: false, why: 'blocked' };
    if (!this.isOnline(p)) return { ok: false, why: 'offline' };
    if (Array.isArray(p.caps) && !p.caps.includes('pg')) return { ok: false, why: 'old' }; // hello-nya sudah dikenal tanpa 'pg': versi lama, jangan menunggu timeout
    return { ok: true };
  },
  // Satu permintaan ke pemilik. Melempar Error ber-`code`: self | peer | blocked | offline | old | bad | auth | time | busy | proto. Permintaan selalu ditandatangani (1c-3b). Tidak ada jawaban / koneksi putus = 'offline'.
  async _pgAsk(peerId, obj, timeout) {
    const a = this.pageAvail(peerId);
    if (!a.ok) throw pgErr(a.why);
    const r = await this._request(this.peers.get(String(peerId)), this._pgSign(peerId, obj), timeout);
    if (!r) throw pgErr('offline');
    if (r.t !== obj.t) throw pgErr('proto');
    if (r.ok === false) throw pgErr(['bad', 'auth', 'time', 'busy'].includes(r.err) ? r.err : 'proto');
    if (r.ok !== true) throw pgErr('proto');
    return r;
  },
  // Daftar postingan peer (terbaru dulu, berhalaman). opts: { after (kursor dari next), limit (1..50, bawaan 10) }.
  // Mengembalikan { items, next, count, skipped }. Peminta tidak bisa membedakan "diblokir" dari "belum punya halaman": keduanya items kosong, count 0.
  // Pemilik offline di tengah gulir: lempar 'offline'; ulangi dengan kursor yang sama (tanpa status di pemilik) begitu dia kembali.
  async pageList(peerId, opts) {
    opts = opts || {};
    const req = { t: 'pg_list' };
    if (opts.after != null) { if (typeof opts.after !== 'string' || !CURSOR.test(opts.after)) throw pgErr('bad'); req.after = opts.after; }
    const limit = Number.isInteger(opts.limit) ? Math.min(PAGE_LIST_MAX, Math.max(1, opts.limit)) : PAGE_LIST_DEF;
    req.limit = limit;
    const r = wireList(await this._pgAsk(peerId, req, PG_T_LIST), { after: req.after, limit });
    if (!r) throw pgErr('proto');
    if (req.after == null && !opts.quiet) this._pgnSeen(peerId, r); // 5b-2: feed dibuka = sudah dilihat (quiet = pertanyaan lencana latar belakang)
    return r;
  },
  // Satu postingan utuh. null = tidak ada / bukan untukku / diblokir (tak bisa dibedakan, memang disengaja). Teks > 1,5 juta karakter datang terpotong (lihat `trunc`).
  async pagePost(peerId, id) {
    if (typeof id !== 'string' || !HEX16.test(id)) throw pgErr('bad');
    const r = await this._pgAsk(peerId, { t: 'pg_get', id }, PG_T_GET);
    if (r.post == null) return null;
    const p = wirePost(r.post);
    if (!p || p.id !== id) throw pgErr('proto');
    return p;
  },

  // Reaksi (4a-4). pageReact(peerId, postId, e) -> { rx, mine } SESUDAH perubahan, atau null (tidak ada / bukan untukku / diblokir / postingan penuh: tak dibedakan, seperti pagePost).
  // e = emoji atau '' (cabut); dikanonkan dulu, yang tak sah = 'bad' tanpa jaringan. peerId = id sendiri: PageStore.react lokal tanpa jaringan. Selain itu pg_rx bertanda tangan ke pemilik;
  // pemilik yang hello-nya sudah dikenal tanpa 'pgr' = 'old' (tanpa menunggu timeout). Jawaban cacat / tak cocok dengan yang diminta (mine harus = emoji kita) = 'proto'. Kode lain seperti pagePost (offline, busy, auth, time, ...).
  async pageReact(peerId, postId, e) {
    if (![peerId, postId].every((x) => typeof x === 'string' && HEX16.test(x)) || typeof e !== 'string') throw pgErr('bad');
    const em = e === '' ? '' : RX.cleanEmoji(e);
    if (em === null) throw pgErr('bad');
    if (peerId === this.id) { try { return (this._pages || fs.existsSync(this._pagesDir())) ? this.pageStore().react(this.id, postId, em) : null; } catch { return null; } }
    const a = this.pageAvail(peerId);
    if (!a.ok) throw pgErr(a.why);
    const p = this.peers.get(peerId);
    if (Array.isArray(p.caps) && !p.caps.includes('pgr')) throw pgErr('old');
    const r = await this._pgAsk(peerId, { t: 'pg_rx', id: postId, e: em }, PG_T_LIST);
    if (r.r == null) return null;
    const w = wireRxState(r.r);
    if (!w || w.mine !== em) throw pgErr('proto');
    return w;
  },

  // ---- gambar penuh (2d-3): peminta merakit blok demi blok dari pemilik dan menyajikannya lewat token penyaji media ----
  // pageMedia(peerId, postId, mediaId) -> { tok, mime, total } atau null (tidak ada / bukan untukku / diblokir, tak dibedakan). Melempar Error ber-`code` seperti pagePost, ditambah 'old' bila pemilik belum mengumumkan 'pgm'.
  // mediaId = id gambar ATAU id video (3c-5; mime video/mp4 | video/webm, kontainer blok pertama diperiksa sniffAv). Lampiran tidak lewat sini (pageFileGet).
  // Tanpa penyimpanan ke disk: tiap pembacaan penyaji (Range atau berurutan) mengambil blok MEDIA_CHUNK sejajar dari pemilik; gambar menyimpan 2 blok terakhir di memori, video 6 (LRU, untuk seek). peerId = id sendiri = gambar milikku sendiri, dibaca dari PageStore lokal.
  // Pemilik tidak dipercaya: potongan pertama HARUS gambar sungguhan sesuai mime yang diklaim (sniffImage + batas piksel), tiap blok harus cocok dengan total/mime yang sama dan panjang persis yang seharusnya.
  // Kegagalan di tengah aliran (pemilik offline, jawaban cacat) = pembacaan mengembalikan null: aliran berhenti, tidak ada data rusak yang disajikan.
  async pageMedia(peerId, postId, mediaId) {
    if (![peerId, postId, mediaId].every((x) => typeof x === 'string' && HEX16.test(x))) throw pgErr('bad');
    const e = { peerId, postId, mid: mediaId, self: peerId === this.id, total: 0, mime: '', blocks: new Map(), exp: Date.now() + PG_PTOK_TTL };
    const c = await this._pgChunk(e, 0);
    if (!c) return null;
    const vid = VIDEO_MIME.includes(c.mime);
    if (vid) { if (sniffAv(c.b) !== VID_SNIFF[c.mime]) throw pgErr('proto'); } // video (3c-5): kontainer di byte awal HARUS cocok dengan mime yang diklaim pemilik
    else { const info = sniffImage(c.b); if (!info || info.mime !== c.mime || !pixelsOk(info)) throw pgErr('proto'); }
    const map = this._ptok || (this._ptok = new Map()), now = Date.now();
    if (vid && !e.self) { const st = pgStreams(map, peerId, now); const lim = this._pgStreamLimits(); if (st.all >= lim.max || st.own >= lim.peer) throw pgErr('streams'); } // 3d-b1: blok pertama sudah terambil (<= 512 KB), tetapi tidak ada token dan tidak ada aliran
    e.total = c.total; e.mime = c.mime; e.vid = vid; e.last = now; e.keep = vid ? PG_VBLOCKS_KEEP : PG_BLOCKS_KEEP; e.blocks.set(0, Promise.resolve(c.b));
    for (const [k, v] of map) if (v.exp < now) map.delete(k);
    while (map.size >= PG_PTOK_MAX) map.delete(map.keys().next().value);
    const tok = crypto.randomBytes(16).toString('hex');
    map.set(tok, e);
    return { tok, mime: e.mime, total: e.total };
  },
  // Satu blok (off = kelipatan MEDIA_CHUNK) -> { mime, total, off, b } atau null (tidak tersedia). Melempar pgErr untuk kegagalan jaringan / jawaban cacat. 'busy' dicoba lagi sebentar (jendela laju pemilik 1 dtk).
  async _pgChunk(e, base) {
    let c;
    if (e.self) {
      const ps = this.pageStore(), r = ps.readMediaFor(this.id, e.postId, e.mid, base, MEDIA_CHUNK) || ps.readVideoFor(this.id, e.postId, e.mid, base, MEDIA_CHUNK);
      c = r && { mime: r.mime, total: r.total, off: r.off, b: r.b };
    } else {
      const p = this.peers.get(e.peerId);
      if (p && Array.isArray(p.caps) && p.caps.includes('pg') && !p.caps.includes('pgm')) throw pgErr('old'); // pemilik mendukung Halaman tetapi belum potongan gambar (versi sebelum 2d)
      let r;
      for (let i = 0; ; i++) {
        try { r = await this._pgAsk(e.peerId, { t: 'pg_media', id: e.postId, mid: e.mid, off: base, len: MEDIA_CHUNK }, PG_T_MEDIA); break; }
        catch (er) { if (er && er.code === 'busy' && i < PG_BUSY_TRIES - 1) { await sleep(PG_BUSY_WAIT); continue; } throw er; }
      }
      const k = r.chunk;
      if (k === null) return null;
      const vm = !!k && VIDEO_MIME.includes(k.mime);
      if (!k || typeof k !== 'object' || !(vm || MEDIA_MIME.includes(k.mime)) || !Number.isSafeInteger(k.total) || k.total <= 0 || k.total > (vm ? PAGE_VIDEO_MAX : PAGE_MEDIA_MAX) || k.off !== base
        || typeof k.b64 !== 'string' || k.b64.length > B64_MAX || !B64.test(k.b64)) throw pgErr('proto');
      const b = Buffer.from(k.b64, 'base64');
      if (b.length !== Math.min(MEDIA_CHUNK, k.total - base)) throw pgErr('proto');
      c = { mime: k.mime, total: k.total, off: base, b };
    }
    if (!c) return null;
    if (e.total && (c.total !== e.total || c.mime !== e.mime)) throw pgErr('proto'); // pemilik berubah pikiran di tengah aliran
    return c;
  },
  // ---- unduh lampiran (3a-5a): peminta menyalin berkas lampiran ke <folder unduhan>/halaman ----
  // pageFileGet(peerId, postId, fileId, opts?) -> { path, name, size } atau null (tidak ada / bukan untukku / diblokir, tak dibedakan). opts: { onProgress(have, total), signal (AbortSignal) }.
  // Melempar Error ber-`code` seperti pagePost, ditambah 'many' (> PG_DL_MAX unduhan berjalan), 'gone' (pemilik berhenti menyediakan di tengah jalan), 'nodl' (3b: pemilik mematikan unduhan postingan ini, sebelum mulai atau di tengah jalan), 'cancel', dan ENOSPC ("Penyimpanan penuh").
  // Nama dan ukuran DIAMBIL dari pemilik lewat pagePost (sudah divalidasi wirePost), bukan dari argumen pemanggil. Nama dibersihkan safeName (tanpa pemisah jalur, titik di depan, nama khusus Windows), ditambah (1), (2) bila bentrok.
  // Ditulis ke <tujuan>.part lalu di-rename; gagal / dibatalkan = .part dan tempat nama dibuang. Pemilik tidak dipercaya: tiap potongan harus cocok total, posisi, dan panjang persis. Tidak ada hash di metadata, jadi isi tidak bisa diverifikasi selain ukuran.
  // Belum ada: lanjut (resume) setelah putus; unduhan mulai ulang dari awal.
  async pageFileGet(peerId, postId, fileId, opts) {
    opts = opts || {};
    if (![peerId, postId, fileId].every((x) => typeof x === 'string' && HEX16.test(x))) throw pgErr('bad');
    const dls = this._pgDl || (this._pgDl = new Set());
    if (dls.size >= PG_DL_MAX) throw pgErr('many');
    const job = {}; dls.add(job);
    const self = peerId === this.id;
    let dest = null, part = null, fh = null, done = false;
    const stop = () => { if (opts.signal && opts.signal.aborted) throw pgErr('cancel'); if (this.stopped) throw pgErr('offline'); };
    try {
      const post = self ? this.pageStore().get(postId) : await this.pagePost(peerId, postId);
      const ent = post && post.files ? post.files.find((f) => f.id === fileId) : null;
      if (!ent) return null;
      if (!self && post.nodl) throw pgErr('nodl'); // 3b: tidak perlu memesan nama / membuka berkas; pemilik toh akan menolak tiap potongan. Pemilik sendiri tidak terkena (readFileFor melepasnya).
      stop();
      dest = await this._reserve(path.join(this._downloadDir(), 'halaman'), safeName(ent.name));
      part = dest + '.part';
      fh = await fs.promises.open(part, 'w');
      let have = 0;
      while (have < ent.size) {
        stop();
        const b = await this._pgFileChunk(peerId, self, postId, fileId, have, ent.size);
        if (!b) { const why = await this._pgWhyGone(peerId, self, postId); stop(); throw pgErr(why); } // dibatalkan selagi bertanya = 'cancel', bukan 'gone'
        stop();
        await fh.write(b, 0, b.length, have); have += b.length;
        if (typeof opts.onProgress === 'function') { try { opts.onProgress(have, ent.size); } catch {} }
      }
      await fh.close(); fh = null;
      if ((await fs.promises.stat(part)).size !== ent.size) throw pgErr('proto');
      await fs.promises.rename(part, dest); done = true;
      return { path: dest, name: path.basename(dest), size: ent.size };
    } catch (e) {
      throw e && e.code === 'ENOSPC' ? ek('e.io.full', null, 'Penyimpanan penuh', 'ENOSPC') : e;
    } finally {
      if (fh) { try { await fh.close(); } catch {} }
      if (!done) for (const f of [part, dest]) if (f) { try { await fs.promises.rm(f, { force: true }); } catch {} }
      dls.delete(job);
    }
  },
  // Potongan lampiran berhenti di tengah unduhan (3b): pemilik mematikan unduhannya ('nodl') atau berkas / postingannya hilang ('gone')? Pemilik menjawab null untuk keduanya, jadi tanya ulang postingannya.
  // Bukan rahasia (nodl memang tampil di postingan). Gagal apa pun saat bertanya = 'gone' (perilaku sebelum 3b).
  async _pgWhyGone(peerId, self, postId) {
    if (self) return 'gone';
    try { const p = await this.pagePost(peerId, postId); return p && p.nodl ? 'nodl' : 'gone'; } catch { return 'gone'; }
  },
  // Satu potongan lampiran (off = kelipatan FILE_CHUNK) -> Buffer, atau null (tidak tersedia). Melempar pgErr untuk kegagalan jaringan / jawaban cacat. 'busy' dicoba lagi sebentar.
  async _pgFileChunk(peerId, self, postId, fileId, base, size) {
    if (self) {
      const r = this.pageStore().readFileFor(this.id, postId, fileId, base, FILE_CHUNK);
      return r && r.total === size && r.off === base ? r.b : null;
    }
    const p = this.peers.get(peerId);
    if (p && Array.isArray(p.caps) && p.caps.includes('pg') && !p.caps.includes('pgm')) throw pgErr('old');
    let r;
    for (let i = 0; ; i++) {
      try { r = await this._pgAsk(peerId, { t: 'pg_media', id: postId, mid: fileId, off: base, len: FILE_CHUNK }, PG_T_MEDIA); break; }
      catch (er) { if (er && er.code === 'busy' && i < PG_BUSY_TRIES - 1) { await sleep(PG_BUSY_WAIT); continue; } throw er; }
    }
    const k = r.chunk;
    if (k === null) return null;
    if (!k || typeof k !== 'object' || k.total !== size || k.off !== base || typeof k.b64 !== 'string' || k.b64.length > B64_MAX || !B64.test(k.b64)) throw pgErr('proto');
    const b = Buffer.from(k.b64, 'base64');
    if (b.length !== Math.min(FILE_CHUNK, size - base)) throw pgErr('proto');
    return b;
  },
  // Dipanggil mediaSrcInfo / mediaSrcRead (core/archne-media.js) untuk token gambar Halaman.
  _pgSrcInfo(tok) {
    const e = this._ptok && this._ptok.get(String(tok));
    return !e || e.exp < Date.now() || this.stopped ? null : { mime: e.mime, total: e.total };
  },
  async _pgSrcRead(tok, start, len) {
    const e = this._ptok && this._ptok.get(String(tok));
    if (!e || e.exp < Date.now() || this.stopped || !Number.isSafeInteger(start) || start < 0 || start >= e.total || !(len >= 1)) return null;
    e.last = Date.now(); // 3d-b1: aliran ini aktif (dihitung pgStreams)
    const bi = Math.floor(start / MEDIA_CHUNK), base = bi * MEDIA_CHUNK;
    let pr = e.blocks.get(bi);
    if (pr) { e.blocks.delete(bi); e.blocks.set(bi, pr); } // LRU: yang baru dipakai jadi yang terakhir disingkirkan
    else { // pembacaan bersamaan atas blok yang sama berbagi satu permintaan; gagal = tidak disimpan (boleh dicoba lagi)
      pr = this._pgChunk(e, base).then((c) => (c ? c.b : null), () => null);
      e.blocks.set(bi, pr);
      pr.then((b) => { if (!b && e.blocks.get(bi) === pr) e.blocks.delete(bi); });
      while (e.blocks.size > (e.keep || PG_BLOCKS_KEEP)) e.blocks.delete(e.blocks.keys().next().value);
    }
    const b = await pr;
    if (!b) return null;
    const o = start - base;
    return b.subarray(o, o + len);
  },
};

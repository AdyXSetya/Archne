'use strict';
// src/core/archne-pages-cmt.js — Halaman 4b-2: komentar lewat jaringan. Sisi PEMILIK (_pgCmtHandle) dan sisi PEMINTA (pageComment, pageComments). Penyimpanan = PageStore.comment / commentsFor (4b-1).
// Lewat _handle -> _pgGate (tanda tangan permintaan, jam +-2 mnt, nonce di penampung SENDIRI _pgSeenC) -> _pgHandle -> sini. Identitas = rid TERBUKTI.
// Protokol:
//   { t:'pg_cmt', id, c }  -> { t:'pg_cmt', ok:true, r:'added' | 'same' | 'full' | null }
//        c = komentar yang SUDAH ditandatangani penulisnya (cmtSign; menutup id pemilik, id postingan, ts, teks). Tanda tangan permintaan menutup id postingan DAN c.id (= hash tanda tangan penulis), jadi komentar tak bisa diganti di jalan.
//        r null = postingan tidak ada / bukan untukmu / diblokir / folder halaman belum ada / gagal tulis / komentar ini pernah dihapus pemilik (5c-3): tak dibedakan. 'full' = batas komentar (per postingan, per penulis, seluruh berkas); hanya dijawab SESUDAH izin lihat lolos, jadi tidak membocorkan apa pun.
//        'bad' = bentuk salah, penulis bukan pengirim terbukti, c.post bukan id, atau tanda tangan komentar tak sah; 'time' = ts komentar > 2 mnt di depan jam pemilik. Semuanya tidak bergantung pada relasi, jadi tidak bisa dipakai menebak postingan Teman atau blokir.
//   { t:'pg_cml', id, after?, limit? } -> { t:'pg_cml', ok:true, r:{ items:[komentar], next, count } | null }  (tertua dulu; `after` = kursor 'ts:id'; limit 1..100, bawaan 50; r null = tak terlihat, tak dibedakan)
//        Ukuran jawaban terbatas sendiri: <= 100 komentar x teks <= 1000 karakter (paling besar ~3,4 KB per komentar dengan aksara 3-byte) = di bawah ~350 KB, jauh dari batas baris jaringan, jadi tidak perlu pemotong byte seperti pg_list.
//        Komentar keluar LENGKAP dengan tanda tangannya: siapa pun yang menerimanya bisa membuktikan penulisnya sendiri (pemilik hanya bisa menyembunyikan, tidak memalsukan).
//        5f (balasan): c boleh membawa `re` = id komentar induk (ikut ditandatangani penulis, tag lain: lihat src/archne-pagecmt.js). r 'noparent' = induknya tidak ada pada postingan itu (dijawab hanya SESUDAH izin lihat lolos). Caps 'pgt': pemilik tanpa 'pgt' menolak balasan sebagai 'bad', jadi peminta memeriksa caps dulu.
//        5g: r boleh membawa `rx` = { cid: { rx:[{e,n}], mine? } } untuk komentar di halaman itu yang punya reaksi (viewer-spesifik, tanpa daftar pelaku; bukan bagian yang ditandatangani, sama seperti reaksi postingan). Dikirim oleh pemilik ber-caps 'pgk'; peminta lama mengabaikannya.
// Urutan jawaban: bentuk salah ('bad') -> laju ('busy') -> tanda tangan komentar ('bad' / 'time') -> relasi.
// Laju (jendela tetap, per peer terbukti + batas global; peer yang melewati jatahnya sendiri tidak memakan jatah global): tulis 30 / menit per peer dan 100 / 10 dtk global (tiap tulis menulis ulang comments.json); baca 120 / menit per peer dan 100 / 10 dtk global.
// Caps 'pgc': peer lama tidak mengenal pg_cmt / pg_cml, jadi peminta memeriksa caps dulu.
// Moderasi (5c-1): pageCommentRemove(postId, cid) = pemilik membuang SATU komentar dari postingannya sendiri. Murni lokal (tanpa jaringan, tanpa jalur masuk dari peer). Satu-satunya pesan jaringan yang menghapus komentar adalah pg_cmd (5e, di bawah): PENULIS menghapus komentarnya SENDIRI, tidak pernah komentar orang lain.
//   { t:'pg_cmd', id, cid } -> { t:'pg_cmd', ok:true, r:'removed' | 'none' | null }  (5e, caps 'pgd'; antrean pemilik offline di src/core/archne-pages-cd.js)
//        Tanda tangan permintaan menutup id postingan DAN cid, dan identitas peminta terbukti: pemilik menghapus hanya bila komentar `cid` ada dan c.by = peminta. 'none' = tidak ada ATAU bukan milikmu (tak dibedakan); null = postingan tak ada / diblokir / dimatikan.
//        Tidak butuh izin LIHAT (putus pertemanan tidak mengunci penulis dari komentarnya sendiri), hanya tidak diblokir. Id dicatat sebagai nisan seperti hapus oleh pemilik. Laju sama dengan pg_cmt (menulis ulang comments.json).
// Privasi (5c-3, model Facebook): izin menulis = izin lihat saat itu; komentar yang sudah diterima TETAP ADA sampai pemilik menghapusnya (putus pertemanan / blokir tidak membuangnya); membaca butuh izin lihat saat ini. Yang dihapus pemilik tetap terhapus: id-nya dicatat (nisan, PageCmt.rm), kirim ulang komentar yang sama persis dijawab r:null (sama dengan "tidak ada", tanpa membocorkan moderasi) dan antrean 4c menjatuhkannya sebagai 'gone'. Komentar baru dari orang yang sama tetap boleh; menghentikan orangnya = blokir.
const fs = require('fs');
const RX = require('../archne-reactions');
const { wireCmtRx } = require('../archne-pagestore');
const { cmtSign, cmtVerify, cmtPage, wireComments, CMT_CURSOR, CMT_SKEW, CMT_PAGE_DEF, CMT_PAGE_MAX } = require('../archne-pagecmt');
const { HEX16 } = require('./archne-constants');
const { pgErr } = require('./archne-pgerr');
const { ek } = require('./archne-ecode');

const CMT_W_PEER = { max: 30, windowMs: 60e3 }, CMT_R_PEER = { max: 120, windowMs: 60e3 }, CMT_ALL = { max: 100, windowMs: 10e3 };
const CMT_T = 10000; // batas waktu peminta (ms)

const limits = (core) => core._pgCmtL || (core._pgCmtL = { wp: RX.limiter(CMT_W_PEER), wa: RX.limiter(CMT_ALL, 1), rp: RX.limiter(CMT_R_PEER), ra: RX.limiter(CMT_ALL, 1) });

module.exports = {
  // ---- sisi PEMILIK ----
  // 5e: penulis menghapus komentarnya sendiri. rid = identitas TERBUKTI (tanda tangan permintaan menutup id postingan dan cid). r: 'removed' | 'none' (tidak ada / bukan milikmu: tak dibedakan) | null (postingan tak ada / diblokir / dimatikan).
  _pgCmdHandle(o, rid) {
    const bad = { t: 'pg_cmd', ok: false, err: 'bad' };
    if (typeof o.id !== 'string' || !HEX16.test(o.id) || typeof o.cid !== 'string' || !HEX16.test(o.cid)) return bad;
    const lim = limits(this), now = Date.now();
    if (!lim.wp.take(rid || '-', 1, now) || !lim.wa.take('*', 1, now)) return { t: 'pg_cmd', ok: false, err: 'busy' }; // menulis ulang comments.json: laju yang sama dengan pg_cmt
    const ps = this._pgServePs();
    let r = null;
    if (ps) { try { r = ps.removeCommentBy(rid, o.id, o.cid); } catch (e) { this.opts.log('pg_cmd: ' + (e && e.message)); } } // gagal tulis dsb: tampak sama dengan "tidak ada"
    if (r === 'removed') this.emit('pgact', { post: o.id, kind: 'cmt' });
    return { t: 'pg_cmd', ok: true, r };
  },
  _pgCmtHandle(o, rid) {
    if (o.t === 'pg_cmd') return this._pgCmdHandle(o, rid);
    const write = o.t === 'pg_cmt', bad = { t: o.t, ok: false, err: 'bad' }, c = o.c;
    if (typeof o.id !== 'string' || !HEX16.test(o.id)) return bad;
    if (write) { if (!c || typeof c !== 'object' || c.post !== o.id || c.by !== rid) return bad; } // penulis = pengirim terbukti, postingan = yang diminta (tanpa melihat relasi)
    else if (o.after != null && !(typeof o.after === 'string' && CMT_CURSOR.test(o.after))) return bad;
    const lim = limits(this), now = Date.now();
    if (!(write ? lim.wp : lim.rp).take(rid || '-', 1, now) || !(write ? lim.wa : lim.ra).take('*', 1, now)) return { t: o.t, ok: false, err: 'busy' }; // peer dulu
    let v = null;
    if (write) {
      v = cmtVerify(c, this.id, o.id); // tanda tangan penulis atas halaman INI dan postingan ini; tidak bergantung pada relasi
      if (!v.ok) return bad;
      if (v.c.ts > now + CMT_SKEW) return { t: o.t, ok: false, err: 'time' };
    }
    const ps = this._pgServePs(); // jangan membuat folder hanya karena ada yang bertanya / berkomentar
    if (write) {
      let r = null;
      if (ps) {
        try { r = ps.comment(rid, o.id, v.c, now); } // null = tak terlihat; 'added' | 'same'
        catch (e) { if (e && e.code === 'full') r = 'full'; else if (e && e.code === 'noparent') r = 'noparent'; else this.opts.log('pg_cmt: ' + (e && e.message)); } // gagal tulis dsb: tampak sama dengan "tidak ada"
      }
      if (r === 'added') this.emit('pgact', { post: o.id, kind: 'cmt' }); // 5d-8: Halamanku terbuka di renderer menyegarkan diri (lokal, bukan pesan jaringan)
      return { t: 'pg_cmt', ok: true, r };
    }
    const all = ps ? ps.commentsFor(rid, o.id) : null;
    if (!all) return { t: 'pg_cml', ok: true, r: null };
    const pg = cmtPage(all, o.after, o.limit);
    const out = { items: pg.items, next: pg.next, count: all.length };
    const cr = ps.commentReactionsFor(rid, o.id, pg.items.map((c) => c.id)); // 5g: reaksi komentar di halaman ini (viewer-spesifik; tanpa daftar pelaku). Peminta lama mengabaikan field ini.
    if (cr) { const keys = Object.keys(cr); if (keys.length) { const m = {}; for (const k of keys) { const v = cr[k]; if (v.rx.length) m[k] = v.mine ? { rx: v.rx, mine: v.mine } : { rx: v.rx }; } if (Object.keys(m).length) out.rx = m; } }
    return { t: 'pg_cml', ok: true, r: out };
  },

  // ---- sisi PEMILIK, lokal (5c-1) ----
  // Buang satu komentar dari postingan milikku. -> true bila ada dan terbuang, false bila tidak ada (postingan / komentar tak dikenal, komentar dimatikan, folder halaman belum ada: tak dibedakan, dan tidak membuat folder).
  // Melempar Error ber-`code`: bad (postId / cid bukan 16 heks, tanpa menyentuh berkas). Gagal tulis (EACCES / ENOSPC) dilempar apa adanya dan memori kembali seperti di berkas (PageCmt.remove).
  pageCommentRemove(postId, cid) {
    if (![postId, cid].every((x) => typeof x === 'string' && HEX16.test(x))) throw pgErr('bad');
    if (!this._pages && !fs.existsSync(this._pagesDir())) return false;
    return this.pageStore().removeComment(postId, cid) === true;
  },

  // ---- sisi PEMINTA ----
  // Komentar pemilik `peerId` pada postingan `postId`: teks dikanonkan dan DITANDATANGANI di sini (kunci identitasku), lalu dikirim. -> { st:'added'|'same', c } atau null (tidak ada / bukan untukku / diblokir: tak dibedakan).
  // re (opsional, 5f) = id komentar yang dibalas: komentar menjadi balasan (pohon). Galat tambahan: noparent (komentar yang dibalas sudah tidak ada), old bila pemilik tanpa caps 'pgt'.
  // Melempar Error ber-`code`: bad (teks kosong / terlalu panjang / id tak sah, tanpa jaringan), full (batas komentar), old (pemilik tanpa caps 'pgc', tanpa menyentuh jaringan; hello tanpa caps sama sekali tetap dicoba), proto (jawaban pemilik cacat), serta self / peer / blocked / offline / busy / auth / time seperti pagePost.
  // peerId = id sendiri: lokal, tanpa jaringan (tidak membuat folder halaman).
  async pageComment(peerId, postId, text, re) {
    if (![peerId, postId].every((x) => typeof x === 'string' && HEX16.test(x))) throw pgErr('bad');
    if (re != null && !(typeof re === 'string' && HEX16.test(re))) throw pgErr('bad');
    let c;
    try { c = cmtSign(this.privKey, this.pub, peerId, postId, text, undefined, re == null ? undefined : re); } catch { throw pgErr('bad'); }
    if (peerId === this.id) {
      if (!this._pages && !fs.existsSync(this._pagesDir())) return null;
      let st;
      try { st = this.pageStore().comment(this.id, postId, c); } catch (e) { throw e && (e.code === 'full' || e.code === 'noparent') ? pgErr(e.code) : e; }
      return st ? { st, c } : null;
    }
    const a = this.pageAvail(peerId);
    if (!a.ok) throw pgErr(a.why);
    const p = this.peers.get(peerId);
    if (Array.isArray(p.caps) && !p.caps.includes('pgc')) throw pgErr('old');
    if (c.re && Array.isArray(p.caps) && !p.caps.includes('pgt')) throw ek('e.pg.oldReply', null, 'Aplikasi pemilik belum mendukung balasan komentar.', 'old');
    const r = await this._pgAsk(peerId, { t: 'pg_cmt', id: postId, c }, CMT_T);
    if (r.r === null) return null;
    if (r.r === 'full') throw pgErr('full');
    if (r.r === 'noparent') throw pgErr('noparent');
    if (r.r !== 'added' && r.r !== 'same') throw pgErr('proto');
    return { st: r.r, c };
  },
  // Komentar satu postingan, tertua dulu, berhalaman. opts: { after (kursor dari next), limit (1..100, bawaan 50) }. -> { items, next, count, skipped } atau null (tidak ada / bukan untukku / diblokir).
  // Dari pemilik jauh, tiap komentar DIPERIKSA tanda tangannya di sini (wireComments); yang palsu dibuang dan dihitung di `skipped`. Galat seperti pageComment (tanpa 'full').
  async pageComments(peerId, postId, opts) {
    opts = opts || {};
    if (![peerId, postId].every((x) => typeof x === 'string' && HEX16.test(x))) throw pgErr('bad');
    if (opts.after != null && !(typeof opts.after === 'string' && CMT_CURSOR.test(opts.after))) throw pgErr('bad');
    const limit = Number.isInteger(opts.limit) ? Math.min(CMT_PAGE_MAX, Math.max(1, opts.limit)) : CMT_PAGE_DEF;
    if (peerId === this.id) {
      const all = (this._pages || fs.existsSync(this._pagesDir())) ? this.pageStore().commentsFor(this.id, postId) : null;
      if (!all) return null;
      const pg = cmtPage(all, opts.after, limit);
      const own = this.pageStore().ownerCommentReactions(this.id, postId, pg.items.map((c) => c.id)); // 5g: kanal lokal pemilik: reaksi + daftar pelaku
      return { items: pg.items, next: pg.next, count: all.length, skipped: 0, rx: own && Object.keys(own).length ? own : undefined };
    }
    const a = this.pageAvail(peerId);
    if (!a.ok) throw pgErr(a.why);
    const p = this.peers.get(peerId);
    if (Array.isArray(p.caps) && !p.caps.includes('pgc')) throw pgErr('old');
    const req = { t: 'pg_cml', id: postId, limit };
    if (opts.after != null) req.after = opts.after;
    const r = await this._pgAsk(peerId, req, CMT_T * 2);
    if (r.r === null) return null;
    const w = wireComments(r.r, { after: req.after, limit }, peerId, postId);
    if (!w) throw pgErr('proto');
    const cr = wireCmtRx(r.r.rx, new Set(w.items.map((c) => c.id))); // 5g: hiasan, bentuk cacat per komentar diabaikan; pemilik lama tidak mengirimnya
    if (cr && Object.keys(cr).length) w.rx = cr;
    const q = this._pcdPeek(), hide = q ? q.hidden(peerId, postId) : null; // 5e: komentarku yang penghapusannya masih mengantre tidak ditampilkan lagi
    if (hide && hide.size) {
      w.items = w.items.filter((c) => !hide.has(c.id));
      w.count = Math.max(w.items.length, w.count - hide.size);
    }
    return w;
  },
};

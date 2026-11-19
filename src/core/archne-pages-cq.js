'use strict';
// src/core/archne-pages-cq.js — Halaman 4c-1: antrean komentar untuk pemilik yang sedang offline. Penyimpanan = src/archne-pagecq.js (CmtQueue, <dataDir>/pgcq.json). Tanpa IPC dan UI (4c-2, 4c-3).
// Alur: pageCommentQueue menandatangani komentar SEKARANG (kunci identitasku, ts = sekarang) dan menaruhnya di antrean. Sesudah itu _tick (tiap ~3 dtk) memanggil _pcqTick untuk tiap pemilik yang online dan tidak diblokir;
// _pcqFlush mengirim yang sudah waktunya (tertua dulu, maks CQ_BATCH per putaran) lewat pg_cmt yang sama dengan pageComment. Komentar yang sama persis dikirim ulang = 'same' di pemilik, jadi aman bila jawaban hilang.
// Hasil per entri (event 'pgcq' { ev, peer, post, id, why }):
//   added / same -> 'sent'; 'noparent' (5f: komentar yang dibalas sudah tidak ada) -> dibuang; null (postingan tak ada / bukan untukmu / diblokir) -> 'gone'; 'full' -> 'full'; galat 'bad' / 'old' / 'self' -> dibuang ('bad' / 'old'), tidak ada gunanya diulang.
//   offline / busy -> coba lagi nanti tanpa dihitung; blocked / peer -> berhenti, entri tetap (dibuang oleh umur); auth / time / proto / lain -> dihitung, jeda eksponensial, CQ_TRIES kali = 'gave'.
//   Umur lewat CQ_TTL = 'expired'. Event hanya untuk entri yang SELESAI atau dibuang; entri yang baru diantrekan tidak mengirim event (pemanggil sudah tahu).
// Antrean dibuat malas: tanpa berkas pgcq.json dan tanpa pemakaian, Core tidak membuat apa pun dan _pcqTick tidak menyentuh disk.
const fs = require('fs');
const path = require('path');
const { cmtSign } = require('../archne-pagecmt');
const { CmtQueue } = require('../archne-pagecq');
const { HEX16 } = require('./archne-constants');
const { pgErr } = require('./archne-pgerr');
const CQ_T = 10000, CQ_BATCH = 10; // batas waktu satu kiriman (sama dengan pageComment); jumlah kiriman per putaran (laju tulis pemilik 30 / menit per peer)

module.exports = {
  _pcqFile() { return path.join(this.opts.dataDir, 'pgcq.json'); },
  _pcqStore() { if (!this._pcq) { this._pcq = new CmtQueue(this._pcqFile()); this._pcqNone = false; } return this._pcq; },
  // Antrean bila sudah ada (dimuat dari berkas yang ada), selain itu null. Pemeriksaan berkas hanya sekali; sesudah itu murah.
  _pcqPeek() {
    if (this._pcq) return this._pcq;
    if (this._pcqNone) return null;
    if (fs.existsSync(this._pcqFile())) return this._pcqStore();
    this._pcqNone = true;
    return null;
  },
  // Dipanggil _tick sekali per tick: buang yang kedaluwarsa, termasuk untuk pemilik yang offline atau diblokir.
  _pcqGc() {
    this._pcdGc(); // 5e: antrean hapus komentar (archne-pages-cd.js) ikut dibersihkan
    const q = this._pcqPeek();
    if (!q) return;
    for (const e of q.expire(Date.now())) this.emit('pgcq', { ev: 'drop', peer: e.peer, post: e.post, id: e.c.id, why: 'expired' });
  },
  // Dipanggil _tick untuk pemilik yang online dan tidak diblokir.
  _pcqTick(p) {
    this._pcdTick(p); // 5e: kirim penghapusan komentar yang menunggu untuk pemilik ini
    const q = this._pcqPeek();
    if (q && q.has(p.id)) this._pcqFlush(p.id).catch((e) => this.log('antrean komentar: ' + (e && e.message)));
  },
  async _pcqFlush(peerId) {
    const q = this._pcqPeek();
    if (!q) return;
    this._pcqRun = this._pcqRun || new Set();
    if (this._pcqRun.has(peerId)) return; // satu putaran per pemilik
    this._pcqRun.add(peerId);
    const fin = (e, ev, why) => { q.done(e.c.id); this.emit('pgcq', { ev, peer: e.peer, post: e.post, id: e.c.id, why }); };
    try {
      let n = 0;
      for (const e of q.due(peerId, Date.now())) {
        if (n++ >= CQ_BATCH) break;
        const p = this.peers.get(peerId);
        if (!p || !this.isOnline(p) || this.isBlocked(peerId)) break;
        let r = null, code = null;
        if (Array.isArray(p.caps) && (!p.caps.includes('pgc') || (e.c.re && !p.caps.includes('pgt')))) code = 'old';
        else { try { r = await this._pgAsk(peerId, { t: 'pg_cmt', id: e.post, c: e.c }, CQ_T); } catch (er) { code = (er && typeof er.code === 'string' && er.code) || 'io'; } }
        if (!q.map.has(e.c.id)) continue; // dibatalkan selagi menunggu jawaban
        if (code === null) {
          if (r.r === 'added' || r.r === 'same') fin(e, 'sent', r.r);
          else if (r.r === null) fin(e, 'drop', 'gone');
          else if (r.r === 'full') fin(e, 'drop', 'full');
          else if (r.r === 'noparent') fin(e, 'drop', 'noparent'); // 5f: komentar yang dibalas sudah dihapus selagi menunggu
          else if (q.retry(e.c.id) === 'gave') this.emit('pgcq', { ev: 'drop', peer: e.peer, post: e.post, id: e.c.id, why: 'gave' });
        } else if (code === 'offline' || code === 'busy') { q.later(e.c.id); break; }
        else if (code === 'blocked' || code === 'peer') break;
        else if (code === 'bad' || code === 'old' || code === 'self') fin(e, 'drop', code);
        else {
          const s = q.retry(e.c.id);
          if (s === 'gave') this.emit('pgcq', { ev: 'drop', peer: e.peer, post: e.post, id: e.c.id, why: 'gave' });
          if (code === 'auth' || code === 'time') break; // berlaku untuk semua entri pemilik ini (jam / tanda tangan permintaan)
        }
      }
    } finally { this._pcqRun.delete(peerId); }
  },

  // Antrekan komentar untuk pemilik `peerId` yang mungkin offline. -> { st:'queued'|'same', c } ('same' = komentar persis sama sudah menunggu). Dikirim otomatis saat pemilik online.
  // Teks dikanonkan dan ditandatangani SEKARANG. Melempar Error ber-`code`: bad (id / teks tak sah, tanpa menyentuh apa pun), self (id sendiri: komentar lokal lewat pageComment, tidak diantrekan), peer (tak dikenal),
  // blocked, old (hello pemilik sudah dikenal tanpa caps 'pgc'), qfull (antrean penuh). Pemilik yang online juga boleh: tetap diantrekan lalu dikirim pada tick berikutnya.
  async pageCommentQueue(peerId, postId, text, re) { // re (opsional, 5f) = id komentar yang dibalas; pemilik tanpa caps 'pgt' = old
    if (![peerId, postId].every((x) => typeof x === 'string' && HEX16.test(x))) throw pgErr('bad');
    if (peerId === this.id) throw pgErr('self');
    if (re != null && !(typeof re === 'string' && HEX16.test(re))) throw pgErr('bad');
    let c;
    try { c = cmtSign(this.privKey, this.pub, peerId, postId, text, undefined, re == null ? undefined : re); } catch { throw pgErr('bad'); }
    const p = this.peers.get(peerId);
    if (!p) throw pgErr('peer');
    if (this.isBlocked(peerId)) throw pgErr('blocked');
    if (Array.isArray(p.caps) && !p.caps.includes('pgc')) throw pgErr('old');
    if (c.re && Array.isArray(p.caps) && !p.caps.includes('pgt')) throw Object.assign(pgErr('old'), { message: 'Aplikasi pemilik belum mendukung balasan komentar.' });
    let st;
    try { st = this._pcqStore().add(peerId, postId, c); } catch (e) { throw e && e.code === 'qfull' ? pgErr('qfull') : e; }
    const out = { id: c.id, by: c.by, ts: c.ts, text: c.text }; if (c.re) out.re = c.re; // 5f: balasan membawa id induknya
    return { st, c: out };
  },
  // Komentar yang masih menunggu untuk satu postingan, tertua dulu: [{ id, ts, text }] (kosong bila tak ada).
  pageCommentPending(peerId, postId) {
    if (![peerId, postId].every((x) => typeof x === 'string' && HEX16.test(x))) throw pgErr('bad');
    const q = this._pcqPeek();
    return q ? q.pending(peerId, postId) : [];
  },
  // Batalkan satu komentar yang menunggu. -> true bila ada dan dibatalkan (hanya milik pemilik `peerId`), selain itu false. Yang sudah terkirim tidak bisa ditarik.
  pageCommentCancel(peerId, commentId) {
    if (![peerId, commentId].every((x) => typeof x === 'string' && HEX16.test(x))) throw pgErr('bad');
    const q = this._pcqPeek();
    const e = q && q.map.get(commentId);
    if (!e || e.peer !== peerId) return false;
    q.done(commentId);
    return true;
  },
};

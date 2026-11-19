'use strict';
// src/core/archne-pages-cd.js — Halaman 5e: penulis menghapus komentarnya sendiri di halaman orang lain, termasuk antreannya bila pemilik sedang offline. Penyimpanan antrean = src/archne-pagecqd.js (DelQueue, <dataDir>/pgcd.json).
// Protokol: { t:'pg_cmd', id, cid } -> { t:'pg_cmd', ok:true, r:'removed' | 'none' | null } (sisi pemilik: _pgCmdHandle di src/core/archne-pages-cmt.js). Caps 'pgd'.
// Antrean dijalankan dari _pcqTick / _pcqGc (archne-pages-cq.js), jadi archne-net.js tidak berubah. Event 'pgcd' { ev:'sent'|'drop', peer, post, cid, why } hanya untuk entri yang SELESAI atau dibuang (Core saja; tidak diteruskan ke renderer).
// Hasil per entri: removed / none / null -> 'sent' (null = tak terlihat / diblokir: tidak ada gunanya diulang); galat 'bad' / 'old' / 'self' -> dibuang; offline / busy -> coba lagi nanti tanpa dihitung;
// blocked / peer -> berhenti, entri tetap (dibuang oleh umur); auth / time / proto / lain -> dihitung, jeda eksponensial, CD_TRIES kali = 'gave'. Umur lewat CD_TTL = 'expired'.
// Antrean dibuat malas: tanpa berkas pgcd.json dan tanpa pemakaian, Core tidak membuat apa pun.
const fs = require('fs');
const path = require('path');
const { DelQueue } = require('../archne-pagecqd');
const { pgErr } = require('./archne-pgerr');
const { ek } = require('./archne-ecode');
const { HEX16 } = require('./archne-constants');
const CD_T = 10000, CD_BATCH = 10; // batas waktu satu kiriman; jumlah kiriman per putaran (laju tulis pemilik 30 / menit per peer)

module.exports = {
  _pcdFile() { return path.join(this.opts.dataDir, 'pgcd.json'); },
  _pcdStore() { if (!this._pcd) { this._pcd = new DelQueue(this._pcdFile()); this._pcdNone = false; } return this._pcd; },
  _pcdPeek() {
    if (this._pcd) return this._pcd;
    if (this._pcdNone) return null;
    if (fs.existsSync(this._pcdFile())) return this._pcdStore();
    this._pcdNone = true;
    return null;
  },
  _pcdGc() {
    const q = this._pcdPeek();
    if (!q) return;
    for (const e of q.expire(Date.now())) this.emit('pgcd', { ev: 'drop', peer: e.peer, post: e.post, cid: e.cid, why: 'expired' });
  },
  _pcdTick(p) {
    const q = this._pcdPeek();
    if (q && q.has(p.id)) this._pcdFlush(p.id).catch((e) => this.log('antrean hapus komentar: ' + (e && e.message)));
  },
  async _pcdFlush(peerId) {
    const q = this._pcdPeek();
    if (!q) return;
    this._pcdRun = this._pcdRun || new Set();
    if (this._pcdRun.has(peerId)) return; // satu putaran per pemilik
    this._pcdRun.add(peerId);
    const fin = (e, ev, why) => { q.done(e.cid); this.emit('pgcd', { ev, peer: e.peer, post: e.post, cid: e.cid, why }); };
    try {
      let n = 0;
      for (const e of q.due(peerId, Date.now())) {
        if (n++ >= CD_BATCH) break;
        const p = this.peers.get(peerId);
        if (!p || !this.isOnline(p) || this.isBlocked(peerId)) break;
        let r = null, code = null;
        if (Array.isArray(p.caps) && !p.caps.includes('pgd')) code = 'old';
        else { try { r = await this._pgAsk(peerId, { t: 'pg_cmd', id: e.post, cid: e.cid }, CD_T); } catch (er) { code = (er && typeof er.code === 'string' && er.code) || 'io'; } }
        if (!q.map.has(e.cid)) continue; // dibatalkan selagi menunggu jawaban
        if (code === null) {
          if (r.r === 'removed' || r.r === 'none') fin(e, 'sent', r.r);
          else if (r.r === null) fin(e, 'drop', 'gone');
          else if (q.retry(e.cid) === 'gave') this.emit('pgcd', { ev: 'drop', peer: e.peer, post: e.post, cid: e.cid, why: 'gave' });
        } else if (code === 'offline' || code === 'busy') { q.later(e.cid); break; }
        else if (code === 'blocked' || code === 'peer') break;
        else if (code === 'bad' || code === 'old' || code === 'self') fin(e, 'drop', code);
        else {
          if (q.retry(e.cid) === 'gave') this.emit('pgcd', { ev: 'drop', peer: e.peer, post: e.post, cid: e.cid, why: 'gave' });
          if (code === 'auth' || code === 'time') break;
        }
      }
    } finally { this._pcdRun.delete(peerId); }
  },

  // Penulis menghapus komentarnya `cid` pada postingan `postId` milik `peerId`. -> { st:'removed'|'none'|'gone'|'queued' }.
  //   removed = pemilik menghapusnya sekarang; none = pemilik tidak punya komentar itu (sudah dihapus / bukan milikmu: tak dibedakan); gone = postingan tak terlihat / diblokir (tak dibedakan);
  //   queued = pemilik offline (atau sibuk): diantrekan dan dikirim otomatis saat pemilik online; selama menunggu pageComments menyembunyikannya.
  // Melempar Error ber-`code`: bad (id tak sah, tanpa menyentuh apa pun), self (halamanku sendiri: pemilik memakai pageCommentRemove), peer, blocked, old (pemilik tanpa caps 'pgd'), qfull, serta auth / time / proto seperti pageComment.
  async pageCommentDelete(peerId, postId, cid) {
    if (![peerId, postId, cid].every((x) => typeof x === 'string' && HEX16.test(x))) throw pgErr('bad');
    if (peerId === this.id) throw pgErr('self');
    const p = this.peers.get(peerId);
    if (!p) throw pgErr('peer');
    if (this.isBlocked(peerId)) throw pgErr('blocked');
    if (Array.isArray(p.caps) && !p.caps.includes('pgd')) throw ek('e.pg.oldCmtDel', null, 'Aplikasi pemilik belum mendukung penghapusan komentar oleh penulisnya. Hanya pemilik halaman yang bisa menghapusnya.', 'old');
    const queue = () => {
      try { this._pcdStore().add(peerId, postId, cid); } catch (e) { throw e && e.code === 'qfull' ? pgErr('qfull') : e; }
      return { st: 'queued' };
    };
    if (!this.isOnline(p)) return queue();
    let r;
    try { r = await this._pgAsk(peerId, { t: 'pg_cmd', id: postId, cid }, CD_T); }
    catch (e) { if (e && (e.code === 'offline' || e.code === 'busy')) return queue(); throw e; }
    if (r.r === null) return { st: 'gone' };
    if (r.r !== 'removed' && r.r !== 'none') throw pgErr('proto');
    // yang sudah terkirim ke pemilik tidak perlu lagi mengantre: buang entri antrean yang sama bila ada
    const q = this._pcdPeek(); if (q) q.done(cid);
    return { st: r.r };
  },
};

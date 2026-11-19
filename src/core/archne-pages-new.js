'use strict';
// src/core/archne-pages-new.js — Halaman 5b-2 fase 1: menanyai teman online tentang postingan terbaru mereka. Penyimpanan = src/archne-pagenew.js (PageNew, <dataDir>/pgnew.json). IPC di src/archne-ipc-pages.js (5b-3a), preload / api-http (5b-3b), UI (5b-4).
// Tanpa protokol baru: _pgnTick(p) memakai pageList(limit 1) yang sama dengan feed, jadi penyaring privasi pemilik berlaku per penonton (postingan Teman tidak terlihat oleh yang bukan teman; diblokir = kosong).
// Hanya TEMAN (fstate 'ok') yang ditanyai, selang PGN_POLL per pemilik (jadwal di memori), satu pertanyaan sekaligus untuk seluruh Core. Galat (offline, busy, old, proto, ...) tidak mengubah apa pun dan menunggu jadwal berikutnya.
// Event 'pgnew' { peer, on } hanya saat status lencana pemilik itu BERUBAH. Pengamatan pertama = garis dasar diam (lihat archne-pagenew.js). Penyimpanan dibuat malas: tanpa teman online, tidak ada berkas dan tidak ada objek.
const path = require('path');
const { PageNew } = require('../archne-pagenew');

module.exports = {
  _pgnFile() { return path.join(this.opts.dataDir, 'pgnew.json'); },
  _pgnStore() { if (!this._pgn) this._pgn = new PageNew(this._pgnFile()); return this._pgn; },
  // Daftar id pemilik yang lencananya menyala sekarang (urut id, salinan baru tiap panggilan). Untuk IPC (5b-3): renderer mengambilnya saat memulai / tersambung ulang, lalu mengikuti event 'pgnew'.
  // Hanya teman yang tidak diblokir: _pgnPrune berjalan tiap _tick, jadi sela sebelum pembersihan tidak boleh membocorkan pemilik yang sudah bukan teman. Tanpa penyimpanan = [] (tidak membuat berkas / objek).
  pageNewList() {
    const s = this._pgn; if (!s || !s.size) return [];
    return s.list().filter((id) => this.fstate(id) === 'ok' && !this.isBlocked(id));
  },
  // Dipanggil _tick untuk pemilik yang online dan tidak diblokir.
  _pgnTick(p) {
    if (this._pgnBusy || this.fstate(p.id) !== 'ok') return;
    const s = this._pgnStore(), now = Date.now();
    if (!s.due(p.id, now)) return;
    s.polled(p.id, now);
    this._pgnBusy = true;
    this._pgnAsk(p.id).catch((e) => this.log('lencana halaman: ' + (e && e.message))).then(() => { this._pgnBusy = false; });
  },
  async _pgnAsk(peerId) {
    let r;
    try { r = await this.pageList(peerId, { limit: 1, quiet: true }); } catch { return; } // galat apa pun: tidak menyalakan apa pun, tanya lagi sesudah PGN_POLL
    if (this.stopped || this.fstate(peerId) !== 'ok') return; // berhenti / bukan teman lagi selagi menunggu
    const it = r.items && r.items[0];
    const s = this._pgnStore();
    if (s.observe(peerId, it ? { ts: it.ts, id: it.id } : null)) this.emit('pgnew', { peer: peerId, on: s.has(peerId) });
  },
  // Dipanggil pageList sesudah jawaban sah untuk halaman PERTAMA (tanpa kursor, bukan pertanyaan latar belakang): feed dibuka = postingan terbaru yang terlihat sekarang sudah dilihat.
  // Hanya teman yang tidak diblokir. Galat penyimpanan tidak boleh merusak pembukaan feed. Event hanya bila status lencana pemilik itu berubah (observe + markSeen dihitung sebagai satu perubahan).
  _pgnSeen(peerId, r) {
    try {
      if (this.stopped || this.fstate(peerId) !== 'ok' || this.isBlocked(peerId)) return;
      const s = this._pgnStore(), was = s.has(peerId), it = r && r.items && r.items[0];
      s.observe(peerId, it ? { ts: it.ts, id: it.id } : null); s.markSeen(peerId);
      const now = s.has(peerId); if (now !== was) this.emit('pgnew', { peer: peerId, on: now });
    } catch (e) { this.log('lencana halaman: ' + (e && e.message)); }
  },
  // Dipanggil _tick: lupakan pemilik yang bukan teman lagi atau diblokir; lencana yang masih menyala dipadamkan dengan event. Tanpa penyimpanan = tidak ada yang dikerjakan.
  _pgnPrune() {
    const s = this._pgn; if (!s || !s.size) return;
    try {
      const keep = (id) => this.fstate(id) === 'ok' && !this.isBlocked(id), lit = s.list().filter((id) => !keep(id));
      if (!s.retain(keep)) return;
      for (const id of lit) this.emit('pgnew', { peer: id, on: false });
    } catch (e) { this.log('lencana halaman: ' + (e && e.message)); }
  },
};

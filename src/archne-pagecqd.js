'use strict';
// Antrean PENGHAPUSAN komentar oleh penulisnya untuk pemilik halaman yang sedang offline (5e). Murni lokal: tanpa jaringan, tanpa Core, tanpa UI. Dipakai src/core/archne-pages-cd.js.
// Saudara archne-pagecq.js (antrean KIRIM komentar), tetapi isinya hanya (peer, post, cid): tidak ada tanda tangan yang disimpan, karena permintaan pg_cmd ditandatangani SAAT DIKIRIM (Core._pgSign, nonce dan jam segar),
// jadi entri yang lama mengantre tidak kedaluwarsa tanda tangannya. Yang membuktikan penulis adalah identitas peminta terbukti; pemilik hanya menghapus bila c.by komentar itu = peminta.
// Entri = { peer, post, cid, at, tries, nx }   (kunci = cid: hash tanda tangan penulis, yang menutup id pemilik + id postingan, jadi unik per halaman + postingan)
// Berkas <dataDir>/pgcd.json = { v: 1, q: [entri] } ditulis atomik. Bukan sumber kebenaran: setiap entri diperiksa ulang bentuknya saat dibuka; yang cacat dibuang diam-diam. Rusak / versi asing = kosong.
// Batas: CD_TOTAL seluruh antrean, CD_PEER per pemilik; terlampaui = menolak ('qfull'). Umur CD_TTL (7 hari) lalu dibuang; CD_TRIES kali gagal diproses = menyerah.
const fs = require('fs'), path = require('path');
const HEX16 = /^[0-9a-f]{16}$/;
const CD_TOTAL = 200, CD_PEER = 50, CD_TTL = 7 * 864e5, CD_TRIES = 6, CD_BACKOFF = 30e3, CD_BACKOFF_MAX = 10 * 60e3;
const qfull = (m) => Object.assign(new Error(m), { code: 'qfull' });
const int = (x, lo, hi, d) => (Number.isSafeInteger(x) && x >= lo && x <= hi ? x : d);

class DelQueue {
  constructor(file, write) {
    this.file = file;
    this.write = typeof write === 'function' ? write : (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', s); fs.renameSync(f + '.tmp', f); };
    this.map = new Map(); // cid -> entri
    let raw = null;
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.v === 1 && Array.isArray(j.q)) raw = j.q; } catch {}
    for (const e of raw || []) {
      if (!e || typeof e !== 'object' || ![e.peer, e.post, e.cid].every((x) => typeof x === 'string' && HEX16.test(x))) continue;
      if (this.map.has(e.cid) || this.map.size >= CD_TOTAL || this._n(e.peer) >= CD_PEER) continue;
      this.map.set(e.cid, { peer: e.peer, post: e.post, cid: e.cid, at: int(e.at, 0, Number.MAX_SAFE_INTEGER, 0), tries: int(e.tries, 0, CD_TRIES, 0), nx: int(e.nx, 0, Number.MAX_SAFE_INTEGER, 0) });
    }
  }
  _n(peer) { let n = 0; for (const e of this.map.values()) if (e.peer === peer) n++; return n; }
  _save() { this.write(this.file, JSON.stringify({ v: 1, q: [...this.map.values()] })); }
  get size() { return this.map.size; }
  // Ada entri untuk pemilik ini? (murah; dipanggil tiap tick)
  has(peer) { for (const e of this.map.values()) if (e.peer === peer) return true; return false; }
  // Antrekan penghapusan komentar `cid` pada (peer, post). -> 'queued' | 'same'. Melempar bila id tak sah (Error biasa) atau batas ('qfull'); gagal tulis memulihkan memori.
  add(peer, post, cid, now) {
    if (![peer, post, cid].every((x) => typeof x === 'string' && HEX16.test(x))) throw new Error('Id tidak valid');
    if (this.map.has(cid)) return 'same';
    if (this.map.size >= CD_TOTAL) throw qfull('Antrean penghapusan penuh');
    if (this._n(peer) >= CD_PEER) throw qfull('Antrean penghapusan untuk pemilik ini penuh');
    this.map.set(cid, { peer, post, cid, at: now == null ? Date.now() : now, tries: 0, nx: 0 });
    try { this._save(); } catch (e) { this.map.delete(cid); throw e; }
    return 'queued';
  }
  // Himpunan cid yang menunggu untuk satu postingan (UI menyembunyikannya selagi menunggu).
  hidden(peer, post) { const s = new Set(); for (const e of this.map.values()) if (e.peer === peer && e.post === post) s.add(e.cid); return s; }
  // Entri pemilik ini yang sudah waktunya dicoba, tertua dulu. Salinan dangkal.
  due(peer, now) {
    const t = now == null ? Date.now() : now;
    return [...this.map.values()].filter((e) => e.peer === peer && e.nx <= t).sort((a, b) => a.at - b.at || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0)).map((e) => Object.assign({}, e));
  }
  // Selesai (terkirim / ditolak / menyerah): buang. -> entri atau null. Gagal tulis diabaikan (paling buruk terkirim ulang; pemilik menjawab 'none').
  done(cid) {
    const e = this.map.get(cid);
    if (!e) return null;
    this.map.delete(cid);
    try { this._save(); } catch {}
    return e;
  }
  // Pemilik tak terjangkau / sibuk: coba lagi nanti TANPA menghitung kegagalan.
  later(cid, now, ms) {
    const e = this.map.get(cid);
    if (!e) return;
    e.nx = (now == null ? Date.now() : now) + (ms == null ? CD_BACKOFF : ms);
    try { this._save(); } catch {}
  }
  // Pemilik menjawab tetapi gagal diproses: hitung, jeda eksponensial. -> 'retry' | 'gave' (entri dibuang) | null.
  retry(cid, now) {
    const e = this.map.get(cid);
    if (!e) return null;
    e.tries++;
    if (e.tries >= CD_TRIES) { this.done(cid); return 'gave'; }
    e.nx = (now == null ? Date.now() : now) + Math.min(CD_BACKOFF_MAX, CD_BACKOFF * 2 ** (e.tries - 1));
    try { this._save(); } catch {}
    return 'retry';
  }
  // Buang yang lebih tua dari CD_TTL. -> larik entri yang dibuang.
  expire(now) {
    const t = now == null ? Date.now() : now, out = [];
    for (const [id, e] of this.map) if (t - e.at > CD_TTL) { this.map.delete(id); out.push(e); }
    if (out.length) { try { this._save(); } catch {} }
    return out;
  }
}
module.exports = { DelQueue, CD_TOTAL, CD_PEER, CD_TTL, CD_TRIES, CD_BACKOFF, CD_BACKOFF_MAX };

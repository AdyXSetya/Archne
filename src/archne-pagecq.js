'use strict';
// Antrean komentar Halaman untuk pemilik yang sedang offline (tahap 4c-1). Murni lokal: tanpa jaringan, tanpa Core, tanpa UI. Dipakai src/core/archne-pages-cq.js.
// Yang diantrekan = komentar yang SUDAH ditandatangani penulisnya (cmtSign, 4b-1) untuk halaman pemilik + postingan itu. Tanda tangan menutup id pemilik, id postingan, ts, dan teks,
// jadi komentar di antrean tidak bisa diputar ulang ke halaman / postingan lain dan tidak perlu ditandatangani ulang saat dikirim. `ts` = waktu SAAT DITULIS (bukan saat terkirim):
// pemilik hanya menolak ts di masa depan (> 2 menit), tidak ada batas bawah, jadi komentar lama tetap sah.
// Entri = { peer, post, c, at, tries, nx }
//   peer  = id pemilik halaman (16 heks), post = id postingan (16 heks), c = komentar bertanda tangan ({ id, post, by, pub, ts, text, sig }); kunci entri = c.id (hash tanda tangan, unik per halaman + postingan).
//   at    = kapan diantrekan (ms); tries = berapa kali pemilik MENJAWAB tetapi gagal diproses (auth / time / proto; offline dan sibuk tidak dihitung); nx = paling cepat dicoba lagi (ms).
// Berkas <dataDir>/pgcq.json = { v: 1, q: [entri] } ditulis atomik. Bukan sumber kebenaran: SETIAP entri diperiksa ulang saat dibuka (bentuk + cmtVerify atas peer + post), jadi berkas yang diubah tangan
// tidak bisa menyelipkan komentar atas nama orang lain; yang tidak lolos dibuang diam-diam. Rusak / versi asing = kosong.
// Batas: CQ_TOTAL seluruh antrean, CQ_PEER per pemilik, CQ_POST per postingan (= CMT_PER_AUTHOR: lebih dari itu pasti ditolak pemilik dengan 'full'); terlampaui = menolak ('qfull'), tidak ada yang dibuang otomatis.
// Umur: CQ_TTL (7 hari) lalu dibuang oleh expire(); CQ_TRIES kali gagal diproses = menyerah (retry() mengembalikan 'gave').
const fs = require('fs'), path = require('path');
const { cmtVerify } = require('./archne-pagecmt');
const HEX16 = /^[0-9a-f]{16}$/;
const CQ_TOTAL = 200, CQ_PEER = 50, CQ_POST = 20, CQ_TTL = 7 * 864e5, CQ_TRIES = 6, CQ_BACKOFF = 30e3, CQ_BACKOFF_MAX = 10 * 60e3;
const qfull = (m) => Object.assign(new Error(m), { code: 'qfull' });
const int = (x, lo, hi, d) => (Number.isSafeInteger(x) && x >= lo && x <= hi ? x : d);

class CmtQueue {
  constructor(file, write) {
    this.file = file;
    this.write = typeof write === 'function' ? write : (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', s); fs.renameSync(f + '.tmp', f); };
    this.map = new Map(); // c.id -> entri
    let raw = null;
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.v === 1 && Array.isArray(j.q)) raw = j.q; } catch {}
    for (const e of raw || []) {
      if (!e || typeof e !== 'object' || !HEX16.test(String(e.peer)) || !HEX16.test(String(e.post)) || !e.c || typeof e.c !== 'object') continue;
      const v = cmtVerify(e.c, e.peer, e.post);
      if (!v.ok || this.map.has(v.c.id) || this.map.size >= CQ_TOTAL || this._n(e.peer) >= CQ_PEER || this._n(e.peer, e.post) >= CQ_POST) continue;
      this.map.set(v.c.id, { peer: e.peer, post: e.post, c: v.c, at: int(e.at, 0, Number.MAX_SAFE_INTEGER, 0), tries: int(e.tries, 0, CQ_TRIES, 0), nx: int(e.nx, 0, Number.MAX_SAFE_INTEGER, 0) });
    }
  }
  _n(peer, post) { let n = 0; for (const e of this.map.values()) if (e.peer === peer && (post === undefined || e.post === post)) n++; return n; }
  _save() { this.write(this.file, JSON.stringify({ v: 1, q: [...this.map.values()] })); }
  get size() { return this.map.size; }
  // Ada entri untuk pemilik ini? (murah; dipanggil tiap tick)
  has(peer) { for (const e of this.map.values()) if (e.peer === peer) return true; return false; }
  // Antrekan komentar bertanda tangan `c` untuk (peer, post). -> 'queued' | 'same'. Melempar bila bentuk / tanda tangan tak sah (Error biasa) atau batas ('qfull'); gagal tulis memulihkan memori.
  add(peer, post, c, now) {
    if (!HEX16.test(String(peer)) || !HEX16.test(String(post))) throw new Error('Id tidak valid');
    const v = cmtVerify(c, peer, post);
    if (!v.ok) throw new Error('Komentar tidak sah');
    if (this.map.has(v.c.id)) return 'same';
    if (this.map.size >= CQ_TOTAL) throw qfull('Antrean penuh');
    if (this._n(peer) >= CQ_PEER) throw qfull('Antrean untuk pemilik ini penuh');
    if (this._n(peer, post) >= CQ_POST) throw qfull('Antrean untuk postingan ini penuh');
    this.map.set(v.c.id, { peer, post, c: v.c, at: now == null ? Date.now() : now, tries: 0, nx: 0 });
    try { this._save(); } catch (e) { this.map.delete(v.c.id); throw e; }
    return 'queued';
  }
  // Entri pemilik ini yang sudah waktunya dicoba, tertua dulu (at, lalu id). Salinan dangkal: mengubahnya tidak mengubah antrean.
  due(peer, now) {
    const t = now == null ? Date.now() : now;
    return [...this.map.values()].filter((e) => e.peer === peer && e.nx <= t).sort((a, b) => a.at - b.at || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0)).map((e) => Object.assign({}, e));
  }
  // Yang menunggu untuk satu postingan, tertua dulu: [{ id, ts, text }] (untuk UI; tanpa kunci dan tanda tangan).
  pending(peer, post) {
    return [...this.map.values()].filter((e) => e.peer === peer && e.post === post).sort((a, b) => a.at - b.at || (a.c.id < b.c.id ? -1 : 1)).map((e) => ({ id: e.c.id, ts: e.c.ts, text: e.c.text }));
  }
  // Selesai (terkirim / ditolak pemilik / dibatalkan): buang. -> entri yang dibuang atau null. Gagal tulis diabaikan (paling buruk terkirim ulang; pemilik menjawab 'same').
  done(id) {
    const e = this.map.get(id);
    if (!e) return null;
    this.map.delete(id);
    try { this._save(); } catch {}
    return e;
  }
  // Pemilik tak terjangkau / sibuk: coba lagi nanti TANPA menghitung kegagalan.
  later(id, now, ms) {
    const e = this.map.get(id);
    if (!e) return;
    e.nx = (now == null ? Date.now() : now) + (ms == null ? CQ_BACKOFF : ms);
    try { this._save(); } catch {}
  }
  // Pemilik menjawab tetapi gagal diproses: hitung, jeda eksponensial (30 dtk, 1, 2, 4, ... maks 10 mnt). -> 'retry' | 'gave' (entri dibuang) | null (tidak ada).
  retry(id, now) {
    const e = this.map.get(id);
    if (!e) return null;
    e.tries++;
    if (e.tries >= CQ_TRIES) { this.done(id); return 'gave'; }
    e.nx = (now == null ? Date.now() : now) + Math.min(CQ_BACKOFF_MAX, CQ_BACKOFF * 2 ** (e.tries - 1));
    try { this._save(); } catch {}
    return 'retry';
  }
  // Buang yang lebih tua dari CQ_TTL. -> larik entri yang dibuang.
  expire(now) {
    const t = now == null ? Date.now() : now, out = [];
    for (const [id, e] of this.map) if (t - e.at > CQ_TTL) { this.map.delete(id); out.push(e); }
    if (out.length) { try { this._save(); } catch {} }
    return out;
  }
}
module.exports = { CmtQueue, CQ_TOTAL, CQ_PEER, CQ_POST, CQ_TTL, CQ_TRIES, CQ_BACKOFF, CQ_BACKOFF_MAX };

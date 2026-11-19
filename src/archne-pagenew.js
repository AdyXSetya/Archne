'use strict';
// Penanda "ada postingan baru" di Halaman peer (tahap 5b-1). Murni lokal: tanpa jaringan, tanpa Core, tanpa UI. Dipakai src/core/archne-pages-new.js (5b-2).
// Per pemilik halaman (16 heks) disimpan dua titik waktu, masing-masing `{ ts, id }` (kursor postingan, sama dengan `ts:id` di pg_list) atau null:
//   l (last) = postingan TERBARU yang terakhir terlihat oleh kita di halaman itu (dari pg_list limit 1 atau dari feed yang dibuka); null = halaman kosong / tak terlihat bagi kita.
//   s (seen) = postingan terbaru yang sudah kita lihat; null = belum melihat satu pun.
// Lencana menyala bila l ada dan l > s (urut ts lalu id). Pengamatan PERTAMA terhadap seorang pemilik hanya menjadi garis dasar (s = l, diam): postingan lama yang sudah ada
// tidak membuat lencana untuk semua teman begitu fitur ini terpasang. Halaman yang kosong saat garis dasar (s = l = null) lalu terisi = lencana menyala.
// Postingan terbaru dihapus pemilik (l turun di bawah s): s ikut diturunkan ke l, supaya postingan baru yang ts-nya di antara keduanya tidak tersembunyi.
// Tidak ada isi postingan, teks, atau nama di sini: hanya id pemilik + dua kursor. Berkas `<dataDir>/pgnew.json` = { v: 1, m: { peer: { s, l } } } ditulis atomik, hanya bila ada perubahan.
// Bukan sumber kebenaran: dibersihkan saat dibuka (id / kursor tak sah dibuang, s > l diturunkan ke l, l null memaksa s null, batas PGN_MAX); rusak / versi asing = kosong.
// Jadwal tanya (due / polled) hanya di memori: tidak disimpan, jadi tiap mulai ulang semua teman online ditanya sekali lagi.
const fs = require('fs'), path = require('path');
const HEX16 = /^[0-9a-f]{16}$/;
const PGN_MAX = 1000; // pemilik yang dilacak; lebih = menolak yang baru (tidak ada yang dibuang otomatis)
const PGN_POLL = 5 * 60e3; // selang tanya ulang per pemilik (ms)
const cmp = (a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const mk = (x) => (x && typeof x === 'object' && Number.isSafeInteger(x.ts) && x.ts >= 0 && typeof x.id === 'string' && HEX16.test(x.id) ? { ts: x.ts, id: x.id } : null);
const fromFile = (x) => (Array.isArray(x) ? mk({ ts: x[0], id: x[1] }) : null);
const toFile = (x) => (x ? [x.ts, x.id] : null);

class PageNew {
  constructor(file, write) {
    this.file = file;
    this.write = typeof write === 'function' ? write : (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', s); fs.renameSync(f + '.tmp', f); };
    this.map = new Map(); // peer -> { s, l }
    this.polls = new Map(); // peer -> kapan terakhir ditanya (memori saja)
    let raw = null;
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.v === 1 && j.m && typeof j.m === 'object' && !Array.isArray(j.m)) raw = j.m; } catch {}
    for (const k of Object.keys(raw || {})) {
      if (!HEX16.test(k) || this.map.size >= PGN_MAX) continue;
      const e = raw[k];
      if (!e || typeof e !== 'object') continue;
      const l = fromFile(e.l);
      let s = l ? fromFile(e.s) : null;
      if (s && cmp(s, l) > 0) s = l;
      this.map.set(k, { s, l });
    }
  }
  _save() { const m = {}; for (const [k, e] of this.map) m[k] = { s: toFile(e.s), l: toFile(e.l) }; this.write(this.file, JSON.stringify({ v: 1, m })); }
  _lit(e) { return !!(e && e.l && (!e.s || cmp(e.l, e.s) > 0)); }
  // Ubah entri lalu simpan; gagal tulis memulihkan memori dan melempar. -> true bila status lencana pemilik itu berubah.
  _set(peer, next) {
    const prev = this.map.get(peer), was = this._lit(prev);
    if (next === null) this.map.delete(peer); else this.map.set(peer, next);
    try { this._save(); } catch (e) { if (prev) this.map.set(peer, prev); else this.map.delete(peer); throw e; }
    return this._lit(next) !== was;
  }
  get size() { return this.map.size; }
  // Lencana menyala untuk pemilik ini? (murah)
  has(peer) { return this._lit(this.map.get(peer)); }
  // Semua pemilik yang lencananya menyala, urut id (salinan).
  list() { return [...this.map.keys()].filter((k) => this._lit(this.map.get(k))).sort(); }
  // Catat postingan terbaru yang terlihat di halaman `peer` sekarang: `post` = { ts, id } atau null (kosong / tak terlihat). Id tak sah / post cacat melempar (tanpa mengubah apa pun).
  // Pengamatan pertama = garis dasar (diam). -> true bila status lencana berubah (untuk memicu event); pengamatan yang tidak mengubah apa pun tidak menulis berkas.
  observe(peer, post) {
    if (!HEX16.test(String(peer))) throw new Error('Id tidak valid');
    const l = post === null || post === undefined ? null : mk(post);
    if (post != null && !l) throw new Error('Postingan tidak valid');
    const e = this.map.get(peer);
    if (!e) {
      if (this.map.size >= PGN_MAX) return false; // penuh: yang baru tidak dilacak (tak ada lencana palsu, tak ada yang dibuang)
      return this._set(peer, { s: l, l });
    }
    let s = e.s;
    if (l === null) s = null; else if (s && cmp(s, l) > 0) s = l; // dihapus: s turun ke l
    const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && cmp(a, b) === 0);
    if (same(l, e.l) && same(s, e.s)) return false;
    return this._set(peer, { s, l });
  }
  // Pemilik ini sudah dibuka: s = l. -> true bila lencana padam. Pemilik tak dikenal = false (tidak membuat entri).
  markSeen(peer) {
    const e = this.map.get(peer);
    if (!e || !e.l || (e.s && cmp(e.s, e.l) === 0)) return false;
    return this._set(peer, { s: e.l, l: e.l });
  }
  // Lupakan satu pemilik (mis. bukan teman lagi). -> true bila ada yang dibuang. Jadwal tanyanya ikut dibuang.
  forget(peer) { this.polls.delete(peer); return this.map.has(peer) ? (this._set(peer, null), true) : false; }
  // Pertahankan hanya pemilik yang lolos `keep(id)`; yang lain dibuang dalam satu tulis. -> jumlah dibuang.
  retain(keep) {
    const gone = [...this.map.keys()].filter((k) => !keep(k));
    for (const k of [...this.polls.keys()]) if (!keep(k)) this.polls.delete(k);
    if (!gone.length) return 0;
    const saved = gone.map((k) => [k, this.map.get(k)]);
    for (const k of gone) this.map.delete(k);
    try { this._save(); } catch (e) { for (const [k, v] of saved) this.map.set(k, v); throw e; }
    return gone.length;
  }
  // Jadwal tanya (memori): sudah waktunya menanyai pemilik ini lagi? Belum pernah ditanya = ya.
  due(peer, now) { const t = this.polls.get(peer); return t === undefined || (now == null ? Date.now() : now) - t >= PGN_POLL; }
  polled(peer, now) { this.polls.set(peer, now == null ? Date.now() : now); }
  // Buat pemilik ini langsung jatuh tempo (mis. baru online lagi).
  soon(peer) { this.polls.delete(peer); }
}

module.exports = { PageNew, PGN_MAX, PGN_POLL };

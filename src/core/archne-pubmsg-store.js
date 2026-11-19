'use strict';
// src/core/archne-pubmsg-store.js — kuota BYTE untuk pesan PUBLIK milik orang lain (v0.22.1, Step 2d).
//  - Dihitung: to === 'public', tanpa kind, bukan dariku, bukan pesan kontrol batal-kirim. Ongkos = custCost (byte teks + overhead), sama dengan titipan.
//  - Penghitung (total dan per pengirim) dijaga lewat kait eksplisit: _ingest (tambah), _applyDel (buang), _pubEvict (gusur), _loadStore (bangun ulang).
//  - Penuh: pesan masuk hanya bisa menggusur pesan yang LEBIH TUA darinya. Korban = pesan terlama dari pengirim yang paling banyak memegang byte
//    (air-meratakan lewat heap), dan penggusuran berhenti di 90% kuota supaya pindaian tidak berulang untuk tiap pesan. Bila tidak cukup ruang: 'full'.
//  - Pesan yang sedang diunduh berkasnya (penerimaan jalan) tidak digusur. Tawaran berkas yang digusur dibuang lewat _dropOffer (berkas di folder unduhan tidak disentuh).
const { DEL, custCost } = require('./archne-constants');

const HYST = 0.9;
const heapPush = (h, x) => { h.push(x); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (h[p].bytes >= h[i].bytes) break; [h[p], h[i]] = [h[i], h[p]]; i = p; } };
const heapPop = (h) => {
  const top = h[0], last = h.pop();
  if (h.length) {
    h[0] = last; let i = 0;
    for (;;) { const l = 2 * i + 1, r = l + 1; let b = i; if (l < h.length && h[l].bytes > h[b].bytes) b = l; if (r < h.length && h[r].bytes > h[b].bytes) b = r; if (b === i) break; [h[b], h[i]] = [h[i], h[b]]; i = b; }
  }
  return top;
};

module.exports = {
  _pqReset() { this._pq = { n: 0, bytes: 0, from: new Map() }; },
  // Pesan publik orang lain yang ikut kuota.
  _isPubOther(m) { return !!m && m.to === 'public' && !m.kind && m.from !== this.id && !(typeof m.text === 'string' && m.text.startsWith(DEL)); },
  _pqAdd(m) { const q = this._pq, sz = custCost(m); q.n++; q.bytes += sz; q.from.set(m.from, (q.from.get(m.from) || 0) + sz); },
  _pqSub(m) {
    const q = this._pq, sz = custCost(m), v = (q.from.get(m.from) || 0) - sz;
    q.n--; q.bytes -= sz;
    if (v > 0) q.from.set(m.from, v); else q.from.delete(m.from);
  },
  _pqRebuild() { this._pqReset(); for (const m of Object.values(this.store.msgs)) if (this._isPubOther(m)) this._pqAdd(m); },
  // Pemakaian untuk UI/pengaturan: { used, count, quota }.
  pubUsage() { return { used: this._pq.bytes, count: this._pq.n, quota: this._custLimits().pub.quota }; },
  // Batas bawah ts untuk sync_req: hanya bila simpanan hampir penuh (>85%), supaya peer tidak mengirim ulang pesan lama yang pasti kutolak. 0 = tanpa batas.
  _pubFloor() {
    const lim = this._custLimits().pub;
    if (!(this._pq.bytes > lim.quota * 0.85)) return 0;
    let min = Infinity;
    for (const m of Object.values(this.store.msgs)) if (this._isPubOther(m)) { const a = this._dts(m); if (a < min) min = a; }
    return Number.isFinite(min) ? min : 0;
  },
  // Izinkan pesan publik orang lain masuk. true = boleh (mungkin setelah menggusur yang lebih tua), false = penuh dan tidak ada yang boleh digusur.
  _pubAdmit(m) {
    const lim = this._custLimits().pub, q = this._pq, sz = custCost(m), at = this._dts(m);
    if (sz > lim.perSender || sz > lim.quota) return false;
    const mine = q.from.get(m.from) || 0;
    if (mine + sz <= lim.perSender && q.bytes + sz <= lim.quota) return true;
    // Hanya bila terlampaui: satu pindaian mengumpulkan calon korban (lebih tua dari pesan masuk, tidak sedang diunduh), per pengirim, terlama dulu.
    const per = new Map();
    for (const [id, x] of Object.entries(this.store.msgs)) {
      if (!this._isPubOther(x)) continue;
      let e = per.get(x.from);
      if (!e) per.set(x.from, e = { bytes: q.from.get(x.from) || 0, list: [], i: 0 });
      const a = this._dts(x);
      if (a <= at && !this._rx.has(id) && !this._dl.has(id)) e.list.push([a, id, custCost(x)]);
    }
    for (const e of per.values()) e.list.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    const victims = []; let total = q.bytes + sz;
    const take = (e) => { const v = e.list[e.i++]; e.bytes -= v[2]; total -= v[2]; victims.push(v[1]); };
    const own = per.get(m.from);
    if (mine + sz > lim.perSender) { // pengirim ini sendiri melewati bagiannya: yang digusur pesan terlamanya sendiri
      if (!own) return false;
      const soft = Math.floor(lim.perSender * HYST) - sz;
      while (own.bytes > soft && own.i < own.list.length) take(own);
      if (own.bytes + sz > lim.perSender) return false;
    }
    if (total > lim.quota) { // kuota total: pengirim yang memegang byte terbanyak kehilangan pesan terlamanya dulu
      const soft = Math.floor(lim.quota * HYST), heap = [];
      for (const e of per.values()) if (e.i < e.list.length) heapPush(heap, e);
      while (total > soft && heap.length) { const e = heapPop(heap); take(e); if (e.i < e.list.length) heapPush(heap, e); }
      if (total > lim.quota) return false;
    }
    this._pubEvict(victims);
    return true;
  },
  // Kuota diturunkan (Step 2e): buang kelebihan sekarang. Pengirim yang melewati batasnya turun ke 90% bagiannya (pesan terlamanya sendiri),
  // lalu bila total masih lewat kuota, pengirim terbanyak kehilangan pesan terlamanya dulu sampai 90% kuota. Yang sedang diunduh tidak digusur. Hasil: jumlah dibuang.
  _pubTrim() {
    const lim = this._custLimits().pub, q = this._pq;
    let over = q.bytes > lim.quota;
    if (!over) for (const v of q.from.values()) if (v > lim.perSender) { over = true; break; }
    if (!over) return 0;
    const per = new Map();
    for (const [id, x] of Object.entries(this.store.msgs)) {
      if (!this._isPubOther(x) || this._rx.has(id) || this._dl.has(id)) continue;
      let e = per.get(x.from);
      if (!e) per.set(x.from, e = { bytes: q.from.get(x.from) || 0, list: [], i: 0 });
      e.list.push([this._dts(x), id, custCost(x)]);
    }
    for (const e of per.values()) e.list.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    const victims = []; let total = q.bytes;
    const take = (e) => { const v = e.list[e.i++]; e.bytes -= v[2]; total -= v[2]; victims.push(v[1]); };
    const softS = Math.floor(lim.perSender * HYST);
    for (const e of per.values()) if (e.bytes > lim.perSender) while (e.bytes > softS && e.i < e.list.length) take(e);
    if (total > lim.quota) {
      const soft = Math.floor(lim.quota * HYST), heap = [];
      for (const e of per.values()) if (e.i < e.list.length) heapPush(heap, e);
      while (total > soft && heap.length) { const e = heapPop(heap); take(e); if (e.i < e.list.length) heapPush(heap, e); }
    }
    this._pubEvict(victims);
    return victims.length;
  },
  _pubEvict(ids) {
    const M = this.store.msgs, offers = [];
    for (const id of ids) {
      const x = M[id];
      if (!x) continue;
      this._pqSub(x);
      if (this._offerOf(x) !== undefined) offers.push(id);
      delete M[id]; delete this.store.hidden[id]; delete this.store.rx[id]; this._plain.delete(id);
    }
    if (offers.length) this._dropOffer(offers); // penerimaan berhenti, sisa unduhan dibuang; berkas di folder unduhan tidak disentuh
    if (ids.length) this.emit('update');
  },
};

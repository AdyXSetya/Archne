'use strict';
// src/core/archne-custody-store.js — titipan SUB (DM, pesan grup) tinggal di DISK, bukan di RAM (v0.22.1, Step 2c).
//  - Di memori tiap titipan sub hanya metadata ringan: m = { id, from, to, kind, ts, ep?, pc? } + at + sz. Field berat (text, sig, pub, name) adalah
//    getter yang membaca segmen custody/<2 hex>/<id>.json bila diakses, lewat cache kecil. Semua kode lama yang membaca `c.m.text` dst. tetap jalan.
//  - Segmen = dua baris: baris 1 = { at, sz, m: metadata }, baris 2 = { text, sig, pub, name }. Muat saat start hanya membaca baris 1.
//  - Penghitung byte per kelas (dm, gmsg), per pengirim, dan per grup dijaga lewat Proxy pada store.custody, jadi cek kuota O(1)
//    walau isinya langsung ditambah/dibuang dari kode lain (termasuk tes). Kelas state (primer) tetap utuh di memori (kecil, di primary.json).
const fs = require('fs');
const path = require('path');
const { custClass, custCost } = require('./archne-constants');

const HEAVY = ['text', 'sig', 'pub', 'name'];
const SEG_RE = /^[0-9a-f]{32}\.json$/;
const HEAD_READ = 4096;          // header segmen jauh lebih kecil dari ini
const CACHE_BYTES = 8e6;         // cache isi pesan yang sering dibaca (sinkronisasi mengirim ulang pesan yang sama)
const segPath = (dir, id) => path.join(dir, id.slice(0, 2), id + '.json');
const readJson = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } };
const metaOf = (m) => { const o = {}; for (const k of Object.keys(m)) if (!HEAVY.includes(k)) o[k] = m[k]; return o; };
const heavyOf = (m) => { const o = {}; for (const k of HEAVY) if (m[k] !== undefined) o[k] = m[k]; return o; };
const isLazy = (c) => !!(c && c.lz);

module.exports = {
  // ---- penghitung byte ----
  _cqReset() { this._cq = { dm: { n: 0, bytes: 0, from: new Map() }, gmsg: { n: 0, bytes: 0, from: new Map(), to: new Map() } }; },
  _cqAdd(c) {
    const q = this._cq[custClass(c.m)]; if (!q) return;
    q.n++; q.bytes += c.sz;
    q.from.set(c.m.from, (q.from.get(c.m.from) || 0) + c.sz);
    if (q.to) q.to.set(c.m.to, (q.to.get(c.m.to) || 0) + c.sz);
  },
  _cqSub(c) {
    const q = this._cq[custClass(c.m)]; if (!q) return;
    q.n--; q.bytes -= c.sz;
    const dec = (map, k) => { const v = (map.get(k) || 0) - c.sz; if (v > 0) map.set(k, v); else map.delete(k); };
    dec(q.from, c.m.from); if (q.to) dec(q.to, c.m.to);
  },
  // Bungkus objek titipan supaya tiap tambah/buang/ganti tercatat di penghitung. Hanya trap set dan delete (pembacaan langsung, tanpa biaya).
  _custWrap(target) {
    const self = this;
    return new Proxy(target, {
      set(t, id, c) {
        if (typeof id !== 'string') { t[id] = c; return true; }
        const old = t[id]; if (old && old.m) self._cqSub(old);
        t[id] = c;
        if (c && c.m) { if (!Number.isFinite(c.sz)) c.sz = custCost(c.m); self._cqAdd(c); }
        return true;
      },
      deleteProperty(t, id) {
        const old = t[id]; if (old && old.m) self._cqSub(old);
        delete t[id];
        return true;
      },
    });
  },
  // Pasang pembungkus di store.custody (idempotent): penghitung dibangun ulang dari isinya.
  _custInstall() {
    const plain = Object.assign({}, this.store.custody);
    this._cqReset();
    this.store.custody = this._custWrap({});
    for (const [id, c] of Object.entries(plain)) this.store.custody[id] = c;
  },

  // ---- segmen ----
  // Isi berat sebuah titipan sub (text/sig/pub/name) dari cache atau disk. null bila segmennya hilang/rusak (id ditandai; _gc membuang titipannya).
  _custHeavy(id) {
    const cache = this._custCache || (this._custCache = new Map());
    const hit = cache.get(id);
    if (hit) { cache.delete(id); cache.set(id, hit); return hit.h; } // segarkan urutan (LRU)
    let h = null;
    try {
      const s = fs.readFileSync(segPath(this.custDir, id), 'utf8'), i = s.indexOf('\n');
      h = i >= 0 ? JSON.parse(s.slice(i + 1)) : null;
    } catch {}
    if (!h || typeof h !== 'object' || typeof h.text !== 'string') { (this._custBad || (this._custBad = new Set())).add(id); return null; }
    this._custCachePut(id, h);
    return h;
  },
  _custCachePut(id, h) {
    const cache = this._custCache || (this._custCache = new Map());
    const sz = (h.text || '').length + 400;
    cache.set(id, { h, sz });
    this._custCacheBytes = (this._custCacheBytes || 0) + sz;
    for (const [k, v] of cache) { if (this._custCacheBytes <= CACHE_BYTES || k === id) break; cache.delete(k); this._custCacheBytes -= v.sz; }
  },
  _custForget(id) {
    const cache = this._custCache, v = cache && cache.get(id);
    if (v) { cache.delete(id); this._custCacheBytes -= v.sz; }
    if (this._custBad) this._custBad.delete(id);
  },
  // Pesan ringan: metadata biasa + field berat sebagai getter (enumerable, supaya JSON.stringify dan Object.assign tetap melihatnya).
  _custLazyMsg(meta) {
    const m = Object.assign({}, meta), id = meta.id, self = this;
    for (const k of HEAVY) Object.defineProperty(m, k, { enumerable: true, configurable: true, get() { const h = self._custHeavy(id); return h ? h[k] : undefined; } });
    return m;
  },
  // Salinan DATAR sebuah pesan titipan (field berat dibaca sekarang): untuk pesan yang akan disimpan lama di tempat lain (mis. store.msgs).
  _custPlain(m) { return Object.assign({}, m); },
  // Tulis segmen (format 2 baris) secara atomik.
  _writeSeg(id, c) {
    const f = segPath(this.custDir, id);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify({ at: c.at, sz: c.sz, m: metaOf(c.m) }) + '\n' + JSON.stringify(heavyOf(c.m)), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f);
  },
  // Setelah segmen tertulis, buang isi berat dari RAM: m jadi ringan. Isinya disimpan di cache (kemungkinan segera dikirim).
  _custLazy(id, c) {
    if (isLazy(c) || custClass(c.m) === 'state') return;
    const meta = metaOf(c.m), h = heavyOf(c.m);
    c.m = this._custLazyMsg(meta);
    Object.defineProperty(c, 'lz', { value: 1, enumerable: false, configurable: true, writable: true });
    this._custCachePut(id, h);
  },
  // Muat semua segmen: hanya baris 1 (metadata) yang dibaca. Format lama (satu baris berisi seluruh pesan, Step 2a) dibaca penuh lalu ditulis ulang jadi 2 baris.
  _readSegments() {
    const dir = this.custDir, out = {};
    let shards = [];
    try { shards = fs.readdirSync(dir); } catch { return out; }
    const buf = Buffer.alloc(HEAD_READ);
    for (const sh of shards) {
      if (!/^[0-9a-f]{2}$/.test(sh)) continue;
      let files = [];
      try { files = fs.readdirSync(path.join(dir, sh)); } catch { continue; }
      for (const f of files) {
        const fp = path.join(dir, sh, f);
        if (f.endsWith('.tmp')) { try { fs.unlinkSync(fp); } catch {} continue; }
        if (!SEG_RE.test(f)) continue;
        const id = f.slice(0, 32);
        const bad = () => this.log('segmen titipan rusak dilewati: ' + id);
        let head = null, n = 0, fd;
        try { fd = fs.openSync(fp, 'r'); n = fs.readSync(fd, buf, 0, HEAD_READ, 0); } catch { bad(); continue; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
        const nl = buf.subarray(0, n).indexOf(10);
        if (nl >= 0) { try { head = JSON.parse(buf.toString('utf8', 0, nl)); } catch {} }
        if (head && head.m && typeof head.m === 'object' && head.m.id === id && id.slice(0, 2) === sh && Number.isFinite(head.at) && Number.isFinite(head.sz) && !('text' in head.m)) {
          out[id] = { m: this._custLazyMsg(head.m), at: head.at, sz: head.sz };
          Object.defineProperty(out[id], 'lz', { value: 1, enumerable: false, configurable: true, writable: true });
          continue;
        }
        const old = readJson(fp); // format 2a: {m (lengkap), at}
        if (!old || !old.m || typeof old.m !== 'object' || old.m.id !== id || id.slice(0, 2) !== sh || typeof old.m.text !== 'string' || !Number.isFinite(old.at)) { bad(); continue; }
        const c = { m: old.m, at: old.at, sz: custCost(old.m) };
        try { this._writeSeg(id, c); this._custLazy(id, c); } catch (e) { this.log('segmen lama gagal dikonversi ' + id + ': ' + e.message); }
        out[id] = c;
      }
    }
    return out;
  },
};

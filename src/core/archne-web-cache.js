'use strict';
// src/core/archne-web-cache.js — Web Lokal (0.34.0 Fase C.2, bagian 4.5 rencana): cache penonton berbasis hash.
// Letak: <dataDir>/webcache/<idPemilik>/<siteId>/ berisi
//   blobs/<sha256 heks>   = isi berkas menurut hash (satu salinan walau dipakai banyak jalur); selalu sudah diverifikasi hash sebelum masuk (webRemoteFile menulis .part lalu rename)
//   manifest.json         = { v:1, rev, entry, ts, files:[{ p, size, hash }] }, ditulis TERAKHIR (titik komit): sinkron yang terputus tidak merusak keadaan cache sebelumnya.
// webCacheSync: ambil manifest baru (murah), unduh HANYA berkas yang hash-nya belum ada di blobs/, tulis manifest, lalu buang blob yang tidak dirujuk lagi.
// Salinan ini juga tampilan baca-saja saat pemilik offline (webCacheRead). Jalur berkas selalu lewat manifest (tryRel) dan nama blob = hash heks tervalidasi, jadi tidak ada jalur dari peer yang menyentuh disk.
// BELUM (sengaja, dikerjakan bersama pengaturan di Fase D/E): kuota ukuran dan LRU antar situs. Sekarang hanya satu versi per situs yang disimpan (blob usang dibuang saat sinkron berikutnya).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HEX16 } = require('./archne-constants');
const { tryRel } = require('../archne-webfiles');

const H64 = /^[0-9a-f]{64}$/;
const E = (code, msg) => Object.assign(new Error(msg), { code });

module.exports = {
  _lwCacheDir(ownerId, siteId) {
    if (typeof ownerId !== 'string' || !HEX16.test(ownerId) || typeof siteId !== 'string' || !HEX16.test(siteId)) throw E('bad', 'Permintaan tidak valid');
    return path.join(this.opts.dataDir, 'webcache', ownerId, siteId);
  },
  // Manifest tersimpan { rev, entry, ts, files } atau null (belum ada / rusak). Dibaca ulang dari disk dan divalidasi tiap kali.
  webCacheManifest(ownerId, siteId) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(this._lwCacheDir(ownerId, siteId), 'manifest.json'), 'utf8')); } catch { return null; }
    if (!j || j.v !== 1 || !Number.isSafeInteger(j.rev) || j.rev < 1 || !Number.isSafeInteger(j.ts) || !Array.isArray(j.files)) return null;
    const entry = tryRel(j.entry);
    if (!entry || entry !== j.entry) return null;
    const files = [], seen = new Set();
    for (const f of j.files) {
      if (!f || typeof f.p !== 'string' || tryRel(f.p) !== f.p || seen.has(f.p) || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.hash !== 'string' || !H64.test(f.hash)) return null;
      seen.add(f.p); files.push({ p: f.p, size: f.size, hash: f.hash });
    }
    return { rev: j.rev, entry, ts: j.ts, files };
  },
  // Isi satu berkas dari cache: Buffer atau null (tidak ada di manifest / blob hilang atau ukurannya tak cocok / lebih besar dari opts.max).
  webCacheRead(ownerId, siteId, p, opts) {
    const m = this.webCacheManifest(ownerId, siteId);
    if (!m || typeof p !== 'string') return null;
    const f = m.files.find((x) => x.p === p);
    if (!f) return null;
    const max = opts && Number.isFinite(opts.max) ? opts.max : Infinity;
    if (f.size > max) return null;
    try {
      const file = path.join(this._lwCacheDir(ownerId, siteId), 'blobs', f.hash), st = fs.statSync(file);
      if (!st.isFile() || st.size !== f.size) return null;
      return fs.readFileSync(file);
    } catch { return null; }
  },
  // Aliran baca satu blob cache (penampil situs, F.1): Readable atau null (blob hilang / ukurannya tak cocok / rentang tak sah). Penampil tidak pernah menerima jalur berkas: hash dan ukuran
  // berasal dari manifest yang sudah divalidasi, nama blob = hash heks tervalidasi. start / end = rentang byte inklusif (bawaan: seluruh berkas).
  webCacheStream(ownerId, siteId, hash, size, start, end) {
    if (typeof hash !== 'string' || !H64.test(hash) || !Number.isSafeInteger(size) || size < 1) return null;
    const a = start === undefined ? 0 : start, b = end === undefined ? size - 1 : end;
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < a || b >= size) return null;
    try {
      const file = path.join(this._lwCacheDir(ownerId, siteId), 'blobs', hash), st = fs.statSync(file);
      if (!st.isFile() || st.size !== size) return null;
      return fs.createReadStream(file, { start: a, end: b });
    } catch { return null; }
  },
  webCacheDrop(ownerId, siteId) {
    fs.rmSync(this._lwCacheDir(ownerId, siteId), { recursive: true, force: true });
    return true;
  },
  // Sinkronkan cache satu situs dengan pemilik. -> null (situs tidak ada / bukan untukku / diblokir: cache TIDAK disentuh) atau { rev, entry, files, fetched, reused, bytes }.
  // opts: { signal (AbortSignal), onProgress({ done, total, p }) }. Panggilan bersamaan untuk situs yang sama berbagi satu pekerjaan. Galat dari webRemoteManifest / webRemoteFile diteruskan.
  webCacheSync(peerId, siteId, opts) {
    const key = String(peerId) + '/' + String(siteId), run = this._lwSyncs || (this._lwSyncs = new Map());
    if (run.has(key)) return run.get(key);
    const pr = this._webCacheSync(String(peerId), siteId, opts || {}).finally(() => run.delete(key));
    run.set(key, pr);
    return pr;
  },
  async _webCacheSync(peerId, siteId, opts) {
    const dir = this._lwCacheDir(peerId, siteId), blobs = path.join(dir, 'blobs');
    const man = await this.webRemoteManifest(peerId, siteId, { signal: opts.signal });
    if (!man) return null;
    fs.mkdirSync(blobs, { recursive: true });
    const need = new Map(); // hash -> { size, p } (satu unduhan per isi yang sama)
    for (const f of man.files) {
      if (need.has(f.hash)) continue;
      let have = false;
      try { const st = fs.statSync(path.join(blobs, f.hash)); have = st.isFile() && st.size === f.size; } catch {}
      if (!have) need.set(f.hash, { size: f.size, p: f.p });
    }
    const total = need.size, reused = new Set(man.files.map((f) => f.hash)).size - total;
    let done = 0, bytes = 0;
    for (const [hash, f] of need) {
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('Pengambilan dibatalkan.'), { code: 'cancel' });
      bytes += await this.webRemoteFile(peerId, siteId, f.p, { size: f.size, hash }, path.join(blobs, hash), { signal: opts.signal });
      done++;
      if (typeof opts.onProgress === 'function') { try { opts.onProgress({ done, total, p: f.p }); } catch {} }
    }
    const tmp = path.join(dir, 'manifest.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, rev: man.rev, entry: man.entry, ts: Date.now(), files: man.files }), { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, 'manifest.json')); // titik komit
    const keep = new Set(man.files.map((f) => f.hash));
    for (const name of fs.readdirSync(blobs)) if (!keep.has(name)) { try { fs.rmSync(path.join(blobs, name), { force: true }); } catch {} } // blob usang dan sisa .part
    return { rev: man.rev, entry: man.entry, files: man.files.length, fetched: total, reused, bytes };
  },
};

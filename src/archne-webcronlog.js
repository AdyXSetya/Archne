'use strict';
// src/archne-webcronlog.js — Log eksekusi cron milik pemilik (Cronjob C5). Hanya data: tanpa timer, tanpa IPC, tanpa isi jawaban PHP.
// Menyimpan N eksekusi TERAKHIR (bukan semua) di SATU berkas di LUAR folder situs (<dataDir>/webcron/log.json), sehingga situs yang diekspor / diterima dari peer tidak membawa log.
// Berkas { v:1, recs:[rec, ...] } urut lama -> baru. Atomik (.tmp lalu rename), mode 0600. Rusak => dipindah ke log.json.bad dan log mulai kosong (butir rusak dibuang satu-satu, yang sehat tetap).
//   rec = { id, site, reason:'schedule'|'missed'|'manual', at, startedAt|null, endedAt, ok, code?, status? }   (bentuk yang dikeluarkan archne-webcron lewat onRun)
//   + path?, name? = salinan jalur / nama job saat eksekusi (agar log tidak berubah ketika job diedit). Hanya kolom itu yang disimpan; kolom lain dibuang. Isi jawaban PHP / header tidak pernah masuk log.
// API: new CronLog(file, { perJob:20, total:200, jobExists(id)->bool })
//   add(rec) = cocok sebagai onRun penjadwal (tidak melempar) | list({ job, site, limit }) terbaru dulu | last(job) | removeJob(id) | removeSite(site) | clear()
//   add/removeJob/removeSite/clear mengembalikan { ok:true, ... } | { ok:false, code }; code: bad | none | write
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/webcronlog.js).
const fs = require('fs'), path = require('path');

const HEX16 = /^[0-9a-f]{16}$/;
const REASONS = ['schedule', 'missed', 'manual'];
const CODE = /^[a-z0-9_-]{1,32}$/i;
const CTL = /[\u0000-\u001f\u007f]/;
const LIM = { perJob: 20, total: 200, list: 50, path: 512, name: 40 };
const fail = (code) => ({ ok: false, code });
const num = (x) => typeof x === 'number' && Number.isFinite(x);

// Bentuk baku satu catatan, atau null bila tidak sah.
function clean(r) {
  if (!r || typeof r !== 'object' || !HEX16.test(r.id) || !HEX16.test(r.site) || !REASONS.includes(r.reason)) return null; // G:shape
  if (!num(r.at) || !num(r.endedAt) || typeof r.ok !== 'boolean') return null;
  if (r.startedAt !== null && !num(r.startedAt)) return null;
  const o = { id: r.id, site: r.site, reason: r.reason, at: r.at, startedAt: r.startedAt, endedAt: r.endedAt, ok: r.ok };
  if (!r.ok) o.code = typeof r.code === 'string' && CODE.test(r.code) ? r.code : 'run'; // G:code
  if (r.status !== undefined && r.status !== null) { if (!Number.isInteger(r.status) || r.status < 100 || r.status > 599) return null; o.status = r.status; }
  // Salinan jalur + nama job SAAT dieksekusi (job bisa diubah lewat Edit; log tidak boleh ikut berubah). Tidak sah / terlalu panjang = dibuang, bukan menolak catatan.
  if (typeof r.path === 'string' && r.path.length > 0 && r.path.length <= LIM.path && !CTL.test(r.path)) o.path = r.path; // G:snap
  if (typeof r.name === 'string' && r.name.length > 0 && r.name.length <= LIM.name && !CTL.test(r.name)) o.name = r.name;
  return o;
}

class CronLog {
  constructor(file, opts) {
    opts = opts || {};
    this.file = path.resolve(file);
    this.perJob = opts.perJob > 0 ? opts.perJob : LIM.perJob;
    this.total = opts.total > 0 ? opts.total : LIM.total;
    this.jobExists = typeof opts.jobExists === 'function' ? opts.jobExists : null;
    this.recovered = false;
    this.recs = this._load();
    this.add = this.add.bind(this); // dipasang langsung sebagai onRun
  }
  _load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    try {
      const o = JSON.parse(raw);
      if (!o || o.v !== 1 || !Array.isArray(o.recs)) throw new Error('bentuk');
      const out = []; for (const r of o.recs) { const c = clean(r); if (c) out.push(c); }
      return this._trim(out);
    } catch {
      try { fs.renameSync(this.file, this.file + '.bad'); } catch { /* */ }
      this.recovered = true; return [];
    }
  }
  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ v: 1, recs: this.recs }), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
      return true;
    } catch { return false; }
  }
  // Batas per job lalu batas total: yang paling lama dibuang dulu.
  _trim(a) {
    const seen = new Map(); const keep = [];
    for (let i = a.length - 1; i >= 0; i--) { const n = (seen.get(a[i].id) || 0) + 1; seen.set(a[i].id, n); if (n <= this.perJob) keep.push(a[i]); } // G:perjob
    keep.reverse();
    return keep.length > this.total ? keep.slice(keep.length - this.total) : keep; // G:total
  }
  add(rec) {
    try {
      const c = clean(rec); if (!c) return fail('bad');
      if (this.jobExists && !this.jobExists(c.id)) return fail('none'); // G:jobexists  (job dihapus saat sedang jalan: tidak meninggalkan catatan yatim)
      const old = this.recs;
      this.recs = this._trim(old.concat(c));
      if (!this._save()) return { ok: false, code: 'write', kept: true }; // tetap ada di memori; sesi berikutnya hilang
      return { ok: true };
    } catch { return fail('bad'); }
  }
  // Terbaru dulu. job / site menyaring; limit 1..200 (bawaan 50).
  list(o) {
    o = o || {};
    const lim = Number.isInteger(o.limit) && o.limit > 0 ? Math.min(o.limit, this.total) : LIM.list;
    const out = [];
    for (let i = this.recs.length - 1; i >= 0 && out.length < lim; i--) {
      const r = this.recs[i];
      if (o.job !== undefined && r.id !== o.job) continue;
      if (o.site !== undefined && r.site !== o.site) continue;
      out.push({ ...r });
    }
    return out;
  }
  last(job) { const l = this.list({ job, limit: 1 }); return l.length ? l[0] : null; }
  _drop(pred) {
    const keep = this.recs.filter((r) => !pred(r)), n = this.recs.length - keep.length;
    if (!n) return { ok: true, removed: 0 };
    const old = this.recs; this.recs = keep;
    if (!this._save()) { this.recs = old; return fail('write'); }
    return { ok: true, removed: n };
  }
  removeJob(id) { return this._drop((r) => r.id === id); } // G:removejob
  removeSite(site) { return this._drop((r) => r.site === site); }
  clear() { return this._drop(() => true); }
}
module.exports = { CronLog, LIM, clean };

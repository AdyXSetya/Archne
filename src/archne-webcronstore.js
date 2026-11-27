'use strict';
// src/archne-webcronstore.js — Daftar cron milik pemilik (Cronjob C2). Hanya data: tanpa timer, tanpa menjalankan apa pun, tanpa IPC.
// Disimpan di SATU berkas di LUAR folder situs (<dataDir>/webcron/cron.json), jadi situs yang diekspor / diterima dari peer tidak pernah membawa cron sendiri.
// Berkas { v:1, jobs:[{ id, site, expr, path, name, on, ms, miss, ts, rev }] }. Atomik (.tmp lalu rename), mode 0600. Rusak => dipindah ke cron.json.bad dan daftar mulai kosong (tidak menimpa diam-diam).
//   id   = 16 heks acak | site = id situs (16 heks, harus ada di penyimpanan situs bila siteExists disuntik)
//   expr = ekspresi 5 kolom / preset yang LOLOS archne-cronexpr, disimpan dalam bentuk rapi | path = jalur di situs itu: diawali "/", tanpa skema / host / "..", maks 512 (PHP atau URL; yang menjalankan = C4)
//   name = label bebas <= 40 (tanpa karakter kendali) | on = boolean (bawaan true) | ms = batas waktu satu eksekusi 1 dtk..5 mnt (bawaan 5 mnt)
//   miss = aturan job terlewat: 'skip' (bawaan, lompati) | 'once' (jalankan sekali saat penjadwal hidup lagi); dipakai C3
// API: new CronStore(file, { siteExists(id)->bool, maxJobs:50, maxPerSite:10, limitsFor(site)->{ perSite, msMax, custom }|null, now()->ms })
//   limitsFor (pengaturan situs, archne-weblimits.js): batas cron PER SITUS. perSite menggantikan maxPerSite; msMax (ms) menggantikan batas atas 5 menit; custom:true = pemilik mengubahnya, sehingga batas total (maxJobs) tidak lagi membatasi situs itu.
//   list(site?) get(id) add(o) update(id, patch) remove(id) removeSite(site) -> semuanya mengembalikan { ok:true, ... } | { ok:false, code } dan TIDAK melempar untuk masukan buruk.
//   code: bad | site | nosite | expr | path | name | ms | miss | on | limit | limitsite | none | write
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { parse } = require('./archne-cronexpr');

const HEX16 = /^[0-9a-f]{16}$/;
const CTL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const LIM = { jobs: 50, perSite: 10, path: 512, name: 40, msMin: 1000, msMax: 300000, msAbs: 3600000 }; // msMax = bawaan batas job; msAbs = pagar mutlak (pemilik bisa menaikkan batas per situs sampai 1 jam)
const MISS = ['skip', 'once'];
const fail = (code) => ({ ok: false, code });

function normPath(p) {
  if (typeof p !== 'string' || !p || p.length > LIM.path) return null;
  if (p[0] !== '/' || p[1] === '/' || p[1] === '\\' || CTL.test(p) || p.includes('\\') || p.includes('#')) return null; // G:path-shape
  const pn = p.split('?')[0];
  if (pn.split('/').some((s) => { let d = s; try { d = decodeURIComponent(s); } catch { return true; } return d === '..' || d === '.' || d.includes('/') || d.includes('\\') || CTL.test(d); })) return null; // G:path-dots
  return p;
}
function cleanName(n) {
  if (n === undefined || n === null) return '';
  if (typeof n !== 'string' || n.length > LIM.name || CTL.test(n)) return null; // G:name
  return n.trim();
}
const clone = (j) => ({ ...j });

class CronStore {
  constructor(file, opts) {
    opts = opts || {};
    this.file = path.resolve(file);
    this.siteExists = typeof opts.siteExists === 'function' ? opts.siteExists : null;
    this.maxJobs = opts.maxJobs > 0 ? opts.maxJobs : LIM.jobs;
    this.maxPerSite = opts.maxPerSite > 0 ? opts.maxPerSite : LIM.perSite;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.limitsFor = typeof opts.limitsFor === 'function' ? opts.limitsFor : null;
    this.recovered = false;
    this.jobs = this._load();
  }
  _load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    try {
      const o = JSON.parse(raw);
      if (!o || o.v !== 1 || !Array.isArray(o.jobs)) throw new Error('bentuk');
      const seen = new Set(), out = [];
      for (const j of o.jobs) { const c = this._check(j); if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); } } // butir rusak dibuang satu-satu, yang sehat tetap
      return out;
    } catch {
      try { fs.renameSync(this.file, this.file + '.bad'); } catch { /* */ }
      this.recovered = true; return [];
    }
  }
  // Pemeriksaan bentuk satu butir (dipakai saat memuat DAN saat menyimpan). Tidak memeriksa keberadaan situs.
  _check(j) {
    if (!j || typeof j !== 'object' || !HEX16.test(j.id) || !HEX16.test(j.site)) return null;
    const p = parse(j.expr), pt = normPath(j.path), nm = cleanName(j.name);
    if (!p.ok || pt === null || nm === null) return null;
    if (typeof j.on !== 'boolean' || !MISS.includes(j.miss)) return null;
    if (!Number.isInteger(j.ms) || j.ms < LIM.msMin || j.ms > LIM.msAbs) return null;
    if (!Number.isFinite(j.ts) || !Number.isInteger(j.rev) || j.rev < 1) return null;
    return { id: j.id, site: j.site, expr: j.expr, path: pt, name: nm, on: j.on, ms: j.ms, miss: j.miss, ts: j.ts, rev: j.rev };
  }
  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const s = JSON.stringify({ v: 1, jobs: this.jobs }, null, 1);
      fs.writeFileSync(this.file + '.tmp', s, { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
      return true;
    } catch { return false; }
  }
  // Menyusun butir dari masukan (add: bawaan terisi; update: dasar = butir lama). Mengembalikan { ok, job } | { ok:false, code }.
  // Batas cron efektif satu situs: dari limitsFor bila ada (gagal / bentuk aneh = bawaan).
  limitsOf(site) {
    let l = null; if (this.limitsFor) { try { l = this.limitsFor(site); } catch { l = null; } }
    const ok = l && Number.isInteger(l.perSite) && l.perSite > 0 && Number.isInteger(l.msMax) && l.msMax >= LIM.msMin;
    return ok ? { perSite: l.perSite, msMax: l.msMax, custom: l.custom === true } : { perSite: this.maxPerSite, msMax: LIM.msMax, custom: false };
  }
  _build(base, o) {
    if (!o || typeof o !== 'object') return fail('bad');
    const j = { ...base }, msMax = this.limitsOf(base.site).msMax;
    if ('expr' in o) { const p = parse(o.expr); if (!p.ok) return fail('expr'); j.expr = o.expr.trim().replace(/\s+/g, ' '); } // G:expr
    if ('path' in o) { const p = normPath(o.path); if (p === null) return fail('path'); j.path = p; }
    if ('name' in o) { const n = cleanName(o.name); if (n === null) return fail('name'); j.name = n; }
    if ('on' in o) { if (typeof o.on !== 'boolean') return fail('on'); j.on = o.on; }
    if ('ms' in o) { if (!Number.isInteger(o.ms) || o.ms < LIM.msMin || o.ms > msMax) return fail('ms'); j.ms = o.ms; } // G:ms
    if ('miss' in o) { if (!MISS.includes(o.miss)) return fail('miss'); j.miss = o.miss; }
    return { ok: true, job: j };
  }
  list(site) { return this.jobs.filter((j) => site === undefined || j.site === site).map(clone); }
  get(id) { const j = this.jobs.find((x) => x.id === id); return j ? clone(j) : null; }
  add(o) {
    if (!o || typeof o !== 'object' || typeof o.site !== 'string' || !HEX16.test(o.site)) return fail('site');
    if (this.siteExists && !this.siteExists(o.site)) return fail('nosite'); // G:nosite
    const lf = this.limitsOf(o.site);
    if (!lf.custom && this.jobs.length >= this.maxJobs) return fail('limit'); // G:limit  (situs dengan batas cron buatan pemilik tidak dibatasi total global)
    if (this.jobs.filter((j) => j.site === o.site).length >= lf.perSite) return fail('limitsite'); // G:limitsite
    if (!('expr' in o) || !('path' in o)) return fail(!('expr' in o) ? 'expr' : 'path');
    const b = this._build({ id: crypto.randomBytes(8).toString('hex'), site: o.site, expr: '', path: '', name: '', on: true, ms: Math.min(LIM.msMax, lf.msMax), miss: 'skip', ts: this.now(), rev: 1 }, o);
    if (!b.ok) return b;
    this.jobs.push(b.job);
    if (!this._save()) { this.jobs.pop(); return fail('write'); }
    return { ok: true, job: clone(b.job) };
  }
  update(id, patch) {
    const i = this.jobs.findIndex((x) => x.id === id);
    if (i < 0) return fail('none');
    if (patch && typeof patch === 'object' && ('site' in patch || 'id' in patch)) return fail('bad'); // G:immutable (situs dan id tidak boleh dipindah)
    const b = this._build(this.jobs[i], patch);
    if (!b.ok) return b;
    b.job.rev = this.jobs[i].rev + 1;
    const old = this.jobs[i]; this.jobs[i] = b.job;
    if (!this._save()) { this.jobs[i] = old; return fail('write'); }
    return { ok: true, job: clone(b.job) };
  }
  remove(id) {
    const i = this.jobs.findIndex((x) => x.id === id);
    if (i < 0) return fail('none');
    const [old] = this.jobs.splice(i, 1);
    if (!this._save()) { this.jobs.splice(i, 0, old); return fail('write'); }
    return { ok: true };
  }
  // Dipanggil saat situs dihapus: tidak boleh ada cron yatim.
  removeSite(site) {
    const keep = this.jobs.filter((j) => j.site !== site), n = this.jobs.length - keep.length;
    if (!n) return { ok: true, removed: 0 };
    const old = this.jobs; this.jobs = keep;
    if (!this._save()) { this.jobs = old; return fail('write'); }
    return { ok: true, removed: n };
  }
}
module.exports = { CronStore, LIM };

'use strict';
// src/archne-ipc-webcron.js — Kanal IPC cron (Cronjob C6). Dipanggil dari registerWeb() di src/archne-ipc-web.js. HANYA UNTUK PEMILIK: kanal ini ada di ipcMain Electron dan di /rpc (token + cookie + Host), tidak ada di protokol peer,
// lw_req, penyaji situs, maupun router PHP. Situs (milik sendiri atau dari peer) tidak bisa membuat, mengubah, atau menjalankan cron.
// Layanannya (src/archne-webcronhost.js) disuntik lewat getCron(); null (mis. tanpa Mesin PHP) = semua kanal berubah menjadi galat 'nocron' kecuali webCronCheck (murni).
//   webCronList(site?)                    -> { ok, items:[{ id, site, domain, expr, path, name, on, ms, miss, ts, rev, next, state:'idle'|'running'|'queued', last }], limits:{ jobs, perSite }, running }
//                                            siteLimits = { [idSitus]: { perSite, ms } } HANYA untuk situs yang batas cron-nya diubah pemilik (Pengaturan situs); limits tetap batas bawaan.
//                                            next = ms jadwal berikut | null (job mati / tak ada jadwal); last = catatan log terakhir | null. Terbaru-dibuat dulu. Tanpa jalur disk.
//   webCronAdd({ site, expr, path, name?, on?, ms?, miss? }) -> { ok, job }   situs harus ada DAN Mesin PHP-nya menyala ('nophp'). path wajib (diawali "/").
//   webCronUpdate(id, { expr?, path?, name?, on?, ms?, miss? }) -> { ok, job }   site / id tidak bisa diubah ('bad'); tambalan kosong = 'bad'.
//   webCronRemove(id)                     -> { ok:true }   daftar + lognya
//   webCronRun(id)                        -> { ok:true } | galat 'none' | 'overlap' | 'stopped'   hasilnya datang sebagai kejadian 'webcron' dan masuk log
//   webCronLog({ job?, site?, limit? })   -> { ok, items:[rec] } terbaru dulu (limit 1..200, bawaan 50)
//   webCronLogClear(job?)                 -> { ok, removed }
//   webCronCheck(expr)                    -> { ok:true, expr, next:[ms x5] } | { ok:false, code:'expr' }  cek langsung saat mengetik; tanpa tulis, tanpa layanan
//   Kejadian 'webcron' (send): { id, site, reason, ok, code?, status?, endedAt } setiap eksekusi selesai (termasuk 'overlap'). Tanpa isi jawaban PHP.
// Galat: { ok:false, err, code } seperti kanal web lain; err berkunci i18n e.cron.*.
const { ek } = require('./core/archne-ecode');
const { parse, nextRun } = require('./archne-cronexpr');
const T = require('./core/archne-i18n-node').tr;

const HEX16 = /^[0-9a-f]{16}$/;
const ADD = ['site', 'expr', 'path', 'name', 'on', 'ms', 'miss'];
const PATCH = ['expr', 'path', 'name', 'on', 'ms', 'miss'];
const STR_MAX = { expr: 200, path: 1000, name: 200, miss: 16 }; // batas kasar sebelum diperiksa CronStore (batas sebenarnya: expr 100, path 512, name 40)

// kode galat -> [kunci kamus, teks Indonesia]; {max} diisi per pemanggilan
const ERR = {
  bad: ['e.cron.bad', 'Permintaan cron tidak valid'],
  site: ['e.cron.site', 'Id situs tidak valid'],
  nosite: ['e.cron.nosite', 'Situs tidak ditemukan'],
  nophp: ['e.cron.nophp', 'Cron hanya untuk situs yang Mesin PHP-nya menyala'],
  expr: ['e.cron.expr', 'Jadwal tidak valid. Pakai 5 kolom (menit jam tanggal bulan hari) atau preset seperti @daily'],
  path: ['e.cron.path', 'Jalur harus diawali "/" dan berada di situs itu (tanpa host, "..", atau "#")'],
  name: ['e.cron.name', 'Nama maksimal 40 karakter, tanpa karakter kendali'],
  ms: ['e.cron.ms', 'Batas waktu harus antara 1 detik dan 5 menit'],
  ms2: ['e.cron.ms2', 'Batas waktu harus antara 1 dan {max} detik'], // dipakai bila batas cron situs itu diubah pemilik (Pengaturan situs); {max} = batas situs itu
  miss: ['e.cron.miss', 'Aturan job terlewat tidak dikenal'],
  on: ['e.cron.on', 'Status aktif harus benar atau salah'],
  limit: ['e.cron.limit', 'Jumlah cron sudah mencapai batas ({max})'],
  limitsite: ['e.cron.limitsite', 'Satu situs paling banyak {max} cron'],
  none: ['e.cron.none', 'Cron tidak ditemukan'],
  write: ['e.cron.write', 'Gagal menyimpan daftar cron'],
  stopped: ['e.cron.stopped', 'Penjadwal cron sedang tidak berjalan'],
  overlap: ['e.cron.overlap', 'Cron ini masih berjalan atau sudah mengantre'],
  nocron: ['e.cron.nocron', 'Cron tidak tersedia di perangkat ini'],
};
const err = (code, params) => { const m = ERR[code] || ERR.bad; return ek(m[0], params || null, m[1], ERR[code] ? code : 'bad'); }; // ek mengisi {max} dari params

// Isian dari renderer -> objek bersih (hanya bidang yang dikenal) atau null. Nilai diperiksa/dikanonkan oleh CronStore.
function pick(o, keys) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = {};
  for (const k of keys) {
    if (!(k in o) || o[k] === undefined) continue;
    const v = o[k];
    if (k === 'on') { if (typeof v !== 'boolean') return null; }
    else if (k === 'ms') { if (!Number.isInteger(v)) return null; }
    else if (k === 'site') { if (typeof v !== 'string' || !HEX16.test(v)) return null; }
    else if (typeof v !== 'string' || v.length > STR_MAX[k]) return null;
    r[k] = v;
  }
  return r;
}

function registerWebCron({ on, core, send, getCron }) {
  const svc = () => { const c = getCron && getCron(); if (!c) throw err('nocron'); return c; };
  const idOk = (id) => typeof id === 'string' && HEX16.test(id);
  // site = situs job yang sedang diubah: batas cron dibaca per situs (Pengaturan situs), bukan konstanta.
  const fromStore = (r, c, site) => { if (r && r.ok) return r; const lf = site ? c.store.limitsOf(site) : null; if (r && r.code === 'ms' && lf && lf.msMax !== 300000) throw err('ms2', { max: Math.round(lf.msMax / 1000) }); throw err(r && r.code, r && r.code === 'limit' ? { max: c.store.maxJobs } : r && r.code === 'limitsite' ? { max: lf ? lf.perSite : c.store.maxPerSite } : null); };

  // Kejadian eksekusi -> renderer. Hanya kolom ringkas; renderer menarik log lengkap lewat webCronLog bila perlu.
  const c0 = getCron && getCron();
  if (c0 && typeof send === 'function') {
    c0.on((r) => { const o = { id: r.id, site: r.site, reason: r.reason, ok: r.ok, endedAt: r.endedAt }; if (r.code !== undefined) o.code = r.code; if (r.status !== undefined) o.status = r.status; try { send('webcron', o); } catch { /* */ } });
  }

  on('webCronCheck', (expr) => {
    if (typeof expr !== 'string' || expr.length > 200) throw err('bad');
    const p = parse(expr);
    if (!p.ok) throw err('expr');
    const next = []; let t = Date.now();
    for (let i = 0; i < 5; i++) { const n = nextRun(p.spec, t); if (n === null) break; next.push(n); t = n; }
    return { ok: true, expr: expr.trim().replace(/\s+/g, ' '), next };
  });

  on('webCronList', (site) => {
    if (site != null && !idOk(site)) throw err('bad');
    const c = svc();
    const jobs = c.store.list(site == null ? undefined : site).reverse().sort((a, b) => b.ts - a.ts); // terbaru dulu; ts sama (satu milidetik) -> yang ditambahkan belakangan dulu
    const st = c.status(), dom = new Map();
    if (jobs.length) { try { for (const s of core.webStore().list()) dom.set(s.id, s.domain); } catch { /* */ } }
    return {
      ok: true,
      items: jobs.map((j) => Object.assign(j, {
        domain: dom.get(j.site) || '',
        next: Number.isFinite(st.next[j.id]) ? st.next[j.id] : null,
        state: st.running === j.id ? 'running' : st.queued.includes(j.id) ? 'queued' : 'idle',
        last: c.log.last(j.id),
      })),
      limits: { jobs: c.store.maxJobs, perSite: c.store.maxPerSite },
      ...(Object.keys(siteLim(c, jobs, site)).length ? { siteLimits: siteLim(c, jobs, site) } : {}),
      running: st.running,
    };
  });

  on('webCronAdd', (o) => {
    const f = pick(o, ADD);
    if (!f || typeof f.site !== 'string') throw err('bad');
    const c = svc(), ws = core.webStore();
    if (!ws.get(f.site).php) throw err('nophp'); // G:php-only  (ws.get melempar 'nosite' bila situsnya tidak ada)
    const r = fromStore(c.store.add(f), c, f.site);
    c.sync();
    return { ok: true, job: r.job };
  });

  on('webCronUpdate', (id, patch) => {
    if (!idOk(id)) throw err('bad');
    if (patch && typeof patch === 'object' && ('site' in patch || 'id' in patch)) throw err('bad'); // G:immutable (situs dan id tidak dipindah dari renderer)
    const f = pick(patch, PATCH);
    if (!f || !Object.keys(f).length) throw err('bad');
    const c = svc();
    const old = c.store.get(id);
    const r = fromStore(c.store.update(id, f), c, old && old.site);
    c.sync();
    return { ok: true, job: r.job };
  });

  on('webCronRemove', (id) => {
    if (!idOk(id)) throw err('bad');
    const c = svc();
    fromStore(c.removeJob(id), c);
    return { ok: true };
  });

  on('webCronRun', (id) => {
    if (!idOk(id)) throw err('bad');
    const c = svc();
    const r = c.scheduler.runNow(id);
    if (!r.ok) throw err(r.code);
    return { ok: true };
  });

  on('webCronLog', (o) => {
    if (o != null && (typeof o !== 'object' || Array.isArray(o))) throw err('bad');
    const q = {};
    if (o && o.job != null) { if (!idOk(o.job)) throw err('bad'); q.job = o.job; }
    if (o && o.site != null) { if (!idOk(o.site)) throw err('bad'); q.site = o.site; }
    if (o && o.limit != null) { if (!Number.isInteger(o.limit) || o.limit < 1) throw err('bad'); q.limit = o.limit; }
    return { ok: true, items: svc().log.list(q) };
  });

  on('webCronLogClear', (job) => {
    if (job != null && !idOk(job)) throw err('bad');
    const c = svc();
    const r = fromStore(job == null ? c.log.clear() : c.log.removeJob(job), c);
    return { ok: true, removed: r.removed || 0 };
  });

  return {};
}

// Batas cron per situs yang diubah pemilik, untuk situs yang tampil di daftar (+ situs yang diminta). Situs berbatas bawaan tidak ikut (bentuk keluaran lama tetap).
function siteLim(c, jobs, site) {
  const ids = new Set(jobs.map((j) => j.site)); if (site) ids.add(site);
  const o = {};
  for (const id of ids) { const l = c.store.limitsOf(id); if (l.custom) o[id] = { perSite: l.perSite, ms: l.msMax }; }
  return o;
}

// Dipakai webRemove (archne-ipc-web.js): cron situs dibuang SEBELUM situsnya dihapus; gagal tulis daftar = situs tidak dihapus.
function dropSiteCron(c, id) {
  if (!c) return;
  const r = c.removeSite(id); // G:site-cleanup
  if (!r.ok) throw err('write');
}

module.exports = { registerWebCron, dropSiteCron, ERR };

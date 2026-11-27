'use strict';
// src/archne-webcronhost.js — Penyambung cron (Cronjob C6): merangkai CronStore (C2) + penjadwal (C3) + penjalan (C4) + log (C5) menjadi SATU layanan milik pemilik.
// Dipakai main.js (Electron) dan archne-headless.js (peramban / Termux / Android) dengan cara yang sama. Tidak tahu IPC; kanalnya ada di archne-ipc-webcron.js.
// createCronService({ core, getPhpHost() -> host|null, log, now, timers, stateDir? }) -> {
//   store, log, scheduler, start(), stop(), sync(), removeJob(id), removeSite(site), on(fn) -> off, status() }
// Berkas (semuanya di <dataDir>/webcron/, di LUAR folder situs): cron.json (daftar), log.json (log), state.json (detak terakhir untuk job terlewat).
// Aturan:
//   - Malas: penjadwal HIDUP hanya selama ada minimal satu job (tanpa job = tanpa timer dan tanpa tulis disk tiap menit). sync() dipanggil setiap daftar berubah.
//   - Job tanpa situs (sisa kejadian terputus) dibuang saat start() bersama lognya: tidak ada cron yatim.
//   - onRun penjadwal = log.add. Penjalan yang hilang PHP-nya (host null / ditutup) menghasilkan code 'site' di log, bukan galat.
//   - on(fn): pendengar hasil eksekusi (UI Dasbor C7). Pendengar yang melempar tidak mengganggu apa pun.
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/webcronipc.js).
const path = require('path');
const { CronStore } = require('./archne-webcronstore');
const { CronLog } = require('./archne-webcronlog');
const { createScheduler } = require('./archne-webcron');
const { createCronRunner } = require('./archne-webcronrun');
const WL = require('./archne-weblimits');

function createCronService(o) {
  if (!o || !o.core) throw new Error('createCronService: core wajib');
  const core = o.core, log = o.log || (() => {});
  const dir = o.stateDir || path.join(core.opts.dataDir, 'webcron');
  const listeners = new Set();
  let alive = false;

  // siteExists / jobExists disuntik: situs diperiksa SAAT dipakai (core.webStore() membuat folder web/ bila belum ada, jadi tidak disentuh saat konstruksi).
  // Batas cron per situs (pengaturan situs): dibaca dari WebStore SAAT dipakai. Core tiruan tanpa limitsRaw / situs hilang = bawaan (null).
  const limRaw = (id) => { try { const ws = core.webStore(); return typeof ws.limitsRaw === 'function' && ws.has(id) ? ws.limitsRaw(id) : null; } catch { return null; } };
  const limitsFor = (id) => WL.cronOf(limRaw(id));
  const store = new CronStore(path.join(dir, 'cron.json'), { siteExists: (id) => core.webStore().has(id), limitsFor }); // G:site-exists
  const clog = new CronLog(path.join(dir, 'log.json'), { jobExists: (id) => !!store.get(id) }); // G:job-exists
  if (store.recovered) log('cron.json rusak, dipindah ke .bad; daftar cron mulai kosong');
  if (clog.recovered) log('log.json cron rusak, dipindah ke .bad; log mulai kosong');

  const run = createCronRunner({ router: (siteId) => { const h = o.getPhpHost && o.getPhpHost(); if (!h || typeof h.cron !== 'function') return null; return h.cron(siteId); } });
  const scheduler = createScheduler({
    store, run, now: o.now, timers: o.timers, stateFile: path.join(dir, 'state.json'),
    capMs: (job) => { const l = limRaw(job.site); return l && l.cronMs !== undefined ? l.cronMs * 1000 : null; }, // hanya bila pemilik mengatur batas cron situs
    onRun: (rec) => {
      try { clog.add(rec); } catch { /* */ }
      for (const fn of [...listeners]) { try { fn(rec); } catch { /* */ } }
    },
  });

  function prune() { // job yang situsnya sudah tidak ada
    const jobs = store.list();
    if (!jobs.length) return;
    let ws; try { ws = core.webStore(); } catch { return; }
    for (const site of new Set(jobs.map((j) => j.site))) if (!ws.has(site)) { store.removeSite(site); clog.removeSite(site); } // G:prune
  }
  function sync() {
    if (!alive) return;
    if (store.list().length) { scheduler.start(); scheduler.refresh(); } // G:lazy-start (start() ganda aman; refresh membaca ulang rev)
    else scheduler.stop();
  }

  return {
    store, log: clog, scheduler,
    start() { if (alive) return; alive = true; prune(); sync(); },
    stop() { alive = false; scheduler.stop(); listeners.clear(); },
    sync,
    // Hapus job: daftar dulu (sumber kebenaran), lalu lognya. Kegagalan log tidak membatalkan (log hanya catatan).
    removeJob(id) { const r = store.remove(id); if (r.ok) { clog.removeJob(id); sync(); } return r; },
    // Dipanggil SEBELUM situsnya dihapus. Gagal tulis daftar = situs jangan dihapus (kembali { ok:false }).
    removeSite(site) { const r = store.removeSite(site); if (r.ok) { clog.removeSite(site); sync(); } return r; },
    on(fn) { if (typeof fn !== 'function') return () => {}; listeners.add(fn); return () => listeners.delete(fn); },
    status() { return scheduler.status(); },
  };
}

module.exports = { createCronService };

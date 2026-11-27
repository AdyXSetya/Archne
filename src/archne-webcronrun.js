'use strict';
// src/archne-webcronrun.js — Penjalan cron (Cronjob C4). Menjalankan SATU job: GET ke path situs lewat router PHP milik cron (host.cron(siteId)).
// createCronRunner({ router(siteId) -> { handle(req), stop() } }) -> run(job, { signal }) -> Promise<{ ok, code?, status? }>   (bentuk yang diminta archne-webcron.createScheduler)
// Aturan:
//   - Router cron memakai pool SENDIRI (archne-phphost: cron(siteId)): tidak memakai slot Worker pengunjung dan tidak antre di belakang permintaan mereka.
//   - Path berasal dari job.path (sudah divalidasi CronStore: diawali "/", tanpa skema / host / ".."). Skrip .php, path URL (front controller), atau berkas statis semuanya lewat router yang sama.
//   - Selalu GET, tanpa cookie, tanpa peer (router cron tidak menerima peer). PHP mengenali eksekusi cron dari $_SERVER['ARCHNE_CRON'] === '1'.
//   - Sukses = status 2xx atau 3xx (pengalihan tidak diikuti dan tidak dianggap gagal; path yang salah adalah tanggung jawab pemilik). Selain itu { ok:false, code, status }: 'timeout' (504), 'busy' (503), 'http' (4xx / 5xx lainnya).
//   - Situs hilang / bukan PHP / host ditutup = 'site'. Router yang melempar = 'run'.
//   - signal abort (batas waktu penjadwal atau stop) = Worker cron situs itu dihentikan (router.stop()); PHP yang menggantung tidak dibiarkan hidup. Hasilnya diabaikan penjadwal.
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/webcronrun.js).

const UA = 'Archne-Cron';

function createCronRunner(o) {
  if (!o || typeof o.router !== 'function') throw new Error('createCronRunner: router wajib');

  return async function run(job, ctx) {
    const signal = ctx && ctx.signal;
    if (signal && signal.aborted) return { ok: false, code: 'abort' }; // G:pre-abort
    let r;
    try { r = o.router(job.site); } catch { return { ok: false, code: 'site' }; }
    if (!r || typeof r.handle !== 'function') return { ok: false, code: 'site' };

    let onAbort = null;
    if (signal && typeof signal.addEventListener === 'function') {
      onAbort = () => { try { r.stop(); } catch { /* */ } }; // G:abort-stop
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const i = job.path.indexOf('?');
      const req = { method: 'GET', path: i < 0 ? job.path : job.path.slice(0, i), query: i < 0 ? '' : job.path.slice(i + 1), headers: { 'user-agent': UA }, host: 'localhost', peer: '' }; // G:get-shape
      const res = await r.handle(req);
      const st = res && Number.isInteger(res.status) ? res.status : 0;
      if (st >= 200 && st < 400) return { ok: true, status: st }; // G:status-ok
      if (st === 0) return { ok: false, code: 'run' };
      return { ok: false, code: st === 504 ? 'timeout' : st === 503 ? 'busy' : 'http', status: st };
    } catch {
      return { ok: false, code: 'run' };
    } finally {
      if (onAbort) { try { signal.removeEventListener('abort', onAbort); } catch { /* */ } }
    }
  };
}

module.exports = { createCronRunner };

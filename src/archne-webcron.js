'use strict';
// src/archne-webcron.js — Penjadwal cron di Core (Cronjob C3). Logika saja: jam, timer, dan "penjalan" DISUNTIK; tidak tahu PHP, HTTP, IPC, atau UI (itu C4-C7).
// createScheduler({ store (CronStore), run(job, { signal }) -> Promise<{ ok, code?, status? }>, onRun(rec), now(), timers:{ set(fn, ms), clear(id) }, stateFile })
//   -> { start(), stop(), refresh(), runNow(id), status() }
// Aturan:
//   - Satu job berjalan SEKALIGUS (tidak ada paralel); yang jatuh tempo bersamaan antre FIFO. Job yang sama tidak diantrekan dua kali: yang kedua dicatat code 'overlap' dan dilewati.
//   - Tiap job punya batas waktu (job.ms): lewat itu AbortSignal dipicu dan hasil dicatat 'timeout'; hasil susulan penjalan yang lambat diabaikan. Penjalan yang melempar / mengembalikan bentukan aneh = code 'run'; penjadwal jalan terus.
//   - Detak tiap menit (tick). Job jatuh tempo dijalankan SEKALI walau terlambat (tanpa rentetan susulan).
//   - Job terlewat (aplikasi mati / perangkat tidur lebih dari 150 dtk / awal start): hanya job miss:'once' yang dijalankan, SEKALI per job, bila ada jadwal dalam selang itu; miss:'skip' dilompati. Batas bawah selang = max(terakhir terlihat, waktu job dibuat).
//     "Terakhir terlihat" = detak yang dicatat di stateFile (null = tanpa catatan = tanpa penyusulan). Jam mundur: tidak menjalankan apa pun, jadwal dihitung ulang dari jam baru.
//   - Job mati (on:false) tidak jalan terjadwal maupun menyusul; runNow tetap boleh. Job baru / diubah (rev berubah, lewat refresh) dihitung dari SEKARANG: tidak langsung jalan.
//   - rec = { id, site, reason:'schedule'|'missed'|'manual', at, startedAt, endedAt, ok, code?, status?, path?, name? } (path / name = salinan job saat itu); code: timeout | run | abort | overlap | (kode dari penjalan). onRun yang melempar tidak merusak penjadwal.
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/webcron.js).
const fs = require('fs'), path = require('path');
const { parse, nextRun } = require('./archne-cronexpr');

const TICK_MS = 60000, WAKE_MS = 150000;

function createScheduler(opts) {
  opts = opts || {};
  const store = opts.store, runner = opts.run;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const T = opts.timers || { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) };
  const snap = (job) => { const o = {}; if (job && typeof job.path === 'string' && job.path) o.path = job.path; if (job && typeof job.name === 'string' && job.name) o.name = job.name; return o; };
  const emit = (rec) => { if (typeof opts.onRun === 'function') { try { opts.onRun(rec); } catch { /* */ } } };

  let started = false, timer = null, lastTick = null, running = null;
  const queue = [], meta = new Map(); // meta: id -> { rev, spec, next }

  const seenRead = () => { if (!opts.stateFile) return null; try { const o = JSON.parse(fs.readFileSync(opts.stateFile, 'utf8')); return o && o.v === 1 && Number.isFinite(o.seen) ? o.seen : null; } catch { return null; } };
  const seenWrite = (t) => {
    if (!opts.stateFile) return;
    try { fs.mkdirSync(path.dirname(opts.stateFile), { recursive: true }); fs.writeFileSync(opts.stateFile + '.tmp', JSON.stringify({ v: 1, seen: t }), { mode: 0o600 }); fs.renameSync(opts.stateFile + '.tmp', opts.stateFile); } catch { /* */ }
  };

  function specOf(job) { const p = parse(job.expr); return p.ok ? p.spec : null; }
  // Menyelaraskan meta dengan isi store. Job baru / rev berubah: next dihitung dari `t` (tidak langsung jalan); job hilang: dibuang.
  function sync(t) {
    const ids = new Set();
    for (const j of store.list()) {
      ids.add(j.id);
      const m = meta.get(j.id);
      if (m && m.rev === j.rev) continue; // G:rev
      const spec = specOf(j);
      meta.set(j.id, { rev: j.rev, spec, next: spec && j.on ? nextRun(spec, t) : null });
    }
    for (const id of [...meta.keys()]) if (!ids.has(id)) meta.delete(id);
  }
  function resetNext(t) { for (const j of store.list()) { const m = meta.get(j.id); if (m) m.next = m.spec && j.on ? nextRun(m.spec, t) : null; } }

  function enqueue(job, reason, at) {
    if ((running && running.id === job.id) || queue.some((q) => q.id === job.id)) { // G:overlap
      emit(Object.assign({ id: job.id, site: job.site, reason, at, startedAt: null, endedAt: at, ok: false, code: 'overlap' }, snap(job)));
      return false;
    }
    queue.push({ id: job.id, reason, at });
    return true;
  }

  function catchUp(from, t) {
    for (const j of store.list()) {
      const m = meta.get(j.id);
      if (!j.on || j.miss !== 'once' || !m || !m.spec) continue; // G:miss
      const lo = Math.max(from, j.ts), n = nextRun(m.spec, lo);
      if (n !== null && n <= t) enqueue(j, 'missed', t); // sekali per job, berapa pun jadwal yang terlewat
    }
  }

  function tick() {
    timer = null;
    if (!started) return;
    const t = now();
    sync(t);
    if (lastTick !== null && t < lastTick) resetNext(t); // G:backward (jam mundur: tanpa menjalankan apa pun)
    else if (lastTick !== null && t - lastTick > WAKE_MS) { catchUp(lastTick, t); resetNext(t); }
    else for (const j of store.list()) {
      const m = meta.get(j.id);
      if (!j.on || !m || m.next === null || m.next > t) continue;
      enqueue(j, 'schedule', m.next);
      m.next = m.spec ? nextRun(m.spec, t) : null;
    }
    lastTick = t; seenWrite(t);
    pump(); arm();
  }
  function arm() {
    if (!started || timer !== null) return;
    const t = now();
    timer = T.set(tick, TICK_MS - (t % TICK_MS) + 20);
  }

  function pump() {
    if (running || !started) return;
    while (queue.length) {
      const q = queue.shift(), job = store.get(q.id);
      if (!job || (!job.on && q.reason !== 'manual')) continue; // dihapus / dimatikan saat mengantre
      return exec(job, q);
    }
  }
  function exec(job, q) {
    const ac = typeof AbortController === 'function' ? new AbortController() : { signal: {}, abort() {} };
    const cur = { id: job.id, ac, startedAt: now(), done: false, tm: null };
    running = cur;
    const finish = (r) => {
      if (cur.done) return; // hasil susulan setelah timeout / stop diabaikan
      cur.done = true; if (cur.tm !== null) T.clear(cur.tm);
      if (running === cur) running = null;
      const o = r && typeof r === 'object' ? r : { ok: false, code: 'run' };
      const rec = { id: job.id, site: job.site, reason: q.reason, at: q.at, startedAt: cur.startedAt, endedAt: now(), ok: o.ok === true, ...snap(job) }; // salinan saat eksekusi dimulai (job bisa diedit sesudahnya)
      if (!rec.ok) rec.code = typeof o.code === 'string' && o.code ? o.code : 'run';
      if (o.status !== undefined) rec.status = o.status;
      emit(rec);
      Promise.resolve().then(pump);
    };
    let ms = job.ms; if (typeof opts.capMs === 'function') { try { const c = opts.capMs(job); if (Number.isFinite(c) && c > 0) ms = Math.min(ms, c); } catch { /* */ } } // capMs: batas situs yang diturunkan berlaku juga untuk job lama
    cur.tm = T.set(() => { cur.tm = null; try { ac.abort(); } catch { /* */ } finish({ ok: false, code: 'timeout' }); }, ms); // G:timeout
    cur.finish = finish;
    let p;
    try { p = Promise.resolve(runner(job, { signal: ac.signal })); } catch { p = Promise.reject(new Error('run')); }
    p.then(finish, () => finish({ ok: false, code: 'run' }));
  }

  return {
    start() {
      if (started) return; // G:double-start
      started = true;
      const t = now();
      meta.clear(); sync(t);
      const seen = seenRead();
      if (seen !== null && seen < t) catchUp(seen, t);
      lastTick = t; seenWrite(t);
      pump(); arm();
    },
    stop() {
      if (!started) return;
      started = false;
      if (timer !== null) { T.clear(timer); timer = null; }
      queue.length = 0;
      if (running) { const r = running; try { r.ac.abort(); } catch { /* */ } r.finish({ ok: false, code: 'abort' }); }
      seenWrite(now());
    },
    refresh() { if (started) sync(now()); },
    runNow(id) {
      if (!started) return { ok: false, code: 'stopped' };
      const job = store.get(id);
      if (!job) return { ok: false, code: 'none' };
      if (!enqueue(job, 'manual', now())) return { ok: false, code: 'overlap' };
      pump(); return { ok: true };
    },
    status() {
      const next = {}; for (const [id, m] of meta) if (m.next !== null) next[id] = m.next;
      return { started, running: running ? running.id : null, queued: queue.map((q) => q.id), next };
    },
  };
}
module.exports = { createScheduler, TICK_MS, WAKE_MS };

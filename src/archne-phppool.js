'use strict';
// Pengatur Worker PHP (P.2): satu Worker per situs, antrean serial, batas waktu lalu terminate(), Worker nganggur ditutup,
// batas Worker aktif. Tidak tahu soal HTTP/situs lain: hanya menjalankan req ke Worker situs yang benar.
const path = require('path');
const { Worker } = require('worker_threads');

const err = (code, msg) => Object.assign(new Error(msg || code), { code });

function createPool(opts = {}) {
  const workerFile = opts.workerFile || path.join(__dirname, 'archne-phpworker.js');
  let maxActive = Math.max(1, Math.floor(opts.maxActive) || 4); // bisa diganti saat berjalan (setMax): pengaturan jumlah Worker oleh pemilik
  const idleMs = opts.idleMs == null ? 120000 : opts.idleMs;
  const defTimeout = opts.timeoutMs || 30000;
  const bootMs = opts.bootTimeoutMs || 60000;
  const waitMs = opts.waitMs || 60000; // lama menunggu slot Worker sebelum BUSY
  const base = opts.base || {};         // workerData tambahan milik aplikasi (mis. { sys }); dipasang TERAKHIR sehingga cfg situs tidak bisa menimpanya
  const sites = new Map();   // siteId -> { w, ready, queue, cur, idle, cfg }
  const waiters = [];        // permintaan situs baru yang menunggu slot
  let nextId = 1, closed = false;

  const active = () => sites.size;
  const isIdle = (s) => !s.cur && !s.queue.length;

  function drop(id, why) {            // matikan Worker situs; semua permintaan yang tersisa gagal dengan 'why'
    const s = sites.get(id); if (!s) return;
    sites.delete(id); clearTimeout(s.idle); clearTimeout(s.bootT);
    s.w.removeAllListeners(); s.w.on('error', () => {});
    s.w.terminate().catch(() => {});
    const e = why || err('CLOSED'); if (!s.ready) s.no(e);
    if (s.cur) { clearTimeout(s.cur.t); s.cur.rej(e); s.cur = null; }
    for (const q of s.queue.splice(0)) q.rej(e);
    wake();
  }

  let waking = false;
  function wake() {                   // slot kosong: layani situs yang menunggu (evictIdle memanggil drop -> wake: dijaga agar tidak masuk dua kali)
    if (waking) return; waking = true;
    try { while (waiters.length && slot()) { const x = waiters.shift(); clearTimeout(x.t); x.go(); } }
    finally { waking = false; }
  }

  function slot() {                   // ada tempat untuk satu Worker lagi? Menutup Worker nganggur sebanyak perlu (batas bisa baru saja diturunkan, jadi satu saja tidak cukup)
    while (active() >= maxActive) if (!evictIdle()) return false;
    return true;
  }

  function evictIdle() {              // kosongkan satu slot dengan menutup Worker nganggur
    for (const [id, s] of sites) if (s.ready && isIdle(s)) { drop(id, err('EVICTED')); return true; }
    return false;
  }

  function spawn(id, cfg) {
    const w = new Worker(workerFile, { workerData: Object.assign({}, cfg, base) });
    const s = { w, ready: false, queue: [], cur: null, idle: null, cfg, bootT: null };
    s.readyP = new Promise((res, rej) => { s.ok = res; s.no = rej; }); s.readyP.catch(() => {});
    sites.set(id, s);
    s.bootT = setTimeout(() => drop(id, err('BOOT_TIMEOUT')), bootMs);
    w.on('message', (m) => {
      if (m.ready) { s.ready = true; s.boot = m.boot; clearTimeout(s.bootT); s.ok(); pump(id); return; }
      if (m.fatal) { drop(id, err('BOOT_FAILED', m.fatal)); return; }
      const c = s.cur; if (!c || c.id !== m.id) return;
      clearTimeout(c.t); s.cur = null;
      if (m.error) c.rej(err('PHP_ERROR', m.error)); else c.res({ status: m.status, headers: m.headers, body: Buffer.from(m.body) });
      pump(id);
    });
    w.on('error', (e) => drop(id, err('CRASH', String(e && e.message || e))));
    w.on('exit', () => drop(id, err('DEAD')));
    return s;
  }

  function pump(id) {
    const s = sites.get(id); if (!s || !s.ready) return;
    clearTimeout(s.idle);
    if (s.cur) return;
    const q = s.queue.shift();
    if (!q) { const im = s.idleMs == null ? idleMs : s.idleMs; if (im > 0) s.idle = setTimeout(() => { const t = sites.get(id); if (t && isIdle(t)) drop(id, err('IDLE')); }, im); wake(); return; }
    q.id = nextId++; s.cur = q;
    q.t = setTimeout(() => drop(id, err('TIMEOUT', 'PHP melewati batas ' + q.timeout + ' ms')), q.timeout);
    s.w.postMessage(q.sys ? { id: q.id, req: q.req, sys: true } : { id: q.id, req: q.req });
  }

  function ensure(id, cfg) {          // kembalikan Promise<site>, memberi slot bila perlu
    const s = sites.get(id); if (s) return Promise.resolve(s);
    if (closed) return Promise.reject(err('CLOSED'));
    if (slot()) return Promise.resolve(spawn(id, cfg));
    return new Promise((res, rej) => {
      const x = { go: () => { const t = sites.get(id); res(t || spawn(id, cfg)); }, rej, t: null };
      x.t = setTimeout(() => { const i = waiters.indexOf(x); if (i >= 0) waiters.splice(i, 1); rej(err('BUSY', 'semua slot Worker PHP terpakai')); }, waitMs);
      waiters.push(x);
    });
  }

  return {
    request(id, cfg, req, o = {}) {
      return ensure(id, cfg).then((s) => new Promise((res, rej) => {
        const cur = sites.get(id) || s;
        if (cur !== s || !sites.has(id)) return rej(err('DEAD'));
        if (Number.isFinite(o.idleMs) && o.idleMs >= 0) s.idleMs = o.idleMs; // batas nganggur per situs (pengaturan situs); tanpa = bawaan pool
        s.queue.push({ req, res, rej, timeout: o.timeoutMs || defTimeout, sys: o.sys === true });
        pump(id);
      }));
    },
    warm(id, cfg) { return ensure(id, cfg).then((s) => s.readyP).then(() => true); },  // P.3: panggil saat situs dibuka (boot Windows bisa 1,7 dtk)
    // Ganti batas Worker aktif. Naik: situs yang menunggu langsung dilayani. Turun: Worker nganggur ditutup sampai muat; yang sedang bekerja
    // tidak dipotong, ia ditutup nanti saat nganggur (slot() menutupnya ketika ada situs lain butuh tempat).
    setMax(n) { const v = Math.floor(n); if (!Number.isFinite(v) || v < 1) return false; maxActive = v; while (active() > maxActive && evictIdle()); wake(); return true; },
    stop(id) { drop(id, err('STOPPED')); },
    closeAll() { closed = true; for (const x of waiters.splice(0)) { clearTimeout(x.t); x.rej(err('CLOSED')); } for (const id of [...sites.keys()]) drop(id, err('CLOSED')); },
    stats() { return { active: active(), waiting: waiters.length, max: maxActive, timeoutMs: defTimeout, idleMs, sites: [...sites].map(([id, s]) => ({ id, ready: s.ready, queued: s.queue.length, busy: !!s.cur })) }; },
  };
}

module.exports = { createPool };

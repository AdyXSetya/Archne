'use strict';
// src/archne-webdash.js — Dasbor Web Lokal (0.34.0 Fase U3). Mengumpulkan metrik perangkat PEMILIK untuk tab Dasbor; dipanggil dari archne-ipc-web.js (webDash, webDashPhp).
// Aturan (planning U3 + G.3): hanya untuk pemilik (tidak ada jalan dari peer / lw_req ke sini), TIDAK ada jalur disk di keluaran, tidak ada phpinfo() penuh (info PHP lewat /sys/info.php yang disaring),
// angka tidak keluar dari perangkat. Label jujur: PHP = php-wasm (bukan PHP asli), MySQL = emulasi di atas SQLite (bukan MySQL asli).
// Sumber metrik berbeda per platform lewat dependensi `metrics()` (mis. Electron: jumlah memori semua proses lewat app.getAppMetrics; tanpanya: RSS proses Node = 'core'). Android memakai jalur 'core' sampai cangkang menyediakan angka sendiri.
const fs = require('fs'), path = require('path'), os = require('os');

const MYSQL_VERSION = '8.0.36-archne-sqlite'; // sama dengan yang dikirim server MySQL palsu (src/archne-mysql)
const PHP_LINE = '8.3';                        // paket @php-wasm/node-8-3 (workerData.php)
const WALK_MAX = 200000, WALK_MS = 4000, TTL_MS = 20000, INFO_TTL_MS = 10 * 60 * 1000, SITES_MAX = 200;
const tick = () => new Promise((r) => setImmediate(r));
const num = (n) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);

// Telusuri satu folder tanpa mengikuti symlink; jumlahkan ukuran berkas biasa. budget = { n, t0 } dipakai bersama semua folder agar total terbatas.
async function walk(dir, budget) {
  let bytes = 0, files = 0, partial = false;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (budget.n >= WALK_MAX || Date.now() - budget.t0 > WALK_MS) { partial = true; return { bytes, files, partial }; }
      budget.n++;
      if (e.isSymbolicLink()) continue;           // tidak diikuti dan tidak dihitung
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      try { const st = fs.lstatSync(p); if (st.isFile()) { bytes += st.size; files++; } } catch {}
      if ((budget.n & 255) === 0) await tick();
    }
  }
  return { bytes, files, partial };
}

function createDash(o) {
  if (!o || !o.core || typeof o.core.webStore !== 'function') throw new Error('createDash: core wajib');
  const getHost = typeof o.getPhpHost === 'function' ? o.getPhpHost : () => null;
  const metrics = typeof o.metrics === 'function' ? o.metrics : null;
  const now = o.now || Date.now;
  let cache = null, inflight = null, info = null, infoP = null;

  async function storage(fresh) {
    if (!fresh && cache && now() - cache.t < TTL_MS) return cache.v;
    if (inflight) return inflight;
    inflight = (async () => {
      const ws = o.core.webStore(), budget = { n: 0, t0: Date.now() };
      const list = ws.list().slice(0, SITES_MAX), sites = [];
      let total = 0, partial = false;
      for (const s of list) {
        const base = path.join(ws.dir, s.id), x = { id: s.id, domain: s.domain, title: s.title, php: !!s.php };
        let sum = 0;
        for (const k of ['www', 'data', 'tmp']) {
          const r = await walk(path.join(base, k), budget);
          x[k] = r.bytes; sum += r.bytes; if (k === 'www') x.files = r.files; if (r.partial) partial = true;
        }
        x.total = sum; total += sum; sites.push(x);
      }
      sites.sort((a, b) => b.total - a.total);
      const v = { total, sites, partial, count: list.length };
      cache = { t: now(), v };
      return v;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  function memory() {
    let appBytes = 0, src = 'core';
    try { const m = metrics && metrics(); if (m && Number.isFinite(m.appBytes) && m.appBytes > 0) { appBytes = num(m.appBytes); src = m.src === 'processes' ? 'processes' : 'core'; } } catch {}
    if (!appBytes) { try { appBytes = num(process.memoryUsage().rss); } catch {} }
    return { total: num(os.totalmem()), free: num(os.freemem()), app: appBytes, src };
  }

  function php(sitesById) {
    const host = getHost();
    if (!host || typeof host.stats !== 'function') return { available: false, engine: 'php-wasm', line: PHP_LINE, max: 0, active: 0, waiting: 0, workers: [] };
    const st = host.stats() || {};
    const workers = (Array.isArray(st.sites) ? st.sites : []).slice(0, 16).map((w) => {
      const s = sitesById.get(w && w.id);
      return { id: s ? s.id : '', domain: s ? s.domain : '', ready: !!(w && w.ready), busy: !!(w && w.busy), queued: num(w && w.queued) };
    });
    return { available: true, engine: 'php-wasm', line: PHP_LINE, max: num(st.max), auto: st.auto !== false, autoMax: num(st.autoMax) || num(st.max), active: num(st.active), waiting: num(st.waiting), timeoutMs: num(st.timeoutMs), idleMs: num(st.idleMs), workers };
  }

  function mysql(list, sitesById) {
    const host = getHost();
    const rows = [];
    for (const s of list) {
      if (!s.php) continue;
      let up = false;
      try { up = !!(host && typeof host.mysqlInfo === 'function' && host.mysqlInfo(s.id)); } catch {}
      rows.push({ id: s.id, domain: s.domain, running: up });
    }
    return { kind: 'emulated', base: 'sqlite', version: MYSQL_VERSION, available: !!(host && typeof host.mysqlInfo === 'function'), running: rows.filter((r) => r.running).length, sites: rows.slice(0, SITES_MAX) };
  }

  async function snapshot(opt) {
    const fresh = !!(opt && opt.fresh);
    const list = o.core.webStore().list().slice(0, SITES_MAX), byId = new Map(list.map((s) => [s.id, s]));
    const st = await storage(fresh);
    return { ok: true, ts: now(), platform: String(process.platform).slice(0, 12), cpus: num((os.cpus() || []).length), mem: memory(), php: php(byId), mysql: mysql(list, byId), storage: st };
  }

  // Info PHP yang disaring. Butuh Worker (boot bisa beberapa detik di Windows): hanya dipanggil atas permintaan. Hasil di-cache; versi tidak berubah selama aplikasi jalan.
  async function phpInfo(siteId) {
    const host = getHost();
    if (!host || typeof host.infoTool !== 'function') { const e = new Error('nophp'); e.code = 'nophp'; throw e; }
    const ws = o.core.webStore();
    let id = siteId;
    if (!id) { const s = ws.list().find((x) => x.php); id = s && s.id; }
    if (!id || !ws.has(id) || !ws.get(id).php) { const e = new Error('nosite'); e.code = 'nophpsite'; throw e; } // id diperiksa SEBELUM cache: situs statis / tak ada tetap ditolak walau hasilnya sudah ada
    if (info && now() - info.t < INFO_TTL_MS) return info.v;
    if (infoP) return infoP;
    infoP = (async () => {
      let res; try { res = await host.infoTool(id); } catch { res = null; } // pesan galat host bisa memuat jalur: dibuang, hanya kode 'io' yang naik
      let j = null; try { if (res && res.body && res.body.length <= 16384) j = JSON.parse(Buffer.from(res.body).toString('utf8')); } catch {}
      if (!j || j.ok !== true) { const e = new Error('fail'); e.code = 'io'; throw e; }
      const str = (v, re) => (typeof v === 'string' && re.test(v) ? v : '');
      const lim = {}; for (const k of ['memory_limit', 'max_execution_time', 'upload_max_filesize', 'post_max_size', 'max_input_vars']) lim[k] = str(j.limits && j.limits[k], /^-?\d{1,12}[KMGkmg]?$/);
      const v = { php: str(j.php, /^[0-9A-Za-z.\-+_]{1,40}$/), sqlite: str(j.sqlite, /^[0-9A-Za-z.\-+_]{1,40}$/), ext: (Array.isArray(j.ext) ? j.ext : []).filter((e) => typeof e === 'string' && /^[a-z0-9_]{1,30}$/.test(e)).slice(0, 100), mysqli: j.mysqli === true, limits: lim };
      info = { t: now(), v }; return v;
    })().finally(() => { infoP = null; });
    return infoP;
  }

  return { snapshot, phpInfo, reset: () => { cache = null; info = null; } };
}

module.exports = { createDash, walk, MYSQL_VERSION, PHP_LINE, WALK_MAX, TTL_MS };

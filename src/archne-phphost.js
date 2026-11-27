'use strict';
// Host mesin PHP di perangkat PEMILIK (0.34.0 Fase P.0 / P.2 / P.3): satu pintu yang menyambungkan WebStore (jalur www/ data/ tmp/) ke pool Worker (archne-phppool.js)
// dan router (archne-phproute.js). Dipakai penampil (archne-sitebrowser.js) untuk pratinjau pemilik; nanti juga oleh penyaji lw_req (P.5).
// Aturan: jalur disk TIDAK PERNAH keluar dari modul ini selain ke router/pool (proses utama). Pool dibuat malas (Worker dan @php-wasm baru dimuat saat situs PHP pertama dibuka).
// Dependensi (createPool, createPhpRouter) bisa disuntik untuk tes tanpa PHP sungguhan.
const os = require('os'), path = require('path');
const { iniFor } = require('./archne-mysql');
const WL = require('./archne-weblimits');

// Batas Worker aktif menurut RAM (±500 MB per Worker, P.2): HP kecil 1-2, desktop 4.
function defaultMaxActive(totalBytes) {
  const gb = totalBytes / (1024 * 1024 * 1024);
  return gb < 4.5 ? 1 : gb < 8.5 ? 2 : 4;
}

function createPhpHost(o) {
  if (!o || !o.core || typeof o.core.webStore !== 'function') throw new Error('createPhpHost: core wajib');
  const log = o.log || function () {};
  const createPool = o.createPool || require('./archne-phppool').createPool;
  const createPhpRouter = o.createPhpRouter || require('./archne-phproute').createPhpRouter;
  const mysql = o.mysql || null; // pengelola MySQL palsu (archne-mysql.js); tidak ada = perilaku lama (tes tanpa PHP sungguhan tidak menyalakan Worker tambahan)
  let pool = null, cronPool = null, closed = false;
  const routers = new Map(); // siteId -> router
  const cronRouters = new Map(); // siteId -> router milik cron (pool SENDIRI)
  const served = new Map(); // siteId -> waktu permintaan peer terakhir (P.5d): pratinjau pemilik yang ditutup tidak boleh mematikan Worker yang sedang melayani peer
  const SERVE_HOLD = o.serveHold == null ? 60000 : o.serveHold;

  // Jumlah Worker aktif: pilihan pemilik (settings.json `phpWorkers`, lewat core.getSettings().php.workers) bila ada, jika tidak otomatis menurut RAM. Tanpa batas atas buatan.
  const autoMax = () => defaultMaxActive(o.totalMem || os.totalmem());
  const customMax = () => { try { const s = o.core.getSettings(), v = s && s.php && s.php.workers; return Number.isSafeInteger(v) && v >= 1 ? v : null; } catch { return null; } };
  const maxNow = () => customMax() || autoMax();
  const getPool = () => pool || (pool = createPool(Object.assign({ maxActive: maxNow(), base: { sys: o.sysDir || path.join(__dirname, 'archne-sys') } }, o.poolOpts || {})));

  // Pool cron (C4): terpisah dari pool aplikasi. Satu Worker (penjadwal menjalankan satu job sekaligus), ditutup cepat saat nganggur, batas waktu longgar
  // (penjadwal yang memegang batas job.ms lalu menghentikan Worker). Akibatnya cron tidak memakai slot Worker pengunjung dan tidak antre di belakang permintaan mereka.
  const getCronPool = () => cronPool || (cronPool = createPool(Object.assign({ maxActive: 1, idleMs: 30000, timeoutMs: 330000, base: { sys: o.sysDir || path.join(__dirname, 'archne-sys') } }, o.cronPoolOpts || {}))); // G:cron-pool

  function ensureMysql(siteId, dataDir, ini) {
    return mysql.start(siteId, dataDir).then((info) => { Object.assign(ini, iniFor(info)); return info; }, () => null);
  }
  // Batas sumber daya situs (pengaturan situs; src/archne-weblimits.js). Hanya kunci yang diatur pemilik; tanpa = null = perilaku lama persis. Core tiruan di tes boleh tidak punya limitsRaw.
  const limOf = (siteId) => { try { const ws = o.core.webStore(); return typeof ws.limitsRaw === 'function' ? ws.limitsRaw(siteId) : null; } catch { return null; } };
  function build(siteId, getP, cron) {
    const p = o.core.webStore().paths(siteId); // melempar e.lw.siteNone / e.lw.phpOff
    const lim = limOf(siteId);
    const ini = Object.assign({}, o.ini, WL.iniFor(lim));
    let r = createPhpRouter(Object.assign({ pool: getP(), siteId, www: p.www, data: p.data, tmp: p.tmp, ini, cron }, WL.routeOpts(lim), cron ? WL.cronRouteOpts(lim) : {}));
    if (mysql) { // server MySQL harus hidup dan nilai ini terisi SEBELUM Worker PHP boot (ini dibaca saat spawn)
      const up = ensureMysql(siteId, p.data, ini), inner = r;
      r = Object.assign(Object.create(inner), { handle: async (rq) => { await up; return inner.handle(rq); }, warm: async () => { await up; return inner.warm(); }, stop: () => { inner.stop(); } });
    }
    return r;
  }
  // Router untuk situs PHP milik perangkat ini. Melempar bila situs tidak ada / bukan situs PHP / host sudah ditutup.
  function router(siteId) {
    if (closed) throw Object.assign(new Error('closed'), { code: 'CLOSED' });
    let r = routers.get(siteId);
    if (r) return r;
    r = build(siteId, getPool, false);
    routers.set(siteId, r);
    return r;
  }
  // Router untuk cron (C4): pemetaan yang sama dengan pratinjau, tetapi lewat pool cron. stop() hanya menghentikan Worker cron situs itu (MySQL tidak disentuh).
  function cron(siteId) {
    if (closed) throw Object.assign(new Error('closed'), { code: 'CLOSED' });
    let r = cronRouters.get(siteId);
    if (r) {
      // C8: router di cache tidak boleh melewati saklar. Situs dihapus / Mesin PHP dimatikan SESUDAH job dibuat: periksa ulang tiap eksekusi (paths() melempar siteNone / phpOff),
      // buang router + hentikan Worker cron situs itu, lalu lempar (penjalan mencatat code 'site'). Tanpa ini cron terus menjalankan PHP situs yang mesinnya sudah dimatikan.
      try { o.core.webStore().paths(siteId); } catch (e) { cronRouters.delete(siteId); try { r.stop(); } catch { /* */ } throw e; } // G:cron-recheck
      return r;
    }
    r = build(siteId, getCronPool, true);
    cronRouters.set(siteId, r);
    return r;
  }
  // Penyedia untuk lw_req (peer): router yang sama dengan pratinjau pemilik (satu Worker per situs), tetapi setiap permintaan menandai situsnya "sedang melayani".
  function serve(siteId) {
    const r = router(siteId);
    return { handle: (rq) => { served.set(siteId, Date.now()); return r.handle(rq); } };
  }
  // Alat database milik aplikasi (P.7a): langsung ke pool dengan skrip /sys, TANPA router dan tanpa lw_req, jadi peer tidak punya jalan ke sini.
  // Mengembalikan { status, body:Buffer }. Memakai Worker situs yang sama (cfg sama dengan router) sehingga tidak menambah Worker.
  async function dbTool(siteId, payload) { return sysCall(siteId, '/sys/dbtool.php', payload, 20000); }
  // Info mesin PHP yang disaring (U3 Dasbor): skrip /sys/info.php di Worker situs yang sama. Hasil: { status, body }.
  async function infoTool(siteId) { return sysCall(siteId, '/sys/info.php', {}, 20000); }
  async function sysCall(siteId, script, payload, timeoutMs) {
    if (closed) throw Object.assign(new Error('closed'), { code: 'CLOSED' });
    const p = o.core.webStore().paths(siteId);
    const body = Buffer.from(JSON.stringify(payload));
    const ini = Object.assign({}, o.ini, WL.iniFor(limOf(siteId))); if (mysql) await ensureMysql(siteId, p.data, ini); // cfg dipakai hanya saat Worker baru dibuat; harus sama dengan router
    return getPool().request(siteId, { www: p.www, data: p.data, tmp: p.tmp, ini },
      { method: 'POST', uri: '/', script, headers: { 'content-type': 'application/json' }, body, server: {} }, { sys: true, timeoutMs });
  }
  // Pengaturan situs berubah (batas PHP / saklar Mesin PHP): ini php.ini dan opsi router dibaca saat Worker dibuat, jadi router + Worker situs ini (pratinjau, peer, DAN cron) dibuang
  // lalu dibuat ulang dengan nilai baru pada permintaan berikutnya. Berbeda dengan stop(): tidak menunggu SERVE_HOLD. MySQL palsu tidak disentuh (juga tidak yang di-pin).
  function reload(siteId) {
    for (const m of [routers, cronRouters]) {
      const r = m.get(siteId); m.delete(siteId);
      if (r) { try { r.stop(); } catch (e) { log('phphost: reload gagal ' + (e && e.code || '')); } }
    }
    if (pool) { try { pool.stop(siteId); } catch { /* */ } } // Worker yang dibuat sysCall (alat DB / Dasbor) tanpa router
    if (cronPool) { try { cronPool.stop(siteId); } catch { /* */ } }
  }
  function stop(siteId) {
    const t = served.get(siteId);
    if (t && Date.now() - t < SERVE_HOLD) return; // masih melayani peer: Worker ditutup pool saat nganggur (bawaan 120 dtk)
    served.delete(siteId);
    const r = routers.get(siteId);
    routers.delete(siteId);
    if (mysql) mysql.stop(siteId);
    if (r) { try { r.stop(); } catch (e) { log('phphost: stop gagal ' + (e && e.code || '')); } }
  }
  function closeAll() {
    closed = true;
    routers.clear(); cronRouters.clear(); served.clear();
    if (mysql) { try { mysql.closeAll(); } catch {} }
    if (pool) { try { pool.closeAll(); } catch {} pool = null; }
    if (cronPool) { try { cronPool.closeAll(); } catch {} cronPool = null; } // G:close-cron
  }
  const mysqlInfo = (siteId) => (mysql ? mysql.info(siteId) : null);
  // Impor dump MySQL (fase 1c): lewat Worker MySQL situs (satu-satunya pemegang WAL mysql.sqlite). null bila tanpa pengelola MySQL (tes / platform tanpa node:sqlite).
  const dataOf = (siteId) => o.core.webStore().paths(siteId).data;
  const mysqlImport = mysql && typeof mysql.importPrepare === 'function' ? {
    prepare: (siteId, text) => mysql.importPrepare(siteId, dataOf(siteId), text),
    commit: (siteId, token) => mysql.importCommit(siteId, dataOf(siteId), token),
    cancel: (siteId, token) => mysql.importCancel(siteId, dataOf(siteId), token),
  } : null;
  // Browser MySQL baca-saja (fase 2a): tables / rows / exec / csv lewat Worker MySQL. null bila tanpa pengelola MySQL.
  const mysqlBrowse = mysql && typeof mysql.browse === 'function' ? {
    tables: (siteId) => mysql.browse(siteId, dataOf(siteId), 'tables'),
    rows: (siteId, args) => mysql.browse(siteId, dataOf(siteId), 'rows', args),
    exec: (siteId, args) => mysql.browse(siteId, dataOf(siteId), 'exec', args),
    csv: (siteId, args) => mysql.browse(siteId, dataOf(siteId), 'csv', args),
  } : null;
  // Ekspor dump MySQL (fase 3-4): Worker menulis dump langsung ke `out` (jalur absolut dari dialog simpan proses utama). null bila tanpa pengelola MySQL.
  const mysqlExport = mysql && typeof mysql.exportRun === 'function' ? {
    run: (siteId, out, onProgress) => mysql.exportRun(siteId, dataOf(siteId), out, onProgress),
    cancel: (siteId) => mysql.exportCancel(siteId, dataOf(siteId)),
  } : null;
  // Baca ulang pilihan pemilik dan terapkan ke pool yang sedang hidup (pool belum dibuat = nilai dibaca saat dibuat). Dipanggil setelah setSettings({ phpWorkers }).
  function setMaxActive() { const n = maxNow(); if (pool && typeof pool.setMax === 'function') pool.setMax(n); return n; }
  // Buat database MySQL (fase 5e): mysql.sqlite kosong + port tetap tanpa menyalakan server. null bila tanpa pengelola MySQL.
  const mysqlCreate = mysql && typeof mysql.provision === 'function' ? { run: (siteId) => mysql.provision(siteId, dataOf(siteId)) } : null;
  // Fase 6a: status server MySQL (hanya baca). null bila tanpa pengelola MySQL.
  const mysqlStatus = mysql && typeof mysql.status === 'function' ? (siteId) => mysql.status(siteId) : null;
  // Fase 6c: pin / unpin server MySQL situs (host.stop dan reload tidak mematikan yang di-pin). null bila pengelola MySQL tidak mendukung.
  const mysqlPin = mysql && typeof mysql.pin === 'function' ? { pin: (siteId) => mysql.pin(siteId), unpin: (siteId) => mysql.unpin(siteId), isPinned: (siteId) => mysql.isPinned(siteId) } : null;
  // Fase 6d: Nyalakan / Matikan oleh pemilik. start: nyalakan (atau pakai Worker yang ada) lalu PIN, supaya host.stop tidak mematikannya; null bila Worker tidak bisa jalan (mis. tanpa node:sqlite).
  // stop: paksa mati (melewati pin; pin ikut hilang bersama Worker). null bila pengelola MySQL tidak mendukung pin.
  const mysqlPower = mysql && typeof mysql.pin === 'function' ? {
    start: async (siteId) => {
      const was = mysql.status(siteId).running;
      const info = await mysql.start(siteId, dataOf(siteId));
      if (!info || !mysql.pin(siteId)) return null; // Worker gagal / mati di antara start dan pin
      return { port: info.port, already: was };
    },
    stop: async (siteId) => (typeof mysql.stopWait === 'function' ? mysql.stopWait(siteId) : mysql.stop(siteId, { force: true })),
  } : null;
  return { mysqlInfo, mysqlStatus, mysqlPin, mysqlPower, mysqlImport, mysqlBrowse, mysqlExport, mysqlCreate, router, cron, serve, dbTool, infoTool, stop, reload, closeAll, stats: () => Object.assign(pool ? pool.stats() : { active: 0, waiting: 0, max: maxNow(), sites: [] }, { auto: customMax() == null, autoMax: autoMax() }), setMaxActive,
    cronStats: () => (cronPool ? cronPool.stats() : { active: 0, waiting: 0, max: 1, sites: [] }) };
}

module.exports = { createPhpHost, defaultMaxActive };

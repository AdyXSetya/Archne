'use strict';
// Server MySQL palsu per situs PHP (P.9 integrasi): mysqli / PDO mysql di PHP-WASM tersambung lewat TCP loopback ke server ini,
// yang menerjemahkan ke SQLite di data/mysql.sqlite. Hanya 127.0.0.1; peer jaringan tidak punya jalan ke sini (lw_req tidak membawa soket).
// Port tetap per situs (disimpan di <situs>/mysql.json, di luar mount www/ dan data/) supaya wp-config dkk. tetap berlaku antar sesi.
// Gagal start (mis. node:sqlite tak ada di Android) = PHP tetap jalan tanpa MySQL; tidak pernah melempar ke pemanggil.
const fs = require('fs'), path = require('path');
const { Worker } = require('worker_threads');
const { provisionMysql } = require('./archne-mysql/provision.js');

function createMysqlHost(o = {}) {
  const log = o.log || function () {};
  const workerFile = o.workerFile || path.join(__dirname, 'archne-mysql', 'worker.js');
  const sites = new Map(); // siteId -> { w, p:Promise<info|null>, info }
  let closed = false;

  function readPort(stateFile) { try { const n = JSON.parse(fs.readFileSync(stateFile, 'utf8')).port; return Number.isInteger(n) && n > 1023 && n < 65536 ? n : 0; } catch { return 0; } }

  // dataDir = folder data/ situs. Idempotent: panggilan kedua mengembalikan Promise yang sama.
  function start(siteId, dataDir) {
    if (closed) return Promise.resolve(null);
    const have = sites.get(siteId); if (have) return have.p;
    const stateFile = path.join(path.dirname(dataDir), 'mysql.json');
    const s = { w: null, info: null, reqs: new Map(), seq: 0 };
    s.p = new Promise((res) => {
      let w;
      try { w = new Worker(workerFile, { workerData: { file: path.join(dataDir, 'mysql.sqlite'), port: readPort(stateFile), lockWaitMs: o.lockWaitMs } }); }
      catch (e) { log('mysql: gagal membuat Worker: ' + (e && e.message)); sites.delete(siteId); return res(null); }
      s.w = w;
      const fail = (why) => { log('mysql: ' + why); if (sites.get(siteId) === s) sites.delete(siteId); try { w.terminate(); } catch {} res(null); };
      const t = setTimeout(() => fail('boot melewati batas'), 15000);
      w.on('message', (m) => {
        if (m && m.id != null) { const q = s.reqs.get(m.id); if (q && m.progress) { if (q.arm) q.arm(); if (q.onProgress) { try { q.onProgress(m.progress); } catch {} } return; } if (q) { s.reqs.delete(m.id); clearTimeout(q.t); m.ok ? q.res(m.result) : q.rej(Object.assign(new Error((m.error && m.error.message) || 'galat'), m.error || {})); } return; }
        if (m.fatal) { clearTimeout(t); return fail(m.fatal); }
        if (m.ready) {
          clearTimeout(t);
          s.info = { host: '127.0.0.1', port: m.port, user: 'root', password: '' };
          try { fs.writeFileSync(stateFile, JSON.stringify({ port: m.port })); } catch {}
          res(s.info);
        }
      });
      w.on('error', (e) => fail('Worker galat: ' + (e && e.message)));
      w.on('exit', () => { if (sites.get(siteId) === s) sites.delete(siteId); res(null); for (const [, q] of s.reqs) { clearTimeout(q.t); q.rej(new Error('Worker MySQL berhenti')); } s.reqs.clear(); });
    });
    sites.set(siteId, s);
    return s.p;
  }
  // Fase 1b: kirim permintaan ke Worker situs (start dulu bila belum jalan — Worker-lah satu-satunya pemegang WAL mysql.sqlite).
  // Menolak (reject) bila Worker tak bisa dijalankan atau melewati batas waktu. Jam batas besar: dump ratusan MB.
  async function request(siteId, dataDir, msg, timeoutMs, onProgress) {
    const info = await start(siteId, dataDir);
    const s = sites.get(siteId);
    if (!info || !s) throw Object.assign(new Error('Server MySQL tidak bisa dijalankan di perangkat ini.'), { code: 'NOMYSQL' });
    return new Promise((res, rej) => {
      const id = ++s.seq;
      const q = { res, rej, t: null, onProgress, arm: null };
      // Batas waktu = diam terlalu lama; tiap pesan progres memperpanjangnya (ekspor besar tidak boleh mati hanya karena lama).
      q.arm = () => { clearTimeout(q.t); q.t = setTimeout(() => { s.reqs.delete(id); rej(Object.assign(new Error('Worker MySQL tidak menjawab.'), { code: 'TIMEOUT' })); }, timeoutMs || 600000); };
      q.arm();
      s.reqs.set(id, q);
      try { s.w.postMessage(Object.assign({ id }, msg)); } catch (e) { s.reqs.delete(id); clearTimeout(q.t); rej(e); }
    });
  }
  const importPrepare = (siteId, dataDir, text) => request(siteId, dataDir, { op: 'import-prepare', text }, 300000);
  const importCommit = (siteId, dataDir, token) => request(siteId, dataDir, { op: 'import-commit', token }, 3600000);
  const importCancel = (siteId, dataDir, token) => request(siteId, dataDir, { op: 'import-cancel', token }, 30000);
  // Fase 2a: browser baca-saja. Worker dimulai bila belum jalan; hanya Worker yang menyentuh mysql.sqlite.
  const browse = (siteId, dataDir, op, args) => request(siteId, dataDir, { op: 'browse-' + op, args }, 30000);

  // Fase 3-3: ekspor dump. `out` = jalur absolut hasil showSaveDialog (main process); Worker menulis langsung ke disk. Batas waktu 5 menit TANPA progres.
  const exportRun = (siteId, dataDir, out, onProgress) => request(siteId, dataDir, { op: 'export-run', out }, 300000, onProgress);
  const exportCancel = (siteId, dataDir) => request(siteId, dataDir, { op: 'export-cancel' }, 30000);

  // Fase 5d: siapkan mysql.sqlite kosong + port tetap TANPA menyalakan server. Bila Worker situs sedang jalan, database pasti sudah ada: kembalikan keadaannya apa adanya.
  async function provision(siteId, dataDir) {
    const s = sites.get(siteId);
    if (s) { const info = s.info || await s.p; if (info) return { created: false, hasDb: true, hasInfo: true, port: info.port }; }
    return provisionMysql(dataDir);
  }

  // Fase 6a: status hanya-baca. running = Worker sudah siap (info terisi); starting = Worker dibuat tetapi belum siap. Tidak menyalakan apa pun.
  function status(siteId) {
    const s = sites.get(siteId);
    if (!s) return { running: false, starting: false, port: null };
    return s.info ? { running: true, starting: false, port: s.info.port } : { running: false, starting: true, port: null };
  }

  // Fase 6c: pin = server dinyalakan pemilik; tidak ikut mati saat Mesin PHP situs dimatikan (host.stop -> stop()). Bendera menempel pada Worker (s.pinned),
  // jadi hilang sendiri bila Worker mati / gagal boot / aplikasi ditutup; tidak bertahan antar sesi. Tanpa Worker (berjalan atau sedang boot) tidak ada yang di-pin: false.
  function pin(siteId) { const s = sites.get(siteId); if (!s) return false; s.pinned = true; return true; }
  function unpin(siteId) { const s = sites.get(siteId); if (!s) return false; s.pinned = false; return true; }
  const isPinned = (siteId) => { const s = sites.get(siteId); return !!(s && s.pinned); };
  function kill(siteId) { const s = sites.get(siteId); if (!s) return false; sites.delete(siteId); try { s.w.terminate(); } catch {} return true; }
  // stop biasa menghormati pin (dipakai host.stop); stop(id, { force: true }) mematikan juga yang di-pin (dipakai aksi Matikan pemilik, fase 6d).
  function stop(siteId, opt) { const s = sites.get(siteId); if (!s || (s.pinned && !(opt && opt.force))) return false; return kill(siteId); }
  // Fase 6d: aksi Matikan pemilik. Paksa (melewati pin), lalu tunggu Worker benar-benar keluar (maks 5 dtk) supaya Nyalakan berikutnya tidak berebut kunci WAL dengan Worker lama. true bila ada yang dimatikan.
  async function stopWait(siteId) {
    const s = sites.get(siteId), w = s && s.w;
    if (!kill(siteId)) return false;
    if (w && typeof w.once === 'function') await new Promise((res) => { const t = setTimeout(res, 5000); w.once('exit', () => { clearTimeout(t); res(); }); });
    return true;
  }
  function closeAll() { closed = true; for (const id of [...sites.keys()]) kill(id); } // penutupan aplikasi mematikan semuanya, termasuk yang di-pin (tanpa Worker yatim)
  return { start, stop, stopWait, pin, unpin, isPinned, closeAll, provision, status, request, importPrepare, importCommit, importCancel, browse, exportRun, exportCancel, info: (id) => (sites.get(id) && sites.get(id).info) || null };
}

// Nilai php.ini bawaan agar mysqli_connect() tanpa argumen langsung tersambung.
function iniFor(info) {
  if (!info) return {};
  return { 'mysqli.default_host': info.host, 'mysqli.default_port': String(info.port), 'mysqli.default_user': info.user, 'mysqli.default_pw': '' };
}

module.exports = { createMysqlHost, iniFor };

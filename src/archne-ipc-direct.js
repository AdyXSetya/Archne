'use strict';
// src/archne-ipc-direct.js — jembatan renderer <-> Core untuk Kirim Langsung (v0.24.0, step 2a). Dipanggil dari register() di src/archne-ipc.js.
// Aturan keamanan (sama seperti berkas biasa):
//  - Renderer TIDAK PERNAH mengirim path tujuan simpan. Folder tujuan hanya lewat dialog di proses utama (dxAccept dengan choose = true) atau bawaan Core.
//  - Path yang DIKIRIM harus absolut; isi dan batas dipindai Core (Direct.scan).
//  - Membuka folder hasil hanya lewat id sesi; path diambil dari catatan Core.
// Kanal: dxState, dxPick, dxSend, dxCancelScan, dxAccept, dxDecline, dxPause, dxResume, dxCancel, dxCancelOut, dxRemove, dxChooseDir, dxOpenDir.
// Event ke renderer: 'dxprog' { id, dir, state, done, total, speed } (denyut Core tiap 400 ms), 'dxscan' { job, ... } (pemindaian folder besar).
const fs = require('fs');
const path = require('path');
const { errText } = require('./core/archne-ecode'); // i18n (E3)
const T = require('./core/archne-i18n-node').tr; // T('e.kunci', param, 'teks Indonesia cadangan')

const HEX32 = /^[0-9a-f]{32}$/;
const JOB = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_JOBS = 20, MAX_PATHS = 1000, SCAN_MS = 150;

const fail = (e) => ({ ok: false, err: errText(e), code: e && e.code });

function registerDirect({ ipcMain, core, deps, toRenderer, log, settingsOut = (r) => r }) {
  const jobs = new Map(); // job -> { job, to, ac }
  const on = (name, fn) => ipcMain.handle(name, async (_e, ...a) => { try { return await fn(...a); } catch (e) { return fail(e); } });
  const idOf = (id) => { id = String(id); return HEX32.test(id) ? id : null; };
  const bad = { ok: false, err: 'id tidak valid', code: 'bad' };

  core.on('direct', (ev) => toRenderer('dxprog', ev));

  on('dxState', () => core.directState());

  // Dialog pilih isi yang dikirim: kind = 'files' | 'folder'. Hasil: larik path absolut (kosong bila dibatalkan).
  on('dxPick', async (kind) => {
    if (!deps.pickItems) return [];
    try {
      const r = await deps.pickItems(kind === 'folder' ? 'folder' : 'files');
      const l = Array.isArray(r) ? r.filter((x) => typeof x === 'string' && path.isAbsolute(x)).slice(0, MAX_PATHS) : [];
      if (deps.pathGuard) deps.pathGuard.grantAll(l);
      return l;
    } catch (e) { log('dxPick ' + e.message); return []; }
  });

  // Tawarkan berkas/folder ke satu peer LAN. Kembali setelah penerima menjawab (atau gagal); pemindaian folder besar bisa lama -> bisa dibatalkan lewat dxCancelScan.
  on('dxSend', async (job, to, paths) => {
    if (typeof job !== 'string' || !JOB.test(job)) return { ok: false, err: 'id pekerjaan tidak valid', code: 'bad' };
    if (jobs.has(job)) return { ok: false, err: 'pekerjaan sudah ada', code: 'bad' };
    if (typeof to !== 'string' || !to) return { ok: false, err: 'tujuan tidak valid', code: 'bad' };
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_PATHS) return { ok: false, err: 'pilih 1–' + MAX_PATHS + ' berkas/folder', code: 'bad' };
    if (!paths.every((p) => typeof p === 'string' && path.isAbsolute(p))) return { ok: false, err: 'path harus absolut', code: 'bad' };
    if (deps.pathGuard && !paths.every((p) => deps.pathGuard.has(p))) return { ok: false, err: 'path tidak dipilih lewat dialog', code: 'bad' };
    if (jobs.size >= MAX_JOBS) return { ok: false, err: 'terlalu banyak pekerjaan', code: 'busy' };
    const j = { job, to, ac: new AbortController() };
    jobs.set(job, j);
    let last = 0;
    try {
      const s = await core.directSend(to, paths, {
        signal: j.ac.signal,
        tmp: paths.filter((x) => core._dxIsTmp(x)), // salinan unggahan (Android): dihapus Core saat sesi berakhir
        onScan: (p) => { const now = Date.now(); if (now - last >= SCAN_MS) { last = now; toRenderer('dxscan', Object.assign({ job }, p)); } },
      });
      return { ok: true, id: s.id, session: s };
    } catch (e) {
      if (j.ac.signal.aborted || (e && e.name === 'AbortError')) return { ok: false, err: 'Dibatalkan', code: 'abort' };
      log('dxSend ' + ((e && e.code) || '') + ' ' + (e && e.message));
      return fail(e);
    } finally { jobs.delete(job); }
  });
  on('dxCancelScan', (job) => { const j = jobs.get(String(job)); if (!j) return false; j.ac.abort(); return true; });

  // Terima: choose = true -> tanya folder lewat dialog (proses utama); dibatalkan = tidak jadi menerima. Kembali setelah daftar berkas diambil dan unduhan mulai.
  on('dxAccept', async (id, choose) => {
    id = idOf(id); if (!id) return bad;
    const opts = {};
    if (choose === true) {
      if (!deps.pickDir) return { ok: false, err: T('e.dx.noPicker', null, 'pemilih folder tidak tersedia'), code: 'nodialog' };
      const dir = await deps.pickDir(core._directDir());
      if (typeof dir !== 'string' || !dir) return { ok: false, err: 'Dibatalkan', code: 'abort' };
      opts.dir = dir;
    }
    await core.directAccept(id, opts);
    return { ok: true };
  });
  on('dxDecline', async (id) => { id = idOf(id); return id ? { ok: !!(await core.directDecline(id)) } : bad; });
  on('dxPause', async (id) => { id = idOf(id); return id ? { ok: !!(await core.directPause(id)) } : bad; });
  on('dxResume', (id) => { id = idOf(id); return id ? { ok: !!core.directResume(id) } : bad; });
  on('dxCancel', async (id) => { id = idOf(id); return id ? { ok: !!(await core.directCancel(id)) } : bad; });
  on('dxCancelOut', async (id) => { id = idOf(id); return id ? { ok: !!(await core.directCancelOut(id)) } : bad; });
  on('dxRemove', (id) => { id = idOf(id); return id ? { ok: !!core.directRemove(id) } : bad; });

  // Ubah folder tujuan Kirim Langsung (Pengaturan): dialog di proses utama, lalu Core memvalidasi dan menyimpan (settings.json). Dibatalkan = tidak ada perubahan.
  // Hasil: getSettings baru, atau { ok:false, code: abort | nodialog | dir (tidak bisa ditulisi) }. Hanya berlaku untuk tawaran yang diterima sesudahnya. Kembali ke bawaan: setSettings({ directDir: null }).
  on('dxChooseDir', async () => {
    if (!deps.pickDir) return { ok: false, err: T('e.dx.noPicker', null, 'pemilih folder tidak tersedia'), code: 'nodialog' };
    const dir = await deps.pickDir(core._directDir());
    if (typeof dir !== 'string' || !dir) return { ok: false, err: 'Dibatalkan', code: 'abort' };
    const r = core.setSettings({ directDir: dir });
    return r && r.ok ? settingsOut(r) : Object.assign({ err: r && r.code === 'dir' ? T('e.dx.dirRO', null, 'Folder itu tidak bisa ditulisi') : T('e.dx.dirBad', null, 'Folder tidak sah') }, r);
  });

  // Buka folder hasil sebuah sesi masuk (atau folder bawaan bila id kosong). Path dari catatan Core, bukan dari renderer.
  on('dxOpenDir', async (id) => {
    let dir = core._directDir();
    if (id) {
      id = idOf(id); if (!id) return bad;
      const s = core._dxIn.get(id);
      if (!s) return { ok: false, err: 'sesi tidak ditemukan', code: 'gone' };
      if (s.dir) dir = s.dir;
    }
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const r = deps.shell ? await deps.shell.openPath(dir) : '';
    return r ? { ok: false, err: r } : { ok: true };
  });

  return { jobs, dispose() { for (const j of jobs.values()) j.ac.abort(); } };
}

module.exports = { registerDirect };

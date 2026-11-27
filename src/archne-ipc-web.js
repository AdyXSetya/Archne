'use strict';
// src/archne-ipc-web.js — jembatan renderer <-> Core untuk Web Lokal (0.34.0 Fase D.6). Dipanggil dari register() di src/archne-ipc.js. UI di renderer/js/archne-web*.js.
// Aturan sama dengan Halaman: renderer hanya mengirim id peer / id situs / isian teks; semua dicek di sini sebelum menyentuh Core. Jalur berkas lokal TIDAK pernah keluar (hanya id situs, domain, judul, dst.).
// Kanal peminta (situs milik peer lain):
//   webAvail(peerId)                          -> { ok:true } | { ok:false, why:'self'|'peer'|'blocked'|'offline'|'old' } (tanpa jaringan)
//   webList(peerId, { after?, limit?, q? })   -> { ok:true, items:[{ id, domain, title, desc, tags, entry, rev, ts }], next, count }; diblokir / tanpa situs = items kosong (tak dibedakan)
// Kanal pemilik (situs di perangkat ini):
//   webMine()                                 -> { ok:true, items:[{ id, domain, title, desc, tags, priv, entry, rev, ts, n }] } terbaru dulu; n = jumlah berkas
//   webCreate({ domain, title?, desc?, tags?, priv? })  -> { ok:true, site }   visibilitas bawaan 'private' (keputusan Lampiran B no. 2)
//   webUpdate(id, { domain?, title?, desc?, tags?, priv? }) -> { ok:true, site }
//   webRemove(id)                             -> { ok:true }  (berkas hilang permanen)
//   webCheckDomain(domain, id?)               -> { ok:true, domain } (bentuk kanonik) | { ok:false, err, code:'dom'|'domres'|'domdup' }  cek langsung saat mengetik di Pengaturan; id = situs yang sedang diubah (domainnya sendiri tidak dianggap bentrok). Tanpa tulis.
//   webPreview(id)                            -> { ok:true, html, entry, inlined, external, missing[], limits[] }  pratinjau SEMENTARA (src/archne-webpreview.js); html dimuat renderer di iframe sandbox + CSP tanpa jaringan. Sejak F.4, tab Pratinjau memakai penampil (siteOpen dengan id sendiri); webPreview tinggal cadangan untuk platform tanpa penampil.
//   webUpdate juga menerima entry (berkas awal; harus berkas yang ada). Pengelola berkas: lihat src/archne-ipc-webfiles.js (webFiles, webFileRead, webFileView, webFileWrite, webMkdir, webRename, webMove, webDelete, webUpload). ZIP: src/archne-ipc-webzip.js (webZipList, webZipExtract, webZipExport).
//   Dasbor (U3, src/archne-webdash.js): webDash({ fresh? }) -> { ok, ts, platform, cpus, mem:{ total, free, app, src }, php:{ available, engine, line, max, active, waiting, workers[] }, mysql:{ kind:'emulated', version, running, sites[] }, storage:{ total, sites[{ id, domain, title, php, www, data, tmp, total, files }], partial } } (tanpa jalur disk); webDashPhp(id?) -> { ok, info:{ php, sqlite, ext[], mysqli, limits } } (Worker PHP dinyalakan bila perlu).
//   Jadikan offline (O1, src/archne-ipc-webassets.js): webAssetScan(id) -> { ok, files, scanned, bytes, skipped[], skippedN, limits[], items[], itemsN, hosts[], dynamic[], ignoredN } (baca saja, tanpa jaringan; bentuk item di src/archne-webassets.js).
//   Jadikan offline (O2e + O3, src/archne-ipc-weboffline.js): webOfflineApply(id) / webOfflineUndoInfo(id) / webOfflineUndo(id) = salin aset ke assets/vendor + tulis ulang referensi, dengan cadangan dan Batalkan (src/archne-weboffapply.js). webOfflineStart(id, { urls? }) -> ringkasan unduhan (menunggu selesai; kemajuan = event 'weboff'), webOfflineCancel(), webOfflineStatus(), webOfflineDiscard(). Mengunduh ke staging saja; tanpa jalur disk di keluaran.
//   Cronjob (C6, src/archne-ipc-webcron.js, hanya pemilik): webCronList, webCronAdd, webCronUpdate, webCronRemove, webCronRun, webCronLog, webCronLogClear, webCronCheck + kejadian 'webcron'. Hapus situs (webRemove) membuang cron dan lognya lebih dulu.
// Galat: { ok:false, err, code }. Galat ber-kunci i18n diterjemahkan (errText); galat sistem (EACCES dll, pesannya memuat jalur) diganti pesan umum.
const { errText, ek } = require('./core/archne-ecode');
const { registerWebFiles } = require('./archne-ipc-webfiles');
const { registerWebZip } = require('./archne-ipc-webzip');
const { registerWebAssets } = require('./archne-ipc-webassets');
const { registerWebOffline } = require('./archne-ipc-weboffline');
const { registerWebDb } = require('./archne-ipc-webdb');
const { registerWebCron, dropSiteCron } = require('./archne-ipc-webcron');
const { createDash } = require('./archne-webdash');
const { tryRel } = require('./archne-webfiles');
const { normDomain } = require('./archne-webdomain');
const { build: buildPreview } = require('./archne-webpreview');
const T = require('./core/archne-i18n-node').tr;
const HEX16 = /^[0-9a-f]{16}$/;
const CURSOR = /^\d+:[0-9a-f]{16}$/;
const STR_MAX = 2000; // batas kasar sebelum dikanonkan Core (batas sebenarnya: judul 80, deskripsi 300, kata kunci 10 x 24)
const TAGS_IPC_MAX = 50;
const FIELDS = ['domain', 'title', 'desc', 'tags', 'priv', 'php', 'lim']; // php = saklar Mesin PHP (boolean; Fase P.0); lim = batas sumber daya PHP / cron situs (objek bilangan bulat, src/archne-weblimits.js; null = kembali ke bawaan)

const fail = (e) => {
  const c = e && typeof e.code === 'string' ? e.code : '';
  if (e && typeof e.ek === 'string') return { ok: false, err: errText(e), code: c || 'bad' };
  if (c === 'ENOSPC') return { ok: false, err: T('e.io.full', null, 'Penyimpanan penuh'), code: c };
  return { ok: false, err: T('e.lw.ioFail', null, 'Gagal mengakses penyimpanan situs'), code: /^[A-Z0-9_]{2,20}$/.test(c) ? c : 'io' };
};
const bad = () => ({ ok: false, err: T('e.lw.err.bad', null, 'Permintaan tidak valid'), code: 'bad' });

// Isian situs dari renderer -> objek bersih atau null (bentuk salah). Hanya bidang yang dikenal; nilai diperiksa/dikanonkan oleh WebStore.
function fieldsOf(o, forCreate) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = {};
  for (const k of FIELDS) {
    if (!(k in o) || o[k] === undefined) continue;
    const v = o[k];
    if (k === 'tags') {
      if (typeof v === 'string') { if (v.length > STR_MAX) return null; }
      else if (!Array.isArray(v) || v.length > TAGS_IPC_MAX || v.some((x) => typeof x !== 'string' || x.length > STR_MAX)) return null;
    } else if (k === 'php') { if (typeof v !== 'boolean') return null; }
    else if (k === 'lim') { if (v !== null && (typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length > 12)) return null; } // isinya diperiksa WebStore (kunci dikenal, bilangan bulat, rentang)
    else if (typeof v !== 'string' || v.length > STR_MAX) return null;
    r[k] = v;
  }
  if (forCreate && typeof r.domain !== 'string') return null;
  return r;
}

function registerWeb({ ipcMain, core, guard, send, getPhpHost, pickSave, pickSql, metrics, getCron }) {
  const on = (name, fn) => ipcMain.handle(name, async (_e, ...a) => { try { return await fn(...a); } catch (e) { return fail(e); } });
  const peerOk = (id) => typeof id === 'string' && HEX16.test(id);
  const siteOk = (id) => typeof id === 'string' && HEX16.test(id);
  const optsOf = (o) => {
    if (o == null) return {};
    if (typeof o !== 'object' || Array.isArray(o)) return null;
    const r = {};
    if (o.after != null) { if (typeof o.after !== 'string' || !CURSOR.test(o.after)) return null; r.after = o.after; }
    if (o.limit != null) { if (!Number.isInteger(o.limit)) return null; r.limit = o.limit; }
    if (o.q != null) { if (typeof o.q !== 'string' || o.q.length > 64) return null; r.q = o.q; }
    return r;
  };
  // Hanya bidang bersih yang keluar (tanpa jalur, tanpa bidang tak dikenal).
  const pubSite = (s) => ({ id: s.id, domain: s.domain, title: s.title, desc: s.desc, tags: Array.isArray(s.tags) ? s.tags.slice() : [], entry: s.entry, rev: s.rev, ts: s.ts });
  const mySite = (s) => Object.assign(pubSite(s), { priv: s.priv }, s.php ? { php: true } : {}, s.lim ? { lim: Object.assign({}, s.lim) } : {}); // php hanya ada bila menyala: bentuk situs statis tidak berubah

  on('webAvail', (peerId) => (peerOk(peerId) ? core.webAvail(peerId) : { ok: false, why: 'peer' }));
  on('webList', async (peerId, o) => {
    const opts = optsOf(o);
    if (!peerOk(peerId) || !opts) return bad();
    const r = await core.webRemoteList(peerId, opts); // galat ber-code (self | peer | blocked | offline | old | auth | time | busy | bad | proto) -> fail()
    return { ok: true, items: r.items.map(pubSite), next: typeof r.next === 'string' ? r.next : null, count: Number.isInteger(r.count) ? r.count : 0 };
  });

  on('webMine', () => ({ ok: true, items: core.webMine().map((s) => Object.assign(mySite(s), { n: Number.isInteger(s.n) ? s.n : 0 })) }));
  on('webCreate', (o) => {
    const f = fieldsOf(o, true);
    if (!f) return bad();
    return { ok: true, site: mySite(core.webStore().create(f)) };
  });
  on('webUpdate', async (id, o) => {
    const f = fieldsOf(o, false);
    if (!siteOk(id) || !f) return bad();
    const ws = core.webStore();
    if (!ws.has(id)) return { ok: false, err: T('e.lw.siteNone', null, 'Situs tidak ditemukan'), code: 'nosite' };
    if (o.entry !== undefined) { // berkas awal (Fase E.5): harus berkas yang sudah ada di www/ (bidang ini TIDAK diterima saat membuat situs)
      const e = typeof o.entry === 'string' ? tryRel(o.entry) : null, st = e && ws.files(id).stat(e);
      if (!st || st.type !== 'file') throw ek('e.lw.entryBad', null, 'Berkas awal harus berkas yang sudah ada di situs', 'entry');
      f.entry = e;
    }
    const before = ws.get(id), site = ws.update(id, f);
    // Batas PHP dibaca saat Worker dibuat: berubah (atau Mesin PHP dinyala / dimatikan) = router + Worker situs ini dibuang dan dibuat ulang dengan nilai baru. Judul / visibilitas dst. tidak menyentuh Worker.
    if (JSON.stringify(before.lim || null) !== JSON.stringify(site.lim || null) || !!before.php !== !!site.php) { const h = getPhpHost && getPhpHost(); if (h && typeof h.reload === 'function') { try { h.reload(id); } catch { /* */ } } }
    // Fase 6g: Mesin PHP situs DIMATIKAN = server MySQL-nya (juga yang di-pin dari tombol) ikut dimatikan dan ditunggu sampai Worker keluar; tab Database tidak bisa memuat daftar tanpa Mesin PHP (phpoff), jadi tanpa ini server hidup tanpa tombol Matikan.
    if (before.php && !site.php) { const h = getPhpHost && getPhpHost(), p = h && h.mysqlPower; if (p && typeof p.stop === 'function') { try { await p.stop(id); } catch { /* */ } } }
    return { ok: true, site: mySite(site) };
  });
  on('webCheckDomain', (domain, id) => {
    if (typeof domain !== 'string' || domain.length > 100 || (id != null && !siteOk(id))) return bad();
    const d = normDomain(domain), ws = core.webStore();
    if (ws.list().some((s) => s.domain === d && s.id !== id)) throw ek('e.lw.domTaken', null, 'Domain sudah dipakai situs lain di perangkat ini', 'domdup');
    return { ok: true, domain: d };
  });
  on('webPreview', (id) => {
    if (!siteOk(id)) return bad();
    const ws = core.webStore();
    if (!ws.has(id)) return { ok: false, err: T('e.lw.siteNone', null, 'Situs tidak ditemukan'), code: 'nosite' };
    const r = buildPreview(ws.files(id), ws.get(id).entry);
    return { ok: true, html: r.html, entry: r.entry, inlined: r.inlined, external: r.external, missing: r.missing, limits: r.limits };
  });
  on('webRemove', (id) => {
    if (!siteOk(id)) return bad();
    const ws = core.webStore();
    if (!ws.has(id)) return { ok: false, err: T('e.lw.siteNone', null, 'Situs tidak ditemukan'), code: 'nosite' };
    dropSiteCron(getCron && getCron(), id); // Cronjob C6: cron + lognya dibuang DULU (gagal tulis = situs tidak dihapus), jadi tidak ada cron yatim
    ws.remove(id);
    return { ok: true };
  });
  const running = new Set(); // satu operasi berkas per situs (unggah / ekstrak / ekspor)
  registerWebFiles({ on, core, guard, send, running });
  registerWebZip({ on, core, send, pickSave, running });
  registerWebAssets({ on, core, running }); // O1: pemindai aset eksternal (baca saja)
  const offline = registerWebOffline({ on, core, send, running }); // O2e + O3: unduh aset ke staging, lalu Apply menulis ulang situs (dengan cadangan)
  registerWebDb({ on, core, getPhpHost, pickSql, pickSave, send });
  registerWebCron({ on, core, send, getCron }); // Cronjob C6: hanya pemilik (src/archne-ipc-webcron.js)
  // Dasbor (U3): hanya untuk pemilik (kanal renderer <-> Core; tidak ada jalan dari peer / lw_req). Keluaran tanpa jalur disk.
  const dash = createDash({ core, getPhpHost, metrics });
  on('webDash', async (o) => {
    if (o != null && (typeof o !== 'object' || Array.isArray(o))) return bad();
    return dash.snapshot({ fresh: !!(o && o.fresh === true) });
  });
  on('webDashPhp', async (id) => { // info PHP yang disaring (versi, ekstensi, batas); id opsional (situs PHP mana yang dipakai bootnya)
    if (id != null && !siteOk(id)) return bad();
    let v;
    try { v = await dash.phpInfo(id || ''); }
    catch (e) {
      if (e && e.code === 'nophp') throw ek('e.dash.noPhp', null, 'Mesin PHP tidak tersedia di perangkat ini', 'nophp');
      if (e && e.code === 'nophpsite') throw ek('e.dash.noPhpSite', null, 'Belum ada situs dengan Mesin PHP menyala', 'nophpsite');
      throw ek('e.dash.phpFail', null, 'Info PHP tidak bisa dimuat. Coba lagi.', 'io');
    }
    return { ok: true, info: v };
  });
  return { fieldsOf, optsOf, offline }; // offline.take(id): untuk O3
}

module.exports = { registerWeb, fieldsOf };

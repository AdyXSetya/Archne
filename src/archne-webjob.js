'use strict';
// src/archne-webjob.js — Sambungan "Jadikan offline" (0.34.0 Fase O2d-5): pemindai O1 -> pelari O2c (archne-webrun) -> penulis staging O2d-3 (archne-webstage). Tanpa IPC, tidak menyentuh situs (www/); tidak mengubah apa pun selain folder pekerjaannya sendiri di root staging.
// API: runJob(list, opts, deps) -> Promise (TIDAK PERNAH menolak/melempar) ->
//   { ok:true, aborted:false, total, fetched, failed, bytes, limits:[kode], job, dir, filesDir, manifest } | { ok:true, aborted:true, total, fetched, failed, bytes, limits, job } | { ok:false, code:'bad'|'root'|'io' }
//   list  = butir pemindai O1: [{ url, kind, cls?, integrity? }] (cls selain 'local' ditolak runAll tanpa jaringan; integrity = string atribut dari O1, diverifikasi oleh webstage/websri).
//   opts  = { root (WAJIB, absolut: root staging, mis. <dataDir>/webstage; divalidasi oleh webstage.open => 'root' bila bukan jalur absolut), signal, ms, onProgress, now } + opsi pengambil yang diteruskan runAll ({ idleMs } dan HANYA UNTUK TES { allowHttp, allowPrivate, ports, ca }).
//   deps  (tes) = { fetchOne, request, lookup, fsp, assign }: diteruskan utuh ke runAll (dan dari sana ke fetchOne) serta fsp / assign ke webstage.open.
//   fetched/failed/bytes = hitungan PENGAMBILAN (runAll). Hasil akhir yang benar-benar tertulis dan yang ditolak penulis (sri, hash, quota, path, io, ...) ada di manifest.items / manifest.rejected / manifest.totals.
// Sikap: badan TIDAK menumpuk di memori: tiap butir selesai langsung diserahkan ke stage.add (salinan dangkal + integrity dari list) dan dibuang dari hasil runAll (dropBody). Yang menahan memori hanya yang sedang diunduh / ditulis (<= 3 x 8 MB, dan batas 48 MB runAll).
//   Batal / tenggat (aborted:true) = SELURUH pekerjaan dibuang (folder staging dihapus, tanpa manifest): sebagian salinan tidak boleh dipakai O3 menulis ulang situs. Pemanggil (O2e) menampilkan hitungan dan mengulang bila perlu.
//   Selesai normal = commit: manifest.json ditulis, folder pekerjaan disimpan sampai disapu archne-webclean (24 jam) atau dipakai O3. Satu butir gagal tidak menggagalkan pekerjaan; manifest.rejected memuat alasannya.
//   Pembersihan saat start (archne-webclean.sweep dengan startup:true) dipanggil pemanggil, bukan di sini.
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/webjob.js): tiap penjaga satu baris.
const R = require('./archne-webrun');
const ST = require('./archne-webstage');

const PASS = ['ms', 'idleMs', 'allowHttp', 'allowPrivate', 'ports', 'ca', 'signal'];
const bad = (code) => ({ ok: false, code });

async function runJob(list, opts, deps) {
  let stage = null;
  try {
    opts = opts && typeof opts === 'object' ? opts : {};
    deps = deps && typeof deps === 'object' ? deps : {};
    if (!Array.isArray(list)) return bad('bad');
    const o = await ST.open(opts.root, Number.isFinite(opts.now) ? { now: opts.now } : {}, { fsp: deps.fsp, assign: deps.assign });
    if (!o.ok) return bad(o.code === 'bad' ? 'root' : 'io');
    stage = o.stage;
    const ro = { dropBody: true }; // G:drop
    for (const k of PASS) if (opts[k] !== undefined) ro[k] = opts[k];
    if (typeof opts.onProgress === 'function') ro.onProgress = opts.onProgress;
    ro.onResult = (e) => {
      const src = list[e.i]; // runAll hanya memproses 500 butir pertama list, jadi indeks e.i sama dengan indeks list
      const integ = src && typeof src === 'object' ? src.integrity : undefined;
      stage.add(Object.assign({}, e, { integrity: integ })); // G:integ — add() tidak pernah menolak; commit() menunggu semua yang tertunda
    };
    const res = await R.runAll(list, ro, deps);
    if (!res || !res.ok) { await stage.abort(); return bad('bad'); }
    const head = { total: res.total, fetched: res.okN, failed: res.failN, bytes: res.bytes, limits: res.limits.slice() };
    if (res.aborted) { await stage.abort(); return Object.assign({ ok: true, aborted: true }, head, { job: stage.job }); } // G:discard
    const c = await stage.commit();
    if (!c.ok) return bad('io'); // commit gagal sudah menghapus folder pekerjaan
    return Object.assign({ ok: true, aborted: false }, head, { job: stage.job, dir: c.dir, filesDir: c.filesDir, manifest: c.manifest });
  } catch {
    if (stage) { try { await stage.abort(); } catch { /* */ } }
    return bad('io');
  }
}

module.exports = { runJob };

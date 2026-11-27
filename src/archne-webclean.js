'use strict';
// src/archne-webclean.js — Pembersih staging untuk "Jadikan offline" (0.34.0 Fase O2d-4). Menghapus folder pekerjaan lama/yatim di root staging (<dataDir>/webstage). Tanpa jaringan, tanpa IPC, tidak menyentuh situs (www/).
// (Pembersihan saat abort sudah ada di webstage.abort(); modul ini untuk saat start dan berdasarkan umur.)
// API: sweep(root, opts?, deps?) -> Promise (TIDAK PERNAH menolak/melempar) ->
//   { ok:true, removed:[job], kept:[job], skipped:[nama], failed:[job], capped:boolean } | { ok:false, code:'bad'|'link'|'io' }
//   root = jalur absolut root staging. Tidak ada root = ok:true tanpa apa-apa.
//   opts: { startup:boolean, now, incompleteMs, keepMs, active:[job] }
//     startup:true  = dipanggil saat aplikasi baru mulai: pekerjaan TANPA manifest.json adalah yatim (prosesnya sudah mati) dan dihapus berapa pun umurnya.
//     startup:false = pekerjaan tanpa manifest dihapus bila umurnya >= incompleteMs (bawaan 2 jam).
//     Pekerjaan BERMANIFEST (commit selesai) disimpan keepMs (bawaan 24 jam) dari waktu pembuatannya, lalu dihapus. Umur dibaca dari nama folder (j<ms>-<hex8>), bukan dari mtime.
//     Waktu pembuatan > 24 jam di depan `now` (jam dimundurkan / nama dipalsukan) dianggap sampah dan kedaluwarsa; selisih yang lebih kecil dianggap umur 0.
//     active = nama pekerjaan yang tidak boleh disentuh; digabung dengan webstage.liveJobs() (pekerjaan terbuka di proses ini).
//   deps (tes): { fsp, live } pengganti fs.promises / ()=>Set pekerjaan terbuka.
// Sikap: HANYA entri yang namanya cocok JOB_RE dan berupa folder sungguhan (bukan tautan simbolik, bukan berkas) yang boleh dihapus; entri lain dilewati dan dilaporkan di skipped, tidak pernah dihapus. Penghapusan memakai rm recursive pada jalur
//   root/<nama> yang namanya sudah lolos JOB_RE (tanpa pemisah jalur), jadi tidak bisa keluar dari root. Satu kegagalan hapus tidak menghentikan yang lain. Paling banyak 1000 entri diperiksa (capped:true bila lebih).
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/webclean.js): tiap penjaga satu baris.
const nodeFs = require('fs'), path = require('path');
const ST = require('./archne-webstage');

const LIM = { incompleteMs: 2 * 3600e3, keepMs: 24 * 3600e3, futureMs: 24 * 3600e3, entries: 1000 };
const bad = (code) => ({ ok: false, code });
const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);

async function sweep(root, opts, deps) {
  try {
    opts = opts && typeof opts === 'object' ? opts : {};
    deps = deps && typeof deps === 'object' ? deps : {};
    if (typeof root !== 'string' || !root || !path.isAbsolute(root)) return bad('bad');
    const fsp = deps.fsp || nodeFs.promises;
    const base = path.resolve(root);
    let st;
    try { st = await fsp.lstat(base); } catch (e) { return e && e.code === 'ENOENT' ? { ok: true, removed: [], kept: [], skipped: [], failed: [], capped: false } : bad('io'); }
    if (st.isSymbolicLink()) return bad('link'); // G:root
    try { if (!(await fsp.stat(base)).isDirectory()) return bad('io'); } catch { return bad('io'); } // harus folder (stat mengikuti tautan; penolakan tautan ada di G:root)
    let names;
    try { names = await fsp.readdir(base); } catch { return bad('io'); }
    names.sort();
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const incMs = num(opts.incompleteMs, LIM.incompleteMs), keepMs = num(opts.keepMs, LIM.keepMs);
    const live = typeof deps.live === 'function' ? deps.live() : ST.liveJobs();
    const active = new Set(Array.isArray(opts.active) ? opts.active.filter((x) => typeof x === 'string') : []);
    const out = { ok: true, removed: [], kept: [], skipped: [], failed: [], capped: false };
    if (names.length > LIM.entries) { names = names.slice(0, LIM.entries); out.capped = true; } // G:cap
    for (const name of names) {
      if (!ST.JOB_RE.test(name)) { out.skipped.push(name); continue; } // G:name
      if (live.has(name) || active.has(name)) { out.kept.push(name); continue; } // G:active
      const dir = path.join(base, name);
      let s;
      try { s = await fsp.lstat(dir); } catch { out.failed.push(name); continue; }
      if (s.isSymbolicLink() || !s.isDirectory()) { out.skipped.push(name); continue; } // G:link
      let done = false;
      try { done = (await fsp.lstat(path.join(dir, 'manifest.json'))).isFile(); } catch { done = false; }
      const created = Number(name.slice(1, name.indexOf('-'))); // sama dengan m[1] bagi nama yang lolos JOB_RE
      let age = now - created;
      if (age < -LIM.futureMs) age = Infinity; // G:future
      else if (age < 0) age = 0;
      const expired = done ? age >= keepMs : (opts.startup === true || age >= incMs); // G:start
      if (!expired) { out.kept.push(name); continue; } // G:age
      try { await fsp.rm(dir, { recursive: true, force: true }); out.removed.push(name); } catch { out.failed.push(name); }
    }
    return out;
  } catch { return bad('io'); }
}

module.exports = { sweep, LIM };

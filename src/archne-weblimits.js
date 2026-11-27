'use strict';
// src/archne-weblimits.js — Batas sumber daya per situs PHP (tab Pengaturan situs). Hanya data + pemetaan: tanpa disk, tanpa Worker, tanpa IPC.
// Disimpan di site.json sebagai site.lim = { mem?, up?, exec?, idle?, cronN?, cronMs? } dan HANYA berisi kunci yang berbeda dari bawaan (tidak ada lim = bawaan = perilaku lama persis).
//   mem    = memory_limit PHP, MB            (bawaan 128)    -> php.ini memory_limit
//   up     = upload_max_filesize + post_max_size, MB (64)    -> php.ini; juga batas badan permintaan di router
//   exec   = batas waktu satu permintaan PHP, detik (30)     -> lewat itu Worker dihentikan (504)
//   idle   = Worker nganggur ditutup setelah, detik (120)    -> HP kecil: kecilkan supaya RAM cepat kembali
//   cronN  = jumlah cron maksimal untuk situs ini (10)
//   cronMs = batas waktu satu eksekusi cron, detik (300)
// Rentang di bawah hanya pagar kewarasan (nilai di luarnya pasti tidak masuk akal atau melampaui batas memori WASM 32-bit), BUKAN pagar kebijakan:
// memilih angka besar di perangkat kecil adalah keputusan pemilik; Dasbor menunjukkan pemakaian sebenarnya.
const { ek } = require('./core/archne-ecode');

const DEF = { mem: 128, up: 64, exec: 30, idle: 120, cronN: 10, cronMs: 300 };
const RANGE = { mem: [16, 2048], up: [1, 2048], exec: [5, 3600], idle: [10, 3600], cronN: [1, 100], cronMs: [1, 3600] };
const KEYS = Object.keys(DEF);
const MB = 1024 * 1024;

const bad = () => ek('e.lw.limBad', null, 'Batas sumber daya tidak valid. Isi bilangan bulat dalam rentang yang diizinkan (memori 16–2048 MB, unggahan 1–2048 MB, waktu permintaan 5–3600 dtk, Worker nganggur 10–3600 dtk, cron 1–100, waktu cron 1–3600 dtk)', 'limbad');

// Masukan bebas -> bentuk kanonik ({} diganti null). Kunci tak dikenal / bukan bilangan bulat / di luar rentang = galat. Nilai yang sama dengan bawaan dibuang.
function clean(v) {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
  const out = {};
  for (const k of Object.keys(v)) if (!KEYS.includes(k)) throw bad();
  for (const k of KEYS) {
    if (!(k in v) || v[k] === undefined) continue;
    const n = v[k];
    if (!Number.isInteger(n) || n < RANGE[k][0] || n > RANGE[k][1]) throw bad();
    if (n !== DEF[k]) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}
// Dari disk: harus sudah kanonik (persis hasil clean). Mengembalikan { ok, lim } agar normSite bisa menolak berkas yang diubah tangan.
function fromDisk(v) {
  if (v === undefined) return { ok: true, lim: null };
  try { const c = clean(v); if (!c || JSON.stringify(c) !== JSON.stringify(v)) return { ok: false }; return { ok: true, lim: c }; } catch { return { ok: false }; }
}
const resolve = (lim) => Object.assign({}, DEF, lim || {});
// Nilai php.ini yang menyimpang dari bawaan Worker (kosong = bawaan; tidak ada perubahan bagi situs yang tidak mengatur apa pun).
function iniFor(lim) {
  const o = {}; if (!lim) return o;
  if (lim.mem !== undefined) o.memory_limit = lim.mem + 'M';
  if (lim.up !== undefined) { o.upload_max_filesize = lim.up + 'M'; o.post_max_size = lim.up + 'M'; }
  return o;
}
// Opsi router / pool (milidetik / byte) HANYA untuk kunci yang diatur pemilik: yang tidak diatur tidak ditimpa, jadi opsi host (poolOpts) dan bawaan pool tetap berlaku.
function routeOpts(lim) {
  const o = {}; if (!lim) return o;
  if (lim.exec !== undefined) o.timeoutMs = lim.exec * 1000;
  if (lim.idle !== undefined) o.idleMs = lim.idle * 1000;
  if (lim.up !== undefined) o.maxBody = lim.up * MB + MB;
  return o;
}
// Router cron: pagar cadangan di pool = batas job + 30 dtk (yang menghentikan job tepat waktu tetap penjadwal, job.ms).
function cronRouteOpts(lim) { return lim && lim.cronMs !== undefined ? { timeoutMs: lim.cronMs * 1000 + 30000 } : {}; }
// Batas cron untuk satu situs (milidetik). custom = pemilik mengubah salah satu batas cron (maka batas total global tidak lagi menjadi pagar: keputusan pemilik).
function cronOf(lim) {
  const r = resolve(lim);
  return { perSite: r.cronN, msMax: r.cronMs * 1000, custom: !!(lim && (lim.cronN !== undefined || lim.cronMs !== undefined)) };
}

module.exports = { DEF, RANGE, KEYS, clean, fromDisk, resolve, iniFor, routeOpts, cronRouteOpts, cronOf };

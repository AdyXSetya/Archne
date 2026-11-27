'use strict';
// Web Lokal (Fase B.3): validasi dan normalisasi nama domain situs. Murni fungsi, tanpa berkas dan tanpa jaringan.
// Domain = SATU label, ditampilkan sebagai `label.archne`. Unik hanya di perangkat pemilik (identitas sebenarnya = id pemilik + domain).
//   aturan: a-z, 0-9, tanda hubung; 3 sampai 32 karakter; tidak diawali/diakhiri tanda hubung; tanpa "--" (menutup pintu punycode `xn--`, jadi tidak ada nama yang menyamar dengan huruf mirip).
//   masukan boleh berhuruf besar atau berakhiran ".archne"; hasil normalisasi selalu huruf kecil tanpa akhiran.
//   huruf besar diubah HANYA untuk A-Z (bukan toLowerCase penuh): toLowerCase mengubah U+212A (tanda Kelvin) menjadi "k" biasa, sehingga nama berhuruf Unicode bisa lolos sebagai ASCII.
const { ek } = require('./core/archne-ecode');

const SUFFIX = '.archne';
const DOM_MIN = 3, DOM_MAX = 32;
const DOM_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
// Dicadangkan: nama yang bermakna khusus di Archne/peramban, dan nama perangkat Windows (jaga-jaga bila label pernah dipakai sebagai nama folder).
const RESERVED = new Set(['archne', 'localhost', 'www', 'con', 'prn', 'aux', 'nul']);
const DEVICE = /^(com|lpt)[0-9]$/;

const lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

// Mengembalikan label bersih atau melempar galat berkunci. code: 'dom' (bentuk), 'domres' (dicadangkan).
function normDomain(input) {
  if (typeof input !== 'string') throw ek('e.lw.domBad', null, 'Domain harus 3 sampai 32 karakter: huruf kecil, angka, dan tanda hubung (tidak di awal atau akhir)', 'dom');
  let s = lower(input.trim());
  if (s.endsWith(SUFFIX)) s = s.slice(0, -SUFFIX.length);
  if (s.length < DOM_MIN || s.length > DOM_MAX || !DOM_RE.test(s) || s.includes('--')) {
    throw ek('e.lw.domBad', null, 'Domain harus 3 sampai 32 karakter: huruf kecil, angka, dan tanda hubung (tidak di awal atau akhir)', 'dom');
  }
  if (RESERVED.has(s) || DEVICE.test(s)) throw ek('e.lw.domReserved', null, 'Nama domain ini dicadangkan', 'domres');
  return s;
}
// Versi tanpa melempar: label bersih atau null (untuk membaca data yang mungkin rusak).
function tryDomain(input) { try { return normDomain(input); } catch { return null; } }
const showDomain = (label) => label + SUFFIX;

module.exports = { normDomain, tryDomain, showDomain, SUFFIX, DOM_MIN, DOM_MAX };

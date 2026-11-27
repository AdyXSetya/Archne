'use strict';
// Deteksi formulir kata sandi pada halaman situs milik orang lain (0.34.0 Fase G.2b). Hanya mencari <input type=password> di teks HTML yang SUDAH dilayani penampil
// (awal berkas HTML statis, atau badan jawaban PHP); hasilnya hanya memunculkan strip peringatan di bilah (state `pw`). Ini lapis peringatan, BUKAN perlindungan:
// kata sandi tidak bisa terkirim ke luar karena jaringan luar mati dan form-action 'none' (situs statis) / 'self' (situs PHP, hanya ke situs itu sendiri).
// Batas yang diumumkan: kolom yang dibuat skrip setelah halaman dimuat, entitas HTML pada nilai `type`, dan halaman yang kolomnya di luar jendela baca TIDAK terdeteksi.
const SCAN_MAX = 1048576; // paling banyak 1 MB awal badan yang dipindai
const RE = /<input\b[^>]*?\stype\s*=\s*["']?\s*password\b/i;

// buf: Buffer | Uint8Array | string -> true bila ada <input type=password>.
function hasPasswordField(buf) {
  let s;
  if (typeof buf === 'string') s = buf.length > SCAN_MAX ? buf.slice(0, SCAN_MAX) : buf;
  else if (buf && typeof buf.length === 'number') s = Buffer.from(buf.buffer ? buf.subarray(0, SCAN_MAX) : buf).toString('latin1'); // latin1: satu byte = satu karakter, ASCII tidak rusak oleh UTF-8 acak
  else return false;
  return RE.test(s);
}
const isHtmlType = (ct) => typeof ct === 'string' && /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(ct);

// Dipanggil penampil untuk tiap halaman yang dilayani. headers = header jawaban PHP ({ nama: [nilai] }, Content-Type diperiksa); tanpa headers, isinya sudah pasti HTML (berkas .html statis).
// Situs sendiri (pratinjau) tidak pernah memicu peringatan.
function scan(cur, buf, headers) {
  if (!cur || typeof cur.onPw !== 'function' || cur.own || !buf || !buf.length) return;
  if (headers !== undefined) { const cts = headers && headers['content-type']; if (!(Array.isArray(cts) && cts.some(isHtmlType))) return; }
  if (hasPasswordField(buf)) cur.onPw();
}
// Pembuat onPw untuk satu pembukaan: menandai c.pw sekali (hanya bila pembukaan itu masih aktif menurut live()), lalu push() mengumumkan state.
const hook = (c, live, push) => () => { if (live() && !c.pw) { c.pw = true; push(); } };

module.exports = { hasPasswordField, isHtmlType, scan, hook, SCAN_MAX };

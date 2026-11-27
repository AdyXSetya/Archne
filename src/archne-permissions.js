'use strict';
// Izin jendela utama: MIKROFON dan KAMERA (panggilan video, v0.20.x) dan hanya untuk halaman aplikasi sendiri (renderer/ lewat file://).
// Semua izin lain (lokasi, notifikasi web, dll.) ditolak. Dipisah dari main.js supaya bisa dites tanpa Electron.
const path = require('path');
const { fileURLToPath } = require('url');

function isAppUrl(u, rendererDir) {
  try {
    const p = new URL(String(u));
    if (p.protocol !== 'file:') return false;
    const f = path.resolve(fileURLToPath(p)), dir = path.resolve(rendererDir);
    return f === dir || f.startsWith(dir + path.sep);
  } catch { return false; }
}

// Pemeriksaan (permissionCheck) kadang hanya memberi origin `file://` tanpa jalur; jendela utama hanya memuat berkas lokal, jadi itu diterima.
const isAppOrigin = (o) => o === 'file://' || o === 'file:///';

// info: { url?, origin?, mediaTypes? (permintaan: ['audio'] ...), mediaType? (pemeriksaan: 'audio' | 'video' | 'unknown') }
function allowMedia(permission, info, rendererDir) {
  if (permission !== 'media') return false;
  info = info || {};
  if (!(isAppUrl(info.url, rendererDir) || (!info.url && isAppOrigin(info.origin)))) return false;
  if (Array.isArray(info.mediaTypes)) return info.mediaTypes.length > 0 && info.mediaTypes.every((t) => t === 'audio' || t === 'video'); // audio, video, atau keduanya
  return info.mediaType === 'audio' || info.mediaType === 'video';
}

// Tangkap layar (v0.32.0 C.3): izin 'display-capture' hanya untuk halaman Archne sendiri. Izin ini sendirian tidak menyerahkan layar apa pun:
// aliran layar hanya lahir dari session.setDisplayMediaRequestHandler (src/archne-screenpick.js), yang menolak halaman lain, mengharuskan pengguna memilih
// sumber sendiri; audio sistem (C.6) hanya ikut bila pengguna mencentangnya di dialog itu. Izin hanya untuk tipe video/audio; tipe lain ditolak di sini.
// info: { url?, origin?, mediaTypes? }
function allowDisplay(permission, info, rendererDir) {
  if (permission !== 'display-capture') return false;
  info = info || {};
  if (!(isAppUrl(info.url, rendererDir) || (!info.url && isAppOrigin(info.origin)))) return false;
  if (Array.isArray(info.mediaTypes) && info.mediaTypes.some((t) => t !== 'video' && t !== 'audio')) return false;
  return true;
}

// Salin ke papan klip: 'clipboard-sanitized-write' hanya untuk halaman Archne sendiri. Hanya menulis teks/gambar tersanitasi (tidak bisa membaca papan klip), dan hanya lewat gestur pengguna.
// Tanpa ini navigator.clipboard.writeText selalu ditolak di Electron, sehingga tombol Salin tidak pernah bekerja.
function allowClipboard(permission, info, rendererDir) {
  if (permission !== 'clipboard-sanitized-write') return false;
  info = info || {};
  return isAppUrl(info.url, rendererDir) || (!info.url && isAppOrigin(info.origin));
}

// Gabungan untuk setPermissionRequestHandler / setPermissionCheckHandler di main.js
const allowPermission = (permission, info, rendererDir) => allowMedia(permission, info, rendererDir) || allowDisplay(permission, info, rendererDir) || allowClipboard(permission, info, rendererDir);

module.exports = { allowMedia, allowDisplay, allowClipboard, allowPermission, isAppUrl };

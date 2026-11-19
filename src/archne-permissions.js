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

module.exports = { allowMedia, isAppUrl };

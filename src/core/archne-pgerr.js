'use strict';
// src/core/archne-pgerr.js — daftar galat Halaman (kode -> pesan) dan pembuat Error ber-`code`; dipakai archne-pages.js (1c) dan archne-pages-cmt.js (4b-2).
const PG_ERR = {
  peer: 'Peer tidak dikenal', self: 'Ini halamanmu sendiri', blocked: 'Kamu memblokir orang ini. Buka blokirnya dulu.',
  offline: 'Pemilik sedang offline. Halaman hanya bisa dibuka saat pemilik online.', old: 'Aplikasi pemilik belum mendukung Halaman.',
  auth: 'Pemilik menolak permintaanmu (tanda tangan tidak sah atau aplikasimu terlalu lama).', time: 'Jam perangkatmu dan jam pemilik berbeda terlalu jauh. Samakan jam, lalu coba lagi.', busy: 'Pemilik sedang sibuk. Coba lagi sebentar lagi.',
  many: 'Terlalu banyak unduhan berjalan. Tunggu salah satunya selesai.', streams: 'Terlalu banyak video diputar sekaligus. Jeda salah satunya, tunggu beberapa detik, lalu coba lagi.', gone: 'Berkas sudah tidak tersedia di pemilik.', cancel: 'Unduhan dibatalkan.', nodl: 'Pemilik mematikan unduhan untuk postingan ini.',
  full: 'Komentar pada postingan ini sudah penuh, atau kamu sudah terlalu banyak berkomentar di sini.', noparent: 'Komentar yang kamu balas sudah tidak ada.', qfull: 'Terlalu banyak komentar yang menunggu terkirim. Tunggu sampai pemiliknya online.', bad: 'Permintaan tidak valid', proto: 'Jawaban pemilik tidak dapat dibaca',
};
const pgErr = (code) => Object.assign(new Error(PG_ERR[code]), { code });
module.exports = { PG_ERR, pgErr };

'use strict';
// Helper tes (i18n E9a): kunci bahasa Core ke Indonesia untuk tes lama yang membaca teks Indonesia dari getState() (catatan grup dst.).
// Pakai di baris pertama tes SEBELUM membuat Core:  require('./_lang')();   (bahasa dibaca saat dipanggil, jadi berlaku untuk semua Core)
module.exports = (lang) => {
  const I = require('../src/core/archne-i18n-node'), real = I.bind;
  I.bind = () => real(() => lang || 'id');
};

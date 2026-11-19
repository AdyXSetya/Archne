'use strict';
// i18n (E2): galat Core yang bisa diterjemahkan di perbatasan (fail(), hasil job, nilai balik send).
//
//   throw ek('e.group.unknown', null, 'Grup tidak dikenal');
//   throw ek('e.file.tooBig', { max: '5 MB' }, 'Berkas melebihi 5 MB', 'toobig');   // argumen ke-4 (opsional) = e.code
//
// `.message` TETAP teks Indonesia (log dan tes lama tetap valid). `.ek` = kunci kamus, `.ep` = parameter.
// errText(e) dipakai di perbatasan: bila galat punya `.ek` -> terjemahan bahasa aktif (kamus bersama renderer/i18n/*.js),
// kalau tidak -> `.message` apa adanya (galat yang belum berkunci / internal tetap seperti sebelumnya).
const I18N = require('./archne-i18n-node');

function ek(key, params, idMsg, code) {
  // {x} di pesan Indonesia diisi dari params, jadi cadangan boleh ditulis literal ('... {max} ...') dan sama persis dengan archne-id.js (dijaga test/i18nipc.js)
  const ip = params ? I18N.numFmt(params, '.') : params; // angka >= 1000 bergaya Indonesia di .message
  const e = new Error(params ? String(idMsg).replace(/\{(\w+)\}/g, (m, k) => (k in ip ? String(ip[k]) : m)) : idMsg);
  e.ek = key;
  if (params) e.ep = params;
  if (code) e.code = code;
  return e;
}

// Teks galat untuk pengguna. Tidak pernah melempar.
function errText(e) {
  if (e && typeof e === 'object' && typeof e.ek === 'string') {
    let p = e.ep;
    if (p) { // parameter berupa Error (galat bersarang, mis. awalan "Gambar ke-N: ") ikut diterjemahkan
      p = {};
      for (const k of Object.keys(e.ep)) p[k] = e.ep[k] instanceof Error ? errText(e.ep[k]) : e.ep[k];
    }
    return I18N.tr(e.ek, p, e.message);
  }
  return (e && e.message) || String(e);
}

module.exports = { ek, errText };

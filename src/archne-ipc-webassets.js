'use strict';
// src/archne-ipc-webassets.js — kanal pemindai aset eksternal (0.34.0 Fase O1, "Jadikan offline"). Dipanggil dari registerWeb() (archne-ipc-web.js). BACA SAJA: tanpa jaringan, tanpa menulis, tanpa jalur disk di keluaran.
// Kanal:
//   webAssetScan(id) -> { ok:true, files, scanned, bytes, skipped, skippedN, limits, items, itemsN, hosts, dynamic, ignoredN } (bentuk: lihat src/archne-webassets.js) | { ok:false, err, code }
//   Satu pemindaian per situs sekaligus: panggilan kedua saat masih berjalan -> code 'busy'. Berbagi himpunan `running` dengan unggah / ZIP, jadi tidak bentrok dengan operasi berkas lain.
const { ek } = require('./core/archne-ecode');
const { scan } = require('./archne-webassets');
const HEX16 = /^[0-9a-f]{16}$/;

function registerWebAssets({ on, core, running }) {
  on('webAssetScan', async (id) => {
    if (typeof id !== 'string' || !HEX16.test(id)) throw ek('e.lw.err.bad', null, 'Permintaan tidak valid', 'bad');
    const ws = core.webStore();
    if (!ws.has(id)) throw ek('e.lw.siteNone', null, 'Situs tidak ditemukan', 'nosite');
    if (running.has(id)) throw ek('e.lw.zip.busy', null, 'Masih ada operasi berkas yang berjalan untuk situs ini', 'busy');
    running.add(id);
    try { return Object.assign({ ok: true }, await scan(ws.files(id))); }
    finally { running.delete(id); }
  });
}
module.exports = { registerWebAssets };

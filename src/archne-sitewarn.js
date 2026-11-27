'use strict';
// Peringatan pertama kali sebelum membuka situs milik orang lain (0.34.0 Fase G.2).
// Aturan: SEKALI PER PEMILIK (bukan per situs). Sebelum pemilik itu dikonfirmasi, siteOpen (src/archne-ipc.js, jalur yang sama dipakai Electron dan Android lewat RPC)
// menjawab { ok:false, code:'warn' } dan TIDAK menghubungi pemilik maupun menyalakan penampil. Renderer menampilkan halaman peringatan; hanya "Saya mengerti" yang memanggil siteWarnAck.
//  - Situs milik sendiri (pratinjau) tidak pernah diperingatkan.
//  - Catatan disimpan di store.json milik Core (store.siteWarn = { <idPemilik>: waktuKonfirmasi }); tidak ada hubungannya dengan situsnya, jadi situs tidak bisa membaca atau memalsukannya.
//  - Tanpa tabel (Core tiruan / store rusak) = BELUM dikonfirmasi: gagal tertutup, bukan terbuka.
//  - Berkas yang diedit tangan dibersihkan sekali per Core: kunci harus 16 heks, nilai bilangan terbatas, paling banyak MAX entri (yang tertua dibuang).
// Sengaja modul terpisah yang bekerja di atas core.store: Core.prototype tidak bertambah (test/api-surface.js menjaganya).
const HEX16 = /^[0-9a-f]{16}$/;
const MAX = 2000;
const cleaned = new WeakSet();

function table(core) {
  const S = core && core.store;
  if (!S || typeof S !== 'object') return null;
  let t = S.siteWarn;
  if (!t || typeof t !== 'object' || Array.isArray(t)) { t = S.siteWarn = {}; cleaned.add(t); return t; }
  if (!cleaned.has(t)) {
    for (const k of Object.keys(t)) if (!HEX16.test(k) || !Number.isFinite(t[k]) || t[k] <= 0) delete t[k];
    trim(t);
    cleaned.add(t);
  }
  return t;
}
function trim(t) {
  const ks = Object.keys(t);
  if (ks.length <= MAX) return;
  ks.sort((a, b) => t[a] - t[b]);
  for (const k of ks.slice(0, ks.length - MAX)) delete t[k];
}
const isSelf = (core, id) => !!core && typeof core.id === 'string' && core.id === id;

// Apakah pemilik ini sudah dikonfirmasi (atau milik sendiri)? id tidak sah = false.
function seen(core, id) {
  if (typeof id !== 'string' || !HEX16.test(id)) return false;
  if (isSelf(core, id)) return true;
  const t = table(core);
  return !!t && Object.prototype.hasOwnProperty.call(t, id);
}
// Perlu menampilkan peringatan sebelum membuka situs milik id ini? Id yang bentuknya tidak sah TIDAK dianggap perlu di sini: ditolak sebagai 'bad' oleh pembuka situs.
const needs = (core, id) => typeof id === 'string' && HEX16.test(id) && !seen(core, id);

// Catat konfirmasi. -> true bila tercatat (atau sudah ada); false untuk id tak sah, id sendiri, atau Core tanpa tabel.
function ack(core, id) {
  if (typeof id !== 'string' || !HEX16.test(id) || isSelf(core, id)) return false;
  const t = table(core);
  if (!t) return false;
  if (!Object.prototype.hasOwnProperty.call(t, id)) {
    t[id] = Date.now();
    trim(t);
    try { if (typeof core._save === 'function') core._save(); } catch {}
  }
  return true;
}

module.exports = { seen, needs, ack, MAX };

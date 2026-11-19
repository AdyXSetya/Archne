'use strict';
// Kamera foto dan video (v0.25.0 Step 3): hitungan murni untuk antarmuka kamera (renderer/js/archne-camera.js), dipisah supaya bisa dites dengan Node.
// Hasil jepretan/rekaman masuk ke jalur kirim berkas yang sama (sendFile): batas ukuran, tawaran, thumbnail, dan unduhan tidak berbeda dari berkas biasa.
// Foto dikodekan ulang lewat canvas, jadi tidak membawa EXIF (lokasi GPS dll). Rekaman dibatasi 720p dan bitrate tetap supaya muat batas ukuran chat.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Camera = factory();
})(this, function () {
  const VIDEO_MAX_MS = 120e3;            // rekaman maksimal 2 menit
  const REC_BYTES_MAX = 60 * 1048576;    // dihentikan otomatis bila sudah sebesar ini (di bawah batas baca 64 MB)
  const PHOTO_SIDE = 2560;               // sisi terpanjang foto hasil jepretan (px)
  const PHOTO_Q = 0.9;
  const BITS = { video: 2000000, audio: 64000 }; // 720p ~ 15 MB/menit
  // MP4 dulu: rekaman WebM dari MediaRecorder tidak punya durasi di header, sehingga seek-nya terbatas di pemutar. WebM hanya cadangan.
  const MIMES = [
    ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'], ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'], ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'], ['video/webm;codecs=vp8,opus', 'webm'], ['video/webm', 'webm'],
  ];
  // isSupported(mime) -> boolean (MediaRecorder.isTypeSupported). Hasil { mime, ext } atau null bila tidak ada yang didukung.
  function pickRecMime(isSupported) {
    if (typeof isSupported !== 'function') return null;
    for (const [mime, ext] of MIMES) { let ok = false; try { ok = !!isSupported(mime); } catch { ok = false; } if (ok) return { mime, ext }; }
    return null;
  }
  const p2 = (n) => String(n).padStart(2, '0');
  // IMG_20261116_143005.jpg / VID_20261116_143005.mp4 (waktu lokal). Ekstensi dari daftar tetap, bukan dari input.
  function shotName(kind, d, ext) {
    const e = kind === 'img' ? 'jpg' : (ext === 'mp4' ? 'mp4' : 'webm');
    d = d instanceof Date && !isNaN(d) ? d : new Date();
    return (kind === 'img' ? 'IMG_' : 'VID_') + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.' + e;
  }
  // Permintaan getUserMedia. facing: 'user' | 'environment'. Foto tanpa mikrofon (tidak perlu izin mikrofon).
  function constraints(mode, facing) {
    const f = facing === 'user' ? 'user' : 'environment';
    if (mode === 'video') return { video: { facingMode: { ideal: f }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }, audio: { echoCancellation: true, noiseSuppression: true } };
    return { video: { facingMode: { ideal: f }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false };
  }
  // Ukuran jepretan: sisi terpanjang <= PHOTO_SIDE, tidak diperbesar, sisi minimal 1.
  function photoDims(w, h) {
    w = Number(w) || 0; h = Number(h) || 0;
    if (!(w > 0 && h > 0)) return null;
    const s = Math.min(1, PHOTO_SIDE / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }
  // Info media untuk tawaran (src/archne-fileoffer.js checkX): { k, w?, h?, d? (ms), th? }. Nilai tidak sah dibuang, bukan dikirim.
  function buildX(kind, o) {
    o = o || {};
    const x = { k: kind === 'vid' ? 'vid' : 'img' };
    const i = (v, max) => Number.isSafeInteger(v) && v >= 1 && v <= max;
    if (i(o.w, 16384) && i(o.h, 16384)) { x.w = o.w; x.h = o.h; }
    if (x.k === 'vid') { const d = Math.round(Number(o.d)); if (i(d, 864e5)) x.d = d; }
    if (typeof o.th === 'string' && o.th) x.th = o.th;
    return x;
  }
  const fmtClock = (ms) => { const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000)); return Math.floor(s / 60) + ':' + p2(s % 60); };
  // Rekaman harus berhenti? ms = lama, bytes = ukuran terkumpul.
  const shouldStop = (ms, bytes) => ms >= VIDEO_MAX_MS || bytes >= REC_BYTES_MAX;
  // Isi file harus cocok jenisnya sebelum dikirim (tanda tangan JPEG / ftyp MP4 / EBML WebM); tanpa ini MediaRecorder yang aneh tetap terkirim sebagai berkas rusak.
  function looksRight(kind, ext, u8) {
    if (!u8 || u8.length < 12) return false;
    if (kind === 'img') return u8[0] === 0xff && u8[1] === 0xd8;
    if (ext === 'mp4') return String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) === 'ftyp';
    return u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3;
  }
  return { VIDEO_MAX_MS, REC_BYTES_MAX, PHOTO_SIDE, PHOTO_Q, BITS, MIMES, pickRecMime, shotName, constraints, photoDims, buildX, fmtClock, shouldStop, looksRight };
});

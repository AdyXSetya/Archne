'use strict';
// Pesan suara (v0.25.0 Step 4): hitungan murni untuk perekam (renderer/js/archne-voicenote.js), dipisah supaya bisa dites dengan Node.
// Hasil rekaman dikirim lewat api.sendVoice (BUKAN sendFile): hanya jalur itu yang boleh membuat tawaran `vc`. Batas di sini mencerminkan src/archne-fileoffer.js
// (VC_MAX_MS, VC_MAX_BYTES, kewajaran ukuran); penerima tetap memeriksa sendiri, jadi ini hanya mencegah rekaman yang pasti ditolak.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceNote = factory();
})(this, function () {
  const MAX_MS = 300e3;                 // 5 menit (= fileoffer.VC_MAX_MS)
  const MIN_MS = 1000;                  // lebih pendek dari ini dibuang (ketukan tidak sengaja)
  const MAX_BYTES = 4 * 1048576;        // dihentikan otomatis; di bawah batas 5 MB penerima
  const BPS = 32000;                    // Opus 32 kbps cukup untuk suara (~1 MB per 4 menit)
  const BPS_MAX = 40000, SLACK = 65536; // kewajaran ukuran: sama dengan fileoffer.vcSizeOk
  // Opus di WebM dulu (didukung Chromium/WebView dan kecil); Ogg dan MP4 sebagai cadangan. Ekstensi cocok dengan fileoffer.VC_NAME.
  const MIMES = [['audio/webm;codecs=opus', 'weba'], ['audio/ogg;codecs=opus', 'ogg'], ['audio/mp4;codecs=mp4a.40.2', 'm4a'], ['audio/mp4', 'm4a'], ['audio/webm', 'weba']];
  function pickRecMime(isSupported) {
    if (typeof isSupported !== 'function') return null;
    for (const [mime, ext] of MIMES) { let ok = false; try { ok = !!isSupported(mime); } catch { ok = false; } if (ok) return { mime, ext }; }
    return null;
  }
  const p2 = (n) => String(n).padStart(2, '0');
  // suara_20261116_143005.weba (waktu lokal). Ekstensi dari daftar tetap, bukan dari input. Core membuat nama tawaran sendiri; ini hanya nama berkas sementara.
  function fileName(d, ext) {
    const e = ext === 'ogg' || ext === 'm4a' ? ext : 'weba';
    d = d instanceof Date && !isNaN(d) ? d : new Date();
    return 'suara_' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.' + e;
  }
  // Hanya mikrofon, tanpa video.
  const constraints = () => ({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const shouldStop = (ms, bytes) => ms >= MAX_MS || bytes >= MAX_BYTES;
  const tooShort = (ms) => !(Number(ms) >= MIN_MS);
  // Lama yang dikirim: dibulatkan dan dijepit ke batas tawaran.
  const clampDur = (ms) => Math.min(MAX_MS, Math.max(MIN_MS, Math.round(Number(ms) || 0)));
  const sizeOk = (bytes, ms) => Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 5 * 1048576 && bytes <= (ms / 1000) * BPS_MAX + SLACK;
  // Isi harus cocok jenisnya (EBML WebM / OggS / ftyp MP4); tanpa ini MediaRecorder yang aneh tetap terkirim sebagai berkas rusak.
  function looksRight(ext, u8) {
    if (!u8 || u8.length < 12) return false;
    if (ext === 'weba') return u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3;
    if (ext === 'ogg') return String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) === 'OggS';
    if (ext === 'm4a') return String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) === 'ftyp';
    return false;
  }
  const fmtClock = (ms) => { const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000)); return Math.floor(s / 60) + ':' + p2(s % 60); };
  return { MAX_MS, MIN_MS, MAX_BYTES, BPS, MIMES, pickRecMime, fileName, constraints, shouldStop, tooShort, clampDur, sizeOk, looksRight, fmtClock };
});

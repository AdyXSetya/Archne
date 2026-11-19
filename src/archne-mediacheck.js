'use strict';
// Pemeriksaan byte gambar (v0.25.0 Step 1). Klaim `x.k: 'img'` pada tawaran hanyalah klaim pengirim; yang menentukan apakah sebuah berkas
// boleh ditampilkan sebagai foto adalah isinya. Dibaca dari header tanpa mendekode gambar: JPEG, PNG, GIF, WebP. SVG sengaja tidak termasuk
// (bisa memuat skrip dan rujukan luar). Berkas yang lolos pun hanya tampil lewat <img> (tanpa skrip) dan dibatasi jumlah pikselnya,
// supaya gambar kecil-di-disk-tapi-raksasa-di-memori tidak membekukan penampil.
const { jpegSize } = require('./archne-fileoffer');

const MAX_PIXELS = 64e6;          // 64 MP (mis. 8000 x 8000)
const VIEW_MAX = 32 * 1048576;    // byte maksimum yang dibaca untuk penampil / pratinjau kirim
const MIME = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
// Ekstensi nama berkas yang boleh memicu tampilan foto. Tampil = thumbnail di kartu; viewable = boleh dibuka di penampil Archne.
const THUMB_EXT = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|heic|heif)$/i;
const VIEW_EXT = /\.(jpe?g|jfif|png|gif|webp)$/i;

// Hasil { mime, w, h } atau null (bukan gambar yang dikenal, terpotong, atau dimensi tidak masuk akal).
function sniffImage(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  let r = null;
  if (b[0] === 0xff && b[1] === 0xd8) {
    const s = jpegSize(b);
    if (s) r = { mime: MIME.jpeg, w: s.w, h: s.h };
  } else if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('latin1', 12, 16) === 'IHDR') {
    r = { mime: MIME.png, w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } else if (b.length >= 10 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a')) {
    r = { mime: MIME.gif, w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  } else if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const t = b.toString('latin1', 12, 16);
    if (t === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) r = { mime: MIME.webp, w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    else if (t === 'VP8L' && b[20] === 0x2f) r = { mime: MIME.webp, w: 1 + (b[21] | ((b[22] & 0x3f) << 8)), h: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) };
    else if (t === 'VP8X') r = { mime: MIME.webp, w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  }
  if (!r || !(r.w > 0) || !(r.h > 0)) return null;
  return r;
}
const pixelsOk = (s) => !!s && s.w * s.h <= MAX_PIXELS;
const thumbName = (n) => THUMB_EXT.test(String(n || ''));
const viewName = (n) => VIEW_EXT.test(String(n || ''));


// ---- Audio/video (v0.25.0 Step 2) ----
// Pemutar bawaan hanya untuk format yang diputar Chromium/WebView tanpa pustaka tambahan. Klaim pengirim (x.k) tidak dipakai: yang menentukan
// adalah ekstensi nama berkas DAN isinya (kontainer dikenali dari byte awal, harus cocok dengan ekstensi). Format lain (mkv, avi, wmv, mov...)
// tidak diputar di sini; kartu menawarkan "Buka" dengan aplikasi lain.
const PLAY_MAX = 32 * 1048576;     // batas berkas untuk pemutar bawaan (dibaca utuh ke memori lalu jadi blob)
const AUD_FMT = { mp3: ['mp3'], m4a: ['mp4'], aac: ['aac', 'mp4'], ogg: ['ogg'], oga: ['ogg'], opus: ['ogg'], wav: ['wav'], flac: ['flac'], weba: ['webm'] };
const VID_FMT = { mp4: ['mp4'], m4v: ['mp4'], webm: ['webm'] };
const extOf = (n) => { const m = /\.([A-Za-z0-9]+)$/.exec(String(n || '')); return m ? m[1].toLowerCase() : ''; };
// -> { kind: 'aud'|'vid', ext } atau null (bukan format pemutar bawaan)
function playKind(name) {
  const e = extOf(name);
  if (Object.prototype.hasOwnProperty.call(AUD_FMT, e)) return { kind: 'aud', ext: e };
  if (Object.prototype.hasOwnProperty.call(VID_FMT, e)) return { kind: 'vid', ext: e };
  return null;
}
// Kontainer dari byte awal: 'mp3' | 'aac' | 'mp4' | 'ogg' | 'flac' | 'wav' | 'webm' | 'mkv' | null.
function sniffAv(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  const t = (o, n) => b.toString('latin1', o, o + n);
  if (t(0, 4) === 'OggS') return 'ogg';
  if (t(0, 4) === 'fLaC') return 'flac';
  if (t(0, 4) === 'RIFF' && t(8, 4) === 'WAVE') return 'wav';
  if (t(4, 4) === 'ftyp') return 'mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return b.subarray(0, 64).includes('webm') ? 'webm' : 'mkv';
  if (t(0, 3) === 'ID3') return 'mp3';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[2] >> 4) !== 15) {
    const layer = (b[1] >> 1) & 3;
    if (layer === 1) return 'mp3';
    if (layer === 0 && (b[1] & 0xf0) === 0xf0) return 'aac';
  }
  return null;
}
// MIME untuk blob pemutar, dari kontainer yang terbukti dan jenis (audio/video) ekstensinya. null bila isi tidak cocok dengan ekstensi.
function playMime(name, fmt) {
  const pk = playKind(name);
  if (!pk || !fmt) return null;
  const ok = (pk.kind === 'aud' ? AUD_FMT : VID_FMT)[pk.ext];
  if (!ok.includes(fmt)) return null;
  const a = pk.kind === 'aud';
  return { mp3: 'audio/mpeg', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav', mp4: a ? 'audio/mp4' : 'video/mp4', webm: a ? 'audio/webm' : 'video/webm' }[fmt] || null;
}

module.exports = { MAX_PIXELS, VIEW_MAX, MIME, sniffImage, pixelsOk, thumbName, viewName, PLAY_MAX, playKind, sniffAv, playMime };

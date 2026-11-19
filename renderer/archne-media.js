'use strict';
// Pratinjau foto untuk tawaran berkas (v0.25.0 Step 1). Saat mengirim foto, gambar dikecilkan jadi thumbnail JPEG kecil lewat canvas lalu
// dititipkan di tawaran (info media `x`), sehingga penerima langsung melihat fotonya tanpa mengunduh, bahkan bila pengirim sudah offline.
// Canvas mengodekan ulang gambar, jadi thumbnail tidak membawa data EXIF (lokasi GPS dll). Berkas yang dikirim tetap berkas aslinya.
// Hitungan (fitDims, pickThumb, plan) murni supaya bisa dites dengan Node; hanya forSend yang butuh browser (canvas).
// Core dan archne-ipc.js memeriksa ulang hasilnya (header JPEG, batas karakter, dimensi), jadi renderer tidak dipercaya.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Media = factory();
})(this, function () {
  // Batas harus sama dengan src/archne-fileoffer.js (TH_MAX, TH_DIM, DIM_MAX); test/mediaui.js menjaga keduanya tidak menyimpang.
  const TH_MAX = { public: 3000, direct: 7000 }; // karakter base64
  const DIM_MAX = 16384;
  const MAX_SRC = 32 * 1048576;
  // Publik ikut kuota byte, jadi thumbnail-nya jauh lebih kecil. Ukuran = sisi terpanjang (px), dicoba dari yang terbesar.
  const PLAN = {
    direct: { sizes: [256, 192, 144, 112, 80], q: [0.72, 0.6, 0.48, 0.36, 0.26] },
    public: { sizes: [128, 96, 72, 56, 40], q: [0.6, 0.46, 0.34, 0.24] },
  };
  const kindOf = (to) => (to === 'public' ? 'public' : 'direct');
  const IMG_NAME = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|heic|heif)$/i;
  const isImageName = (n) => IMG_NAME.test(String(n || ''));

  // Skala gambar w x h supaya sisi terpanjang = max (tidak pernah diperbesar). Sisi minimal 1.
  function fitDims(w, h, max) {
    const s = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }

  // encode(maxSide, quality) -> base64 atau null. Ambil yang pertama muat dalam batas karakter tujuan.
  function pickThumb(encode, to) {
    const k = kindOf(to), plan = PLAN[k], max = TH_MAX[k];
    for (const size of plan.sizes) for (const q of plan.q) {
      const b = encode(size, q);
      if (typeof b === 'string' && b.length > 0 && b.length <= max && b.length % 4 === 0) return { b64: b, size, quality: q };
    }
    return null;
  }

  // Info media untuk satu foto: { k:'img', w?, h?, th? } atau null bila bukan gambar yang bisa dibaca (berkas dikirim biasa).
  // src = path (Electron: bytes dibaca proses utama lewat api.mediaPrep) atau objek File (Android/peramban).
  async function forSend(src, to, api) {
    let blob, name = '';
    if (typeof src === 'string') {
      name = src;
      if (!isImageName(src) || !api || typeof api.mediaPrep !== 'function') return null;
      const r = await api.mediaPrep(src);
      if (!r || !r.ok || typeof r.b64 !== 'string') return null;
      const bin = atob(r.b64), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      blob = new Blob([u8], { type: r.mime || 'image/jpeg' });
    } else if (src && typeof src.size === 'number') {
      name = src.name || '';
      if (src.size > MAX_SRC || !(isImageName(name) || /^image\//.test(src.type || ''))) return null;
      blob = src;
    } else return null;
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch { return null; } // HEIC tanpa kodek, rusak, dll: kirim sebagai berkas biasa
    try {
      const x = { k: 'img' };
      if (bmp.width <= DIM_MAX && bmp.height <= DIM_MAX && bmp.width > 0 && bmp.height > 0) { x.w = bmp.width; x.h = bmp.height; }
      const r = pickThumb((side, q) => {
        const d = fitDims(bmp.width, bmp.height, side);
        const cv = document.createElement('canvas'); cv.width = d.w; cv.height = d.h;
        const g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, d.w, d.h); // PNG/GIF transparan: latar putih (JPEG tidak punya alfa)
        g.imageSmoothingQuality = 'high';
        g.drawImage(bmp, 0, 0, d.w, d.h);
        const u = cv.toDataURL('image/jpeg', q);
        return u.startsWith('data:image/jpeg;base64,') ? u.slice(23) : null;
      }, to);
      if (r) x.th = r.b64;
      return x;
    } finally { try { bmp.close(); } catch {} }
  }

  // Thumbnail JPEG dari sumber yang bisa digambar (canvas, <video>, ImageBitmap) berukuran w x h: base64 atau null bila tidak ada yang muat. (Kamera, Step 3)
  function thumbFrom(src, w, h, to) {
    if (!src || !(w > 0 && h > 0)) return null;
    try {
      const r = pickThumb((side, q) => {
        const d = fitDims(w, h, side);
        const cv = document.createElement('canvas'); cv.width = d.w; cv.height = d.h;
        const g = cv.getContext('2d');
        g.fillStyle = '#000'; g.fillRect(0, 0, d.w, d.h);
        g.imageSmoothingQuality = 'high';
        g.drawImage(src, 0, 0, d.w, d.h);
        const u = cv.toDataURL('image/jpeg', q);
        return u.startsWith('data:image/jpeg;base64,') ? u.slice(23) : null;
      }, to);
      return r ? r.b64 : null;
    } catch { return null; }
  }

  return { TH_MAX, DIM_MAX, PLAN, kindOf, isImageName, fitDims, pickThumb, forSend, thumbFrom };
});

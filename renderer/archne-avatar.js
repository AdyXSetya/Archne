'use strict';
// Foto profil (v0.7.4): mengecilkan gambar pilihan pengguna jadi JPEG persegi kecil (base64) sebelum dikirim ke Core.
// Hitungan geometri dan pencarian kualitas dipisah sebagai fungsi murni supaya bisa dites dengan Node; hanya fromFile yang butuh browser (canvas).
// Core tetap memeriksa ulang hasilnya (JPEG sah, ukuran dan dimensi), jadi renderer tidak dipercaya.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Avatar = factory();
})(this, function () {
  // i18n (D3): pesan galat tampil sebagai toast. Tanpa I18N (Node murni / tes vm lama) teks Indonesia cadangan dipakai.
  const T = (k, fb) => (typeof I18N !== 'undefined' && I18N.tx ? I18N.tx(k) : fb);
  const MAX_B64 = 14000, MAX_SRC = 25 * 1048576;
  const SIZES = [128, 96, 64];
  const QUALITIES = [0.85, 0.72, 0.6, 0.48, 0.36];

  // Potong tengah supaya persegi: { sx, sy, sw, sh } pada gambar sumber w x h.
  function cropSquare(w, h) {
    const s = Math.min(w, h);
    return { sx: Math.floor((w - s) / 2), sy: Math.floor((h - s) / 2), sw: s, sh: s };
  }

  // Coba tiap ukuran (besar ke kecil) dan kualitas (tinggi ke rendah); `encode(size, q)` -> base64 atau null. Ambil yang pertama muat.
  function pick(encode, max) {
    for (const size of SIZES) for (const q of QUALITIES) {
      const b = encode(size, q);
      if (typeof b === 'string' && b.length > 0 && b.length <= (max || MAX_B64)) return { b64: b, size, quality: q };
    }
    return null;
  }

  async function fromFile(file) {
    if (!file || !(file.size >= 0)) throw new Error(T('av.noFile', 'Berkas tidak dipilih'));
    if (file.size > MAX_SRC) throw new Error(T('av.tooBig', 'Gambar terlalu besar (maks 25 MB)'));
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { throw new Error(T('av.notImg', 'Berkas ini bukan gambar yang bisa dibaca')); }
    try {
      const c = cropSquare(bmp.width, bmp.height);
      const r = pick((size, q) => {
        const cv = document.createElement('canvas'); cv.width = cv.height = size;
        const g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); // PNG transparan: latar putih (JPEG tidak punya alfa)
        g.drawImage(bmp, c.sx, c.sy, c.sw, c.sh, 0, 0, size, size);
        const u = cv.toDataURL('image/jpeg', q);
        return u.startsWith('data:image/jpeg;base64,') ? u.slice(23) : null;
      });
      if (!r) throw new Error(T('av.tooComplex', 'Gambar terlalu rumit untuk dikecilkan; coba gambar lain'));
      return r.b64;
    } finally { try { bmp.close(); } catch {} }
  }

  return { cropSquare, pick, fromFile, MAX_B64, SIZES, QUALITIES };
});

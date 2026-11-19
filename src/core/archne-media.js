'use strict';
// src/core/archne-media.js — foto (v0.25.0 Step 1): membaca foto hasil unduhan untuk penampil, dan unduh otomatis foto yang masuk.
// Tawaran berkas membawa thumbnail kecil (x.th) yang tampil tanpa mengunduh apa pun. Foto penuh baru diambil saat diketuk,
// atau otomatis bila pengaturan `autoImg` menyala dan syarat di bawah terpenuhi.
const fs = require('fs');
const crypto = require('crypto');
const Media = require('../archne-mediacheck');
const T = require('./archne-i18n-node').tr; // galat untuk UI: dihitung saat dikembalikan (bukan saat berkas dimuat), mengikuti bahasa aktif
const { HEX32, AUTO_IMG_MAX } = require('./archne-constants');

const AUTO_IMG_AGE = 10 * 60e3;     // hanya pesan yang baru masuk; riwayat lama yang tersinkron tidak diunduh massal
const AUTO_IMG_PAR = 3;             // unduhan otomatis serentak

module.exports = {
  // Mode unduh foto otomatis: 'off' | 'lan' (bawaan). 'lan' = hanya dari pengirim yang sedang terhubung lewat LAN/jaringan lokal.
  _autoImgMode() { return this._settings && this._settings.autoImg === 'off' ? 'off' : 'lan'; },
  // Dipanggil untuk setiap pesan baru yang diterima. Tidak pernah melempar; kegagalan unduh tampil di kartu seperti biasa.
  _autoImg(m) {
    try {
      if (this._autoImgMode() !== 'lan' || this.stopped) return false;
      if (!m || m.from === this.id || m.to === 'public' || m.kind === 'ginv') return false; // Publik: siapa pun bisa menulis, jadi tidak pernah otomatis
      if (this.isBlocked(m.from)) return false;
      if (Math.abs(this._wall() - m.ts) > AUTO_IMG_AGE) return false;
      const off = this._offerOf(m);
      // Foto (<= AUTO_IMG_MAX) dan voice chat (Step 4; fileoffer.parseOffer sudah membatasi ukuran <= 5 MB dan nama berekstensi suara) diunduh otomatis; tidak pernah diputar otomatis.
      const okImg = !!off && !!off.x && off.x.k === 'img' && Media.viewName(off.name) && off.meta.size <= AUTO_IMG_MAX, okVc = !!off && !!off.x && off.x.k === 'vc';
      if (!okImg && !okVc) return false;
      if (this.store.got[m.id] || this._rx.has(m.id)) return false;
      const p = this.peers.get(m.from);
      if (!p || !this.isOnline(p) || !this._directOk(p.ip)) return false;
      if ((this._autoN || 0) >= AUTO_IMG_PAR) return false;
      this._autoN = (this._autoN || 0) + 1;
      this.receiveFile(m.id).catch(() => {}).finally(() => { this._autoN = Math.max(0, (this._autoN || 1) - 1); });
      return true;
    } catch (e) { this.log('autoImg: ' + (e && e.message)); return false; }
  },
  // Isi foto yang sudah tersimpan, untuk penampil. Hanya lewat id tawaran. Isinya diperiksa (header JPEG/PNG/GIF/WebP, jumlah piksel):
  // berkas yang bukan gambar sungguhan ditolak walau pengirim mengklaim foto. Hasil { ok, mime, w, h, size, b64 } atau { ok:false, code, err }.
  async mediaRead(id) {
    const no = (code, err) => ({ ok: false, code, err });
    id = String(id);
    if (!HEX32.test(id)) return no('bad', 'id tidak valid');
    const m = this.store.msgs[id];
    const off = m && m.from !== this.id ? this._offerOf(m) : undefined;
    const g = this.store.got[id];
    if (!off || !g || !g.path) return no('gone', T('e.media.photoGone', null, 'Foto belum diunduh atau sudah dihapus'));
    if (!Media.viewName(g.name)) return no('notimg', T('e.media.notViewable', null, 'Jenis berkas ini tidak dibuka di penampil foto'));
    let st;
    try { st = await fs.promises.stat(g.path); } catch { return no('gone', T('e.file.gone', null, 'Berkas tidak ditemukan (mungkin sudah dipindah atau dihapus)')); }
    if (!st.isFile()) return no('gone', T('e.media.notFound', null, 'Berkas tidak ditemukan'));
    if (st.size > Media.VIEW_MAX) return no('big', T('e.media.photoBig', null, 'Foto terlalu besar untuk penampil'));
    let buf;
    try { buf = await fs.promises.readFile(g.path); } catch { return no('gone', T('e.media.unreadable', null, 'Berkas tidak bisa dibaca')); }
    const s = Media.sniffImage(buf);
    if (!s) return no('notimg', T('e.media.notImage', null, 'Berkas ini bukan gambar yang valid'));
    if (!Media.pixelsOk(s)) return no('big', T('e.media.imgBig', null, 'Gambar terlalu besar untuk penampil'));
    return { ok: true, mime: s.mime, w: s.w, h: s.h, size: buf.length, b64: buf.toString('base64') };
  },
  // Isi audio/video yang sudah tersimpan, untuk pemutar (v0.25.0 Step 2). Hanya lewat id tawaran. Ekstensi harus format pemutar bawaan DAN
  // kontainer di byte awal harus cocok dengannya; berkas lain ditolak walau pengirim mengklaim audio/video. Hasil { ok, kind, mime, size, b64 }.
  async mediaPlay(id) {
    const no = (code, err) => ({ ok: false, code, err });
    id = String(id);
    if (!HEX32.test(id)) return no('bad', 'id tidak valid');
    const m = this.store.msgs[id];
    const off = m && m.from !== this.id ? this._offerOf(m) : undefined;
    const g = this.store.got[id];
    if (!off || !g || !g.path) return no('gone', T('e.media.fileGone', null, 'Berkas belum diunduh atau sudah dihapus'));
    const pk = Media.playKind(g.name);
    if (!pk) return no('format', T('e.media.format', null, 'Format ini tidak diputar di Archne. Gunakan "Buka dengan aplikasi lain".'));
    let st;
    try { st = await fs.promises.stat(g.path); } catch { return no('gone', T('e.file.gone', null, 'Berkas tidak ditemukan (mungkin sudah dipindah atau dihapus)')); }
    if (!st.isFile()) return no('gone', T('e.media.notFound', null, 'Berkas tidak ditemukan'));
    if (st.size > Media.PLAY_MAX) return no('big', T('e.media.playBig', null, 'Berkas terlalu besar untuk pemutar bawaan. Gunakan "Buka dengan aplikasi lain".'));
    let buf;
    try { buf = await fs.promises.readFile(g.path); } catch { return no('gone', T('e.media.unreadable', null, 'Berkas tidak bisa dibaca')); }
    const mime = Media.playMime(g.name, Media.sniffAv(buf));
    if (!mime) return no('notmedia', T('e.media.mismatch', null, 'Isi berkas tidak cocok dengan jenisnya, jadi tidak diputar.'));
    return { ok: true, kind: pk.kind, mime, size: buf.length, b64: buf.toString('base64') };
  },

  // ---- Streaming (v0.25.0 Step 2b): berkas besar dengan seek, dan putar sambil mengunduh ----
  // Pemutar tidak menerima byte lewat IPC, melainkan URL lokal berisi token acak (archne-media://m/<token> di desktop, /s/<sesi>/media/<token> di
  // Android). Server membaca lewat mediaSrcRead, yang menentukan berkas mana yang sedang berlaku (final, .pk, atau .part yang masih tumbuh).
  // Putar sambil unduh HANYA untuk DM/grup mode raw: potongan di .part sudah lolos verifikasi enkripsi sebelum ditulis, dan byte-nya sama dengan berkas.
  // Publik (tanpa enkripsi per potongan; hash baru dicek di akhir) dan mode terkompres tetap menunggu unduhan selesai.
  async mediaStream(id) {
    const no = (code, err) => ({ ok: false, code, err });
    id = String(id);
    if (!HEX32.test(id)) return no('bad', 'id tidak valid');
    const m = this.store.msgs[id];
    const off = m && m.from !== this.id ? this._offerOf(m) : undefined;
    if (!off) return no('gone', T('e.media.notFound', null, 'Berkas tidak ditemukan'));
    const pk = Media.playKind(off.name);
    if (!pk) return no('format', T('e.media.format', null, 'Format ini tidak diputar di Archne. Gunakan "Buka dengan aplikasi lain".'));
    const head = async (f) => { let fd; try { fd = await fs.promises.open(f, 'r'); const b = Buffer.alloc(4096); const { bytesRead } = await fd.read(b, 0, 4096, 0); return b.subarray(0, bytesRead); } catch { return null; } finally { if (fd) await fd.close().catch(() => {}); } };
    const g = this.store.got[id];
    let total, mime, live = false;
    if (g && g.path) {
      let st; try { st = await fs.promises.stat(g.path); } catch { return no('gone', T('e.file.gone', null, 'Berkas tidak ditemukan (mungkin sudah dipindah atau dihapus)')); }
      if (!st.isFile()) return no('gone', T('e.media.notFound', null, 'Berkas tidak ditemukan'));
      const h = await head(g.path); mime = h && Media.playMime(g.name, Media.sniffAv(h));
      if (!mime) return no('notmedia', T('e.media.mismatch', null, 'Isi berkas tidak cocok dengan jenisnya, jadi tidak diputar.'));
      total = st.size;
    } else {
      if (m.to === 'public' || !m.kind) return no('public', T('e.media.publicWait', null, 'Di Publik, berkas diputar setelah selesai diunduh.'));
      if (off.meta.mode !== 'raw' || off.meta.psize !== off.meta.size) return no('packed', T('e.media.packed', null, 'Berkas ini dikirim terkompres; putar setelah selesai diunduh.'));
      if (!this._rx.has(id) && !this._dl.has(id)) return no('notstarted', T('e.media.notStarted', null, 'Unduhan belum berjalan.'));
      const { part, pk: packed } = this._inPaths(id);
      const f = [packed, part].find((x) => { try { return fs.statSync(x).size >= 16; } catch { return false; } });
      if (!f) return no('wait', T('e.media.waitFirst', null, 'Menunggu data pertama…'));
      const h = await head(f); mime = h && Media.playMime(off.name, Media.sniffAv(h));
      if (!mime) return no('notmedia', T('e.media.mismatch', null, 'Isi berkas tidak cocok dengan jenisnya, jadi tidak diputar.'));
      total = off.meta.size; live = true;
    }
    if (!(total > 0)) return no('gone', T('e.media.empty', null, 'Berkas kosong'));
    const map = this._mtok || (this._mtok = new Map());
    const now = Date.now();
    for (const [k, v] of map) if (v.exp < now) map.delete(k);
    while (map.size >= 32) map.delete(map.keys().next().value);
    const tok = crypto.randomBytes(16).toString('hex');
    map.set(tok, { id, total, mime, exp: now + 6 * 3600e3 });
    return { ok: true, kind: pk.kind, mime, total, tok, live };
  },
  // Info token untuk server media: { mime, total } atau null (tidak dikenal/kedaluwarsa).
  mediaSrcInfo(tok) {
    if (this._ptok && this._ptok.has(String(tok))) return this._pgSrcInfo(tok); // gambar Halaman (2d-3)
    const e = this._mtok && this._mtok.get(String(tok));
    if (!e || e.exp < Date.now() || this.stopped) return null;
    return { mime: e.mime, total: e.total };
  },
  // Unduhan untuk token ini masih berjalan (data bisa bertambah)?
  mediaSrcLive(tok) {
    const e = this._mtok && this._mtok.get(String(tok));
    return !!e && !this.stopped && (this._rx.has(e.id) || this._dl.has(e.id));
  },
  // Baca sampai `len` byte mulai `start`. Hasil: Buffer berisi data; Buffer kosong = belum ada (unduhan masih berjalan, coba lagi); null = habis/hilang.
  async mediaSrcRead(tok, start, len) {
    if (this._ptok && this._ptok.has(String(tok))) return this._pgSrcRead(tok, start, len); // gambar Halaman (2d-3)
    const e = this._mtok && this._mtok.get(String(tok));
    if (!e || e.exp < Date.now() || this.stopped) return null;
    if (!(start >= 0) || start >= e.total) return null;
    const g = this.store.got[e.id], { part, pk } = this._inPaths(e.id);
    const cands = [g && g.path, pk, part].filter(Boolean);
    for (const f of cands) {
      let fd;
      try {
        fd = await fs.promises.open(f, 'r');
        const st = await fd.stat();
        const isFinal = f === (g && g.path) || f === pk;
        if (isFinal && st.size !== e.total) continue;            // berkas final harus utuh; selain itu lanjut ke kandidat berikutnya
        if (!isFinal && st.size > e.total) continue;
        if (start >= st.size) continue;                           // .part belum sampai ke sini
        const n = Math.min(len, st.size - start, e.total - start);
        const b = Buffer.alloc(n);
        const { bytesRead } = await fd.read(b, 0, n, start);
        if (bytesRead > 0) return b.subarray(0, bytesRead);
      } catch { /* berkas berpindah (rename) atau belum ada: coba kandidat berikutnya */ } finally { if (fd) await fd.close().catch(() => {}); }
    }
    return this.mediaSrcLive(tok) ? Buffer.alloc(0) : null;
  },
};


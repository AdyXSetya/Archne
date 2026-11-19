'use strict';
// src/core/archne-file-send.js — sendFile, tawaran, serve berkas
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Pack = require('../archne-pack');
const Offer = require('../archne-fileoffer');
const Xfer = require('../archne-xfer');
const Media = require('../archne-mediacheck');
const { ek } = require('./archne-ecode');
const { HEX16, HEX32, UP_MAX, UP_PER_IP } = require('./archne-constants');

const VC_MIN_MS = 500;                                  // rekaman lebih pendek dari ini bukan pesan suara
const VC_EXT = { ogg: 'ogg', webm: 'weba', mp4: 'm4a' }; // kontainer yang boleh jadi voice chat -> ekstensi tawaran

module.exports = {
  // ---- Berkas (tahap 3, langkah 1: tawaran saja; byte berkas diambil di langkah berikutnya) ----
  // undefined = bukan tawaran; null = tawaran tidak sah; selain itu { name, meta }.
  _offerOf(m) {
    if (m.kind === 'ginv') return undefined;
    return Offer.parseOffer(m.kind ? this._open(m) : m.text, m.to);
  },
  _dropFile(id) {
    for (const [k, r] of this._pushes) if (k.startsWith(id + ':')) r.ac.abort();
    const f = this.store.files[id];
    if (!f) return Promise.resolve();
    if (f.escTouched) this._makeRevoke(id); // pernah didorong ke kurir: minta kurir membuang byte berkasnya
    delete this.store.files[id];
    if (!f.staged) return Promise.resolve();
    return fs.promises.rm(f.path, { force: true }).catch(() => {}); // hanya salinan hasil kompres milik kita; berkas asli pengguna tidak disentuh
  },
  // Tujuan harus dikenal dan boleh dikirimi (dipakai sendFile dan sendVoice).
  _checkDest(to) {
    if (to !== 'public' && !to.startsWith('g:') && !HEX16.test(to)) throw ek('e.file.badDest', null, 'Tujuan tidak dikenal');
    if (to.startsWith('g:')) {
      const g = this.store.groups[to.slice(2)];
      if (!g) throw ek('e.group.unknown', null, 'Grup tidak dikenal');
      if (g.removed) throw ek('e.group.removed', null, 'Kamu sudah dikeluarkan dari grup ini');
    } else if (to !== 'public' && !this._pairKey(to)) throw ek('e.file.noKey', null, 'Kunci enkripsi belum tersedia (peer versi lama atau belum terlihat)');
  },
  // Siapkan berkas (kompres bila hemat), simpan di daftar kirim, lalu kirim tawarannya sebagai pesan bertanda tangan. `name` = nama di tawaran.
  // opts.expectSize (internal, dari sendVoice): ukuran berkas yang sudah diperiksa; bila hasil pack berbeda, berkas berubah di tengah jalan dan kiriman dibatalkan.
  async _sendPacked(src, name, to, x, opts) {
    const kind = Offer.kindOf(to);
    const outDir = path.join(this.opts.dataDir, 'out');
    await fs.promises.mkdir(outDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(outDir, crypto.randomBytes(12).toString('hex') + '.br');
    const r = await Pack.pack(src, tmp, { kind, signal: opts.signal, onProgress: opts.onProgress });
    const staged = r.path === tmp;
    let m;
    try {
      if (opts.expectSize !== undefined && r.meta.size !== opts.expectSize) { throw ek('e.file.changed', null, 'Berkas berubah saat disiapkan', 'changed'); }
      m = this._send(Offer.encodeOffer(name, r.meta, x, to), to);
    } catch (e) {
      if (staged) await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    const st = await fs.promises.stat(r.path).catch(() => null);
    this.store.files[m.id] = { path: r.path, staged, meta: r.meta, mtime: st ? Math.floor(st.mtimeMs) : 0 };
    this._save(); this.emit('update');
    return m;
  },
  // opts: { signal, onProgress({done,total}), media: { k, w, h, d, th } (info media opsional; lihat fileoffer.checkX) }. Batas ukuran dicek sebelum apa pun ditulis ke disk.
  async sendFile(src, to = 'public', opts = {}) {
    src = String(src);
    this._checkDest(to);
    let x;
    if (opts.media !== undefined && opts.media !== null) {
      if (opts.media.k === 'vc') throw ek('e.file.noVc', null, 'Voice chat tidak bisa dikirim sebagai berkas');
      const r = Offer.checkX(opts.media, to);
      if (!r.ok) throw new Error('Info media tidak sah: ' + r.err);
      x = r.x;
    }
    return this._sendPacked(src, path.basename(src), to, x, opts);
  },
  // ---- Voice chat (v0.25.0 Step 4): satu-satunya jalan membuat tawaran `x.k: 'vc'` ----
  // Hanya DM dan grup (Publik ditolak). Isi berkas diperiksa SEBELUM dikirim: ukuran, durasi, dan kontainer audio (ogg/webm/mp4) dari byte awal.
  // Nama tawaran dibuat di sini (suara-<waktu>.<ekstensi dari isi>), bukan dari nama berkas sumber, jadi ekstensi selalu cocok dengan isinya.
  // opts: { durMs (wajib, lama rekaman), signal, onProgress }.
  async sendVoice(src, to, opts = {}) {
    src = String(src);
    if (to === 'public') throw ek('e.voice.noPublic', null, 'Pesan suara tidak bisa dikirim di Publik');
    this._checkDest(to);
    const d = Math.round(Number(opts.durMs));
    if (!Number.isSafeInteger(d) || d < VC_MIN_MS || d > Offer.VC_MAX_MS) throw ek('e.voice.badDur', null, 'Durasi pesan suara tidak sah');
    const st = await fs.promises.stat(src).catch(() => null);
    if (!st || !st.isFile()) throw ek('e.voice.notFound', null, 'Rekaman suara tidak ditemukan');
    if (st.size < 12) throw ek('e.voice.empty', null, 'Rekaman suara kosong');
    if (st.size > Offer.VC_MAX_BYTES) throw ek('e.voice.tooBig', null, 'Rekaman suara terlalu besar');
    if (!Offer.vcSizeOk(st.size, d)) throw ek('e.voice.sizeOdd', null, 'Ukuran rekaman tidak wajar untuk durasinya');
    let fd, head;
    try {
      fd = await fs.promises.open(src, 'r');
      const b = Buffer.alloc(4096); const { bytesRead } = await fd.read(b, 0, 4096, 0); head = b.subarray(0, bytesRead);
    } catch { throw ek('e.voice.unreadable', null, 'Rekaman suara tidak bisa dibaca'); } finally { if (fd) await fd.close().catch(() => {}); }
    const ext = VC_EXT[Media.sniffAv(head)];
    if (!ext) throw ek('e.voice.badFormat', null, 'Format rekaman suara tidak dikenal');
    const t = new Date(this._wall()), p2 = (n) => String(n).padStart(2, '0');
    const name = 'suara-' + t.getFullYear() + p2(t.getMonth() + 1) + p2(t.getDate()) + '-' + p2(t.getHours()) + p2(t.getMinutes()) + p2(t.getSeconds()) + '.' + ext;
    return this._sendPacked(src, name, to, { k: 'vc', d }, Object.assign({}, opts, { expectSize: st.size }));
  },
  // ---- Berkas (tahap 3, langkah 2: transfer byte lewat TCP, resume, enkripsi per potongan untuk DM/grup) ----
  // Siapa yang boleh mengambil: publik = siapa saja; DM = lawan bicara; grup = anggota pada epoch pesan itu.
  // Identitas peminta hanyalah klaim di hello (belum dibuktikan), jadi pemeriksaan ini hanya lapis pertama. Lapis yang menentukan
  // adalah enkripsi: DM/grup dikirim tersegel dengan kunci turunan kunci pasangan/epoch grup, sehingga peminta yang menyamar
  // hanya mendapat ciphertext. Berkas publik memang terbuka dan dikirim polos.
  // Kunci per berkas; null bila kunci pasangan/epoch tidak ada. Berkas publik tidak punya kunci (dikirim polos).
  _fileKey(m) {
    if (!m.kind) return null;
    try {
      const base = this._keyFor(m);
      return base ? Xfer.fileKey(base, m.from, m.id) : null;
    } catch { return null; }
  },
  _canFetch(m, rid) {
    if (m.to === 'public') return true;
    if (!rid) return false;
    if (m.to.startsWith('g:')) {
      const g = this.store.groups[m.to.slice(2)], e = g && g.eps[m.ep || 0];
      return !!e && !g.removed && e.members.includes(rid);
    }
    return m.to === rid;
  },
  _serveFile(sock, o, ip) {
    ip = String(ip).replace('::ffff:', '');
    const no = (err) => Xfer.refuse(sock, err);
    if (this.stopped) return sock.destroy();
    if (!HEX32.test(String(o.id)) || !Number.isSafeInteger(o.off) || o.off < 0) return no('bad');
    if (o.hi) this.noteHello(o.hi, ip);
    const rid = o.hi && HEX16.test(String(o.hi.id)) ? o.hi.id : null;
    if (rid && this.isBlocked(rid)) return no('denied');
    const f = this.store.files[o.id], m = this.store.msgs[o.id];
    if (!m || m.from !== this.id) { // bukan berkas kiriman kita: mungkin salinan seed (publik/grup) atau titipan kurir
      if (m && this._serveSeed(sock, o, ip, rid, no, m)) return;
      return this._serveEsc(sock, o, ip, rid, no);
    }
    if (!f) return no('gone');
    if (!this._canFetch(m, rid)) return no('denied');
    let same = 0; for (const v of this._up.values()) if (v === ip) same++;
    if (this._up.size >= UP_MAX || same >= UP_PER_IP) return no('busy');
    if (!this._relayServeOk(ip, f.meta.psize)) return no('relaycap'); // jalur relay: batas antar jaringan (Pengaturan); LAN/langsung tanpa batas
    if (o.off > f.meta.psize) return no('range');
    // DM/grup wajib tersegel: tanpa kunci, jangan pernah mengirim polos. Offset resume harus sejajar potongan.
    const key = m.kind ? this._fileKey(m) : null;
    if (m.kind && !key) return no('nokey');
    if (key && o.off % Xfer.SEG && o.off !== f.meta.psize) return no('range');
    this._up.set(sock, ip);
    sock.once('close', () => this._up.delete(sock));
    fs.promises.stat(f.path).then((st) => {
      // berkas asli (raw) bisa diubah/dipindah pengguna setelah tawaran dikirim: ukuran dan mtime harus sama dengan saat ditawarkan
      if (!st.isFile() || st.size !== f.meta.psize || (!f.staged && Math.floor(st.mtimeMs) !== f.mtime)) return no('changed');
      return Xfer.serve(sock, f.path, o.off, f.meta.psize - o.off, key, f.meta.psize);
    }).catch(() => no('changed'));
  },
  _inPaths(id) {
    const dir = path.join(this.opts.dataDir, 'in');
    return { dir, part: path.join(dir, id + '.part'), pk: path.join(dir, id + '.pk') };
  },
  _dropIn(id) {
    if (!HEX32.test(String(id))) return Promise.resolve();
    const { dir, part, pk } = this._inPaths(id), out = path.join(dir, id + '.out');
    return Promise.all([part, pk, out, out + '.part'].map((f) => fs.promises.rm(f, { force: true }).catch(() => {}))).then(() => {});
  },
};

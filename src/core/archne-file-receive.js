'use strict';
// src/core/archne-file-receive.js — fetchPacked, receiveFile, _receive, _sweep, pembersihan
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const fs = require('fs');
const path = require('path');
const Pack = require('../archne-pack');
const Offer = require('../archne-fileoffer');
const Xfer = require('../archne-xfer');
const { ek, errText } = require('./archne-ecode');
const { HEX32, IN_MAX_AGE } = require('./archne-constants');

module.exports = {
  // Unduh byte berkas (bentuk terkemas, belum di-unpack) dari pengirim ke dataDir/in/<id>.pk. DM/grup: tiap potongan didekripsi dan
  // diverifikasi sebelum ditulis, .part berisi plaintext terverifikasi. Resume otomatis dari .part,
  // termasuk dicoba ulang bila koneksi putus. Panggilan serentak untuk id yang sama berbagi satu unduhan (promise yang sama).
  // opts: { signal, onProgress({done,total}), retries (3), retryMs }. Hasil: { path, name, meta }.
  // Unpack + verifikasi hash + simpan ke folder unduhan: langkah 3.
  fetchPacked(id, opts = {}) {
    id = String(id);
    const m = this.store.msgs[id];
    const offer = m && m.from !== this.id ? this._offerOf(m) : undefined;
    if (!offer) return Promise.reject(ek('e.file.offerGone', null, 'Tawaran berkas tidak ditemukan'));
    if (this._dl.has(id)) return this._dl.get(id);
    const p = this._fetchPacked(m, offer, opts).finally(() => this._dl.delete(id));
    this._dl.set(id, p);
    return p;
  },
  async _fetchPacked(m, offer, opts) {
    const { dir, part, pk } = this._inPaths(m.id);
    const total = offer.meta.psize, res = { path: pk, name: offer.name, meta: offer.meta, srcs: [] }; // srcs: peer yang dicoba (untuk menandai pemegang yang memberi data salah)
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const size = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };
    if (size(pk) === total) return res;
    // Jenis pesan (bukan header dari jaringan) yang menentukan wajib-enkripsi, jadi pengirim palsu tidak bisa menurunkan ke polos.
    const key = m.kind ? this._fileKey(m) : null;
    if (m.kind && !key) throw new Xfer.XferError('nokey');
    const onBytes = Xfer.throttle(opts.onProgress, total);
    const retries = opts.retries === undefined ? 3 : opts.retries;
    // Satu sumber: dicoba ulang (resume) selama masih ada kemajuan. Potongan di .part sudah terverifikasi dan sejajar, jadi bisa
    // dilanjutkan dari sumber mana pun (pengirim atau kurir): byte tersegel kurir identik dengan yang disegel pengirim.
    const pull = async (peerId, absent) => {
      let tries = 0, best = -1;
      for (;;) {
        const peer = this.peers.get(peerId);
        try {
          if (!peer || !peer.ip) throw new Xfer.XferError('net', absent);
          if (!res.srcs.includes(peerId)) res.srcs.push(peerId);
          await Xfer.download(peer, { id: m.id, hi: this.hello() }, part, total, { signal: opts.signal, onBytes, key, dial: (p) => this._dial(p) });
          return;
        } catch (e) {
          const got = Math.max(size(part), 0);
          if (got > best) { best = got; tries = 0; } // ada kemajuan: hitungan coba ulang dimulai lagi
          if (!Xfer.canRetry(e) || ++tries > retries || this.stopped) throw e;
          await new Promise((r) => setTimeout(r, opts.retryMs === undefined ? 400 * tries : opts.retryMs));
          if (opts.signal && opts.signal.aborted) throw new Xfer.XferError('abort');
        }
      }
    };
    const couriers = () => this._holdersOf(m.id).filter((id) => this.isOnline(this.peers.get(id)));
    const fail = async (e) => {
      if (e.code === 'gone' || e.code === 'changed') await fs.promises.rm(part, { force: true }).catch(() => {}); // sisa unduhan tidak berguna lagi
      throw e;
    };
    // Urutan sumber: pengirim dulu, lalu kurir yang mengumumkan memegang byte berkasnya. Pengirim yang tidak online dilewati begitu
    // ada kurir (tanpa menunggu coba ulang); tanpa kurir perilakunya sama seperti sebelumnya.
    let first = null;
    if (couriers().length && !this.isOnline(this.peers.get(m.from))) first = new Xfer.XferError('net', 'pengirim tidak online');
    else {
      try { await pull(m.from, 'pengirim belum terlihat di jaringan'); } catch (e) { first = e; }
    }
    if (first) {
      // jawaban pengirim yang final (berkas dibatalkan, kita tidak berhak, data rusak) tidak diakali lewat kurir
      if (!['net', 'timeout', 'busy', 'changed', 'proto'].includes(first.code)) await fail(first);
      let last = null, tried = 0;
      for (const cid of couriers()) {
        tried++;
        try { await pull(cid, 'kurir tidak terlihat di jaringan'); last = null; break; } catch (e) {
          if (e.code === 'abort') throw e;
          last = e;
          if (e.code === 'gone') { const h = this._holders.get(m.id); if (h) h.delete(cid); } // kurir sudah membuangnya
          this.log(`unduh ${m.id.slice(0, 8)} dari kurir ${cid.slice(0, 4)}: ${e.code}`);
        }
      }
      if (tried && last) await fail(['net', 'timeout'].includes(first.code) ? last : first);
      if (!tried) await fail(first);
    }
    await fs.promises.rename(part, pk);
    if (opts.onProgress) opts.onProgress({ done: total, total });
    return res;
  },
  // ---- Berkas (tahap 3, langkah 3a: unpack + verifikasi hash + simpan ke folder unduhan) ----
  _downloadDir() { return this.opts.downloadDir || path.join(this.opts.dataDir, 'downloads'); },
  // Cadangkan nama yang belum dipakai di folder unduhan. 'wx' gagal bila nama sudah ada, jadi berkas yang sudah ada
  // (termasuk milik pengguna sendiri) tidak pernah tertimpa; yang kembar jadi "nama (1).ext", "nama (2).ext", dst.
  async _reserve(dir, name) {
    await fs.promises.mkdir(dir, { recursive: true });
    const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 0; i < 1000; i++) {
      const p = path.join(dir, i ? `${base} (${i})${ext}` : name);
      try { await (await fs.promises.open(p, 'wx')).close(); return p; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    throw ek('e.file.nameClash', null, 'Terlalu banyak berkas dengan nama yang sama di folder unduhan');
  },
  // Pindahkan hasil ke nama yang sudah dicadangkan (menimpa placeholder kosong milik kita). Beda drive: salin lalu hapus.
  async _place(from, to) {
    try { await fs.promises.rename(from, to); } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fs.promises.copyFile(from, to);
      await fs.promises.rm(from, { force: true });
    }
  },
  _phase(id, phase, done, total, extra) {
    this._prog[id] = Object.assign({ phase, done, total }, extra);
    this.emit('file', Object.assign({ id, phase, done, total }, extra));
  },
  // Terima berkas dari tawaran: unduh (resume otomatis) -> unpack -> cocokkan ukuran dan SHA-256 -> simpan ke folder unduhan.
  // opts: { signal, onProgress({phase, done, total}), retries, retryMs }. Hasil: { path, name, meta, cached? }.
  // Event 'file' { id, phase: 'download' | 'unpack' | 'done' | 'error', done, total, code?, err? }; progres tidak memicu 'update'
  // (terlalu sering), hanya pergantian fase. Panggilan serentak untuk id yang sama berbagi satu proses.
  // Gagal verifikasi (hash/ukuran/rusak): bentuk terkemas dibuang supaya percobaan berikutnya mengunduh ulang, bukan mengulang data rusak.
  // Dibatalkan atau gagal I/O: bentuk terkemas disimpan supaya bisa dilanjutkan tanpa mengunduh ulang.
  receiveFile(id, opts = {}) {
    id = String(id);
    const m = this.store.msgs[id];
    const offer = m && m.from !== this.id ? this._offerOf(m) : undefined;
    if (!offer) return Promise.reject(ek('e.file.offerGone', null, 'Tawaran berkas tidak ditemukan'));
    if (this.isBlocked(m.from)) return Promise.reject(ek('e.file.senderBlocked', null, 'Pengirim ini kamu blokir'));
    const got = this.store.got[id];
    if (got) {
      if (fs.existsSync(got.path)) return Promise.resolve({ path: got.path, name: got.name, meta: offer.meta, cached: true });
      delete this.store.got[id]; this._save(); // berkas hasil unduhan sudah dihapus/dipindah pengguna: boleh diunduh lagi
    }
    if (this._rx.has(id)) return this._rx.get(id).p;
    const ac = new AbortController();
    if (opts.signal) { if (opts.signal.aborted) ac.abort(); else opts.signal.addEventListener('abort', () => ac.abort(), { once: true }); }
    const p = this._receive(m, offer, ac.signal, opts).finally(() => this._rx.delete(id));
    this._rx.set(id, { p, ac });
    return p;
  },
  cancelFile(id) { const r = this._rx.get(String(id)); if (r) r.ac.abort(); return !!r; },
  async _receive(m, offer, signal, opts) {
    const id = m.id, meta = offer.meta;
    const { dir, pk } = this._inPaths(id);
    const out = path.join(dir, id + '.out');
    const prog = (phase) => (p) => { this._prog[id] = { phase, done: p.done, total: p.total }; this.emit('file', { id, phase, done: p.done, total: p.total }); if (opts.onProgress) opts.onProgress({ phase, done: p.done, total: p.total }); };
    const exists = () => !!this.store.msgs[id]; // pengirim bisa membatalkan pesan kapan saja, juga saat kita sedang bekerja
    const stale = () => new Xfer.XferError('gone', 'Pengirim membatalkan berkas ini');
    let dest = null;
    try {
      this._phase(id, 'download', 0, meta.psize); this.emit('update');
      const r = await this.fetchPacked(id, { signal, retries: opts.retries, retryMs: opts.retryMs, onProgress: prog('download') });
      if (!exists()) throw stale();
      this._phase(id, 'unpack', 0, meta.size);
      try {
        await Pack.unpack(r.path, out, meta, { kind: Offer.kindOf(m.to), signal, onProgress: prog('unpack') });
      } catch (e) {
        if (e instanceof Pack.PackError) {
          // berkas publik dikirim polos: pemegang selain pengirim yang memberi data salah ditandai, supaya unduhan ulang tidak berulang dari mereka
          if (m.to === 'public') for (const sid of r.srcs || []) if (sid !== m.from) this._markBad(id, sid);
          await fs.promises.rm(pk, { force: true }).catch(() => {});
        }
        throw e;
      }
      if (!exists()) throw stale();
      dest = await this._reserve(this._downloadDir(), offer.name);
      try { await this._place(out, dest); } catch (e) { await fs.promises.rm(dest, { force: true }).catch(() => {}); dest = null; throw e; }
      if (!exists()) { await fs.promises.rm(dest, { force: true }).catch(() => {}); dest = null; throw stale(); }
      this.store.got[id] = { path: dest, name: path.basename(dest), ts: Date.now() };
      this._makeFileRcpt(m); // kurir yang memegang byte berkas ini boleh membuangnya
      if (!(await this._keepSeed(m, pk, meta.psize))) await fs.promises.rm(pk, { force: true }).catch(() => {}); // publik/grup: bentuk terkemas jadi salinan seed
      delete this._prog[id];
      this._save();
      this.emit('file', { id, phase: 'done', done: meta.size, total: meta.size, path: dest });
      this.emit('update');
      if (opts.onProgress) opts.onProgress({ phase: 'done', done: meta.size, total: meta.size });
      return { path: dest, name: path.basename(dest), meta };
    } catch (e) {
      if (!exists() || e.code === 'gone') this._dropIn(id);
      this._phase(id, 'error', 0, meta.size, { code: e.code || e.name || 'error', err: errText(e) });
      this.emit('update');
      throw e;
    } finally {
      await fs.promises.rm(out, { force: true }).catch(() => {});
    }
  },
  // ---- Berkas (tahap 3, langkah 3b: pembersihan) ----
  // Lepaskan semua yang menempel pada tawaran berkas: penerimaan yang sedang jalan dihentikan, catatan `got` dan keadaan progres
  // dibuang, salinan kompres kiriman kita (out/) dihapus, lalu sisa unduhan (in/*.part, .pk, .out) dihapus SETELAH penerimaan itu
  // benar-benar berhenti (di Windows berkas yang masih terbuka tidak bisa dihapus). Berkas hasil unduhan di folder unduhan dan
  // berkas asli pengguna tidak pernah disentuh. Bagian yang menyentuh disk berjalan di belakang layar (lihat flushCleanup).
  _dropOffer(ids) {
    const list = [...new Set(ids.map(String))].filter((id) => HEX32.test(id));
    if (!list.length) return;
    const busy = [];
    let changed = false;
    for (const id of list) {
      const rx = this._rx.get(id), dl = this._dl.get(id);
      if (rx) { rx.ac.abort(); busy.push(rx.p); }
      if (dl) busy.push(dl);
      if (this.store.got[id]) { delete this.store.got[id]; changed = true; }
      if (this.store.files[id]) changed = true;
      delete this._prog[id];
      this._holders.delete(id); this._bad.delete(id);
      this._dropSeed(id);
    }
    const rms = list.map((id) => this._dropFile(id)); // catatan kiriman dilepas sekarang juga; salinan kompresnya dihapus sambil menunggu
    if (changed) this._save();
    this._clean = this._clean
      .then(() => Promise.allSettled(busy.concat(rms)))
      .then(() => Promise.all(list.map((id) => this._dropIn(id))))
      .then(() => { for (const id of list) delete this._prog[id]; this.emit('update'); }) // penerimaan yang dibatalkan sempat mencatat 'error'
      .catch(() => {});
  },
  // Buang sisa unduhan satu tawaran (in/*.part, .pk, .out) atas permintaan pengguna: penerimaan yang berjalan dihentikan dulu, lalu
  // sisa dihapus setelah benar-benar berhenti. Tawarannya sendiri tetap ada, jadi bisa diunduh ulang dari awal. Berkas yang sudah
  // tersimpan di folder unduhan tidak disentuh. Hasil: true bila ada tawaran orang lain dengan id itu.
  async discardIncoming(id) {
    id = String(id);
    const m = HEX32.test(id) ? this.store.msgs[id] : null;
    if (!m || m.from === this.id || this._offerOf(m) === undefined) return false;
    const rx = this._rx.get(id), dl = this._dl.get(id);
    if (rx) rx.ac.abort();
    await Promise.allSettled([rx && rx.p, dl].filter(Boolean));
    await this._dropIn(id);
    delete this._prog[id];
    this.emit('update');
    return true;
  },
  // Tunggu sampai semua pembersihan yang sudah diminta selesai (untuk stop() dan tes).
  async flushCleanup() {
    let c;
    do { c = this._clean; await c; } while (c !== this._clean);
  },
  // Disapu sekali saat aplikasi dibuka, sebelum jaringan menyala. Yang dibuang:
  //  - in/: `.out` dan `.out.part` (setengah jadi, tidak bisa dilanjutkan); `.part`/`.pk` yang tawarannya sudah tidak ada
  //    (dibatalkan, chat dibersihkan, grup dihapus) atau lebih tua dari batas umur (opts.inMaxAgeMs, default 7 hari).
  //  - out/: salinan kompres yang tidak punya catatan kiriman, dan catatan kiriman yang tawarannya sudah hilang.
  //  - catatan `got` yang berkas hasilnya sudah dihapus pengguna, atau yang tawarannya sudah tidak ada.
  // Hanya nama berkas buatan kita yang disentuh; berkas lain di folder itu dibiarkan.
  async _sweep() {
    const rm = (f) => fs.promises.rm(f, { force: true }).catch(() => {});
    const list = (d) => fs.promises.readdir(d).catch(() => []);
    const maxAge = this.opts.inMaxAgeMs === undefined ? IN_MAX_AGE : this.opts.inMaxAgeMs;
    const now = Date.now();
    const st = { in: 0, out: 0, got: 0, files: 0, esc: 0, seed: 0 };
    try {
      let changed = false;
      for (const id of Object.keys(this.store.got)) {
        const g = this.store.got[id];
        if (!this.store.msgs[id] || this.store.hidden[id] || !g || !fs.existsSync(g.path)) { delete this.store.got[id]; st.got++; changed = true; }
      }
      const rms = [];
      for (const id of Object.keys(this.store.files)) {
        const f = this.store.files[id], m = this.store.msgs[id];
        if (!m || m.from !== this.id || this.store.hidden[id] || (f.staged && !fs.existsSync(f.path))) { rms.push(this._dropFile(id)); st.files++; changed = true; }
      }
      await Promise.all(rms);

      const live = (id) => { // tawaran milik orang lain yang masih ada dan terlihat; tak terbaca sementara (null) dihitung masih hidup
        const m = this.store.msgs[id];
        return !!m && m.from !== this.id && !this.store.hidden[id] && this._offerOf(m) !== undefined;
      };
      const inDir = path.join(this.opts.dataDir, 'in');
      for (const name of await list(inDir)) {
        const mt = /^([0-9a-f]{32})\.(part|pk|out|out\.part)$/.exec(name);
        if (!mt) continue;
        const f = path.join(inDir, name);
        let drop = mt[2].startsWith('out') || !live(mt[1]);
        if (!drop) { const s = await fs.promises.stat(f).catch(() => null); drop = !!s && now - s.mtimeMs > maxAge; }
        if (drop) { await rm(f); st.in++; }
      }

      const outDir = path.join(this.opts.dataDir, 'out');
      const keep = new Set(Object.values(this.store.files).filter((f) => f.staged).map((f) => path.basename(f.path)));
      for (const name of await list(outDir)) {
        if (!/^[0-9a-f]{24}\.br(\.part)?$/.test(name) || keep.has(name)) continue;
        await rm(path.join(outDir, name)); st.out++;
      }
      // esc/: rekaman tanpa titipan pesan, kedaluwarsa, atau berkasnya hilang dibuang; jumlah byte disamakan dengan isi disk;
      // berkas tanpa rekaman dibuang. Hanya nama buatan kita (<id>.bin / <id>.bin.part) yang disentuh.
      const escDir = path.join(this.opts.dataDir, 'esc');
      for (const id of Object.keys(this.store.esc)) {
        const e = this.store.esc[id], { part, bin } = this._escPaths(id);
        const s1 = await fs.promises.stat(e && e.done ? bin : part).catch(() => null);
        if (e && !e.to && this.store.custody[id]) { e.from = this.store.custody[id].m.from; e.to = this.store.custody[id].m.to; changed = true; }
        const bad = !e || !e.to || now - e.at > this._limitsOf(this._poolOf(e.to)).ttl || !Number.isSafeInteger(e.psize) || !Number.isSafeInteger(e.wl)
          || e.wl !== (this._poolOf(e.to) === 'pub' ? e.psize : Xfer.wireLen(0, e.psize)) || (e.done ? !s1 || s1.size !== e.wl : false);
        if (bad) { delete this.store.esc[id]; await rm(part); await rm(bin); st.esc++; changed = true; continue; }
        if (!e.done) {
          const n = s1 ? s1.size : 0; // tulisan yang terputus oleh matinya aplikasi: lanjut dari ukuran sebenarnya
          if (n > e.wl) { await rm(part); e.have = 0; changed = true; } else if (n !== e.have) { e.have = n; changed = true; }
        }
      }
      for (const name of await list(escDir)) {
        const mt = /^([0-9a-f]{32})\.bin(\.part)?$/.exec(name);
        if (!mt) continue;
        const e = this.store.esc[mt[1]];
        if (e && (mt[2] ? !e.done : e.done)) continue;
        await rm(path.join(escDir, name)); st.esc++;
      }
      // seed/: rekaman tanpa tawarannya atau tanpa berkas (atau ukurannya beda) dibuang; berkas tanpa rekaman dibuang.
      for (const id of Object.keys(this.store.seeds)) {
        const sd = this.store.seeds[id], s1 = await fs.promises.stat(this._seedPath(id)).catch(() => null);
        if (!sd || !this.store.msgs[id] || !Number.isSafeInteger(sd.psize) || !s1 || s1.size !== sd.psize) { delete this.store.seeds[id]; await rm(this._seedPath(id)); st.seed++; changed = true; }
      }
      for (const name of await list(path.join(this.opts.dataDir, 'seed'))) {
        const mt = /^([0-9a-f]{32})\.pk$/.exec(name);
        if (!mt || this.store.seeds[mt[1]]) continue;
        await rm(path.join(this.opts.dataDir, 'seed', name)); st.seed++;
      }
      if (changed) this._save();
      if (st.in || st.out || st.got || st.files || st.esc || st.seed) this.log(`sweep: in/ ${st.in}, out/ ${st.out}, got ${st.got}, files ${st.files}, esc ${st.esc}, seed ${st.seed}`);
    } catch (e) { this.log('sweep error ' + e.message); }
    return st;
  },
};

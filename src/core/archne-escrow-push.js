'use strict';
// src/core/archne-escrow-push.js — dorong ke kurir, auto-push, revoke, seed, holder, kedaluwarsa
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Pack = require('../archne-pack');
const Xfer = require('../archne-xfer');
const { ESC_REPLICAS, FTAG, HEX16, HEX32, PTAG, RVTAG, RV_MAX, SEED_QUOTA, UP_MAX, UP_PER_IP } = require('./archne-constants');
const { idFromPub } = require('./archne-util');

module.exports = {
  // Dorong berkas tawaran DM milikku ke kurir `peerId` (peer online, bukan tujuan pesan). Resume otomatis dari yang sudah ada di kurir.
  // opts: { signal, onBytes(wireBytesDone) }. Hasil: { have, done } atau melempar XferError (code: lihat Xfer.PUT_REFUSALS, net, timeout, abort, ...).
  // Kurir sudah harus memegang pesan tawarannya (didapat lewat sinkronisasi); kalau belum, `nocustody`.
  pushToCourier(id, peerId, opts = {}) {
    id = String(id);
    const k = id + ':' + peerId;
    if (this._pushes.has(k)) return this._pushes.get(k).p;
    const ac = new AbortController();
    if (opts.signal) { if (opts.signal.aborted) ac.abort(); else opts.signal.addEventListener('abort', () => ac.abort(), { once: true }); }
    const p = this._push(id, peerId, ac, opts).finally(() => this._pushes.delete(k));
    this._pushes.set(k, { p, ac });
    return p;
  },
  async _push(id, peerId, ac, opts) {
    const X = (c, msg) => new Xfer.XferError(c, msg);
    const m = this.store.msgs[id], f = this.store.files[id];
    const pub = !!m && !m.kind && m.to === 'public'; // berkas publik didorong polos ke kolam kurir publik; DM dan grup tersegel
    const grp = !!m && m.kind === 'g1'; // grup: didorong ke anggota grup yang online (kolam grup di anggota itu)
    if (!m || m.from !== this.id || !f || (m.kind !== 'e1' && !pub && !grp)) throw X('gone', 'hanya tawaran berkas DM, grup, atau publik milikmu yang bisa dititipkan');
    if (!pub && !grp && this.store.receipts[id + m.to]) throw X('receipt');
    if (!pub && !grp && peerId === m.to) throw X('bad', 'tujuan pesan tidak perlu kurir: ambil langsung');
    if (grp && (peerId === this.id || !this._canFetch(m, peerId))) throw X('bad', 'penitip berkas grup harus anggota grup');
    if (this.isBlocked(peerId)) throw X('bad', 'orang ini diblokir');
    try { Pack.checkLimit(f.meta.size, 'courier'); } catch { throw X('big'); }
    const peer = this.peers.get(peerId);
    if (!this._escSizeOk(f.meta.psize, peer)) throw X('big', 'berkas melebihi batas titipan antar jaringan (Pengaturan)'); // LAN tanpa batas; antar jaringan di atas batas: hanya diambil langsung dari pengirim
    if (!this.isOnline(peer)) throw X('net', 'kurir tidak online');
    if (this._viaRelay(peer)) throw X('net', 'jalur ke kurir lewat relay: berkas tidak dititipkan lewat relay');
    const key = pub ? null : this._fileKey(m);
    if (!pub && !key) throw X('nokey');
    const psize = f.meta.psize;
    const st = await fs.promises.stat(f.path).catch(() => null);
    if (!st || !st.isFile() || st.size !== psize || (!f.staged && Math.floor(st.mtimeMs) !== f.mtime)) throw X('changed');
    if (ac.signal.aborted) throw X('abort');
    const q = await this._request(peer, { t: 'esc_q', id, psize }, 4000);
    if (ac.signal.aborted) throw X('abort');
    if (!q || q.t !== 'esc_r') throw X('net', 'kurir tidak menjawab');
    if (!q.ok) throw X(Xfer.PUT_REFUSALS.includes(q.err) ? q.err : 'proto');
    if (!f.escTouched) { f.escTouched = true; this._save(); } // mulai sekarang kurir bisa memegang byte: batal kirim harus mencabutnya
    const wl = pub ? psize : Xfer.wireLen(0, psize), seg = Xfer.SEG + Xfer.TAG;
    if (q.wl !== wl || typeof q.nonce !== 'string' || !Number.isSafeInteger(q.have) || q.have < 0 || q.have > wl) throw X('proto');
    if (q.done) return { have: wl, done: true };
    if (!pub && q.have % seg) throw X('proto');
    const sig = crypto.sign(null, Buffer.from(PTAG + id + ':' + psize + ':' + q.nonce), this.privKey).toString('base64');
    const start = pub ? q.have : (q.have / seg) * Xfer.SEG;
    const head = { id, psize, off: q.have, nonce: q.nonce, sig, hi: this.hello() };
    if (pub) head.plain = 1;
    return Xfer.put(peer, head, f.path, start, key, psize, { signal: ac.signal, onBytes: opts.onBytes, dial: (p) => this._dial(p) });
  },
  // ---- Dorongan otomatis ke kurir + pencabutan (tahap 4b-2) ----
  // Tiap putaran, untuk tawaran DM milikku yang masih `pending` (belum ada tanda terima), berkasnya didorong ke peer online yang bukan
  // tujuan pesan, sampai `escReplicas` (default 2) kurir memegangnya. Satu dorongan pada satu waktu. Gagal -> jeda eksponensial per
  // (berkas, kurir) yang hanya di memori. Kurir yang sudah lengkap dicatat di files[id].pushed = { peerId: waktu } dan disimpan;
  // catatan lebih tua dari (kedaluwarsa kurir - 1 hari) dianggap basi dan dicek ulang (esc_q: kalau kurir masih memegangnya, tanpa byte).
  _pushTick(p) {
    if (this.stopped || this.opts.escPush === false || this._pushes.size) return;
    if (this._viaRelay(p) || (this._isWan(p) && this._escMaxBytes() === 0)) return; // hemat relay: berkas tidak dititipkan lewat jalur relay; 0 di Pengaturan mematikan titipan antar jaringan (LAN tetap)
    const now = Date.now(), want = this.opts.escReplicas || ESC_REPLICAS, fresh = this._escLimits().ttl - 864e5;
    const pubTtl = this._pubLimits().ttl, pubFresh = Math.max(pubTtl - 864e5, pubTtl / 2);
    const grpTtl = this._grpLimits().ttl, grpFresh = Math.max(grpTtl - 864e5, grpTtl / 2);
    let best = null;
    for (const [id, f] of Object.entries(this.store.files)) {
      const m = this.store.msgs[id];
      if (!m || m.from !== this.id) continue;
      const pub = !m.kind && m.to === 'public', grp = m.kind === 'g1';
      if (m.kind !== 'e1' && !pub && !grp) continue;
      if (grp && !this._canFetch(m, p.id)) continue; // berkas grup hanya dititipkan ke sesama anggota grup
      if (pub || grp) {
        // Publik dan grup: yang dihitung pemegang yang online SEKARANG (kurir maupun peer yang sudah mengunduh), bukan catatan lama. Kurir yang
        // berkasnya sudah tergusur atau offline tidak dianggap lagi, jadi berkas dititipkan ulang ke peer lain.
        const have = this._pubHave(id, f);
        if (have.size >= want || have.has(p.id)) continue;
        // Satu pasangan (berkas, kurir) hanya didorong sekali per jendela: kurir yang kolamnya penuh membuang yang lama, dan tanpa batas ini
        // pengirim akan mendorong ulang berkas yang tergusur terus-menerus (bolak-balik). Tergusur = tersedia lebih sedikit, bukan diulang.
        if (f.pushed && f.pushed[p.id] && now - f.pushed[p.id] < (pub ? pubFresh : grpFresh)) continue;
      } else {
        if (m.to === p.id) continue;
        if (this.store.status[id] !== 'pending' || this.store.receipts[id + m.to]) continue;
        const pushed = f.pushed || {};
        if (Object.values(pushed).filter((at) => now - at < fresh).length >= want) continue;
        if (pushed[p.id] && now - pushed[p.id] < fresh) continue;
      }
      const bk = this._pushBack.get(id + ':' + p.id);
      if (bk && bk.next > now) continue;
      try { Pack.checkLimit(f.meta.size, 'courier'); } catch { continue; }
      if (!this._escSizeOk(f.meta.psize, p)) continue; // antar jaringan dan lebih besar dari batas: tidak dititipkan (LAN tanpa batas)
      if (!best || m.ts < best.ts) best = { id, ts: m.ts };
    }
    if (best) this._autoPush(best.id, p);
  },
  // Pemegang berkas publik milikku yang online sekarang: kurir maupun peer yang sudah mengunduh (dikabarkan lewat sync), ditambah
  // dorongan yang baru selesai (30 dtk) dan belum sempat diumumkan.
  _pubHave(id, f) {
    const now = Date.now(), on = (pid) => this.isOnline(this.peers.get(pid));
    const have = new Set(this._holdersOf(id).filter(on));
    for (const [pid, at] of Object.entries((f && f.pushed) || {})) if (now - at < 30e3 && on(pid)) have.add(pid);
    return have;
  },
  async _autoPush(id, p) {
    const k = id + ':' + p.id;
    try {
      const r = await this.pushToCourier(id, p.id);
      this._pushBack.delete(k);
      const f = this.store.files[id];
      if (r.done && f) {
        (f.pushed = f.pushed || {})[p.id] = Date.now();
        this._save();
        this.emit('escrow', { id, peer: p.id, phase: 'done' });
      }
    } catch (e) {
      const code = e && e.code;
      if (code === 'abort') return; // dibatalkan (batal kirim / stop), bukan kegagalan kurir
      const prev = this._pushBack.get(k), n = (prev ? prev.n : 0) + 1;
      const FINAL = ['gone', 'big', 'changed', 'nokey', 'kind', 'bad', 'proto', 'receipt'];
      const base = (code === 'nocustody' ? 20e3 : code === 'quota' || code === 'sender' ? 600e3 : FINAL.includes(code) ? 3600e3 : 8e3) * (this.opts.escBackoff || 1);
      this._pushBack.set(k, { n, next: Date.now() + Math.min(3600e3 * (this.opts.escBackoff || 1), base * 2 ** (n - 1)) });
      this.log(`dorong ${id.slice(0, 8)} ke ${p.name}: ${code || e.message}`);
    }
  },
  // Pencabutan: pengirim menandatangani `RVTAG + id` (bisa diperiksa siapa saja dari kunci di dalamnya, seperti tanda terima).
  // Dibawa lewat sinkronisasi (`vh`/`rv`), jadi kurir yang offline saat pesan dibatalkan tetap menerimanya lewat peer lain.
  // Efeknya hanya di kurir yang memegang titipan pesan itu dari pengirim yang sama: byte berkas dibuang dan dorongan berikutnya ditolak (`gone`).
  // Pencabutan untuk pesan yang tidak kita titipkan diabaikan (tidak disimpan, tidak diteruskan), supaya tidak bisa dipakai membanjiri.
  _makeRevoke(id) {
    if (this.store.revokes[id]) return;
    const sig = crypto.sign(null, Buffer.from(RVTAG + id), this.privKey).toString('base64');
    this.store.revokes[id] = { id, by: this.id, pub: this.pub, sig, at: Date.now() };
    this._save();
  },
  _addRevoke(rv) {
    if (!rv || !HEX32.test(String(rv.id)) || !HEX16.test(String(rv.by))) return false;
    if (typeof rv.pub !== 'string' || typeof rv.sig !== 'string' || rv.pub.length > 200 || rv.sig.length > 200) return false;
    if (this.store.revokes[rv.id]) return false;
    const c = this.store.custody[rv.id], e0 = this.store.esc[rv.id];
    const owner = c ? c.m.from : e0 && e0.from; // titipan pesan, atau byte berkas yang bertahan setelah titipan pesannya dibuang
    if (!owner || owner !== rv.by) return false;
    try {
      if (rv.by !== idFromPub(rv.pub)) return false;
      const key = crypto.createPublicKey({ key: Buffer.from(rv.pub, 'base64'), format: 'der', type: 'spki' });
      if (!crypto.verify(null, Buffer.from(RVTAG + rv.id), key, Buffer.from(rv.sig, 'base64'))) return false;
    } catch { return false; }
    const R = this.store.revokes;
    R[rv.id] = { id: rv.id, by: rv.by, pub: rv.pub, sig: rv.sig, at: Date.now() };
    const all = Object.entries(R);
    if (all.length > RV_MAX) all.sort((a, b) => a[1].at - b[1].at).slice(0, all.length - RV_MAX).forEach(([k]) => delete R[k]);
    if (this.store.esc[rv.id]) this._escDrop(rv.id);
    this._save();
    return true;
  },
  // Alamat berkas lengkap (siap dilayani ke penerima) atau null.
  _escFile(id) {
    const e = this.store.esc[String(id)];
    return e && e.done ? this._escPaths(String(id)).bin : null;
  },
  // Buang rekaman sekarang; berkasnya dihapus setelah tulisan yang sedang jalan berhenti (di Windows berkas terbuka tidak bisa dihapus).
  _escDrop(id) {
    id = String(id);
    if (!HEX32.test(id)) return;
    const had = !!this.store.esc[id];
    delete this.store.esc[id];
    const w = this._escW.get(id), { part, bin } = this._escPaths(id);
    this._clean = this._clean
      .then(() => (w ? Promise.allSettled([w]) : null))
      .then(() => Promise.all([part, bin].map((f) => fs.promises.rm(f, { force: true }).catch(() => {}))))
      .catch(() => {});
    if (had) this._save();
  },
  // ---- Penerima mengambil dari kurir (tahap 4c) ----
  // Tanda terima BERKAS: penerima menandatangani FTAG + id + ':' + dirinya setelah berkas utuh dan terverifikasi tersimpan. Bentuknya
  // seperti tanda terima pesan, tapi artinya lain: kurir boleh membuang byte berkasnya. Dibawa lewat sinkronisasi (`eq`/`fr`): peminta
  // menyebut id byte yang dipegangnya, peer yang punya tanda terimanya membalas. Hanya diterima (dan disimpan, dan diteruskan) oleh kurir
  // yang memegang byte berkas itu untuk penerima yang sama; yang lain diabaikan, jadi tidak bisa dipakai membanjiri atau membuang titipan orang.
  _makeFileRcpt(m) {
    if (!m || m.kind !== 'e1' || m.to !== this.id || this.store.freceipts[m.id]) return;
    const sig = crypto.sign(null, Buffer.from(FTAG + m.id + ':' + this.id), this.privKey).toString('base64');
    this.store.freceipts[m.id] = { id: m.id, by: this.id, pub: this.pub, sig, at: Date.now() };
    this._save();
  },
  _addFileRcpt(fr) {
    if (!fr || !HEX32.test(String(fr.id)) || !HEX16.test(String(fr.by))) return false;
    if (typeof fr.pub !== 'string' || typeof fr.sig !== 'string' || fr.pub.length > 200 || fr.sig.length > 200) return false;
    if (this.store.freceipts[fr.id]) return false;
    // diterima kalau aku kurir yang memegang byte-nya untuk penerima itu, atau pengirimnya (yang pernah mendorong ke kurir) sebagai pembawa
    const e = this.store.esc[fr.id], om = this.store.msgs[fr.id], of = this.store.files[fr.id];
    const mine = !!(om && om.from === this.id && om.to === fr.by && of && of.escTouched);
    if (!(e && e.to === fr.by) && !mine) return false;
    try {
      if (fr.by !== idFromPub(fr.pub)) return false;
      const key = crypto.createPublicKey({ key: Buffer.from(fr.pub, 'base64'), format: 'der', type: 'spki' });
      if (!crypto.verify(null, Buffer.from(FTAG + fr.id + ':' + fr.by), key, Buffer.from(fr.sig, 'base64'))) return false;
    } catch { return false; }
    const F = this.store.freceipts;
    F[fr.id] = { id: fr.id, by: fr.by, pub: fr.pub, sig: fr.sig, at: Date.now() };
    const all = Object.entries(F);
    if (all.length > RV_MAX) all.sort((a, b) => a[1].at - b[1].at).slice(0, all.length - RV_MAX).forEach(([k]) => delete F[k]);
    if (e) this._escDrop(fr.id);
    this._save();
    return true;
  },
  // Kurir yang mengumumkan memegang byte berkas tawaran DM untukku. Hanya kabar (bisa bohong): penerima memverifikasi tiap potongan.
  _noteHolders(p, list) {
    const now = Date.now(), seen = new Set();
    if (Array.isArray(list)) for (const id of list.slice(0, 200)) {
      const m = HEX32.test(String(id)) ? this.store.msgs[id] : null;
      if (!m || m.from === p.id) continue;
      // DM untukku (kurir DM), atau tawaran publik/grup (kurir publik atau peer yang sudah mengunduh dan ikut melayani).
      // Tawaran publik milikku sendiri juga dicatat: dipakai untuk tahu apakah masih perlu dititipkan ke kurir.
      const ok = (m.kind === 'e1' && m.to === this.id) || (this._seedable(m) && m.from !== this.id && this._offerOf(m))
        || (!m.kind && m.to === 'public' && m.from === this.id) || (m.kind === 'g1' && m.from === this.id);
      if (!ok) continue;
      let h = this._holders.get(id);
      if (!h) this._holders.set(id, h = new Map());
      h.set(p.id, now); seen.add(id);
    }
    for (const [id, h] of this._holders) if (!seen.has(id)) { h.delete(p.id); if (!h.size) this._holders.delete(id); }
  },
  _markBad(id, pid) { let b = this._bad.get(id); if (!b) this._bad.set(id, b = new Set()); b.add(pid); const h = this._holders.get(id); if (h) h.delete(pid); },
  _holdersOf(id) {
    const h = this._holders.get(id);
    const bad = this._bad.get(id);
    return h ? [...h.entries()].filter(([k]) => !(bad && bad.has(k))).sort((a, b) => b[1] - a[1]).map(([k]) => k) : [];
  },
  // Layani byte tersegel dari esc/<id>.bin kepada TUJUAN pesan (identitas hanya klaim di hello; yang menentukan tetap enkripsi: yang menyamar
  // hanya mendapat ciphertext). Kurir tidak bisa memalsukan isi: penerima memverifikasi tag tiap potongan. Pembatas unggahan sama dengan pengirim.
  _serveEsc(sock, o, ip, rid, no) {
    const id = String(o.id), e = this.store.esc[id];
    if (!e || !e.done || !e.to || this.store.revokes[id] || this.store.freceipts[id]) return no('gone');
    const pool = this._poolOf(e.to), pub = pool === 'pub'; // publik: polos dan terbuka untuk siapa saja; DM: tersegel, hanya tujuan pesan; grup: tersegel, hanya anggota
    if (pool !== 'dm' && this.store.deleted[id]) return no('gone');
    if (pool === 'grp') { const gm = this.store.msgs[id]; if (!gm || !rid || !this._canFetch(gm, rid)) return no('denied'); }
    else if (pool === 'dm' && (!rid || rid !== e.to)) return no('denied');
    let same = 0; for (const v of this._up.values()) if (v === ip) same++;
    if (this._up.size >= UP_MAX || same >= UP_PER_IP) return no('busy');
    if (o.off > e.psize || (!pub && o.off % Xfer.SEG && o.off !== e.psize)) return no('range');
    this._up.set(sock, ip);
    sock.once('close', () => this._up.delete(sock));
    e.used = Date.now(); // untuk LRU kolam publik
    const { bin } = this._escPaths(id);
    fs.promises.stat(bin).then((st) => {
      if (!st.isFile() || st.size !== e.wl) return no('gone');
      return pub ? Xfer.serve(sock, bin, o.off, e.psize - o.off, null, e.psize) : Xfer.serveSealed(sock, bin, o.off, e.psize);
    }).catch(() => no('gone'));
  },
  // ---- Salinan seed: peer yang sudah mengunduh berkas publik/grup ikut melayani ----
  // Bentuk terkemas (psize byte) yang sudah lolos verifikasi disimpan di dataDir/seed/<id>.pk dan dilayani seperti oleh pengirimnya
  // (publik polos; grup tersegel dengan kunci epoch grup, jadi hanya anggota yang bisa membukanya). Pengunduh memverifikasi sendiri:
  // grup per potongan (tag), publik lewat SHA-256 berkas asli yang ada di tawaran bertanda tangan pengirim.
  // Batas: kuota total (SEED_QUOTA, LRU) dan kedaluwarsa (SEED_TTL sejak terakhir dipakai). DM tidak di-seed (kurirnya yang menanggung).
  _seedPath(id) { return path.join(this.opts.dataDir, 'seed', id + '.pk'); },
  _seedable(m) { return (m.to === 'public' && !m.kind) || m.kind === 'g1'; },
  _serveSeed(sock, o, ip, rid, no, m) {
    const sd = this.store.seeds[m.id];
    if (!sd || !this._seedable(m)) return false;
    if (!this._canFetch(m, rid)) { no('denied'); return true; }
    if (this._viaRelay(ip)) { no('denied'); return true; } // hemat relay: salinan seed tidak dilayankan lewat jalur relay (peminta mencoba sumber lain)
    let same = 0; for (const v of this._up.values()) if (v === ip) same++;
    if (this._up.size >= UP_MAX || same >= UP_PER_IP) { no('busy'); return true; }
    if (o.off > sd.psize) { no('range'); return true; }
    const key = m.kind ? this._fileKey(m) : null;
    if (m.kind && !key) { no('nokey'); return true; }
    if (key && o.off % Xfer.SEG && o.off !== sd.psize) { no('range'); return true; }
    this._up.set(sock, ip);
    sock.once('close', () => this._up.delete(sock));
    sd.used = Date.now();
    const file = this._seedPath(m.id);
    fs.promises.stat(file).then((st) => {
      if (!st.isFile() || st.size !== sd.psize) { this._dropSeed(m.id); return no('gone'); }
      return Xfer.serve(sock, file, o.off, sd.psize - o.off, key, sd.psize);
    }).catch(() => no('gone'));
    return true;
  },
  // Simpan bentuk terkemas hasil unduhan sebagai seed (memindahkan `pk`). Hasil: true bila disimpan; false -> pemanggil membuang `pk`.
  async _keepSeed(m, pk, psize) {
    if (!this._seedable(m) || !(psize > 0)) return false;
    const quota = this.opts.seedQuota || SEED_QUOTA, S = this.store.seeds;
    if (psize > quota) return false;
    try {
      await fs.promises.mkdir(path.dirname(this._seedPath(m.id)), { recursive: true, mode: 0o700 });
      const others = Object.entries(S).filter(([k]) => k !== m.id).sort((a, b) => (a[1].used || a[1].at) - (b[1].used || b[1].at));
      let used = others.reduce((n, [, v]) => n + v.psize, 0);
      for (const [k, v] of others) { if (used + psize <= quota) break; used -= v.psize; this._dropSeed(k); }
      if (!this.store.msgs[m.id]) return false; // tawarannya dibatalkan selagi kita bekerja
      await fs.promises.rename(pk, this._seedPath(m.id));
      S[m.id] = { psize, at: Date.now(), used: Date.now() };
      const dup = this.store.esc[m.id];
      if (dup && this._poolOf(dup.to) === 'grp') this._escDrop(m.id); // seed menggantikan titipan grup yang sama: tidak perlu dua salinan
      this._save();
      return true;
    } catch { return false; }
  },
  _dropSeed(id) {
    id = String(id);
    if (!HEX32.test(id) || !this.store.seeds[id]) return;
    delete this.store.seeds[id];
    const f = this._seedPath(id);
    this._clean = this._clean.then(() => fs.promises.rm(f, { force: true })).catch(() => {});
    this._save();
  },
  _escExpire(now) {
    const ttl = this._escLimits().ttl, pttl = this._pubLimits().ttl, gttl = this._grpLimits().ttl;
    let ch = false;
    for (const [id, e] of Object.entries(this.store.esc)) {
      const pool = this._poolOf(e.to);
      if (pool === 'pub' && (now - e.at > pttl || this.store.deleted[id])) { this._escDrop(id); ch = true; continue; }
      if (pool === 'grp') { // kedaluwarsa, dibatalkan, atau aku sudah bukan anggota (keluar/dikeluarkan): buang
        const gm = this.store.msgs[id];
        if (now - e.at > gttl || this.store.deleted[id] || !gm || !this._canFetch(gm, this.id)) { this._escDrop(id); ch = true; }
        continue;
      }
      if (!e.to) { // rekaman dari versi sebelum 4c: lengkapi dari titipan pesan; tanpa itu tidak bisa dilayani/dicabut, buang
        const c = this.store.custody[id];
        if (c) { e.from = c.m.from; e.to = c.m.to; ch = true; }
      }
      if (!e.to || now - e.at > ttl) { this._escDrop(id); ch = true; }
    }
    return ch;
  },
};

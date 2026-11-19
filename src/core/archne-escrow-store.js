'use strict';
// src/core/archne-escrow-store.js — titipan BYTE berkas: batas, kuota, tulis, query, _escPutServe
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Pack = require('../archne-pack');
const Xfer = require('../archne-xfer');
const { ESC_PER_SENDER, ESC_QUOTA, ESC_TTL, GRP_PER_SENDER, GRP_QUOTA, GRP_TTL, HEX32, NONCE_MAX, NONCE_TTL, PTAG, PUB_PER_SENDER, PUB_QUOTA, PUB_TTL, PUT_MAX, PUT_PER_IP } = require('./archne-constants');

module.exports = {
  // ---- Titipan byte berkas di kurir (tahap 4a: hanya penyimpanan, belum ada jaringan) ----
  // Kurir menyimpan byte berkas TERSEGEL (DM selalu tersegel per potongan; kurir tidak punya kuncinya dan tidak membaca isinya),
  // sebagai tambahan pada titipan pesan tawarannya. Rekaman `store.esc[id]` = { psize, wl, have, done, at }; byte di dataDir/esc/<id>.bin
  // (<id>.bin.part selama belum lengkap). Syarat: pesan tawarannya sedang kita titipkan (custody, kind e1, bukan undangan/grup),
  // belum ada tanda terima. Batas: 50 MB per berkas, kuota total (dihitung dengan Pack.quotaCost = ukuran setelah kompres),
  // batas per pengirim, kedaluwarsa 7 hari sejak dititipkan. Kurir tidak bisa memverifikasi isinya; penerima yang memverifikasi tiap potongan.
  _escLimits() {
    const o = this.opts;
    return { quota: o.escQuota || ESC_QUOTA, perSender: o.escPerSender || ESC_PER_SENDER, ttl: o.escTtlMs || ESC_TTL, maxFile: Pack.LIMITS.courier };
  },
  _pubLimits() {
    const o = this.opts;
    return { quota: o.pubQuota || PUB_QUOTA, perSender: o.pubPerSender || PUB_PER_SENDER, ttl: o.pubTtlMs || PUB_TTL, maxFile: Pack.LIMITS.public };
  },
  _grpLimits() {
    const o = this.opts;
    return { quota: o.grpQuota || GRP_QUOTA, perSender: o.grpPerSender || GRP_PER_SENDER, ttl: o.grpTtlMs || GRP_TTL, maxFile: Pack.LIMITS.courier };
  },
  // Kolam sebuah titipan dari tujuan pesannya: pub (polos), grp (tersegel, 'g:<id>'), dm (tersegel, tujuan = id penerima).
  _poolOf(to) { return to === 'public' ? 'pub' : typeof to === 'string' && to.startsWith('g:') ? 'grp' : 'dm'; },
  _limitsOf(pool) { return pool === 'pub' ? this._pubLimits() : pool === 'grp' ? this._grpLimits() : this._escLimits(); },
  _escPaths(id) {
    const dir = path.join(this.opts.dataDir, 'esc');
    return { dir, part: path.join(dir, id + '.bin.part'), bin: path.join(dir, id + '.bin') };
  },
  escUsage() {
    let used = 0, n = 0;
    for (const e of Object.values(this.store.esc)) { if (this._poolOf(e.to) !== 'dm') continue; used += Pack.quotaCost(e); n++; } // kolam DM saja
    return { used, count: n, quota: this._escLimits().quota };
  },
  escUsagePub() { // kolam kurir publik (terpisah dari kolam DM)
    let used = 0, n = 0;
    for (const e of Object.values(this.store.esc)) { if (this._poolOf(e.to) !== 'pub') continue; used += Pack.quotaCost(e); n++; }
    return { used, count: n, quota: this._pubLimits().quota };
  },
  escUsageGrp() { // kolam titipan berkas grup di anggota (terpisah dari kolam DM dan publik)
    let used = 0, n = 0;
    for (const e of Object.values(this.store.esc)) { if (this._poolOf(e.to) !== 'grp') continue; used += Pack.quotaCost(e); n++; }
    return { used, count: n, quota: this._grpLimits().quota };
  },
  // Minta tempat. Hasil: { ok:true, have, done } (have = byte yang sudah ada, untuk resume) atau { ok:false, code }.
  // code: bad (id/ukuran tidak sah), nocustody (pesannya tidak kita titipkan), kind (bukan DM), receipt (sudah sampai), big, quota, sender.
  // Pesan tawaran yang menjadi dasar titipan: DM = titipan pesan (custody, kind e1); publik = tawaran publik yang kita punya (psize-nya bisa kita cek sendiri).
  _escMsg(id) {
    const c = this.store.custody[id];
    if (c) return c.m.kind === 'e1' ? { m: c.m, pool: 'dm' } : { code: 'kind' };
    const m = this.store.msgs[id];
    if (m && !m.kind && m.to === 'public') return { m, pool: 'pub' };
    // berkas grup: hanya anggota grup yang memegang tawarannya (dan bukan milikku sendiri) yang bersedia menampung byte tersegelnya
    if (m && m.kind === 'g1' && m.from !== this.id && this._canFetch(m, this.id)) return { m, pool: 'grp' };
    return { code: 'nocustody' };
  },
  _escCheck(id, psize) {
    id = String(id);
    if (!HEX32.test(id) || !Number.isSafeInteger(psize) || psize <= 0) return { ok: false, code: 'bad' };
    const r = this._escMsg(id);
    if (r.code) return { ok: false, code: r.code };
    const { m, pool } = r, pub = pool === 'pub', lru = pool !== 'dm'; // pub = polos; lru = kolam yang membuang yang lama saat penuh (publik, grup)
    if (this.store.revokes[id] || (lru && this.store.deleted[id])) return { ok: false, code: 'gone' }; // pengirim mencabutnya
    if (lru) {
      const off = this._offerOf(m);
      if (!off) return { ok: false, code: 'kind' }; // bukan tawaran berkas
      if (off.meta.psize !== psize) return { ok: false, code: 'bad' };
    } else if (this.store.receipts[id + m.to] || this.store.freceipts[id]) return { ok: false, code: 'receipt' };
    const e = this.store.esc[id];
    if (e) return e.psize === psize && this._poolOf(e.to) === pool ? { ok: true, e, m, pool, pub, lru } : { ok: false, code: 'bad' };
    const L = this._limitsOf(pool);
    if (psize > L.maxFile || (lru && (psize > L.perSender || psize > L.quota))) return { ok: false, code: 'big' };
    if (lru) return { ok: true, e: null, m, pool, pub, lru }; // kolam publik/grup tidak menolak karena penuh: yang lama dibuang saat tempat dicadangkan
    let used = 0, mine = 0;
    for (const [k, v] of Object.entries(this.store.esc)) {
      if (this._poolOf(v.to) !== 'dm') continue;
      used += Pack.quotaCost(v);
      const fr = v.from || (this.store.custody[k] && this.store.custody[k].m.from); if (fr === m.from) mine += Pack.quotaCost(v);
    }
    if (mine + psize > L.perSender) return { ok: false, code: 'sender' };
    if (used + psize > L.quota) return { ok: false, code: 'quota' };
    return { ok: true, e: null, m, pool, pub, lru };
  },
  // Kolam publik/grup: buang yang paling lama tidak dipakai (milik pengirim yang sama dulu sampai muat di batas per pengirim, lalu siapa saja
  // sampai muat di kuota) supaya `psize` baru muat. Yang sedang ditulis tidak dibuang. Hasil: true bila muat.
  _poolMakeRoom(pool, id, psize, from) {
    const L = this._limitsOf(pool), lru = (e) => e.used || e.at;
    const list = () => Object.entries(this.store.esc).filter(([k, v]) => this._poolOf(v.to) === pool && k !== id);
    const sum = (a) => a.reduce((n, [, v]) => n + Pack.quotaCost(v), 0);
    const evict = (a, over) => {
      for (const [k] of a.filter(([k]) => !this._escW.has(k)).sort((x, y) => lru(x[1]) - lru(y[1]))) {
        if (!over()) return;
        this._escDrop(k);
      }
    };
    evict(list().filter(([, v]) => v.from === from), () => sum(list().filter(([, v]) => v.from === from)) + psize > L.perSender);
    evict(list(), () => sum(list()) + psize > L.quota);
    return sum(list()) + psize <= L.quota && sum(list().filter(([, v]) => v.from === from)) + psize <= L.perSender;
  },
  _escReserve(id, psize) {
    id = String(id);
    const k = this._escCheck(id, psize);
    if (!k.ok) return k;
    if (k.e) return { ok: true, have: k.e.have, done: k.e.done };
    const cm = k.m;
    if (k.lru && !this._poolMakeRoom(k.pool, id, psize, cm.from)) return { ok: false, code: 'quota' };
    this.store.esc[id] = { psize, wl: k.pub ? psize : Xfer.wireLen(0, psize), have: 0, done: false, at: Date.now(), from: cm.from, to: cm.to };
    this._save();
    return { ok: true, have: 0, done: false };
  },
  // Tambahkan byte berurutan: `off` harus sama dengan jumlah byte yang sudah ada (resume = tanya `have` dulu).
  // Lengkap (have == wl) -> .bin.part diganti nama jadi .bin. Hasil: { ok:true, have, done } atau { ok:false, code, have? }:
  // gone (tidak ada/sudah dibuang), range (off tidak sama dengan have), over (melebihi ukuran terdaftar), busy (ada tulisan lain), io.
  async _escWrite(id, off, buf) {
    id = String(id);
    const e = this.store.esc[id];
    if (!e) return { ok: false, code: 'gone' };
    if (e.done || !Number.isSafeInteger(off) || off !== e.have) return { ok: false, code: 'range', have: e.have };
    if (!Buffer.isBuffer(buf) || !buf.length || e.have + buf.length > e.wl) return { ok: false, code: 'over', have: e.have };
    if (this._escW.has(id)) return { ok: false, code: 'busy', have: e.have };
    const { dir, part, bin } = this._escPaths(id);
    const job = (async () => {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const fh = await fs.promises.open(part, 'a');
      try {
        const size = (await fh.stat()).size;
        if (size !== e.have) { e.have = size; return { ok: false, code: 'range', have: size }; } // sisa di disk tidak sama dengan catatan
        await fh.write(buf, 0, buf.length);
      } finally { await fh.close(); }
      if (this.store.esc[id] !== e) return { ok: false, code: 'gone' }; // dibuang selagi menulis; sisa berkas disapu pembuangan
      e.have += buf.length;
      if (e.have === e.wl) { await fs.promises.rename(part, bin); e.done = true; }
      this._save();
      return { ok: true, have: e.have, done: e.done };
    })().catch(() => ({ ok: false, code: 'io', have: e.have }));
    this._escW.set(id, job);
    try { return await job; } finally { this._escW.delete(id); }
  },
  // ---- Mendorong berkas ke kurir (tahap 4b-1: protokol; penjadwalan otomatis dan pencabutan di 4b-2) ----
  // Dua langkah supaya kurir tidak menerima byte dari sembarang peer:
  //   1. esc_q { id, psize }  -> { ok, nonce, have, done, wl } (kurir mengecek syarat, mengeluarkan nonce sekali pakai 30 dtk; `have` sudah sejajar potongan)
  //   2. file_put { id, psize, off, nonce, sig, hi } + byte tersegel mulai `off`: sig = tanda tangan PENGIRIM PESAN (kunci yang ada di titipan)
  //      atas PTAG|id|psize|nonce. Penyadap yang menyalin head tidak bisa memakainya lagi (nonce habis), dan peer lain tidak bisa
  //      mengisi slot dengan sampah. Kurir hanya menyimpan; isi yang diubah di jalan ditolak penerima (tag per potongan).
  _escQuery(o) {
    const id = String(o.id), psize = o.psize;
    const k = this._escCheck(id, psize);
    if (!k.ok) return { t: 'esc_r', ok: false, err: k.code };
    const now = Date.now();
    for (const [n, v] of this._escNonce) if (v.exp < now) this._escNonce.delete(n);
    if (this._escNonce.size >= NONCE_MAX) return { t: 'esc_r', ok: false, err: 'busy' };
    const nonce = crypto.randomBytes(16).toString('hex');
    this._escNonce.set(nonce, { id, exp: now + NONCE_TTL });
    const e = k.e, seg = Xfer.SEG + Xfer.TAG;
    // publik: byte polos, bisa dilanjutkan dari offset mana pun; DM: tersegel, lanjut dari batas potongan
    return { t: 'esc_r', ok: true, nonce, have: e ? (e.done ? e.wl : k.pub ? e.have : e.have - (e.have % seg)) : 0, done: !!(e && e.done), wl: k.pub ? psize : Xfer.wireLen(0, psize) };
  },
  // Potong byte sisa yang tidak sejajar potongan tersegel (koneksi putus di tengah potongan): resume selalu dari batas potongan.
  async _escAlign(id) {
    const e = this.store.esc[id];
    if (!e || e.done || this._escW.has(id)) return;
    const n = e.to === 'public' ? e.have : e.have - (e.have % (Xfer.SEG + Xfer.TAG));
    if (n === e.have) return;
    await fs.promises.truncate(this._escPaths(id).part, n).catch(() => {});
    e.have = n; this._save();
  },
  _escPutServe(sock, o, ip) {
    ip = String(ip).replace('::ffff:', '');
    const no = (err, extra) => { sock.resume(); sock.end(JSON.stringify(Object.assign({ t: 'file_put', ok: false, err }, extra)) + '\n'); };
    if (this.stopped) return sock.destroy();
    const id = String(o.id), psize = o.psize;
    if (!HEX32.test(id) || !Number.isSafeInteger(psize) || !Number.isSafeInteger(o.off) || o.off < 0
      || typeof o.nonce !== 'string' || typeof o.sig !== 'string' || o.sig.length > 200) return no('bad');
    if (o.hi) this.noteHello(o.hi, ip);
    if (o.hi && this.isBlocked(String(o.hi.id))) return no('denied');
    const nz = this._escNonce.get(o.nonce);
    this._escNonce.delete(o.nonce); // sekali pakai, berhasil atau tidak
    if (!nz || nz.id !== id || nz.exp < Date.now()) return no('auth');
    const k = this._escCheck(id, psize);
    if (!k.ok) return no(k.code);
    if (!!o.plain !== k.pub) return no('bad'); // berkas publik didorong polos, DM tersegel: tidak boleh tertukar
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(k.m.pub, 'base64'), format: 'der', type: 'spki' });
      if (!crypto.verify(null, Buffer.from(PTAG + id + ':' + psize + ':' + o.nonce), key, Buffer.from(o.sig, 'base64'))) return no('auth');
    } catch { return no('auth'); }
    let same = 0, sameId = false;
    for (const v of this._putIn.values()) { if (v.ip === ip) same++; if (v.id === id) sameId = true; }
    if (this._putIn.size >= PUT_MAX || same >= PUT_PER_IP || sameId || this._escW.has(id)) return no('busy');
    this._putIn.set(sock, { ip, id });
    let finished = false, got = 0, need = 0, pend = [], pn = 0, off = 0, chain = Promise.resolve();
    const done = () => { finished = true; };
    const flush = async (quiet) => {
      if (!pn) return;
      const b = Buffer.concat(pend); pend = []; pn = 0;
      const r = await this._escWrite(id, off, b);
      if (!r.ok) { if (!quiet) throw { code: r.code, have: r.have }; return; }
      off += b.length;
    };
    const fail = (err, extra) => { if (finished) return; done(); sock.removeAllListeners('data'); no(err, extra); };
    sock.setTimeout(Xfer.IDLE_MS, () => sock.destroy());
    // koneksi putus di tengah jalan: simpan yang sudah masuk (resume akan melanjutkan dari batas potongan), lalu lepaskan slot
    sock.once('close', () => { chain = chain.then(() => (finished ? null : flush(true))).catch(() => {}).then(() => this._putIn.delete(sock)); });
    (async () => {
      const r = this._escReserve(id, psize);
      if (!r.ok) return fail(r.code);
      await this._escAlign(id);
      const e = this.store.esc[id];
      if (!e) return fail('gone');
      if (e.done) return fail('range', { have: e.wl });
      if (o.off !== e.have) return fail('range', { have: e.have });
      off = o.off; need = e.wl - o.off;
      const finish = () => {
        if (finished) return;
        done();
        sock.end(JSON.stringify({ t: 'file_put', ok: true, have: e.have, done: e.done }) + '\n');
      };
      if (need === 0) return finish();
      sock.on('data', (c) => {
        if (finished) return;
        got += c.length;
        if (got > need) { chain = chain.then(() => fail('over')); return; }
        pend.push(c); pn += c.length;
        if (pn >= 262144 || got === need) {
          sock.pause();
          chain = chain.then(() => flush(false)).then(() => { if (finished || sock.destroyed) return; if (got === need) finish(); else sock.resume(); })
            .catch((x) => fail(x && x.code ? x.code : 'io', x && Number.isSafeInteger(x.have) ? { have: x.have } : undefined));
        }
      });
      sock.resume();
    })().catch(() => fail('io'));
  },
};

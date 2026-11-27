'use strict';
// src/core/archne-mailbox-out.js — outbox kotak surat dan status kirim (langkah 4d).
// Antrean titipan keluar yang tahan restart (store.mbox.q), dengan percobaan ulang bertahap. Tetap tanpa jaringan: Core hanya MEMUTUSKAN dan MENYEGEL,
// host (archne-wanhost.js) mem-publish hasilnya lalu melapor lewat mailboxOutDone. Alurnya:
//   host: jobs = core.mailboxPlan()  ->  tiap job di-publish  ->  core.mailboxOutDone(job.id, ok)
//
// Status pesan TIDAK mengubah store.status ('pending' -> 'delivered' tetap milik jalur lama: kirim langsung, kurir, tanda terima), supaya pengiriman langsung dan
// kurir tetap jalan walau titipan gagal. Status kotak surat adalah lapisan sendiri, dibaca lewat mailboxStatus(id):
//   'queued'     antre: belum berhasil dititipkan (menunggu peer terdeteksi offline, broker tersambung, kuota, atau jeda percobaan ulang)
//   'deposited'  dititipkan: sudah di-publish retained ke broker, menunggu penerima mengambil
//   'failed'     gagal: masa berlaku titipan lewat tanpa pesan terkirim (why: 'expired'), atau tidak bisa disegel (why: 'toobig' | 'invalid'). Bisa dicoba lagi: mailboxRetry
//   'delivered'  sudah terkirim (tanda terima masuk) tetapi titipan di broker belum sempat dibersihkan
// 'terkirim' sendiri dibuktikan seperti biasa oleh store.status[id] === 'delivered'. Penerima yang mengambil dari kotak surat mengirim tanda terima bertanda tangan
// lewat kotak surat pengirim (entri 'r' di antrean yang sama), jadi pengirim tahu walau mereka tidak pernah bertemu langsung.
//
// Entri antrean: q[kunci] = { k: 'm'|'r', to, at, ttl, st, n, next, mid?, exp?, sat?, why?, dat? }
//   kunci: id pesan (32 hex) untuk 'm'; 'rc:' + id pesan untuk tanda terima 'r'.
//   st: queued | sending (job sudah dibagikan, host belum melapor) | deposited | failed | clear (titipan perlu dikosongkan di broker) | clearing
const Mailbox = require('../archne-mailbox');
const { HEX16 } = require('./archne-constants');

const BACKOFF_BASE = 15e3, BACKOFF_MAX = 600e3; // percobaan ulang: 15 dtk, 30 dtk, ... maksimal 10 menit
const POLL_MS = 15e3;      // peer terdeteksi online: tunggu sebentar, jalur langsung yang mengantar
const FULL_MS = 60e3;      // kuota titipan penuh: coba lagi nanti
const INFLIGHT_MS = 60e3;  // job yang tidak dilaporkan host dianggap gagal publish
const JOBS_MAX = 20;       // job per panggilan mailboxPlan
const RC_MAX = 200;        // tanda terima yang menunggu dititipkan
const Q_MAX = 2000;        // seluruh entri antrean
const KEY_RE = /^(rc:)?[0-9a-f]{32}$/;
const STATES = new Set(['queued', 'sending', 'deposited', 'failed', 'clear', 'clearing']);
const FINAL = /terlalu besar|tidak valid|diblokir/; // galat penyegelan yang tidak akan membaik dengan mencoba lagi
const backoff = (n) => Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** Math.min(Math.max(n - 1, 0), 10)); // kegagalan ke-1: 15 dtk, ke-2: 30 dtk, ...
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

module.exports = {
  // ---- pengaturan (tombol di UI = langkah 4e) ----
  // Menitip pesan keluar ke broker. Bawaan MATI: broker melihat metadata (topik, waktu, ukuran), jadi pengguna memilih sendiri. Mengambil titipan (4c) tidak bergantung pada ini.
  mailboxOutEnabled() { const c = this.store.mbox && this.store.mbox.cfg; return !!(c && c.out === true); },
  mailboxSetOut(on) {
    const m = this.store.mbox || (this.store.mbox = {});
    m.cfg = Object.assign({}, m.cfg, { out: !!on });
    this._mboxPersist(); this.emit('update');
    return !!on;
  },
  // Untuk layar Pengaturan (4e): { out, ttlMs, ttlMin, ttlMax, queued, deposited, failed }. Tanpa rahasia.
  mailboxSettings() { const i = this.mailboxOutInfo(); return { out: i.enabled, ttlMs: this.mailboxOutTtl(), ttlMin: Mailbox.MIN_TTL_MS, ttlMax: Mailbox.MAX_TTL_MS, queued: i.queued, deposited: i.deposited, failed: i.failed }; },
  // Satu panggilan dari UI: out (bool, opsional) dan ttlMs (opsional). Semua divalidasi dulu, baru diterapkan.
  mailboxConfigure(out, ttlMs) {
    if (ttlMs !== undefined && ttlMs !== null && (!Number.isSafeInteger(ttlMs) || ttlMs < Mailbox.MIN_TTL_MS || ttlMs > Mailbox.MAX_TTL_MS)) throw new Error('Masa berlaku tidak valid');
    if (ttlMs !== undefined && ttlMs !== null) this.mailboxSetTtl(ttlMs);
    if (out === true || out === false) this.mailboxSetOut(out);
    return this.mailboxSettings();
  },
  // Masa berlaku titipan baru (bawaan 7 hari), dalam batas Mailbox.MIN_TTL_MS..MAX_TTL_MS.
  mailboxOutTtl() { const c = this.store.mbox && this.store.mbox.cfg, t = c && c.ttl; return Number.isSafeInteger(t) && t >= Mailbox.MIN_TTL_MS && t <= Mailbox.MAX_TTL_MS ? t : Mailbox.DEFAULT_TTL_MS; },
  mailboxSetTtl(ms) {
    if (!Number.isSafeInteger(ms) || ms < Mailbox.MIN_TTL_MS || ms > Mailbox.MAX_TTL_MS) throw new Error('Masa berlaku tidak valid');
    const m = this.store.mbox || (this.store.mbox = {});
    m.cfg = Object.assign({}, m.cfg, { ttl: ms });
    this._mboxPersist();
    return ms;
  },

  // ---- antrean ----
  // Lazy dari store.mbox.q. Entri rusak dibuang; job yang sedang berjalan saat aplikasi mati dikembalikan ke antre (kuota dilepas, publish dianggap gagal).
  _mboxQ() {
    if (this._mbQ) return this._mbQ;
    const src = this.store.mbox && this.store.mbox.q, q = {};
    this._mbQ = q; // dipasang dulu: _mboxOut() di bawah tidak boleh memanggil balik
    if (!src || typeof src !== 'object') return q;
    const out = this._mboxOut();
    for (const [key, e] of Object.entries(src)) {
      if (!KEY_RE.test(key) || !e || typeof e !== 'object' || !HEX16.test(String(e.to)) || !Number.isSafeInteger(e.at) || !STATES.has(e.st)) continue;
      const x = { k: key.startsWith('rc:') ? 'r' : 'm', to: e.to, at: e.at, ttl: Number.isSafeInteger(e.ttl) && e.ttl >= Mailbox.MIN_TTL_MS && e.ttl <= Mailbox.MAX_TTL_MS ? e.ttl : Mailbox.DEFAULT_TTL_MS, st: e.st, n: int(e.n), next: int(e.next) };
      if (HEX16.test(String(e.mid)) && Number.isSafeInteger(e.exp)) { x.mid = e.mid; x.exp = e.exp; }
      if (typeof e.why === 'string') x.why = e.why.slice(0, 16);
      if (Number.isSafeInteger(e.dat)) x.dat = e.dat;
      if (x.st === 'sending') { if (x.mid) Mailbox.outRemove(out, x.to, x.mid); delete x.mid; delete x.exp; x.st = 'queued'; }
      else if (x.st === 'clearing') x.st = 'clear';
      if ((x.st === 'deposited' || x.st === 'clear') && !x.mid) continue; // tanpa mid tidak ada yang bisa dikosongkan
      q[key] = x;
    }
    return q;
  },
  // Dipanggil host: apa yang harus di-publish sekarang. Juga merawat antrean (kedaluwarsa, pembersihan, entri baru). Aman dipanggil sering; tanpa perubahan tidak menulis apa pun.
  // Hasil: [{ id, to, topic, payload, mid, retain: true, qos: 1, exp?, clear? }]. `clear: true` = payload '' untuk mengosongkan titipan retained di broker.
  // Setiap job HARUS dilaporkan lewat mailboxOutDone(id, ok).
  mailboxPlan(opts) {
    const now = Date.now(), q = this._mboxQ(), out = this._mboxOut(), w = this._wanCtx(), on = this.mailboxOutEnabled() && !!w;
    const max = opts && Number.isSafeInteger(opts.max) && opts.max > 0 ? Math.min(opts.max, JOBS_MAX) : JOBS_MAX;
    let ch = false;
    const drop = (key) => { const e = q[key]; if (e && e.mid) Mailbox.outRemove(out, e.to, e.mid); delete q[key]; ch = true; };
    const tidy = (key, e) => { if (e.mid && now <= e.exp && w) { e.st = 'clear'; e.n = 0; e.next = 0; ch = true; } else drop(key); }; // titipan masih hidup di broker: kosongkan dulu
    for (const [key, e] of Object.entries(q)) { // job yang tidak pernah dilaporkan host
      if ((e.st === 'sending' || e.st === 'clearing') && now - (e.sat || 0) > INFLIGHT_MS) { this._mboxFail(key, e, now); ch = true; }
    }
    // 1. rawat entri
    for (const [key, e] of Object.entries(q)) {
      if (e.k === 'r') { if (now > e.at + e.ttl) drop(key); continue; }
      if (e.st === 'sending' || e.st === 'clearing') continue;
      if (e.st === 'clear') { if (!e.exp || now > e.exp) drop(key); continue; }
      const m = this.store.msgs[key];
      const need = !!m && m.from === this.id && this.store.status[key] === 'pending' && !this.isBlocked(e.to);
      if (!need) { // terkirim lewat jalur lain, dibatalkan, dibersihkan, atau penerima diblokir
        if (e.st === 'deposited') tidy(key, e); else drop(key);
        continue;
      }
      if (e.st === 'deposited' && now > e.exp) { e.st = 'failed'; e.why = 'expired'; ch = true; }
      else if (e.st === 'queued' && now > e.at + e.ttl) { // tidak pernah berhasil dititipkan selama satu masa berlaku penuh
        if (e.mid) Mailbox.outRemove(out, e.to, e.mid);
        delete e.mid; delete e.exp; e.st = 'failed'; e.why = 'expired'; ch = true;
      }
    }
    // 2. pesan DM baru yang masih tertahan untuk peer yang sedang offline: masuk antrean
    if (on) {
      let size = Object.keys(q).length;
      const ttl = this.mailboxOutTtl();
      for (const [id, st] of Object.entries(this.store.status)) {
        if (st !== 'pending' || q[id] || size >= Q_MAX) continue;
        const m = this.store.msgs[id];
        if (!m || m.from !== this.id || m.kind !== 'e1' || !HEX16.test(String(m.to)) || this.isBlocked(m.to) || this._on.get(m.to) || !this._pairKey(m.to)) continue;
        q[id] = { k: 'm', to: m.to, at: now, ttl, st: 'queued', n: 0, next: 0 }; size++; ch = true;
      }
    }
    // 3. job yang jatuh tempo, yang tertua dulu
    const jobs = [];
    const due = Object.entries(q).filter(([, e]) => (e.st === 'queued' || e.st === 'clear') && e.next <= now).sort((a, b) => a[1].at - b[1].at);
    for (const [key, e] of due) {
      if (jobs.length >= max) break;
      if (e.st === 'clear') {
        e.st = 'clearing'; e.sat = now; ch = true;
        jobs.push({ id: key, to: e.to, topic: Mailbox.topicOf(w.netId, e.to, e.mid), payload: '', mid: e.mid, retain: true, qos: 1, clear: true });
        continue;
      }
      if (!on) continue;
      try {
        let d;
        if (e.k === 'm') d = this.mailboxDepositMsg(this.store.msgs[key], { ttlMs: e.ttl });
        else {
          const rc = this.store.receipts[key.slice(3) + this.id];
          if (!rc) { drop(key); continue; }
          d = this.mailboxDeposit(e.to, { k: 'rc', rc: { id: rc.id, by: rc.by, pub: rc.pub, sig: rc.sig } }, { force: true, ttlMs: e.ttl }); // penerima tanda terima = pengirim asli, yang sedang offline
        }
        if (!d.ok) { e.next = now + (d.why === 'online' ? POLL_MS : FULL_MS); continue; } // sementara: tanpa menulis apa pun
        e.st = 'sending'; e.mid = d.mid; e.exp = d.exp; e.sat = now; delete e.why; ch = true;
        jobs.push({ id: key, to: e.to, topic: d.topic, payload: d.payload, mid: d.mid, exp: d.exp, retain: true, qos: 1 });
      } catch (err) {
        if (FINAL.test(String(err && err.message))) {
          if (e.k === 'r') drop(key);
          else { e.st = 'failed'; e.why = /terlalu besar/.test(String(err.message)) ? 'toobig' : 'invalid'; ch = true; }
        } else { e.n++; e.next = now + backoff(e.n); } // mis. kunci pasangan belum ada: tunggu
      }
    }
    if (ch) { this._mboxPersist(); this.emit('update'); }
    return jobs;
  },
  // Satu job gagal (publish gagal, atau tidak pernah dilaporkan). Kuota titipan dilepas; percobaan berikutnya menyegel ulang dengan id baru.
  _mboxFail(key, e, now) {
    const q = this._mboxQ();
    if (e.st === 'clearing') { e.st = 'clear'; e.n++; e.next = now + backoff(e.n); delete e.sat; return; }
    if (e.mid) Mailbox.outRemove(this._mboxOut(), e.to, e.mid);
    delete e.mid; delete e.exp; delete e.sat;
    e.st = 'queued'; e.n++; e.next = now + backoff(e.n);
    if (!q[key]) q[key] = e;
  },
  // Laporan host untuk satu job dari mailboxPlan. ok = broker menerima publish. Mengembalikan false bila id itu bukan job yang sedang berjalan.
  mailboxOutDone(id, ok) {
    const q = this._mboxQ(), e = q[id], now = Date.now();
    if (!e || (e.st !== 'sending' && e.st !== 'clearing')) return false;
    if (e.st === 'clearing') {
      if (ok) { if (e.mid) Mailbox.outRemove(this._mboxOut(), e.to, e.mid); delete q[id]; }
      else this._mboxFail(id, e, now);
    } else if (ok) {
      if (e.k === 'r') delete q[id]; // tanda terima cukup sampai ke broker; penerimanya yang membersihkan, kuota lepas sendiri saat exp
      else { e.st = 'deposited'; e.dat = now; e.n = 0; e.next = 0; delete e.sat; delete e.why; }
    } else this._mboxFail(id, e, now);
    this._mboxPersist(); this.emit('update');
    return true;
  },
  // Coba lagi pesan yang gagal (kedaluwarsa dan sebagainya): kembali ke antre dengan masa berlaku baru. Mengembalikan true bila ada yang diubah.
  mailboxRetry(id) {
    const e = this._mboxQ()[String(id)];
    if (!e || e.k !== 'm' || e.st !== 'failed' || this.store.status[id] !== 'pending') return false;
    e.st = 'queued'; e.at = Date.now(); e.ttl = this.mailboxOutTtl(); e.n = 0; e.next = 0; delete e.why; delete e.mid; delete e.exp;
    this._mboxPersist(); this.emit('update');
    return true;
  },
  // Status kotak surat satu pesan keluar: { state: 'queued'|'deposited'|'failed'|'delivered', why?, exp?, n? } atau null bila pesan ini tidak lewat kotak surat.
  // 'delivered' di sini hanya berarti: sudah terkirim lewat jalur mana pun, tetapi titipannya belum selesai dibersihkan. Setelah itu entri hilang dan hanya store.status yang berbicara.
  mailboxStatus(id) {
    const e = this._mboxQ()[String(id)];
    if (!e || e.k !== 'm') return null;
    const s = this.store.status[id] === 'delivered' || e.st === 'clear' || e.st === 'clearing' ? 'delivered' : e.st === 'sending' ? 'queued' : e.st;
    const r = { state: s };
    if (e.why) r.why = e.why;
    if (e.exp) r.exp = e.exp;
    if (e.n) r.n = e.n;
    return r;
  },
  // Ringkasan untuk UI: jumlah pesan keluar per status kotak surat.
  mailboxOutInfo() {
    const r = { enabled: this.mailboxOutEnabled(), queued: 0, deposited: 0, failed: 0, receipts: 0 };
    for (const e of Object.values(this._mboxQ())) {
      if (e.k === 'r') { r.receipts++; continue; }
      if (e.st === 'queued' || e.st === 'sending') r.queued++; else if (e.st === 'deposited') r.deposited++; else if (e.st === 'failed') r.failed++;
    }
    return r;
  },
  // Penerima baru saja menyimpan pesan `id` dari `to`: titipkan tanda terima bertanda tangan ke kotak surat pengirim (hanya bila menitip keluar menyala).
  _mboxEnqRc(to, id) {
    if (!this.mailboxOutEnabled() || !this._wanCtx() || !HEX16.test(String(to))) return false;
    const key = 'rc:' + id, q = this._mboxQ();
    if (q[key] || !this.store.receipts[id + this.id]) return false;
    const rcs = Object.keys(q).filter((k) => q[k].k === 'r').sort((a, b) => q[a].at - q[b].at);
    while (rcs.length >= RC_MAX) delete q[rcs.shift()];
    q[key] = { k: 'r', to, at: Date.now(), ttl: this.mailboxOutTtl(), st: 'queued', n: 0, next: 0 };
    this._mboxPersist();
    return true;
  },
};

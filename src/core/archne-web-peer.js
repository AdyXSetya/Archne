'use strict';
// src/core/archne-web-peer.js — Web Lokal (0.34.0 Fase C.2): sisi PEMINTA. Stateless seperti pageList / pagePost: tiap panggilan satu koneksi pendek ke pemilik, permintaan selalu ditandatangani.
// Jawaban pemilik TIDAK dipercaya: semua dicek bentuknya (jalur lewat tryRel, metadata lewat normSite kanonik, hash heks, ukuran) dan isi berkas diverifikasi hash SHA-256 sebelum dipakai.
// Galat berupa Error ber-`code`: self | peer | blocked | offline | old | auth | time | busy | bad | proto | gone | changed | hash | big | cancel. Cache penonton: archne-web-cache.js.
const fs = require('fs');
const crypto = require('crypto');
const { HEX16, DEFAULT_TCP_PORT } = require('./archne-constants');
const { normSite } = require('../archne-webstore');
const { tryRel } = require('../archne-webfiles');
const { LW } = require('./archne-web');
const { ek } = require('./archne-ecode');
const { LWQ } = require('./archne-web-req');

const LW_ERR = {
  peer: 'Peer tidak dikenal', self: 'Ini situsmu sendiri', blocked: 'Kamu memblokir orang ini. Buka blokirnya dulu.', offline: 'Pemilik sedang offline. Situs hanya bisa dibuka saat pemilik online.', bg: 'Pemilik online tetapi aplikasinya sedang di latar belakang. Minta dia membuka Archne di HP-nya, lalu coba lagi.',
  old: 'Aplikasi pemilik belum mendukung Web Lokal.', auth: 'Pemilik menolak permintaanmu (tanda tangan tidak sah atau aplikasimu terlalu lama).', time: 'Jam perangkatmu dan jam pemilik berbeda terlalu jauh. Samakan jam, lalu coba lagi.',
  busy: 'Pemilik sedang sibuk. Coba lagi sebentar lagi.', bad: 'Permintaan tidak valid', proto: 'Jawaban pemilik tidak dapat dibaca', gone: 'Berkas sudah tidak tersedia di pemilik.',
  changed: 'Situs berubah selagi diambil. Coba lagi.', hash: 'Isi berkas tidak cocok dengan hash yang dijanjikan pemilik.', big: 'Situs terlalu besar untuk diambil.', cancel: 'Pengambilan dibatalkan.',
};
// Galat berkunci i18n (e.lw.err.<kode>): .message tetap teks Indonesia, terjemahan dipilih di perbatasan IPC (errText).
const lwErr = (code) => { const c = LW_ERR[code] ? code : 'proto'; return ek('e.lw.err.' + c, null, LW_ERR[c], code); };
const T_LIST = 10000, T_MAN = 60000, T_CHUNK = 15000; // batas waktu (ms); manifest lama karena pemilik menghitung hash berkas yang belum di-cache
const BUSY_TRIES = 4, BUSY_WAIT = 300, T_REQ = 45000; // T_REQ: pool PHP memutus di 30 dtk (504); sisanya margin jaringan
const RES_HDR_MAX = 64, RES_VAL_MAX = 8192, RES_VALS_MAX = 16, RES_DROP = new Set(['x-powered-by', 'transfer-encoding', 'connection', 'keep-alive', 'content-length', 'server', 'proxy-authenticate', 'upgrade']);
const BAD_VAL = /[\x00-\x08\x0a-\x1f\x7f]/, HNAME = /^[a-z0-9-]{1,64}$/, REQ_B64_MAX = Math.ceil(LWQ.LW_REQ_OUT / 3) * 4;
const MAX_FILES = 200000; // batas sisi penonton untuk satu manifest (melindungi memori dari pemilik jahat); BUKAN batas produk untuk pemilik
const B64 = /^[A-Za-z0-9+/]*={0,2}$/, B64_MAX = Math.ceil(LW.LW_CHUNK / 3) * 4;
const H64 = /^[0-9a-f]{64}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Metadata situs dari peer -> bentuk bersih (tanpa priv) atau null. normSite menuntut bentuk kanonik, jadi karakter kontrol / bidi / tag tak bersih ditolak.
function wireSite(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string') return null;
  const s = normSite(Object.assign({}, x, { v: 1, priv: 'public' }), x.id);
  if (!s) return null;
  return { id: s.id, domain: s.domain, title: s.title, desc: s.desc, tags: s.tags, entry: s.entry, rev: s.rev, ts: s.ts, ...(s.php ? { php: true } : {}) }; // php:true = situs PHP: dibuka lewat webRemoteReq, tidak punya manifest/berkas
}
// Satu halaman manifest -> { rev, entry, n, files, next } atau null bila cacat.
function wireManifestPage(m, siteId, after) {
  if (!m || typeof m !== 'object' || m.id !== siteId || !Number.isSafeInteger(m.rev) || m.rev < 1 || !Number.isSafeInteger(m.n) || m.n < 0) return null;
  const entry = tryRel(m.entry);
  if (!entry || entry !== m.entry || !Array.isArray(m.files) || m.files.length > LW.LW_MAN_FILES) return null;
  let prev = after == null ? null : after;
  const files = [];
  for (const f of m.files) {
    if (!f || typeof f.p !== 'string' || tryRel(f.p) !== f.p || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.hash !== 'string' || !H64.test(f.hash)) return null;
    if (prev !== null && !(f.p > prev)) return null; // harus naik ketat (tanpa ganda, tanpa mundur): menutup pemilik yang berputar-putar
    prev = f.p; files.push({ p: f.p, size: f.size, hash: f.hash });
  }
  if (m.next != null && (typeof m.next !== 'string' || !files.length || m.next !== files[files.length - 1].p)) return null;
  return { rev: m.rev, entry, n: m.n, files, next: m.next == null ? null : m.next };
}

// Jawaban lw_req pemilik (TIDAK dipercaya) -> { status, headers:{nama:[nilai]}, body:Buffer } atau null (cacat). Header berbahaya/tidak berguna dibuang, bukan galat.
// HEAD, 1xx, 204 dan 304 tidak punya badan: badan kiriman pemilik dibuang.
function wireReqRes(r, method) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) return null;
  if (!r.headers || typeof r.headers !== 'object' || Array.isArray(r.headers) || typeof r.b64 !== 'string') return null;
  const isBig = r.tok !== undefined || r.tl !== undefined; // hasil besar: badan tidak ikut, diambil per potongan (P.5c)
  if (isBig) {
    if (r.b64 !== '' || typeof r.tok !== 'string' || !HEX16.test(r.tok) || !Number.isSafeInteger(r.tl) || r.tl <= LWQ.LW_REQ_OUT || r.tl > LWQ.LW_BIG) return null;
    if (method === 'HEAD' || r.status < 200 || r.status === 204 || r.status === 304) return null;
  } else if (r.b64.length > REQ_B64_MAX || r.b64.length % 4 !== 0 || !B64.test(r.b64)) return null;
  const names = Object.keys(r.headers);
  if (names.length > RES_HDR_MAX) return null;
  const headers = {};
  for (const k of names) {
    const v = r.headers[k];
    if (!HNAME.test(k) || !Array.isArray(v) || !v.length || v.length > RES_VALS_MAX) return null;
    for (const x of v) if (typeof x !== 'string' || x.length > RES_VAL_MAX || BAD_VAL.test(x)) return null;
    if (!RES_DROP.has(k)) headers[k] = v.slice();
  }
  if (isBig) return { status: r.status, headers, big: { tl: r.tl, tok: r.tok } };
  let body = Buffer.from(r.b64, 'base64');
  if (body.length > LWQ.LW_REQ_OUT) return null;
  if (method === 'HEAD' || r.status < 200 || r.status === 204 || r.status === 304) body = Buffer.alloc(0);
  return { status: r.status, headers, body };
}
// Permintaan penonton -> bentuk kawat (tanpa tanda tangan) atau galat 'bad'. Nama header apa pun huruf diubah ke huruf kecil; yang di luar daftar izin dibuang (pemilik juga membuangnya); ganda digabung.
function wireReqOut(siteId, req) {
  if (!req || typeof req !== 'object' || typeof siteId !== 'string' || !HEX16.test(siteId)) throw lwErr('bad');
  const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
  const hd = {};
  for (const [k0, v0] of Object.entries(req.headers || {})) {
    const k = String(k0).toLowerCase();
    if (!LWQ.REQ_HDR.has(k)) continue;
    const v = Array.isArray(v0) ? v0.join(k === 'cookie' ? '; ' : ', ') : v0;
    hd[k] = hd[k] === undefined ? v : hd[k] + (k === 'cookie' ? '; ' : ', ') + v;
  }
  let b = null;
  if (req.body != null && !(Buffer.isBuffer(req.body) && !req.body.length && !LWQ.WITH_BODY.has(method))) {
    b = Buffer.isBuffer(req.body) ? req.body : typeof req.body === 'string' ? Buffer.from(req.body) : null;
    if (!b) throw lwErr('bad');
  }
  const bb = b || Buffer.alloc(0);
  const o = { t: 'lw_req', id: siteId, method, path: req.path, query: req.query == null ? '' : req.query, hd, bh: crypto.createHash('sha256').update(bb).digest('hex') };
  let big = null; // badan > LW_REQ_IN: diunggah per potongan dulu (lw_rup), lw_req hanya membawa token `up`
  if (b && b.length > LWQ.LW_REQ_IN) { if (b.length > LWQ.LW_BIG) throw lwErr('bad'); big = b; o.up = crypto.randomBytes(8).toString('hex'); }
  else if (b && b.length) o.b64 = b.toString('base64'); // badan kosong tidak dikirim (hash byte kosong tetap ikut ditandatangani)
  if (!LWQ.shapeReq(o)) throw lwErr('bad'); // bentuk yang sama persis dengan pemeriksaan pemilik: yang pasti ditolak tidak membuang jaringan
  return { o, big };
}

module.exports = {
  // Apakah situs PHP peer ini bisa diminta sekarang? Sama dengan webAvail, tetapi menuntut kemampuan 'lw2' (hello sudah dikenal tanpa 'lw2' = 'old').
  webAvailReq(peerId) {
    const a = this.webAvail(peerId);
    if (!a.ok) return a;
    const p = this.peers.get(String(peerId));
    if (Array.isArray(p.caps) && !p.caps.includes('lw2')) return { ok: false, why: 'old' };
    return { ok: true };
  },
  // Apakah situs peer ini bisa diminta sekarang? { ok:true } | { ok:false, why: 'self' | 'peer' | 'blocked' | 'offline' | 'old' }. Tidak menyentuh jaringan.
  webAvail(peerId) {
    const id = String(peerId);
    if (id === this.id) return { ok: false, why: 'self' };
    const p = HEX16.test(id) ? this.peers.get(id) : null;
    if (!p) return { ok: false, why: 'peer' };
    if (this.isBlocked(p.id)) return { ok: false, why: 'blocked' };
    if (!this.isOnline(p)) return { ok: false, why: 'offline' };
    if (Array.isArray(p.caps) && !p.caps.includes('lw1')) return { ok: false, why: 'old' }; // hello sudah dikenal tanpa 'lw1': versi lama, jangan menunggu timeout
    return { ok: true };
  },
  // Seperti webAvail, tetapi peer yang tampak OFFLINE ditanyai langsung (hello, maks 3 dtk) dulu. Status online hanya diperbarui oleh hello; di HP yang baru kembali dari latar belakang
  // pewaktu inti tertahan dan siaran UDP terlewat, jadi peer yang sebenarnya hidup tampak offline sampai tick berikut. Tanpa ini membuka situs langsung ditolak ("Pemilik sedang offline")
  // dan baru berhasil setelah diulang beberapa kali. Satu penanyaan per peer pada satu waktu; peer yang memang mati hanya menambah jeda <= 3 dtk sebelum galat yang sama.
  async webReach(peerId) {
    const a = this.webAvail(peerId);
    if (a.ok || a.why !== 'offline') return a;
    const id = String(peerId), p = this.peers.get(id);
    // Pemilik hadir di broker tetapi link-nya mati (HP terkunci / aplikasi di latar): bangunkan dan tunggu ~25 dtk, lalu beri petunjuk, bukan "offline".
    if (this.peerLive(p) === 'bg') {
      await this.peerWait(id, this.opts.bgWaitMs == null ? 25000 : this.opts.bgWaitMs);
      const b = this.webAvail(peerId);
      return b.ok || b.why !== 'offline' ? b : this.isPresent(id) ? { ok: false, why: 'bg' } : b;
    }
    if (!p || !p.ip || !p.port) return a;
    if (!this._reach) this._reach = new Map();
    let job = this._reach.get(id);
    if (!job) {
      const to = [{ ip: p.ip, port: p.port }];
      if (p.port !== DEFAULT_TCP_PORT) to.push({ ip: p.ip, port: DEFAULT_TCP_PORT }); // dia mungkin dibuka ulang dengan port tetap (port lamanya basi), seperti _tick
      job = Promise.all(to.map((t) => this._request(t, { t: 'hello' }, 3000))).catch(() => {}).finally(() => { this._reach.delete(id); });
      this._reach.set(id, job);
    }
    await job;
    return this.webAvail(peerId);
  },
  async _lwAsk(peerId, obj, timeout) {
    const a = await this.webReach(peerId);
    if (!a.ok) throw lwErr(a.why);
    const r = await this._request(this.peers.get(String(peerId)), this._lwSign(peerId, obj), timeout);
    if (!r) throw lwErr('offline');
    if (r.t !== obj.t) throw lwErr('proto');
    if (r.ok === false) throw lwErr(['bad', 'auth', 'time', 'busy'].includes(r.err) ? r.err : 'proto');
    if (r.ok !== true) throw lwErr('proto');
    return r;
  },
  // Sama dengan _lwAsk, tetapi 'busy' diulang beberapa kali dengan jeda (pembatas laju pemilik dilewati sebentar).
  async _lwAskBusy(peerId, obj, timeout, signal) {
    for (let i = 0; ; i++) {
      if (signal && signal.aborted) throw lwErr('cancel');
      try { return await this._lwAsk(peerId, obj, timeout); } catch (e) { if (e.code !== 'busy' || i >= BUSY_TRIES - 1) throw e; await sleep(BUSY_WAIT); }
    }
  },
  // Satu permintaan HTTP ke situs PHP milik peer: req = { method?, path, query?, headers?, body? (Buffer|string) } -> { status, headers:{nama:[nilai]}, body:Buffer } atau null
  // (tidak ada / bukan untukku / diblokir / bukan situs PHP / mesin pemilik mati: tak dibedakan). Galat ber-code: bad (cacat; tanpa jaringan) | big (jawaban > batas) | busy (setelah beberapa ulang) |
  // offline | old | blocked | self | peer | auth | time | proto | cancel. 'busy' dari pemilik selalu ditolak SEBELUM PHP jalan, jadi mengulang POST aman. Jawaban pemilik divalidasi ketat (wireReqRes).
  // Penampil (P.5d) menaruh hasilnya di gerbang cookie (archne-phpgate.js), yang membuang header berbahaya lagi.
  async webRemoteReq(peerId, siteId, req, opts) {
    const { o, big } = wireReqOut(siteId, req), signal = opts && opts.signal, method = o.method, PART = LWQ.LW_PART;
    let a = this.webAvailReq(peerId);
    if (!a.ok && a.why === 'offline') { await this.webReach(peerId); a = this.webAvailReq(peerId); }
    if (!a.ok) throw lwErr(a.why);
    if (big) { // unggah berurutan; pemilik menolak 'busy' sebelum menyimpan, dan sebelum PHP jalan
      for (let off = 0; off < big.length; off += PART) {
        const c = big.subarray(off, off + PART);
        const r = await this._lwReqAsk(peerId, { t: 'lw_rup', id: siteId, hd: {}, up: o.up, off, bh: crypto.createHash('sha256').update(c).digest('hex'), b64: c.toString('base64') }, T_CHUNK, signal);
        if (r.n === null) return null;
        if (r.n !== off + c.length) throw lwErr('proto');
      }
    }
    const r = await this._lwReqAsk(peerId, o, (opts && opts.timeout) || T_REQ, signal);
    if (r.r === null) return null;
    const w = wireReqRes(r.r, method);
    if (!w) throw lwErr('proto');
    if (!w.big) return w;
    const { tl, tok } = w.big, out = Buffer.allocUnsafe(tl);
    for (let off = 0; off < tl;) {
      const want = Math.min(PART, tl - off);
      const c = (await this._lwReqAsk(peerId, { t: 'lw_rbody', id: siteId, hd: {}, up: tok, off, len: want }, T_CHUNK, signal)).c;
      if (c == null) throw lwErr('gone');
      if (typeof c !== 'object' || c.off !== off || c.total !== tl || typeof c.b64 !== 'string' || c.b64.length > Math.ceil(want / 3) * 4 || !B64.test(c.b64)) throw lwErr('proto');
      const buf = Buffer.from(c.b64, 'base64');
      if (!buf.length || buf.length > want) throw lwErr('proto'); // tanpa kemajuan: jangan berputar selamanya
      buf.copy(out, off); off += buf.length;
    }
    return { status: w.status, headers: w.headers, body: out };
  },
  // Tanda tangan + kirim + ulang 'busy' (pemilik menolak sebelum menyentuh apa pun, jadi aman). Tiap ulang nonce baru. Mengembalikan jawaban ok:true; selain itu galat.
  async _lwReqAsk(peerId, obj, timeout, signal) {
    for (let i = 0; ; i++) {
      if (signal && signal.aborted) throw lwErr('cancel');
      const p = this.peers.get(String(peerId));
      if (!p) throw lwErr('peer');
      const r = await this._request(p, LWQ.lwReqSign(this.privKey, String(peerId), obj), timeout);
      if (signal && signal.aborted) throw lwErr('cancel');
      if (!r) throw lwErr('offline');
      if (r.t !== obj.t) throw lwErr('proto');
      if (r.ok === false) {
        if (r.err === 'busy' && i < BUSY_TRIES - 1) { await sleep(BUSY_WAIT); continue; }
        throw lwErr(['bad', 'auth', 'time', 'busy', 'big'].includes(r.err) ? r.err : 'proto');
      }
      if (r.ok !== true) throw lwErr('proto');
      return r;
    }
  },
  // Daftar situs peer (terbaru dulu, berhalaman). opts: { after, limit (1..50), q }. -> { items, next, count }. Diblokir / tanpa situs / tanpa yang terlihat = items kosong (tak dibedakan).
  async webRemoteList(peerId, opts) {
    opts = opts || {};
    const req = { t: 'lw_list' };
    if (opts.after != null) { if (typeof opts.after !== 'string' || !LW.CURSOR.test(opts.after)) throw lwErr('bad'); req.after = opts.after; }
    if (opts.q != null && opts.q !== '') { if (typeof opts.q !== 'string' || opts.q.length > 64) throw lwErr('bad'); req.q = opts.q; }
    req.limit = Number.isInteger(opts.limit) ? Math.min(LW.LW_LIST_MAX, Math.max(1, opts.limit)) : LW.LW_LIST_DEF;
    const r = await this._lwAskBusy(peerId, req, T_LIST);
    if (!Array.isArray(r.items) || r.items.length > req.limit || !Number.isSafeInteger(r.count) || r.count < 0) throw lwErr('proto');
    const items = [];
    let prev = Infinity;
    for (const x of r.items) {
      const s = wireSite(x);
      if (!s || !(s.ts < prev)) throw lwErr('proto'); // harus turun ketat menurut ts
      prev = s.ts; items.push(s);
    }
    if (r.next != null && (typeof r.next !== 'string' || !LW.CURSOR.test(r.next) || !items.length || r.next !== items[items.length - 1].ts + ':' + items[items.length - 1].id)) throw lwErr('proto');
    return { items, next: r.next == null ? null : r.next, count: r.count };
  },
  // Manifest LENGKAP satu situs (semua halaman digabung): { id, rev, entry, files:[{p,size,hash}] } atau null (tidak ada / bukan untukku / diblokir, tak dibedakan).
  // Bila rev berubah di tengah jalan, diulang dari awal (maksimal 3 kali), lalu galat 'changed'.
  async webRemoteManifest(peerId, siteId, opts) {
    if (typeof siteId !== 'string' || !HEX16.test(siteId)) throw lwErr('bad');
    const signal = opts && opts.signal;
    for (let attempt = 0; attempt < 3; attempt++) {
      const files = [];
      let after = null, head = null, changed = false;
      for (;;) {
        const req = { t: 'lw_manifest', id: siteId };
        if (after != null) req.after = after;
        const r = await this._lwAskBusy(peerId, req, T_MAN, signal);
        if (r.m == null) { if (head === null) return null; changed = true; break; } // hilang / disembunyikan di tengah jalan
        const pg = wireManifestPage(r.m, siteId, after);
        if (!pg) throw lwErr('proto');
        if (head === null) head = { rev: pg.rev, entry: pg.entry };
        else if (pg.rev !== head.rev || pg.entry !== head.entry) { changed = true; break; }
        if (files.length + pg.files.length > MAX_FILES) throw lwErr('big');
        for (const f of pg.files) files.push(f);
        if (pg.next === null) break;
        after = pg.next;
      }
      if (!changed) return { id: siteId, rev: head.rev, entry: head.entry, files };
    }
    throw lwErr('changed');
  },
  // Satu potongan berkas: { total, off, buf } atau null (tidak ada / bukan untukku / diblokir / di luar berkas). len dipangkas pemilik ke LW_CHUNK.
  async webRemoteChunk(peerId, siteId, p, off, len, signal) {
    if (typeof siteId !== 'string' || !HEX16.test(siteId) || typeof p !== 'string' || tryRel(p) !== p || !Number.isSafeInteger(off) || off < 0 || !Number.isSafeInteger(len) || len < 1) throw lwErr('bad');
    const want = Math.min(len, LW.LW_CHUNK);
    const r = await this._lwAskBusy(peerId, { t: 'lw_file', id: siteId, p, off, len: want }, T_CHUNK, signal);
    const c = r.chunk;
    if (c == null) return null;
    if (typeof c !== 'object' || !Number.isSafeInteger(c.total) || c.total < 0 || c.off !== off || typeof c.b64 !== 'string' || c.b64.length > B64_MAX || !B64.test(c.b64)) throw lwErr('proto');
    const buf = Buffer.from(c.b64, 'base64');
    if (buf.length > want || off + buf.length > c.total) throw lwErr('proto');
    return { total: c.total, off, buf };
  },
  // Unduh satu berkas ke `dest` (jalur absolut; tulis atomik lewat .part lalu rename), diverifikasi ukuran + SHA-256 sesuai manifest.
  // expect = { size, hash } (dari manifest). opts.signal = AbortSignal. Mengembalikan jumlah byte. Gagal = galat 'gone' | 'changed' | 'hash' | ... dan tidak ada sisa berkas.
  async webRemoteFile(peerId, siteId, p, expect, dest, opts) {
    if (!expect || !Number.isSafeInteger(expect.size) || expect.size < 0 || typeof expect.hash !== 'string' || !H64.test(expect.hash) || typeof dest !== 'string' || !dest) throw lwErr('bad');
    const signal = opts && opts.signal, part = dest + '.part-' + crypto.randomBytes(4).toString('hex');
    const fh = await fs.promises.open(part, 'wx', 0o600);
    let done = false;
    try {
      const h = crypto.createHash('sha256');
      let off = 0;
      while (off < expect.size) {
        if (signal && signal.aborted) throw lwErr('cancel');
        const c = await this.webRemoteChunk(peerId, siteId, p, off, expect.size - off, signal);
        if (!c) throw lwErr('gone');
        if (c.total !== expect.size) throw lwErr('changed');
        if (!c.buf.length) throw lwErr('proto'); // tanpa kemajuan: jangan berputar selamanya
        await fh.write(c.buf, 0, c.buf.length, off);
        h.update(c.buf); off += c.buf.length;
      }
      if (h.digest('hex') !== expect.hash) throw lwErr('hash');
      await fh.close(); done = true;
      fs.renameSync(part, dest);
      return expect.size;
    } finally {
      if (!done) { try { await fh.close(); } catch {} }
      try { fs.rmSync(part, { force: true }); } catch {}
    }
  },
};

'use strict';
// src/core/archne-web-req.js — Situs PHP lewat jaringan (0.34.0 Fase P.5a): sisi PEMILIK dari lw_req. Situs PHP tidak disalin ke penonton; penonton mengirim PERMINTAAN HTTP, pemilik
// menjalankannya di mesin PHP-nya sendiri (router -> pool -> php-wasm) dan mengirim balik HASILNYA (status, header, badan). Kode .php dan data/ tidak pernah ikut.
// Meniru lw_*: tanda tangan (tag sendiri 'archne-lw2:'), nonce sekali pakai, pembatas laju per peer, dan "tidak ada" = "bukan untukmu" = "diblokir" = "mesin mati" (jawaban SAMA persis).
//
// Protokol (satu baris JSON per arah):
//   { t:'lw_req', id, method, path, query, hd:{nama:nilai}, bh, b64? } -> { t:'lw_req', ok:true, r: null | { status, headers:{nama:[nilai]}, b64 } }
//        bh = SHA-256 heks badan (kosong = hash byte kosong) ikut ditandatangani, jadi badan tidak bisa diganti di jalan. hd hanya header yang diizinkan (REQ_HDR); sisanya dibuang pemilik.
//        Host TIDAK PERNAH diteruskan: pemilik menetapkan host = id situs dan peer = id TERBUKTI dari tanda tangan ($_SERVER['ARCHNE_PEER']), penonton tidak bisa memalsukan keduanya.
//        r null = tidak ada / bukan untukmu / diblokir / bukan situs PHP / mesin PHP tidak ada. Jawaban terlalu besar = { ok:false, err:'big' }. Salah bentuk = 'bad', terlalu cepat / penuh = 'busy'.
//   P.5a: badan permintaan <= LW_REQ_IN dan balasan <= LW_REQ_OUT masuk satu baris.
//   P.5c: lebih besar lewat potongan. UNGGAH: { t:'lw_rup', id, up, off, bh (sha potongan), b64, hd:{} } -> { ok:true, n: panjang terkumpul | null }; lalu lw_req dengan `up` (tanpa b64) dan bh = sha SELURUH badan (dicek pemilik).
//   UNDUH: jawaban lw_req > LW_REQ_OUT -> r:{ status, headers, b64:'', tl, tok }; potongan diambil lewat { t:'lw_rbody', id, up:tok, off, len, hd:{} } -> { ok:true, c: null | { off, total, b64 } }.
//   Penampung sementara per peer (TTL, batas byte dan jumlah); token terikat ke id TERBUKTI peminta, jadi peer lain tidak bisa membacanya. Hanya batas pelindung, bukan batas produk.
const crypto = require('crypto');
const { HEX16 } = require('./archne-constants');
const { PG_SKEW } = require('../archne-pagestore');

const LW2TAG = 'archne-lw2:';
const LW_REQ_IN = 1024 * 1024, LW_REQ_OUT = 2 * 1024 * 1024; // byte badan (sebelum base64); baris jaringan maksimal 8 MB
const LW_REQ_RATE = 30, LW_REQ_WIN = 1000, LW_REQ_PEER = 2, LW_REQ_ALL = 8; // permintaan per jendela per peer; berjalan bersamaan per peer dan seluruhnya
const LW_REQ_SEEN_MAX = 20000;
const LW_BIG = 64 * 1024 * 1024, LW_PART = 512 * 1024; // badan/jawaban terbesar lewat potongan; byte per potongan
const LW_STASH_PEER = 128 * 1024 * 1024, LW_STASH_ALL = 256 * 1024 * 1024, LW_STASH_N = 6, LW_STASH_TTL = 120000; // penampung: byte per peer, byte seluruhnya, entri per peer, umur sejak sentuhan terakhir
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']), WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REQ_HDR = new Set(['accept', 'accept-language', 'content-type', 'cookie', 'if-none-match', 'if-modified-since', 'origin', 'range', 'referer', 'user-agent', 'x-requested-with']);
const RES_DROP = new Set(['x-powered-by', 'transfer-encoding', 'connection', 'keep-alive', 'content-length', 'server', 'proxy-authenticate', 'upgrade']);
const HDR_VAL_MAX = 8192, REQ_HDR_MAX = 16, RES_HDR_MAX = 64, PATH_MAX = 2048, QUERY_MAX = 4096;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/, H64 = /^[0-9a-f]{64}$/, METHOD_OK = /^[A-Z]{3,7}$/;
const BAD_URL = /[\x00-\x20\x7f\\#]/; // path dan query: tanpa kontrol, spasi, backslash, fragmen (spasi harus sudah %20)
const BAD_VAL = /[\x00-\x08\x0a-\x1f\x7f]/; // nilai header: tab boleh, CR/LF/NUL/kontrol lain tidak
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pubId = (pub) => crypto.createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16);
const nz = (v) => (v == null ? null : v);
const canonHd = (hd) => Object.keys(hd).sort().map((k) => [k, hd[k]]);
const canon = (o) => JSON.stringify([o.t, nz(o.id), nz(o.method), nz(o.path), nz(o.query), canonHd(o.hd), nz(o.bh), nz(o.up), nz(o.off), nz(o.len)]);

// Tanda tangan dibuat peminta; body dipakai hanya untuk menghitung bh bila bh belum diberikan.
function lwReqSign(privKey, ownerId, obj, now, nonce) {
  const o = Object.assign({}, obj, { ts: now == null ? Date.now() : now, n: nonce || crypto.randomBytes(8).toString('hex') });
  o.sig = crypto.sign(null, Buffer.from(LW2TAG + ownerId + ':' + o.ts + ':' + o.n + ':' + canon(o)), privKey).toString('base64');
  return o;
}
// { ok:true, rid, key } | { ok:false, err:'auth' | 'time' }. Bentuk dasar -> id cocok kunci -> tanda tangan -> jam; tidak bergantung pada relasi.
function lwReqVerify(o, ownerId, now) {
  const AUTH = { ok: false, err: 'auth' };
  try {
    const hi = o && o.hi;
    if (!hi || typeof hi.pub !== 'string' || hi.pub.length > 200 || typeof hi.id !== 'string' || !HEX16.test(hi.id) || pubId(hi.pub) !== hi.id) return AUTH;
    if (typeof o.sig !== 'string' || o.sig.length > 200 || typeof o.n !== 'string' || !HEX16.test(o.n) || !Number.isSafeInteger(o.ts)) return AUTH;
    if (!o.hd || typeof o.hd !== 'object' || Array.isArray(o.hd)) return AUTH;
    const key = crypto.createPublicKey({ key: Buffer.from(hi.pub, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, Buffer.from(LW2TAG + ownerId + ':' + o.ts + ':' + o.n + ':' + canon(o)), key, Buffer.from(o.sig, 'base64'))) return AUTH;
    if (Math.abs((now == null ? Date.now() : now) - o.ts) > PG_SKEW) return { ok: false, err: 'time' };
    return { ok: true, rid: hi.id, key: hi.id + ':' + o.n };
  } catch { return AUTH; }
}

// Bentuk permintaan -> { method, path, query, headers, body } bersih, atau null. Header di luar daftar izin dibuang diam-diam (Host, X-Forwarded-*, ARCHNE_PEER, Proxy, ...); nilai cacat = null.
function shapeReq(o) {
  if (typeof o.id !== 'string' || !HEX16.test(o.id)) return null;
  if (typeof o.method !== 'string' || !METHOD_OK.test(o.method) || !METHODS.has(o.method)) return null;
  if (typeof o.path !== 'string' || o.path[0] !== '/' || o.path[1] === '/' || o.path.length > PATH_MAX || BAD_URL.test(o.path)) return null;
  if (typeof o.query !== 'string' || o.query.length > QUERY_MAX || BAD_URL.test(o.query)) return null;
  if (typeof o.bh !== 'string' || !H64.test(o.bh)) return null;
  const names = Object.keys(o.hd);
  if (names.length > REQ_HDR_MAX) return null;
  const headers = {};
  for (const k of names) {
    const v = o.hd[k];
    if (typeof v !== 'string' || v.length > HDR_VAL_MAX || BAD_VAL.test(v) || k !== k.toLowerCase() || !/^[a-z0-9-]{1,64}$/.test(k)) return null;
    if (REQ_HDR.has(k)) headers[k] = v;
  }
  let body = Buffer.alloc(0);
  if (o.up != null) { // badan besar sudah diunggah per potongan: bh dicek pemilik terhadap hasil rakitan
    if (typeof o.up !== 'string' || !HEX16.test(o.up) || o.b64 != null || !WITH_BODY.has(o.method)) return null;
    return { method: o.method, path: o.path, query: o.query, headers, body, up: o.up };
  }
  if (o.b64 != null) {
    if (typeof o.b64 !== 'string' || o.b64.length > Math.ceil(LW_REQ_IN / 3) * 4 || !B64.test(o.b64) || !WITH_BODY.has(o.method)) return null;
    body = Buffer.from(o.b64, 'base64');
    if (body.length > LW_REQ_IN) return null;
  }
  if (sha(body) !== o.bh) return null;
  return { method: o.method, path: o.path, query: o.query, headers, body };
}
// Jawaban router -> bentuk kawat dengan header disaring, atau null bila badan terlalu besar.
function wireRes(r) {
  const status = r && Number.isInteger(r.status) && r.status >= 100 && r.status <= 599 ? r.status : 502;
  const body = r && Buffer.isBuffer(r.body) ? r.body : Buffer.from(r && r.body != null ? r.body : '');
  if (body.length > LW_REQ_OUT) return null;
  const headers = {};
  let n = 0;
  for (const [k0, v] of Object.entries((r && r.headers) || {})) {
    const k = String(k0).toLowerCase();
    if (RES_DROP.has(k) || !/^[a-z0-9-]{1,64}$/.test(k) || n >= RES_HDR_MAX) continue;
    const vals = (Array.isArray(v) ? v : [v]).map(String).filter((x) => x.length <= HDR_VAL_MAX && !BAD_VAL.test(x)).slice(0, 16);
    if (vals.length) { headers[k] = vals; n++; }
  }
  return { status, headers, b64: body.toString('base64') };
}

module.exports = {
  // Pemilik memasang penyedia router: fn(siteId) -> router (punya handle()) atau melempar. null = tanpa mesin PHP (lw_req dijawab "tidak ada"; caps 'lw2' tidak diumumkan).
  setPhpServe(fn) { this._phpServe = typeof fn === 'function' ? fn : null; },
  // Boleh dilihat peminta `rid` (id TERBUKTI)? Hanya situs PHP; aturan hubungan sama dengan lw_* (blokir > public > friends; private tidak pernah).
  _lwVisibleReq(site, rid) { return !!site && site.php === true && this._lwSeeRel(site, rid); },
  _lwReqGate(o) {
    const T = o && (o.t === 'lw_rup' || o.t === 'lw_rbody') ? o.t : 'lw_req';
    const v = lwReqVerify(o, this.id);
    if (!v.ok) return { t: T, ok: false, err: v.err };
    const now = Date.now(), seen = this._lwSeenQ || (this._lwSeenQ = new Map());
    if (seen.size) for (const [k, exp] of seen) { if (exp > now) break; seen.delete(k); }
    if (seen.has(v.key)) return { t: T, ok: false, err: 'auth' }; // putar ulang
    if (seen.size >= LW_REQ_SEEN_MAX) return { t: T, ok: false, err: 'busy' };
    seen.set(v.key, now + 2 * PG_SKEW + 1000);
    if (T === 'lw_rup') return this._lwUp(o, v.rid);
    if (T === 'lw_rbody') return this._lwBody(o, v.rid);
    return this._lwReqHandle(o, v.rid);
  },
  // Penampung sementara (unggahan 'u:' dan hasil 'd:'), kunci = jenis:peer:token. Yang kedaluwarsa dibuang setiap kali disentuh.
  _lwStash() {
    const m = this._lwSt || (this._lwSt = new Map()), now = Date.now();
    for (const [k, e] of m) if (e.exp <= now) m.delete(k);
    return m;
  },
  _lwStashRoom(rid, add) {
    let a = add, p = add, n = 0;
    for (const e of this._lwStash().values()) { a += e.len; if (e.rid === rid) { p += e.len; n++; } }
    return p <= LW_STASH_PEER && a <= LW_STASH_ALL && n < LW_STASH_N;
  },
  _lwStashPut(k, e) {
    e.exp = Date.now() + LW_STASH_TTL;
    this._lwStash().set(k, e);
    const t = setTimeout(() => this._lwStash(), LW_STASH_TTL + 1000); if (t.unref) t.unref(); // memori tidak tertahan bila tak ada yang menyentuh lagi
  },
  // Satu potongan badan permintaan. Berurutan (off harus = panjang terkumpul). Situs tidak terlihat = n:null (sama dengan tidak ada).
  async _lwUp(o, rid) {
    const bad = (e) => ({ t: 'lw_rup', ok: false, err: e });
    if (typeof o.id !== 'string' || !HEX16.test(o.id) || typeof o.up !== 'string' || !HEX16.test(o.up) || !Number.isSafeInteger(o.off) || o.off < 0) return bad('bad');
    if (typeof o.b64 !== 'string' || o.b64.length > Math.ceil(LW_PART / 3) * 4 || !B64.test(o.b64) || typeof o.bh !== 'string' || !H64.test(o.bh)) return bad('bad');
    const buf = Buffer.from(o.b64, 'base64');
    if (!buf.length || buf.length > LW_PART || o.off + buf.length > LW_BIG || sha(buf) !== o.bh) return bad('bad');
    if (!this._lwRate('q', rid, LW_REQ_RATE)) return bad('busy');
    const ws = this._lwServe(), site = ws && ws.has(o.id) ? ws.get(o.id) : null;
    if (!this._phpServe || !this._lwVisibleReq(site, rid)) return { t: 'lw_rup', ok: true, n: null };
    const m = this._lwStash(), k = 'u:' + rid + ':' + o.up;
    let e = m.get(k);
    if (!e) {
      if (o.off !== 0) return bad('bad');
      if (!this._lwStashRoom(rid, buf.length)) return bad('busy');
      e = { rid, parts: [], len: 0 };
    } else if (o.off !== e.len) return bad('bad');
    else {
      let a = buf.length, p = buf.length;
      for (const x of m.values()) { a += x.len; if (x.rid === rid) p += x.len; }
      if (p > LW_STASH_PEER || a > LW_STASH_ALL) { m.delete(k); return bad('busy'); }
    }
    e.parts.push(buf); e.len += buf.length;
    this._lwStashPut(k, e);
    return { t: 'lw_rup', ok: true, n: e.len };
  },
  // Satu potongan hasil besar. Potongan terakhir melepas penampung. Token milik peer lain / kedaluwarsa / di luar = c:null.
  async _lwBody(o, rid) {
    const bad = (e) => ({ t: 'lw_rbody', ok: false, err: e });
    if (typeof o.up !== 'string' || !HEX16.test(o.up) || !Number.isSafeInteger(o.off) || o.off < 0 || !Number.isSafeInteger(o.len) || o.len < 1 || o.len > LW_PART) return bad('bad');
    if (!this._lwRate('q', rid, LW_REQ_RATE)) return bad('busy');
    const m = this._lwStash(), k = 'd:' + rid + ':' + o.up, e = m.get(k);
    if (!e || o.off >= e.len) return { t: 'lw_rbody', ok: true, c: null };
    const end = Math.min(e.len, o.off + o.len), b64 = e.body.subarray(o.off, end).toString('base64');
    if (end >= e.len) m.delete(k); else e.exp = Date.now() + LW_STASH_TTL;
    return { t: 'lw_rbody', ok: true, c: { off: o.off, total: e.len, b64 } };
  },
  // Selalu Promise. Urutan: bentuk -> laju -> keterlihatan -> slot -> router. Semua penolakan "tidak terlihat" = r:null yang sama.
  async _lwReqHandle(o, rid) {
    const none = { t: 'lw_req', ok: true, r: null };
    const q = shapeReq(o);
    if (!q) return { t: 'lw_req', ok: false, err: 'bad' };
    if (!this._lwRate('q', rid, LW_REQ_RATE)) return { t: 'lw_req', ok: false, err: 'busy' };
    const ws = this._lwServe();
    const site = ws && ws.has(o.id) ? ws.get(o.id) : null;
    if (!this._phpServe || !this._lwVisibleReq(site, rid)) return none;
    const busy = this._lwReqBusy || (this._lwReqBusy = new Map());
    if ((busy.get(rid) || 0) >= LW_REQ_PEER || (this._lwReqAll || 0) >= LW_REQ_ALL) return { t: 'lw_req', ok: false, err: 'busy' };
    busy.set(rid, (busy.get(rid) || 0) + 1); this._lwReqAll = (this._lwReqAll || 0) + 1;
    try {
      let res;
      if (q.up) { // badan besar yang sudah diunggah: rakit, cocokkan panjang + hash, lalu lepas penampung
        const m = this._lwStash(), k = 'u:' + rid + ':' + q.up, e = m.get(k);
        if (!e) return { t: 'lw_req', ok: false, err: 'bad' };
        m.delete(k);
        const body = Buffer.concat(e.parts, e.len);
        if (sha(body) !== o.bh) return { t: 'lw_req', ok: false, err: 'bad' };
        q.body = body;
      }
      try {
        const router = this._phpServe(site.id);
        res = await router.handle({ method: q.method, path: q.path, query: q.query, headers: q.headers, body: q.body, peer: rid, host: site.id });
      } catch (e) {
        if (e && (e.code === 'CLOSED')) return none; // mesin dimatikan: sama dengan tidak ada
        res = { status: 502, headers: { 'content-type': ['text/plain; charset=utf-8'] }, body: Buffer.from('Mesin PHP gagal') }; // pesan galat tidak keluar (bisa memuat jalur pemilik)
      }
      const w = wireRes(res);
      if (w) return { t: 'lw_req', ok: true, r: w };
      const rb = res && Buffer.isBuffer(res.body) ? res.body : Buffer.from(res && res.body != null ? res.body : '');
      if (rb.length > LW_BIG) return { t: 'lw_req', ok: false, err: 'big' };
      if (!this._lwStashRoom(rid, rb.length)) return { t: 'lw_req', ok: false, err: 'busy' };
      const head = wireRes(Object.assign({}, res, { body: Buffer.alloc(0) })), tok = crypto.randomBytes(8).toString('hex');
      this._lwStashPut('d:' + rid + ':' + tok, { rid, body: rb, len: rb.length });
      head.tl = rb.length; head.tok = tok; // b64 kosong: badan diambil per potongan (lw_rbody)
      return { t: 'lw_req', ok: true, r: head };
    } finally {
      const n = (busy.get(rid) || 1) - 1;
      if (n > 0) busy.set(rid, n); else busy.delete(rid);
      this._lwReqAll--;
    }
  },
};
// Non-enumerable: dipakai klien (P.5b) dan tes, tidak boleh ikut ter-mixin ke Core.prototype.
Object.defineProperty(module.exports, 'LWQ', { value: { LW2TAG, LW_BIG, LW_PART, LW_REQ_IN, LW_REQ_OUT, LW_REQ_RATE, LW_REQ_PEER, LW_REQ_ALL, REQ_HDR, METHODS, WITH_BODY, lwReqSign, lwReqVerify, shapeReq, wireRes, canon } });

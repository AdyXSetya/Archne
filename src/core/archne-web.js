'use strict';
// src/core/archne-web.js — Web Lokal (0.34.0 Fase C.1): sisi PEMILIK. Menyambungkan WebStore ke Core dan melayani lw_list / lw_manifest / lw_file dari peer. Meniru pola Halaman (archne-pages.js).
// Klien ada di archne-web-peer.js, cache penonton di archne-web-cache.js.
// Penyimpanan di <dataDir>/web (folder sendiri, bukan bagian store.json). Dibuat malas: Core yang tidak memakai Web Lokal tidak membuat folder apa pun, dan pertanyaan orang asing tidak membuatnya.
//
// Tanda tangan permintaan (sama seperti pg_*, tag sendiri): peminta menandatangani 'archne-lw1:' + id PEMILIK + ts + n + [t, after, limit, q, id, p, off, len] dengan kunci identitasnya.
//   Pemilik memeriksa: kunci di hello cocok dengan id, jam +-2 menit, tanda tangan sah, nonce belum dipakai. Gagal = { ok:false, err:'auth' | 'time' | 'busy' } yang tidak bergantung pada relasi (blokir / teman).
//   Nonce lw_file punya penampung sendiri (_lwSeenF): satu berkas besar = ribuan potongan, tidak boleh menghabiskan jatah lw_list / lw_manifest.
// Visibilitas (dibaca dari Core pada tiap permintaan, tanpa cache, jadi blokir dan putus teman berlaku seketika):
//   public = semua yang tidak diblokir; friends = hanya teman (fstate 'ok'); private = tidak pernah muncul di daftar maupun bisa diminta.
//   Situs yang tidak boleh dilihat peminta, situs yang tidak ada, peminta diblokir, dan pemilik tanpa situs/layanan mati menghasilkan jawaban YANG SAMA PERSIS (tak dibedakan).
//
// Protokol (satu baris JSON per arah):
//   { t:'lw_list', after?, limit?, q? } -> { t:'lw_list', ok:true, items:[{ id, domain, title, desc, tags, entry, rev, ts }], next, count }
//        terbaru dulu; after = kursor '<ts>:<id>' dari next; limit 1..50 (bawaan 20); q = pencarian sisi pemilik (judul, domain, deskripsi, kata kunci; <= 64 karakter); count = jumlah situs yang cocok dan terlihat.
//   { t:'lw_manifest', id, after? } -> { t:'lw_manifest', ok:true, m: null | { id, rev, entry, n, files:[{ p, size, hash }], next } }
//        berkas diurut menurut p (urutan kode UTF-16, sama di semua OS); satu halaman <= LW_MAN_FILES berkas atau ~LW_MAN_BYTES byte; after = p terakhir halaman sebelumnya; next = p terakhir bila masih ada lanjutan.
//        hash = SHA-256 heks isi berkas (di-cache menurut ukuran + mtime); n = jumlah berkas seluruh situs; rev = kunci cache penonton. m null = tidak ada / bukan untukmu / diblokir.
//   { t:'lw_file', id, p, off, len } -> { t:'lw_file', ok:true, chunk: null | { total, off, b64 } }  potongan <= LW_CHUNK byte (len dipangkas); null = tidak ada / bukan untukmu / diblokir / off di luar berkas.
//        Terlalu cepat (> LW_FILE_RATE potongan per detik per peer) = { ok:false, err:'busy' }.
//   Salah bentuk = { ok:false, err:'bad' }, DICEK SEBELUM relasi, jadi jawabannya sama untuk semua peminta.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { HEX16 } = require('./archne-constants');
const { coreRelation, PG_SKEW } = require('../archne-pagestore');
const { WebStore } = require('../archne-webstore');
const { tryRel } = require('../archne-webfiles');

const LWTAG = 'archne-lw1:';
const LW_CHUNK = 512 * 1024, LW_LIST_DEF = 20, LW_LIST_MAX = 50, LW_Q_MAX = 64;
const LW_MAN_FILES = 2000, LW_MAN_BYTES = 1e6; // satu halaman manifest: jumlah berkas dan byte JSON (baris jaringan maksimal 8 MB)
const LW_FILE_RATE = 48, LW_META_RATE = 20, LW_WIN = 1000; // per peer per jendela tetap (lw_file ~24 MB/dtk seperti pg_media)
const LW_SEEN_MAX = 20000, LW_SEEN_FILE_MAX = 100000; // nonce yang diingat; penuh = tolak 'busy', bukan membuang yang lama
const LW_HASH_MAX = 50000, LW_MAN_PAR = 2; // cache hash dan pembuatan manifest bersamaan paling banyak
const CURSOR = /^\d+:[0-9a-f]{16}$/;
const pubId = (pub) => crypto.createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16);
const nz = (v) => (v == null ? null : v);
const canon = (o) => JSON.stringify([o.t, nz(o.after), nz(o.limit), nz(o.q), nz(o.id), nz(o.p), nz(o.off), nz(o.len)]);

function lwSignReq(privKey, ownerId, obj, now, nonce) {
  const o = Object.assign({}, obj, { ts: now == null ? Date.now() : now, n: nonce || crypto.randomBytes(8).toString('hex') });
  o.sig = crypto.sign(null, Buffer.from(LWTAG + ownerId + ':' + o.ts + ':' + o.n + ':' + canon(o)), privKey).toString('base64');
  return o;
}
// { ok:true, rid, key } | { ok:false, err:'auth' | 'time' }. Urutan: bentuk -> id cocok kunci -> tanda tangan -> jam. Tidak bergantung pada relasi apa pun.
function lwVerifyReq(o, ownerId, now) {
  const AUTH = { ok: false, err: 'auth' };
  try {
    const hi = o && o.hi;
    if (!hi || typeof hi.pub !== 'string' || hi.pub.length > 200 || typeof hi.id !== 'string' || !HEX16.test(hi.id) || pubId(hi.pub) !== hi.id) return AUTH;
    if (typeof o.sig !== 'string' || o.sig.length > 200 || typeof o.n !== 'string' || !HEX16.test(o.n) || !Number.isSafeInteger(o.ts)) return AUTH;
    const key = crypto.createPublicKey({ key: Buffer.from(hi.pub, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, Buffer.from(LWTAG + ownerId + ':' + o.ts + ':' + o.n + ':' + canon(o)), key, Buffer.from(o.sig, 'base64'))) return AUTH;
    if (Math.abs((now == null ? Date.now() : now) - o.ts) > PG_SKEW) return { ok: false, err: 'time' };
    return { ok: true, rid: hi.id, key: hi.id + ':' + o.n };
  } catch { return AUTH; }
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const wireSite = (s) => ({ id: s.id, domain: s.domain, title: s.title, desc: s.desc, tags: s.tags.slice(), entry: s.entry, rev: s.rev, ts: s.ts, ...(s.php ? { php: true } : {}) }); // php:true = tanda saja; berkas/manifest situs PHP tetap tidak pernah keluar

module.exports = {
  _webDir() { return path.join(this.opts.dataDir, 'web'); },
  // Penyimpanan situs milik perangkat ini (dibuat malas). Dipakai pemilik sendiri (UI Fase D/E) dan penyaji.
  webStore() {
    if (!this._web) this._web = new WebStore(this._webDir());
    return this._web;
  },
  // Situs milik perangkat ini untuk UI pemilik (Fase D.4): metadata lengkap (termasuk priv) + n = jumlah berkas. Terbaru dulu. Tidak lewat penyaring peer, hanya dipanggil dari IPC lokal.
  webMine() {
    const ws = this.webStore();
    return ws.list().map((s) => { let n = 0; try { n = this._lwWalk(ws.files(s.id), '', []).length; } catch {} return Object.assign({}, s, { n }); });
  },
  // WebStore untuk MELAYANI peer jauh, atau null = "tidak ada": layanan dimatikan (pengaturan webServe === false) ATAU pemilik belum pernah memakai Web Lokal.
  _lwServe() {
    if (this._settings && this._settings.webServe === false) return null;
    return (this._web || fs.existsSync(this._webDir())) ? this.webStore() : null;
  },
  _lwSign(ownerId, obj) { return lwSignReq(this.privKey, String(ownerId), obj); },
  // Boleh dilihat peminta `rid` (id TERBUKTI)? Hanya public / friends; private tidak pernah.
  _lwVisible(site, rid) {
    if (!site || !rid) return false;
    if (site.php) return false; // situs PHP (Fase P.0): kodenya tidak boleh sampai ke peer lewat daftar/manifest/berkas; jalurnya lw_req (archne-web-req.js, P.5). Di sini tak terlihat = sama dengan "tidak ada"
    return this._lwSeeRel(site, rid);
  },
  // Aturan hubungan yang SAMA untuk lw_* dan lw_req: blokir > public > friends (teman / pemilik); private tidak pernah.
  _lwSeeRel(site, rid) {
    if (!site || !rid) return false;
    const rel = coreRelation(this)(rid);
    if (rel === 'blocked') return false;
    if (site.priv === 'public') return true;
    return site.priv === 'friends' && (rel === 'friend' || rel === 'owner');
  },
  _lwGate(o) {
    const v = lwVerifyReq(o, this.id);
    if (!v.ok) return { t: o.t, ok: false, err: v.err };
    const now = Date.now(), file = o.t === 'lw_file';
    const seen = file ? (this._lwSeenF || (this._lwSeenF = new Map())) : (this._lwSeen || (this._lwSeen = new Map()));
    if (seen.size) for (const [k, exp] of seen) { if (exp > now) break; seen.delete(k); } // Map berurutan menurut waktu masuk, kedaluwarsa seragam
    if (seen.has(v.key)) return { t: o.t, ok: false, err: 'auth' }; // putar ulang
    if (seen.size >= (file ? LW_SEEN_FILE_MAX : LW_SEEN_MAX)) return { t: o.t, ok: false, err: 'busy' };
    seen.set(v.key, now + 2 * PG_SKEW + 1000);
    return this._lwHandle(o, v.rid);
  },
  // Pembatas laju per peer (jendela tetap), terpisah untuk berkas dan metadata. Dihitung per id TERBUKTI dan sama untuk semua relasi.
  _lwRate(kind, rid, max) {
    const now = Date.now(), all = this._lwRates || (this._lwRates = new Map()), m = all.get(kind) || (all.set(kind, new Map()), all.get(kind));
    if (m.size > 2000) for (const [id, e] of m) if (now - e.t0 >= LW_WIN) m.delete(id);
    let e = m.get(rid);
    if (!e || now - e.t0 >= LW_WIN) { e = { t0: now, n: 0 }; m.set(rid, e); }
    return ++e.n <= max;
  },
  // Satu pintu bentuk permintaan; mengembalikan true bila bentuknya sah. Dicek SEBELUM relasi.
  _lwShapeOk(o) {
    const hex = (x) => typeof x === 'string' && HEX16.test(x), int = (x, min) => Number.isSafeInteger(x) && x >= min;
    if (o.t === 'lw_list') {
      if (o.after != null && !(typeof o.after === 'string' && CURSOR.test(o.after))) return false;
      if (o.q != null && !(typeof o.q === 'string' && o.q.length <= LW_Q_MAX)) return false;
      return o.limit == null || Number.isInteger(o.limit);
    }
    if (o.t === 'lw_manifest') return hex(o.id) && (o.after == null || (typeof o.after === 'string' && tryRel(o.after) === o.after));
    return hex(o.id) && typeof o.p === 'string' && tryRel(o.p) === o.p && int(o.off, 0) && int(o.len, 1);
  },
  // Selalu mengembalikan balasan (objek) atau Promise-nya (lw_manifest menghitung hash secara async).
  _lwHandle(o, rid) {
    if (!this._lwShapeOk(o)) return { t: o.t, ok: false, err: 'bad' };
    if (!this._lwRate(o.t === 'lw_file' ? 'f' : 'm', rid, o.t === 'lw_file' ? LW_FILE_RATE : LW_META_RATE)) return { t: o.t, ok: false, err: 'busy' };
    const ws = this._lwServe();
    if (o.t === 'lw_list') return this._lwList(o, rid, ws);
    const site = ws && ws.has(o.id) ? ws.get(o.id) : null;
    const vis = this._lwVisible(site, rid) ? site : null;
    if (o.t === 'lw_file') return this._lwFile(o, vis, ws);
    return this._lwManifest(o, vis, ws);
  },
  _lwList(o, rid, ws) {
    const empty = { t: 'lw_list', ok: true, items: [], next: null, count: 0 };
    if (!ws) return empty;
    const q = typeof o.q === 'string' ? o.q.normalize('NFC').toLowerCase().trim() : '';
    let rows = ws.list().filter((s) => this._lwVisible(s, rid) || (!!this._phpServe && this._lwVisibleReq(s, rid))); // situs PHP muncul (bertanda php:true) HANYA bila mesin PHP terpasang dan aturan hubungan lolos; isinya tetap lewat lw_req (P.5)
    if (q) rows = rows.filter((s) => [s.domain, s.title, s.desc].concat(s.tags).join('\n').toLowerCase().includes(q));
    const count = rows.length;
    if (o.after != null) { const ts = Number(o.after.split(':')[0]); rows = rows.filter((s) => s.ts < ts); } // ts unik per penyimpanan dan urut turun
    const limit = Math.min(LW_LIST_MAX, Math.max(1, Number.isInteger(o.limit) ? o.limit : LW_LIST_DEF));
    const more = rows.length > limit, items = rows.slice(0, limit).map(wireSite), last = items[items.length - 1];
    return { t: 'lw_list', ok: true, items, next: more ? last.ts + ':' + last.id : null, count };
  },
  // Daftar berkas www/ (relatif, '/'), tanpa symlink dan nama yang tak lolos aturan jalur (WebFiles.list menyaringnya). Diurut menurut p.
  _lwWalk(wf, rel, out) {
    for (const e of wf.list(rel)) {
      const p = rel ? rel + '/' + e.name : e.name;
      if (e.type === 'dir') this._lwWalk(wf, p, out);
      else out.push({ p: p.normalize('NFC'), size: e.size, mtime: e.mtime });
    }
    return out;
  },
  // Pratinjau pemilik (F.4): situs di perangkat ini dibuka di penampil yang SAMA dengan yang dipakai peer. Daftar berkasnya dari _lwWalk (pintu yang sama dengan lw_manifest: tanpa symlink, nama tak sah tidak ikut),
  // tetapi tanpa hash (tidak ada jaringan, tidak ada cache) dan tanpa mengecek visibilitas: situs privat tetap bisa dipratinjau pemilik. -> { rev, entry, files:[{ p, size }] } terurut menurut p, atau null (tidak ada).
  webOwnManifest(siteId) {
    if (typeof siteId !== 'string' || !HEX16.test(siteId)) return null;
    const ws = this.webStore();
    if (!ws.has(siteId)) return null;
    let all;
    try { all = this._lwWalk(ws.files(siteId), '', []); } catch { return null; }
    all.sort((a, b) => cmp(a.p, b.p));
    const cur = ws.get(siteId);
    return { rev: cur.rev, entry: cur.entry, files: all.map((f) => ({ p: f.p, size: f.size })) };
  },
  // Aliran baca satu berkas situs sendiri, rentang inklusif [start, end] (bawaan seluruh berkas). Lewat readRange (satu pintu dengan lw_file). null = tidak ada / ukuran berubah sejak manifest dibuat / rentang tak sah;
  // berkas yang berubah di tengah pembacaan memutus aliran (galat), bukan mengirim isi campuran.
  webOwnStream(siteId, p, size, start, end) {
    if (typeof siteId !== 'string' || !HEX16.test(siteId) || typeof p !== 'string' || tryRel(p) !== p || !Number.isSafeInteger(size) || size < 1) return null;
    const a = start === undefined ? 0 : start, b = end === undefined ? size - 1 : end;
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < a || b >= size) return null;
    const ws = this.webStore();
    if (!ws.has(siteId)) return null;
    const wf = ws.files(siteId);
    try { const st = wf.stat(p); if (!st || st.type !== 'file' || st.size !== size) return null; } catch { return null; }
    const CH = 256 * 1024;
    return Readable.from((function* () {
      for (let off = a; off <= b;) {
        const r = wf.readRange(p, off, Math.min(CH, b - off + 1));
        if (!r || r.total !== size || r.buf.length === 0) throw new Error('changed');
        yield r.buf; off += r.buf.length;
      }
    })());
  },
  async _lwManifest(o, site, ws) {
    const none = { t: 'lw_manifest', ok: true, m: null };
    if (!site) return none;
    if ((this._lwManBusy || 0) >= LW_MAN_PAR) return { t: 'lw_manifest', ok: false, err: 'busy' }; // hash berkas besar berat: paling banyak LW_MAN_PAR sekaligus
    this._lwManBusy = (this._lwManBusy || 0) + 1;
    try {
      const wf = ws.files(site.id), all = this._lwWalk(wf, '', []).sort((a, b) => cmp(a.p, b.p));
      const rest = o.after == null ? all : all.filter((f) => f.p > o.after);
      const cache = this._lwHash || (this._lwHash = new Map()), files = [];
      let bytes = 0, cut = false;
      for (const f of rest) {
        if (files.length >= LW_MAN_FILES || bytes >= LW_MAN_BYTES) { cut = true; break; }
        const key = site.id + '/' + f.p;
        let c = cache.get(key);
        if (!c || c.size !== f.size || c.mtime !== f.mtime) {
          let d; try { d = await wf.digest(f.p); } catch { continue; } // berkas hilang / berganti jenis selagi dihitung: lewati
          c = { size: d.size, mtime: d.mtime, hash: d.hash };
          if (cache.size >= LW_HASH_MAX) cache.delete(cache.keys().next().value);
          cache.delete(key); cache.set(key, c);
        }
        files.push({ p: f.p, size: c.size, hash: c.hash }); bytes += f.p.length + 100;
      }
      const cur = ws.has(site.id) ? ws.get(site.id) : null;
      if (!cur) return none; // dihapus selagi dihitung
      return { t: 'lw_manifest', ok: true, m: { id: site.id, rev: cur.rev, entry: cur.entry, n: all.length, files, next: cut && files.length ? files[files.length - 1].p : null } };
    } catch { return none; } finally { this._lwManBusy--; }
  },
  _lwFile(o, site, ws) {
    let chunk = null;
    if (site) {
      try {
        const r = ws.files(site.id).readRange(o.p, o.off, Math.min(o.len, LW_CHUNK));
        if (r) chunk = { total: r.total, off: r.off, b64: r.buf.toString('base64') };
      } catch {} // tidak ada / bukan berkas / symlink: sama dengan null
    }
    return { t: 'lw_file', ok: true, chunk };
  },
};
// Non-enumerable: konstanta ini dipakai archne-web-peer.js dan tes, tetapi tidak boleh ikut ter-mixin ke Core.prototype.
Object.defineProperty(module.exports, 'LW', { value: { LWTAG, LW_CHUNK, LW_LIST_DEF, LW_LIST_MAX, LW_MAN_FILES, LW_FILE_RATE, LW_META_RATE, CURSOR, lwSignReq, lwVerifyReq } });

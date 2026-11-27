'use strict';
// Web Lokal (Fase B.1): penyimpanan situs milik pemilik perangkat. Murni lokal: tanpa jaringan, tanpa UI, tidak menyentuh Core / store.json.
// Satu folder sendiri (dir), isinya:
//   index.json        = CACHE daftar situs { v, sites: [{ id, m, z, s }] } (m/z = mtime dan ukuran site.json saat dicatat). BUKAN sumber kebenaran: hilang / rusak / tertinggal -> dibangun ulang dari site.json saat dibuka.
//   <siteId>/         = 16 heks acak
//     site.json       = SUMBER KEBENARAN { v, id, domain, title, desc, tags[], priv, entry, ts, rev, php?, lim? }. php (boolean, bawaan false) = saklar Mesin PHP (0.34.0 Fase P.0); tidak ada = false. lim (objek, hanya kunci yang beda dari bawaan) = batas sumber daya PHP / cron situs ini (src/archne-weblimits.js); tidak ada = bawaan. Atomik (.tmp lalu rename), mode 0600.
//     www/            = isi situs (dikelola WebFiles; struktur folder bebas)
//     tmp/            = penampung tulis atomik WebFiles (satu volume dengan www/, tidak pernah dilayani)
//     data/           = (hanya situs PHP, dibuat saat dibutuhkan) SQLite dan sesi PHP; TIDAK pernah dilayani, tidak masuk manifest, tidak dikelola WebFiles
// Urutan aman terhadap crash: buat = folder + isi dulu, site.json TERAKHIR (titik komit); hapus = site.json DULU, baru folder. Folder tanpa site.json dirapikan saat dibuka.
//   domain = label tanpa ".archne" (lihat archne-webdomain.js), unik di penyimpanan ini
//   priv   = 'private' (bawaan: tidak pernah muncul di daftar maupun bisa diminta, sampai pemilik sengaja membukanya) | 'friends' | 'public'
//   ts     = waktu buat (ms), naik ketat per penyimpanan; rev = naik tiap perubahan metadata ATAU berkas (kunci cache penonton)
//   Jumlah situs, jumlah berkas, dan ukuran total TIDAK dibatasi (keputusan pemilik). Batas di bawah hanya untuk metadata yang nanti ikut terkirim di daftar peer (lw_list).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { ek } = require('./core/archne-ecode');
const { normDomain, tryDomain } = require('./archne-webdomain');
const { WebFiles, normRel, tryRel } = require('./archne-webfiles');
const L = require('./archne-weblimits');
const { starterHtml } = require('./archne-starter');

const WEB_PRIV = ['private', 'friends', 'public'];
const TITLE_MAX = 80, DESC_MAX = 300, TAGS_MAX = 10, TAG_MAX = 24;
const HEX16 = /^[0-9a-f]{16}$/;
const BAD = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const FLUSH_MS = 300;

const line = (s) => s.replace(BAD, ' ').replace(/\s+/g, ' ').trim();
function cleanTitle(s) {
  if (typeof s !== 'string') throw ek('e.lw.titleBad', null, 'Judul tidak valid (maksimal 80 karakter)', 'title');
  const t = line(s);
  if (t.length > TITLE_MAX) throw ek('e.lw.titleBad', null, 'Judul tidak valid (maksimal 80 karakter)', 'title');
  return t;
}
function cleanDesc(s) {
  if (typeof s !== 'string') throw ek('e.lw.descBad', null, 'Deskripsi tidak valid (maksimal 300 karakter)', 'desc');
  const t = line(s);
  if (t.length > DESC_MAX) throw ek('e.lw.descBad', null, 'Deskripsi tidak valid (maksimal 300 karakter)', 'desc');
  return t;
}
// tags: larik string atau satu string dipisah koma. Huruf kecil, unik, maksimal TAGS_MAX berisi TAG_MAX karakter.
function cleanTags(t) {
  const bad = () => ek('e.lw.tagsBad', null, 'Kata kunci tidak valid (maksimal 10, masing-masing 24 karakter)', 'tags');
  if (typeof t === 'string') t = t.split(',');
  if (!Array.isArray(t)) throw bad();
  const out = [];
  for (const x of t) {
    if (typeof x !== 'string') throw bad();
    const k = line(x).toLowerCase();
    if (!k) continue;
    if (k.length > TAG_MAX) throw bad();
    if (!out.includes(k)) out.push(k);
  }
  if (out.length > TAGS_MAX) throw bad();
  return out;
}
function cleanPhp(v) {
  if (typeof v !== 'boolean') throw ek('e.lw.phpBad', null, 'Pengaturan Mesin PHP tidak valid', 'php');
  return v;
}
function cleanPriv(p) {
  if (!WEB_PRIV.includes(p)) throw ek('e.lw.privBad', null, 'Visibilitas tidak valid', 'priv');
  return p;
}
// Baca dari disk: kembalikan situs bersih atau null (rusak / bukan milik folder ini). Tidak melempar.
function normSite(o, id) {
  try {
    if (!o || typeof o !== 'object' || o.v !== 1 || o.id !== id || !HEX16.test(o.id)) return null;
    const domain = tryDomain(o.domain);
    if (!domain || domain !== o.domain) return null;
    // Dari disk harus sudah BENTUK KANONIK (persis hasil create/update): metadata ini nanti dikirim ke peer, jadi berkas yang diubah tangan tidak boleh menyelundupkan karakter kontrol/bidi atau tag tidak bersih.
    if (typeof o.title !== 'string' || o.title.length > TITLE_MAX || line(o.title) !== o.title || typeof o.desc !== 'string' || o.desc.length > DESC_MAX || line(o.desc) !== o.desc) return null;
    if (!Array.isArray(o.tags)) return null;
    const tags = cleanTags(o.tags);
    if (JSON.stringify(tags) !== JSON.stringify(o.tags)) return null;
    if (!WEB_PRIV.includes(o.priv)) return null;
    const entry = tryRel(o.entry);
    if (!entry || entry !== o.entry) return null;
    if (!Number.isSafeInteger(o.ts) || o.ts <= 0 || !Number.isSafeInteger(o.rev) || o.rev < 1) return null;
    if (o.php !== undefined && typeof o.php !== 'boolean') return null;
    const lm = L.fromDisk(o.lim); if (!lm.ok) return null;
    return { v: 1, id, domain, title: o.title, desc: o.desc, tags, priv: o.priv, entry, ts: o.ts, rev: o.rev, ...(o.php === true ? { php: true } : {}), ...(lm.lim ? { lim: lm.lim } : {}) };
  } catch { return null; }
}
const clone = (s) => ({ ...s, tags: s.tags.slice(), ...(s.lim ? { lim: { ...s.lim } } : {}) });
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function writeAtomic(f, s, mode) {
  fs.writeFileSync(f + '.tmp', s, { mode });
  fs.renameSync(f + '.tmp', f);
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

class WebStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
    this._ts = 0; this._sites = new Map(); this._files = new Map(); this._timer = null; this._stamp = new Map();
    this._load();
  }
  _siteFile(id) { return path.join(this.dir, id, 'site.json'); }
  _need(id) {
    if (typeof id !== 'string' || !HEX16.test(id) || !this._sites.has(id)) throw ek('e.lw.siteNone', null, 'Situs tidak ditemukan', 'nosite');
    return this._sites.get(id);
  }
  _now() { let t = Date.now(); if (t <= this._ts) t = this._ts + 1; this._ts = t; return t; }
  // Muat dari disk. Folder (heks) tanpa site.json = sisa buat/hapus yang terputus -> dibuang. Indeks dipakai hanya bila stat site.json cocok.
  _load() {
    const idx = readJson(path.join(this.dir, 'index.json'));
    const cached = new Map();
    if (idx && idx.v === 1 && Array.isArray(idx.sites)) for (const e of idx.sites) if (e && typeof e.id === 'string') cached.set(e.id, e);
    let stale = cached.size > 0 ? false : true;
    const ids = new Set();
    for (const name of fs.readdirSync(this.dir)) {
      if (!HEX16.test(name)) continue;
      let st = null;
      try { st = fs.statSync(this._siteFile(name)); } catch {}
      if (!st) { try { fs.rmSync(path.join(this.dir, name), { recursive: true, force: true }); } catch {} continue; }
      ids.add(name);
      const c = cached.get(name);
      let site = c && c.m === st.mtimeMs && c.z === st.size ? normSite(c.s, name) : null;
      if (!site) { site = normSite(readJson(this._siteFile(name)), name); stale = true; }
      if (!site) continue; // site.json rusak: folder dibiarkan (jangan hapus data pengguna karena berkas metadata rusak), situs tidak tampil
      this._sites.set(name, site); this._stamp.set(name, { m: st.mtimeMs, z: st.size });
      if (site.ts > this._ts) this._ts = site.ts;
    }
    for (const id of cached.keys()) if (!ids.has(id)) stale = true;
    if (stale) this._saveIndex();
  }
  _saveIndex() {
    this._timer = null;
    const sites = [];
    for (const [id, s] of this._sites) {
      let st; try { st = fs.statSync(this._siteFile(id)); } catch { continue; }
      sites.push({ id, m: st.mtimeMs, z: st.size, s });
    }
    try { writeAtomic(path.join(this.dir, 'index.json'), JSON.stringify({ v: 1, sites }), 0o600); } catch {} // cache: gagal menulis bukan bencana
  }
  _dirty() { if (!this._timer) { this._timer = setTimeout(() => this._saveIndex(), FLUSH_MS); if (this._timer.unref) this._timer.unref(); } }
  flush() { if (this._timer) { clearTimeout(this._timer); } this._saveIndex(); }
  _commit(site) { writeAtomic(this._siteFile(site.id), JSON.stringify(site), 0o600); this._sites.set(site.id, site); this._dirty(); }
  _byDomain(d, exceptId) { for (const s of this._sites.values()) if (s.domain === d && s.id !== exceptId) return s; return null; }

  // o: { domain (wajib), title?, desc?, tags?, priv?, entry?, starter? }. Judul kosong = domain. starter:false = tanpa index.html contoh.
  create(o) {
    o = o || {};
    const domain = normDomain(o.domain);
    if (this._byDomain(domain)) throw ek('e.lw.domTaken', null, 'Domain sudah dipakai situs lain di perangkat ini', 'domdup');
    const title = o.title === undefined ? domain : (cleanTitle(o.title) || domain);
    const entry = o.entry === undefined ? 'index.html' : normRel(o.entry, false);
    const site = { v: 1, id: '', domain, title, desc: o.desc === undefined ? '' : cleanDesc(o.desc), tags: o.tags === undefined ? [] : cleanTags(o.tags), priv: o.priv === undefined ? 'private' : cleanPriv(o.priv), entry, ts: 0, rev: 1 };
    if (o.php !== undefined && cleanPhp(o.php)) site.php = true; // hanya ditulis bila true: situs statis tetap persis seperti sebelum Fase P
    if (o.lim !== undefined) { const lm = L.clean(o.lim); if (lm) site.lim = lm; } // hanya bila menyimpang dari bawaan
    let id;
    do { id = crypto.randomBytes(8).toString('hex'); } while (this._sites.has(id) || fs.existsSync(path.join(this.dir, id)));
    site.id = id; site.ts = this._now();
    const base = path.join(this.dir, id);
    try {
      fs.mkdirSync(path.join(base, 'www'), { recursive: true }); fs.mkdirSync(path.join(base, 'tmp'));
      if (site.php) fs.mkdirSync(path.join(base, 'data'));
      if (o.starter !== false && entry === 'index.html') {
        const wf = new WebFiles(path.join(base, 'www'), path.join(base, 'tmp'));
        wf.write('index.html', starterHtml({ title, domain, php: !!site.php }));
      }
      this._commit(site); // titik komit
    } catch (e) { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} this._sites.delete(id); throw e; }
    return clone(site);
  }
  has(id) { return typeof id === 'string' && this._sites.has(id); }
  get(id) { return clone(this._need(id)); }
  byDomain(domain) { const d = tryDomain(domain); const s = d && this._byDomain(d); return s ? clone(s) : null; }
  // Terbaru dulu.
  list() { return [...this._sites.values()].sort((a, b) => b.ts - a.ts).map(clone); }
  get size() { return this._sites.size; }
  // patch: subset dari domain, title, desc, tags, priv, entry. Tanpa perubahan nyata = tidak ada tulis dan rev tetap.
  update(id, patch) {
    const cur = this._need(id), p = patch || {}, nx = clone(cur);
    if (p.domain !== undefined) {
      nx.domain = normDomain(p.domain);
      if (this._byDomain(nx.domain, id)) throw ek('e.lw.domTaken', null, 'Domain sudah dipakai situs lain di perangkat ini', 'domdup');
    }
    if (p.title !== undefined) nx.title = cleanTitle(p.title) || nx.domain;
    if (p.desc !== undefined) nx.desc = cleanDesc(p.desc);
    if (p.tags !== undefined) nx.tags = cleanTags(p.tags);
    if (p.priv !== undefined) nx.priv = cleanPriv(p.priv);
    if (p.entry !== undefined) nx.entry = normRel(p.entry, false);
    if (p.php !== undefined) { if (cleanPhp(p.php)) nx.php = true; else delete nx.php; }
    if (p.lim !== undefined) { const lm = L.clean(p.lim); if (lm) nx.lim = lm; else delete nx.lim; } // null / {} / semua bawaan = kembali ke bawaan
    if (JSON.stringify(nx) === JSON.stringify(cur)) return clone(cur);
    if (nx.php) { try { fs.mkdirSync(path.join(this.dir, id, 'data'), { recursive: true }); } catch {} } // data/ siap sebelum situs menyala sebagai PHP (gagal = dibuat ulang oleh paths())
    nx.rev = cur.rev + 1;
    this._commit(nx);
    return clone(nx);
  }
  // Jalur disk untuk mesin PHP (P.0/P.2): www/ (kode), data/ (SQLite + sesi, tidak pernah dilayani), tmp/. Hanya untuk proses utama pemilik; TIDAK PERNAH dikirim ke renderer atau peer.
  // data/ dibuat bila belum ada. Melempar bila situs tidak ada atau bukan situs PHP.
  paths(id) {
    const s = this._need(id);
    if (!s.php) throw ek('e.lw.phpOff', null, 'Mesin PHP tidak menyala untuk situs ini', 'phpoff');
    const base = path.join(this.dir, id), r = { www: path.join(base, 'www'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp') };
    for (const d of [r.www, r.data, r.tmp]) fs.mkdirSync(d, { recursive: true });
    return r;
  }
  // Batas sumber daya situs (lengkap, bawaan terisi). Dipakai host PHP / cron; tidak melempar bila situs ada.
  limits(id) { return L.resolve(this._need(id).lim); }
  limitsRaw(id) { const s = this._need(id); return s.lim ? { ...s.lim } : null; }
  // Naikkan rev (dipanggil WebFiles tiap perubahan berkas).
  bump(id) { const cur = this._need(id); const nx = clone(cur); nx.rev = cur.rev + 1; this._commit(nx); return nx.rev; }
  // Pengelola berkas situs; tiap perubahan berhasil menaikkan rev.
  files(id) {
    this._need(id);
    let f = this._files.get(id);
    if (!f) {
      const base = path.join(this.dir, id);
      f = new WebFiles(path.join(base, 'www'), path.join(base, 'tmp'), () => { if (this._sites.has(id)) this.bump(id); });
      this._files.set(id, f);
    }
    return f;
  }
  // Hapus situs beserta seluruh berkasnya.
  remove(id) {
    this._need(id);
    fs.rmSync(this._siteFile(id), { force: true }); // titik komit hapus: setelah ini situs sudah "tidak ada" walau proses mati
    this._sites.delete(id); this._files.delete(id);
    try { fs.rmSync(path.join(this.dir, id), { recursive: true, force: true }); } catch {} // sisa (bila gagal) dibuang saat dibuka berikutnya
    this._dirty();
    return true;
  }
  // Jalur www/ absolut: HANYA untuk Core (pelayan berkas di fase berikutnya). Jangan pernah dikirim ke renderer atau peer.
  wwwDir(id) { this._need(id); return path.join(this.dir, id, 'www'); }
}

module.exports = { WebStore, normSite, WEB_PRIV, TITLE_MAX, DESC_MAX, TAGS_MAX, TAG_MAX };

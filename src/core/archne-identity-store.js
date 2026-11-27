'use strict';
// src/core/archne-identity-store.js — identitas, kunci, _open/_makeMsg, muat/simpan/migrasi store, jam HLC
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Vc = require('../archne-vchan');
const { CALL_CID, CALL_LOG_MAX, CALL_MAX_PEERS, CALL_OUT, HEX16, HEX32, HLC_DRIFT, XTAG, canon, custClass } = require('./archne-constants');

// v0.22.0: penyimpanan dipisah. primary.json = data PRIMER yang kecil dan mutlak (profil, tanda terima, titipan state/sematan/kontrol) + cadangan .bak;
// titipan SUB (DM, pesan grup) = satu berkas per pesan di custody/<2 hex>/<id>.json (v0.22.1, bersegmen: simpan hanya menulis yang baru/dibuang,
// tidak menulis ulang semuanya; custody.json lama dimigrasi otomatis); store.json = sisanya. Dalam memori tetap satu `this.store` (profiles, receipts, custody).
const readJson = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } };
const writeJson = (f, obj, bak) => {
  const s = JSON.stringify(obj);
  fs.writeFileSync(f + '.tmp', s, { mode: 0o600 }); // data obrolan: hanya pemilik akun OS yang boleh membaca (diabaikan di Windows)
  if (bak) { try { fs.copyFileSync(f, f + '.bak'); } catch {} } // salinan versi sebelumnya: primer rusak tidak boleh berarti hilang
  fs.renameSync(f + '.tmp', f);
};
const { aeadOpen, aeadSeal, idFromPub, msgId } = require('./archne-util');

const segPath = (dir, id) => path.join(dir, id.slice(0, 2), id + '.json');

module.exports = {
  _loadIdentity() {
    const f = path.join(this.opts.dataDir, 'identity.json');
    let j, raw = null;
    try { raw = fs.readFileSync(f, 'utf8'); } catch {}
    if (raw !== null) {
      try { j = JSON.parse(raw); } catch {}
      if (!j || typeof j.priv !== 'string' || typeof j.pub !== 'string') {
        // identity.json ada tetapi rusak (mis. mati listrik saat menulis): JANGAN diam-diam diganti identitas baru (kunci lama hilang selamanya). Simpan dulu sebagai berkas .corrupt.
        j = null;
        try { fs.renameSync(f, f + '.corrupt-' + Date.now()); if (this.log) this.log('identity.json rusak: disimpan sebagai .corrupt-*, identitas baru dibuat'); } catch {}
      }
    }
    this._idFresh = !j; // true = identitas baru dibuat pada start ini (dicatat di log "core start": id yang berganti tiap start berarti identity.json tidak terbaca)
    if (!j) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      j = {
        pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      };
    }
    if (!j.xpriv) {
      const x = crypto.generateKeyPairSync('x25519');
      j.xpub = x.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      j.xpriv = x.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(j), { mode: 0o600 });
      fs.renameSync(tmp, f); // atomik: tidak pernah ada identity.json setengah tertulis
    }
    if (process.platform !== 'win32') { try { fs.chmodSync(f, 0o600); } catch {} } // berkas lama yang terlanjur dibuat longgar
    this.pub = j.pub;
    this.privKey = crypto.createPrivateKey({ key: Buffer.from(j.priv, 'base64'), format: 'der', type: 'pkcs8' });
    this.id = idFromPub(this.pub);
    this.xpub = j.xpub;
    this.xpriv = crypto.createPrivateKey({ key: Buffer.from(j.xpriv, 'base64'), format: 'der', type: 'pkcs8' });
    this.xsig = crypto.sign(null, Buffer.from(XTAG + this.xpub), this.privKey).toString('base64');
  },
  _pairKey(id) {
    const p = this.peers.get(id);
    if (!p || !p.xpub) return null;
    const c = this._pk.get(id);
    if (c && c.xpub === p.xpub) return c.key;
    const pub = crypto.createPublicKey({ key: Buffer.from(p.xpub, 'base64'), format: 'der', type: 'spki' });
    const secret = crypto.diffieHellman({ privateKey: this.xpriv, publicKey: pub });
    const [a, b] = [this.id, id].sort();
    const key = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from('archne-v1'), Buffer.from(a + b), 32));
    this._pk.set(id, { xpub: p.xpub, key });
    return key;
  },
  _aad(m) { return Buffer.from(JSON.stringify([m.from, m.to, m.ts, m.kind || ''].concat(m.ep !== undefined ? [m.ep] : []))); },
  _keyFor(m) {
    if (m.kind === 'g1') {
      const g = this.store.groups[m.to.slice(2)], e = g && g.eps[m.ep || 0];
      return e ? Buffer.from(e.key, 'base64') : null;
    }
    return this._pairKey(m.from === this.id ? m.to : m.from);
  },
  _open(m) {
    if (!m.kind) return m.text;
    if (this._plain.has(m.id)) return this._plain.get(m.id);
    try {
      const key = this._keyFor(m);
      if (!key) return null;
      let t;
      try { t = aeadOpen(key, this._aad(m), m.text); } catch (e) {
        // dua admin membuat epoch yang sama bersamaan: kunci yang kalah disimpan di `alt` supaya pesannya tetap terbaca
        const g = m.kind === 'g1' ? this.store.groups[m.to.slice(2)] : null, ex = g && g.eps[m.ep || 0];
        for (const k of (ex && ex.alt) || []) { try { t = aeadOpen(Buffer.from(k, 'base64'), this._aad(m), m.text); break; } catch {} }
        if (t === undefined) throw e;
      }
      if (this._plain.size > 5000) this._plain.clear();
      this._plain.set(m.id, t);
      return t;
    } catch { return null; }
  },
  _makeMsg(to, kind, plain, ep, pc) {
    const m = { from: this.id, to, ts: this._tsNow(), text: '' };
    if (kind) {
      m.kind = kind;
      if (kind === 'g1') {
        const g = this.store.groups[to.slice(2)];
        const e = ep !== undefined ? ep : (g ? g.epoch : 0);
        if (e > 0) m.ep = e;
      }
      if (pc) m.pc = 1; // primer (v0.22.0): ikut ditandatangani, dibaca kurir non-anggota
      const key = this._keyFor(m);
      if (!key) throw new Error('Kunci enkripsi belum tersedia (peer versi lama atau belum terlihat)');
      m.text = aeadSeal(key, this._aad(m), plain);
    } else m.text = plain;
    m.id = msgId(m);
    m.sig = crypto.sign(null, Buffer.from(canon(m)), this.privKey).toString('base64');
    m.pub = this.pub;
    m.name = this.name;
    return m;
  },
  _loadStore() {
    this.storeFile = path.join(this.opts.dataDir, 'store.json');
    this.primFile = path.join(this.opts.dataDir, 'primary.json'); this.custFile = path.join(this.opts.dataDir, 'custody.json'); // custFile = format lama (< 0.22.1), hanya dibaca untuk migrasi
    this.custDir = path.join(this.opts.dataDir, 'custody');
    const old = readJson(this.storeFile);
    if (old) Object.assign(this.store, old); // store lama (<0.22.0) masih memuat profiles/receipts/custody: dipakai sebagai dasar
    this._wanLoad(); // konfigurasi TURN tersimpan (lintas jaringan)
    const prim = readJson(this.primFile) || readJson(this.primFile + '.bak') || {}, sub = readJson(this.custFile) || {};
    const seg = this._readSegments();
    this._custDisk = new Set(Object.keys(seg)); // id yang SUDAH ada di disk sebagai segmen; sisanya (mis. dari custody.json lama) ditulis pada simpan berikutnya
    for (const k of ['profiles', 'receipts']) if (prim[k] && typeof prim[k] === 'object') this.store[k] = Object.assign({}, this.store[k], prim[k]);
    this.store.custody = Object.assign({}, this.store.custody, prim.custody, sub.custody, seg);
    this._migrate();
    this._custInstall(); // penghitung byte titipan (Step 2c)
    this._pqRebuild(); // penghitung pesan publik orang lain (Step 2d)
    const h = this.store.hlc; // jam HLC bertahan lewat restart; nilai yang tidak masuk akal diabaikan
    this.hlc = Number.isSafeInteger(h) && h > 0 && h <= this._wall() + HLC_DRIFT ? h : 0;
    this.name = this.store.name || this.opts.name;
    for (const p of Object.values(this.store.peers)) this.peers.set(p.id, Object.assign({}, p, { lastSeen: 0 }));
    // store lama (v0.3.0) menyimpan grup yang sudah dikeluarkan; sekarang grup seperti itu dihapus
    for (const g of Object.values(this.store.groups)) if (g.removed) this._purgeGroup(g, g.epoch);
    this._pvRebuild();
  },
  // Format v0.2.0: grup hanya punya satu `key`. Jadi epoch 0.
  _migrate() {
    if (!Array.isArray(this.store.notes)) this.store.notes = [];
    if (!this.store.notif || typeof this.store.notif !== 'object' || Array.isArray(this.store.notif)) this.store.notif = {};
    if (!this.store.hidden || typeof this.store.hidden !== 'object') this.store.hidden = {};
    if (!this.store.left || typeof this.store.left !== 'object') this.store.left = {};
    if (!this.store.deleted || typeof this.store.deleted !== 'object') this.store.deleted = {};
    if (!this.store.custody || typeof this.store.custody !== 'object') this.store.custody = {};
    if (!this.store.receipts || typeof this.store.receipts !== 'object') this.store.receipts = {};
    if (!this.store.esc || typeof this.store.esc !== 'object') this.store.esc = {};
    if (!this.store.seeds || typeof this.store.seeds !== 'object') this.store.seeds = {};
    if (!this.store.revokes || typeof this.store.revokes !== 'object') this.store.revokes = {};
    if (!this.store.freceipts || typeof this.store.freceipts !== 'object') this.store.freceipts = {};
    if (!this.store.rx || typeof this.store.rx !== 'object') this.store.rx = {};
    if (!this.store.files || typeof this.store.files !== 'object') this.store.files = {};
    if (!this.store.got || typeof this.store.got !== 'object') this.store.got = {};
    if (!this.store.profiles || typeof this.store.profiles !== 'object') this.store.profiles = {};
    if (!this.store.friends || typeof this.store.friends !== 'object') this.store.friends = {};
    if (!this.store.blocked || typeof this.store.blocked !== 'object') this.store.blocked = {};
    if (!this.store.pvm || typeof this.store.pvm !== 'object' || Array.isArray(this.store.pvm)) this.store.pvm = {};
    this._pinMigrate();
    this._rxMigrate(); // reaksi (v0.24.0)
    this.store.calls = (Array.isArray(this.store.calls) ? this.store.calls : []).filter((r) => r && typeof r === 'object' && CALL_CID.test(String(r.id)) && HEX16.test(String(r.peer)) && (r.dir === 'in' || r.dir === 'out') && CALL_OUT.has(r.out) && Number.isFinite(r.at)).slice(-CALL_LOG_MAX);
    for (const r of this.store.calls) {
      if (r.video) r.video = 1; else delete r.video;
      if (r.group) {
        r.group = 1;
        r.members = (Array.isArray(r.members) ? r.members : []).filter((x) => x && HEX16.test(String(x.id))).slice(0, CALL_MAX_PEERS).map((x) => ({ id: String(x.id), name: String(x.name || '?').slice(0, 32) }));
        r.hcs = (Array.isArray(r.hcs) ? r.hcs : []).filter((x) => HEX16.test(String(x))).slice(0, CALL_MAX_PEERS);
      } else { delete r.group; delete r.members; delete r.hcs; }
    }
    // v0.7.3 menyimpan teman satu arah ({ at, name }). Sekarang pertemanan harus disetujui kedua pihak: entri lama jadi permintaan terkirim ('out'),
    // permintaannya dikirim begitu kuncinya tersedia (mig = belum terkirim).
    for (const [k, r] of Object.entries(this.store.friends)) {
      if (!r || typeof r !== 'object' || !HEX16.test(k)) { delete this.store.friends[k]; continue; }
      if (typeof r.st !== 'string') { r.st = 'out'; r.rts = 0; r.mig = true; }
    }
    for (const g of Object.values(this.store.groups)) {
      if (!g.eps) { g.eps = { 0: { key: g.key, members: g.members.map((x) => x.id) } }; delete g.key; }
      if (!Number.isInteger(g.epoch)) g.epoch = 0;
      if (typeof g.removed !== 'boolean') g.removed = false;
      // v0.8.0: peran. Grup lama hanya punya pembuat; admin = anggota yang ditunjuk pembuat.
      const ids = (g.members || []).map((x) => x.id);
      g.admins = Array.isArray(g.admins) ? [...new Set(g.admins.filter((x) => ids.includes(x) && x !== g.creator))] : [];
      // v0.9.0: anggota yang sudah menyatakan keluar tapi belum dikeluarkan dari daftar (bukti tanda tangannya disimpan)
      if (!g.leaves || typeof g.leaves !== 'object' || Array.isArray(g.leaves)) g.leaves = {};
      for (const k of Object.keys(g.leaves)) if (!ids.includes(k)) delete g.leaves[k];
      g.vch = Vc.clean(g.vch, g); // v0.19.0: channel voice grup
    }
  },
  // ---- Hybrid logical clock ----
  _wall() { return this.opts.now ? this.opts.now() : Date.now(); },
  // ts baru: jam dinding, tapi tidak pernah mundur atau sama dengan ts yang pernah dikirim/dilihat.
  _tsNow() {
    const t = Math.max(this._wall(), this.hlc + 1);
    this.hlc = t; this._save();
    return t;
  },
  // Pesan yang sah dari peer lain memajukan jam kita (jadi balasan selalu lebih baru dari yang dibalas),
  // kecuali ts-nya melompat jauh ke depan, supaya satu PC dengan jam ngawur tidak merusak urutan semua orang.
  _tsSeen(ts) {
    if (Number.isSafeInteger(ts) && ts > this.hlc && ts <= this._wall() + HLC_DRIFT) { this.hlc = ts; this._save(); }
  },
  // Waktu yang ditampilkan/diurutkan: ts pesan, kecuali ts-nya jauh di masa depan, maka pakai waktu kedatangan.
  _dts(m) { const rx = this.store.rx[m.id]; return rx && rx < m.ts ? rx : m.ts; },
  // Catatan grup. Disimpan sebagai kunci kamus + parameter (nk/np) supaya riwayat ikut berganti bahasa saat getState();
  // `text` = kalimat Indonesia jadi (cadangan, dan satu-satunya isi untuk catatan lama sebelum i18n). Tanpa kunci: _note(gid, teks).
  _note(gid, nk, np, idMsg) {
    const n = this.store.notes;
    const e = { id: crypto.randomBytes(6).toString('hex'), to: 'g:' + gid, ts: this._tsNow(), text: nk };
    if (idMsg !== undefined) { e.text = String(idMsg).replace(/\{(\w+)\}/g, (m, k) => (np && k in np ? String(np[k]) : m)); e.nk = nk; e.np = np; }
    n.push(e);
    if (n.length > 300) n.splice(0, n.length - 300);
  },
  _save() {
    if (this._st) return;
    this._st = setTimeout(() => { this._st = null; this._saveNow(); }, 300);
  },
  // Sinkronkan segmen di disk dengan titipan sub di memori: tulis yang baru, hapus yang sudah tidak ada. Entri titipan tidak pernah diubah isinya
  // (hanya ditambah/dibuang), jadi cukup membandingkan himpunan id. Kegagalan satu berkas tidak menghentikan simpan; diulang pada simpan berikutnya.
  _saveSegments(sub) {
    if (!this._custDisk) this._custDisk = new Set();
    let fail = 0;
    for (const [id, c] of Object.entries(sub)) {
      if (this._custDisk.has(id)) continue;
      if (!HEX32.test(id)) continue; // id tidak sah tidak dijadikan nama berkas (hanya di memori)
      try {
        this._writeSeg(id, c);
        this._custDisk.add(id);
        this._custLazy(id, c); // sudah aman di disk: buang isi beratnya dari RAM
      } catch (e) { fail++; this.log('segmen titipan gagal ditulis ' + id + ': ' + e.message); }
    }
    for (const id of [...this._custDisk]) {
      if (Object.prototype.hasOwnProperty.call(sub, id)) continue;
      try { fs.unlinkSync(segPath(this.custDir, id)); } catch (e) { if (e.code !== 'ENOENT') { fail++; continue; } }
      this._custDisk.delete(id);
    }
    if (!fail) { try { fs.unlinkSync(this.custFile); } catch {} try { fs.unlinkSync(this.custFile + '.tmp'); } catch {} } // migrasi selesai: format lama dibuang hanya setelah semua segmen tertulis
  },
  _saveNow() {
    try {
      this.store.name = this.name;
      this.store.hlc = this.hlc;
      this.store.peers = Object.fromEntries(this.peers);
      const S = this.store, prim = { profiles: S.profiles, receipts: S.receipts, custody: {} }, sub = { custody: {} };
      for (const [id, c] of Object.entries(S.custody)) (custClass(c.m) === 'state' ? prim.custody : sub.custody)[id] = c;
      const rest = Object.assign({}, S); delete rest.custody; delete rest.profiles; delete rest.receipts;
      writeJson(this.primFile, prim, true); // primer dulu
      this._saveSegments(sub.custody);
      writeJson(this.storeFile, rest);
    } catch (e) { this.log('save error ' + e.message); }
  },
};

'use strict';
// src/core/archne-settings.js — pengaturan kuota oleh pengguna (v0.22.1, Step 2e): settings.json, batas minimum, opsi tanpa batas, penegakan saat kuota diturunkan.
// Tiga pengaturan, semuanya dalam BYTE (bilangan bulat) atau 'unlimited':
//   cust    kuota titipan pesan DM dan pesan grup (masing-masing punya kuota sendiri sebesar nilai ini). Minimum 10 MB.
//   files   kuota titipan berkas: kolam kurir DM, publik, grup, dan salinan seed (masing-masing sebesar nilai ini). Minimum 100 MB.
//   pubMsgs kuota riwayat pesan publik milik orang lain (archne-pubmsg-store.js). Minimum 5 MB.
// v0.23.1: `escMax` = batas ukuran satu berkas yang boleh dititipkan ke kurir (bawaan 10 MB, 0 = mati, maksimal 100 MB, TIDAK ada 'unlimited'; kode galat 'max' bila lebih),
// dan `theme` = 'system' | 'dark' | 'light' (tampilan; bukan kuota, tidak lewat SPEC).
// i18n (A2): `lang` = 'en' | 'id' (bahasa UI; bawaan 'en' = kuncinya tidak ada; getSettings().lang selalu terisi; bukan kuota, tidak lewat SPEC).
// Tidak ada kunci = bawaan. Nilai di settings.json yang tidak sah dibuang, yang di bawah minimum dinaikkan ke minimum (berkas bisa diedit tangan).
// Pengaturan diterapkan dengan menimpa opts (custDmQuota, escQuota, ...); nilai asal dari konstruktor (tes) dipulihkan bila pengaturan dikembalikan ke bawaan.
// Batas per pengirim tidak ikut berubah (konstanta, atau pecahan kuota untuk titipan pesan), jadi 'unlimited' tidak membuka pintu bagi satu identitas.
const fs = require('fs');
const path = require('path');
const { AUTO_IMG_MAX, CUST_DM_QUOTA, CUST_GMSG_QUOTA, ESC_MAX_CEIL, ESC_MAX_DEF, ESC_QUOTA, PG_VSTREAM_LIM, PUBMSG_QUOTA, SEED_QUOTA, custClass } = require('./archne-constants');

const MB = 1048576;
const SPEC = {
  cust: { min: 10 * MB, def: CUST_DM_QUOTA, opts: ['custDmQuota', 'custGmsgQuota'] },
  files: { min: 100 * MB, def: ESC_QUOTA, opts: ['escQuota', 'pubQuota', 'grpQuota', 'seedQuota'] },
  pubMsgs: { min: 5 * MB, def: PUBMSG_QUOTA, opts: ['pubMsgQuota'] },
  // v0.23.1 (hemat relay): batas ukuran satu berkas yang boleh DITITIPKAN ke kurir (psize). 0 = mati, maksimal 100 MB, TANPA opsi 'unlimited' (lihat archne-relay-policy.js).
  escMax: { min: 0, max: ESC_MAX_CEIL, def: ESC_MAX_DEF, opts: ['escMaxBytes'] },
};
const LANGS = ['en', 'id']; // bahasa UI (i18n A2): 'en' bawaan (kuncinya tidak ada di settings.json), 'id' = Bahasa Indonesia; kunci `lang`, bukan kuota
const THEMES = ['system', 'dark', 'light']; // tampilan: ikut sistem (bawaan), gelap, terang; disimpan di settings.json (kunci `theme`), bukan kuota
const UNL = 'unlimited';
const PGS = Object.keys(PG_VSTREAM_LIM); // 5a-2: pgStreamMax / pgStreamPeer (bilangan bulat dalam [min, maks]; bukan kuota, tidak lewat SPEC)
const pgsOk = (k, v) => Number.isSafeInteger(v) && v >= PG_VSTREAM_LIM[k][0] && v <= PG_VSTREAM_LIM[k][2];
// 5a-1: `pagesServe` = false menonaktifkan layanan Halaman ke peer lain (bukan kuota, tidak lewat SPEC; lihat _pgServePs di archne-pages.js).
// v0.24.0: `directDir` = folder tujuan Kirim Langsung (string path absolut; bukan kuota, tidak lewat SPEC). Tidak ada kunci = <folder unduhan>/file_transfer.
// Hanya dipakai untuk tawaran yang diterima SETELAH diubah; sesi yang sudah berjalan tetap di foldernya (s.dir).
const dirOk = (v) => typeof v === 'string' && v.length > 0 && v.length <= 1024 && v.indexOf('\0') < 0 && path.isAbsolute(v);
// Nilai dari berkas: sah -> nilai (dinaikkan ke minimum bila kurang), tidak sah -> undefined.
const lenient = (k, v) => {
  const sp = SPEC[k];
  if (v === UNL) return sp.max === undefined ? UNL : undefined; // kunci bermaksimum tidak mengenal 'unlimited'
  if (!Number.isSafeInteger(v) || v < 0 || (v === 0 && sp.min !== 0)) return undefined;
  const r = Math.max(v, sp.min);
  return sp.max === undefined ? r : Math.min(r, sp.max);
};
const jsonQ = (q) => (Number.isFinite(q) ? q : UNL); // Infinity tidak lolos JSON (jadi null): pakai 'unlimited'

module.exports = {
  _settingsFile() { return path.join(this.opts.dataDir, 'settings.json'); },
  _loadSettings() {
    let j = null;
    for (const f of [this._settingsFile(), this._settingsFile() + '.bak']) {
      try { const x = JSON.parse(fs.readFileSync(f, 'utf8')); if (x && typeof x === 'object' && !Array.isArray(x)) { j = x; break; } } catch {}
    }
    const S = {};
    if (j) for (const k of Object.keys(SPEC)) { if (!(k in j)) continue; const v = lenient(k, j[k]); if (v === undefined) this.log('settings: ' + k + ' tidak sah, pakai bawaan'); else S[k] = v; }
    if (j && THEMES.includes(j.theme) && j.theme !== 'system') S.theme = j.theme;
    if (j && LANGS.includes(j.lang) && j.lang !== 'en') S.lang = j.lang; // bahasa tak dikenal di berkas dibuang -> bawaan en
    if (j && j.autoImg === 'off') S.autoImg = 'off'; // unduh foto otomatis: bawaan 'lan' (kuncinya tidak ada); hanya 'off' yang disimpan
    if (j && j.pagesServe === false) S.pagesServe = false; // 5a-1: melayani Halaman ke peer lain; bawaan aktif (kuncinya tidak ada); hanya false yang disimpan
    for (const k of PGS) if (j && k in j) { if (pgsOk(k, j[k])) { if (j[k] !== PG_VSTREAM_LIM[k][1]) S[k] = j[k]; } else this.log('settings: ' + k + ' tidak sah, pakai bawaan'); } // 5a-2: nilai di luar batas dibuang (bukan dijepit: tidak ada yang "hampir benar"); nilai bawaan tidak disimpan
    if (j && 'directDir' in j) { if (dirOk(j.directDir)) S.directDir = path.resolve(j.directDir); else this.log('settings: directDir tidak sah, pakai bawaan'); } // folder yang belum ada/tak terpasang tidak dibuang: dibuat/dicoba lagi saat menerima
    this._settings = S;
    this._applySettings();
  },
  _saveSettings(S) {
    const f = this._settingsFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(Object.assign({ v: 1 }, S)));
    try { fs.copyFileSync(f, f + '.bak'); } catch {}
    fs.renameSync(f + '.tmp', f);
  },
  // Terapkan this._settings ke opts. Nilai awal opts (dari konstruktor) dicatat sekali dan dipulihkan untuk kunci yang tidak diatur.
  _applySettings() {
    if (!this._qBase) { this._qBase = {}; for (const sp of Object.values(SPEC)) for (const o of sp.opts) if (o in this.opts) this._qBase[o] = this.opts[o]; }
    for (const [k, sp] of Object.entries(SPEC)) {
      for (const o of sp.opts) {
        if (k in this._settings) this.opts[o] = this._settings[k] === UNL ? Infinity : this._settings[k];
        else if (o in this._qBase) this.opts[o] = this._qBase[o];
        else delete this.opts[o];
      }
    }
  },
  // Pemakaian untuk UI, aman-JSON (kuota tanpa batas = 'unlimited').
  settingsUsage() {
    const cu = this.custUsage(), seeds = Object.values(this.store.seeds);
    const w = (u) => ({ used: u.used, count: u.count, quota: jsonQ(u.quota) });
    return {
      cust: { dm: w(cu.dm), gmsg: w(cu.gmsg) },
      files: { dm: w(this.escUsage()), pub: w(this.escUsagePub()), grp: w(this.escUsageGrp()), seed: w({ used: seeds.reduce((n, v) => n + (v.psize || 0), 0), count: seeds.length, quota: this.opts.seedQuota || SEED_QUOTA }) },
      pubMsgs: w(cu.pub),
    };
  },
  // { ok, items: { <kunci>: { value (byte | 'unlimited'), def, min, custom } }, usage }
  getSettings() {
    const items = {};
    for (const [k, sp] of Object.entries(SPEC)) {
      items[k] = { value: k in this._settings ? this._settings[k] : sp.def, def: sp.def, min: sp.min, custom: k in this._settings };
      if (sp.max !== undefined) items[k].max = sp.max;
    }
    return { ok: true, items, usage: this.settingsUsage(), theme: this._settings.theme || 'system', lang: this._settings.lang || 'en', direct: { dir: this._directDir(), def: this._directDirDef(), custom: !!this._settings.directDir }, autoImg: { mode: this._autoImgMode(), def: 'lan', max: AUTO_IMG_MAX }, pages: { serve: this._settings.pagesServe !== false, def: true, streams: Object.assign({ def: { max: PG_VSTREAM_LIM.pgStreamMax[1], peer: PG_VSTREAM_LIM.pgStreamPeer[1] }, min: { max: PG_VSTREAM_LIM.pgStreamMax[0], peer: PG_VSTREAM_LIM.pgStreamPeer[0] }, ceil: { max: PG_VSTREAM_LIM.pgStreamMax[2], peer: PG_VSTREAM_LIM.pgStreamPeer[2] } }, this._pgStreamLimits()) } };
  },
  // 5a-2: batas stream video bersamaan { max: per Core, peer: per pemilik jauh }. Dibaca tiap panggilan (berlaku seketika); stream yang sudah berjalan tidak dipotong (lihat pageMedia).
  _pgStreamLimits() {
    const S = this._settings || {};
    return { max: pgsOk('pgStreamMax', S.pgStreamMax) ? S.pgStreamMax : PG_VSTREAM_LIM.pgStreamMax[1], peer: pgsOk('pgStreamPeer', S.pgStreamPeer) ? S.pgStreamPeer : PG_VSTREAM_LIM.pgStreamPeer[1] };
  },
  // patch: { <kunci>: byte | 'unlimited' | null/'default' (kembali ke bawaan) }. Semua atau tidak sama sekali.
  // Gagal: { ok:false, code: 'bad' (bentuk/kunci/nilai tidak sah) | 'min' (di bawah minimum; ada `min`) | 'io' (gagal menulis), key }.
  setSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, code: 'bad' };
    const next = Object.assign({}, this._settings);
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'theme') { // tampilan: 'system' | 'dark' | 'light' (system/null = bawaan, kuncinya dibuang)
        if (v !== null && !THEMES.includes(v)) return { ok: false, code: 'bad', key: k };
        if (v === null || v === 'system') delete next.theme; else next.theme = v;
        continue;
      }
      if (k === 'lang') { // bahasa UI: 'en' (bawaan, kuncinya dibuang) | 'id'; null/'default' = bawaan
        if (v === null || v === 'default' || v === 'en') { delete next.lang; continue; }
        if (!LANGS.includes(v)) return { ok: false, code: 'bad', key: k };
        next.lang = v;
        continue;
      }
      if (k === 'autoImg') { // unduh foto otomatis: 'lan' (bawaan, kuncinya dibuang) | 'off'
        if (v === null || v === 'default' || v === 'lan') { delete next.autoImg; continue; }
        if (v !== 'off') return { ok: false, code: 'bad', key: k };
        next.autoImg = 'off';
        continue;
      }
      if (k === 'pagesServe') { // 5a-1: true/null/'default' = bawaan (aktif, kuncinya dibuang); false = nonaktif
        if (v === null || v === 'default' || v === true) { delete next.pagesServe; continue; }
        if (v !== false) return { ok: false, code: 'bad', key: k };
        next.pagesServe = false;
        continue;
      }
      if (PGS.includes(k)) { // 5a-2: bilangan bulat dalam [min, maks]; null/'default' = bawaan (kuncinya dibuang); di bawah min = 'min', di atas maks = 'max'
        if (v === null || v === 'default') { delete next[k]; continue; }
        if (!Number.isSafeInteger(v)) return { ok: false, code: 'bad', key: k };
        if (v < PG_VSTREAM_LIM[k][0]) return { ok: false, code: 'min', key: k, min: PG_VSTREAM_LIM[k][0] };
        if (v > PG_VSTREAM_LIM[k][2]) return { ok: false, code: 'max', key: k, max: PG_VSTREAM_LIM[k][2] };
        if (v === PG_VSTREAM_LIM[k][1]) delete next[k]; else next[k] = v;
        continue;
      }
      if (k === 'directDir') { // folder Kirim Langsung: null/'default' = bawaan; selain itu path absolut yang bisa dibuat dan ditulisi (galat 'dir')
        if (v === null || v === 'default') { delete next.directDir; continue; }
        if (!dirOk(v)) return { ok: false, code: 'bad', key: k };
        const d = path.resolve(v);
        try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); } catch { return { ok: false, code: 'dir', key: k }; }
        next.directDir = d;
        continue;
      }
      const sp = Object.prototype.hasOwnProperty.call(SPEC, k) ? SPEC[k] : null;
      if (!sp) return { ok: false, code: 'bad', key: k };
      if (v === null || v === 'default') { delete next[k]; continue; }
      if (v === UNL && sp.max !== undefined) return { ok: false, code: 'bad', key: k }; // batas bermaksimum: tidak ada tanpa batas
      if (v === UNL) { next[k] = UNL; continue; }
      if (!Number.isSafeInteger(v) || v < 0 || (v === 0 && sp.min !== 0)) return { ok: false, code: 'bad', key: k };
      if (v < sp.min) return { ok: false, code: 'min', key: k, min: sp.min };
      if (sp.max !== undefined && v > sp.max) return { ok: false, code: 'max', key: k, max: sp.max };
      next[k] = v;
    }
    try { this._saveSettings(next); } catch (e) { this.log('settings: gagal menulis ' + e.message); return { ok: false, code: 'io' }; }
    this._settings = next;
    this._applySettings();
    this._enforceQuotas();
    this.emit('update');
    return this.getSettings();
  },
  // Kuota diturunkan (atau berkas diedit): buang kelebihan SEKARANG, tidak menunggu pesan baru. Jumlah yang dibuang dikembalikan.
  //  - titipan DM/pesan grup: yang terlama dulu (sekali jalan, tidak seadil penggusuran saat pesan baru datang)
  //  - pesan publik orang lain: adil per pengirim (_pubTrim)
  //  - kolam berkas publik/grup dan seed: yang paling lama tidak dipakai
  //  - kolam berkas DM TIDAK digusur (kolam ini menolak yang baru saat penuh, bukan membuang): kelebihannya hilang sendiri lewat tanda terima/TTL 7 hari
  _enforceQuotas() {
    const L = this._custLimits();
    let n = 0;
    for (const cls of ['dm', 'gmsg']) {
      const quota = L[cls].quota;
      if (!(this._cq[cls].bytes > quota)) continue;
      const list = Object.entries(this.store.custody).filter(([, c]) => custClass(c.m) === cls).sort((a, b) => a[1].at - b[1].at);
      for (const [id] of list) { if (!(this._cq[cls].bytes > quota)) break; this._dropCustody(id); n++; }
    }
    n += this._pubTrim();
    for (const pool of ['pub', 'grp']) { const before = Object.keys(this.store.esc).length; this._poolMakeRoom(pool, null, 0, null); n += before - Object.keys(this.store.esc).length; }
    const S = this.store.seeds, quota = this.opts.seedQuota || SEED_QUOTA;
    let used = Object.values(S).reduce((x, v) => x + (v.psize || 0), 0);
    if (used > quota) {
      for (const [k, v] of Object.entries(S).sort((a, b) => (a[1].used || a[1].at) - (b[1].used || b[1].at))) { if (used <= quota) break; used -= v.psize || 0; this._dropSeed(k); n++; }
    }
    if (n) this._save();
    return n;
  },
};

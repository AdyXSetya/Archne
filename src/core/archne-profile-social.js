'use strict';
// src/core/archne-profile-social.js — nama/bio/avatar, teman, blokir
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const crypto = require('crypto');
const { AV_DIM, AV_MAX, BIO_BAD, FCTL, FR_KEEP, FR_PENDING_MAX, FTEXT, HEX16, HLC_DRIFT, PF2TAG, PFTAG, PROF_DEFAULT, PROF_KEEP, PROF_MAX, sha } = require('./archne-constants');
const { idFromPub } = require('./archne-util');
const { ek } = require('./archne-ecode');

module.exports = {
  setName(n) {
    this.name = String(n || '').trim().slice(0, 32) || this.name;
    this._save(); this.emit('update');
  },
  // ---- Profil: deskripsi (bio) dan foto ----
  // Tanpa pengaturan, semua orang tampil dengan PROF_DEFAULT ("Hallo...") dan tanpa foto: tidak ada yang perlu disimpan atau disinkronkan.
  // Mengubah deskripsi/foto membuat catatan bertanda tangan { id, pub, bio, ts, sig, av } (ts = HLC, jadi selalu lebih baru dari yang lama);
  // sync membawanya ke semua akun, juga lewat peer lain, dan versi terbaru menang. Bio kosong = bawaan; av kosong = tanpa foto.
  // Catatan v1 (v0.7.3, tanpa `av`) tetap diterima: tanda tangannya PFTAG + id:ts:bio. Catatan v2 menandatangani JSON [id, ts, bio, sha(av)],
  // jadi isi bio tidak bisa dibuat menyerupai bagian lain dari pesan yang ditandatangani.
  bioOf(id) { const p = this.store.profiles[id]; return p && p.bio ? p.bio : PROF_DEFAULT; },
  avatarOf(id) { const p = this.store.profiles[id]; return p && p.av ? p.av : ''; },
  _cleanBio(t) {
    const x = String(t == null ? '' : t).replace(/[\r\n\t]+/g, ' ').replace(new RegExp(BIO_BAD.source, 'g'), '');
    return Array.from(x).slice(0, PROF_MAX).join('').trim();
  },
  // Foto sah: '' (tanpa foto) atau JPEG base64 baku, <= AV_MAX karakter, berawal FFD8FF, berakhir FFD9, dan dimensi (dari penanda SOF) 1..AV_DIM.
  _validAvatar(b) {
    if (b === '') return true;
    if (typeof b !== 'string' || b.length > AV_MAX || b.length < 100 || b.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b)) return false;
    const buf = Buffer.from(b, 'base64');
    if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return false;
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) return false;
      const mk = buf[i + 1];
      if (mk === 0xff) { i++; continue; }
      if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
      if (mk >= 0xc0 && mk <= 0xc2) { // SOF baseline/extended/progressive
        if (i + 9 > buf.length) return false;
        const h = buf.readUInt16BE(i + 5), w = buf.readUInt16BE(i + 7);
        return w >= 1 && h >= 1 && w <= AV_DIM && h <= AV_DIM;
      }
      if (mk === 0xda || mk === 0xd9) return false; // data gambar/akhir sebelum ada ukuran
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return false;
  },
  _wireProfile(x) {
    const o = { id: x.id, pub: x.pub, bio: x.bio, ts: x.ts, sig: x.sig };
    if (typeof x.av === 'string') o.av = x.av;
    return o;
  },
  _putProfile(bio, av) {
    const ts = this._tsNow();
    const sig = crypto.sign(null, Buffer.from(PF2TAG + JSON.stringify([this.id, ts, bio, av ? sha(av) : ''])), this.privKey).toString('base64');
    this.store.profiles[this.id] = { id: this.id, pub: this.pub, bio, ts, sig, av };
    this._save(); this.emit('update');
  },
  setBio(text) {
    const bio = this._cleanBio(text), cur = this.store.profiles[this.id];
    if ((cur ? cur.bio : '') === bio) return this.bioOf(this.id);
    this._putProfile(bio, (cur && cur.av) || '');
    return this.bioOf(this.id);
  },
  // b64 = JPEG base64 (boleh berawalan data URL); '' menghapus foto. Hasil: true bila sekarang ada foto.
  setAvatar(b64) {
    const av = String(b64 == null ? '' : b64).trim().replace(/^data:image\/jpeg;base64,/i, '');
    if (!this._validAvatar(av)) throw ek('e.group.avInvalid', { dim: AV_DIM, kb: Math.floor(AV_MAX * 3 / 4 / 1024) }, 'Foto tidak valid: harus JPEG maks {dim}x{dim} px dan {kb} KB');
    const cur = this.store.profiles[this.id];
    if (((cur && cur.av) || '') === av) return !!av;
    this._putProfile(cur ? cur.bio : '', av);
    return !!av;
  },
  _addProfile(pf) {
    if (!pf || typeof pf !== 'object' || !HEX16.test(String(pf.id))) return false;
    if (typeof pf.pub !== 'string' || typeof pf.sig !== 'string' || pf.pub.length > 200 || pf.sig.length > 200) return false;
    if (typeof pf.bio !== 'string' || pf.bio.length > PROF_MAX * 2 || Array.from(pf.bio).length > PROF_MAX || BIO_BAD.test(pf.bio)) return false;
    const v2 = pf.av !== undefined;
    if (v2 && !this._validAvatar(pf.av)) return false;
    if (!Number.isSafeInteger(pf.ts) || pf.ts <= 0 || pf.ts > this._wall() + HLC_DRIFT) return false; // ts jauh di masa depan tidak bisa dipakai mengunci profil
    const old = this.store.profiles[pf.id];
    if (old && old.ts >= pf.ts) return false;
    try {
      if (pf.id !== idFromPub(pf.pub)) return false;
      const key = crypto.createPublicKey({ key: Buffer.from(pf.pub, 'base64'), format: 'der', type: 'spki' });
      const msg = v2 ? PF2TAG + JSON.stringify([pf.id, pf.ts, pf.bio, pf.av ? sha(pf.av) : '']) : PFTAG + pf.id + ':' + pf.ts + ':' + pf.bio;
      if (!crypto.verify(null, Buffer.from(msg), key, Buffer.from(pf.sig, 'base64'))) return false;
    } catch { return false; }
    const P = this.store.profiles;
    P[pf.id] = { id: pf.id, pub: pf.pub, bio: pf.bio, ts: pf.ts, sig: pf.sig };
    if (v2) P[pf.id].av = pf.av;
    if (pf.id === this.id) this._tsSeen(pf.ts); // profilku dari peer lain (mis. setelah pasang ulang) lebih baru: jam kita menyusul
    const all = Object.keys(P);
    if (all.length > PROF_KEEP) all.filter((k) => k !== this.id && !this._friendRec(k) && !this.peers.has(k)).sort((a, b) => P[a].ts - P[b].ts)
      .slice(0, all.length - PROF_KEEP).forEach((k) => delete P[k]);
    return true;
  },
  // ---- Teman: pertemanan dua arah ----
  // store.friends[id] = { st, rts, at, name }; st: 'out' (aku meminta, menunggu), 'in' (dia meminta, menunggu aku), 'ok' (saling setuju), '' (tidak ada;
  // catatan tetap disimpan sebagai penanda urutan). rts = ts kontrol terakhir yang diterapkan dari dia, supaya kontrol lama yang telat sampai
  // (mis. permintaan yang sudah dibatalkan) tidak menghidupkan keadaan lama. Kontrol: frq (minta), fac (setuju), fdl (batal/putus).
  _friendRec(id) { const r = this.store.friends[id]; return r && r.st ? r : null; },
  fstate(id) { const r = this.store.friends[id]; return (r && r.st) || ''; },
  _friendCtl(m) {
    if (m.kind !== 'e1') return null;
    const t = this._open(m);
    return typeof t === 'string' ? (FCTL[t] || null) : null;
  },
  _fsend(c, id) {
    try { this._send(FTEXT[c], id); return true; } catch { return false; }
  },
  _friendRetry() { // permintaan dari daftar teman v0.7.3 dikirim begitu kunci enkripsinya tersedia
    for (const [id, r] of Object.entries(this.store.friends)) {
      if (r.mig && r.st === 'out' && this._pairKey(id) && this._fsend('frq', id)) { delete r.mig; this._save(); }
    }
  },
  _applyFriendCtl(m, c) {
    const id = m.from, F = this.store.friends;
    if (!HEX16.test(id) || id === this.id || m.ts > this._wall() + HLC_DRIFT) return;
    if (F[id] && m.ts <= (F[id].rts || 0)) return;
    const r = F[id] || (F[id] = { st: '', rts: 0, at: Date.now() });
    r.rts = m.ts;
    const p = this.peers.get(id);
    if (p) r.name = p.name;
    if (c === 'frq') {
      if (r.st === 'out') { r.st = 'ok'; delete r.mig; this._fsend('fac', id); } // kita saling meminta: langsung berteman
      else if (r.st === 'ok') this._fsend('fac', id); // dia kehilangan catatannya: beri tahu kita masih berteman
      else if (r.st !== 'in' && Object.values(F).filter((x) => x.st === 'in').length < FR_PENDING_MAX) { r.st = 'in'; r.at = Date.now(); }
    } else if (c === 'fac') {
      if (r.st === 'out') { r.st = 'ok'; delete r.mig; }
    } else if (c === 'fdl') r.st = '';
    const all = Object.entries(F);
    if (all.length > FR_KEEP) all.filter(([, x]) => !x.st).sort((a, b) => (a[1].rts || 0) - (b[1].rts || 0)).slice(0, all.length - FR_KEEP).forEach(([k]) => delete F[k]);
  },
  // Tambah teman = kirim permintaan; kalau dia sudah meminta kita, ini menyetujuinya. Hasil: keadaan baru ('out' atau 'ok').
  addFriend(id) {
    id = String(id);
    if (!HEX16.test(id) || id === this.id) throw new Error('ID teman tidak valid');
    const p = this.peers.get(id);
    if (!p) throw ek('e.profile.neverSeen', null, 'Orang ini belum pernah terlihat di jaringan');
    if (this.isBlocked(id)) throw ek('e.profile.blockedPeer', null, 'Kamu memblokir orang ini. Buka blokirnya dulu.');
    const cur = this.fstate(id);
    if (cur === 'ok' || cur === 'out') return cur;
    if (!this._pairKey(id)) throw ek('e.profile.noPair', null, 'Orang ini belum bisa dihubungi secara terenkripsi (versi lama atau belum terlihat)');
    const r = this.store.friends[id] || (this.store.friends[id] = { st: '', rts: 0, at: 0 });
    r.name = p.name; r.at = Date.now();
    if (cur === 'in') { r.st = 'ok'; this._fsend('fac', id); } else { r.st = 'out'; this._fsend('frq', id); }
    this._save(); this.emit('update');
    return r.st;
  },
  // Hapus teman / batalkan permintaan terkirim (dia diberi tahu) / tolak permintaan masuk (diam-diam, dia tidak diberi tahu).
  removeFriend(id) {
    id = String(id);
    const r = this.store.friends[id];
    if (!r || !r.st) return false;
    const was = r.st;
    r.st = ''; delete r.mig;
    if (was !== 'in') this._fsend('fdl', id);
    this._save(); this.emit('update');
    return true;
  },
  // ---- Blokir (privasi pribadi, hanya berlaku di perangkatku) ----
  // store.blocked[id] = { at, name, fdl? }. Orang yang kublokir tidak diberi tahu soal blokirnya (fdl = pemberitahuan putus teman yang masih tertahan). Yang terjadi di perangkatku:
  //  - pesannya (publik, grup, privat) dan dia sendiri hilang dari semua daftar; chat privat dengannya disembunyikan (tidak dihapus: muncul lagi bila blokir dibuka);
  //  - DM, permintaan teman, dan undangan grup barunya dibuang diam-diam (dia tetap melihat "terkirim");
  //  - aku tidak mengirim apa pun kepadanya (DM, pesan grup, sync, profil, berkas) dan tidak melayani sync/unduhan darinya;
  //  - pertemanan putus di dua sisi: dia menerima pemutusan pertemanan biasa (seperti Hapus teman), bukan kabar bahwa dia diblokir.
  // Batas: di grup yang sama dia tetap memegang kunci grup, jadi pesan grupku masih bisa sampai lewat anggota lain, dan siaran penemuan LAN
  // (UDP) tetap terlihat olehnya. Tanpa server, itu tidak bisa dicegah; satu-satunya cara memutus total adalah mengeluarkannya dari grup (admin).
  isBlocked(id) { return !!this.store.blocked[id]; },
  blockUser(id) {
    id = String(id);
    if (!HEX16.test(id) || id === this.id) throw new Error('ID tidak valid');
    if (this.isBlocked(id)) return true;
    const p = this.peers.get(id), known = [...Object.values(this.store.groups).flatMap((g) => g.members), ...Object.values(this.store.msgs).filter((m) => m.from === id && m.name).map((m) => ({ id, name: m.name }))].find((x) => x.id === id);
    // Blokir = putus pertemanan di dua sisi: pemberitahuan putus teman (DM terenkripsi, lewat kurir kalau dia offline) dikirim SEKALI.
    // Dibuat langsung (bukan lewat _send, yang menolak orang terblokir dan langsung mengirim apa pun yang tertahan). Permintaan masuk
    // yang belum kujawab dibuang diam-diam, seperti menolak.
    let fdl = null;
    const f = this.store.friends[id];
    if (f && f.st) {
      const was = f.st;
      f.st = ''; delete f.mig;
      if (was !== 'in') {
        try { const dm = this._makeMsg(id, 'e1', FTEXT.fdl); this.store.msgs[dm.id] = dm; this.store.status[dm.id] = 'pending'; fdl = dm.id; } catch {} // tanpa kunci enkripsi: tidak ada jalan memberi tahu
      }
    }
    this.store.blocked[id] = Object.assign({ at: Date.now(), name: String((p && p.name) || (known && known.name) || '?').slice(0, 32) }, fdl ? { fdl } : {});
    for (const [mid, st] of Object.entries(this.store.status)) { // kiriman lain yang masih tertahan untuk dia dibatalkan, bukan terkirim belakangan
      const m = this.store.msgs[mid];
      if (st === 'pending' && m && m.to === id && mid !== this.store.blocked[id].fdl) this.store.status[mid] = 'cancelled';
    }
    for (const gs of Object.values(this.store.gstatus)) if (gs[id] === 'pending') delete gs[id];
    for (const [cid, c] of Object.entries(this.store.custody)) if (c.m.from === id) this._dropCustody(cid);
    this._vcDrop(id);
    this._pvDrop(id);
    this._pvRebuild(); // channel publik miliknya disembunyikan (dan tidak lagi memakan tempat); kembali lewat sync kalau dibuka blokirnya
    this._callDrop(id, 'blocked'); // panggilan yang sedang berjalan dengannya diputus tanpa memberi tahu
    this._save(); this.emit('update');
    if (fdl && this.isOnline(p)) this._flushOutbox(p);
    return true;
  },
  unblockUser(id) {
    id = String(id);
    if (!this.isBlocked(id)) return false;
    delete this.store.blocked[id];
    try { this._pinReapply(id); } catch {}
    try { this._rxReapply(id); } catch {}
    this._save(); this.emit('update');
    this._resync();
    return true;
  },
};

'use strict';
// i18n (E9e): label sematan pesan suara ikut tersimpan di data sematan dan terkirim ke peer, jadi TIDAK diterjemahkan di pengirim; sengaja English (bahasa bawaan).
const PIN_VOICE_LABEL = '🎤 Voice message';
// src/core/archne-pin-sync.js — sematan pesan (pin*)
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const Pins = require('../archne-pins');
const { ek } = require('./archne-ecode');
const { HEX16, HLC_DRIFT } = require('./archne-constants');

module.exports = {
  // ---- Sematan pesan (v0.20.0, pin2): penyimpanan dan penyebaran (aturan murni ada di archne-pins.js) ----
  // Sematan BERSAMA (grup, DM) disebar sebagai pesan kontrol tersembunyi: g1 di grup, e1 di DM, teks berawalan Pins.CTL. Pesan itu masuk store.msgs seperti
  // pesan biasa, jadi ikut sinkron, kurir (DM), dan status kirim, tetapi tidak pernah tampil, tidak memicu notifikasi, dan tidak bisa dibalas.
  // Keadaan sematan TIDAK diturunkan dari riwayat pesan: disimpan terpisah di store.pins[scope] = { m: peta sematan, r: { pid: id pesan pembawa versi terkini } },
  // jadi "Bersihkan chat" (yang hanya menyembunyikan pesan) dan batal kirim pesan asli tidak mengubah apa pun. Sematan PRIBADI (juga di tab Publik, dan milik
  // member biasa di grup) hanya lokal: store.mypins[scope] = peta; tidak ada pesan, tidak ada jaringan. scope = 'public' | 'g:<gid>' | <id lawan bicara>.
  _pinMigrate() {
    const S = this.store, fix = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
    const okScope = (k) => k === 'public' || /^g:[0-9a-f]{16}$/.test(k) || HEX16.test(k);
    S.pins = fix(S.pins); S.mypins = fix(S.mypins);
    for (const [k, b] of Object.entries(S.pins)) {
      if (k === 'public' || !okScope(k) || !b || typeof b !== 'object') { delete S.pins[k]; continue; }
      const m = Pins.clean(b.m), r = {};
      for (const [pid, mid] of Object.entries(fix(b.r))) if (m[pid] && typeof mid === 'string' && /^[0-9a-f]{32}$/.test(mid)) r[pid] = mid;
      if (Object.keys(m).length) S.pins[k] = { m, r }; else delete S.pins[k];
    }
    for (const [k, mp] of Object.entries(S.mypins)) {
      const m = okScope(k) ? Pins.clean(mp) : {};
      for (const id of Object.keys(m)) if (m[id].del) delete m[id]; // sematan pribadi tidak punya tombstone
      if (Object.keys(m).length) S.mypins[k] = m; else delete S.mypins[k];
    }
  },
  _pinBox(scope, make) {
    let b = this.store.pins[scope];
    if (!b && make) b = this.store.pins[scope] = { m: {}, r: {} };
    return b || null;
  },
  _isPinCtl(m) { // murah: dipakai di setiap penyaringan pesan
    if (m.kind !== 'g1' && m.kind !== 'e1') return false;
    const t = this._open(m);
    return typeof t === 'string' && t.startsWith(Pins.CTL);
  },
  _pinCtl(m) { return this._isPinCtl(m) ? Pins.parseCtl(this._open(m)) : null; },
  _pinScopeOf(m) { return m.kind === 'g1' ? m.to : (m.from === this.id ? m.to : m.from); },
  _pinPolicy(scope) { // null = lingkup ini tidak bisa punya sematan bersama (grup hilang / dikeluarkan / bukan chat)
    if (scope.startsWith('g:')) { const g = this.store.groups[scope.slice(2)]; return g && !g.removed ? Pins.groupPolicy(g) : null; }
    return HEX16.test(scope) && scope !== this.id ? Pins.dmPolicy(this.id, scope) : null;
  },
  // Terapkan rekaman dari pesan kontrol (m.from sudah diverifikasi tanda tangannya). Mengembalikan jumlah rekaman yang berubah.
  _applyPinCtl(m, recs) {
    if (m.from !== this.id && this.isBlocked(m.from)) return 0;
    const scope = this._pinScopeOf(m), pol = this._pinPolicy(scope);
    if (!pol) return 0;
    const box = this._pinBox(scope, true), lim = this._wall() + HLC_DRIFT; // ts jauh di masa depan akan menang selamanya: tolak
    let n = 0;
    for (const r of recs) {
      if (!r || typeof r !== 'object' || !(r.ts <= lim)) continue;
      if (Pins.applyRemote(box.m, pol, m.from, r) === 'applied') { box.r[r.id] = m.id; n++; }
    }
    for (const pid of Object.keys(box.r)) if (!box.m[pid]) delete box.r[pid]; // rekaman yang terbuang (tombstone terlama) tidak perlu pembawa
    if (!Object.keys(box.m).length) delete this.store.pins[scope];
    return n;
  },
  // Pesan pembawa versi terkini sematan bersama sebuah lingkup. Sync grup selalu menyertakannya: pesan kontrol lama tidak boleh hilang
  // hanya karena obrolan ramai mendorongnya keluar dari jendela 500 pesan terbaru.
  _pinCarriers(scope) {
    const b = this.store.pins[scope], out = new Map();
    if (b) for (const mid of Object.values(b.r)) { const m = this.store.msgs[mid]; if (m && !out.has(mid)) out.set(mid, m); }
    return [...out.values()];
  },
  // Umumkan ulang sematan bersama yang hidup (dipanggil admin setelah menambah anggota: anggota baru tidak menerima riwayat lama).
  _pinAnnounce(g) {
    const scope = 'g:' + g.id, box = this.store.pins[scope];
    if (!box || !Pins.groupPolicy(g).canPost(this.id)) return 0;
    const recs = Pins.live(box.m);
    if (!recs.length) return 0;
    for (const text of Pins.encodeAll(recs)) {
      const m = this._send(text, scope);
      for (const r of Pins.parseCtl(text)) if (box.m[r.id]) box.r[r.id] = m.id;
    }
    this._save();
    return recs.length;
  },
  // Orang yang kublokir hilang dari tampilanku: sematan yang dipasangnya, dan sematan yang menyalin pesannya (bersama maupun pribadi). Hanya tampilan:
  // datanya tetap, jadi sematan muncul lagi bila blokir dibuka dan tidak ada yang menyimpang dari anggota lain.
  _pinHidden(r) { return this.isBlocked(r.by) || (r.kind !== 'note' && this.isBlocked(r.from)); },
  // Pesan kontrol sematan dari orang yang kublokir tetap disimpan (disembunyikan) tetapi tidak diterapkan; setelah blokir dibuka pesannya sudah
  // 'dup' dan tidak akan diterapkan lagi, jadi diterapkan di sini dari simpanan. Aman diulang: yang sudah ada hasilnya 'stale'.
  _pinReapply(id) {
    let n = 0;
    for (const m of Object.values(this.store.msgs)) {
      if (m.from !== id || m.kind !== 'g1') continue; // DM dari orang terblokir tidak pernah disimpan
      const pc = this._pinCtl(m);
      if (pc) n += this._applyPinCtl(m, pc);
    }
    return n;
  },
  _pinTarget(scope) {
    scope = String(scope);
    if (scope === 'public') return { scope, kind: 'public', pol: null };
    if (scope.startsWith('g:')) {
      const g = this.store.groups[scope.slice(2)];
      if (!g) throw ek('e.group.unknown', null, 'Grup tidak dikenal');
      if (g.removed) throw ek('e.group.removed', null, 'Kamu sudah dikeluarkan dari grup ini');
      return { scope, kind: 'g', pol: Pins.groupPolicy(g) };
    }
    if (HEX16.test(scope) && scope !== this.id) return { scope, kind: 'dm', pol: Pins.dmPolicy(this.id, scope) };
    throw ek('e.msg.chatUnknown', null, 'Chat tidak dikenal');
  },
  // Ubah lokal lalu sebarkan. Kalau pengiriman gagal (mis. kunci belum ada), perubahan dibatalkan supaya tidak menyimpang dari anggota lain.
  _pinCommit(t, fn) {
    const box = this._pinBox(t.scope, true), snapM = JSON.stringify(box.m), snapR = JSON.stringify(box.r);
    try {
      const rec = fn(box.m);
      const m = this._send(Pins.encodeCtl([rec]), t.scope);
      box.r[rec.id] = m.id;
      this._save(); this.emit('update');
      return rec;
    } catch (e) {
      box.m = JSON.parse(snapM); box.r = JSON.parse(snapR);
      if (!Object.keys(box.m).length) delete this.store.pins[t.scope];
      throw e;
    }
  },
  _pinMineDo(scope, fn) { // pribadi: hanya lokal. Peta baru disimpan hanya bila operasinya berhasil dan tidak kosong.
    const M = this.store.mypins, map = M[scope] || {};
    const r = fn(map);
    if (Object.keys(map).length) M[scope] = map; else delete M[scope];
    this._save(); this.emit('update');
    return r;
  },
  // Salinan pesan yang dilihat pengguna: teks tanpa awalan balasan; berkas hanya labelnya ("📎 nama"), bukan isinya.
  _pinSnap(scope, mid) {
    const m = this.store.msgs[String(mid)];
    if (!m || m.kind === 'ginv' || this.store.hidden[m.id] || this.isBlocked(m.from) || this._isCtlMsg(m) || this._chatKey(m) !== scope) throw ek('e.msg.notFound', null, 'Pesan tidak ditemukan (mungkin sudah dibatalkan atau dibersihkan)');
    const t = m.kind ? this._open(m) : m.text;
    if (typeof t !== 'string') throw ek('e.pin.unreadable', null, 'Pesan ini tidak bisa dibaca, jadi tidak bisa disematkan');
    const off = this._offerOf(m);
    if (off === null) throw ek('e.pin.badOffer', null, 'Tawaran berkas tidak valid');
    return { kind: off ? 'file' : 'msg', text: off ? (off.x && off.x.k === 'vc' ? PIN_VOICE_LABEL : '📎 ' + off.name) : this._splitReply(t).text, from: m.from, name: m.name, at: this._dts(m), mid: m.id };
  },
  _pinMake(t, shared, spec) {
    if (!shared) return this._pinMineDo(t.scope, (map) => Pins.create(map, Pins.selfPolicy(this.id), this.id, Pins.newId(this.id), spec, this._tsNow()));
    if (t.kind === 'public') throw ek('e.pin.publicOnlyMine', null, 'Di tab Publik sematan hanya untuk dirimu sendiri');
    return this._pinCommit(t, (map) => Pins.create(map, t.pol, this.id, Pins.newId(this.id), spec, this._tsNow()));
  },
  // Sematkan pesan. shared=true: untuk semua di chat ini (grup: admin/pemilik; DM: kedua orang; Publik: tidak ada). shared=false: pribadi.
  pinAdd(scope, mid, shared) {
    const t = this._pinTarget(scope);
    return this._pinMake(t, !!shared, this._pinSnap(t.scope, mid)).id;
  },
  // Pengumuman bebas (bukan dari sebuah pesan).
  pinNote(scope, text, shared) {
    const t = this._pinTarget(scope);
    return this._pinMake(t, !!shared, { kind: 'note', text }).id;
  },
  pinEdit(scope, pid, text) {
    const t = this._pinTarget(scope);
    pid = String(pid);
    const box = this._pinBox(t.scope), cur = box && box.m[pid];
    if (cur && !cur.del) {
      if (cur.kind === 'note' && Pins.cleanText(text) === cur.text) return true; // tidak berubah: tidak usah menyebar
      this._pinCommit(t, (map) => Pins.edit(map, t.pol, this.id, pid, text, this._tsNow()));
      return true;
    }
    this._pinMineDo(t.scope, (map) => Pins.edit(map, Pins.selfPolicy(this.id), this.id, pid, text, this._tsNow()));
    return true;
  },
  pinRemove(scope, pid) {
    const t = this._pinTarget(scope);
    pid = String(pid);
    const box = this._pinBox(t.scope), cur = box && box.m[pid];
    if (cur && !cur.del) { this._pinCommit(t, (map) => Pins.remove(map, t.pol, this.id, pid, this._tsNow())); return true; }
    this._pinMineDo(t.scope, (map) => Pins.remove(map, Pins.selfPolicy(this.id), this.id, pid, this._tsNow()));
    return true;
  },
  // Daftar untuk UI: bersama dan pribadi dipisah, terbaru di atas. canShare = boleh menyematkan untuk semua di chat ini.
  pinList(scope) {
    let t;
    try { t = this._pinTarget(scope); } catch { return { shared: [], mine: [], canShare: false }; }
    const box = this._pinBox(t.scope), pol = t.pol;
    const vis = (map) => { const o = {}; for (const [k, r] of Object.entries(map || {})) if (!this._pinHidden(r)) o[k] = r; return o; }; // disaring SEBELUM dibatasi 100 teratas
    const view = (r, shared) => ({ id: r.id, kind: r.kind, text: r.text, from: r.from, name: r.name, at: r.at, mid: r.mid, ts: r.ts, by: r.by, shared,
      canRemove: shared ? pol.canRemove(this.id, r) : true, canEdit: r.kind === 'note' && (shared ? pol.canPost(this.id) : true) });
    return { shared: pol && box ? Pins.live(vis(box.m)).map((r) => view(r, true)) : [], mine: Pins.live(vis(this.store.mypins[t.scope])).map((r) => view(r, false)), canShare: !!pol && pol.canPost(this.id) };
  },
  // Semua lingkup yang punya sematan tampil (bersama atau pribadi), untuk state(): { [scope]: { shared, mine, canShare } }. Lingkup tanpa sematan
  // tidak ikut; UI yang butuh canShare untuk chat kosong memanggil pinList(scope).
  pinAll() {
    const out = {};
    for (const k of new Set([...Object.keys(this.store.pins), ...Object.keys(this.store.mypins)])) {
      const l = this.pinList(k);
      if (l.shared.length || l.mine.length) out[k] = l;
    }
    return out;
  },
};

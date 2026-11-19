'use strict';
// src/core/archne-reactions.js — reaksi pesan (rx1, langkah 3): penyimpanan, penyebaran, penerapan. Aturan murni (emoji, register LWW, batas) ada di src/archne-reactions.js.
// Satu orang = satu reaksi per pesan. Keadaan disimpan terpisah dari riwayat: store.react = { [mid]: { [by]: { e, ts } } } (e kosong = dicabut, tetap disimpan
// sebagai tombstone). Reaksi DISEBAR sebagai pesan kontrol tersembunyi (g1 di grup, e1 di DM, teks berawalan Rx.CTL) yang masuk store.msgs seperti pesan biasa,
// jadi ikut sinkron dan status kirim, tetapi tidak pernah tampil, tidak memicu notifikasi, dan tidak bisa dibalas (lihat _isCtlMsg).
// Pembawa BUKAN primer (pc:1): ia kelas obrolan biasa, ikut kuota titipan dan bisa tergusur. Kurir tidak bisa membuka isinya, jadi tidak ada urutan khusus (custRank).
// Publik (setelah rilis 0.25.0): pembawanya pesan publik biasa (tanpa kind, teks polos berawalan Rx.CTL), jadi ikut kuota byte pesan publik (pubmsg-store: ongkosnya sama
// dengan pesan lain, penggusuran adil per pengirim) dan sinkron riwayat. Biayanya dijaga batching 2 dtk (satu pesan per ≤10 rekaman) dan pembatas laju kirim/terima.
// Peserta Publik = siapa saja (pengirim tetap penanda tangan pembawa); pagar ≤256 register per pesan dan ≤5000 total berlaku sama.
// Pengirim reaksi = penanda tangan pesan pembawa (m.from, diverifikasi di _ingest), tidak pernah dibaca dari isi.
// Ketukan dikumpulkan RX_BATCH_MS (satu slot per pesan, yang terakhir menang) lalu dikirim sebagai satu pesan kontrol per chat.
// Reaksi yang sasarannya belum tiba ditahan di _rxPend (disalin ke store.reactHold supaya selamat dari restart) sampai sasarannya tiba (_rxArrive).
const Rx = require('../archne-reactions');
const { ek } = require('./archne-ecode');
const T = require('./archne-i18n-node').tr; // dipanggil saat dipakai, bukan saat load
const { HEX16, HEX32, HLC_DRIFT } = require('./archne-constants');

module.exports = {
  _rxMigrate() {
    const S = this.store;
    S.react = Rx.clean(S.react);
    Rx.retain(S.react, (mid) => !!S.msgs[mid]); // sasaran yang sudah tidak ada (dibatalkan/dibuang) tidak perlu reaksinya
    S.reactRecent = Rx.pushRecent(S.reactRecent, null);
    const now = this._wall();
    this._rxPend = new Map();
    for (const h of Array.isArray(S.reactHold) ? S.reactHold : []) {
      if (h && typeof h === 'object' && Number.isFinite(h.at) && !S.deleted[h.rec && h.rec.m]) Rx.hold(this._rxPend, h.from, h.rec, h.at);
    }
    Rx.gcPending(this._rxPend, now);
    this._rxHoldSave();
  },
  _rxHoldSave() { this.store.reactHold = [...this._rxPend.values()].map((v) => ({ from: v.from, rec: v.rec, at: v.at })); },
  _rxGc() { if (this._rxPend.size && Rx.gcPending(this._rxPend, this._wall())) { this._rxHoldSave(); this._save(); } },

  // ---- pesan kontrol ----
  _rxText(m) { return m.to === 'public' && !m.kind ? m.text : (m.kind === 'g1' || m.kind === 'e1') ? this._open(m) : null; }, // Publik: teks polos
  _isRxCtl(m) { // murah: dipakai di setiap penyaringan pesan (lewat _isCtlMsg)
    return Rx.isCtl(this._rxText(m));
  },
  _rxCtl(m) { return this._isRxCtl(m) ? Rx.parseCtl(this._rxText(m)) : null; },

  // ---- penerapan ----
  _rxParticipant(scope, id) { // peserta chat: anggota grup saat ini, aku / lawan bicara di DM, atau siapa saja di Publik
    if (scope === 'public') return HEX16.test(id);
    if (scope.startsWith('g:')) { const g = this.store.groups[scope.slice(2)]; return !!g && !g.removed && g.members.some((x) => x.id === id); }
    return id === this.id || id === scope;
  },
  // Satu rekaman dari `from` untuk chat `scope`. Hasil: 'applied' | 'stale' | 'reject' | 'pending' (lihat Rx.applyRemote).
  _rxApplyOne(from, raw, scope, maxTs) {
    const mid = raw && typeof raw === 'object' && typeof raw.m === 'string' ? raw.m : '';
    if (this.store.deleted[mid]) return 'stale'; // sasaran sudah dibatalkan pengirimnya
    const t = this.store.msgs[mid];
    if (t && (t.kind === 'ginv' || this._isCtlMsg(t) || this._chatKey(t) !== scope)) return 'reject'; // pesan kontrol / undangan / chat lain tidak bisa diberi reaksi
    const res = Rx.applyRemote(this.store.react, from, raw, { isParticipant: (id) => this._rxParticipant(scope, id), known: (x) => !!this.store.msgs[x], maxTs });
    if (res === 'pending' && Rx.hold(this._rxPend, from, raw, this._wall())) this._rxHeld = true;
    return res;
  },
  // Terapkan rekaman dari pesan kontrol (m.from sudah diverifikasi tanda tangannya). Mengembalikan jumlah rekaman yang berubah.
  // direct = pesan datang langsung dari pengirimnya (bukan sinkron riwayat): hanya di sini laju terima dibatasi, supaya riwayat lama tidak terbuang.
  _applyRxCtl(m, recs, direct) {
    if (m.from !== this.id && this.isBlocked(m.from)) return 0; // disimpan (tersembunyi) tetapi tidak diterapkan; diterapkan lagi saat blokir dibuka (_rxReapply)
    const scope = this._chatKey(m);
    if (!this._rxParticipant(scope, m.from)) return 0;
    if (direct && m.from !== this.id && !this._rxIn.take(m.from, Math.max(1, Math.min(recs.length, Rx.RX_MAX_PER_MSG)), this._wall())) return 0;
    const maxTs = Math.min(m.ts, this._wall()) + HLC_DRIFT; // pengirim jujur selalu memberi rekaman ts <= ts pembawanya; ts jauh di masa depan akan menang selamanya: tolak
    let n = 0;
    this._rxHeld = false;
    const fresh = [];
    for (const raw of recs.slice(0, Rx.RX_MAX_PER_MSG)) {
      if (this._rxApplyOne(m.from, raw, scope, maxTs) !== 'applied') continue;
      n++;
      const t = this.store.msgs[raw.m], r = this.store.react[raw.m] && this.store.react[raw.m][m.from];
      if (direct && m.from !== this.id && t && t.from === this.id && r && r.e) fresh.push({ mid: raw.m, e: r.e });
    }
    if (fresh.length) this._rxNotice(m, scope, fresh);
    if (n) Rx.prune(this.store.react);
    if (this._rxHeld) { this._rxHeld = false; this._rxHoldSave(); }
    return n;
  },
  // Pemberitahuan "X bereaksi 🩷" untuk pesanku (hanya yang datang langsung, bukan sinkron riwayat; mengikuti bisu per chat lewat notifyOn).
  // Bentuknya sama dengan notifyRich supaya cangkang Android memakainya apa adanya. Satu ketukan terakhir per pesan; tidak memicu bila chat dibisukan.
  _rxNotice(m, scope, fresh) {
    if (!this.notifyOn(scope) || Date.now() - this._dts(m) > 60000) return;
    const who = this._rxName(m.from, scope), last = fresh[fresh.length - 1], t = this.store.msgs[last.mid];
    let q = ''; try { q = this._splitReply(String(this._open(t) || t.text || '')).text.replace(/\s+/g, ' ').trim().slice(0, 60); } catch (e) {}
    const g = scope.startsWith('g:') ? this.store.groups[scope.slice(2)] : null;
    this.emit('reaction', { key: scope, title: g ? g.name + ' · ' + who : who, text: q ? T('rx.noticeOn', { who, emoji: last.e, quote: q }, '{who} bereaksi {emoji} pada: {quote}') : T('rx.notice', { who, emoji: last.e }, '{who} bereaksi {emoji}'), from: m.from, who, chat: g ? g.name : '', ts: this._dts(m), av: this.avatarOf(m.from), mid: last.mid, e: last.e });
  },
  // Sasaran m baru tiba: terapkan reaksi yang menunggunya. Pengecekan peserta memakai chat sasaran, jadi reaksi dari orang yang bukan peserta chat itu ditolak.
  _rxArrive(m) {
    if (!this._rxPend.size) return 0;
    const held = Rx.release(this._rxPend, m.id);
    if (!held.length) return 0;
    this._rxHoldSave();
    if (m.kind === 'ginv' || this._isCtlMsg(m)) return 0;
    const scope = this._chatKey(m);
    let n = 0;
    for (const h of held) {
      if (h.from !== this.id && this.isBlocked(h.from)) continue;
      if (this._rxApplyOne(h.from, h.rec, scope, undefined) === 'applied') n++;
    }
    if (n) Rx.prune(this.store.react);
    return n;
  },
  // Pesan kontrol reaksi dari orang yang kublokir tetap disimpan (tersembunyi) tetapi tidak diterapkan; setelah blokir dibuka pesannya sudah 'dup',
  // jadi diterapkan di sini dari simpanan. Aman diulang: yang sudah ada hasilnya 'stale'.
  _rxReapply(id) {
    let n = 0;
    for (const m of Object.values(this.store.msgs)) {
      if (m.from !== id || (m.kind !== 'g1' && !(m.to === 'public' && !m.kind))) continue; // DM dari orang terblokir tidak pernah disimpan
      const rc = this._rxCtl(m);
      if (rc) n += this._applyRxCtl(m, rc, false);
    }
    return n;
  },
  // Pesan sasaran hilang (dibatalkan, grup bubar): reaksinya dan reaksi yang menunggunya ikut hilang.
  _rxDrop(ids) {
    let held = false;
    for (const id of ids) {
      Rx.dropMsg(this.store.react, id);
      if (this._rxPend.size && Rx.release(this._rxPend, id).length) held = true;
    }
    if (held) this._rxHoldSave();
  },

  // ---- tampilan ----
  // Reaksi orang yang kublokir hilang dari tampilanku (hanya tampilan: datanya tetap, muncul lagi saat blokir dibuka).
  _rxRow(mid) {
    const row = this.store.react[mid], vis = {};
    if (row) for (const [by, r] of Object.entries(row)) if (by === this.id || !this.isBlocked(by)) vis[by] = r;
    return vis;
  },
  // Chip di bawah gelembung: [{ e, n, mine, by }] (lihat Rx.summary). Kosong bila tidak ada reaksi.
  reactions(mid) {
    mid = String(mid);
    if (!this.store.react[mid]) return [];
    return Rx.summary({ [mid]: this._rxRow(mid) }, mid, this.id);
  },
  _rxName(id, scope) {
    if (id === this.id) return this.name;
    const g = scope && scope.startsWith('g:') ? this.store.groups[scope.slice(2)] : null, gm = g && g.members.find((x) => x.id === id);
    const p = this.peers.get(id);
    return (gm && gm.name) || (p && p.name) || id.slice(0, 6);
  },
  // Siapa saja yang memberi emoji e pada pesan mid (tekan lama pada chip): [{ id, name }], terlama dulu.
  reactWho(mid, e) {
    mid = String(mid);
    const t = HEX32.test(mid) ? this.store.msgs[mid] : null, scope = t ? this._chatKey(t) : null;
    const em = Rx.cleanEmoji(e);
    if (!em || !this.store.react[mid]) return [];
    return Rx.who({ [mid]: this._rxRow(mid) }, mid, em).map((id) => ({ id, name: this._rxName(id, scope) }));
  },
  // Emoji yang terakhir kupakai, terbaru di depan.
  reactRecent() { return Rx.pushRecent(this.store.reactRecent, null); },

  // ---- mengirim ----
  // Apakah semua peserta chat bisa menerima reaksi? Peer yang hello-nya sudah dikenal tetapi tidak punya caps 'rx' memakai versi lama: ia akan menampilkan
  // pesan kontrol sebagai teks biasa. Peer yang belum pernah kudengar kabarnya (caps belum dikenal) dianggap bisa. Mengembalikan { ok, old: [id] }.
  rxSupport(scope) {
    scope = String(scope);
    const g = scope.startsWith('g:') ? this.store.groups[scope.slice(2)] : null;
    // Publik: yang dihitung hanya peer yang sedang online (yang lain tidak bisa kutahu, dan pesan lama tidak memuat pembawa baru untuk mereka)
    const ids = scope === 'public' ? [...this.peers.values()].filter((p) => this.isOnline(p)).map((p) => p.id) : g ? g.members.map((x) => x.id) : HEX16.test(scope) ? [scope] : [];
    const old = ids.filter((id) => {
      if (id === this.id || this.isBlocked(id)) return false;
      const p = this.peers.get(id);
      return !!p && Array.isArray(p.caps) && !p.caps.includes('rx');
    });
    return { ok: !old.length, old };
  },
  _rxSendCheck(scope) {
    if (scope === 'public') { /* tidak ada kunci/keanggotaan; hanya pemeriksaan versi di bawah */ } else if (scope.startsWith('g:')) {
      const g = this.store.groups[scope.slice(2)];
      if (!g) throw ek('e.group.unknown', null, 'Grup tidak dikenal');
      if (g.removed) throw ek('e.group.removed', null, 'Kamu sudah dikeluarkan dari grup ini');
      if (!g.eps[g.epoch]) throw ek('e.rx.noGroupKey', null, 'Kunci enkripsi grup belum tersedia');
    } else {
      if (!HEX16.test(scope) || scope === this.id) throw ek('e.msg.chatUnknown', null, 'Chat tidak dikenal');
      if (this.isBlocked(scope)) throw ek('e.rx.blocked', null, 'Kamu memblokir orang ini. Buka blokirnya dulu untuk bereaksi.');
      if (!this._pairKey(scope)) throw ek('e.file.noKey', null, 'Kunci enkripsi belum tersedia (peer versi lama atau belum terlihat)');
    }
    const s = this.rxSupport(scope);
    if (!s.ok) throw ek('e.rx.old', { names: s.old.map((id) => this._rxName(id, scope)).join(', ') }, 'Reaksi belum bisa dipakai di chat ini: {names} masih memakai versi lama.');
  },
  // Ketuk emoji e pada pesan mid: sama dengan reaksiku sekarang = cabut, lain = pasang/ganti. Berlaku di sini seketika, dikirim ±RX_BATCH_MS kemudian.
  // Mengembalikan { e, ts }; e kosong = reaksi dicabut.
  react(mid, e) {
    mid = String(mid);
    const t = HEX32.test(mid) ? this.store.msgs[mid] : null;
    if (!t || t.kind === 'ginv' || this.store.hidden[mid] || this._isCtlMsg(t) || (t.from !== this.id && this.isBlocked(t.from))) throw ek('e.msg.notFound', null, 'Pesan tidak ditemukan (mungkin sudah dibatalkan atau dibersihkan)');
    const scope = this._chatKey(t);
    this._rxSendCheck(scope);
    const em = Rx.cleanEmoji(e);
    if (!em) throw new Error('Emoji tidak valid');
    if (!this._rxOut.take(this.id, 1, this._wall())) throw ek('e.rx.tooFast', null, 'Terlalu cepat bereaksi. Tunggu sebentar.');
    const rec = Rx.toggle(this.store.react, this.id, mid, em, this._tsNow());
    Rx.prune(this.store.react);
    if (rec.e) this.store.reactRecent = Rx.pushRecent(this.store.reactRecent, rec.e);
    let q = this._rxQ.get(scope);
    if (!q) this._rxQ.set(scope, q = Rx.queue());
    Rx.enqueue(q, rec);
    if (!this._rxT) this._rxT = setTimeout(() => { this._rxT = null; this._rxFlush(); }, Rx.RX_BATCH_MS);
    this._save(); this.emit('update');
    return { e: rec.e, ts: rec.ts };
  },
  // Kirim semua ketukan yang menunggu (satu pesan kontrol per chat, atau lebih bila melewati batas jumlah/byte). Dipanggil timer batch dan stop().
  // Pengiriman yang gagal (mis. aku dikeluarkan dari grup dalam jeda itu) dicatat saja: keadaan lokal tetap, dan ketukan berikutnya menyebarkannya lagi.
  _rxFlush() {
    clearTimeout(this._rxT); this._rxT = null;
    for (const [scope, q] of [...this._rxQ]) {
      this._rxQ.delete(scope);
      for (const text of Rx.flush(q)) {
        try { this._send(text, scope); } catch (e) { this.log('reaksi gagal dikirim ke ' + scope + ': ' + e.message); }
      }
    }
  },
};

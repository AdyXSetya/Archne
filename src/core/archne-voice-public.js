'use strict';
// src/core/archne-voice-public.js — channel suara publik (pv*) + presence
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const crypto = require('crypto');
const Pv = require('../archne-pvch');
const { ek } = require('./archne-ecode'); // i18n (E9e)
const { HEX16, HLC_DRIFT, PV_BAD_MAX, PV_BAD_MS, SYNC_PUB_BYTES, VC_TRY_MAX } = require('./archne-constants');
const { fitBytes, verifyMsg } = require('./archne-util');

module.exports = {
  // ---- Channel voice publik (v0.20.0, pvch2): penyimpanan dan penyebaran ----
  // Rekaman channel (lihat archne-pvch.js) dibawa pesan bertanda tangan bertujuan 'pvch'. Ini BUKAN pesan chat: tidak masuk store.msgs, jadi tidak tampil,
  // tidak ikut "Bersihkan chat", tidak terdorong keluar dari jendela sync 500 pesan publik oleh obrolan ramai, dan aplikasi versi lama menolaknya
  // (_allowed). store.pvm = { [msgId]: pesan } hanya berisi pesan yang masih membawa versi terkini sebuah channel; this.pv (peta channel) adalah
  // turunannya dan dibangun ulang saat memuat dan saat memblokir. Penyebaran: dorong langsung ke peer online + sync (pvh = versi yang kupunya).
  // Karena bertanda tangan pemiliknya, pesan boleh diteruskan peer mana pun, jadi channel tetap ada walau pemiliknya offline.
  _pvApplyMsg(m, map, ref) {
    const recs = Pv.parseCtl(m.text);
    if (!recs) return 0;
    const lim = this._wall() + HLC_DRIFT; // ts rekaman jauh di masa depan akan menang selamanya: tolak
    let n = 0;
    for (const r of recs) {
      if (!r || typeof r !== 'object' || !(r.ts <= lim)) continue;
      if (Pv.applyRemote(map, m.from, r) === 'applied') { ref[r.id] = m.id; n++; }
    }
    return n;
  },
  _pvGc() {
    for (const cid of Object.keys(this._pvRef)) if (!this.pv[cid]) delete this._pvRef[cid];
    const keep = new Set(Object.values(this._pvRef));
    for (const id of Object.keys(this.store.pvm)) if (!keep.has(id)) delete this.store.pvm[id];
  },
  // Bangun ulang peta dari pesan yang tersimpan, tanpa pesan dari orang yang kublokir (pesan mereka dibuang; kembali lewat sync saat dibuka blokirnya).
  _pvRebuild() {
    const map = {}, ref = {};
    const ms = Object.values(this.store.pvm).filter((m) => m && typeof m === 'object' && m.to === 'pvch' && typeof m.id === 'string' && typeof m.text === 'string' && HEX16.test(String(m.from)) && Number.isFinite(m.ts) && !this.isBlocked(m.from))
      .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    this.store.pvm = {};
    for (const m of ms) { this.store.pvm[m.id] = m; this._pvApplyMsg(m, map, ref); }
    this.pv = map; this._pvRef = ref;
    this._pvGc();
  },
  // Terima satu pesan kontrol (dari dorongan langsung atau sync). 'new' | 'stale' (sah tapi tidak mengubah apa pun, tidak disimpan) | 'dup' | 'bad'.
  _pvIngest(m) {
    if (!m || typeof m !== 'object' || m.to !== 'pvch' || m.kind !== undefined || !verifyMsg(m)) return 'bad';
    if (this.store.pvm[m.id]) return 'dup';
    if (m.from !== this.id && this.isBlocked(m.from)) return 'dup';
    if (m.ts > this._wall() + HLC_DRIFT || Pv.parseCtl(m.text) === null) return 'bad';
    if (!this._pvApplyMsg(m, this.pv, this._pvRef)) return 'stale'; // applyRemote hanya mengubah peta bila 'applied'
    this.store.pvm[m.id] = m;
    this._pvGc();
    this._tsSeen(m.ts);
    this._save(); this.emit('update');
    return 'new';
  },
  // Pesan yang diminta peer: untuk tiap channel yang versinya lebih baru dari yang dia punya (pvh = { cid: v }), kecuali dari pengirim yang dia blokir (pvb).
  _pvForSync(pvh, pvb) {
    const have = pvh && typeof pvh === 'object' && !Array.isArray(pvh) ? pvh : {};
    const skip = new Set(Array.isArray(pvb) ? pvb.slice(0, 200).map(String) : []);
    const ids = new Set();
    for (const [cid, c] of Object.entries(this.pv)) {
      const mid = this._pvRef[cid], m = mid && this.store.pvm[mid];
      if (!m || skip.has(m.from) || (Number.isSafeInteger(have[cid]) && have[cid] >= c.v)) continue;
      ids.add(mid);
    }
    return fitBytes([...ids].map((id) => this.store.pvm[id]).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)).slice(0, 800), SYNC_PUB_BYTES);
  },
  _pvPush(m) {
    for (const p of this.peers.values()) if (this.isOnline(p) && !this.isBlocked(p.id)) this._request(p, { t: 'pvch', m });
  },
  // Ubah lokal lalu sebarkan. Kalau gagal di tengah jalan, perubahan lokal dibatalkan supaya tidak menyimpang dari node lain.
  _pvCommit(fn) {
    const snap = JSON.stringify(this.pv);
    try {
      const ch = fn(this.pv);
      const m = this._makeMsg('pvch', null, Pv.encodeCtl([ch]));
      this.store.pvm[m.id] = m; this._pvRef[ch.id] = m.id;
      this._pvGc();
      this._save(); this.emit('update');
      this._pvPush(m);
      return ch;
    } catch (e) { this.pv = JSON.parse(snap); throw e; }
  },
  // Daftar channel untuk UI, tanpa pemeriksa PIN. Bawaan: hanya channel yang ada orangnya + milikku sendiri (supaya aku tetap bisa masuk/kelola/hapus);
  // opts.empty = true menampilkan semuanya. Urutan: paling ramai dulu. count = jumlah orang, people = tiga orang pertama (aku lebih dulu), inside = aku di dalamnya.
  pvList(opts) {
    const all = !!(opts && opts.empty), here = this._pvHereAll();
    return Pv.live(this.pv).map((c) => {
      const ppl = here.get(c.id) || [];
      return { id: c.id, name: c.name, by: c.by, locked: c.locked, ts: c.ts, mine: c.by === this.id, canManage: Pv.canManage(c, this.id),
        count: ppl.length, people: ppl.slice(0, 3), inside: !!(this._pvMe && this._pvMe.cid === c.id), full: !Pv.hasRoom(ppl.length) };
    }).filter((c) => all || c.count > 0 || c.mine)
      .sort((x, y) => y.count - x.count || x.ts - y.ts || (x.id < y.id ? -1 : 1));
  },
  pvCreate(name, pin) { return this._pvCommit((map) => Pv.create(map, this.id, Pv.newId(this.id), name, pin, this._tsNow())).id; },
  pvDelete(cid) {
    cid = String(cid);
    this._pvCommit((map) => Pv.remove(map, this.id, cid, this._tsNow()));
    if (this._pvMe && this._pvMe.cid === cid) this.pvLeave();
    return true;
  },
  pvUpdate(cid, patch) { this._pvCommit((map) => Pv.update(map, this.id, String(cid), patch || {}, this._tsNow())); return true; },
  // ---- Kehadiran + masuk/keluar + audio mesh channel publik (v0.20.0, pvch3-pvch4). Sinyal langsung 'pp' (jalur 'call'), tidak disimpan. ----
  // Beda dengan voice grup: disiarkan ke SEMUA peer online (bukan anggota grup). Satu orang hanya di satu channel. Disiarkan saat masuk/keluar,
  // diulang berkala (yang baru tersambung atau tadi kehilangan sinyal tetap tahu), dan dijawab sendiri ke peer yang baru online. Hanya di memori.
  // PIN: channel terkunci diperiksa OLEH PENERIMA. Sinyal masuk membawa PIN (terenkripsi per pasangan, ditandatangani); penerima memeriksanya dengan
  // hash+salt dari data channelnya sendiri, dan hanya yang lolos dihitung hadir / boleh menyambung audio. Pemilik tidak perlu PIN. Percobaan salah dibatasi.
  // Ruang audio = cid channel (kaki dipakai ulang dari panggilan grup), maksimal PV_MAX_MEMBERS orang. Satu panggilan sekaligus: lihat pvEnter.
  // Channel yang terlihat (tidak dihapus, termasuk dalam batas per pemilik). Selain itu null.
  _pvChan(cid) { const ch = this.pv[cid]; return ch && !ch.del && Pv.live(this.pv).some((c) => c.id === cid) ? ch : null; },
  _pvRoom(room) { return this._pvMe && this._pvMe.cid === room ? this._pvMe : null; },
  // Penanda kunci channel: berubah kalau channel dikunci atau PIN-nya diganti (hash baru), supaya yang masuk dengan kunci lama gugur.
  _pvLk(ch) { return ch && ch.locked ? ch.hash : ''; },
  // Orang ini sah di channel? Pemilik selalu; selain itu kunci yang dulu dia lolosi harus masih sama dengan kunci sekarang (tanpa kunci: ''). Peer yang tidak tercatat hadir hanya sah di channel gratis.
  _pvAllowed(id, cid) {
    const ch = this._pvChan(cid);
    if (!ch || this.isBlocked(id)) return false;
    if (ch.by === id || !ch.locked) return true;
    const x = this._pvAt.get(id);
    return !!(x && x.cid === cid && x.lk === this._pvLk(ch));
  },
  // cid -> daftar orang di sana menurut pengetahuanku, aku lebih dulu lalu urut nama. Disaring saat dibaca: channel masih terlihat,
  // peer masih dikenal, online, tidak diblokir, belum kedaluwarsa, dan masih sah (PIN lolos untuk kunci yang sekarang).
  _pvHereAll() {
    const live = Pv.live(this.pv), vis = new Map(live.map((c) => [c.id, c])), now = Date.now(), ttl = this._vcTtlMs(), by = new Map();
    const add = (cid, x) => { const a = by.get(cid); if (a) a.push(x); else by.set(cid, [x]); };
    if (this._pvMe && vis.has(this._pvMe.cid)) add(this._pvMe.cid, { id: this.id, name: this.name, me: true });
    for (const [id, x] of this._pvAt) {
      const ch = vis.get(x.cid);
      if (!ch || now - x.at > ttl || (ch.by !== id && x.lk !== this._pvLk(ch))) continue;
      const p = this.peers.get(id);
      if (!p || !this.isOnline(p) || this.isBlocked(id)) continue;
      add(x.cid, { id, name: p.name });
    }
    for (const a of by.values()) a.sort((x, y) => (x.me ? 0 : 1) - (y.me ? 0 : 1) || (x.name < y.name ? -1 : x.name > y.name ? 1 : x.id < y.id ? -1 : 1));
    return by;
  },
  _pvHere(cid) { return this._pvHereAll().get(String(cid)) || []; },
  _pvMsg(cid, on) {
    const o = { t: 'pp', cid, on }, me = this._pvMe;
    if (on === 1 && me && me.cid === cid && me.pin) o.pin = me.pin; // PIN ikut (terenkripsi): penerima yang memeriksanya
    return o;
  },
  _pvBroadcast(cid, on) {
    let n = 0;
    for (const p of this.peers.values()) {
      if (!this.isOnline(p) || this.isBlocked(p.id)) continue;
      n++; this._callSend(p.id, this._pvMsg(cid, on)).catch(() => {});
    }
    return n;
  },
  // Masuk channel. Pemilik masuk tanpa PIN; channel terkunci perlu PIN yang benar (diperiksa di sini, dan lagi oleh tiap penerima); ada batas orang;
  // dan tidak bisa masuk selagi ada panggilan lain (satu panggilan sekaligus; pindah channel publik boleh, kaki channel lama dilepas).
  pvEnter(cid, pin) {
    cid = String(cid);
    const ch = this._pvChan(cid);
    if (!ch) throw ek('e.vc.gone', null, 'Channel tidak ditemukan');
    if (!Pv.canJoin(ch, this.id, pin)) throw Object.assign(new Error('PIN salah'), { code: 'pin' }); // code: UI membedakan PIN salah dari galat lain
    const old = this._pvMe, same = !!(old && old.cid === cid);
    if (!same) {
      if ([...this._calls.values()].some((c) => !(old && c.room === old.cid)) || this._joins.size || this._invIn.size || this._vcMe) throw ek('e.call.busy', null, 'Masih ada panggilan yang berlangsung');
      if (!Pv.hasRoom(this._pvHere(cid).length)) throw ek('e.vc.full', { max: Pv.PV_MAX_MEMBERS }, 'Channel sudah penuh (maksimal {max} orang)');
    }
    if (old && !same) { this._pvBroadcast(old.cid, 0); this._vcCloseLegs(old.cid, 'ended'); this._roomEnd(old.cid); this.emit('pvpres', { cid: old.cid, peer: this.id, name: this.name, on: 0, me: true }); }
    this._pvMe = { cid, pin: ch.locked && ch.by !== this.id ? String(pin) : null, lk: this._pvLk(ch) };
    this._pvNext = Date.now() + this._vcBeatMs();
    this._pvBroadcast(cid, 1);
    this.emit('pvpres', { cid, peer: this.id, name: this.name, on: 1, me: true });
    this.emit('update');
    if (!same) { this._vcTry.clear(); for (const x of this._pvHere(cid)) if (!x.me) this._pvNeed(cid, x.id); }
    return true;
  },
  pvLeave() {
    const me = this._pvMe;
    if (!me) return false;
    this._pvBroadcast(me.cid, 0);
    this._vcCloseLegs(me.cid, 'ended'); // selagi masih tercatat sebagai ruang channel: tidak masuk riwayat, 'last' tidak dikirim
    this._pvMe = null;
    this._vcTry.clear();
    this._roomEnd(me.cid);
    this.emit('pvpres', { cid: me.cid, peer: this.id, name: this.name, on: 0, me: true });
    this.emit('update');
    return true;
  },
  // Perlu kaki audio ke orang ini? Sama dengan voice grup: hanya sisi ber-id lebih kecil yang menelepon ('legneed' -> UI membuat SDP -> callLeg).
  // Dibatasi: tidak dobel, hanya ke yang sah, tidak ke yang offline/diblokir/tanpa kunci, dan paling banyak VC_TRY_MAX kali gagal beruntun per orang.
  _pvNeed(room, peerId, retry) {
    const me = this._pvRoom(room);
    if (!me || !(this.id < peerId) || this._legs(room).some((x) => x.peer === peerId) || !this._pvAllowed(peerId, room)) return false;
    const p = this.peers.get(peerId);
    if (!p || !this.isOnline(p) || !this._pairKey(peerId)) return false;
    if (this._legs(room).length + 1 >= Pv.PV_MAX_MEMBERS) return false;
    const now = Date.now(), t = this._vcTry.get(peerId);
    if (retry && t && (t.n >= VC_TRY_MAX || now - t.at < (this.opts.vcRetryMs || 8000))) return false;
    this._vcTry.set(peerId, { at: now, n: (t ? t.n : 0) + 1 });
    this.emit('call', { ev: 'legneed', room, peer: peerId, name: p.name, pv: { cid: room } });
    return true;
  },
  _pvDrop(id, expired) {
    const x = this._pvAt.get(id);
    if (!x) return;
    this._pvAt.delete(id);
    if (this._pvRoom(x.cid)) this._vcCloseLegs(x.cid, 'ended', (l) => l.peer === id && (!expired || l.state !== 'active')); // keluar/diblokir: kakinya ditutup; kedaluwarsa: hanya yang belum aktif
    this._vcTry.delete(id);
    this.emit('pvpres', { cid: x.cid, peer: id, name: (this.peers.get(id) || {}).name || '?', on: 0 });
    this.emit('update');
  },
  // Kegagalan PIN dari satu orang: maksimal PV_BAD_MAX per PV_BAD_MS, selebihnya diabaikan tanpa memeriksa (juga menghemat CPU: scrypt mahal).
  _pvBadBlocked(id) { const b = this._pvBad.get(id); return !!(b && Date.now() - b.at < (this.opts.pvBadMs || PV_BAD_MS) && b.n >= PV_BAD_MAX); },
  _pvBadAdd(id) {
    const now = Date.now(), b = this._pvBad.get(id);
    this._pvBad.set(id, b && now - b.at < (this.opts.pvBadMs || PV_BAD_MS) ? { n: b.n + 1, at: b.at } : { n: 1, at: now });
    if (this._pvBad.size > 500) for (const [k, v] of this._pvBad) if (now - v.at > (this.opts.pvBadMs || PV_BAD_MS)) this._pvBad.delete(k);
  },
  _pvPresIn(m, o, name, ack) {
    if (!this.peers.get(m.from)) return ack(true); // bukan peer yang kukenal: diabaikan (juga membatasi ukuran peta kehadiran)
    const prev = this._pvAt.get(m.from);
    if (o.on === 0) {
      if (prev && prev.cid === o.cid) this._pvDrop(m.from);
      return ack(true);
    }
    if (o.on !== 1) return ack(false);
    // Channel belum kukenal (sinkron daftar belum sampai) atau sudah dihapus: diabaikan. Siaran ulang berkala memperbaikinya nanti.
    const ch = this._pvChan(o.cid);
    if (!ch) return ack(true);
    const same = !!(prev && prev.cid === o.cid), lk = this._pvLk(ch);
    let ph = '';
    if (ch.by !== m.from && ch.locked) { // channel terkunci: periksa PIN-nya
      const pin = typeof o.pin === 'string' ? o.pin : '';
      ph = crypto.createHash('sha256').update(pin).digest('hex');
      if (!(same && prev.lk === lk && prev.ph === ph)) { // PIN yang sama untuk kunci yang sama sudah pernah lolos: tidak diperiksa ulang
        if (this._pvBadBlocked(m.from)) return ack(true);
        if (!Pv.checkPin(ch, pin)) {
          this._pvBadAdd(m.from);
          if (prev) this._pvDrop(m.from); // dulu lolos dengan kunci lain, sekarang tidak: gugur
          return ack(true);
        }
      }
    }
    if (!same && !Pv.hasRoom(this._pvHere(o.cid).length)) return ack(true); // penuh: yang baru tidak dihitung (yang sudah di dalam tetap)
    if (prev && !same) this._pvDrop(m.from); // pindah channel: yang lama dilepas dulu
    this._pvAt.set(m.from, { cid: o.cid, at: Date.now(), lk, ph });
    if (!same) { this._vcTry.delete(m.from); this.emit('pvpres', { cid: o.cid, peer: m.from, name, on: 1 }); this.emit('update'); }
    if (this._pvRoom(o.cid)) this._pvNeed(o.cid, m.from, same); // dia ada di channelku: sambungkan audio (kalau aku sisi penelepon)
    return ack(true);
  },
  // Peer baru online: beri tahu dia kalau aku sedang di sebuah channel.
  _pvGreet(p) {
    const me = this._pvMe;
    if (me) this._callSend(p.id, this._pvMsg(me.cid, 1)).catch(() => {});
  },
  // Aku dikeluarkan dari channel (dihapus / dikunci / PIN diganti): keluar otomatis dan UI diberi tahu alasannya.
  _pvKick(cid, reason) {
    this.pvLeave();
    this.emit('pvkick', { cid, reason });
  },
  _pvTick() {
    const now = Date.now(), me = this._pvMe;
    if (me) {
      const ch = this._pvChan(me.cid);
      if (!ch) this._pvKick(me.cid, 'deleted'); // dihapus oleh pemilik (atau pemiliknya kublokir)
      else if (ch.by !== this.id && this._pvLk(ch) !== me.lk) { // kunci berubah: aku harus masih lolos dengan PIN-ku
        if (Pv.canJoin(ch, this.id, me.pin)) { me.lk = this._pvLk(ch); me.pin = ch.locked ? me.pin : null; }
        else this._pvKick(me.cid, me.lk ? 'pin' : 'locked');
      } else if (now >= this._pvNext) { this._pvNext = now + this._vcBeatMs(); this._pvBroadcast(me.cid, 1); }
    }
    for (const [id, x] of [...this._pvAt]) {
      const ch = this._pvChan(x.cid);
      if (now - x.at > this._vcTtlMs() || !ch || (ch.by !== id && x.lk !== this._pvLk(ch))) this._pvDrop(id, !!ch && now - x.at > this._vcTtlMs());
    }
    if (this._pvMe) { // perbaiki yang belum tersambung / putus, dan lepas kaki orang yang tidak (lagi) sah
      const cur = this._pvMe;
      this._vcCloseLegs(cur.cid, 'ended', (l) => !this._pvAllowed(l.peer, cur.cid));
      for (const x of this._pvHere(cur.cid)) if (!x.me) this._pvNeed(cur.cid, x.id, true);
    }
  },
};

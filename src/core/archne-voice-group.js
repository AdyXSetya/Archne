'use strict';
// src/core/archne-voice-group.js — channel suara grup (vc*) + presence
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const crypto = require('crypto');
const Vc = require('../archne-vchan');
const { CALL_MAX_PEERS, VC_BEAT_MS, VC_TRY_MAX, VC_TTL_MS } = require('./archne-constants');
const { ek } = require('./archne-ecode');

module.exports = {
  _isAdminOf(g, id) { return !!g && (g.creator === id || (g.admins || []).includes(id)); },
  // ---- Channel voice grup (v0.19.0, langkah 1: aturan dan data lokal; penyebaran ke anggota lain menyusul di langkah 2) ----
  _vcGroup(gid) {
    const g = this.store.groups[String(gid)];
    if (!g) throw ek('e.group.unknown', null, 'Grup tidak dikenal');
    if (g.removed) throw ek('e.group.removed', null, 'Kamu sudah dikeluarkan dari grup ini');
    return g;
  },
  vcList(gid) {
    const g = this.store.groups[String(gid)];
    if (!g || g.removed) return [];
    return Vc.live(g).sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1))
      .map((c) => ({ id: c.id, name: c.name, by: c.by, locked: c.locked, allow: [...c.allow], ts: c.ts, canJoin: Vc.canJoin(g, c, this.id), canManage: Vc.canManage(g, c, this.id), here: this._vcHere(g, c.id) }));
  },
  // Pesan kontrol channel: g1 tersembunyi berisi rekaman channel (lihat archne-vchan.js). null = bukan pesan kontrol channel.
  _vcCtl(m) {
    if (m.kind !== 'g1') return null;
    return Vc.parseCtl(this._open(m));
  },
  _applyVcCtl(m, recs) {
    if (this.isBlocked(m.from)) return false;
    const g = this.store.groups[m.to.slice(2)];
    if (!g) return false;
    let changed = false;
    for (const r of recs) if (Vc.applyRemote(g, m.from, r) === 'applied') changed = true;
    return changed;
  },
  // Ubah lokal lalu sebarkan. Kalau pengiriman gagal (mis. kunci grup belum ada), perubahan lokal dibatalkan supaya tidak menyimpang dari anggota lain.
  _vcCommit(g, fn) {
    const snap = JSON.stringify(g.vch || {});
    try {
      const ch = fn();
      this._send(Vc.encodeCtl([ch]), 'g:' + g.id);
      this._save(); this.emit('update');
      return ch;
    } catch (e) { g.vch = JSON.parse(snap); throw e; }
  },
  // Umumkan ulang channel yang hidup (dipanggil admin setelah menambah anggota: anggota baru tidak menerima riwayat lama).
  _vcAnnounce(g) {
    const recs = Vc.live(g).filter((c) => Vc.canManage(g, c, this.id));
    if (!recs.length) return 0;
    this._send(Vc.encodeCtl(recs), 'g:' + g.id);
    return recs.length;
  },
  vcCreate(gid, name, locked, allow) {
    const g = this._vcGroup(gid);
    return this._vcCommit(g, () => Vc.create(g, this.id, crypto.randomBytes(8).toString('hex'), name, locked, allow, this._tsNow())).id;
  },
  vcDelete(gid, cid) {
    const g = this._vcGroup(gid);
    this._vcCommit(g, () => Vc.remove(g, this.id, String(cid), this._tsNow()));
    return true;
  },
  vcUpdate(gid, cid, patch) {
    const g = this._vcGroup(gid);
    this._vcCommit(g, () => Vc.update(g, this.id, String(cid), patch || {}, this._tsNow()));
    return true;
  },
  // ---- Presence channel voice (langkah 3): siapa yang sedang di channel mana. Sinyal langsung 't:vp' (jalur 'call'), tidak disimpan. ----
  // Satu orang hanya di satu channel sekaligus. Kehadiran disiarkan ke anggota grup yang online saat masuk/keluar, disiarkan ulang berkala
  // (supaya yang baru tersambung atau yang tadi kehilangan sinyal tetap tahu), dan dijawab sendiri ke peer yang baru online.
  // Langkah ini baru presence: sambungan audio (mesh) menyusul di langkah 4.
  _vcBeatMs() { return this.opts.vcBeatMs || VC_BEAT_MS; },
  _vcTtlMs() { return this.opts.vcTtlMs || VC_TTL_MS; },
  _vcBroadcast(gid, cid, on) {
    const g = this.store.groups[gid];
    if (!g || g.removed) return 0;
    let n = 0;
    for (const x of g.members) {
      if (x.id === this.id) continue;
      const p = this.peers.get(x.id);
      if (!p || !this.isOnline(p) || this.isBlocked(x.id)) continue;
      n++; this._callSend(x.id, { t: 'vp', cid, g: gid, on }).catch(() => {});
    }
    return n;
  },
  vcEnter(gid, cid) {
    const g = this._vcGroup(gid); cid = String(cid);
    const ch = g.vch && g.vch[cid];
    if (!ch || ch.del) throw ek('e.vc.gone', null, 'Channel tidak ditemukan');
    if (!Vc.canJoin(g, ch, this.id)) throw ek('e.vc.noPerm', null, 'Kamu tidak punya izin masuk channel ini');
    const old = this._vcMe, same = !!(old && old.gid === g.id && old.cid === cid);
    if (!same) {
      // panggilan lain (selain kaki channel lama yang akan kulepas) sedang berjalan: channel tidak bisa dimasuki
      if ([...this._calls.values()].some((c) => !(old && c.room === old.cid)) || this._joins.size || this._invIn.size || this._pvMe) throw ek('e.call.busy', null, 'Masih ada panggilan yang berlangsung');
      if (this._vcHere(g, cid).filter((x) => !x.me).length >= CALL_MAX_PEERS - 1) throw ek('e.vc.full', { max: CALL_MAX_PEERS }, 'Channel sudah penuh (maksimal {max} orang)');
    }
    if (old && !same) { this._vcBroadcast(old.gid, old.cid, 0); this._vcCloseLegs(old.cid, 'ended'); this._roomEnd(old.cid); }
    this._vcMe = { gid: g.id, cid };
    this._vcNext = Date.now() + this._vcBeatMs();
    this._vcBroadcast(g.id, cid, 1);
    this.emit('vcpres', { gid: g.id, cid, peer: this.id, name: this.name, on: 1, me: true });
    this.emit('update');
    if (!same) { this._vcTry.clear(); for (const x of this._vcHere(g, cid)) if (!x.me) this._vcNeed(cid, x.id); }
    return true;
  },
  vcLeave() {
    const me = this._vcMe;
    if (!me) return false;
    this._vcBroadcast(me.gid, me.cid, 0);
    this._vcCloseLegs(me.cid, 'ended'); // selagi masih tercatat sebagai ruang channel: tidak masuk riwayat, 'last' tidak dikirim
    this._vcMe = null;
    this._vcTry.clear();
    this._roomEnd(me.cid);
    this.emit('vcpres', { gid: me.gid, cid: me.cid, peer: this.id, name: this.name, on: 0, me: true });
    this.emit('update');
    return true;
  },
  // Ruang channel yang sedang kumasuki (null bila `room` bukan itu).
  _vcRoom(room) { return this._vcMe && this._vcMe.cid === room ? this._vcMe : null; },
  _vcCloseLegs(room, reason, only) {
    for (const l of this._legs(room)) if (!only || only(l)) this._callFinish(l, l.state === 'active' ? reason : 'cancelled', 'end');
  },
  // Perlu kaki audio ke anggota channel ini? Hanya sisi ber-id lebih kecil yang menelepon (event 'legneed' -> UI membuat SDP -> callLeg).
  // Dibatasi: tidak dobel, tidak ke yang offline/diblokir/tanpa kunci, dan paling banyak VC_TRY_MAX kali gagal beruntun per orang.
  _vcNeed(room, peerId, retry) {
    const me = this._vcRoom(room);
    if (!me || !(this.id < peerId) || this._legs(room).some((x) => x.peer === peerId)) return false;
    const g = this.store.groups[me.gid], p = this.peers.get(peerId);
    if (!g || g.removed || !Vc.canJoin(g, g.vch && g.vch[room], peerId)) return false;
    if (!p || !this.isOnline(p) || this.isBlocked(peerId) || !this._pairKey(peerId)) return false;
    if (this._legs(room).length + 1 >= CALL_MAX_PEERS) return false;
    const now = Date.now(), t = this._vcTry.get(peerId);
    if (retry && t && (t.n >= VC_TRY_MAX || now - t.at < (this.opts.vcRetryMs || 8000))) return false;
    this._vcTry.set(peerId, { at: now, n: (t ? t.n : 0) + 1 });
    this.emit('call', { ev: 'legneed', room, peer: peerId, name: p.name, vc: { gid: me.gid, cid: room } });
    return true;
  },
  // Siapa yang ada di channel ini menurut pengetahuanku. Disaring saat dibaca: masih anggota, masih online, tidak diblokir, masih berhak masuk, belum kedaluwarsa.
  _vcHere(g, cid) {
    const ch = g.vch && g.vch[cid];
    if (!ch || ch.del) return [];
    const now = Date.now(), ttl = this._vcTtlMs(), out = [];
    if (this._vcMe && this._vcMe.gid === g.id && this._vcMe.cid === cid) out.push({ id: this.id, name: this.name, me: true });
    for (const [id, x] of this._vcAt) {
      if (x.gid !== g.id || x.cid !== cid || now - x.at > ttl) continue;
      const p = this.peers.get(id);
      if (!p || !this.isOnline(p) || this.isBlocked(id) || !Vc.canJoin(g, ch, id)) continue;
      out.push({ id, name: p.name });
    }
    return out;
  },
  _vcDrop(id, expired) {
    const x = this._vcAt.get(id);
    if (!x) return;
    this._vcAt.delete(id);
    // dia keluar / diblokir: kaki audionya ke aku ditutup. Kedaluwarsa karena siaran hilang: hanya kaki yang belum aktif (yang aktif punya penjagaan sendiri).
    if (this._vcRoom(x.cid)) this._vcCloseLegs(x.cid, 'ended', (l) => l.peer === id && (!expired || l.state !== 'active'));
    this._vcTry.delete(id);
    this.emit('vcpres', { gid: x.gid, cid: x.cid, peer: id, name: (this.peers.get(id) || {}).name || '?', on: 0 });
    this.emit('update');
  },
  _vcPresIn(m, o, name, ack) {
    const gid = typeof o.g === 'string' && Object.prototype.hasOwnProperty.call(this.store.groups, o.g) ? o.g : null;
    const g = gid && this.store.groups[gid];
    if (!g || g.removed || !Vc.isMember(g, m.from) || !Vc.isMember(g, this.id)) return ack(true); // bukan urusanku / bukan anggota: diam-diam diabaikan
    const prev = this._vcAt.get(m.from);
    if (o.on === 0) {
      if (prev && prev.gid === gid && prev.cid === o.cid) this._vcDrop(m.from);
      return ack(true);
    }
    if (o.on !== 1) return ack(false);
    // Channel belum kukenal (sinkron daftar belum sampai), sudah dihapus, atau terkunci untuknya: diabaikan. Siaran ulang berkala memperbaikinya nanti.
    if (!Vc.canJoin(g, g.vch && g.vch[o.cid], m.from)) return ack(true);
    const same = prev && prev.gid === gid && prev.cid === o.cid;
    if (prev && !same) this._vcDrop(m.from); // pindah channel: yang lama dilepas dulu
    this._vcAt.set(m.from, { gid, cid: o.cid, at: Date.now() });
    if (!same) { this._vcTry.delete(m.from); this.emit('vcpres', { gid, cid: o.cid, peer: m.from, name, on: 1 }); this.emit('update'); }
    if (this._vcRoom(o.cid)) this._vcNeed(o.cid, m.from, !same ? false : true); // dia ada di channelku: sambungkan audio (kalau aku sisi penelepon)
    return ack(true);
  },
  // Peer baru online: beri tahu dia kalau aku sedang di sebuah channel dan dia anggota grupnya.
  _vcGreet(p) {
    const me = this._vcMe;
    if (!me) return;
    const g = this.store.groups[me.gid];
    if (!g || g.removed || !g.members.some((x) => x.id === p.id)) return;
    this._callSend(p.id, { t: 'vp', cid: me.cid, g: me.gid, on: 1 }).catch(() => {});
  },
  _vcTick() {
    const now = Date.now(), me = this._vcMe;
    if (me) {
      const g = this.store.groups[me.gid];
      if (!g || g.removed || !Vc.canJoin(g, g.vch && g.vch[me.cid], this.id)) this.vcLeave(); // channel dihapus / dikunci untukku / aku dikeluarkan
      else if (now >= this._vcNext) { this._vcNext = now + this._vcBeatMs(); this._vcBroadcast(me.gid, me.cid, 1); }
    }
    for (const [id, x] of [...this._vcAt]) if (now - x.at > this._vcTtlMs()) this._vcDrop(id, true);
    if (this._vcMe) { // perbaiki yang belum tersambung / putus, dan lepas kaki orang yang haknya dicabut
      const cur = this._vcMe, g = this.store.groups[cur.gid], ch = g && g.vch && g.vch[cur.cid];
      if (g) {
        this._vcCloseLegs(cur.cid, 'ended', (l) => !Vc.canJoin(g, ch, l.peer));
        for (const x of this._vcHere(g, cur.cid)) if (!x.me) this._vcNeed(cur.cid, x.id, true);
      }
    }
  },
  vcCanJoin(gid, cid, id) {
    const g = this.store.groups[String(gid)];
    return !!g && !g.removed && Vc.canJoin(g, g.vch && g.vch[String(cid)], id === undefined ? this.id : String(id));
  },
};

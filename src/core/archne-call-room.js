'use strict';
// src/core/archne-call-room.js — undangan, ruang, leg, media, end
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const crypto = require('crypto');
const Vc = require('../archne-vchan');
const Pv = require('../archne-pvch');
const { CALL_CAM_MAX, CALL_CID, CALL_CONN_MS, CALL_ICE_MAX, CALL_ICE_N, CALL_MAX_PEERS, CALL_RING_MS, CALL_SDP_MAX, HEX16, sdpVideo } = require('./archne-constants');
const { ek } = require('./archne-ecode');

module.exports = {
  // ---- Panggilan grup, bagian 1a: model ruang + undangan (bergabung menyusul di 1b) ----
  // Satu ruang = kumpulan kaki panggilan yang `room`-nya sama. Anggota = aku + lawan bicara tiap kaki.
  _callMembers(room) { return [this.id, ...[...this._calls.values()].filter((x) => x.room === room).map((x) => x.peer)].map((id) => ({ id, name: id === this.id ? this.name : ((this.peers.get(id) || {}).name || '?') })); },
  _invPending(room) { let n = 0; for (const k of this._invOut.keys()) if (k.startsWith(room + ':')) n++; return n; },
  // Undang satu orang online ke panggilan yang sedang aktif. Hasil akhirnya lewat event 'call': ev 'invitefail' { room, peer, reason: declined|busy|noanswer|refused|unreachable }.
  callInvite(cid, peerId, video) {
    const c = this._callGet(cid, null, 'active');
    if (this._vcRoom(c.room)) throw ek('e.call.vcNoInvite', null, 'Channel voice tidak bisa diundang lewat panggilan; yang berhak masuk lewat grupnya');
    if (this._pvRoom(c.room)) throw ek('e.call.pvNoInvite', null, 'Channel publik tidak bisa diundang lewat panggilan; siapa saja bisa masuk dari daftar channel');
    peerId = String(peerId);
    if (!HEX16.test(peerId) || peerId === this.id) throw new Error('ID tidak valid');
    if (this.isBlocked(peerId)) throw ek('e.profile.blockedPeer', null, 'Kamu memblokir orang ini. Buka blokirnya dulu.');
    const p = this.peers.get(peerId);
    if (!p || !this.isOnline(p)) throw ek('e.call.offline', null, 'Dia sedang offline');
    if (!this._pairKey(peerId)) throw ek('e.file.noKey', null, 'Kunci enkripsi belum tersedia (peer versi lama atau belum terlihat)');
    const mem = this._callMembers(c.room);
    if (mem.some((x) => x.id === peerId)) throw ek('e.call.already', null, 'Dia sudah ada di panggilan ini');
    const k = c.room + ':' + peerId;
    if (this._invOut.has(k)) throw ek('e.call.invPending', null, 'Undangan untuk orang ini masih menunggu jawaban');
    if (mem.length + this._invPending(c.room) >= CALL_MAX_PEERS) throw ek('e.call.full', { max: CALL_MAX_PEERS }, 'Panggilan sudah penuh (maksimal {max} peserta)');
    const t = setTimeout(() => { if (this._invOut.delete(k)) this.emit('call', { ev: 'invitefail', room: c.room, peer: peerId, name: p.name, reason: 'noanswer' }); }, this.opts.callRingMs || CALL_RING_MS);
    if (t.unref) t.unref();
    this._invOut.set(k, t);
    // anggota lain diberi tahu dulu supaya penelepon baru sudah dikenal saat tawarannya tiba
    const told = this._legs(c.room).filter((x) => x.state === 'active').map((x) => this._callQueue(x, { t: 'room', cid: x.cid, add: peerId }));
    Promise.all(told).then(() => this._callSend(peerId, Object.assign({ t: 'invite', cid: c.room, room: c.room, members: mem.map((x) => x.id) }, video === true ? { video: true } : {}))).then((ok) => {
      if (ok || !this._invOut.has(k)) return;
      clearTimeout(this._invOut.get(k)); this._invOut.delete(k);
      this.emit('call', { ev: 'invitefail', room: c.room, peer: peerId, name: p.name, reason: this.isOnline(this.peers.get(peerId)) ? 'refused' : 'unreachable' });
    });
    return true;
  },
  _invitedIn(m, o, name, ack) {
    const room = o.cid;
    if (this._invIn.has(room) || this._invIn.size >= CALL_MAX_PEERS) return ack(true);
    if (this._callBusy() || this._joins.size || this._vcMe || this._pvMe) { this._callSend(m.from, { t: 'invdec', cid: room, room, reason: 'busy' }); return ack(true); }
    const ids = Array.isArray(o.members) ? o.members : [];
    const set = new Set([m.from]);
    for (const id of ids) if (set.size < CALL_MAX_PEERS && typeof id === 'string' && HEX16.test(id) && id !== this.id) set.add(id);
    const members = [...set].map((id) => ({ id, name: String((this.peers.get(id) || (id === m.from ? { name } : {})).name || '?').slice(0, 32) }));
    const t = setTimeout(() => { this._invIn.delete(room); this.emit('call', { ev: 'inviteend', room, peer: m.from, reason: 'expired' }); }, this.opts.callRingMs || CALL_RING_MS);
    if (t.unref) t.unref();
    const vid = o.video === true; // ruang video: penerima menyalakan kamera saat menerima
    this._invIn.set(room, { room, from: m.from, name, members, timer: t, at: Date.now(), video: vid });
    this.emit('call', Object.assign({ ev: 'invited', room, cid: room, peer: m.from, name, members }, vid ? { video: true } : {}));
    return ack(true);
  },
  // ---- Panggilan grup, bagian 1b: bergabung + kaki antar-peserta ----
  _roomMax(room) { return this._pvRoom(room) ? Pv.PV_MAX_MEMBERS : CALL_MAX_PEERS; }, // channel publik sampai 16 orang; ruang lain CALL_MAX_PEERS
  _legs(room) { return [...this._calls.values()].filter((x) => x.room === room); },
  _expectTtl() { return (this.opts.callRingMs || CALL_RING_MS) + 2 * (this.opts.callConnMs || CALL_CONN_MS); },
  _expectAdd(room, id) {
    let m = this._expect.get(room);
    if (!m) this._expect.set(room, m = new Map());
    clearTimeout(m.get(id));
    const t = setTimeout(() => { const mm = this._expect.get(room); if (mm) { mm.delete(id); if (!mm.size) this._expect.delete(room); } }, this._expectTtl());
    if (t.unref) t.unref();
    m.set(id, t);
  },
  // Boleh menyambung sebagai satu kaki ruang? Ya kalau: aku sedang bergabung dan dia anggotanya, atau dia diumumkan/diundang oleh anggota ruang.
  _roomAuth(room, peer) {
    const vc = this._vcRoom(room); // ruang channel voice: yang berhak masuk channel ini (aturan dari data channelku sendiri) boleh menyambung
    if (vc) { const g = this.store.groups[vc.gid]; return !!g && !g.removed && !this.isBlocked(peer) && Vc.canJoin(g, g.vch && g.vch[room], peer); }
    if (this._pvRoom(room)) return this._pvAllowed(peer, room); // channel publik: pemilik, channel gratis, atau yang PIN-nya lolos kuperiksa
    const j = this._joins.get(room);
    if (j && j.members.includes(peer)) return true;
    const e = this._expect.get(room);
    return !!(e && e.has(peer)) || this._invOut.has(room + ':' + peer);
  },
  _roomAuthDel(room, peer) {
    const e = this._expect.get(room);
    if (e && e.has(peer)) { clearTimeout(e.get(peer)); e.delete(peer); if (!e.size) this._expect.delete(room); }
    const k = room + ':' + peer;
    if (this._invOut.has(k)) { clearTimeout(this._invOut.get(k)); this._invOut.delete(k); }
  },
  // Terima undangan: kirim 'join' ke semua anggota; untuk yang id-nya lebih besar, aku penelepon (event 'legneed' -> UI membuat SDP -> callLeg).
  callInviteAccept(room) {
    room = String(room);
    const iv = this._invIn.get(room);
    if (!iv) throw ek('e.call.invGone', null, 'Undangan tidak ditemukan');
    if (this._callBusy() || this._joins.size || this._vcMe || this._pvMe) throw ek('e.call.busy', null, 'Masih ada panggilan yang berlangsung');
    clearTimeout(iv.timer); this._invIn.delete(room);
    const ids = iv.members.map((x) => x.id).filter((id) => !this.isBlocked(id));
    const t = setTimeout(() => { if (this._joins.get(room) === j) { this._joins.delete(room); if (!this._legs(room).length) { this._roomEnd(room); this.emit('call', { ev: 'end', cid: room, room, peer: iv.from, name: iv.name, dir: 'in', reason: 'failed', wasActive: false, dur: 0, last: true }); } } }, this._expectTtl());
    if (t.unref) t.unref();
    const j = { room, members: ids, timer: t, from: iv.from, name: iv.name, at: Date.now(), info: iv.members, seen: new Set(), live: false };
    this._joins.set(room, j);
    this._rjoin.add(room);
    this.emit('call', { ev: 'joining', room, members: iv.members });
    for (const id of ids) {
      this._callSend(id, { t: 'join', cid: room, room });
      if (this.id < id) this.emit('call', { ev: 'legneed', room, peer: id, name: (iv.members.find((x) => x.id === id) || {}).name });
    }
    return true;
  },
  // Tawaran ruang channel (suara/publik) selalu memuat jalur video kosong supaya kamera bisa dinyalakan nanti: itu bukan panggilan video.
  _vidLeg(room, sdp) { return sdpVideo(sdp) && !this._vcRoom(room) && !this._pvRoom(room); },
  // Buat satu kaki ke anggota ruang (hanya sisi ber-id lebih kecil). sdp = tawaran dari UI.
  callLeg(room, peerId, sdp) {
    room = String(room); peerId = String(peerId);
    if (!CALL_CID.test(room) || !HEX16.test(peerId) || peerId === this.id) throw new Error('ID tidak valid');
    const legs = this._legs(room);
    if (legs.some((x) => x.peer === peerId)) throw ek('e.call.connected', null, 'Sudah tersambung ke dia');
    if (!this._roomAuth(room, peerId)) throw ek('e.call.noAuth', null, 'Tidak ada izin menyambung ke dia di ruang ini');
    if (typeof sdp !== 'string' || !sdp || sdp.length > CALL_SDP_MAX) throw new Error('SDP tidak valid');
    if (legs.length + 1 >= this._roomMax(room)) throw ek('e.call.full', { max: this._roomMax(room) }, 'Panggilan sudah penuh (maksimal {max} peserta)');
    const p = this.peers.get(peerId);
    if (this.isBlocked(peerId) || !p || !this.isOnline(p)) throw ek('e.call.offline', null, 'Dia sedang offline');
    if (!this._pairKey(peerId)) throw ek('e.file.noKey', null, 'Kunci enkripsi belum tersedia (peer versi lama atau belum terlihat)');
    const c = { cid: crypto.randomBytes(8).toString('hex'), room, peer: peerId, name: p.name, dir: 'out', state: 'dialing', at: Date.now(), q: Promise.resolve(), ice: 0, sent: 0, stn: 0, video: this._vidLeg(room, sdp) };
    this._calls.set(c.cid, c);
    const jn = this._joins.get(room); if (jn) jn.seen.add(peerId);
    this._roomAuthDel(room, peerId);
    this._callArm(c, this.opts.callRingMs || CALL_RING_MS, 'noanswer', 'end');
    this._callQueue(c, { t: 'offer', cid: c.cid, room, sdp }).then((ok) => { if (!ok) this._callFinish(c, this.isOnline(this.peers.get(peerId)) ? 'refused' : 'unreachable', null); });
    return c.cid;
  },
  // Tolak undangan masuk.
  callInviteDecline(room) {
    const iv = this._invIn.get(String(room));
    if (!iv) throw ek('e.call.invGone', null, 'Undangan tidak ditemukan');
    clearTimeout(iv.timer); this._invIn.delete(iv.room);
    this._callSend(iv.from, { t: 'invdec', cid: iv.room, room: iv.room, reason: 'declined' });
    return true;
  },
  callStart(peerId, sdp) {
    peerId = String(peerId);
    if (!HEX16.test(peerId) || peerId === this.id) throw new Error('ID tidak valid');
    if (this.isBlocked(peerId)) throw ek('e.profile.blockedPeer', null, 'Kamu memblokir orang ini. Buka blokirnya dulu.');
    if (typeof sdp !== 'string' || !sdp || sdp.length > CALL_SDP_MAX) throw new Error('SDP tidak valid');
    const p = this.peers.get(peerId);
    if (!p || !this.isOnline(p)) throw ek('e.call.offline', null, 'Dia sedang offline');
    if (!this._pairKey(peerId)) throw ek('e.file.noKey', null, 'Kunci enkripsi belum tersedia (peer versi lama atau belum terlihat)');
    if (this._callBusy() || this._joins.size || this._vcMe || this._pvMe) throw ek('e.call.busy', null, 'Masih ada panggilan yang berlangsung');
    const cid0 = crypto.randomBytes(8).toString('hex');
    const c = { cid: cid0, room: cid0, peer: peerId, name: p.name, dir: 'out', state: 'dialing', at: Date.now(), q: Promise.resolve(), ice: 0, sent: 0, stn: 0, video: sdpVideo(sdp) };
    this._calls.set(c.cid, c);
    this._callArm(c, this.opts.callRingMs || CALL_RING_MS, 'noanswer', 'end');
    this._callQueue(c, { t: 'offer', cid: c.cid, sdp }).then((ok) => { if (!ok) this._callFinish(c, this.isOnline(this.peers.get(peerId)) ? 'refused' : 'unreachable', null); });
    return c.cid;
  },
  _callGet(cid, dir, state) {
    const c = this._calls.get(String(cid));
    if (!c || (dir && c.dir !== dir) || (state && c.state !== state)) throw ek('e.call.badState', null, 'Panggilan tidak ditemukan atau keadaannya tidak sesuai');
    return c;
  },
  callAnswer(cid, sdp) {
    const c = this._callGet(cid, 'in', 'ringing');
    if (typeof sdp !== 'string' || !sdp || sdp.length > CALL_SDP_MAX) throw new Error('SDP tidak valid');
    c.state = 'connecting';
    this._callArm(c, this.opts.callConnMs || CALL_CONN_MS, 'failed', 'end');
    this._callQueue(c, { t: 'answer', cid: c.cid, sdp });
    return true;
  },
  callIce(cid, data) {
    const c = this._calls.get(String(cid));
    if (!c || typeof data !== 'string' || !data || data.length > CALL_ICE_MAX || c.sent >= CALL_ICE_N) return false;
    c.sent++;
    this._callQueue(c, { t: 'ice', cid: c.cid, data });
    return true;
  },
  // Siarkan status mik/deafen milikku ke semua kaki aktif di ruang (1-1 dan grup lewat jalur yang sama). Dipanggil UI setiap kali status berubah.
  // cam (opsional): true/false = kamera hidup/mati; undefined = tidak membawa kabar kamera (suara saja, atau peer lama).
  callMedia(room, muted, deafened, cam) {
    room = String(room);
    const legs = this._legs(room);
    if (!legs.length && !this._joins.has(room) && !this._vcRoom(room) && !this._pvRoom(room)) return false; // bukan ruangku: jangan simpan apa pun (tidak akan pernah dibersihkan)
    const d = deafened === true, mu = d || muted === true;
    const cv = cam === true || cam === false ? cam : undefined;
    const prev = this._callMy.get(room) || {};
    let vt = prev.vt;
    if (cv === true && (this._vcRoom(room) || this._pvRoom(room)) && prev.cam !== true) { // channel: kamera baru menyala, batasi jumlahnya
      if (this._chanCamList(room).length >= CALL_CAM_MAX) return 'full'; // penuh: tidak disimpan, tidak disiarkan
      vt = Date.now(); // urutan menyala (dibawa ke peserta lain untuk menentukan siapa yang lebih dulu bila dua orang menyala bersamaan)
    }
    const keep = cv === undefined ? (typeof prev.cam === 'boolean' ? { cam: prev.cam, vt: prev.vt } : {}) : cv ? { cam: true, vt } : { cam: false };
    this._callMy.set(room, Object.assign({ muted: mu, deafened: d }, keep));
    const kv = cv === undefined ? {} : { v: cv ? 1 : 0 };
    if (cv === true && vt) kv.vt = vt;
    for (const l of legs) if (l.state === 'active') this._callQueue(l, Object.assign({ t: 'st', cid: l.cid, m: mu ? 1 : 0, d: d ? 1 : 0 }, kv));
    return true;
  },
  // Yang kameranya hidup di ruang channel (aku + kaki aktif), urut: yang lebih dulu menyala di depan (vt, lalu id sebagai pemutus seri).
  // Urutan ini sama di semua peserta karena vt dibawa pengirimnya, jadi semua sepakat siapa yang masuk 4 teratas.
  _chanCamList(room) {
    const out = [], my = this._callMy.get(room);
    if (my && my.cam === true) out.push({ me: true, id: this.id, vt: my.vt || 0 });
    for (const l of this._legs(room)) if (l.state === 'active' && l.pst && l.pst.cam === true) out.push({ me: false, id: l.peer, vt: l.pst.vt || Number.MAX_SAFE_INTEGER });
    return out.sort((a, b) => (a.vt - b.vt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  },
  // Dua orang menyalakan kamera bersamaan lalu jumlahnya melebihi batas: yang urutannya di luar 4 teratas mematikan kameranya sendiri.
  _camEnforce(room) {
    if (!(this._vcRoom(room) || this._pvRoom(room))) return;
    const my = this._callMy.get(room);
    if (!my || my.cam !== true) return;
    if (this._chanCamList(room).findIndex((x) => x.me) < CALL_CAM_MAX) return;
    this._callMy.set(room, { muted: my.muted, deafened: my.deafened, cam: false });
    for (const l of this._legs(room)) if (l.state === 'active') this._callQueue(l, { t: 'st', cid: l.cid, m: my.muted || my.deafened ? 1 : 0, d: my.deafened ? 1 : 0, v: 0 });
    this.emit('call', { ev: 'camoff', room, reason: 'full' });
  },
  callConnected(cid) {
    const c = this._calls.get(String(cid));
    if (!c || c.state !== 'connecting') return false;
    c.state = 'active'; c.since = Date.now();
    clearTimeout(c.timer);
    this._vcTry.delete(c.peer); // tersambung: hitungan gagal beruntun mulai lagi
    const jn = this._joins.get(c.room);
    if (jn) { // selesai bergabung begitu semua anggota sudah mencoba menyambung dan semua kaki aktif
      jn.live = true;
      if (jn.seen.size >= jn.members.length && this._legs(c.room).every((x) => x.state === 'active')) { clearTimeout(jn.timer); this._joins.delete(c.room); }
    }
    const my = this._callMy.get(c.room); // status mik/deafen milikku yang sudah berlaku: kirim ke kaki baru ini (anggota baru / perubahan sebelum aktif). Status bawaan tidak perlu dikirim.
    if (my && (my.muted || my.deafened || typeof my.cam === 'boolean')) this._callQueue(c, Object.assign({ t: 'st', cid: c.cid, m: my.muted || my.deafened ? 1 : 0, d: my.deafened ? 1 : 0 }, typeof my.cam === 'boolean' ? Object.assign({ v: my.cam ? 1 : 0 }, my.cam && my.vt ? { vt: my.vt } : {}) : {}));
    this.emit('call', { ev: 'state', cid: c.cid, peer: c.peer, state: 'active' });
    if (c.stEarly) { const e = c.stEarly; c.stEarly = null; this._callSt(c, e); } // kabar status yang tiba sebelum aktif (mis. kamera yang sudah hidup)
    return true;
  },
  // Keluar dari seluruh ruang: semua kaki ditutup (masing-masing diberi tahu), undangan keluar dibatalkan, dan proses bergabung dihentikan.
  // Peserta lain tetap berbicara satu sama lain; ruang bubar di sisi mereka kalau tinggal satu orang.
  callLeave(room) {
    room = String(room);
    if (this._vcRoom(room)) return this.vcLeave(); // tombol tutup di layar panggilan = keluar dari channel
    if (this._pvRoom(room)) return this.pvLeave();
    const legs = this._legs(room), j = this._joins.get(room);
    if (!legs.length && !j) return false;
    if (j) j.seen = new Set(j.members); // supaya kaki terakhir yang ditutup dihitung sebagai akhir ruang
    for (const l of legs) this._callFinish(l, l.state === 'active' ? 'ended' : 'cancelled', 'end');
    if (!legs.length) { this._roomEnd(room); this.emit('call', { ev: 'end', cid: room, room, peer: j.from, name: j.name, dir: 'in', reason: 'cancelled', wasActive: false, dur: 0, last: true }); }
    return true;
  },
  callReject(cid) { this._callFinish(this._callGet(cid, 'in', 'ringing'), 'rejected', 'reject'); return true; },
  callEnd(cid) {
    const c = this._calls.get(String(cid));
    if (!c) return false;
    this._callFinish(c, c.state === 'active' ? 'ended' : 'cancelled', 'end');
    return true;
  },
};

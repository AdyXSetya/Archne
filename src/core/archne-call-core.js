'use strict';
// src/core/archne-call-core.js — state panggilan, _callIn, riwayat
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const { CALL_CID, CALL_CONN_MS, CALL_ICE_MAX, CALL_ICE_N, CALL_LOG_MAX, CALL_MAX_PEERS, CALL_NET_MS, CALL_RING_MS, CALL_SDP_MAX, CALL_SEEN_MAX, CALL_SKEW, CALL_ST_N, CALL_T, HEX16, sdpVideo, unmask } = require('./archne-constants');
const { verifyMsg } = require('./archne-util');

module.exports = {
  // ---- Panggilan suara (v0.13.0): lapisan sinyal ----
  // Event 'call' (satu bentuk, dibaca UI): { ev, cid, peer, name?, ... }
  //   ev 'incoming' { sdp }  | 'answer' { sdp } | 'ice' { data } | 'state' { state } | 'missed' { reason } (tawaran masuk yang tidak berdering)
  //   ev 'end' { reason, dir, wasActive }: ended | cancelled | missed | rejected | busy | noanswer | unreachable | refused | failed | blocked | glare
  // Keadaan: out: dialing -> connecting -> active; in: ringing -> connecting -> active. UI memanggil callConnected saat media tersambung.
  _callBusy() { for (const c of this._calls.values()) return c; return null; },
  callInfo() {
    const c = this._callBusy();
    if (!c) { // baru menerima undangan dan belum ada kaki yang terbentuk: UI tetap perlu tahu ada panggilan yang sedang disambung
      const j = this._joins.values().next().value;
      if (!j) { // undangan masuk yang belum dijawab: UI yang baru terpasang tetap perlu menampilkan dering undangan
        const iv = this._invIn.values().next().value;
        if (!iv) return null;
        return Object.assign({ cid: iv.room, room: iv.room, peer: iv.from, name: iv.name, dir: 'in', state: 'ringing', at: iv.at, invite: true, legs: [], members: iv.members.map((x) => ({ id: x.id, name: x.name })) }, iv.video ? { video: true } : {});
      }
      return { cid: j.room, room: j.room, peer: j.from, name: j.name, dir: 'in', state: 'connecting', at: j.at, joining: true, legs: [], members: [{ id: this.id, name: this.name }, ...j.info] };
    }
    const p = this.peers.get(c.peer), legs = this._legs(c.room);
    const o = { cid: c.cid, room: c.room, peer: c.peer, name: (p && p.name) || c.name || '?', dir: c.dir, state: legs.some((x) => x.state === 'active') ? 'active' : c.state, at: c.at, members: this._callMembers(c.room) };
    const vc = this._vcRoom(c.room); if (vc) o.vc = { gid: vc.gid, cid: vc.cid };
    const pvr = this._pvRoom(c.room); if (pvr) o.pv = { cid: pvr.cid };
    if (c.room !== c.cid || legs.length > 1 || this._joins.has(c.room)) { o.joining = this._joins.has(c.room); o.legs = legs.map((x) => Object.assign({ cid: x.cid, peer: x.peer, name: x.name, dir: x.dir, state: x.state }, x.pst ? Object.assign({ muted: x.pst.muted, deafened: x.pst.deafened }, typeof x.pst.cam === 'boolean' ? { cam: x.pst.cam } : {}) : {})); }
    if (c.pst) { o.muted = c.pst.muted; o.deafened = c.pst.deafened; if (typeof c.pst.cam === 'boolean') o.cam = c.pst.cam; } // status mik/deafen lawan bicara (hanya bila sudah pernah dikirim)
    const inv = [...this._invOut.keys()].filter((k) => k.startsWith(c.room + ':')).map((k) => { const id = k.slice(c.room.length + 1), q = this.peers.get(id); return { peer: id, name: (q && q.name) || '?' }; });
    if (inv.length) o.invites = inv; // undangan keluar yang menunggu jawaban (UI memangkas daftarnya sendiri bila event invitefail terlewat)
    // UI yang baru terpasang (Android: halaman dimuat ulang saat notifikasi diketuk) butuh tawaran + ICE yang sudah masuk, karena event-nya sudah lewat
    if (c.dir === 'in' && c.state === 'ringing') { o.sdp = c.sdp; o.ice = c.rice.slice(); }
    return o;
  },
  _callArm(c, ms, reason, notify) {
    clearTimeout(c.timer);
    c.timer = setTimeout(() => this._callFinish(c, reason, notify), ms);
    if (c.timer.unref) c.timer.unref();
  },
  // Satu kaki selesai. Event 'end' dikirim PER KAKI (UI menutup koneksi kaki itu): { cid, room, peer, name, last, ... }.
  // last=false: peserta itu keluar/putus tapi ruang masih berjalan; last=true: tidak ada orang lagi, ruang bubar.
  // Orang yang baru bergabung dan belum pernah tersambung ke siapa pun tidak langsung dianggap bubar selama masih ada anggota yang belum mencoba menelepon.
  _callFinish(c, reason, notify) {
    if (this._calls.get(c.cid) !== c) return;
    this._calls.delete(c.cid);
    clearTimeout(c.timer);
    const j = this._joins.get(c.room), vc = this._vcRoom(c.room), pv = this._pvRoom(c.room);
    const last = !vc && !pv && !this._legs(c.room).length && !(j && !j.live && j.seen.size < j.members.length); // channel: ruang tetap hidup walau sendirian
    const dur = this._callRecord(c, reason);
    if (last) this._roomEnd(c.room);
    if (notify) this._callQueue(c, { t: notify, cid: c.cid });
    this.emit('call', Object.assign({ ev: 'end', cid: c.cid, room: c.room, peer: c.peer, name: c.name, dir: c.dir, reason, wasActive: c.state === 'active', dur, last }, vc ? { vc: { gid: vc.gid, cid: vc.cid } } : pv ? { pv: { cid: pv.cid } } : {}));
  },
  // Ruang bubar: batalkan semua yang masih menggantung (undangan keluar -> pengundang memberi tahu yang diundang, izin menyambung, keadaan bergabung).
  _roomEnd(room) {
    for (const k of [...this._invOut.keys()]) if (k.startsWith(room + ':')) { clearTimeout(this._invOut.get(k)); this._invOut.delete(k); this._callSend(k.slice(room.length + 1), { t: 'invcancel', cid: room, room }); }
    const e = this._expect.get(room);
    if (e) { for (const t of e.values()) clearTimeout(t); this._expect.delete(room); }
    const j = this._joins.get(room);
    if (j) { clearTimeout(j.timer); this._joins.delete(room); }
    this._callMy.delete(room);
    this._rlogFlush(room);
  },
  // Catat satu kaki. Satu RUANG = satu catatan riwayat: kaki yang selesai hanya menambah bahan ke `_rlog`, catatannya ditulis `_rlogFlush` saat ruang bubar.
  // Diblokir/glare tidak dicatat (yang pertama dibuang diam-diam, yang kedua digantikan tawaran lawan).
  // Mengembalikan durasi (detik) kaki ini kalau sempat tersambung, selain itu 0.
  _callRecord(c, reason) {
    const active = c.state === 'active';
    const dur = active ? Math.max(0, Math.round((Date.now() - (c.since || c.at)) / 1000)) : 0;
    if (reason === 'blocked' || reason === 'glare' || this._vcRoom(c.room) || this._pvRoom(c.room)) return dur; // channel voice tidak masuk riwayat panggilan
    let r = this._rlog.get(c.room);
    if (!r) this._rlog.set(c.room, r = { room: c.room, at: c.at, dir: c.dir, peer: c.peer, name: c.name, since: 0, act: false, peers: new Map(), live: new Map(), reason, ldir: c.dir, video: false });
    if (c.at < r.at) { r.at = c.at; r.dir = c.dir; r.peer = c.peer; r.name = c.name; } // yang tercatat sebagai pembuka = kaki paling awal
    r.reason = reason; r.ldir = c.dir;
    if (c.video) r.video = true; // satu kaki saja yang berisi video sudah cukup untuk menandai ruangnya
    r.peers.set(c.peer, c.name);
    if (active) { r.act = true; r.live.set(c.peer, c.name); const s0 = c.since || c.at; r.since = r.since ? Math.min(r.since, s0) : s0; }
    return dur;
  },
  _callOut(active, reason, dir) {
    return active ? 'done' : reason === 'missed' ? 'missed' : reason === 'rejected' ? 'rejected' : reason === 'noanswer' ? 'noanswer' : reason === 'busy' ? 'busy' : (reason === 'cancelled' && dir === 'out') ? 'cancelled' : 'failed';
  },
  // Tulis satu catatan untuk ruang yang bubar. 1-1: bentuk lama. Grup: + group:1 dan members (yang pernah tersambung; kalau tak ada yang tersambung, semua yang dicoba).
  _rlogFlush(room) {
    const joined = this._rjoin.delete(room), r = this._rlog.get(room);
    if (!r) return;
    this._rlog.delete(room);
    const dur = r.act ? Math.max(0, Math.round((Date.now() - r.since) / 1000)) : 0;
    const rec = { id: r.room, peer: r.peer, name: r.name, dir: r.dir, out: this._callOut(r.act, r.reason, r.ldir), at: r.at, dur };
    if (r.video) rec.video = 1;
    if (r.live.size === 1) { const [id, name] = [...r.live][0]; rec.peer = id; rec.name = name; } // 1-1 yang sempat mencoba menambah orang tapi tidak jadi: tetap catatan 1-1
    if (r.live.size > 1 || joined) { // grup = pernah ada dua orang lain yang tersambung, atau aku yang bergabung
      rec.group = 1;
      if (joined) rec.dir = 'in'; // aku diundang masuk: arah kartu 'masuk', walau kaki-kakinya kebetulan kutelepon sendiri (id lebih kecil jadi penelepon)
      rec.members = [...(r.act ? r.live : r.peers)].slice(0, CALL_MAX_PEERS).map(([id, name]) => ({ id, name }));
      if (rec.members.length && !rec.members.some((x) => x.id === rec.peer)) { rec.peer = rec.members[0].id; rec.name = rec.members[0].name; }
    }
    this._callLogAdd(rec);
  },
  _callLogAdd(r) {
    const l = this.store.calls;
    if (l.some((x) => x.id === r.id)) return;
    l.push(r);
    if (l.length > CALL_LOG_MAX) l.splice(0, l.length - CALL_LOG_MAX);
    this._save(); this.emit('update');
  },
  // Riwayat untuk UI (terbaru dulu). Catatan grup: hanya anggota yang tidak kublokir yang tampil; kalau semuanya terblokir, catatannya disembunyikan.
  _callsOut(blk) {
    const nm = (id, d) => (this.peers.get(id) || {}).name || d || '?';
    const out = [];
    for (const r of this.store.calls) {
      if (!r.group) { if (!blk[r.peer]) out.push({ id: r.id, peer: r.peer, name: nm(r.peer, r.name), dir: r.dir, out: r.out, at: r.at, dur: r.dur || 0, hc: !!r.hc, video: !!r.video }); continue; }
      const mem = r.members.filter((x) => !blk[x.id]).map((x) => ({ id: x.id, name: nm(x.id, x.name) }));
      if (!mem.length) continue;
      const lead = mem.find((x) => x.id === r.peer) || mem[0];
      out.push({ id: r.id, peer: lead.id, name: lead.name, dir: r.dir, out: r.out, at: r.at, dur: r.dur || 0, hc: false, video: !!r.video, group: true, members: mem, hcs: (r.hcs || []).slice() });
    }
    return out.reverse();
  },
  // Hapus riwayat panggilan di perangkat ini: semuanya, atau hanya dengan satu orang.
  clearCalls(peerId) {
    if (peerId !== undefined && peerId !== null && !HEX16.test(String(peerId))) throw new Error('ID tidak valid');
    this.store.calls = peerId ? this.store.calls.filter((r) => r.peer !== String(peerId) && !(r.members || []).some((x) => x.id === String(peerId))) : []; // catatan grup yang memuat orang itu ikut terhapus
    this._save(); this.emit('update');
  },
  _callDrop(peerId, reason) { for (const c of [...this._calls.values()]) if (c.peer === peerId) this._callFinish(c, reason, null); },
  // Pengiriman langsung satu kali; tidak pernah melempar, tidak pernah menyimpan.
  async _callSend(peerId, payload) {
    try {
      const p = this.peers.get(peerId);
      if (!p || !this.isOnline(p) || this.isBlocked(peerId)) return false;
      const m = this._makeMsg(peerId, 'c1', JSON.stringify(payload));
      const r = await this._request(p, { t: 'call', m }, CALL_NET_MS);
      return !!(r && r.t === 'ack' && r.ok);
    } catch { return false; }
  },
  // Sinyal satu panggilan dikirim BERURUTAN (ICE tidak boleh mendahului tawaran, 'end' tidak boleh mendahului jawaban).
  _callQueue(c, payload) {
    const run = () => this._callSend(c.peer, payload);
    c.q = c.q.then(run, run);
    return c.q;
  },
  _callIn(m) {
    const ack = (ok) => ({ t: 'ack', id: m && m.id, ok });
    if (!verifyMsg(m) || m.kind !== 'c1' || m.to !== this.id || m.from === this.id) return ack(false);
    if (Math.abs(m.ts - this._wall()) > CALL_SKEW) return ack(false); // sinyal basi / jam ngawur / pemutaran ulang lama
    if (this.isBlocked(m.from)) return ack(true); // dibuang diam-diam: pengirim tidak tahu diblokir
    if (this._callSeen.has(m.id)) return ack(true);
    const now = this._wall();
    this._callSeen.set(m.id, now);
    if (this._callSeen.size > CALL_SEEN_MAX) for (const [k, t] of this._callSeen) { if (now - t > 2 * CALL_SKEW || this._callSeen.size > CALL_SEEN_MAX) this._callSeen.delete(k); }
    let o = null;
    try { const t = this._open(m); o = t === null ? null : JSON.parse(t); } catch {}
    if (!o || typeof o !== 'object' || !CALL_T.has(o.t) || !CALL_CID.test(String(o.cid))) return ack(false);
    const kp = this.peers.get(m.from), name = String((kp && kp.name) || m.name || '?').slice(0, 32);
    const c = this._calls.get(o.cid);
    if (kp && kp.ip) { if (o.sdp) o.sdp = unmask(o.sdp, kp.ip); if (o.data) o.data = unmask(o.data, kp.ip); }
    if (o.t === 'invite') return this._invitedIn(m, o, name, ack);
    if (o.t === 'vp') return this._vcPresIn(m, o, name, ack);
    if (o.t === 'pp') return this._pvPresIn(m, o, name, ack);
    if (o.t === 'join') {
      const room = o.cid, legs = this._legs(room);
      if (!legs.length || legs.some((x) => x.peer === m.from) || !this._roomAuth(room, m.from)) return ack(true);
      const k = room + ':' + m.from;
      if (this._invOut.has(k)) { clearTimeout(this._invOut.get(k)); this._invOut.delete(k); this._expectAdd(room, m.from); }
      if (legs.length + 1 < CALL_MAX_PEERS && this.id < m.from) this.emit('call', { ev: 'legneed', room, peer: m.from, name }); // id lebih kecil = penelepon
      return ack(true);
    }
    if (o.t === 'invcancel') { // pengundang keluar/ruang bubar sebelum aku menjawab
      const iv = this._invIn.get(o.cid);
      if (iv && iv.from === m.from) { clearTimeout(iv.timer); this._invIn.delete(o.cid); this.emit('call', { ev: 'inviteend', room: o.cid, peer: m.from, reason: 'cancelled' }); }
      return ack(true);
    }
    if (o.t === 'invdec') {
      const k = o.cid + ':' + m.from;
      if (this._invOut.has(k)) { clearTimeout(this._invOut.get(k)); this._invOut.delete(k); this.emit('call', { ev: 'invitefail', room: o.cid, peer: m.from, name, reason: o.reason === 'busy' ? 'busy' : 'declined' }); }
      return ack(true);
    }
    if (o.t === 'offer') {
      if (c) return ack(true);
      if (typeof o.sdp !== 'string' || !o.sdp || o.sdp.length > CALL_SDP_MAX) return ack(false);
      const room = typeof o.room === 'string' && CALL_CID.test(o.room) ? o.room : null;
      if (room && this._roomAuth(room, m.from)) { // tawaran dari sesama anggota ruang: diterima walau sedang dalam panggilan, dijawab otomatis oleh UI
        const legs = this._legs(room);
        if (legs.some((x) => x.peer === m.from)) return ack(true);
        if (legs.length + 1 >= this._roomMax(room)) { this._callSend(m.from, { t: 'busy', cid: o.cid }); return ack(true); }
        this._roomAuthDel(room, m.from);
        const jn = this._joins.get(room); if (jn) jn.seen.add(m.from);
        const gc = { cid: o.cid, room, peer: m.from, name, dir: 'in', state: 'ringing', at: Date.now(), q: Promise.resolve(), ice: 0, sent: 0, stn: 0, sdp: o.sdp, rice: [], video: this._vidLeg(room, o.sdp) };
        this._calls.set(gc.cid, gc);
        this._callArm(gc, this.opts.callRingMs || CALL_RING_MS, 'missed', null);
        this.emit('call', Object.assign({ ev: 'incoming', cid: gc.cid, room, auto: true, peer: gc.peer, name, sdp: o.sdp }, gc.video ? { video: true } : {}));
        return ack(true);
      }
      if (room) { this._callSend(m.from, { t: 'busy', cid: o.cid }); return ack(true); } // tawaran ruang dari yang tidak diizinkan (ruang sudah bubar / bukan anggota): tidak berdering, tidak dicatat
      const cur = this._callBusy();
      if (cur || this._joins.size || this._vcMe || this._pvMe) {
        if (cur && cur.peer === m.from && cur.dir === 'out' && cur.state === 'dialing') {
          // saling menelepon bersamaan: id yang lebih kecil menjadi penelepon, yang lain mengalah dan menerima tawaran ini
          if (this.id < m.from) { this._callSend(m.from, { t: 'busy', cid: o.cid }); return ack(true); }
          this._callFinish(cur, 'glare', null);
        } else {
          this._callSend(m.from, { t: 'busy', cid: o.cid });
          this._callLogAdd(Object.assign({ id: o.cid, peer: m.from, name, dir: 'in', out: 'missed', at: Date.now(), dur: 0 }, sdpVideo(o.sdp) ? { video: 1 } : {}));
          this.emit('call', { ev: 'missed', cid: o.cid, peer: m.from, name, reason: 'busy' });
          return ack(true);
        }
      }
      const nc = { cid: o.cid, room: o.cid, peer: m.from, name, dir: 'in', state: 'ringing', at: Date.now(), q: Promise.resolve(), ice: 0, sent: 0, stn: 0, sdp: o.sdp, rice: [], video: sdpVideo(o.sdp) };
      this._calls.set(nc.cid, nc);
      this._callArm(nc, this.opts.callRingMs || CALL_RING_MS, 'missed', null);
      this.emit('call', Object.assign({ ev: 'incoming', cid: nc.cid, peer: nc.peer, name, sdp: o.sdp }, nc.video ? { video: true } : {}));
      return ack(true);
    }
    if (!c || c.peer !== m.from) return ack(true); // tidak dikenal / bukan lawan bicara panggilan ini: abaikan (tanpa membocorkan apa pun)
    if (o.t === 'answer') {
      if (c.dir !== 'out' || c.state !== 'dialing') return ack(true);
      if (typeof o.sdp !== 'string' || !o.sdp || o.sdp.length > CALL_SDP_MAX) return ack(false);
      c.state = 'connecting';
      this._callArm(c, this.opts.callConnMs || CALL_CONN_MS, 'failed', 'end');
      this.emit('call', { ev: 'answer', cid: c.cid, peer: c.peer, sdp: o.sdp });
    } else if (o.t === 'ice') {
      if (typeof o.data !== 'string' || !o.data || o.data.length > CALL_ICE_MAX || ++c.ice > CALL_ICE_N) return ack(true);
      if (c.dir === 'in' && c.state === 'ringing') c.rice.push(o.data);
      this.emit('call', { ev: 'ice', cid: c.cid, peer: c.peer, data: o.data });
    } else if (o.t === 'end') {
      this._callFinish(c, c.dir === 'in' && c.state === 'ringing' ? 'missed' : 'ended', null);
    } else if (o.t === 'reject') {
      if (c.dir === 'out') this._callFinish(c, 'rejected', null);
    } else if (o.t === 'busy') {
      if (c.dir === 'out' && c.state === 'dialing') this._callFinish(c, 'busy', null);
    } else if (o.t === 'st') { // status mik/deafen lawan bicara (4c-2): hanya dari kaki yang aktif, bentuk ketat, jumlah dibatasi
      // v0.21.0: kabar yang tiba saat kaki ini belum aktif di sisiku (UI-ku belum memanggil callConnected) tidak lagi dibuang: yang terbaru ditahan
      // dan dipakai begitu aktif. Dulu peserta yang baru masuk tidak pernah tahu kamera orang yang sudah menyala (kartunya tidak muncul).
      if ((c.state !== 'active' && c.state !== 'connecting' && c.state !== 'dialing') || (o.m !== 0 && o.m !== 1) || (o.d !== 0 && o.d !== 1) || (o.v !== undefined && o.v !== 0 && o.v !== 1) || ++c.stn > CALL_ST_N) return ack(true);
      if (c.state !== 'active') { c.stEarly = o.v === undefined && c.stEarly && c.stEarly.v !== undefined ? Object.assign({}, o, { v: c.stEarly.v }, c.stEarly.vt !== undefined ? { vt: c.stEarly.vt } : {}) : o; return ack(true); } // kabar tanpa v (mis. hanya mute) tidak boleh menghapus kabar kamera yang sudah ditahan
      this._callSt(c, o);
    } else if (o.t === 'room') { // anggota ruang mengumumkan: id ini diundang dan akan menelepon aku
      if (typeof o.add === 'string' && HEX16.test(o.add) && o.add !== this.id && c.state === 'active' && !this._legs(c.room).some((x) => x.peer === o.add) && this._legs(c.room).length + 1 < CALL_MAX_PEERS) this._expectAdd(c.room, o.add);
    }
    return ack(true);
  },
  // Terapkan satu kabar status (st) yang sudah lolos pemeriksaan bentuk: simpan di c.pst, beri tahu UI, tegakkan batas kamera channel.
  _callSt(c, o) {
    const d = o.d === 1, mu = d || o.m === 1; // deafen selalu berarti mik mati
    const cam = o.v === undefined ? undefined : o.v === 1; // kamera hidup (opsional; peer lama tidak mengirimnya)
    const vtIn = cam === true ? (Number.isFinite(o.vt) && Math.abs(o.vt - Date.now()) < 600000 ? Math.floor(o.vt) : Date.now()) : undefined; // jam pengirim hanya dipercaya bila wajar (10 menit)
    c.pst = Object.assign({ muted: mu, deafened: d }, cam === undefined ? (c.pst && typeof c.pst.cam === 'boolean' ? { cam: c.pst.cam, vt: c.pst.vt } : {}) : cam ? { cam, vt: c.pst && c.pst.cam === true && c.pst.vt ? c.pst.vt : vtIn } : { cam });
    this.emit('call', Object.assign({ ev: 'peerstate', cid: c.cid, room: c.room, peer: c.peer, muted: mu, deafened: d }, cam === undefined ? {} : { cam }));
    if (cam === true) this._camEnforce(c.room);
  },
};

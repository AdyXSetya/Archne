'use strict';
// RTCPeerConnection / RTCDataChannel palsu untuk tes rtcmux (langkah 3). Tanpa jaringan.
// Perilaku yang ditiru dari WebRTC asli (supaya bug nyata terpancing):
//  - addIceCandidate MENOLAK sebelum remote description terpasang (InvalidStateError);
//  - kandidat dikirim lewat onicecandidate setelah setLocalDescription (trickle); koneksi baru "connected" bila kedua sisi sudah punya
//    description dan minimal satu kandidat dari lawan;
//  - DataChannel: send() melempar bila belum open, bufferedAmount menumpuk dan terkuras bertahap, 'bufferedamountlow' hanya saat
//    melintasi ambang dari atas, pesan > maxMessage ditolak, close() satu sisi menutup sisi lain;
//  - net.blocked = ICE tidak pernah tersambung (state 'failed'); net.cut(pc) = jaringan putus mendadak; net.paused = tidak ada yang terkirim.
class FakeNet {
  constructor() {
    this.pcs = new Map(); this.n = 0; this.blocked = false; this.paused = false; this.pathType = 'host';
    this.maxMessage = 256 * 1024; this.perTick = 8; this.failDelay = 20; this.connectDelay = 2; this.created = 0;
  }
  // kelas RTCPeerConnection untuk satu perangkat
  rtc(name) {
    const net = this;
    return class FakePC {
      constructor(config) {
        this.net = net; this.name = name; this.id = ++net.n; net.created++; net.pcs.set(this.id, this); this.config = config;
        this.connectionState = 'new'; this.localDescription = null; this.remoteDescription = null; this.remote = null; this.remoteCands = [];
        this.dcs = []; this.addedCands = []; this.closed = false; this.gathered = [];
        this.onicecandidate = null; this.onconnectionstatechange = null; this.ondatachannel = null; this._connT = null;
      }
      createDataChannel(label, opts) { const dc = new FakeDC(net, label, opts); dc.pc = this; this.dcs.push(dc); this._local = dc; return dc; }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nfake-pc ' + this.id }; }
      async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nfake-pc ' + this.id }; }
      async setLocalDescription(d) {
        this.localDescription = d;
        setTimeout(() => { // pengumpulan kandidat dimulai setelah setLocalDescription
          if (this.closed) return;
          for (let i = 0; i < 2; i++) {
            const type = i === 0 ? 'host' : 'srflx';
            const c = { candidate: 'candidate:' + i + ' 1 udp 1 10.0.' + this.id + '.' + i + ' ' + (4000 + this.id) + ' typ ' + type, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'u' + this.id };
            this.gathered.push(c);
            if (this.onicecandidate) this.onicecandidate({ candidate: c });
          }
          if (this.onicecandidate) this.onicecandidate({ candidate: null });
        }, 1);
        this._maybe();
      }
      async setRemoteDescription(d) {
        const m = /fake-pc (\d+)/.exec(d.sdp || ''); if (!m) throw new Error('SDP tidak valid');
        this.remote = net.pcs.get(Number(m[1])); this.remoteDescription = d; this._maybe();
      }
      async addIceCandidate(c) {
        if (!this.remoteDescription) { const e = new Error('remote description belum ada'); e.name = 'InvalidStateError'; throw e; }
        this.addedCands.push(c); this.remoteCands.push(c); this._maybe();
      }
      _ready() { return !this.closed && this.localDescription && this.remoteDescription && this.remoteCands.length > 0; }
      _maybe() {
        const a = this, b = this.remote;
        if (!b || !a._ready() || !b._ready()) { if (a._ready() && net.blocked) a._failSoon(); return; }
        if (a._connT || a.connectionState === 'connected') return;
        if (net.blocked) { a._failSoon(); b._failSoon(); return; }
        const t = setTimeout(() => {
          if (a.closed || b.closed) return;
          a._connT = b._connT = null;
          a._state('connected'); b._state('connected');
          const off = a._local ? a : b, ans = off === a ? b : a; // yang punya DataChannel lokal = penawar
          const rdc = new FakeDC(net, off._local.label, {}); rdc.pc = ans; ans.dcs.push(rdc);
          rdc.remote = off._local; off._local.remote = rdc;
          if (ans.ondatachannel) ans.ondatachannel({ channel: rdc });
          off._local._open(); rdc._open();
        }, net.connectDelay);
        a._connT = b._connT = t;
      }
      _failSoon() { if (this._failT || this.closed) return; this._failT = setTimeout(() => { this._failT = null; if (!this.closed && this.connectionState !== 'connected') this._state('failed'); }, net.failDelay); }
      _state(s) { if (this.connectionState === s) return; this.connectionState = s; if (this.onconnectionstatechange) this.onconnectionstatechange(); }
      async getStats() {
        const t = net.pathType;
        return new Map([
          ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
          ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'succeeded', nominated: true }],
          ['L', { id: 'L', type: 'local-candidate', candidateType: t }], ['R', { id: 'R', type: 'remote-candidate', candidateType: 'srflx' }],
        ]);
      }
      close() {
        if (this.closed) return; this.closed = true; this.connectionState = 'closed';
        clearTimeout(this._connT); clearTimeout(this._failT);
        for (const dc of this.dcs) dc.close();
      }
    };
  }
  // jaringan putus mendadak di pc ini: semua channel-nya mati, state 'failed'
  cut(pc) { const o = pc.remote; for (const p of [pc, o]) { if (!p) continue; p._state('failed'); for (const dc of p.dcs) dc._die(); } }
}

class FakeDC {
  constructor(net, label, opts) {
    this.net = net; this.label = label; this.ordered = !opts || opts.ordered !== false; this.readyState = 'connecting';
    this.binaryType = 'blob'; this.bufferedAmount = 0; this.bufferedAmountLowThreshold = 0; this.remote = null; this.q = []; this.sent = []; this.maxBuffered = 0;
    this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null; this.onbufferedamountlow = null; this._t = null;
  }
  _open() { this.readyState = 'open'; if (this.onopen) this.onopen({}); }
  send(d) {
    if (this.readyState !== 'open') { const e = new Error('channel tidak open'); e.name = 'InvalidStateError'; throw e; }
    if (typeof d === 'string') { // string tetap string di sisi lawan (seperti WebRTC asli)
      const n = Buffer.byteLength(d); if (n > this.net.maxMessage) throw new TypeError('pesan terlalu besar');
      const item = { str: d, length: n }; this.q.push(item); this.sent.push(d); this.bufferedAmount += n; this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount); this._sched(); return;
    }
    const u = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
    if (u.length > this.net.maxMessage) throw new TypeError('pesan terlalu besar');
    const copy = new Uint8Array(u.length); copy.set(u);
    this.q.push(copy); this.sent.push(copy); this.bufferedAmount += copy.length; this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
    this._sched();
  }
  _sched() { if (this._t || this.net.paused) return; this._t = setTimeout(() => this._drain(), 1); }
  resume() { this._sched(); }
  _drain() {
    this._t = null;
    if (this.readyState !== 'open' || this.net.paused) return;
    for (let i = 0; i < this.net.perTick && this.q.length; i++) {
      const m = this.q.shift(), before = this.bufferedAmount; this.bufferedAmount -= m.length;
      const r = this.remote;
      if (r && r.readyState === 'open' && r.onmessage) r.onmessage({ data: m.str !== undefined ? m.str : m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength) });
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold && this.onbufferedamountlow) this.onbufferedamountlow({});
    }
    if (this.q.length) this._sched();
  }
  close() { // sisi ini tertutup, sisi lain menyusul
    if (this.readyState === 'closed') return;
    const r = this.remote; this._die();
    if (r && r.readyState !== 'closed') setImmediate(() => r._die());
  }
  _die() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed'; this.q = []; this.bufferedAmount = 0; clearTimeout(this._t);
    if (this.onclose) this.onclose({});
  }
}

// `wan` palsu: bus sinyal antar perangkat. Isi sinyal dilewatkan JSON (harus bisa diserialkan) dan dikirim asinkron.
class FakeBus {
  constructor() { this.nodes = new Map(); this.log = []; this.filter = null; this.latency = null; this.delivered = 0; }
  node(id) {
    const bus = this;
    const L = { signal: [], peers: [], status: [] };
    const n = {
      id, online: [],
      on: (k, cb) => { L[k].push(cb); },
      peers: () => n.online.map((x) => ({ id: x, name: x, ts: 1 })),
      isOfferer: (p) => id < p,
      sendSignal: async (to, body) => {
        const b = JSON.parse(JSON.stringify(body));
        if (bus.latency) { const ms = bus.latency(id, to, b); if (ms > 0) await new Promise((r) => setTimeout(r, ms)); } // lama pengiriman per sinyal (bisa membuat sinyal yang dikirim belakangan selesai lebih dulu)
        bus.log.push({ from: id, to, body: b }); // dicatat saat pengiriman SELESAI, jadi urutan log = urutan sampai ke broker
        let delay = 0;
        if (bus.filter) { delay = bus.filter(id, to, b); if (delay === null) return true; } // null = jatuhkan
        const dst = bus.nodes.get(to); if (!dst) return false;
        setTimeout(() => { bus.delivered++; dst.deliver(id, b); }, delay);
        return true;
      },
      deliver: (from, body) => L.signal.forEach((cb) => cb({ from, ts: Date.now(), body })),
      setPeers: (ids) => { n.online = ids.slice(); L.peers.forEach((cb) => cb(n.peers())); },
    };
    bus.nodes.set(id, n);
    return n;
  }
}

module.exports = { FakeNet, FakeDC, FakeBus };

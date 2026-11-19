'use strict';
// Transport palsu di memori untuk tes (kontrak: src/archne-transport.js). Tidak ada jaringan: sepasang Duplex saling terhubung.
// Meniru perilaku net.Socket yang dipakai Core/Xfer: event 'connect' setelah connect(), setTimeout sebagai batas diam,
// tutup satu sisi = sisi lain ikut tertutup, allowHalfOpen=false.
const { Duplex } = require('stream');
const { isRtcAddr, rtcId } = require('../../src/archne-transport');

class MemSocket extends Duplex {
  constructor() { super({ allowHalfOpen: false }); this.remote = null; this._idleMs = 0; this._idleCb = null; this._idleT = null; }
  _read() {}
  _write(chunk, _enc, cb) { this._bump(); const r = this.remote; if (r && !r.destroyed) { r._bump(); r.push(chunk); } cb(); }
  _final(cb) { const r = this.remote; if (r && !r.destroyed) r.push(null); cb(); }
  _destroy(err, cb) { clearTimeout(this._idleT); const r = this.remote; this.remote = null; if (r && !r.destroyed) r.destroy(); cb(err); }
  setTimeout(ms, cb) { this._idleMs = ms || 0; this._idleCb = cb || null; this._bump(); return this; }
  _bump() {
    clearTimeout(this._idleT);
    if (this._idleMs > 0) { this._idleT = setTimeout(() => { if (this._idleCb) this._idleCb(); }, this._idleMs); this._idleT.unref(); }
  }
}

class MemHub {
  constructor() { this.nodes = new Map(); this.cut = new Set(); } // cut: "dari>ke" yang diputus
  transport(id) { const t = new MemTransport(this, id); this.nodes.set(id, t); return t; }
  sever(a, b) { this.cut.add(a + '>' + b); this.cut.add(b + '>' + a); }
  heal() { this.cut.clear(); }
}

class MemTransport {
  constructor(hub, id) { this.hub = hub; this.id = id; this.onIncoming = null; this.closed = false; this.dials = 0; this.incoming = 0; }
  connect(peer) {
    this.dials++;
    if (this.closed || !isRtcAddr(peer.ip)) return null;
    const to = rtcId(peer.ip), a = new MemSocket(), b = new MemSocket();
    a.remote = b; b.remote = a;
    setImmediate(() => {
      const t = this.hub.nodes.get(to);
      if (!t || t.closed || !t.onIncoming || this.hub.cut.has(this.id + '>' + to)) { a.destroy(new Error('unreachable')); return; }
      t.incoming++;
      t.onIncoming(b, this.id);
      a.emit('connect');
    });
    return a;
  }
  close() { this.closed = true; }
}

module.exports = { MemHub, MemTransport, MemSocket };

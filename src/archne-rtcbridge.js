'use strict';
// Jembatan Core <-> UI untuk peer lintas jaringan (mode lintas jaringan, langkah 4).
//
// DataChannel (WebRTC) hanya ada di UI, sedangkan Core jalan di Node. Berkas ini adalah sisi Core: sebuah *transport* (kontrak: src/archne-transport.js)
// yang menjadikan setiap stream rtcmux di UI sebagai soket-like di Core. Core tidak tahu apa pun soal WebRTC.
//
//   Core  --connect(peer "rtc:<id>")-->  BridgeSocket  --{op:'open'|'data'|'fin'|'rst'}-->  UI (renderer/archne-rtcglue.js)  -->  rtcmux  -->  DataChannel
//
// Semua pesan adalah objek biasa (bisa lewat IPC Electron apa adanya, atau JSON lewat SSE/POST di Android/peramban):
//
//  Core -> UI  (send(msg), msg.e = epoch)
//    open  { sid, peer }        Core ingin membuka stream baru ke peer (sid ganjil, dibuat Core)
//    data  { sid, d }           byte; d = Uint8Array (binary) atau base64 (binary:false)
//    fin   { sid }              Core selesai menulis (half-close)
//    rst   { sid }              batalkan stream
//    ack   { sid, n }           Core sudah memproses n byte data dari UI (memulihkan kredit stream di sisi UI)
//    detached {}                UI lain mengambil alih; UI ini harus berhenti
//  UI -> Core  (feed(msg); batch = larik pesan; msg.e = epoch)
//    attach { e }               UI mulai (epoch baru, 16 heks). Mengganti UI sebelumnya, menutup semua stream lama.
//    detach {}                  UI berhenti
//    link  { peer, state, path? }  state 'open' | 'closed' | 'failed' untuk link DataChannel ke peer
//    in    { sid, peer }        peer membuka stream ke Core (sid genap, dibuat UI)
//    data / fin / rst           sama seperti arah sebaliknya
//    ack   { sid, n }           UI sudah menyerahkan n byte data dari Core ke DataChannel
//
// Flow control: tiap arah punya jendela kredit per stream. Core menahan penulis (callback _write) selama byte yang belum di-ack >= WINDOW,
// jadi Xfer/Core yang menulis berkas besar ikut melambat mengikuti DataChannel; sebaliknya Core hanya me-ack byte yang benar-benar sudah
// diberikan ke pendengar 'data' (soket yang di-pause tidak di-ack), sehingga UI menahan lawan lewat kredit rtcmux.
//
// Keamanan: pemanggil adalah UI lokal yang dipercaya; yang divalidasi ketat adalah bentuk pesan (ID, ukuran, batas), bukan niat.
// Identitas peer berasal dari rtcmux (sinyal bertanda tangan Core), jadi `peer` dari UI diteruskan ke Core sebagai remoteId terotentikasi.
const { Duplex } = require('stream');
const Transport = require('./archne-transport');

const HEX16 = /^[0-9a-f]{16}$/;
const WINDOW = 256 * 1024;       // byte Core -> UI yang boleh belum di-ack, per stream
const ACK_AT = 64 * 1024;        // Core me-ack setelah sebanyak ini byte diproses
const CHUNK = 32 * 1024;         // ukuran satu pesan data dari Core
const MAX_IN_MSG = 256 * 1024;   // pesan data dari UI lebih besar dari ini ditolak
const RX_LIMIT = 2 * 1024 * 1024; // byte dari UI yang belum diproses Core per stream; lebih dari ini = pelanggaran
const MAX_SOCKS = 128;
const MAX_BATCH = 256;

function decodeBytes(d) {
  if (typeof d === 'string') {
    if (d.length > Math.ceil(MAX_IN_MSG * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(d) || d.length % 4 === 1) return null;
    return Buffer.from(d, 'base64');
  }
  let b = null;
  if (Buffer.isBuffer(d)) b = d;
  else if (d instanceof Uint8Array) b = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  else if (Object.prototype.toString.call(d) === '[object ArrayBuffer]') b = Buffer.from(d);
  if (!b || b.length > MAX_IN_MSG) return null;
  return b;
}

class BridgeSocket extends Duplex {
  constructor(br, sid, peerId) {
    super({ allowHalfOpen: false });
    this.br = br; this.sid = sid; this.peerId = peerId;
    this.inflight = 0;            // byte yang sudah dikirim ke UI tetapi belum di-ack
    this._w = null;               // { chunk, off, cb } penulisan yang menunggu kredit
    this.emitted = 0; this.pushed = 0; this.acked = 0; // arah UI -> Core
    this.finSent = false; this.finRecv = false; this.remoteGone = false;
    this._idleMs = 0; this._idleCb = null; this._idleT = null;
    this.on('error', () => {}); // pemanggil Core memasang pendengar sendiri; ini hanya mencegah 'error' tanpa pendengar melempar
  }
  _read() {}
  _write(chunk, _enc, cb) { this._bump(); this._w = { chunk, off: 0, cb }; this._pumpW(); }
  _pumpW() {
    const w = this._w;
    while (w && w.off < w.chunk.length) {
      if (this.destroyed) return;
      if (this.inflight >= WINDOW) return; // lanjut saat ack tiba
      const n = Math.min(CHUNK, w.chunk.length - w.off);
      this.br._data(this.sid, w.chunk.subarray(w.off, w.off + n));
      w.off += n; this.inflight += n;
    }
    if (w) { this._w = null; w.cb(); }
  }
  _onAck(n) {
    this.inflight = Math.max(0, this.inflight - n);
    this._bump();
    if (this._w) this._pumpW();
  }
  _final(cb) { this.finSent = true; if (!this.remoteGone) this.br._out({ op: 'fin', sid: this.sid }); cb(); }
  _destroy(err, cb) {
    clearTimeout(this._idleT);
    this._w = null;
    this.br._closed(this);
    if (!this.remoteGone && !(this.finSent && this.finRecv)) this.br._out({ op: 'rst', sid: this.sid });
    cb(err);
  }
  // Menghitung byte yang benar-benar diberikan ke pendengar (bukan yang menumpuk di buffer) untuk ack.
  emit(ev, ...a) {
    if (ev === 'data' && a.length) {
      const c = a[0];
      this.emitted += typeof c === 'string' ? Buffer.byteLength(c) : (c ? c.length : 0);
      this._ack(false);
    }
    return super.emit(ev, ...a);
  }
  _ack(force) {
    const n = Math.min(this.emitted, this.pushed) - this.acked; // unshift() membuat byte keluar dua kali; jangan melebihi yang pernah masuk
    if (n <= 0 || (!force && n < ACK_AT) || this.remoteGone) return;
    this.acked += n;
    this.br._out({ op: 'ack', sid: this.sid, n });
  }
  _fromUi(buf) {
    this._bump();
    if (this.pushed - this.acked + buf.length > RX_LIMIT) { this.br._out({ op: 'rst', sid: this.sid }); this.remoteGone = true; this.destroy(new Error('UI melebihi jendela')); return; }
    this.pushed += buf.length;
    this.push(buf);
  }
  _fromUiFin() { this.finRecv = true; this.push(null); }
  setTimeout(ms, cb) { this._idleMs = ms || 0; this._idleCb = cb || null; this._bump(); return this; }
  _bump() {
    clearTimeout(this._idleT);
    if (this._idleMs > 0 && !this.destroyed) { this._idleT = setTimeout(() => { if (this._idleCb) this._idleCb(); }, this._idleMs); if (this._idleT.unref) this._idleT.unref(); }
  }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
}

function createBridge(opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  const binary = opts.binary !== false;
  const sendRaw = typeof opts.send === 'function' ? opts.send : () => {};
  const socks = new Map();        // sid -> BridgeSocket
  const links = new Map();        // peerId -> { path, since }
  const listeners = [];
  let epoch = null, nextSid = 1;
  const stats = { out: 0, in: 0, msgsOut: 0, msgsIn: 0 };

  const emitLink = (ev) => { for (const cb of listeners.slice()) { try { cb(ev); } catch (e) { log('rtcbridge link listener: ' + e); } } };

  function out(msg) {
    if (!epoch) return false;
    stats.msgsOut++;
    try { sendRaw(Object.assign({ e: epoch }, msg)); return true; } catch (e) { log('rtcbridge send: ' + (e && e.message)); return false; }
  }
  function data(sid, piece) {
    // Salinan: Uint8Array yang masih berupa tampilan pada buffer besar akan menyerialkan SELURUH buffer lewat IPC (structured clone).
    stats.out += piece.length;
    out({ op: 'data', sid, d: binary ? new Uint8Array(piece) : piece.toString('base64') });
  }
  function allocSid() {
    for (let i = 0; i < 1e6; i++) {
      const s = nextSid; nextSid = nextSid >= 0x7FFFFFFD ? 1 : nextSid + 2;
      if (!socks.has(s)) return s;
    }
    return 0;
  }
  function track(s) { socks.set(s.sid, s); }

  // Dipanggil BridgeSocket._destroy
  const forget = (s) => { if (socks.get(s.sid) === s) socks.delete(s.sid); };

  function dropAll(why) {
    for (const s of [...socks.values()]) { s.remoteGone = true; s.destroy(new Error(why)); }
    socks.clear();
  }
  function dropPeer(peerId, why) {
    for (const s of [...socks.values()]) if (s.peerId === peerId) { s.remoteGone = true; s.destroy(new Error(why)); }
  }
  function resetLinks(why) {
    const ids = [...links.keys()]; links.clear();
    for (const id of ids) emitLink({ peerId: id, state: 'closed', reason: why });
  }

  const transport = {
    onIncoming: null,
    // peer.ip = "rtc:<id>". Null bila tidak ada link terbuka (Core menganggapnya tidak terjangkau; tidak memicu penyambungan baru).
    connect(peer) {
      const id = peer && Transport.rtcId(peer.ip);
      if (!epoch || !id || !links.has(id) || socks.size >= MAX_SOCKS) return null;
      const sid = allocSid(); if (!sid) return null;
      const s = new BridgeSocket(api, sid, id); track(s);
      if (!out({ op: 'open', sid, peer: id })) { s.remoteGone = true; s.destroy(); return null; }
      process.nextTick(() => { if (!s.destroyed) s.emit('connect'); }); // optimis: UI menahan penulisan sampai stream terbuka; kegagalan = rst
      return s;
    },
    reachable(id) { return !!epoch && links.has(id); },
    // Core berhenti (stop): beri tahu UI per stream lalu lepas.
    close() {
      if (epoch) { for (const s of [...socks.values()]) s.destroy(new Error('Core berhenti')); out({ op: 'detached' }); }
      api.detach();
    },
  };

  const api = {
    transport,
    _out: out, _data: data, _closed: forget,
    stats,
    get epoch() { return epoch; },
    links: () => [...links.entries()].map(([peerId, v]) => ({ peerId, path: v.path, since: v.since })),
    // pendengar perubahan link: ({ peerId, state: 'open'|'closed', path? })
    onLink(cb) { listeners.push(cb); },
    attached: () => !!epoch,

    detach() {
      if (!epoch) { dropAll('ditutup'); return; }
      dropAll('UI berhenti'); resetLinks('ui-detached'); epoch = null;
    },

    // Pesan dari UI. Menerima satu objek atau larik (batch). Mengembalikan { ok, ... }.
    feed(msg) {
      if (Array.isArray(msg)) {
        if (msg.length > MAX_BATCH) return { ok: false, err: 'batch terlalu besar' };
        let last = { ok: true };
        for (const m of msg) { last = api.feed(m); if (!last.ok) return last; }
        return last;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.op !== 'string') return { ok: false, err: 'pesan tidak valid' };
      stats.msgsIn++;
      if (msg.op === 'attach') {
        if (typeof msg.e !== 'string' || !HEX16.test(msg.e)) return { ok: false, err: 'epoch tidak valid' };
        if (epoch && epoch !== msg.e) { out({ op: 'detached' }); }
        if (epoch !== msg.e) { dropAll('UI diganti'); resetLinks('ui-replaced'); }
        epoch = msg.e; nextSid = 1;
        return { ok: true };
      }
      if (!epoch || msg.e !== epoch) return { ok: false, err: 'epoch', stale: true }; // UI lama atau belum attach
      switch (msg.op) {
        case 'detach': api.detach(); return { ok: true };
        case 'link': {
          if (!HEX16.test(String(msg.peer))) return { ok: false, err: 'peer tidak valid' };
          if (msg.state === 'open') {
            const had = links.has(msg.peer);
            links.set(msg.peer, { path: ['direct', 'relay'].includes(msg.path) ? msg.path : 'unknown', since: Date.now() });
            if (!had) emitLink({ peerId: msg.peer, state: 'open', path: links.get(msg.peer).path });
            else emitLink({ peerId: msg.peer, state: 'update', path: links.get(msg.peer).path });
          } else if (msg.state === 'closed' || msg.state === 'failed') {
            const had = links.delete(msg.peer);
            dropPeer(msg.peer, 'link putus');
            if (had) emitLink({ peerId: msg.peer, state: 'closed', reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 40) : undefined });
          } else return { ok: false, err: 'state tidak valid' };
          return { ok: true };
        }
        case 'in': {
          const sid = msg.sid, peer = msg.peer;
          if (!Number.isInteger(sid) || sid <= 0 || sid % 2 !== 0 || !HEX16.test(String(peer))) return { ok: false, err: 'in tidak valid' };
          const ok = !socks.has(sid) && links.has(peer) && socks.size < MAX_SOCKS && typeof transport.onIncoming === 'function';
          if (!ok) { out({ op: 'rst', sid }); return { ok: true }; }
          const s = new BridgeSocket(api, sid, peer); track(s);
          try { transport.onIncoming(s, peer); } catch (e) { log('rtcbridge onIncoming: ' + (e && e.message)); s.destroy(); }
          return { ok: true };
        }
        case 'data': {
          const s = socks.get(msg.sid);
          if (!s) return { ok: true }; // stream sudah ditutup di sini: abaikan (UI akan mendapat rst)
          const b = decodeBytes(msg.d);
          if (!b) { out({ op: 'rst', sid: s.sid }); s.remoteGone = true; s.destroy(new Error('data tidak valid')); return { ok: true }; }
          stats.in += b.length;
          if (b.length) s._fromUi(b);
          return { ok: true };
        }
        case 'fin': { const s = socks.get(msg.sid); if (s) s._fromUiFin(); return { ok: true }; }
        case 'rst': { const s = socks.get(msg.sid); if (s) { s.remoteGone = true; s.destroy(new Error('stream di-reset oleh UI')); } return { ok: true }; }
        case 'ack': {
          const s = socks.get(msg.sid);
          if (s && Number.isInteger(msg.n) && msg.n > 0) s._onAck(msg.n);
          return { ok: true };
        }
        default: return { ok: false, err: 'op tidak dikenal' };
      }
    },
  };
  return api;
}

module.exports = { createBridge, BridgeSocket, decodeBytes, WINDOW, CHUNK, ACK_AT, RX_LIMIT, MAX_SOCKS };

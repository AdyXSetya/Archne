'use strict';
// src/archne-mqttlite.js — klien MQTT 3.1.1 kecil lewat WebSocket untuk inti Node (langkah 2a lintas jaringan di latar belakang).
// Alasan: di HP, klien MQTT di WebView ikut mati saat aplikasi ke latar. Inti Node tetap hidup (ArchneService), jadi presence dan signaling pindah ke sini.
// Antarmukanya sengaja sama dengan subset mqtt.js yang dipakai renderer/archne-wan.js: connect(url, opts) -> client { on, removeAllListeners, subscribe, publish, end }.
// Didukung: CONNECT (Last Will), SUBSCRIBE, PUBLISH QoS 0/1 (dan terima QoS 2 secara sederhana), PINGREQ, DISCONNECT, sambung ulang otomatis.
// Memakai WebSocket bawaan Node (opts.WebSocket untuk tes). Tanpa paket pihak ketiga.
const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX_PACKET = 1024 * 1024; // pesan lintas jaringan paling besar ~70 KB; batas ini melindungi dari broker yang rusak

function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const u16 = (n) => Uint8Array.of((n >> 8) & 255, n & 255);
const bstr = (s) => { const b = enc.encode(s); return concat([u16(b.length), b]); };
function varLen(n) {
  const o = [];
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; o.push(d); } while (n > 0);
  return Uint8Array.from(o);
}
const packet = (type, flags, body) => concat([Uint8Array.of((type << 4) | flags), varLen(body.length), body]);
const toBytes = (p) => (p instanceof Uint8Array ? p : enc.encode(String(p === undefined || p === null ? '' : p)));

// Pemisah paket: satu frame WebSocket bisa berisi sebagian paket atau beberapa paket.
class Parser {
  constructor() { this.buf = new Uint8Array(0); }
  feed(chunk) {
    this.buf = this.buf.length ? concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      let mul = 1, len = 0, i = 1, ok = false;
      for (; i < b.length && i <= 4; i++) {
        len += (b[i] & 127) * mul; mul *= 128;
        if (!(b[i] & 128)) { ok = true; i++; break; }
      }
      if (!ok) { if (i > 4) throw new Error('panjang paket MQTT tidak sah'); break; }
      if (len > MAX_PACKET) throw new Error('paket MQTT terlalu besar');
      if (b.length < i + len) break;
      out.push({ type: b[0] >> 4, flags: b[0] & 15, body: b.subarray(i, i + len) });
      this.buf = b.subarray(i + len);
    }
    return out;
  }
}

const encode = {
  connect(o) {
    let f = 0;
    if (o.clean !== false) f |= 0x02;
    const parts = [bstr('MQTT'), Uint8Array.of(4), null, u16(o.keepalive), bstr(o.clientId)];
    if (o.will) { f |= 0x04 | ((o.will.qos || 0) << 3) | (o.will.retain ? 0x20 : 0); }
    if (typeof o.username === 'string') f |= 0x80;
    if (typeof o.password === 'string') f |= 0x40;
    parts[2] = Uint8Array.of(f);
    if (o.will) { const wp = toBytes(o.will.payload); parts.push(bstr(o.will.topic), concat([u16(wp.length), wp])); }
    if (typeof o.username === 'string') parts.push(bstr(o.username));
    if (typeof o.password === 'string') parts.push(bstr(o.password));
    return packet(1, 0, concat(parts));
  },
  publish(topic, payload, qos, retain, id) {
    const parts = [bstr(topic)];
    if (qos > 0) parts.push(u16(id));
    parts.push(toBytes(payload));
    return packet(3, (qos << 1) | (retain ? 1 : 0), concat(parts));
  },
  subscribe(id, topics, qos) { return packet(8, 2, concat([u16(id)].concat(topics.map((t) => concat([bstr(t), Uint8Array.of(qos)]))))); },
  ack(type, id, flags) { return packet(type, flags || 0, u16(id)); },
  ping() { return packet(12, 0, new Uint8Array(0)); },
  disconnect() { return packet(14, 0, new Uint8Array(0)); },
};

function connect(url, opts) {
  const o = Object.assign({ keepalive: 30, reconnectPeriod: 1000, connectTimeout: 30000, clean: true }, opts || {});
  const WS = o.WebSocket || globalThis.WebSocket;
  const L = {};
  const self = {
    on(k, f) { (L[k] = L[k] || []).push(f); return self; },
    removeAllListeners(k) { if (k) delete L[k]; else for (const x of Object.keys(L)) delete L[x]; return self; },
  };
  const emit = (k, ...a) => { for (const f of (L[k] || []).slice()) { try { f(...a); } catch { /* pendengar tidak boleh merusak klien */ } } };
  let ws = null, parser = null, up = false, ended = false, nextId = 0, rt = null, ct = null, pt = null, pingWait = false, wsGen = 0;
  const acks = new Map(); // id -> callback (PUBACK / SUBACK)

  const id = () => { for (let i = 0; i < 65535; i++) { nextId = (nextId % 65535) + 1; if (!acks.has(nextId)) return nextId; } throw new Error('terlalu banyak paket tertunda'); };
  const send = (bytes) => { if (!ws || ws.readyState !== 1) return false; try { ws.send(bytes); return true; } catch { return false; } };
  const failAcks = (msg) => { const m = [...acks.values()]; acks.clear(); for (const cb of m) { try { cb(new Error(msg)); } catch { /* abaikan */ } } };
  const stopTimers = () => { clearTimeout(ct); ct = null; clearInterval(pt); pt = null; pingWait = false; };

  function dropped(why) { // dari onclose soket yang masih berlaku
    const was = up;
    up = false; stopTimers(); failAcks('tidak tersambung');
    ws = null; parser = null;
    if (ended) return;
    emit('close'); emit('offline');
    if (why === 'fatal') return;
    if (o.reconnectPeriod > 0 && !rt) rt = setTimeout(() => { rt = null; if (!ended) { emit('reconnect'); open(); } }, o.reconnectPeriod);
    void was;
  }

  function open() {
    const my = ++wsGen;
    let sock;
    try { sock = new WS(url, 'mqtt'); } catch (e) { emit('error', e); dropped(); return; }
    ws = sock; parser = new Parser();
    try { sock.binaryType = 'arraybuffer'; } catch { /* abaikan */ }
    const live = () => my === wsGen && ws === sock;
    ct = setTimeout(() => { if (!live() || up) return; emit('error', new Error('connack timeout')); try { sock.close(); } catch { /* abaikan */ } dropped(); }, o.connectTimeout);
    sock.onopen = () => { if (!live()) return; send(encode.connect({ clientId: o.clientId, keepalive: o.keepalive, clean: o.clean, will: o.will, username: o.username, password: o.password })); };
    sock.onmessage = (ev) => {
      if (!live()) return;
      let d = ev && ev.data;
      if (typeof d === 'string') return; // MQTT lewat WebSocket selalu biner
      if (d instanceof ArrayBuffer) d = new Uint8Array(d); else if (ArrayBuffer.isView(d)) d = new Uint8Array(d.buffer, d.byteOffset, d.byteLength); else return;
      let pk;
      try { pk = parser.feed(d); } catch (e) { emit('error', e); try { sock.close(); } catch { /* abaikan */ } dropped(); return; }
      for (const p of pk) { if (!live()) return; onPacket(p); }
    };
    sock.onerror = (e) => { if (live()) emit('error', e && e.error ? e.error : (e instanceof Error ? e : new Error((e && e.message) || 'WebSocket galat'))); };
    sock.onclose = () => { if (live()) dropped(); };
  }

  function onPacket(p) {
    const b = p.body;
    switch (p.type) {
      case 2: { // CONNACK
        const rc = b[1];
        if (rc !== 0) {
          emit('error', Object.assign(new Error('Connection refused: code ' + rc), { code: rc }));
          if (o.reconnectOnConnackError === false) { ended = true; try { ws.close(); } catch { /* abaikan */ } }
          else try { ws.close(); } catch { /* abaikan */ }
          return;
        }
        clearTimeout(ct); ct = null; up = true; pingWait = false;
        const ms = Math.max(250, (o.keepalive * 1000) / 2);
        pt = setInterval(() => { // pemeriksa sambungan mati: PINGRESP tidak datang dalam satu putaran = putus
          if (!up) return;
          if (pingWait) { emit('error', new Error('keepalive timeout')); try { ws.close(); } catch { /* abaikan */ } return; }
          if (send(encode.ping())) pingWait = true;
        }, ms);
        emit('connect', { sessionPresent: !!(b[0] & 1) });
        break;
      }
      case 3: { // PUBLISH
        const qos = (p.flags >> 1) & 3, retain = !!(p.flags & 1);
        if (b.length < 2) return;
        const tl = (b[0] << 8) | b[1]; let i = 2 + tl;
        if (b.length < i) return;
        const topic = dec.decode(b.subarray(2, i));
        let pid = 0;
        if (qos > 0) { if (b.length < i + 2) return; pid = (b[i] << 8) | b[i + 1]; i += 2; }
        const payload = Buffer.from(b.subarray(i));
        if (qos === 1) send(encode.ack(4, pid)); else if (qos === 2) send(encode.ack(5, pid));
        emit('message', topic, payload, { qos, retain, cmd: 'publish' });
        break;
      }
      case 4: case 7: { const cb = acks.get((b[0] << 8) | b[1]); if (cb) { acks.delete((b[0] << 8) | b[1]); cb(null); } break; } // PUBACK, PUBCOMP
      case 5: send(encode.ack(6, (b[0] << 8) | b[1], 2)); break; // PUBREC -> PUBREL
      case 6: send(encode.ack(7, (b[0] << 8) | b[1])); break; // PUBREL -> PUBCOMP
      case 9: { // SUBACK
        const k = (b[0] << 8) | b[1], cb = acks.get(k);
        if (!cb) break;
        acks.delete(k);
        const codes = Array.from(b.subarray(2));
        if (codes.some((c) => c === 0x80)) cb(new Error('subscribe ditolak broker')); else cb(null, codes);
        break;
      }
      case 13: pingWait = false; break; // PINGRESP
      default: break;
    }
  }

  self.subscribe = (topics, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const arr = Array.isArray(topics) ? topics : [topics], qos = Math.min(1, (opts && opts.qos) || 0);
    if (!up) { if (cb) setImmediate(() => cb(new Error('tidak tersambung'))); return self; }
    const k = id(); acks.set(k, (e, g) => { if (cb) cb(e, g); });
    if (!send(encode.subscribe(k, arr, qos))) { acks.delete(k); if (cb) setImmediate(() => cb(new Error('tidak tersambung'))); }
    return self;
  };
  self.publish = (topic, payload, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const qos = Math.min(1, (opts && opts.qos) || 0), retain = !!(opts && opts.retain);
    if (!up) { if (cb) setImmediate(() => cb(new Error('tidak tersambung'))); return self; }
    if (qos === 0) { const ok = send(encode.publish(topic, payload, 0, retain, 0)); if (cb) setImmediate(() => cb(ok ? null : new Error('tidak tersambung'))); return self; }
    const k = id(); acks.set(k, (e) => { if (cb) cb(e); });
    if (!send(encode.publish(topic, payload, 1, retain, k))) { acks.delete(k); if (cb) setImmediate(() => cb(new Error('tidak tersambung'))); }
    return self;
  };
  // end(force, opts, cb): putus rapi mengirim DISCONNECT (Last Will TIDAK disiarkan broker); force menutup soket langsung.
  self.end = (force, opts, cb) => {
    if (typeof force === 'function') { cb = force; force = false; } else if (typeof opts === 'function') { cb = opts; }
    const was = up, sock = ws;
    ended = true; clearTimeout(rt); rt = null; stopTimers();
    if (was && !force) send(encode.disconnect());
    up = false; failAcks('klien ditutup'); ws = null; wsGen++;
    if (sock) { const c = () => { try { sock.close(); } catch { /* abaikan */ } }; if (was && !force) setTimeout(c, 50); else c(); }
    if (was || sock) emit('close');
    emit('end');
    if (cb) setImmediate(cb);
    return self;
  };
  Object.defineProperty(self, 'connected', { get: () => up });

  open();
  return self;
}

module.exports = { connect, Parser, encode, _concat: concat };

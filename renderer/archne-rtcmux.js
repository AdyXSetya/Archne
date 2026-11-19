'use strict';
// Manajer DataChannel untuk mode lintas jaringan (langkah 3). Berjalan di UI. Dimuat dengan <script src="archne-rtcmux.js"> (global `ArchneRtcMux`); di Node (tes) lewat require().
//
// Dua lapis, keduanya murni (RTCPeerConnection dan wan disuntikkan, jadi bisa dites tanpa jaringan):
//
// 1. createMux(channel, opts)  -- multiplexing di atas SATU DataChannel (ordered, biner).
//    Satu stream logis = satu "koneksi TCP" lama di Core (permintaan/balasan sekali pakai, atau aliran berkas).
//    Bingkai: [streamId u32 BE][flag u8][payload]. Flag: 1 OPEN, 2 DATA, 3 FIN (half-close), 4 RST (batalkan).
//    - DATA dipecah per `maxPayload` (bawaan 16 KiB, aman lintas browser untuk SCTP) dan dikirim bergiliran antar stream
//      (stream besar tidak menahan stream kecil).
//    - Backpressure: tidak menulis ke channel selagi bufferedAmount > `high`; lanjut pada 'bufferedamountlow'. write() baru resolve
//      setelah seluruh datanya diserahkan ke channel, jadi penulis yang menunggu write() ikut terhambat.
//    - ID stream: sisi penawar memakai ganjil, sisi penjawab genap. OPEN dari sisi sendiri atau ID mundur = pelanggaran protokol.
//    - Pelanggaran protokol (bingkai pendek/besar, flag asing, pesan bukan biner, OPEN tidak sah, data setelah FIN) menutup link
//      atau me-reset stream yang bersangkutan; tidak pernah melempar ke pemanggil.
//    Kredit per stream (langkah 4, opsional): `window` > 0 mengaktifkan flow control per stream. Pengirim hanya boleh mengirim sebanyak kredit
//    (awalnya `window` byte); penerima memulihkannya dengan bingkai CREDIT [u32 BE jumlah] setelah aplikasi memanggil stream.consumed(n).
//    Dengan begitu penerima yang lambat (Core di balik IPC) tidak menumpuk memori di UI. SYARAT: kedua sisi memakai `window` yang sama, dan
//    aplikasi WAJIB memanggil consumed() untuk setiap byte yang sudah selesai diproses, kalau tidak aliran berhenti setelah `window` byte.
//    window = 0 (bawaan): tanpa kredit, perilaku langkah 3 tidak berubah.
//
// 2. createRtcMux({ wan, RTCPeerConnection, ... })  -- satu RTCPeerConnection + DataChannel per peer, lewat signaling `wan` (langkah 2).
//    - Aturan penawar: ID lebih kecil membuat offer (wan.isOfferer). Penjawab yang ingin menyambung mengirim `want`.
//    - Signaling (semua lewat wan.sendSignal, sudah bertanda tangan dan terenkripsi oleh Core):
//        offer {cid, sdp} | answer {cid, sdp} | ice {cid, c} | want {last} | reject {cid, why} | bye {cid}
//      `cid` = ID percobaan; sinyal dengan cid lain dibuang. Pengiriman sinyal diserialkan (offer selalu mendahului ICE-nya).
//    - Trickle ICE; kandidat yang tiba sebelum remote description disimpan dulu.
//    - Reconnect otomatis dengan backoff selama peer masih online di presence; `bye` (penutupan sengaja) menahan percobaan 60 detik.
//    - Batas sambungan (bawaan 8); alasan kegagalan dalam kode + penjelasan (ikut bahasa aplikasi; cadangan Indonesia) (mis. ice-failed = "butuh TURN").
//
// API:
//   const rm = createRtcMux({ wan, RTCPeerConnection?, iceServers?: array | () => array|Promise<array>, maxLinks?, autoConnect?, ... })
//   rm.connect(peerId) -> Promise<{peerId,state,...}>   // menolak dengan Error{reason}
//   rm.openStream(peerId) -> Promise<Stream>             // menyambung dulu bila perlu
//   rm.on('stream', (stream, peerId) => ...)             // stream masuk dari peer
//   rm.on('link', ({ peerId, state: 'connecting'|'open'|'closed'|'failed', reason?, explain?, path?: 'direct'|'relay'|'unknown' }) => ...)
//   rm.links() ; rm.close(peerId) ; rm.stop()
//   Stream: write(bytes|string) -> Promise ; end() -> Promise (half-close) ; destroy(err?) ; on('data'|'end'|'close'|'error'|'open', cb)
//           Jangan ubah buffer yang diberikan ke write() sebelum Promise-nya selesai.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.ArchneRtcMux = m;
})(typeof self !== 'undefined' ? self : this, function () {
  const F_OPEN = 1, F_DATA = 2, F_FIN = 3, F_RST = 4, F_CREDIT = 5, HDR = 5;
  const MUX_DEFAULTS = { maxPayload: 16 * 1024, high: 1024 * 1024, low: 256 * 1024, maxStreams: 64, recvMax: 256 * 1024, window: 0 };
  const LABEL = 'archne';
  const HEX16 = /^[0-9a-f]{16}$/;
  const DEFAULT_STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  const MAX_SDP = 16 * 1024;

  // Penjelasan galat untuk UI: tabel alasan -> [kunci i18n, cadangan Indonesia]. Dibaca saat explain() dipanggil, jadi mengikuti bahasa aktif.
  const EXPLAIN = {
    'ice-failed': ['rtcx.iceFailed', 'Tidak bisa tersambung langsung ke perangkat itu. Biasanya karena NAT yang ketat; salah satu sisi butuh server TURN yang berfungsi.'],
    timeout: ['rtcx.timeout', 'Perangkat itu tidak menjawab tepat waktu (mungkin offline atau aplikasinya ditutup).'],
    offline: ['rtcx.offline', 'Perangkat itu tidak sedang online di jaringan ini.'],
    busy: ['rtcx.busy', 'Perangkat itu sudah mencapai batas sambungan.'],
    'connection-lost': ['rtcx.connLost', 'Sambungan terputus.'],
    'channel-closed': ['rtcx.chanClosed', 'Saluran data ditutup.'],
    'remote-bye': ['rtcx.remoteBye', 'Sambungan ditutup oleh perangkat itu.'],
    closed: ['rtcx.closed', 'Sambungan ditutup.'],
    stopped: ['rtcx.stopped', 'Mode lintas jaringan dimatikan.'],
    setup: ['rtcx.setup', 'Gagal menyiapkan sambungan.'],
    superseded: ['rtcx.superseded', 'Digantikan percobaan sambungan yang lebih baru.'],
    'bad-channel': ['rtcx.badChannel', 'Saluran data tidak dikenali.'],
  };
  const tx = (k, fb) => (typeof I18N !== 'undefined' && I18N.tx ? I18N.tx(k) : fb); // tanpa I18N = teks Indonesia (tes Node/vm lama)
  const explain = (r) => { const e = Object.prototype.hasOwnProperty.call(EXPLAIN, r) ? EXPLAIN[r] : null; return e ? tx(e[0], e[1]) : String(r); };
  const rerr = (reason) => Object.assign(new Error(explain(reason)), { reason });

  class Emitter {
    constructor() { this._l = new Map(); }
    on(k, cb) { if (!this._l.has(k)) this._l.set(k, []); this._l.get(k).push(cb); return this; }
    count(k) { return (this._l.get(k) || []).length; }
    emit(k, ...a) { for (const cb of (this._l.get(k) || []).slice()) { try { cb(...a); } catch { /* pendengar tidak boleh merusak link */ } } }
  }

  function toBytes(d) {
    if (typeof d === 'string') return new TextEncoder().encode(d);
    if (d instanceof Uint8Array) return d;
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    if (Object.prototype.toString.call(d) === '[object ArrayBuffer]') return new Uint8Array(d);
    throw new TypeError('data harus string, ArrayBuffer, atau Uint8Array');
  }

  class Stream extends Emitter {
    constructor(api, id) {
      super(); this._api = api; this.id = id; this.q = []; this.inActive = false;
      this.openSent = false; this.localEnded = false; this.finSent = false; this.remoteEnded = false; this.closed = false; this.bytesIn = 0; this.bytesOut = 0;
      this.credit = 0; this.blocked = false; this.rx = 0; this.owed = 0; // kredit per stream (hanya bila window > 0)
    }
    consumed(n) { this._api.consumed(this, n); }
    write(data) { return this._api.write(this, data); }
    end() { return this._api.end(this); }
    destroy(err) { this._api.reset(this, err || null); }
  }

  // ---------------------------------------------------------------- 1. multiplexing
  function createMux(ch, o) {
    const cfg = Object.assign({}, MUX_DEFAULTS, o || {});
    if (!(cfg.maxPayload >= 1 && cfg.maxPayload <= MUX_DEFAULTS.recvMax)) throw new Error('maxPayload tidak valid'); // batas terima bawaan lawan = 256 KiB
    const initiator = !!cfg.initiator;
    const mux = new Emitter();
    const streams = new Map(), active = [];
    let nextId = initiator ? 1 : 2, lastRemote = 0, closed = false, pumping = false;

    function raw(id, flag, payload, off, len) {
      const f = new Uint8Array(HDR + len);
      f[0] = id >>> 24; f[1] = id >>> 16; f[2] = id >>> 8; f[3] = id; f[4] = flag;
      if (len) f.set(payload.subarray(off, off + len), HDR);
      ch.send(f);
    }

    function closeStream(s, err, sendRst) {
      if (s.closed) return;
      s.closed = true; streams.delete(s.id);
      const i = active.indexOf(s); if (i >= 0) active.splice(i, 1);
      s.inActive = false;
      const pend = s.q; s.q = [];
      const e = err || new Error('stream tertutup');
      for (const it of pend) if (it.rej) it.rej(e);
      if (sendRst && s.openSent && ch.readyState === 'open') { try { raw(s.id, F_RST, null, 0, 0); } catch { /* channel sudah mati */ } }
      if (err) s.emit('error', err);
      s.emit('close', err || null);
    }
    const maybeClose = (s) => { if (!s.closed && s.finSent && s.remoteEnded && !s.q.length) closeStream(s, null, false); };

    function closeAll(err) {
      if (closed) return;
      closed = true;
      const e = err || new Error('link ditutup');
      for (const s of [...streams.values()]) closeStream(s, e, false);
      active.length = 0;
      try { ch.onmessage = null; ch.onclose = null; ch.onbufferedamountlow = null; ch.onopen = null; } catch { /* abaikan */ }
      mux.emit('close', err || null);
    }
    const fatal = (e) => closeAll(e instanceof Error ? e : new Error(String(e)));

    function pump() {
      if (closed || pumping) return;
      pumping = true;
      try {
        while (active.length) {
          if (ch.readyState !== 'open') return;
          if (ch.bufferedAmount > cfg.high) return; // lanjut di 'bufferedamountlow'
          const s = active.shift(); s.inActive = false;
          const it = s.q[0];
          if (!it) continue;
          if (it.flag === F_DATA) {
            let n = Math.min(cfg.maxPayload, it.data.length - it.off);
            if (cfg.window) {
              n = Math.min(n, s.credit);
              if (n <= 0) { s.blocked = true; continue; } // menunggu CREDIT; tidak masuk antrean aktif
              s.credit -= n;
            }
            raw(s.id, F_DATA, it.data, it.off, n); it.off += n; s.bytesOut += n;
            if (it.off >= it.data.length) { s.q.shift(); it.res(); }
          } else {
            raw(s.id, it.flag, null, 0, 0); s.q.shift();
            if (it.flag === F_OPEN) { s.openSent = true; s.emit('open'); }
            else { s.finSent = true; it.res(); }
          }
          if (s.q.length) { active.push(s); s.inActive = true; } else maybeClose(s);
        }
      } catch (e) { fatal(e); } finally { pumping = false; }
    }
    function enqueue(s, it) {
      s.q.push(it);
      if (!s.inActive) { active.push(s); s.inActive = true; }
      pump();
    }

    const api = {
      write(s, data) {
        if (s.closed) return Promise.reject(new Error('stream tertutup'));
        if (s.localEnded) return Promise.reject(new Error('stream sudah di-end'));
        let d; try { d = toBytes(data); } catch (e) { return Promise.reject(e); }
        if (!d.length) return Promise.resolve();
        return new Promise((res, rej) => enqueue(s, { flag: F_DATA, data: d, off: 0, res, rej }));
      },
      end(s) {
        if (s.closed || s.localEnded) return Promise.resolve();
        s.localEnded = true;
        return new Promise((res, rej) => enqueue(s, { flag: F_FIN, res, rej }));
      },
      reset(s, err) { closeStream(s, err || new Error('stream dibatalkan'), true); },
      consumed(s, n) {
        if (!cfg.window || s.closed || !(n > 0)) return;
        n = Math.min(Math.floor(n), s.rx); if (n <= 0) return;
        s.rx -= n; s.owed += n;
        if (s.remoteEnded || s.owed < cfg.window / 4 || ch.readyState !== 'open') return; // belum perlu (atau sudah tidak ada yang dikirim lagi)
        const b = new Uint8Array(4), v = s.owed; s.owed = 0;
        b[0] = v >>> 24; b[1] = v >>> 16; b[2] = v >>> 8; b[3] = v;
        try { raw(s.id, F_CREDIT, b, 0, 4); } catch { /* channel sudah mati */ }
      },
    };

    function onFrame(id, flag, payload) {
      const s = streams.get(id);
      if (flag === F_OPEN) {
        if (payload.length) return fatal(new Error('OPEN tidak boleh membawa data'));
        if (id === 0 || (id & 1) !== (initiator ? 0 : 1) || id <= lastRemote) return fatal(new Error('OPEN tidak sah (id ' + id + ')'));
        lastRemote = id;
        if (streams.size >= cfg.maxStreams) { try { raw(id, F_RST, null, 0, 0); } catch { /* abaikan */ } return; }
        const ns = new Stream(api, id); ns.openSent = true; ns.credit = cfg.window; streams.set(id, ns);
        mux.emit('stream', ns);
        return;
      }
      if (!s) return; // stream sudah ditutup (data/FIN/RST yang terlambat) atau tidak pernah ada: abaikan, tidak dibalas RST (tanpa badai RST)
      if (flag === F_DATA) {
        if (s.remoteEnded) return closeStream(s, new Error('data setelah FIN'), true);
        if (cfg.window) { s.rx += payload.length; if (s.rx > cfg.window) return closeStream(s, new Error('melebihi jendela kredit'), true); }
        s.bytesIn += payload.length; s.emit('data', payload);
      } else if (flag === F_CREDIT) {
        if (!cfg.window) return; // lawan memakai kredit tetapi aku tidak: abaikan (tidak merusak link)
        if (payload.length !== 4) return fatal(new Error('CREDIT harus 4 byte'));
        const v = ((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0;
        if (v === 0 || s.credit + v > 0x7FFFFFFF) return closeStream(s, new Error('CREDIT tidak sah'), true);
        s.credit += v;
        if (s.blocked) { s.blocked = false; if (s.q.length && !s.inActive) { active.push(s); s.inActive = true; } pump(); }
      } else if (flag === F_FIN) {
        if (payload.length) return fatal(new Error('FIN tidak boleh membawa data'));
        if (s.remoteEnded) return;
        s.remoteEnded = true; s.emit('end'); maybeClose(s);
      } else if (flag === F_RST) {
        closeStream(s, new Error('stream di-reset oleh peer'), false);
      }
    }

    ch.binaryType = 'arraybuffer';
    try { ch.bufferedAmountLowThreshold = cfg.low; } catch { /* abaikan */ }
    ch.onbufferedamountlow = () => pump();
    ch.onopen = () => { pump(); mux.emit('open'); };
    ch.onclose = () => closeAll(new Error('saluran data ditutup'));
    ch.onmessage = (ev) => {
      if (closed) return;
      const d = ev && ev.data;
      let u;
      if (Object.prototype.toString.call(d) === '[object ArrayBuffer]') u = new Uint8Array(d);
      else if (ArrayBuffer.isView(d)) u = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      else return fatal(new Error('pesan bukan biner'));
      if (u.length < HDR) return fatal(new Error('bingkai terlalu pendek'));
      if (u.length - HDR > cfg.recvMax) return fatal(new Error('bingkai terlalu besar'));
      const flag = u[4];
      if (flag < F_OPEN || flag > F_CREDIT) return fatal(new Error('flag tidak dikenal'));
      onFrame(((u[0] << 24) | (u[1] << 16) | (u[2] << 8) | u[3]) >>> 0, flag, u.subarray(HDR));
    };

    mux.open = function () {
      if (closed) throw new Error('link ditutup');
      if (streams.size >= cfg.maxStreams) throw new Error('terlalu banyak stream');
      if (nextId > 0xFFFFFFFF) throw new Error('ID stream habis');
      const s = new Stream(api, nextId); nextId += 2; s.credit = cfg.window; streams.set(s.id, s);
      enqueue(s, { flag: F_OPEN });
      return s;
    };
    mux.close = function () { closeAll(new Error('link ditutup')); try { ch.close(); } catch { /* abaikan */ } };
    mux.isOpen = () => !closed && ch.readyState === 'open';
    mux.size = () => streams.size;
    mux.pending = () => active.length;
    return mux;
  }

  // ---------------------------------------------------------------- 2. manajer link
  function createRtcMux(opts) {
    opts = opts || {};
    const wan = opts.wan;
    const RTC = opts.RTCPeerConnection || (typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null);
    if (!wan || typeof wan.sendSignal !== 'function') throw new Error('wan diperlukan');
    if (!RTC) throw new Error('RTCPeerConnection tidak tersedia');
    const cfg = Object.assign({
      maxLinks: 8, autoConnect: true, connectTimeoutMs: 30000, disconnectGraceMs: 8000, sendTimeoutMs: 5000,
      backoffMs: [1000, 2000, 4000, 8000, 16000, 30000, 60000], byeCooldownMs: 60000, mux: {},
    }, opts);
    const now = opts.now || Date.now;
    const T = opts.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };
    const rand = opts.rand || Math.random;
    const ev = new Emitter();
    const links = new Map();      // peerId -> link aktif (menyambung atau terbuka)
    const online = new Set();
    const retries = new Map();    // peerId -> { n, t }
    const cooldown = new Map();   // peerId -> waktu (ms) sampai auto-connect boleh lagi (setelah bye)
    const lastCid = new Map();    // peerId -> cid link terakhir (untuk `want`)
    const early = new Map();      // peerId -> { cid, list } ICE yang tiba sebelum offer-nya
    const wanted = new Set();
    let stopped = false;

    const rand16 = () => { let s = ''; for (let i = 0; i < 16; i++) s += Math.floor(rand() * 16).toString(16); return s; };
    const newCid = () => { // ID percobaan: acak 16 heks (bukan rahasia; hanya mencegah sinyal basi tercampur)
      const c = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues) ? globalThis.crypto : null;
      if (!c) return rand16();
      const a = new Uint8Array(8); c.getRandomValues(a);
      return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
    };

    // Sinyal keluar diserialkan: offer harus sampai sebelum ICE-nya. Satu pengiriman yang macet tidak boleh menahan yang lain selamanya.
    let sendQ = Promise.resolve();
    function send(to, body) {
      sendQ = sendQ.then(() => new Promise((res) => {
        let done = false; const fin = (v) => { if (!done) { done = true; T.clearTimeout(tm); res(v); } };
        const tm = T.setTimeout(() => fin(false), cfg.sendTimeoutMs);
        Promise.resolve().then(() => wan.sendSignal(to, body)).then(fin, () => fin(false));
      }));
      return sendQ;
    }

    const publicLink = (L) => ({ peerId: L.peerId, state: L.state, initiator: L.initiator, path: L.path, since: L.since, openedAt: L.openedAt || null, cid: L.cid });
    const emitLink = (L, extra) => ev.emit('link', Object.assign(publicLink(L), extra || {}, extra && extra.reason ? { explain: explain(extra.reason) } : {}));

    function mkLink(peerId, initiator) {
      return { peerId, initiator, cid: null, pc: null, dc: null, mux: null, state: 'connecting', since: now(), openedAt: 0, remoteSet: false, answerSeen: false,
        pendingIce: [], outIce: [], descSent: false, nIn: 0, nOut: 0, waiters: [], connT: null, graceT: null, path: 'unknown', dead: false };
    }
    const inCooldown = (id) => (cooldown.get(id) || 0) > now();

    function armTimer(L) {
      L.connT = T.setTimeout(() => teardown(L, L.remoteSet ? 'ice-failed' : 'timeout'), cfg.connectTimeoutMs);
    }

    function teardown(L, reason, o) {
      o = o || {};
      if (L.dead) return;
      L.dead = true;
      T.clearTimeout(L.connT); T.clearTimeout(L.graceT);
      if (L.cid) lastCid.set(L.peerId, L.cid);
      const wasOpen = L.state === 'open';
      L.state = o.state || (wasOpen ? 'closed' : 'failed');
      if (links.get(L.peerId) === L) links.delete(L.peerId);
      if (o.bye && L.cid) send(L.peerId, { k: 'bye', cid: L.cid }); // lebih dulu dari penutupan channel (lawan tetap bisa melihat channel mati sebelum bye tiba; lihat onBye)
      try { if (L.mux) L.mux.close(); } catch { /* abaikan */ }
      try { if (L.dc) L.dc.close(); } catch { /* abaikan */ }
      try { if (L.pc) { L.pc.onicecandidate = null; L.pc.onconnectionstatechange = null; L.pc.oniceconnectionstatechange = null; L.pc.ondatachannel = null; L.pc.close(); } } catch { /* abaikan */ }
      if (!o.silent) {
        for (const w of L.waiters.splice(0)) w.rej(rerr(reason));
        emitLink(L, { reason });
      }
      if (!o.noRetry && !o.silent && !stopped) scheduleRetry(L.peerId);
      autoFill();
    }

    function scheduleRetry(peerId) {
      if (stopped || !(cfg.autoConnect || wanted.has(peerId)) || !online.has(peerId)) return;
      const r = retries.get(peerId) || { n: 0, t: null };
      if (r.t) return;
      const base = cfg.backoffMs[Math.min(r.n, cfg.backoffMs.length - 1)];
      r.n++; retries.set(peerId, r);
      r.t = T.setTimeout(() => { r.t = null; ensure(peerId, true); }, Math.round(base * (0.8 + 0.4 * rand())));
    }
    const clearRetry = (id) => { const r = retries.get(id); if (r) { T.clearTimeout(r.t); retries.delete(id); } };

    // Menyambung ke peer bila boleh (dipanggil dari presence, pewaktu retry, dan setelah link lepas).
    function ensure(peerId, fromRetry) {
      if (stopped || links.has(peerId) || !online.has(peerId) || inCooldown(peerId) || links.size >= cfg.maxLinks) return;
      if (!(cfg.autoConnect || wanted.has(peerId))) return;
      if (!fromRetry && (retries.has(peerId) || (!wan.isOfferer(peerId) && !wanted.has(peerId)))) return; // otomatis: hanya penawar yang memulai; yang sedang backoff menunggu pewaktunya
      connect(peerId, { auto: true }).catch(() => {});
    }
    function autoFill() { for (const id of online) ensure(id, false); }

    async function resolveIce() {
      try {
        const v = typeof cfg.iceServers === 'function' ? await cfg.iceServers() : cfg.iceServers;
        if (Array.isArray(v)) return v;
      } catch { /* pakai bawaan */ }
      return DEFAULT_STUN;
    }

    async function newPc(L) {
      const iceServers = await resolveIce();
      if (L.dead) return null;
      const pc = new RTC({ iceServers, iceTransportPolicy: 'all' });
      L.pc = pc;
      pc.onicecandidate = (e) => {
        if (L.dead || !e || !e.candidate || L.nOut >= 64) return;
        L.nOut++;
        const c = e.candidate;
        const item = { candidate: String(c.candidate), sdpMid: c.sdpMid == null ? null : String(c.sdpMid), sdpMLineIndex: c.sdpMLineIndex == null ? null : c.sdpMLineIndex };
        if (c.usernameFragment) item.usernameFragment = String(c.usernameFragment);
        if (L.descSent) send(L.peerId, { k: 'ice', cid: L.cid, c: item }); else L.outIce.push(item);
      };
      const onState = () => {
        if (L.dead) return;
        const s = pc.connectionState || ({ checking: 'connecting', completed: 'connected' }[pc.iceConnectionState] || pc.iceConnectionState); // WebView lama: hanya iceConnectionState
        if (s === 'failed') teardown(L, L.state === 'open' ? 'connection-lost' : 'ice-failed');
        else if (s === 'disconnected') {
          if (!L.graceT) L.graceT = T.setTimeout(() => { L.graceT = null; teardown(L, L.state === 'open' ? 'connection-lost' : 'ice-failed'); }, cfg.disconnectGraceMs);
        } else if (s === 'connected') { T.clearTimeout(L.graceT); L.graceT = null; }
      };
      pc.onconnectionstatechange = onState;
      pc.oniceconnectionstatechange = onState;
      pc.ondatachannel = (e) => { if (!L.initiator && !L.dead && e && e.channel) bindDc(L, e.channel); };
      return pc;
    }

    function sendDesc(L, k, desc) {
      send(L.peerId, { k, cid: L.cid, sdp: desc.sdp });
      L.descSent = true;
      for (const c of L.outIce.splice(0)) send(L.peerId, { k: 'ice', cid: L.cid, c });
    }

    function flushPending(L) {
      for (const c of L.pendingIce.splice(0)) addIce(L, c);
    }
    function addIce(L, c) {
      try { Promise.resolve(L.pc.addIceCandidate(c)).catch(() => {}); } catch { /* kandidat buruk: abaikan */ }
    }

    function bindDc(L, dc) {
      if (dc.label !== LABEL) return teardown(L, 'bad-channel');
      L.dc = dc;
      const mux = createMux(dc, Object.assign({}, cfg.mux, { initiator: L.initiator }));
      L.mux = mux;
      mux.on('stream', (s) => { if (!L.dead && ev.count('stream')) ev.emit('stream', s, L.peerId); else s.destroy(); });
      mux.on('open', () => onOpen(L));
      mux.on('close', () => { if (!L.dead) teardown(L, L.state === 'open' ? 'channel-closed' : 'setup'); });
      if (dc.readyState === 'open') onOpen(L);
    }

    function onOpen(L) {
      if (L.dead || L.state === 'open') return;
      L.state = 'open'; L.openedAt = now();
      T.clearTimeout(L.connT); T.clearTimeout(L.graceT); L.graceT = null;
      clearRetry(L.peerId); early.delete(L.peerId);
      for (const w of L.waiters.splice(0)) w.res(publicLink(L));
      emitLink(L);
      detectPath(L);
    }

    // Jalur terpilih (langsung atau lewat relay), dibaca dari getStats; tidak tersedia = 'unknown'.
    function detectPath(L) {
      try {
        if (!L.pc || typeof L.pc.getStats !== 'function') return;
        Promise.resolve(L.pc.getStats()).then((rep) => {
          const by = new Map(); rep.forEach((v, k) => by.set(v.id || k, v));
          let pair = null;
          for (const v of by.values()) if (v.type === 'transport' && v.selectedCandidatePairId && by.get(v.selectedCandidatePairId)) pair = by.get(v.selectedCandidatePairId);
          if (!pair) for (const v of by.values()) if (v.type === 'candidate-pair' && (v.selected || v.nominated) && v.state === 'succeeded') pair = v;
          if (!pair) return;
          const lt = (by.get(pair.localCandidateId) || {}).candidateType, rt = (by.get(pair.remoteCandidateId) || {}).candidateType;
          if (!lt && !rt) return;
          L.path = (lt === 'relay' || rt === 'relay') ? 'relay' : 'direct';
          if (!L.dead) emitLink(L);
        }).catch(() => {});
      } catch { /* abaikan */ }
    }

    async function startOffer(L) {
      try {
        L.cid = newCid();
        const pc = await newPc(L); if (!pc) return;
        bindDc(L, pc.createDataChannel(LABEL, { ordered: true }));
        const offer = await pc.createOffer(); if (L.dead) return;
        await pc.setLocalDescription(offer); if (L.dead) return;
        sendDesc(L, 'offer', pc.localDescription || offer);
      } catch { teardown(L, 'setup'); }
    }

    function connect(peerId, o) {
      o = o || {};
      if (stopped) return Promise.reject(rerr('stopped'));
      if (!HEX16.test(String(peerId))) return Promise.reject(rerr('offline'));
      if (!o.auto) { cooldown.delete(peerId); wanted.add(peerId); }
      const cur = links.get(peerId);
      if (cur && cur.state === 'open') return Promise.resolve(publicLink(cur));
      if (cur) return new Promise((res, rej) => cur.waiters.push({ res, rej }));
      if (links.size >= cfg.maxLinks) return Promise.reject(rerr('busy'));
      if (!o.fromWant && !online.has(peerId)) return Promise.reject(rerr('offline'));
      const L = mkLink(peerId, wan.isOfferer(peerId));
      links.set(peerId, L);
      const p = new Promise((res, rej) => L.waiters.push({ res, rej }));
      armTimer(L); emitLink(L);
      if (L.initiator) startOffer(L); else send(peerId, o.auto ? { k: 'want', last: lastCid.get(peerId) || null, auto: true } : { k: 'want', last: lastCid.get(peerId) || null });
      return p;
    }

    async function openStream(peerId) {
      await connect(peerId);
      const L = links.get(peerId);
      if (!L || L.state !== 'open' || !L.mux) throw rerr('closed');
      return L.mux.open();
    }

    // ------------------------------------------------ sinyal masuk
    const validCid = (c) => typeof c === 'string' && HEX16.test(c);
    const validSdp = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_SDP && s.startsWith('v=0');
    function cleanCand(c) {
      if (!c || typeof c !== 'object' || typeof c.candidate !== 'string' || c.candidate.length > 512) return null;
      const mid = c.sdpMid == null ? null : c.sdpMid, idx = c.sdpMLineIndex == null ? null : c.sdpMLineIndex;
      if (mid !== null && (typeof mid !== 'string' || mid.length > 64)) return null;
      if (idx !== null && !(Number.isInteger(idx) && idx >= 0 && idx <= 8)) return null;
      const out = { candidate: c.candidate, sdpMid: mid, sdpMLineIndex: idx };
      if (typeof c.usernameFragment === 'string' && c.usernameFragment.length <= 64) out.usernameFragment = c.usernameFragment;
      return out;
    }

    async function onOffer(from, b) {
      if (wan.isOfferer(from)) return;                         // offer hanya sah dari ID yang lebih kecil dari ID-ku
      if (!validCid(b.cid) || !validSdp(b.sdp)) return;
      const old = links.get(from);
      if (old && old.cid === b.cid) return;                    // salinan
      if (!old && links.size >= cfg.maxLinks) { send(from, { k: 'reject', cid: b.cid, why: 'busy' }); return; }
      const L = mkLink(from, false); L.cid = b.cid;
      if (old) { if (old.state === 'connecting') L.waiters = old.waiters.splice(0); teardown(old, 'superseded', { silent: true, noRetry: true }); }
      links.set(from, L);
      const e = early.get(from);
      if (e && e.cid === b.cid) { L.pendingIce = e.list.slice(); early.delete(from); }
      armTimer(L); emitLink(L);
      try {
        const pc = await newPc(L); if (!pc) return;
        await pc.setRemoteDescription({ type: 'offer', sdp: b.sdp }); if (L.dead) return;
        L.remoteSet = true; flushPending(L);
        const ans = await pc.createAnswer(); if (L.dead) return;
        await pc.setLocalDescription(ans); if (L.dead) return;
        sendDesc(L, 'answer', pc.localDescription || ans);
      } catch { teardown(L, 'setup'); }
    }

    async function onAnswer(from, b) {
      if (!wan.isOfferer(from) || !validCid(b.cid) || !validSdp(b.sdp)) return;
      const L = links.get(from);
      if (!L || !L.initiator || L.cid !== b.cid || L.answerSeen || !L.pc || !L.descSent) return;
      L.answerSeen = true;
      try {
        await L.pc.setRemoteDescription({ type: 'answer', sdp: b.sdp }); if (L.dead) return;
        L.remoteSet = true; flushPending(L);
      } catch { teardown(L, 'setup'); }
    }

    function onIce(from, b) {
      if (!validCid(b.cid)) return;
      const c = cleanCand(b.c); if (!c) return;
      const L = links.get(from);
      if (L && L.cid === b.cid) {
        if (L.nIn++ >= 64) return;
        if (L.remoteSet && L.pc) addIce(L, c); else if (L.pendingIce.length < 64) L.pendingIce.push(c);
        return;
      }
      let e = early.get(from);                                 // tiba mendahului offer-nya (urutan jaringan tidak dijamin)
      if (!e || e.cid !== b.cid) { e = { cid: b.cid, list: [] }; early.set(from, e); }
      if (e.list.length < 32) e.list.push(c);
    }

    function onWant(from, b) {
      if (!wan.isOfferer(from)) return;                        // hanya penawar yang membuat offer
      if (b.last !== null && b.last !== undefined && !validCid(b.last)) return;
      const last = b.last == null ? null : b.last;
      if (b.auto === true && inCooldown(from)) return;         // want otomatis (retry) tidak menembus jeda setelah penutupan sengaja; want eksplisit pengguna menembus
      const L = links.get(from);
      if (L) {
        if (L.state === 'connecting') return;                  // offer sudah berjalan
        if (L.cid !== last) return;                            // want basi: merujuk link lama
        teardown(L, 'superseded', { silent: true, noRetry: true }); // sisi sana sudah menganggap link ini mati
      }
      if (links.size >= cfg.maxLinks) { send(from, { k: 'reject', cid: null, why: 'busy' }); return; }
      connect(from, { fromWant: true }).catch(() => {});
    }

    function onReject(from, b) {
      const L = links.get(from);
      if (!L || L.state !== 'connecting') return;
      if (b.cid === null || b.cid === undefined ? false : b.cid !== L.cid) return;
      teardown(L, 'busy');
    }

    // bye berlaku untuk link yang sedang berjalan MAUPUN yang baru saja mati (channel sering terlihat mati lebih dulu daripada bye yang lewat broker).
    function onBye(from, b) {
      if (!validCid(b.cid)) return;
      const L = links.get(from);
      const cur = !!L && L.cid === b.cid;
      if (!cur && lastCid.get(from) !== b.cid) return;
      cooldown.set(from, now() + cfg.byeCooldownMs); clearRetry(from);
      if (cur) teardown(L, 'remote-bye', { noRetry: true });
    }

    wan.on('signal', (m) => {
      if (stopped || !m || !HEX16.test(String(m.from)) || !m.body || typeof m.body !== 'object') return;
      const b = m.body;
      switch (b.k) {
        case 'offer': onOffer(m.from, b); break;
        case 'answer': onAnswer(m.from, b); break;
        case 'ice': onIce(m.from, b); break;
        case 'want': onWant(m.from, b); break;
        case 'reject': onReject(m.from, b); break;
        case 'bye': onBye(m.from, b); break;
        default: break;
      }
    });

    function syncPeers(list) {
      const next = new Set((list || []).map((p) => p.id));
      for (const id of online) {
        if (next.has(id)) continue;
        clearRetry(id);
        const L = links.get(id);
        if (L && L.state !== 'open') teardown(L, 'offline', { noRetry: true }); // yang sudah terbuka tetap hidup: DataChannel tidak bergantung pada broker
      }
      online.clear(); next.forEach((id) => online.add(id));
      autoFill();
    }
    wan.on('peers', syncPeers);
    if (typeof wan.peers === 'function') { try { syncPeers(wan.peers()); } catch { /* abaikan */ } }

    function close(peerId) {
      wanted.delete(peerId); clearRetry(peerId);
      cooldown.set(peerId, now() + cfg.byeCooldownMs);
      const L = links.get(peerId);
      if (L) teardown(L, 'closed', { bye: true, noRetry: true, state: 'closed' });
    }

    function stop() {
      if (stopped) return Promise.resolve();
      stopped = true;
      for (const id of [...retries.keys()]) clearRetry(id);
      for (const L of [...links.values()]) teardown(L, 'stopped', { bye: true, noRetry: true, state: 'closed' });
      return sendQ.then(() => undefined);
    }

    return {
      connect, openStream, close, stop,
      links: () => [...links.values()].map(publicLink),
      on: (k, cb) => { ev.on(k, cb); },
      explain,
    };
  }

  return { createMux, createRtcMux, explain, DEFAULT_STUN, F_OPEN, F_DATA, F_FIN, F_RST, F_CREDIT, HDR };
});

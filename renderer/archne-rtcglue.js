'use strict';
// Penyambung UI untuk jalur Core <-> DataChannel (mode lintas jaringan, langkah 4). Berjalan di UI, di sebelah archne-rtcmux.js.
// Dimuat dengan <script src="archne-rtcglue.js"> (global `ArchneRtcGlue`); di Node (tes) lewat require().
//
// Tugasnya hanya menyalin byte antara stream rtcmux dan jembatan Core (src/archne-rtcbridge.js, protokol pesan ada di berkas itu):
//   Core membuka stream      -> rm.openStream(peer) -> stream rtcmux
//   Peer membuka stream      -> rm.on('stream')     -> pesan `in` ke Core
//   byte dua arah, FIN, RST  -> disalin apa adanya; tidak ada parsing protokol Core di sini
//   link terbuka / putus     -> pesan `link` ke Core (Core menyapa peer, atau menganggapnya offline)
//
// Flow control (tanpa antrean tak terbatas di UI):
//   Core -> peer : write() ke stream rtcmux; `ack` dikirim ke Core setelah write() selesai (data sudah diserahkan ke DataChannel).
//   peer -> Core : byte dikirim ke Core; stream.consumed(n) dipanggil hanya setelah Core me-ack. SYARAT: rtcmux dibuat dengan
//                  mux: { window: ArchneRtcGlue.MUX_WINDOW } di kedua sisi, kalau tidak aliran peer -> Core tidak dibatasi.
//
// Pengiriman ke Core diserialkan dan dikelompokkan (satu panggilan rtcIn membawa banyak pesan; data kecil digabung) supaya jalur
// HTTP/base64 di Android tidak dibanjiri permintaan kecil, dan urutan pesan terjamin.
//
// API:
//   const glue = createRtcGlue({ rm, call: (batch) => Promise<{ok,stale?}>, base64?: bool, now?, timers? })
//   glue.feed(msg)       // dari api.onRtcb(...)
//   await glue.start()   // attach ke Core (epoch baru), lalu laporkan link yang sudah terbuka
//   glue.stop()          // detach, tutup semua stream
//   glue.restart()       // mulai ulang (mis. setelah SSE tersambung kembali): semua stream lama dibuang
//   glue.stats()
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.ArchneRtcGlue = m;
})(typeof self !== 'undefined' ? self : this, function () {
  const HEX16 = /^[0-9a-f]{16}$/;
  const MUX_WINDOW = 512 * 1024;     // kredit per stream rtcmux (harus sama di kedua sisi)
  const FLUSH_AT = 64 * 1024;        // gabungkan data peer -> Core sampai sebanyak ini sebelum dikirim
  const BATCH_BYTES = 256 * 1024;    // batas byte data per panggilan rtcIn
  const BATCH_MSGS = 128;
  const MAX_ENTRIES = 256;

  function b64enc(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64dec(str) {
    if (typeof Buffer !== 'undefined') { const b = Buffer.from(str, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
    const bin = atob(str), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function toU8(d) {
    if (typeof d === 'string') return b64dec(d);
    if (d instanceof Uint8Array) return d;
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    if (Object.prototype.toString.call(d) === '[object ArrayBuffer]') return new Uint8Array(d);
    return null;
  }
  function newEpoch() {
    const c = typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues ? globalThis.crypto : null;
    const a = new Uint8Array(8);
    if (c) c.getRandomValues(a); else for (let i = 0; i < 8; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function createRtcGlue(o) {
    o = o || {};
    const rm = o.rm, call = o.call;
    if (!rm || typeof rm.openStream !== 'function' || typeof rm.on !== 'function') throw new Error('rm (createRtcMux) diperlukan');
    if (typeof call !== 'function') throw new Error('call diperlukan');
    const base64 = o.base64 !== undefined ? !!o.base64 : (typeof location !== 'undefined' && !!location && /^https?:/.test(location.protocol || ''));
    const T = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };

    const ents = new Map(); // sid -> { sid, peer, s, q, pend, pendN, flushT, ackN, ackT, gone }
    let epoch = null, stopped = true, nextSid = 2, outQ = [], sending = false, gen = 0;
    const st = { restarts: 0, calls: 0, bytesToCore: 0, bytesFromCore: 0, rejected: 0 };

    // ------------------------------------------------ keluar (ke Core)
    function emit(msg) {
      if (!epoch) return;
      outQ.push(Object.assign({ e: epoch }, msg));
      if (!sending) { sending = true; T.setTimeout(pump, 0); }
    }
    async function pump() {
      const my = gen;
      try {
        while (outQ.length && my === gen) {
          let bytes = 0, n = 0;
          while (n < outQ.length && n < BATCH_MSGS && (n === 0 || bytes < BATCH_BYTES)) { const m = outQ[n]; if (m.d) bytes += m.d.length; n++; }
          const batch = outQ.splice(0, n);
          st.calls++;
          let r;
          try { r = await call(batch); } catch { r = null; }
          if (my !== gen) return;
          if (!r || (r.ok === false && r.stale)) { sending = false; return void T.setTimeout(() => { if (!stopped && my === gen) restart(); }, 0); } // Core tidak tercapai / tidak lagi mengenal epoch ini
          if (r.ok === false) st.rejected++; // pesan ditolak (bentuk salah): lanjut, stream yang bersangkutan akan di-rst Core
        }
      } finally { if (my === gen) sending = false; }
    }

    function sendData(ent, u8) {
      st.bytesToCore += u8.length;
      emit({ op: 'data', sid: ent.sid, d: base64 ? b64enc(u8) : u8 });
    }
    function flush(ent) {
      T.clearTimeout(ent.flushT); ent.flushT = null;
      if (!ent.pendN) return;
      let u8;
      if (ent.pend.length === 1) u8 = ent.pend[0].slice(); // salinan: tampilan pada buffer lain akan ikut diserialkan utuh lewat IPC
      else { u8 = new Uint8Array(ent.pendN); let off = 0; for (const p of ent.pend) { u8.set(p, off); off += p.length; } }
      ent.pend = []; ent.pendN = 0;
      sendData(ent, u8);
    }

    // ------------------------------------------------ stream <-> entri
    function mkEnt(sid, peer) { return { sid, peer, s: null, q: [], pend: [], pendN: 0, flushT: null, ackN: 0, ackT: null, gone: false }; }

    function drop(ent) {
      if (ents.get(ent.sid) === ent) ents.delete(ent.sid);
      T.clearTimeout(ent.flushT); T.clearTimeout(ent.ackT); ent.flushT = ent.ackT = null;
    }
    function kill(ent, tellCore) {
      if (ent.gone) return;
      ent.gone = true;
      const s = ent.s; ent.s = null;
      if (tellCore) { flush(ent); emit({ op: 'rst', sid: ent.sid }); }
      drop(ent);
      if (s) { try { s.destroy(); } catch { /* sudah mati */ } }
    }

    function bind(ent, s) {
      ent.s = s;
      s.on('data', (d) => {
        if (ent.gone) return;
        ent.pend.push(d); ent.pendN += d.length;
        if (ent.pendN >= FLUSH_AT) flush(ent);
        else if (!ent.flushT) ent.flushT = T.setTimeout(() => flush(ent), 0);
      });
      s.on('end', () => { if (ent.gone) return; flush(ent); emit({ op: 'fin', sid: ent.sid }); });
      s.on('close', (err) => {
        if (ent.gone) return;
        ent.s = null;
        if (err) { ent.gone = true; flush(ent); emit({ op: 'rst', sid: ent.sid }); }
        else ent.gone = true; // tutup normal: FIN sudah dilaporkan
        drop(ent);
      });
      for (const m of ent.q.splice(0)) applyToStream(ent, m);
    }

    function applyToStream(ent, m) {
      const s = ent.s; if (!s) return;
      if (m.op === 'data') {
        const n = m.u8.length; st.bytesFromCore += n;
        s.write(m.u8).then(() => ackLater(ent, n), () => {});
      } else if (m.op === 'fin') {
        s.end().catch(() => {});
      }
    }
    function ackLater(ent, n) {
      if (ent.gone) return;
      ent.ackN += n;
      if (!ent.ackT) ent.ackT = T.setTimeout(() => { ent.ackT = null; if (ent.ackN && !ent.gone) { const k = ent.ackN; ent.ackN = 0; emit({ op: 'ack', sid: ent.sid, n: k }); } }, 0);
    }

    // ------------------------------------------------ masuk (dari Core)
    function onOpen(m) {
      if (!Number.isInteger(m.sid) || m.sid <= 0 || m.sid % 2 !== 1 || !HEX16.test(String(m.peer)) || ents.has(m.sid)) return emit({ op: 'rst', sid: m.sid });
      const open = rm.links().some((l) => l.peerId === m.peer && l.state === 'open');
      if (!open || ents.size >= MAX_ENTRIES) return emit({ op: 'rst', sid: m.sid }); // tidak memicu penyambungan baru dari sapaan Core
      const ent = mkEnt(m.sid, m.peer); ents.set(m.sid, ent);
      const my = gen;
      rm.openStream(m.peer).then((s) => {
        if (my !== gen || ent.gone) { try { s.destroy(); } catch { /* abaikan */ } return; }
        bind(ent, s);
      }, () => { if (my === gen) kill(ent, true); });
    }

    function onData(m) {
      const ent = ents.get(m.sid); if (!ent || ent.gone) return;
      const u8 = toU8(m.d); if (!u8) return kill(ent, true);
      if (!u8.length) return;
      if (ent.s) applyToStream(ent, { op: 'data', u8 }); else ent.q.push({ op: 'data', u8 });
    }

    function feed(m) {
      if (stopped || !m || typeof m !== 'object') return;
      if (m.op === 'reconnect') return void restart(); // dipancarkan adaptor HTTP saat SSE tersambung kembali: event hilang, mulai dari nol
      if (m.e !== epoch) return;                        // milik UI/sesi lain
      switch (m.op) {
        case 'open': onOpen(m); break;
        case 'data': onData(m); break;
        case 'fin': { const ent = ents.get(m.sid); if (ent && !ent.gone) { if (ent.s) applyToStream(ent, { op: 'fin' }); else ent.q.push({ op: 'fin' }); } break; }
        case 'rst': { const ent = ents.get(m.sid); if (ent) kill(ent, false); break; }
        case 'ack': { const ent = ents.get(m.sid); if (ent && ent.s && Number.isInteger(m.n) && m.n > 0) ent.s.consumed(m.n); break; }
        case 'detached': stopLocal(); break; // UI lain mengambil alih
        default: break;
      }
    }

    // peer membuka stream ke Core
    rm.on('stream', (s, peer) => {
      if (stopped || !epoch || ents.size >= MAX_ENTRIES) { try { s.destroy(); } catch { /* abaikan */ } return; }
      const sid = nextSid; nextSid += 2; if (nextSid > 0x7FFFFFFE) nextSid = 2;
      const ent = mkEnt(sid, peer); ents.set(sid, ent);
      emit({ op: 'in', sid, peer });
      bind(ent, s);
    });

    rm.on('link', (ev) => {
      if (stopped || !ev || !HEX16.test(String(ev.peerId))) return;
      if (ev.state === 'open') emit({ op: 'link', peer: ev.peerId, state: 'open', path: ev.path });
      else if (ev.state === 'closed' || ev.state === 'failed') {
        emit({ op: 'link', peer: ev.peerId, state: ev.state, reason: ev.reason });
        for (const ent of [...ents.values()]) if (ent.peer === ev.peerId) kill(ent, false); // rtcmux sudah menutup stream-nya; Core menutup sisinya dari pesan link
      }
    });

    // ------------------------------------------------ siklus hidup
    function resetLocal() {
      gen++; sending = false; outQ = [];
      for (const ent of [...ents.values()]) { ent.gone = true; const s = ent.s; ent.s = null; drop(ent); if (s) { try { s.destroy(); } catch { /* abaikan */ } } }
      ents.clear();
    }
    function stopLocal() { stopped = true; resetLocal(); epoch = null; }

    function restart() {
      resetLocal();
      stopped = false; st.restarts++;
      epoch = newEpoch(); nextSid = 2;
      emit({ op: 'attach' });
      for (const l of rm.links()) if (l.state === 'open') emit({ op: 'link', peer: l.peerId, state: 'open', path: l.path });
      return drained();
    }
    // selesai bila antrean keluar kosong (atau setelah 2 detik)
    function drained() {
      return new Promise((res) => {
        const t0 = Date.now();
        const wait = () => { if ((!outQ.length && !sending) || Date.now() - t0 > 2000) res(); else T.setTimeout(wait, 2); };
        T.setTimeout(wait, 0);
      });
    }

    return {
      start: restart,
      restart,
      feed,
      stop() {
        if (stopped) return Promise.resolve();
        for (const ent of ents.values()) flush(ent);
        emit({ op: 'detach' });
        return drained().then(stopLocal); // kirim detach dulu, baru berhenti
      },
      stats: () => Object.assign({ streams: ents.size, queued: outQ.length, epoch }, st),
      active: () => !stopped,
    };
  }

  return { createRtcGlue, MUX_WINDOW, b64enc, b64dec };
});

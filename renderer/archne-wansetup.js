'use strict';
// Penyatu mode lintas jaringan di UI (langkah 6): menyalakan/mematikan tumpukan archne-wan.js + archne-rtcmux.js + archne-rtcglue.js mengikuti pengaturan di Core
// (api.wanSettings), dan menyajikan status untuk layar Pengaturan. Semua bagian disuntikkan, jadi bisa dites tanpa jaringan.
// Dimuat dengan <script src="archne-wansetup.js"> (global `ArchneWanSetup`); di Node (tes) lewat require().
//
//   const app = createWanApp({ api, mqtt, createWan, createWanRemote?, createRtcMux, createRtcGlue, MUX_WINDOW, RTCPeerConnection?, base64?, getName? })
//   Langkah 2c: bila inti Node memegang MQTT (api.wanHostView menjawab ok), presence + signaling dipakai lewat createWanRemote dan UI TIDAK membuka MQTT sendiri.
//   Bila tidak (Electron, peramban, host tidak ada / galat), jalur lama: createWan + mqtt di UI.
//   await app.sync()   // baca pengaturan Core; mulai / henti / mulai ulang bila berubah. Aman dipanggil berkali-kali (diserialkan).
//   app.view()         // { state: 'off'|'connecting'|'online'|'error', err, broker, peers: [{ id, name, state, note }] }
//   app.on('change', cb); await app.stop()
// state peer: 'waiting' (online di broker, belum disambung) | 'connecting' | 'direct' | 'relay' | 'failed'
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.ArchneWanSetup = m;
})(typeof self !== 'undefined' ? self : this, function () {
  // i18n (D4): galat yang tampil di UI. Tanpa I18N (Node murni / tes vm lama) teks Indonesia cadangan dipakai. Baris log teknis (dbg/note) sengaja tidak diterjemahkan.
  const tr = (k, fb, p) => (typeof I18N !== 'undefined' && I18N.tx ? I18N.tx(k, p) : (p ? fb.replace(/\{(\w+)\}/g, (m, x) => (p[x] != null ? p[x] : m)) : fb));
  function createWanApp(o) {
    const api = o.api;
    const L = [];
    const emit = () => L.forEach((cb) => { try { cb(); } catch (e) { /* pendengar tidak boleh merusak */ } });
    let cur = null;                 // { key, wan, rm, glue }
    let st = { state: 'off', err: '', broker: '' };
    let queue = Promise.resolve();
    let lastLog = []; // jejak tumpukan terakhir yang gagal (cur sudah dibuang)
    api.onRtcb((m) => { const c = cur; if (c && c.glue) c.glue.feed(m); });

    // Tahap yang tidak selesai dalam batas waktu dilaporkan sebagai galat bernama, bukan menggantung diam-diam.
    function within(p, what) {
      let t; const ms = o.stageMs || 20000;
      return Promise.race([p, new Promise((_r, rej) => { t = setTimeout(() => rej(new Error(tr('wans.stuck', 'Macet di tahap: {what} (>{s} dtk)', { what, s: Math.round(ms / 1000) }))), ms); })]).then((v) => { clearTimeout(t); return v; }, (e) => { clearTimeout(t); throw e; });
    }
    async function halt(c) {
      try { await c.rm.stop(); } catch (e) { /* lanjut */ }
      try { await c.wan.stop(); } catch (e) { /* lanjut */ }
      try { c.glue.stop(); } catch (e) { /* lanjut */ }
    }
    async function iceFromCore() { // DataChannel antar-Core selalu memakai konfigurasi lintas jaringan (STUN + TURN pengguna)
      try { const r = await api.turnIce(); if (r && r.ok && Array.isArray(r.iceServers)) return r.iceServers; } catch (e) { /* STUN bawaan rtcmux */ }
      return undefined;
    }
    async function hostAvailable() { // inti Node memegang MQTT? Galat / tenggat = tidak ada (jalur lama)
      if (!o.createWanRemote || typeof api.wanHostView !== 'function') return false;
      let t;
      try {
        const r = await Promise.race([Promise.resolve(api.wanHostView()), new Promise((_r, rej) => { t = setTimeout(() => rej(new Error('timeout')), o.hostProbeMs || 8000); })]);
        return !!(r && r.ok && r.view);
      } catch (e) { return false; } finally { clearTimeout(t); }
    }
    async function begin(set) {
      const viaHost = await hostAvailable();
      if (!viaHost && !o.mqtt) { st = { state: 'error', err: tr('wans.noMqtt', 'Pustaka MQTT tidak termuat'), broker: set.broker }; return; }
      const log = []; // jejak tahap (untuk layar Pengaturan): [jam, teks]
      const note = (m) => { log.push([Date.now(), String(m)]); if (log.length > 40) log.shift(); };
      note('mulai: broker ' + set.broker + (viaHost ? ' (MQTT di inti Node)' : ''));
      const wan = viaHost ? o.createWanRemote({ api, log: note }) : o.createWan({ api, mqtt: o.mqtt, log: note, nativeWs: o.nativeWs });
      const rm = o.createRtcMux({ wan, RTCPeerConnection: o.RTCPeerConnection, iceServers: iceFromCore, mux: { window: o.MUX_WINDOW } });
      const glue = o.createRtcGlue({ rm, call: (batch) => api.rtcIn(batch), base64: !!o.base64 });
      const c = { key: set.key, wan, rm, glue, fails: new Map(), lastErr: '', log, note }; // fails: peerId -> alasan gagal terakhir (links() hanya memuat link aktif)
      cur = c;
      st = { state: 'connecting', err: '', broker: set.broker };
      wan.on('status', (s) => { if (cur !== c) return; if (s.err) c.lastErr = s.err; if (s.state === 'online') c.lastErr = ''; st = { state: s.state === 'offline' ? 'off' : s.state, err: s.err || '', broker: set.broker }; emit(); }); // lastErr bertahan lewat 'menyambung ulang' supaya alasan gagal tidak hilang tertimpa
      wan.on('peers', () => { if (cur === c) emit(); });
      rm.on('link', (e) => { if (cur !== c) return; if (e.state === 'failed') c.fails.set(e.peerId, e.explain || e.reason || ''); else if (e.state === 'open' || e.state === 'connecting') c.fails.delete(e.peerId); emit(); });
      try {
        note('menyiapkan jembatan Core (glue.start)');
        await within(glue.start(), 'jembatan Core (glue.start)');
        note('jembatan siap');
        await within(wan.start({ broker: set.broker, name: (o.getName && o.getName()) || 'Anon' }), 'wan.start');
      } catch (e) {
        if (cur === c) { note('GAGAL: ' + ((e && e.message) || e)); lastLog = c.log.map((x) => x.slice()); st = { state: 'error', err: (e && e.message) || tr('wans.connFail', 'Gagal tersambung ke broker'), broker: set.broker }; await halt(c); cur = null; }
      }
    }
    async function doSync() {
      let r;
      try { r = await api.wanSettings(); } catch (e) { r = null; }
      const s = r && r.ok ? r.settings : null;
      const want = s && s.enabled && s.hasCode ? { key: s.netId + '|' + s.broker, broker: s.broker } : null;
      if (cur && (!want || want.key !== cur.key)) { const c = cur; cur = null; await halt(c); st = { state: 'off', err: '', broker: '' }; }
      if (want && !cur) await begin(want);
      emit();
    }
    function view() {
      const c = cur, peers = [];
      if (c && st.state !== 'error') {
        const links = new Map(c.rm.links().map((l) => [l.peerId, l]));
        const seen = new Set();
        for (const p of c.wan.peers()) { seen.add(p.id); peers.push(peerView(p.id, p.name, links.get(p.id), c.fails.get(p.id))); }
        for (const l of links.values()) if (!seen.has(l.peerId) && l.state === 'open') peers.push(peerView(l.peerId, '?', l)); // tersambung walau presence broker hilang
      }
      return { state: st.state, err: st.err, lastErr: c ? c.lastErr : '', log: c ? c.log.map((x) => x.slice()) : lastLog, broker: st.broker, peers };
    }
    function peerView(id, name, l, fail) {
      if (!l) return fail !== undefined ? { id, name, state: 'failed', note: fail } : { id, name, state: 'waiting', note: '' };
      if (l.state === 'open') return { id, name, state: l.path === 'relay' ? 'relay' : 'direct', note: '' };
      return { id, name, state: 'connecting', note: '' };
    }
    return {
      sync: () => (queue = queue.then(doSync, doSync)),
      view,
      stop: () => (queue = queue.then(async () => { const c = cur; cur = null; if (c) await halt(c); st = { state: 'off', err: '', broker: '' }; emit(); })),
      on: (k, cb) => { if (k === 'change') L.push(cb); },
    };
  }
  return { createWanApp };
});

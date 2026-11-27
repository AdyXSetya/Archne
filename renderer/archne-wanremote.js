'use strict';
// Klien lintas jaringan "jarak jauh" di UI (langkah 2c). MQTT (presence + signaling) sekarang hidup di inti Node (src/archne-wanhost.js),
// jadi UI tidak lagi membuka sambungan ke broker. Berkas ini hanya meniru bentuk ArchneWan (archne-wan.js) di atas api.wanHostView / wanHostSignal
// dan event wanst / wanpeers / wansig, supaya archne-rtcmux.js dan archne-wansetup.js tidak perlu tahu siapa yang memegang MQTT.
// Dimuat dengan <script src="archne-wanremote.js"> (global `ArchneWanRemote`); di Node (tes) lewat require().
//
// createWanRemote({ api, log? }) -> {
//   start() -> Promise   // minta tampilan host (status + peer), lalu mulai meneruskan event. Galat bila host tidak ada / belum menjawab.
//   stop() -> Promise    // berhenti meneruskan event. TIDAK mematikan host: sambungan ke broker milik inti Node dan tetap hidup.
//   sendSignal(to, body) -> Promise<bool>
//   peers() -> [{ id, name, ts }]; isOfferer(peerId) -> bool (ID lebih kecil membuat offer, sama dengan ArchneWan)
//   on('status' | 'peers' | 'signal', cb)  // bentuk sama dengan ArchneWan
// }
// Langkah 3d: signal yang ditahan host saat UI belum ada (view.pending) diputar ulang urut SEKALI saat start()/resync, lalu di-ack lewat api.wanHostAck(seq).
// Nomor seq terbesar yang sudah diproses disimpan di hub (per api), jadi event + pending yang tumpang tindih atau remote baru tidak memutar dua kali.
// api yang dipakai: wanHostView(), wanHostSignal(to, body), wanHostAck(seq) (opsional), onWanSt(cb), onWanPeers(cb), onWanSig(cb), dan (opsional) onRtcb(cb) untuk mendeteksi SSE tersambung ulang.
// Pendengar di adaptor HTTP tidak bisa dilepas, jadi didaftarkan SEKALI per api (WeakMap) dan meneruskan ke remote yang sedang aktif.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.ArchneWanRemote = m;
})(typeof self !== 'undefined' ? self : this, function () {
  const tr = (k, fb, p) => (typeof I18N !== 'undefined' && I18N.tx ? I18N.tx(k, p) : (p ? fb.replace(/\{(\w+)\}/g, (m, x) => (p[x] != null ? p[x] : m)) : fb));
  const HEX16 = /^[0-9a-f]{16}$/;
  const VIEW_MS = 8000; // tenggat menunggu jawaban host: inti Node yang macet tidak boleh menggantung UI

  const hubs = new WeakMap(); // api -> { cur }
  function hubOf(api) {
    let h = hubs.get(api);
    if (h) return h;
    h = { cur: null, seq: 0 };
    hubs.set(api, h);
    if (typeof api.onWanSt === 'function') api.onWanSt((s) => { if (h.cur) h.cur._st(s); });
    if (typeof api.onWanPeers === 'function') api.onWanPeers((l) => { if (h.cur) h.cur._peers(l); });
    if (typeof api.onWanSig === 'function') api.onWanSig((m) => { if (h.cur) h.cur._sig(m); });
    // SSE putus-sambung: event wanst/wanpeers yang lewat hilang. Ambil ulang tampilan host.
    if (typeof api.onRtcb === 'function') api.onRtcb((m) => { if (m && m.op === 'reconnect' && h.cur) h.cur._resync(); });
    return h;
  }

  function createWanRemote(opts) {
    const api = opts.api;
    const dbg = (m) => { try { if (opts.log) opts.log(m); } catch (e) { /* log tidak boleh merusak klien */ } };
    const L = { status: [], peers: [], signal: [] };
    const emit = (k, v) => L[k].forEach((cb) => { try { cb(v); } catch (e) { /* pendengar tidak boleh merusak klien */ } });
    const hub = hubOf(api);
    let active = false, myId = null, list = [], gen = 0;

    // Status host 'off' saat pengaturan baru menyala hanya sesaat (host menyusul lewat event 'update' Core): tampilkan sebagai menyambung, bukan mati.
    const mapState = (s, fromView) => {
      const state = s && s.state;
      if (state === 'off') return fromView ? { state: 'connecting' } : { state: 'offline' };
      if (state === 'connecting' || state === 'online' || state === 'offline' || state === 'error') return s.err ? { state, err: s.err } : { state };
      return { state: 'connecting' };
    };
    const norm = (l) => (Array.isArray(l) ? l.filter((p) => p && HEX16.test(String(p.id))).map((p) => ({ id: p.id, name: String(p.name == null ? '?' : p.name).slice(0, 32), ts: p.ts })) : []);

    async function fetchView() {
      let t; const to = new Promise((_r, rej) => { t = setTimeout(() => rej(new Error(tr('wanr.noAnswer', 'Inti aplikasi tidak menjawab'))), VIEW_MS); });
      try {
        const r = await Promise.race([Promise.resolve(api.wanHostView()), to]);
        if (!r || !r.ok || !r.view) throw new Error((r && r.err) || tr('wanr.noHost', 'Lintas jaringan di inti aplikasi tidak tersedia'));
        return r.view;
      } finally { clearTimeout(t); }
    }
    // Teruskan satu signal bila belum pernah diproses (seq lebih besar dari yang terakhir), lalu ack. Tanpa seq (host lama) = selalu diteruskan.
    function deliver(m) {
      if (!m || !HEX16.test(String(m.from))) return;
      const n = Number(m.seq);
      if (Number.isFinite(n)) { if (n <= hub.seq) return; hub.seq = n; }
      emit('signal', { from: m.from, ts: m.ts, body: m.body });
      if (Number.isFinite(n) && typeof api.wanHostAck === 'function') { try { Promise.resolve(api.wanHostAck(n)).catch(() => {}); } catch (e) { /* ack gagal: host membuangnya sendiri lewat umur */ } }
    }
    function apply(v) {
      if (typeof v.id === 'string' && HEX16.test(v.id)) myId = v.id;
      list = norm(v.peers);
      emit('status', mapState(v, true));
      emit('peers', list.slice());
      if (Array.isArray(v.pending)) v.pending.slice().sort((a, b) => a.seq - b.seq).forEach(deliver); // sesudah status + peers: penerima sudah tahu siapa yang online
    }

    const self = {
      async start() {
        const my = ++gen;
        if (typeof api.wanHostView !== 'function' || typeof api.wanHostSignal !== 'function') throw new Error(tr('wanr.noHost', 'Lintas jaringan di inti aplikasi tidak tersedia'));
        hub.cur = self; active = true; // pasang dulu: event yang datang selama menunggu tampilan tidak hilang
        dbg('minta tampilan host');
        let v;
        try { v = await fetchView(); } catch (e) { if (my === gen) { active = false; if (hub.cur === self) hub.cur = null; } throw e; }
        if (my !== gen || !active) return;
        apply(v);
        dbg('host: ' + v.state + ', ' + list.length + ' peer');
      },
      async stop() {
        gen++; active = false;
        if (hub.cur === self) hub.cur = null;
        list = []; // tidak mengirim 'peers' kosong / 'offline': host tetap tersambung, dan pemanggil sedang membongkar tumpukan UI
      },
      sendSignal(to, body) {
        if (!active || !HEX16.test(String(to))) return Promise.resolve(false);
        return Promise.resolve(api.wanHostSignal(to, body)).then((r) => !!(r && r.ok), () => false);
      },
      peers: () => list.slice(),
      isOfferer: (peerId) => !!myId && String(myId) < String(peerId),
      on: (k, cb) => { if (L[k]) L[k].push(cb); },
      // ---- dipanggil hub ----
      _st(s) { if (active) emit('status', mapState(s, false)); },
      _peers(l) { if (!active) return; list = norm(l); emit('peers', list.slice()); },
      _sig(m) { if (active) deliver(m); },
      _resync() { const my = gen; if (!active) return; fetchView().then((v) => { if (my === gen && active) apply(v); }, (e) => dbg('resync gagal: ' + (e && e.message))); },
    };
    return self;
  }

  return { createWanRemote };
});

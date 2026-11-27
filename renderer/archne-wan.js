'use strict';
// Klien mode lintas jaringan (langkah 2): MQTT untuk presence (dengan Last Will) dan signaling terenkripsi. Berjalan di UI.
// UI tidak memegang kode atau kunci: semua bungkus/buka lewat Core (api.wanSeal / api.wanOpen); UI hanya memindahkan string opak ke/dari broker.
// Dimuat dengan <script src="archne-wan.js"> (global `ArchneWan`) setelah vendor/mqtt.min.js (global `mqtt`); di Node (tes) lewat require().
//
// createWan({ api, mqtt, now?, rand?, timers? }) -> {
//   start({ broker, name }) -> Promise  // sambung ke broker; menyiarkan presence "online" (retained) dan memasang Last Will "offline"
//   stop() -> Promise                    // siarkan "offline" lalu putus
//   sendSignal(to, body) -> Promise<bool>
//   publishRaw(topic, payload, { retain }) -> Promise<bool>  // 4d: publish bungkus kotak surat yang sudah disegel Core (atau '' untuk mengosongkan titipan retained). Hanya topik kotak surat; true = broker menerima (QoS 1)
//   peers() -> [{ id, name, ts }] yang sedang online; isOfferer(peerId) -> bool (ID lebih kecil membuat offer; menghindari glare)
//   on('status' | 'peers' | 'signal' | 'mailbox', cb)  // status: { state: 'connecting'|'online'|'offline'|'error', err? }; signal: { from, ts, body }
//     mailbox (4c-3, hanya bila api.mailboxIn ada): hasil Core.mailboxIngest + topic: { action: 'stored'|'clear'|'retry'|'ignore', topic, mid?, why? }; deleted (4c-4): true/false bila titipan 'stored'/'clear' sudah dicoba dihapus dari broker
// }
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.ArchneWan = m;
})(typeof self !== 'undefined' ? self : this, function () {
  // i18n (D4): galat yang tampil di UI. Tanpa I18N (Node murni / tes vm lama) teks Indonesia cadangan dipakai. Baris log teknis (dbg/note) sengaja tidak diterjemahkan.
  const tr = (k, fb, p) => (typeof I18N !== 'undefined' && I18N.tx ? I18N.tx(k, p) : (p ? fb.replace(/\{(\w+)\}/g, (m, x) => (p[x] != null ? p[x] : m)) : fb));
  const HEARTBEAT_MS = 5 * 60 * 1000;  // siaran ulang presence (Core membuang online yang lebih tua dari 15 menit)
  const SWEEP_MS = 60 * 1000;
  const TTL_MS = 15 * 60 * 1000;
  const MAX_PEERS = 500;
  const SID_RE = /^[0-9a-f]{16}$/;
  const HEX16 = /^[0-9a-f]{16}$/;

  // ws:// hanya untuk localhost (percobaan); selain itu wajib wss://
  function validBroker(u) {
    if (typeof u !== 'string' || u.length > 300) return false;
    if (/^wss:\/\/[^\s/]+(\/[^\s]*)?$/i.test(u)) return true;
    return /^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?$/i.test(u);
  }

  const defaultRand = () => {
    const a = new Uint8Array(8);
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues) ? globalThis.crypto : require('crypto').webcrypto;
    c.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  };
  // Galat WebSocket peramban sering berupa Event tanpa pesan: beri petunjuk yang bisa ditindaklanjuti, bukan "[object Event]".
  const errText = (e) => (e && typeof e.message === 'string' && e.message ? e.message : tr('wanc.wsFail', 'WebSocket tidak bisa dibuka: port broker (mis. 8084) mungkin diblokir firewall/jaringan, atau broker menolak sambungan'));
  const decode = (p) => (typeof p === 'string' ? p : new TextDecoder().decode(p));

  function createWan(opts) {
    const api = opts.api, mqtt = opts.mqtt;
    const now = opts.now || Date.now;
    const rand = opts.rand || defaultRand;
    const dbg = (m) => { try { if (opts.log) opts.log(m); } catch (e) { /* log tidak boleh merusak klien */ } };
    const T = opts.timers || { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h) };
    const L = { status: [], peers: [], signal: [], mailbox: [] };
    const emit = (k, v) => L[k].forEach((cb) => { try { cb(v); } catch (e) { /* pendengar tidak boleh merusak klien */ } });
    const peerMap = new Map(); // id -> { id, name, sid, ts, online }
    let client = null, topics = null, myId = null, sid = null, name = '', hb = null, sweep = null, queue = Promise.resolve(), gen = 0, lastOnline = null, healT = null;

    const list = () => [...peerMap.values()].filter((p) => p.online).map((p) => ({ id: p.id, name: p.name, ts: p.ts })).sort((a, b) => (a.id < b.id ? -1 : 1));
    const changed = () => emit('peers', list());

    function onPresence(msg) {
      const b = msg.body;
      if (!b || (b.state !== 'online' && b.state !== 'offline') || typeof b.sid !== 'string' || !SID_RE.test(b.sid)) return;
      const cur = peerMap.get(msg.from);
      if (b.state === 'online') {
        if (cur && cur.sid === b.sid && msg.ts <= cur.ts) return;   // salinan lama / putar ulang dari sesi yang sama
        if (cur && cur.sid !== b.sid && msg.ts < cur.ts) return;     // sesi yang lebih lama dari yang sudah kuketahui
        if (!cur && peerMap.size >= MAX_PEERS) return;
        peerMap.set(msg.from, { id: msg.from, name: typeof b.name === 'string' ? b.name.slice(0, 32) : '?', sid: b.sid, ts: msg.ts, online: true });
      } else {
        // Last Will dibuat saat connect (ts-nya bisa jauh lebih lama dari online berikutnya), jadi sah-tidaknya ditentukan sid sesi, bukan ts.
        if (!cur || cur.sid !== b.sid || !cur.online) return;
        cur.online = false;
      }
      changed();
    }

    // Langkah 4c-3: kotak suratku. Hanya aktif bila Core memberi topics.mailbox DAN api.mailboxIn ada (host Node); di jalur UI/IPC tidak berlangganan.
    // Isi tidak dibuka di sini: string opak diteruskan ke Core (mailboxIn -> mailboxIngest). Hasilnya dipancarkan apa adanya lewat 'mailbox' (4c-4 memakainya untuk menghapus dari broker).
    const mboxOn = () => !!(topics && typeof topics.mailbox === 'string' && typeof api.mailboxIn === 'function');
    const isMbox = (topic) => mboxOn() && typeof topic === 'string' && topic.startsWith(topics.mailbox.slice(0, -1)) && topic.length <= 200;
    // 4c-4: hapus titipan dari broker = publish payload kosong ke topik retained itu. Hanya setelah Core menjawab 'stored' atau 'clear' (pesan sudah tersimpan atau memang tak perlu disimpan);
    // 'retry' dan 'ignore' dibiarkan. Gagal menghapus tidak berbahaya: titipan terbaca 'dup' di sambungan berikutnya lalu dihapus lagi.
    const delRetained = (c, topic) => new Promise((res) => {
      let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
      const t = setTimeout(() => fin(false), 5000);
      try { c.publish(topic, '', { qos: 1, retain: true }, (e) => { clearTimeout(t); fin(!e); }); } catch { clearTimeout(t); fin(false); }
    });
    async function handleMailbox(topic, payload) {
      const c = client;
      let r;
      try { const s = decode(payload); if (s.length > 70000) return; r = await api.mailboxIn(topic, s); } catch (e) { dbg('mailboxIn gagal: ' + (e && e.message)); return; }
      if (!r || typeof r !== 'object' || typeof r.action !== 'string') return;
      const out = Object.assign({}, r, { topic });
      if ((r.action === 'stored' || r.action === 'clear') && c && c === client) out.deleted = await delRetained(c, topic);
      emit('mailbox', out);
    }

    async function handle(topic, payload) {
      let r;
      try { r = await api.wanOpen(topic, decode(payload)); } catch { return; }
      const m = r && r.ok && r.msg;
      if (!m) return; // dibuang Core: kode salah, rusak, tanda tangan salah, basi, bukan untukku, diputar ulang
      if (m.type === 'presence') onPresence(m);
      else if (m.type === 'signal') emit('signal', { from: m.from, ts: m.ts, body: m.body });
    }

    async function publishPresence(state, retain) {
      const s = await api.wanSeal('presence', null, { state, sid, name });
      if (!s || !s.ok) throw new Error((s && s.err) || tr('wanc.sealFail', 'wanSeal gagal'));
      if (state === 'online') lastOnline = s.payload; // untuk mengenali gema siaranku sendiri (lihat heal)
      await new Promise((res, rej) => client.publish(s.topic, s.payload, { qos: 1, retain }, (e) => (e ? rej(e) : res())));
    }

    // Last Will sesi lama bisa tiba terlambat dan menimpa presence retained milikku (broker baru sadar sambungan lama mati setelah aku kembali).
    // Pesan apa pun di topik presence-ku selain siaranku sendiri berarti retained-ku mungkin salah: siarkan ulang "online".
    function heal(c) {
      if (healT) return;
      healT = setTimeout(() => { healT = null; if (c === client) publishPresence('online', true).catch(() => {}); }, 100);
    }

    async function start(o) {
      await stop();
      const myGen = ++gen;
      if (!validBroker(o && o.broker)) throw new Error(tr('wanc.badBroker', 'Alamat broker tidak valid (harus wss://)'));
      dbg('minta topik ke Core');
      const t = await api.wanTopics();
      if (!t || !t.ok) throw new Error((t && t.err) || tr('wanc.noCode', 'Kode jaringan belum diatur'));
      topics = t; myId = t.id; sid = rand(); name = String((o && o.name) || '').slice(0, 32);
      if (!SID_RE.test(sid)) throw new Error('sid tidak valid');
      dbg('topik OK; membungkus Last Will');
      const will = await api.wanSeal('presence', null, { state: 'offline', sid, name });
      if (!will || !will.ok) throw new Error((will && will.err) || tr('wanc.sealFail', 'wanSeal gagal'));
      dbg('Last Will OK; mqtt.connect ' + o.broker);
      if (myGen !== gen) return;
      emit('status', { state: 'connecting' });
      // Jalur: 'chromium' (WebSocket peramban) dulu; bila gagal sebelum pernah tersambung dan ada opts.nativeWs, pindah ke jalur Node di proses utama
      // (broker sama, jadi tetap satu jaringan dengan perangkat lain). Jalur yang berhasil dipakai terus, termasuk untuk sambung ulang otomatis.
      let useNative = false, everUp = false;
      const attach = () => {
        const native = useNative;
        const co = {
          clientId: 'archne-' + myId + '-' + sid.slice(0, 8), clean: true, keepalive: 30, reconnectPeriod: 3000, reconnectOnConnackError: true, connectTimeout: native || !opts.nativeWs ? 15000 : 10000,
          will: { topic: will.topic, payload: will.payload, qos: 1, retain: true },
        };
        if (native) co.createWebsocket = (u, p) => opts.nativeWs(u, p, dbg);
        // mqtt.js (varian timer 'auto') membuat Web Worker dari blob: untuk keepalive. CSP aplikasi melarangnya (worker-src), sehingga
        // _onConnect melempar SecurityError SESUDAH CONNACK dan 'connect' tidak pernah terpicu. Di Electron (ada nativeWs) pakai timer biasa.
        if (opts.nativeWs) co.timerVariant = 'native';
        dbg('jalur: ' + (native ? 'Node (proses utama)' : 'Chromium'));
        const c = mqtt.connect(o.broker, co);
        client = c;
        let switched = false;
        const failover = (why) => {
          if (native || everUp || switched || !opts.nativeWs || c !== client || myGen !== gen) return false;
          switched = true;
          dbg('Chromium gagal (' + why + '); beralih ke jalur Node');
          try { c.removeAllListeners && c.removeAllListeners(); c.on && c.on('error', () => {}); } catch (e) { /* lanjut */ }
          try { c.end(true); } catch (e) { /* lanjut */ }
          useNative = true; client = null;
          setTimeout(() => { if (myGen === gen && !client) attach(); }, 0);
          return true;
        };
        // Chromium bisa menggantung ~45 dtk tanpa galat (handshake macet): jangan menunggu selama itu
        const wd = setTimeout(() => { if (c !== client || myGen !== gen || up) return; if (!failover('tanpa balasan ' + Math.round(co.wdMs / 1000) + ' dtk')) dbg('belum ada CONNACK setelah ' + Math.round(co.wdMs / 1000) + ' dtk (jalur ' + (native ? 'Node' : 'Chromium') + ')'); }, co.wdMs = opts.watchdogMs || (native ? 20000 : 12000));
        let up = false; try { wd.unref && wd.unref(); } catch (e) { /* abaikan */ }
        let npk = 0;
        c.on('packetreceive', (p) => { if (npk++ < 4) dbg('mqtt terima: ' + (p && p.cmd) + (p && p.returnCode !== undefined ? ' rc=' + p.returnCode : '') + (p && p.reasonCode !== undefined ? ' reason=' + p.reasonCode : '')); });
        c.on('offline', () => dbg('mqtt: offline'));
        c.on('end', () => dbg('mqtt: end'));
        c.on('disconnect', (p) => dbg('mqtt: disconnect dari broker ' + JSON.stringify(p || {})));
        c.on('message', (topic, payload) => {
          if (c !== client) return;
          if (isMbox(topic)) { queue = queue.then(() => handleMailbox(topic, payload)); return; }
          if (topic === topics.mine) { if (decode(payload) !== lastOnline) heal(c); return; } // presence-ku sendiri: tidak perlu dibuka
          queue = queue.then(() => handle(topic, payload));
        });
        c.on('connect', () => {
          if (c !== client) return;
          everUp = true; up = true; clearTimeout(wd);
          dbg('broker menerima sambungan' + (native ? ' (jalur Node)' : '') + '; subscribe');
          c.subscribe(mboxOn() ? [topics.presence, topics.inbox, topics.mailbox] : [topics.presence, topics.inbox], { qos: 1 }, (e) => {
            dbg(e ? 'subscribe gagal' : 'subscribe OK; menerbitkan presence');
            if (e) return emit('status', { state: 'error', err: 'subscribe: ' + (e.message || e) });
            publishPresence('online', true).then(() => emit('status', { state: 'online' }), (e2) => emit('status', { state: 'error', err: String(e2 && e2.message || e2) }));
          });
        });
        c.on('reconnect', () => { dbg('menyambung ulang'); if (c === client) emit('status', { state: 'connecting' }); });
        c.on('close', () => { dbg('sambungan tertutup'); if (c !== client) return; if (failover('ditutup')) return; emit('status', { state: 'offline' }); });
        c.on('error', (e) => { dbg('galat: ' + errText(e)); if (c !== client) return; if (failover(e && e.message || 'galat')) return; emit('status', { state: 'error', err: errText(e) }); });
      };
      attach();
      hb = T.setInterval(() => { if (client) publishPresence('online', true).catch(() => {}); }, HEARTBEAT_MS);
      sweep = T.setInterval(() => { // online yang tidak diperbarui lebih dari TTL (Last Will tidak sampai) dianggap offline
        let ch = false;
        for (const p of peerMap.values()) if (p.online && now() - p.ts > TTL_MS) { p.online = false; ch = true; }
        if (ch) changed();
      }, SWEEP_MS);
    }

    async function stop() {
      gen++;
      const c = client;
      if (!c) return;
      client = null; lastOnline = null;
      if (healT) { clearTimeout(healT); healT = null; }
      if (hb) { T.clearInterval(hb); hb = null; }
      if (sweep) { T.clearInterval(sweep); sweep = null; }
      try {
        const s = await api.wanSeal('presence', null, { state: 'offline', sid, name });
        if (s && s.ok) await new Promise((res) => { try { c.publish(s.topic, s.payload, { qos: 1, retain: true }, () => res()); } catch { res(); } setTimeout(res, 1500); });
      } catch { /* putus saja; Last Will menyusul dari broker */ }
      await new Promise((res) => { try { c.end(false, {}, () => res()); } catch { res(); } setTimeout(res, 500); });
      peerMap.clear(); changed();
      emit('status', { state: 'offline' });
    }

    async function sendSignal(to, body) {
      if (!client || !HEX16.test(String(to))) return false;
      const s = await api.wanSeal('signal', to, body);
      if (!s || !s.ok) return false;
      return new Promise((res) => client.publish(s.topic, s.payload, { qos: 1, retain: false }, (e) => res(!e)));
    }

    // 4d: publish apa adanya (string opak dari Core). Hanya topik titipan archne/v1/<net>/m/<penerima>/<mid>; sambungan yang sedang putus langsung gagal
    // (tanpa diantre mqtt.js), supaya Core menjadwalkan percobaan ulang dengan id baru dan bukan menumpuk publish tertunda.
    const MBOX_TOPIC = /^archne\/v1\/[0-9a-f]{16}\/m\/[0-9a-f]{16}\/[0-9a-f]{16}$/;
    function publishRaw(topic, payload, o) {
      const c = client;
      if (!c || c.connected === false || typeof topic !== 'string' || !MBOX_TOPIC.test(topic) || typeof payload !== 'string' || payload.length > 70000) return Promise.resolve(false);
      return new Promise((res) => {
        let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
        const t = setTimeout(() => fin(false), 8000);
        try { c.publish(topic, payload, { qos: 1, retain: !!(o && o.retain) }, (e) => { clearTimeout(t); fin(!e); }); } catch { clearTimeout(t); fin(false); }
      });
    }

    return {
      start, stop, sendSignal, publishRaw, peers: list,
      isOfferer: (peerId) => !!myId && String(myId) < String(peerId),
      on: (k, cb) => { if (L[k]) L[k].push(cb); },
    };
  }

  return { createWan, validBroker };
});

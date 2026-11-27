'use strict';
// src/archne-wanhost.js — host mode lintas jaringan di inti Node (langkah 2b).
// Menjalankan ArchneWan (renderer/archne-wan.js) di Node memakai klien MQTT kecil (archne-mqttlite.js), dengan `api` langsung ke Core
// (wanTopics/wanSeal/wanOpen), jadi presence dan signaling tetap hidup saat WebView dijeda di latar belakang HP.
// Bentuk hasil api sama dengan handler IPC di archne-ipc.js, jadi logika presence/signal di ArchneWan tidak berubah.
//
// createWanHost({ core, mqtt?, createWan?, send, log?, getName?, onWake?, now?, wakeGapMs? }) -> {
//   onWake({ from, who, ts })  // langkah 3a: dipanggil saat signal 'offer'/'want' masuk; tertahan wakeGapMs (30 dtk) per peer
//   sync()          // samakan dengan core.wanSettings() (enabled, kode, broker): nyalakan, matikan, atau sambung ulang bila berubah
//   stop()          // matikan dan lepas dari core
//   sendSignal(to, body) -> Promise<bool>
//   view()          // { id (ID inti sendiri, untuk aturan penawar di UI), state: 'off'|'connecting'|'online'|'offline'|'error', err, broker, peers: [{ id, name, ts }] }
//   isOfferer(peerId)
//   drain()         // langkah 4d: kuras outbox kotak surat (core.mailboxPlan -> publish -> core.mailboxOutDone). Jalan sendiri saat sambungan online, saat Core berubah, dan tiap mailboxMs (30 dtk)
//   ackSignals(seq)  // langkah 3b: UI sudah memproses signal sampai nomor seq (termasuk): buang dari pending
// view().pending = [{ seq, from, ts, body }]: signal yang belum di-ack (urut seq naik), dibatasi 50 dan umur 120 dtk. Signal dari peer yang diblokir
// tidak ditahan, tidak dikirim ke UI, dan tidak membangunkan. Event 'wansig' membawa seq: { seq, from, ts, body }.
// }
// Ke UI lewat send(channel, payload): 'wanst' { state, err? }, 'wanpeers' [{ id, name, ts }], 'wansig' { from, ts, body }.
const Invite = require('./archne-invite');
const { createWan } = require('../renderer/archne-wan');
const mqttlite = require('./archne-mqttlite');

function createWanHost(o) {
  const core = o.core;
  const mqtt = o.mqtt || mqttlite;
  const make = o.createWan || createWan;
  const log = (m) => { try { if (o.log) o.log('[wanhost] ' + m); } catch { /* log tidak boleh merusak host */ } };
  const send = (ch, p) => { try { if (o.send) o.send(ch, p); } catch { /* UI tidak boleh merusak host */ } };

  // api untuk ArchneWan: sama dengan jawaban IPC (wanTopics/wanSeal/wanOpen), tanpa lewat UI.
  const api = {
    async wanTopics() {
      const t = core.wanTopics();
      if (!t) return { ok: false, err: 'Mode lintas jaringan belum diatur' };
      const mb = core.mailboxFilter && core.mailboxFilter(); // 4c-3: langganan kotak suratku hanya di host Node (jalur IPC/UI tidak menyertakannya)
      return Object.assign({ ok: true, id: core.id }, t, mb ? { mailbox: mb } : {});
    },
    // 4c-3: satu pesan dari langganan kotak suratku -> Core. Hasil { action, ... } (stored|clear|retry|ignore); tidak pernah melempar.
    async mailboxIn(topic, payload) {
      if (typeof topic !== 'string' || topic.length > 200 || typeof payload !== 'string' || payload.length > 70000) return { action: 'ignore', why: 'bad' };
      try { return core.mailboxIngest(topic, payload); } catch (e) { log('mailboxIngest gagal: ' + (e && e.message)); return { action: 'ignore', why: 'error' }; }
    },
    async wanSeal(kind, to, body) {
      if (kind !== 'presence' && kind !== 'signal') throw new Error('Jenis tidak valid');
      return Object.assign({ ok: true }, core.wanSeal(kind, kind === 'signal' ? String(to) : null, body));
    },
    async wanOpen(topic, payload) {
      if (typeof topic !== 'string' || topic.length > 200 || typeof payload !== 'string' || payload.length > 70000) return { ok: true, msg: null };
      return { ok: true, msg: core.wanOpen(topic, payload) };
    },
  };

  // Langkah 3a: hanya 'offer'/'want' yang membangunkan UI, dan per peer ditahan supaya tidak membanjiri notifikasi.
  const now = o.now || (() => Date.now());
  const gap = o.wakeGapMs == null ? 30000 : o.wakeGapMs;
  const lastWake = new Map();
  // Langkah 3b: signal yang belum di-ack UI ditahan (batas jumlah dan umur) supaya UI yang bangun belakangan bisa memutarnya.
  const PEND_MAX = 50, PEND_TTL = o.pendingTtlMs == null ? 120000 : o.pendingTtlMs;
  let seq = now(), pending = []; // seq mulai dari waktu: tetap naik walau inti Node dimulai ulang (UI membuang seq lama = ganda)
  const prune = () => { const t = now(); pending = pending.filter((e) => t - e.at < PEND_TTL).slice(-PEND_MAX); };
  const blocked = (id) => { try { return !!core.isBlocked(id); } catch { return false; } };
  function maybeWake(m) {
    if (!o.onWake || !m || !m.body || (m.body.k !== 'offer' && m.body.k !== 'want')) return;
    const t = now(), prev = lastWake.get(m.from);
    if (prev != null && t - prev < gap) return;
    lastWake.set(m.from, t);
    let who = m.from;
    try { const p = wan && wan.peers().find((x) => x.id === m.from); if (p && p.name) who = p.name; } catch { /* nama opsional */ }
    try { o.onWake({ from: m.from, who, ts: t }); } catch (e) { log('onWake gagal: ' + (e && e.message)); }
  }

  // Langkah 4d: pengurasan outbox kotak surat. Hanya satu putaran pada satu waktu; permintaan yang datang selama berjalan memicu satu putaran lagi.
  // Core yang menentukan apa yang boleh dititipkan (menyala, peer offline, kuota, percobaan ulang); host hanya mem-publish dan melapor.
  let draining = false, again = false, drainT = null, mbTimer = null;
  async function drain() {
    if (draining) { again = true; return; }
    draining = true;
    try {
      do {
        again = false;
        const w = wan;
        if (stopped || !w || status.state !== 'online' || typeof core.mailboxPlan !== 'function' || typeof w.publishRaw !== 'function') break;
        const jobs = core.mailboxPlan();
        for (const j of jobs) {
          let ok = false;
          try { ok = w === wan && status.state === 'online' ? await w.publishRaw(j.topic, j.payload, { retain: j.retain }) : false; } catch (e) { log('publish kotak surat gagal: ' + (e && e.message)); }
          try { core.mailboxOutDone(j.id, ok === true); } catch (e) { log('mailboxOutDone gagal: ' + (e && e.message)); }
        }
      } while (again && !stopped);
    } catch (e) { log('drain gagal: ' + (e && e.message)); }
    finally { draining = false; }
  }
  const drainSoon = () => { if (stopped || drainT) return; drainT = setTimeout(() => { drainT = null; drain(); }, o.drainDelayMs == null ? 200 : o.drainDelayMs); try { drainT.unref && drainT.unref(); } catch { /* abaikan */ } };
  mbTimer = setInterval(drainSoon, o.mailboxMs == null ? 30000 : o.mailboxMs);
  try { mbTimer.unref && mbTimer.unref(); } catch { /* abaikan */ }

  let wan = null, key = '', status = { state: 'off' }, stopped = false, busy = Promise.resolve();

  // Presence broker -> Core (status "online di latar"). Hanya bila broker tersambung; selain itu daftar dianggap kosong (tidak tahu = tidak hadir).
  const pushPresence = () => {
    try { if (typeof core.wanPresence === 'function') core.wanPresence(wan && status.state === 'online' ? wan.peers() : []); } catch (e) { log('wanPresence gagal: ' + (e && e.message)); }
  };
  // Core meminta peer yang hadir tetapi link-nya mati disambungi: kirim 'want' (hanya bila bukan aku penawarnya; penawar dibuat sendiri oleh rtcmux di UI).
  const onWakePeer = (e) => {
    try {
      if (!e || !wan || status.state !== 'online' || wan.isOfferer(e.id)) return;
      wan.sendSignal(e.id, { k: 'want', last: null, auto: true }).catch(() => {});
    } catch (err) { log('wakepeer gagal: ' + (err && err.message)); }
  };
  core.on('wakepeer', onWakePeer);

  const sig = () => {
    let s; try { s = core.wanSettings(); } catch { return null; }
    return s && s.enabled && s.hasCode ? { key: s.netId + '|' + s.broker, broker: s.broker } : null;
  };

  async function down() {
    const w = wan; wan = null; key = ''; pending = [];
    if (w) { try { await w.stop(); } catch (e) { log('stop gagal: ' + (e && e.message)); } }
    status = { state: 'off' };
    send('wanst', status); send('wanpeers', []); pushPresence();
  }

  async function up(s) {
    const w = make({ api, mqtt, log });
    w.on('status', (st) => { if (w !== wan) return; status = st; send('wanst', st); pushPresence(); if (st && st.state === 'online') drainSoon(); });
    w.on('peers', (l) => { if (w !== wan) return; send('wanpeers', l); pushPresence(); });
    w.on('mailbox', (r) => { if (w === wan && r && r.action !== 'ignore') log('kotak surat: ' + r.action + (r.why ? ' (' + r.why + ')' : '') + (r.deleted === true ? ' [dihapus dari broker]' : r.deleted === false ? ' [gagal dihapus]' : '')); }); // penghapusan dari broker dilakukan ArchneWan (4c-4)
    w.on('signal', (m) => {
      if (w !== wan || !m || blocked(m.from)) return;
      const e = { seq: ++seq, from: m.from, ts: m.ts, body: m.body, at: now() };
      pending.push(e); prune();
      send('wansig', { seq: e.seq, from: e.from, ts: e.ts, body: e.body });
      maybeWake(m);
    });
    wan = w; key = s.key; status = { state: 'connecting' };
    send('wanst', status);
    try { await w.start({ broker: s.broker, name: (o.getName && o.getName()) || core.name || 'Anon' }); }
    catch (e) {
      if (w !== wan) return;
      status = { state: 'error', err: String(e && e.message || e) };
      send('wanst', status);
      log('start gagal: ' + status.err);
    }
  }

  // Diserialkan: 'update' Core sering datang beruntun; hanya perubahan (enabled/netId/broker) yang menyambung ulang.
  function sync() {
    busy = busy.then(async () => {
      if (stopped) return;
      const s = sig();
      if (!s) { if (wan) await down(); return; }
      if (wan && key === s.key) return;
      if (wan) await down();
      await up(s);
    }).catch((e) => log('sync gagal: ' + (e && e.message)));
    return busy;
  }

  const onUpdate = () => { sync(); drainSoon(); };
  core.on('update', onUpdate);

  return {
    sync, drain,
    async stop() {
      stopped = true;
      if (drainT) { clearTimeout(drainT); drainT = null; }
      if (mbTimer) { clearInterval(mbTimer); mbTimer = null; }
      try { core.removeListener ? core.removeListener('update', onUpdate) : core.off && core.off('update', onUpdate); } catch { /* lanjut */ }
      try { core.removeListener('wakepeer', onWakePeer); } catch { /* lanjut */ }
      await busy;
      await down();
    },
    ackSignals(n) { n = Number(n); if (Number.isFinite(n)) pending = pending.filter((e) => e.seq > n); },
    sendSignal: (to, body) => (wan ? wan.sendSignal(to, body) : Promise.resolve(false)),
    isOfferer: (id) => !!wan && wan.isOfferer(id),
    view() {
      const s = sig();
      return { id: core.id, state: status.state, err: status.err, broker: s ? s.broker : (core.wanSettings().broker || Invite.DEFAULT_BROKER), peers: wan ? wan.peers() : [], pending: (prune(), pending.map((e) => ({ seq: e.seq, from: e.from, ts: e.ts, body: e.body }))) };
    },
  };
}

module.exports = { createWanHost };

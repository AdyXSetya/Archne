'use strict';
// Menjalankan Core + adaptor HTTP tanpa Electron. Dipakai server.js (peramban/Termux/PC) dan cangkang Android.
const { Core } = require('./archne-core');
const { createRpc } = require('./archne-rpc');
const { createCronService } = require('./archne-webcronhost');
const { createWanHost } = require('./archne-wanhost');

// Mesin PHP (0.34.0 P.2/P.3, Android): sama dengan main.js Electron. Pool Worker dibuat malas, jadi situs statis tidak membayar apa pun.
// o.php: true = pasang bawaan; objek = opsi tambahan untuk createPhpHost (tes: poolOpts, createPool, totalMem). Gagal dibuat = tanpa PHP (bukan galat fatal).
// Dipasang SEBELUM core.start(): peer mencatat caps dari hello, jadi penyaji lw_req harus sudah ada saat peer pertama terhubung (temuan P.5b).
function makePhpHost(core, o, log) {
  if (!o.php) return null;
  try {
    const { createPhpHost } = require('./archne-phphost');
    const { createMysqlHost } = require('./archne-mysql');
    const opts = typeof o.php === 'object' ? o.php : {};
    const host = createPhpHost(Object.assign({ core, log, mysql: createMysqlHost({ log }) }, opts));
    core.setPhpServe((siteId) => host.serve(siteId));
    return host;
  } catch (e) { log('mesin PHP tidak tersedia: ' + (e && e.message)); return null; }
}

const UPDATE_GAP_MS = 150;
// Gabungkan panggilan beruntun: yang pertama langsung jalan, yang datang dalam `gap` ms berikutnya dijadikan satu panggilan di ujung jendela. cancel() membatalkan yang tertunda.
function coalesce(fn, gap) {
  let t = null, pend = false, last = 0;
  const run = () => { last = Date.now(); try { fn(); } catch {} };
  const f = () => {
    const wait = gap - (Date.now() - last);
    if (!t && wait <= 0) { run(); return; }
    pend = true;
    if (!t) { t = setTimeout(() => { t = null; if (pend) { pend = false; run(); } }, Math.max(0, wait)); if (t.unref) t.unref(); }
  };
  f.cancel = () => { if (t) clearTimeout(t); t = null; pend = false; };
  return f;
}

async function startHeadless(o) {
  const log = o.log || (() => {});
  const core = new Core({ dataDir: o.dataDir, downloadDir: o.downloadDir, directShown: o.directShown, name: o.name || 'Anon', log });
  const php = makePhpHost(core, o, log);
  await core.start();
  // Cron (C6): hanya bila ada Mesin PHP (o.cron === false = dimatikan cangkang). Penjadwal baru hidup setelah ada job; dimulai SETELAH core.start().
  let cron = null;
  if (php && o.cron !== false) { try { cron = createCronService({ core, getPhpHost: () => php, log }); cron.start(); } catch (e) { cron = null; log('cron tidak tersedia: ' + (e && e.message)); } }
  const rpc = createRpc({ core, log, php, cron, host: o.host, port: o.port, token: o.token, canOpenFolder: o.canOpenFolder, canNotify: o.canNotify, canDirectCopy: o.canDirectCopy, pickSave: o.pickSave, pickArc: o.pickArc, metrics: o.metrics, onEvent: o.onEvent, siteAncestors: o.siteAncestors });
  // Pesan baru yang perlu diberi tahu (aturan bisu per chat ada di core.notifyOf). Hanya dikirim bila cangkang punya cara menampilkannya (Android).
  if (o.canNotify) core.on('reaction', (n) => { try { rpc.broadcast('notify', n); } catch (e) { log('notify reaksi gagal ' + e); } });
  if (o.canNotify) core.on('message', (m) => { try { const n = core.notifyRich(m); if (n) rpc.broadcast('notify', n); } catch (e) { log('notify gagal ' + e); } });
  // Sync riwayat memasukkan ratusan pesan beruntun dan tiap pesan memicu 'update'. Tiap 'update' membuat UI memanggil state() penuh lalu render ulang, jadi di HP
  // inti Node dan WebView kewalahan (Dasbor/Cron "Memuat..." dan peer lain melihat HP putus). Digabung: kejadian pertama langsung, sisanya satu per UPDATE_GAP_MS.
  const upd = coalesce(() => rpc.broadcast('update'), UPDATE_GAP_MS);
  core.on('update', upd);
  core.on('removed', (r) => rpc.broadcast('removed', r));
  // Lintas jaringan di inti Node (langkah 2b, hanya bila cangkang memintanya: o.wanHost). Presence dan signaling tetap hidup saat WebView dijeda.
  // Ke UI: event 'wanst' / 'wanpeers' / 'wansig'; dari UI: wanHostView() dan wanHostSignal(to, body). UI memakainya mulai langkah 2c.
  let wanHost = null;
  if (o.wanHost) {
    const wh = typeof o.wanHost === 'object' ? o.wanHost : {}; // true = bawaan; objek { mqtt?, createWan? } = penyuntikan untuk tes
    // onWake (langkah 3c): cangkang memakainya untuk menampilkan notifikasi saat ada offer/want masuk; boleh di o.onWake atau di objek wanHost.
    const onWake = wh.onWake || o.onWake;
    wanHost = createWanHost({ core, mqtt: wh.mqtt, createWan: wh.createWan, send: (ch, p) => rpc.broadcast(ch, p), log, getName: () => core.name, onWake: onWake ? (n) => { try { onWake(n); } catch (e) { log('onWake cangkang gagal ' + e); } } : undefined, now: wh.now, wakeGapMs: wh.wakeGapMs });
    rpc.handlers.set('wanHostAck', async (e, seq) => { wanHost.ackSignals(seq); return { ok: true }; });
    rpc.handlers.set('wanHostView', async () => ({ ok: true, view: wanHost.view() }));
    rpc.handlers.set('wanHostSignal', async (e, to, body) => ({ ok: typeof to === 'string' && /^[0-9a-f]{16}$/.test(to) ? await wanHost.sendSignal(to, body) : false }));
  }
  await rpc.start();
  if (wanHost) wanHost.sync(); // sesudah core.start(): bila mode sudah menyala dari sesi sebelumnya, langsung tersambung
  return { core, rpc, php, cron, wanHost, async stop() { if (wanHost) await wanHost.stop(); upd.cancel(); await rpc.stop(); if (cron) { try { cron.stop(); } catch {} } if (php) { try { php.closeAll(); } catch {} } await core.stop(); } };
}

module.exports = { startHeadless, coalesce };

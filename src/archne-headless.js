'use strict';
// Menjalankan Core + adaptor HTTP tanpa Electron. Dipakai server.js (peramban/Termux/PC) dan cangkang Android.
const { Core } = require('./archne-core');
const { createRpc } = require('./archne-rpc');

async function startHeadless(o) {
  const log = o.log || (() => {});
  const core = new Core({ dataDir: o.dataDir, downloadDir: o.downloadDir, directShown: o.directShown, name: o.name || 'Anon', log });
  await core.start();
  const rpc = createRpc({ core, log, host: o.host, port: o.port, token: o.token, canOpenFolder: o.canOpenFolder, canNotify: o.canNotify, canDirectCopy: o.canDirectCopy, pickSave: o.pickSave, pickArc: o.pickArc, onEvent: o.onEvent });
  // Pesan baru yang perlu diberi tahu (aturan bisu per chat ada di core.notifyOf). Hanya dikirim bila cangkang punya cara menampilkannya (Android).
  if (o.canNotify) core.on('reaction', (n) => { try { rpc.broadcast('notify', n); } catch (e) { log('notify reaksi gagal ' + e); } });
  if (o.canNotify) core.on('message', (m) => { try { const n = core.notifyRich(m); if (n) rpc.broadcast('notify', n); } catch (e) { log('notify gagal ' + e); } });
  core.on('update', () => rpc.broadcast('update'));
  core.on('removed', (r) => rpc.broadcast('removed', r));
  await rpc.start();
  return { core, rpc, async stop() { await rpc.stop(); await core.stop(); } };
}

module.exports = { startHeadless };

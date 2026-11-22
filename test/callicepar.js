'use strict';
// Kandidat ICE dikirim bersamaan (satu yang lambat tidak menahan yang lain), tapi tetap sesudah tawaran, dan 'end' tetap berurutan.
const assert = require('assert');
const M = require('../src/core/archne-call-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const log = [];
  const self = { _callSend: async (peer, p) => { log.push('s:' + (p.t === 'ice' ? p.data : p.t)); await sleep(p.data === 'slow' ? 200 : p.t === 'offer' ? 50 : 5); log.push('d:' + (p.t === 'ice' ? p.data : p.t)); return true; } };
  const c = { peer: 'x', q: Promise.resolve() };
  M._callQueue.call(self, c, { t: 'offer' });
  M._callQueue.call(self, c, { t: 'ice', data: 'slow' });
  M._callQueue.call(self, c, { t: 'ice', data: 'b' });
  const last = M._callQueue.call(self, c, { t: 'end' });
  await sleep(400); await last;
  assert.ok(log.indexOf('s:slow') > log.indexOf('d:offer'), 'ICE menunggu tawaran');
  assert.ok(log.indexOf('d:b') < log.indexOf('d:slow'), 'kandidat cepat tidak menunggu yang lambat');
  assert.ok(log.indexOf('s:end') > log.indexOf('d:offer'), 'end sesudah tawaran');
  console.log('  OK  callicepar');
})().catch((e) => { console.error(e); process.exit(1); });

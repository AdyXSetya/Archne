// Regresi: di peramban, setTimeout/clearTimeout/setInterval melempar "Illegal invocation" bila dipanggil dengan this selain global.
const assert = require('assert');
const strict = (fn) => function (...a) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return fn(...a); };
globalThis.setTimeout = strict(globalThis.setTimeout); globalThis.clearTimeout = strict(globalThis.clearTimeout);
globalThis.setInterval = strict(globalThis.setInterval); globalThis.clearInterval = strict(globalThis.clearInterval);
const LC = require('../renderer/archne-call.js');
(async () => {
  const w = { parent: { postMessage() {} }, addEventListener() {} };
  const b = LC.nativeBridge(w);
  const r = await b.ask('mic', undefined, 10);
  assert.strictEqual(r.res, 'timeout', 'ask() harus berjalan tanpa Illegal invocation');
  const rg = LC.makeRinger(function () { return { state: 'running', currentTime: 0, createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }, createOscillator() { return { frequency: {}, connect() {}, start() {}, stop() {} }; }, destination: {} }; });
  rg.start('in'); rg.stop();
  const c = new LC.Controller({ api: {}, rtc: {}, ui: {}, now: Date.now });
  c.setT(() => {}, 1); c.clearT(c.setT(() => {}, 1000));
  console.log('ok illegal invocation: timer dibungkus aman'); process.exit(0);
})().catch((e) => { console.error('GAGAL', e); process.exit(1); });

// Tes RNNoise sungguhan: memuat worklet + WASM dari renderer/vendor dengan tiruan AudioWorkletGlobalScope, lalu memeriksa bahwa bising diredam.
// (Kualitas suara bicara tetap harus didengar di perangkat: README.md bagian 6 (Manual tes).)
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert'; import { fileURLToPath, pathToFileURL } from 'node:url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'vendor');
let Proc;
globalThis.sampleRate = 48000; globalThis.currentTime = 0; globalThis.currentFrame = 0;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {}, addEventListener() {}, start() {} }; } };
globalThis.registerProcessor = (name, c) => { assert.strictEqual(name, '@sapphi-red/web-noise-suppressor/rnnoise'); Proc = c; };
Object.defineProperty(globalThis, 'process', { value: undefined, configurable: true }); // worklet asli tidak punya `process`
await import(pathToFileURL(path.join(dir, 'rnnoise-worklet.js')).href);
assert(Proc, 'worklet mendaftarkan prosesor');
for (const f of ['rnnoise_simd.wasm', 'rnnoise.wasm']) {
  const b = fs.readFileSync(path.join(dir, f));
  const p = new Proc({ processorOptions: { maxChannels: 1, wasmBinary: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } });
  await new Promise((r) => setTimeout(r, 300));
  const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const outs = [];
  for (let b2 = 0; b2 < 600; b2++) { const i = new Float32Array(128), o = new Float32Array(128); for (let k = 0; k < 128; k++) i[k] = rnd() * 0.1; assert(p.process([[i]], [[o]]) !== false); outs.push(...o); }
  const inR = 0.1 / Math.sqrt(3), outR = rms(outs.slice(-24000));
  assert(outR < inR * 0.6, f + ': bising putih turun > 4 dB (masuk ' + inR.toFixed(4) + ', keluar ' + outR.toFixed(4) + ')');
  console.log('  OK  ' + f + ': bising ' + inR.toFixed(4) + ' -> ' + outR.toFixed(4) + ' (' + (20 * Math.log10(outR / inR)).toFixed(1) + ' dB)');
}

'use strict';
// Runtime Node di Android bisa berjalan tanpa ICU: \p{L} melempar "Invalid property name in character class". Jalur cadangan filter spam
// harus (1) tidak melempar dan (2) menghasilkan kunci yang sama dengan jalur utama untuk teks tanpa aksen/bentuk lebar-penuh (yang butuh NFKD).
const assert = require('assert');
const { buildSpamNorm } = require('../src/archne-core');
const full = buildSpamNorm(true, true), plain = buildSpamNorm(false, false);
const LONG = 'Halo semuanya, hari ini kita rapat jam tiga sore di ruang biasa, tolong bawa laptop dan laporan mingguan masing-masing ya.';
const samples = [LONG, LONG + '.', LONG + ' ......', '  ' + LONG.toUpperCase() + '  ', LONG.replace('rapat', 'rapaat'), LONG.replace(/, /g, ' '),
  LONG + ' 😀', LONG.replace('Halo', 'Haloooooo'), '😀😀', '!!!', '你好，世界！', 'a-b_c d.e', '“kutip” — tanda – baca … «x»', 'Total: Rp 1.500.000,-'];
for (const t of samples) assert.strictEqual(plain(t), full(t), 'beda untuk: ' + t);
assert.strictEqual(plain('Halo, dunia!!!'), 'halodunia');
assert.strictEqual(plain('😀😀'), '😀😀', 'emoji saja dibandingkan apa adanya');
assert.doesNotThrow(() => plain('Héllo wörld'), 'aksen tidak melempar');
console.log('  OK  filter spam tanpa ICU: ' + samples.length + ' contoh sama dengan jalur utama, tidak melempar');
console.log('1 tes noicu OK');

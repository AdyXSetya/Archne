'use strict';
// Tes grid video tanpa gulir (v0.20.x): jumlah kartu -> data-n; CSS memetakan n ke kolom/baris untuk HP dan laptop.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const H = { esc: (x) => String(x), avatar: () => '', icons: { phone: 'P', mic: 'M', micOff: 'X', video: 'V', videoOff: 'W', head: 'H', headOff: 'G', add: 'A' }, meId: 'ME' };
const view = (others) => ({ phase: 'active', video: true, peer: 'P1', name: 'Budi', muted: false, deafened: false, since: 1, noise: 'standard', invite: false, members: [],
  legs: Array.from({ length: others }, (_, i) => ({ peer: 'P' + (i + 1), name: 'N' + (i + 1), state: 'active', video: true })), invites: [] });
const n = (html) => { const m = html.match(/class="cvg[^"]*" data-n="(\d+)"/); return m ? +m[1] : null; };
const tiles = (html) => [...html.matchAll(/data-vkey="/g)].length;

// 1. data-n = jumlah kartu (lawan + kamu), maksimal 8
for (let others = 1; others <= 7; others++) {
  const html = LC.overlayHtml(view(others), H);
  assert.strictEqual(tiles(html), others + 1, others + ' lawan: kartu');
  assert.strictEqual(n(html), others + 1, others + ' lawan: data-n');
}
ok('data-n mengikuti jumlah kartu (2..8), termasuk kamu');

// 2. undangan yang menunggu ikut dihitung (kartu "Mengundang…"), dan tidak lebih dari 8
{
  const v = view(2); v.invites = [{ peer: 'X1', name: 'A' }, { peer: 'X2', name: 'B' }];
  assert.strictEqual(n(LC.overlayHtml(v, H)), 5);
  const big = view(7); big.invites = [{ peer: 'Y1', name: 'A' }, { peer: 'Y2', name: 'B' }];
  assert.strictEqual(n(LC.overlayHtml(big, H)), 8, 'dibatasi 8');
}
ok('undangan menunggu ikut dihitung, batas 8');

// 3. mode perbesar tetap membawa data-n, tapi CSS-nya tidak memakai grid
{
  const html = LC.overlayHtml(view(3), Object.assign({}, H, { focus: 'P1' }));
  assert(/class="cvg grid focus" data-n="4"/.test(html));
}
ok('mode perbesar: kelas focus tetap ada');

// 4. CSS: tanpa gulir, peta kolom x baris
{
  const css = require('./_src').htmlSrc();
  assert(/#callov \.cvg:not\(\.focus\)\{display:grid;[^}]*overflow:hidden\}/.test(css), 'grid tanpa gulir');
  assert(!/\.cvg\.grid\{[^}]*overflow-y:auto/.test(css) && !/aspect-ratio:3\/4/.test(css), 'tidak ada lagi grid yang digulir atau kartu 3:4');
  const has = (re, m) => assert(re.test(css), m);
  has(/\.cvg\[data-n="3"\],#callov \.cvg\[data-n="4"\]\{--c:2;--r:2\}/, '3-4 = 2x2');
  has(/\.cvg\[data-n="5"\],#callov \.cvg\[data-n="6"\]\{--c:2;--r:3\}/, 'HP 5-6 = 2x3');
  has(/\.cvg\[data-n="7"\],#callov \.cvg\[data-n="8"\]\{--c:2;--r:4\}/, 'HP 7-8 = 2x4');
  has(/@media \(min-width:760px\)[^\n]*\[data-n="5"\],#callov \.cvg\[data-n="6"\]\{--c:3;--r:2\}/, 'laptop 5-6 = 3x2');
  has(/@media \(min-width:760px\)[^\n]*\[data-n="7"\],#callov \.cvg\[data-n="8"\]\{--c:4;--r:2\}/, 'laptop 7-8 = 4x2');
  has(/@media \(min-width:760px\)[^\n]*\[data-n="2"\]\{--c:2;--r:1\}/, 'laptop 2 = kiri-kanan');
}
ok('CSS: peta kolom/baris HP dan laptop, tanpa gulir');

// 5. notifikasi desktop tidak berbunyi untuk tawaran otomatis sesama anggota ruang
assert(/ev\.ev !== 'incoming' \|\| ev\.auto/.test(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')));
ok('main.js: tawaran otomatis (auto) tidak memunculkan notifikasi');

console.log('\ncallgrid: ' + pass + ' OK');

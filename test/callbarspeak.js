'use strict';
// Tombol layar panggilan bisa ditutup/dibuka (ketuk kartu yang diperbesar, gaya WhatsApp) + bingkai hijau saat peserta bicara (gaya Discord).
const assert = require('assert');
const LC = require('../renderer/archne-call');
const src = require('./_src').htmlSrc();
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };

// 1. ketuk kartu: perbesar + sembunyikan tombol; ketuk lagi = tombol muncul/hilang; kembali ke grid = tombol tampil
assert(/vidFocus = k; callBar = false/.test(src), 'memperbesar menyembunyikan tombol');
assert(/if \(k && vidFocus === k\) callBar = !callBar/.test(src), 'ketuk kartu yang sudah diperbesar membalik tombol');
assert(/a === 'unfocus'\) \{ vidFocus = null; callBar = true/.test(src), 'kembali ke grid memunculkan tombol');
assert(/if \(!vv\) callBar = true/.test(src), 'tanpa video tombol selalu ada');
assert(/hideBar[^\n]*\.cvg\.focus/.test(src) && /'nobar'/.test(src), 'kelas nobar hanya selagi ada kartu yang diperbesar');
assert(/#callov\.nobar>\*:not\(\.cvg\)\{display:none!important\}/.test(src) && /#callov\.nobar \.cvt\{border-radius:0\}/.test(src), 'CSS layar penuh');
ok('tombol bisa ditutup/dibuka; layar penuh tanpa tombol');

// 2. bingkai hijau
assert(/function spkApply/.test(src) && /classList\.toggle\('speaking'/.test(src) && /LC\.levelMeter/.test(src) && /spkSet\(!!v\)/.test(src));
assert(/\.cvt\.speaking \.cvp \.av/.test(src) && /#2fbf71/.test(src) && /\.cvt\.speaking::after\{border-color:#2fbf71\}/.test(src));
assert(/li\.speaking \.cpa \.av/.test(src) && /\.cav\.speaking \.av/.test(src), 'daftar suara dan avatar besar ikut');
ok('bingkai hijau saat bicara (kartu, baris, avatar besar)');

// 3. elemen yang ditandai ada di HTML: avatar besar 1-1 punya data-peer
{
  const H = { esc: (x) => String(x), avatar: () => '', icons: {}, meId: 'ME' };
  const html = LC.overlayHtml({ phase: 'active', peer: 'P', name: 'N', legs: [{ peer: 'P', state: 'active' }], invites: [], members: [], since: 1 }, H);
  assert(/class="cav" data-peer="P"/.test(html));
  const ch = LC.overlayHtml({ phase: 'active', vc: { cid: 'c', gid: 'g', name: 'X' }, legs: [{ peer: 'A', name: 'A', state: 'active' }], invites: [], members: [], since: 1, video: false, camOff: true }, H);
  assert(/<li class="[^"]*" data-peer="A"/.test(ch), 'channel suara tanpa kamera tetap memakai daftar (satu-satunya tempat melihat peserta)');
}
ok('data-peer tersedia untuk penanda bicara');
console.log('\ncallbarspeak: ' + pass + ' OK');

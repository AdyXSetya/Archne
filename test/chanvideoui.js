'use strict';
// Tes langkah 4: tampilan channel gaya Discord. Masuk hanya suara (daftar peserta); begitu ada yang menyalakan kamera, kartu video muncul di atas
// hanya untuk yang kameranya hidup (maks 4), daftar peserta suara tetap di bawah, tombol tetap di bawah.
const assert = require('assert'), fs = require('fs'), path = require('path');
const LC = require('../renderer/archne-call');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const H = { esc: (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), avatar: () => '', icons: { phone: 'P', mic: 'M', micOff: 'X', video: 'V', videoOff: 'W', head: 'H', headOff: 'G', add: 'A', flip: 'F' }, meId: 'ME' };
const leg = (peer, o) => Object.assign({ peer, name: 'N' + peer, state: 'active' }, o || {});
const view = (legs, o) => Object.assign({ phase: 'active', vc: { cid: 'cc', gid: 'gg', name: 'Ngobrol' }, legs, invites: [], members: [], since: 1, muted: false, deafened: false, video: false, camOff: true, noise: 'standard' }, o || {});
const keys = (html) => [...html.matchAll(/class="cvt[^"]*" data-vkey="([^"]*)"/g)].map((x) => x[1]);
const n = (html) => { const m = html.match(/class="cvg chv[^"]*" data-n="(\d+)"/); return m ? +m[1] : null; };

// 1. tanpa kamera: tampilan suara seperti sebelumnya
{
  const v = view([leg('A'), leg('B')]);
  const html = LC.overlayHtml(v, H);
  assert.strictEqual(LC.videoView(v), false); assert(!/class="cvg/.test(html) && /class="cpl"/.test(html) && /Channel suara · 3 orang/.test(html));
  const w = view([leg('A', { video: true }), leg('B', { video: true })]); // jalur video kosong ada di tiap kaki (leg.video), tapi tanpa kamera hidup
  assert.strictEqual(LC.videoView(w), false); assert(!/class="cvg/.test(LC.overlayHtml(w, H)));
}
ok('tanpa kamera hidup: tampilan suara; jalur video kosong tidak dihitung');

// 2. satu kamera lawan: satu kartu, daftar peserta lengkap tetap ada, tombol di bawah
{
  const v = view([leg('A', { cam: true }), leg('B', { cam: false }), leg('C')]);
  const html = LC.overlayHtml(v, H);
  assert.strictEqual(LC.videoView(v), true); assert.deepStrictEqual(keys(html), ['A']); assert.strictEqual(n(html), 1);
  assert(/<ul class="cpl cvl"/.test(html), 'daftar peserta di bawah kartu');
  for (const p of ['ME', 'A', 'B', 'C']) assert(new RegExp('<li class="[^"]*" data-peer="' + p + '"').test(html), 'baris ' + p);
  assert(html.indexOf('class="cvg') < html.indexOf('class="cpl cvl"') && html.indexOf('class="cpl cvl"') < html.indexOf('class="cbtns"'), 'urutan: kartu, daftar, tombol');
  assert.strictEqual((html.match(/id="calltime"/g) || []).length, 1);
  assert(/class="cnm">Ngobrol</.test(html));
}
ok('satu kamera: satu kartu di atas, daftar peserta lengkap di bawah, tombol paling bawah');

// 3. aku + dua lawan: 3 kartu, aku terakhir; kameraku mati tidak punya kartu
{
  const legs = [leg('A', { cam: true }), leg('B', { cam: true }), leg('C')];
  let html = LC.overlayHtml(view(legs, { video: true, camOff: false }), H);
  assert.deepStrictEqual(keys(html), ['A', 'B', 'me']); assert.strictEqual(n(html), 3);
  assert(/class="cvt me" data-vkey="me"/.test(html));
  html = LC.overlayHtml(view(legs, { video: true, camOff: true }), H); // pernah menyala, sekarang mati
  assert.deepStrictEqual(keys(html), ['A', 'B']); assert.strictEqual(n(html), 2);
  html = LC.overlayHtml(view([leg('C')], { video: true, camOff: false }), H); // hanya aku
  assert.deepStrictEqual(keys(html), ['me']); assert.strictEqual(n(html), 1);
  html = LC.overlayHtml(view([leg('A', { cam: true }), leg('B', { cam: true }), leg('C', { cam: true })], { video: true, camOff: false }), H);
  assert.strictEqual(n(html), 4);
}
ok('kartu = yang kameranya hidup (aku terakhir); maksimal 4');

// 4. hanya kaki aktif dengan cam === true
{
  const v = view([leg('A', { cam: true, state: 'connecting' }), leg('B', { cam: 'ya' }), leg('C', { cam: true, state: 'active' })]);
  assert.deepStrictEqual(keys(LC.overlayHtml(v, H)), ['C']);
}
ok('kaki yang belum aktif atau cam bukan true tidak dapat kartu');

// 5. perbesar
{
  const v = view([leg('A', { cam: true }), leg('B', { cam: true })]);
  let html = LC.overlayHtml(v, Object.assign({ focus: 'B' }, H));
  assert(/class="cvg chv focus"/.test(html) && /class="cvt big" data-vkey="B"/.test(html) && /data-cact="unfocus"/.test(html));
  assert(/data-cact="focus" data-vfocus="A"/.test(html), 'kartu lain tetap ada (disembunyikan CSS)');
  html = LC.overlayHtml(v, Object.assign({ focus: 'Z' }, H));
  assert(!/ focus"/.test(html.match(/class="cvg[^"]*"/)[0]) && !/ big"/.test(html), 'kunci yang tak ada diabaikan');
}
ok('perbesar kartu di channel; kunci tak dikenal diabaikan');

// 6. nama di-escape, ruang undangan/dering tidak punya kartu
{
  const v = view([leg('A', { cam: true, name: '<b>x</b>' })]);
  const html = LC.overlayHtml(v, H);
  assert(!/<b>x<\/b>/.test(html) && /&lt;b&gt;x&lt;\/b&gt;/.test(html));
  assert.strictEqual(LC.videoView(view([leg('A', { cam: true })], { phase: 'ringing' })), false);
  assert.strictEqual(LC.videoView(view([leg('A', { cam: true })], { invite: true })), false);
}
ok('nama di-escape; dering dan undangan tidak punya kartu');

// 7. label tombol kamera: hitungan, penuh, hidup
{
  const lab = (o) => (LC.overlayHtml(view([leg('A', { cam: true })], o), H).match(/data-cact="cam"[^>]*aria-label="([^"]*)"/) || [])[1];
  assert.strictEqual(lab({ camOff: true }), 'Kamera');
  assert.strictEqual(lab({ camOff: true, camCount: 2, camMax: 4 }), 'Kamera 2/4');
  assert.strictEqual(lab({ camOff: true, camCount: 4, camMax: 4 }), 'Kamera penuh');
  assert.strictEqual(lab({ camOff: false, video: true, camCount: 4, camMax: 4 }), 'Kamera hidup');
}
ok('tombol kamera: hitungan, penuh, hidup');

// 8. panggilan 1-1 dan grup tidak berubah
{
  assert.strictEqual(LC.videoView({ phase: 'active', video: true, legs: [leg('A')] }), true);
  assert.strictEqual(LC.videoView({ phase: 'active', video: false, legs: [leg('A', { video: true })] }), true);
  assert.strictEqual(LC.videoView({ phase: 'active', video: false, legs: [leg('A')] }), false);
  const html = LC.overlayHtml({ phase: 'active', video: true, peer: 'A', name: 'A', legs: [leg('A', { video: true })], invites: [], members: [], since: 1, camOff: false }, H);
  assert(/class="cvg" data-n="2"/.test(html) && !/chv/.test(html));
}
ok('1-1 dan grup tidak berubah');

// 9. CSS dan archne-index.html
{
  const css = require('./_src').htmlSrc();
  assert(/#callov \.cvg\[data-n="1"\]\{--c:1;--r:1;max-width:720px\}/.test(css), 'satu kartu');
  assert(/#callov \.cvl\{max-height:22vh/.test(css), 'daftar peserta dibatasi dan digulir');
  assert(/LC\.videoView\(v\)/.test(css) && /mountVideos\(v\)/.test(css), 'archne-index.html memasang video lewat videoView/mountVideos');
}
ok('CSS dan jembatan archne-index.html');

console.log('\nchanvideoui: ' + pass + ' OK');

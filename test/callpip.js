'use strict';
// Tes kartu Picture-in-Picture (v0.31.x): satu kartu saja. 1-1 = lawan bicara (kameranya mati = kameraku); grup / channel = yang sedang bicara.
//   1. LC.pickPip: aturan pemilihan, hysteresis (tidak melompat), kandidat berubah
//   2. LC.levelMeter: sinkron stream, level halus, pelepasan, tanpa WebAudio = null
//   3. UI (archne-call-ui.js) dan CSS saling cocok
const fs = require('fs'), path = require('path'), assert = require('assert');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const A = 'a'.repeat(16), B = 'b'.repeat(16), C = 'c'.repeat(16);
const D = LC.PIP_DWELL_MS;

{ // 1. pickPip
  assert.strictEqual(LC.pickPip([], {}, null, 0).key, null, 'tanpa kandidat: tidak ada kartu');
  assert.strictEqual(LC.pickPip(['me', A], {}, null, 0).key, A, '1-1 dengan kamera lawan: lawan bicara, bukan aku');
  assert.strictEqual(LC.pickPip(['me', A], { me: 0.9, [A]: 0 }, null, 0).key, A, 'aku yang bicara pun, 1-1 tetap lawan bicara');
  assert.strictEqual(LC.pickPip(['me'], {}, null, 0).key, 'me', '1-1 lawan tanpa kamera: kameraku');
  assert.strictEqual(LC.pickPip([A], {}, null, 0).key, A, 'hanya lawan berkamera');
  ok('1-1: lawan bicara; kameranya mati -> kameraku; suaraku tidak menggeser');

  // grup: yang paling keras
  let st = LC.pickPip([A, B, 'me'], { [A]: 0.01, [B]: 0.2, me: 0.5 }, null, 1000);
  assert.strictEqual(st.key, B, 'awal: yang paling keras di antara orang lain (aku tidak ikut)');
  st = LC.pickPip([A, B, 'me'], { [A]: 0.3, [B]: 0.2 }, st, 1000 + D - 1);
  assert.strictEqual(st.key, B, 'belum cukup lama: tetap');
  st = LC.pickPip([A, B, 'me'], { [A]: 0.3, [B]: 0.2 }, st, 1000 + D);
  assert.strictEqual(st.key, B, 'A hanya 1,5x? 0.3 < 0.2*1.5=0.3 tidak lebih besar: tetap');
  st = LC.pickPip([A, B, 'me'], { [A]: 0.31, [B]: 0.2 }, st, 1000 + D);
  assert.strictEqual(st.key, A, 'A jelas lebih keras dan sudah cukup lama: pindah');
  assert.strictEqual(st.at, 1000 + D);
  const at = st.at;
  st = LC.pickPip([A, B, 'me'], { [A]: 0, [B]: 0.4 }, st, at + 10);
  assert.strictEqual(st.key, A, 'baru pindah: ditahan walau B lebih keras');
  assert.strictEqual(LC.pickPip([A, B], { [A]: 0.01, [B]: 0.015 }, { key: A, at: 0 }, 99999).key, A, 'di bawah ambang bicara: tidak pindah');
  assert.strictEqual(LC.pickPip([A, B], { [A]: 0, [B]: 0 }, null, 0).key, A, 'hening dari awal: yang pertama');
  ok('grup: yang paling keras, aku tidak ikut dipilih, tahan ' + D + ' ms dan perlu 1,5x agar tidak melompat');

  // kandidat berubah
  st = LC.pickPip([B, C], { [B]: 0.3 }, { key: A, at: 0 }, 50);
  assert.strictEqual(st.key, B, 'kartu lama hilang (kamera mati): pindah segera ke yang paling keras, tanpa menunggu');
  st = LC.pickPip(['me', A], {}, { key: A, at: 5 }, 9);
  assert.strictEqual(LC.pickPip(['me'], {}, st, 20).key, 'me', 'lawan mematikan kamera: kameraku');
  assert.strictEqual(LC.pickPip(['me', B], {}, { key: 'me', at: 0 }, 5).key, B, 'lawan menyalakan kamera: kembali ke lawan');
  assert.strictEqual(LC.pickPip(null, null, null, 0).key, null);
  assert.deepStrictEqual(LC.pickPip([A], null, { key: A, at: 7 }, 99), { key: A, at: 7 }, 'satu kandidat: waktu kartu dipertahankan');
  ok('kandidat berubah: kartu hilang -> pindah; lawan mati/hidupkan kamera -> kameraku/lawan; masukan aneh aman');
}

{ // 2. levelMeter
  assert.strictEqual(LC.levelMeter(null), null, 'tanpa WebAudio = null');
  const made = [], closed = [];
  class AN { constructor() { this.fftSize = 0; this.amp = 128; } getByteTimeDomainData(b) { b.fill(this.amp); } }
  class Ctx {
    constructor() { this.state = 'suspended'; this.resumed = 0; }
    resume() { this.resumed++; this.state = 'running'; }
    createAnalyser() { const a = new AN(); made.push(a); return a; }
    createMediaStreamSource(s) { const src = { s, to: null, off: 0, connect(x) { this.to = x; }, disconnect() { this.off++; } }; made.push(src); return src; }
    close() { closed.push(1); }
  }
  const m = LC.levelMeter(Ctx);
  const sA = { id: 'A' }, sB = { id: 'B' };
  m.sync({ [A]: sA, [B]: sB });
  const srcs = made.filter((x) => x.s), ans = made.filter((x) => x instanceof AN);
  assert.strictEqual(srcs.length, 2); assert.strictEqual(ans.length, 2);
  assert.strictEqual(ans[0].fftSize, 512);
  assert(srcs.every((s) => s.to instanceof AN), 'sumber hanya ke analyser (tidak ke speaker)');
  assert.deepStrictEqual(m.levels(), { [A]: 0, [B]: 0 }, 'hening = 0');
  ans[1].amp = 228; // B bicara: (100/128)
  const l1 = m.levels();
  assert(l1[B] > 0.7 && l1[A] === 0, 'B terbaca');
  ans[1].amp = 128;
  const l2 = m.levels();
  assert(l2[B] > 0 && l2[B] < l1[B], 'turun halus, bukan langsung nol');
  m.sync({ [A]: sA }); // B hilang
  assert.strictEqual(srcs[1].off, 1, 'pengamat B dilepas'); assert.deepStrictEqual(Object.keys(m.levels()), [A]);
  const n0 = made.length; m.sync({ [A]: sA }); assert.strictEqual(made.length, n0, 'stream sama: tidak dipasang ulang');
  m.sync({ [A]: { id: 'A2' } }); assert.strictEqual(srcs[0].off, 1, 'stream berganti: dipasang ulang'); assert.strictEqual(made.length, n0 + 2);
  m.stop(); assert.strictEqual(closed.length, 1); assert.deepStrictEqual(m.levels(), {});
  const bad = LC.levelMeter(class { constructor() { throw new Error('x'); } });
  bad.sync({ [A]: sA }); assert.deepStrictEqual(bad.levels(), {}); bad.stop();
  ok('levelMeter: analyser saja (tanpa ke speaker), level turun halus, stream hilang/berganti, stop, galat WebAudio aman');
}

{ // 3. kontrak UI + CSS
  const ui = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'archne-call-ui.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'css', 'archne-app.css'), 'utf8');
  assert(/LC\.pickPip\(/.test(ui) && /LC\.levelMeter\(/.test(ui) && /pipsel/.test(ui), 'UI memakai pickPip, levelMeter, kelas pipsel');
  assert(/nbridge\.onPip = \(\) => pipCheck\(\)/.test(ui) && /on \? pipStart\(\) : pipStop\(\)/.test(ui), 'onPip memulai / menghentikan pemilih lewat pipCheck');
  assert(/addEventListener\('resize', pipCheck\)/.test(ui) && /nbridge\.pipWant && pipSmall\(\)/.test(ui), 'cadangan: jendela sangat kecil saat siaga dianggap PiP');
  assert(/mountVideos\(v\);\s*pipApply\(\);/.test(ui), 'kartu terpilih ditandai ulang setiap render');
  assert(/classList\.contains\('hasv'\)/.test(ui), 'kandidat = kartu yang punya video');
  assert(/body\.archne-pip #callov>\*:not\(\.cvg\)\{display:none!important\}/.test(css), 'CSS: semua selain kartu disembunyikan');
  assert(/body\.archne-pip #callov \.cvg \.cvt\{display:none!important/.test(css) && /\.cvt\.pipsel\{display:flex!important\}/.test(css), 'CSS: hanya .pipsel tampil, walau sedang diperbesar');
  const ctl = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archne-call.js'), 'utf8');
  assert(/localAudio\(\)/.test(ctl) && /remoteAudio\(peer\)/.test(ctl));
  ok('UI dan CSS: pemilih dipasang saat PiP, satu kartu tampil, kontrol dan kartu lain disembunyikan');
}
console.log('\n' + pass + ' tes kartu PiP OK');

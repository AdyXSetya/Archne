'use strict';
// Tes anti-spam isi + lipat pesan panjang (v0.9.2).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), vm = require('vm');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-spam-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (name) => { pass++; console.log('  OK  ' + name); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const has = (c, text) => c.getState().messages.some((m) => !m.sys && m.text === text);
const spam = (fn) => assert.throws(fn, (e) => e.code === 'SPAM' && /spam/.test(e.message));
const LONG = 'Halo semuanya, hari ini kita rapat jam tiga sore di ruang biasa, tolong bawa laptop dan laporan mingguan masing-masing ya.';

(async () => {
  console.log('Archne spam test, dir: ' + tmp);
  const A = mk('A'), B = mk('B');
  for (const n of [A, B]) await n.start();
  await A.addPeer('127.0.0.1', B.port);
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 8000, 'online');

  // ---------- teks sama dan trik-trik kecil ----------
  const first = A.sendText(LONG, 'public');
  await until(() => has(B, LONG), 8000, 'tiba');
  spam(() => A.sendText(LONG, 'public'));
  spam(() => A.sendText(LONG + '.', 'public'));
  spam(() => A.sendText(LONG + ' ......', 'public'));
  spam(() => A.sendText('  ' + LONG.toUpperCase() + '  ', 'public'));
  spam(() => A.sendText(LONG.replace('rapat', 'rapaat'), 'public'));
  spam(() => A.sendText(LONG.replace(/, /g, ' '), 'public'));
  spam(() => A.sendText(LONG.slice(0, -6), 'public'));                                // dikurangi dikit
  spam(() => A.sendText(LONG.replace('tiga', 'empat').replace('biasa', 'baru'), 'public')); // ganti beberapa kata
  spam(() => A.sendText(LONG + ' 😀', 'public'));
  spam(() => A.sendText(LONG.replace('Halo', 'Haloooooo'), 'public'));                // huruf dipanjangkan
  assert(!has(B, LONG + '.') && A.getState().messages.filter((m) => m.text === LONG).length === 1, 'tidak ada yang lolos/tersimpan');
  ok('teks sama dan variasi kecil (titik, spasi, huruf besar, typo, dikurangi, emoji, huruf dipanjangkan) ditolak');

  // ---------- yang sah tetap lolos ----------
  A.sendText('Besok kita makan siang bersama di kantin lantai dua ya, jangan lupa bawa uang pas.', 'public');
  A.sendText('Ada yang punya charger laptop tipe C yang bisa dipinjam sebentar saja siang ini?', 'public');
  ok('pesan berbeda isinya tetap terkirim');

  // ---------- pendek: sekali-sekali boleh ----------
  A.sendText('ok', 'public');
  spam(() => A.sendText('ok', 'public'));
  spam(() => A.sendText('OK!', 'public'));
  A.sendText('ya', 'public');
  A.sendText('😂', 'public');
  A.sendText('❤️', 'public'); // emoji berbeda tidak dianggap sama
  spam(() => A.sendText('😂', 'public'));
  ok('teks pendek: sama persis dalam 30 detik ditolak, yang berbeda (termasuk emoji lain) boleh');

  // ---------- per chat dan per pengirim ----------
  assert(B.sendText(LONG, 'public'), 'orang lain boleh mengirim teks yang sama');
  A.sendText(LONG, B.id); // chat lain (DM): tidak dihitung
  await until(() => has(B, LONG), 8000, 'dm tiba');
  spam(() => A.sendText(LONG, B.id)); // tapi di DM yang sama tetap ditolak
  ok('hanya pesan sendiri di chat yang sama yang dibandingkan');

  // ---------- balasan ikut diperiksa; awalan balasan tidak dihitung ----------
  const t = B.sendText('Pesan dari B untuk dibalas oleh A di sini ya', 'public');
  await until(() => has(A, 'Pesan dari B untuk dibalas oleh A di sini ya'), 8000, 'b tiba');
  spam(() => A.sendText(LONG, 'public', t.id));
  ok('mengirim ulang sebagai balasan tidak menghindari pemeriksaan');

  // ---------- batalkan pesan: boleh kirim ulang (perbaiki salah ketik) ----------
  A.deleteMessage(first.id);
  assert(A.sendText(LONG, 'public'), 'setelah dibatalkan, bisa dikirim lagi');
  spam(() => A.sendText(LONG, 'public'));
  ok('pesan yang dibatalkan tidak dihitung; versi baru yang sama lagi ditolak');

  // ---------- pesan kontrol (pertemanan) bukan pesan pengguna ----------
  A.addFriend(B.id);
  await until(() => A.fstate(B.id) !== '', 8000, 'permintaan teman');
  assert(A.sendText('frq', B.id) !== undefined, 'mengetik "frq" setelah mengirim permintaan teman tidak dianggap spam');
  ok('pesan kontrol (permintaan teman, batal kirim) tidak ikut dibandingkan');

  // ---------- bertahan setelah restart ----------
  await A.stop();
  const A2 = new Core({ dataDir: path.join(tmp, 'A'), name: 'A', discovery: false });
  await A2.start();
  spam(() => A2.sendText(LONG, 'public'));
  ok('pemeriksaan tetap jalan setelah aplikasi dibuka ulang (dari riwayat tersimpan)');

  // ---------- pesan panjang 10k: tidak lambat ----------
  const big = Array.from({ length: 1400 }, (_, i) => 'kata' + (i % 97)).join(' ');
  const t0 = Date.now();
  A2.sendText(big, 'public');
  spam(() => A2.sendText(big + ' x', 'public'));
  assert(Date.now() - t0 < 1500, 'pemeriksaan cepat: ' + (Date.now() - t0) + ' ms');
  ok('pesan sangat panjang diperiksa cepat');

  await A2.stop(); await B.stop();

  // ---------- lipat pesan panjang (fungsi asli dari archne-index.html) ----------
  const html = require('./_src').htmlSrc();
  const src = html.match(/const FOLD_CHARS[^\n]*\n/)[0] + html.match(/function fold\(text\) \{[\s\S]*?\n\}\n/)[0];
  const ctx = {}; vm.createContext(ctx); vm.runInContext(src + '\nthis.fold = fold;', ctx);
  const fold = ctx.fold;
  assert.strictEqual(fold('pendek'), null);
  assert.strictEqual(fold('a'.repeat(1000)), null, 'tepat 1000: tidak dilipat');
  assert.strictEqual(fold('a'.repeat(1001)).length, 1000, '1001: dilipat di 1000');
  assert.strictEqual(fold(Array(12).fill('x').join('\n')), null, '12 baris pas: tidak dilipat');
  assert.strictEqual(fold(Array(13).fill('x').join('\n')), Array(12).fill('x').join('\n'), '13 baris: dilipat di baris ke-12');
  const emo = 'a'.repeat(999) + '😀' + 'b'.repeat(50);
  const fe = fold(emo);
  assert(fe.length === 999 && !/[\ud800-\udbff]$/.test(fe), 'emoji tidak terpotong separuh');
  assert.strictEqual(fold('x\n'.repeat(500)).split('\n').length, 12, 'banyak baris pendek juga dilipat');
  ok('lipat: batas 1000 karakter / 12 baris, emoji tidak terpecah');

  console.log(`\nSEMUA TES ANTI-SPAM DAN LIPAT PESAN LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

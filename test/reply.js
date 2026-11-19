'use strict';
// Tes balas pesan (v0.9.1): referensi ke pesan asli ikut di teks bertanda tangan (terenkripsi untuk DM/grup), pratinjau dihitung
// di perangkat penerima, tidak bisa dipalsukan lewat ketikan, tidak membocorkan chat lain, dan ikut hilang bila pesan asli dibatalkan.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core, MAX_TEXT, verifyMsg } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-rep-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (name) => { pass++; console.log('  OK  ' + name); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const find = (c, text) => c.getState().messages.find((m) => !m.sys && m.text === text);
const has = (c, text) => !!find(c, text);
const lan = (c, ...others) => Promise.all(others.map((o) => c.addPeer('127.0.0.1', o.port)));

(async () => {
  console.log('Archne reply test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C');
  const all = [A, B, C];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 2), 8000, 'mesh');

  // ---------- publik ----------
  const p1 = A.sendText('apa kabar semua?', 'public');
  await until(() => has(B, 'apa kabar semua?'), 8000, 'publik tiba');
  const r1 = B.sendText('baik-baik saja', 'public', p1.id);
  await until(() => has(A, 'baik-baik saja') && has(C, 'baik-baik saja'), 8000, 'balasan publik tiba');
  for (const n of [A, B, C]) {
    const m = find(n, 'baik-baik saja');
    assert(m.reply && m.reply.id === p1.id && !m.reply.gone && m.reply.text === 'apa kabar semua?' && m.reply.from === A.id, 'pratinjau di ' + n.name);
    assert(!m.text.includes('\u0003') && !m.text.includes('re:'), 'teks tampil tanpa awalan teknis');
  }
  assert(find(A, 'apa kabar semua?').reply === undefined, 'pesan biasa tidak punya reply');
  ok('balasan publik: penerima melihat pratinjau pesan asli, teks bersih dari awalan');

  // ---------- DM terenkripsi ----------
  const d1 = A.sendText('rahasia dua orang', B.id);
  await until(() => has(B, 'rahasia dua orang'), 8000, 'dm tiba');
  const d2 = B.sendText('oke, kupegang', A.id, d1.id);
  await until(() => has(A, 'oke, kupegang'), 8000, 'balasan dm');
  assert(find(A, 'oke, kupegang').reply.text === 'rahasia dua orang' && find(A, 'oke, kupegang').enc === true);
  const raw = Object.values(C.store.msgs).filter((m) => m.id === d2.id);
  assert(raw.length === 0 || !raw[0].text.includes(d1.id), 'referensi tidak terbaca pihak ketiga (terenkripsi)');
  assert(!JSON.stringify(A.store.msgs[d2.id].text).includes(d1.id), 'id yang dibalas tidak terlihat di teks terenkripsi');
  ok('balasan DM: terenkripsi, referensi tidak bocor di kabel');

  // ---------- grup ----------
  const gid = A.createGroup('Tim', [B.id, C.id]).id, G = 'g:' + gid;
  await until(() => [B, C].every((n) => n.getState().groups.some((g) => g.id === gid)), 8000, 'grup');
  const g1 = C.sendText('rapat jam 3', G);
  await until(() => has(A, 'rapat jam 3') && has(B, 'rapat jam 3'), 8000, 'grup tiba');
  B.sendText('siap', G, g1.id);
  await until(() => has(A, 'siap') && has(C, 'siap'), 8000, 'balasan grup');
  assert.strictEqual(find(A, 'siap').reply.text, 'rapat jam 3');
  assert.strictEqual(find(C, 'siap').reply.from, C.id);
  ok('balasan grup tampil di semua anggota');

  // ---------- validasi pengirim ----------
  assert.throws(() => A.sendText('x', 'public', 'f'.repeat(32)), /tidak ditemukan/, 'id tidak ada');
  assert.throws(() => A.sendText('x', 'public', 'bukan-id'), /tidak ditemukan/, 'format salah');
  assert.throws(() => A.sendText('x', 'public', d1.id), /bukan dari chat ini/, 'pesan DM tidak bisa dibalas dari publik');
  assert.throws(() => A.sendText('x', B.id, p1.id), /bukan dari chat ini/, 'pesan publik tidak bisa dibalas dari DM');
  assert.throws(() => A.sendText('x', G, p1.id), /bukan dari chat ini/, 'pesan publik tidak bisa dibalas dari grup');
  assert.strictEqual(A.sendText('   ', 'public', p1.id), null, 'teks kosong tidak terkirim');
  ok('balasan ke pesan yang tidak ada / dari chat lain ditolak di pengirim');

  // ---------- tidak bisa dipalsukan lewat ketikan ----------
  const f = A.sendText('\u0003re:' + p1.id + '\u0003palsu', 'public');
  await until(() => B.getState().messages.some((m) => m.id === f.id), 8000, 'palsu tiba');
  const fm = B.getState().messages.find((m) => m.id === f.id);
  assert(!fm.reply && fm.text.includes('re:' + p1.id) && !fm.text.includes('\u0003'), 'karakter pemisah disaring: tampil sebagai teks biasa, bukan balasan');
  ok('awalan balasan tidak bisa diketik pengguna');

  // ---------- pengirim nakal: referensi ke chat lain tidak membocorkan isi ----------
  const sneaky = A._send('\u0003re:' + d1.id + '\u0003intip', 'public'); // lewat jalur internal, melewati pemeriksaan sendText
  await until(() => has(C, 'intip'), 8000, 'sneaky tiba');
  const sm = find(C, 'intip');
  assert(sm.reply && sm.reply.gone === true && !JSON.stringify(sm.reply).includes('rahasia'), 'C bahkan tidak punya DM itu; B (punya) pun tidak menampilkannya di chat publik');
  await until(() => has(B, 'intip'), 8000, 'sneaky di B');
  assert(find(B, 'intip').reply.gone === true && !JSON.stringify(find(B, 'intip').reply).includes('rahasia'), 'B punya DM-nya tapi chat berbeda: tetap tidak bocor');
  ok('referensi ke pesan di chat lain dianggap hilang, isinya tidak dibocorkan');

  // ---------- batas panjang: balasan teks penuh di publik tetap lolos verifikasi ----------
  const longT = 'x'.repeat(MAX_TEXT);
  const lg = B.sendText(longT, 'public', p1.id);
  assert(verifyMsg(lg), 'pesan bertanda tangan valid walau ada awalan');
  await until(() => has(C, longT), 8000, 'panjang tiba');
  assert.strictEqual(find(C, longT).reply.id, p1.id);
  assert.throws(() => B.sendText('y'.repeat(MAX_TEXT + 1), 'public', p1.id), /terlalu panjang/);
  ok('balasan 10.000 karakter di publik tetap diterima; batas pengguna tetap 10.000');

  // ---------- pesan asli dibatalkan ----------
  A.deleteMessage(p1.id);
  await until(() => !has(B, 'apa kabar semua?') && !has(C, 'apa kabar semua?') && !has(A, 'apa kabar semua?'), 8000, 'asli hilang');
  for (const n of [A, B, C]) {
    const m = find(n, 'baik-baik saja');
    assert(m && m.reply && m.reply.gone === true, 'pratinjau berubah jadi "tidak ada" di ' + n.name);
  }
  assert.throws(() => B.sendText('terlambat', 'public', p1.id), /tidak ditemukan/, 'tidak bisa membalas pesan yang sudah dibatalkan');
  ok('pesan asli dibatalkan: balasan tetap ada, pratinjau jadi "sudah tidak ada"');

  // ---------- pratinjau panjang dipotong, balasan berantai, berkas ----------
  const big = A.sendText('k'.repeat(400), 'public');
  await until(() => has(B, 'k'.repeat(400)), 8000, 'besar');
  const c1 = B.sendText('balas besar', 'public', big.id);
  await until(() => has(A, 'balas besar'), 8000, 'balas besar tiba');
  const pv = find(A, 'balas besar').reply.text;
  assert(pv.length <= 121 && pv.endsWith('…'), 'pratinjau dipotong');
  const c2 = A.sendText('balas balasan', 'public', c1.id);
  await until(() => has(B, 'balas balasan'), 8000, 'berantai');
  assert.strictEqual(find(B, 'balas balasan').reply.text, 'balas besar', 'pratinjau balasan berantai tidak membawa awalan teknis atau kutipan lama');
  ok('pratinjau dipotong 120 karakter; balasan berantai bersih');

  // ---------- bertahan setelah restart ----------
  await B.stop();
  const B2 = new Core({ dataDir: path.join(tmp, 'B'), name: 'B', discovery: false });
  await B2.start();
  assert(find(B2, 'balas balasan').reply.text === 'balas besar', 'tersimpan di disk');
  await B2.stop();

  for (const n of [A, C]) await n.stop();
  console.log(`\nSEMUA TES BALAS PESAN LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

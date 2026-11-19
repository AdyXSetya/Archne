'use strict';
// Tes reaksi di tab Publik (setelah rilis 0.25.0): pembawa = pesan publik biasa (teks polos berawalan Rx.CTL). Diuji dengan Core sungguhan:
// tersebar ke semua peer online, pembawa tersembunyi, bisa dicabut, ikut sinkron ke yang datang belakangan, hilang bersama pesannya,
// peer versi lama menutupnya, dan pembawa ikut kuota byte pesan publik (tidak gratis).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const Rx = require('../src/archne-reactions');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-rxpub-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false }, o));
const lan = (c, ...o) => Promise.all(o.map((x) => c.addPeer('127.0.0.1', x.port)));
const sum = (c, mid) => c.reactions(mid).map((x) => x.e + x.n + (x.mine ? '*' : '')).join(' ');
const carriers = (c, from) => Object.values(c.store.msgs).filter((m) => (!from || m.from === from) && c._isRxCtl(m));

(async () => {
  console.log('Archne rx public test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C');
  for (const n of [A, B, C]) await n.start();
  await lan(A, B, C); await lan(B, C);
  await until(() => [A, B, C].every((n) => n.getState().peers.filter((p) => p.online).length === 2), 8000, 'mesh');
  const all = [A, B, C];

  // ---- 1. reaksi di Publik tersebar, pembawa tersembunyi ----
  const t1 = A.sendText('halo semua orang', 'public');
  await until(() => all.every((n) => n.store.msgs[t1.id]), 8000, 'pesan publik tiba');
  const seen = []; for (const n of all) n.on('message', (m) => seen.push(m));
  const ev = []; A.on('reaction', (e) => ev.push(e));
  assert.strictEqual(B.react(t1.id, '👍').e, '👍');
  assert.strictEqual(sum(B, t1.id), '👍1*', 'berlaku seketika di pengirim');
  assert.strictEqual(sum(A, t1.id), '', 'belum dikirim: batch ±2 dtk');
  await until(() => all.every((n) => sum(n, t1.id).startsWith('👍1')), 8000, 'reaksi publik tersebar');
  assert.deepStrictEqual(A.reactWho(t1.id, '👍'), [{ id: B.id, name: 'B' }]);
  const car = carriers(A, B.id)[0];
  assert(car && car.to === 'public' && !car.kind && car.text.startsWith('\u0001rx:'), 'pembawa = pesan publik polos');
  for (const n of all) assert(n.getState().messages.every((m) => !String(m.text).includes('\u0001') && !String(m.text).includes('rx:')), 'pembawa tidak tampil');
  assert(seen.every((m) => !Rx.isCtl(m.text)), 'pembawa tidak memicu event message (notifikasi pesan baru)');
  assert.strictEqual(ev.length, 0, 'notifikasi Publik mati secara bawaan, reaksi mengikutinya');
  const st = A.getState().messages.find((m) => m.id === t1.id);
  assert.deepStrictEqual(st.rx, [{ e: '👍', n: 1, mine: false, by: [B.id] }], 'getState memuat chip');
  ok('Publik: reaksi tersebar ke semua peer online, pembawa tersembunyi dan tidak memicu notifikasi pesan');

  // ---- 2. banyak orang, ganti, cabut ----
  A.setNotify('public', true);
  C.react(t1.id, '😂'); A.react(t1.id, '👍');
  await until(() => all.every((n) => sum(n, t1.id).includes('👍2') && sum(n, t1.id).includes('😂1')), 8000, 'dua emoji');
  assert.strictEqual(ev.length, 1, 'Publik dinyalakan: pembuat pesan diberi tahu sekali (reaksiku sendiri tidak)'); assert(ev[0].key === 'public' && /^C reacted 😂 to: halo semua/.test(ev[0].text), 'isi pemberitahuan: ' + ev[0].text);
  A.setNotify('public', null);
  B.react(t1.id, '👍'); // ketuk yang sama = cabut
  await until(() => all.every((n) => sum(n, t1.id).includes('👍1') && !sum(n, t1.id).includes('👍2')), 8000, 'dicabut');
  ok('Publik: beberapa orang, satu reaksi per orang, ketuk lagi mencabut; notifikasi reaksi mengikuti pengaturan Publik');

  // ---- 3. peer yang datang belakangan mendapat reaksi lewat sinkron riwayat ----
  const D = mk('D'); await D.start(); await lan(D, A);
  await until(() => D.store.msgs[t1.id] && sum(D, t1.id).includes('😂1') && sum(D, t1.id).includes('👍1'), 10000, 'sinkron reaksi publik ke peer baru');
  assert(D.getState().messages.every((m) => !String(m.text).includes('\u0001')), 'pembawa tersembunyi juga di peer baru');
  ok('Publik: peer yang datang belakangan menerima reaksi lewat sinkron riwayat');

  // ---- 4. pembawa ikut kuota byte pesan publik ----
  const u0 = D.pubUsage().used; assert(u0 > 0 && D._isPubOther(carriers(D, B.id)[0]), 'pembawa dihitung sebagai pesan publik orang lain');
  ok('Publik: pembawa dihitung di kuota byte pesan publik (tidak gratis)');

  // ---- 5. peer versi lama menutup reaksi Publik (ia akan melihat pembawa sebagai teks) ----
  const pb = A.peers.get(B.id), caps0 = pb.caps; pb.caps = [];
  const s = A.rxSupport('public'); assert(!s.ok && s.old.includes(B.id));
  assert.throws(() => A.react(t1.id, '🙏'), /versi lama/, 'ditolak bila ada peer online berversi lama');
  pb.caps = caps0; assert(A.rxSupport('public').ok);
  ok('Publik: peer online berversi lama menutup reaksi (pesan galat menyebut namanya)');

  // ---- 6. batal kirim: reaksi pada pesan itu ikut hilang ----
  A.deleteMessage(t1.id);
  await until(() => all.every((n) => !n.store.msgs[t1.id] && !n.store.react[t1.id]), 8000, 'reaksi hilang bersama pesan');
  ok('Publik: pesan dibatalkan -> reaksinya ikut hilang di semua peer');

  // ---- 7. orang yang kublokir: reaksinya tidak tampil ----
  const t2 = A.sendText('pesan kedua', 'public');
  await until(() => all.every((n) => n.store.msgs[t2.id]), 8000, 'pesan 2');
  A.blockUser(C.id);
  C.react(t2.id, '🙏'); B.react(t2.id, '👍');
  await until(() => sum(A, t2.id) === '👍1', 8000, 'hanya reaksi B');
  assert.strictEqual(sum(A, t2.id), '👍1', 'reaksi orang terblokir tidak tampil');
  ok('Publik: reaksi dari orang yang kublokir tidak tampil');

  for (const n of [A, B, C, D]) await n.stop();
  console.log('\n' + pass + ' kelompok tes lulus');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

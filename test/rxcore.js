'use strict';
// Tes reaksi pesan di Core (v0.24.0, rx1 langkah 3): penyimpanan, penyebaran lewat pesan kontrol tersembunyi, penerapan, pembersihan.
// Aturan murni (emoji, LWW, batas) diuji di test/archne-reactions.js; di sini yang diuji adalah penyambungannya ke Core: grup, DM, batching,
// reaksi yatim, pembatalan pesan, blokir, caps versi lama, pembatas laju, dan selamat dari restart.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const Rx = require('../src/archne-reactions');
const { Core } = require('../src/archne-core');
const { HLC_DRIFT } = require('../src/core/archne-constants');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-rxcore-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const lan = (c, ...o) => Promise.all(o.map((x) => c.addPeer('127.0.0.1', x.port)));
const grp = (c, gid) => c.getState().groups.find((g) => g.id === gid);
const sum = (c, mid) => c.reactions(mid).map((x) => x.e + x.n + (x.mine ? '*' : '')).join(' ');
const carriers = (c, from) => Object.values(c.store.msgs).filter((m) => (!from || m.from === from) && c._isRxCtl(m));
const arrived = (nodes, id) => until(() => nodes.every((n) => n.store.msgs[id]), 8000, 'pesan tiba');

(async () => {
  console.log('Archne rx core test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C');
  for (const n of [A, B, C]) await n.start();
  await lan(A, B, C); await lan(B, C);
  await until(() => [A, B, C].every((n) => n.getState().peers.filter((p) => p.online).length === 2), 8000, 'mesh');
  const gid = A.createGroup('Tim', [B.id, C.id]).id, G = 'g:' + gid;
  await until(() => [B, C].every((n) => grp(n, gid)), 8000, 'undangan');
  const all = [A, B, C];

  // ---- A. hello membawa caps; peer lain mencatatnya ----
  assert.deepStrictEqual(A.hello().caps, ['rx', 'pg', 'pgm', 'pgr', 'pgc', 'pgd', 'pgt', 'pgk']);
  assert(A.peers.get(B.id).caps.includes('rx') && C.peers.get(A.id).caps.includes('rx'), 'caps tercatat dari hello');
  ok('hello membawa caps:[rx,pg,pgm,pgr] dan peer mencatatnya');

  // ---- B. grup: reaksi berlaku seketika di pengirim, tersebar ke semua, pesan kontrol tersembunyi ----
  const t1 = A.sendText('rapat jam 9 di aula', G);
  await arrived(all, t1.id);
  const seen = []; for (const n of all) n.on('message', (m) => seen.push(m));
  const rev = [], revC = []; A.on('reaction', (e) => rev.push(e)); C.on('reaction', (e) => revC.push(e));
  const r1 = B.react(t1.id, '👍');
  assert.strictEqual(r1.e, '👍');
  assert.strictEqual(sum(B, t1.id), '👍1*', 'berlaku seketika di pengirim');
  assert.strictEqual(sum(A, t1.id), '', 'belum dikirim: batch ±2 dtk');
  await until(() => all.every((n) => sum(n, t1.id).startsWith('👍1')), 8000, 'reaksi tersebar');
  assert.strictEqual(sum(A, t1.id), '👍1'); assert.strictEqual(sum(C, t1.id), '👍1');
  assert.strictEqual(rev.length, 1, 'pembuat pesan diberi tahu sekali'); assert(rev[0].e === '👍' && /^B reacted 👍 to: rapat/.test(rev[0].text) && rev[0].key === G, 'isi pemberitahuan'); assert.strictEqual(revC.length, 0, 'yang bukan pembuat pesan tidak diberi tahu');
  assert.deepStrictEqual(A.reactions(t1.id)[0].by, [B.id]);
  assert.deepStrictEqual(A.reactWho(t1.id, '👍'), [{ id: B.id, name: 'B' }]);
  for (const n of all) {
    assert(n.getState().messages.every((m) => !String(m.text).includes('\u0001') && !String(m.text).includes('rx:')), 'pesan kontrol tidak tampil');
    assert(carriers(n, B.id).length >= 1, 'tersimpan sebagai pesan kontrol (ikut sinkron)');
  }
  const stA = A.getState().messages.find((m) => m.id === t1.id);
  assert.deepStrictEqual(stA.rx, [{ e: '👍', n: 1, mine: false, by: [B.id] }], 'getState memuat chip');
  assert.strictEqual(A.getState().messages.filter((m) => m.rx).length, 1, 'pesan tanpa reaksi tidak membawa rx');
  assert.strictEqual(seen.length, 0, 'tidak memicu notifikasi pesan');
  assert.throws(() => A.sendText('balas', G, carriers(A, B.id)[0].id), /tidak ditemukan/, 'pesan kontrol tidak bisa dibalas');
  assert.throws(() => A.react(carriers(A, B.id)[0].id, '👍'), /tidak ditemukan/, 'pesan kontrol tidak bisa diberi reaksi');
  ok('grup: reaksi berlaku seketika, tersebar ke semua anggota, pesan kontrol tersembunyi, tanpa notifikasi');

  // ---- C. satu orang satu reaksi; ganti; cabut; ketukan beruntun digabung jadi satu rekaman ----
  C.react(t1.id, '🥺'); B.react(t1.id, '🥺'); // B mengganti 👍 -> 🥺
  await until(() => all.every((n) => sum(n, t1.id).startsWith('🥺2')), 8000, 'ganti');
  assert.strictEqual(sum(A, t1.id), '🥺2', 'B mengganti, bukan menambah: tidak ada 👍 tersisa');
  assert.deepStrictEqual(A.reactWho(t1.id, '🥺').map((x) => x.name).sort(), ['B', 'C']);
  const nB = carriers(A, B.id).length;
  B.react(t1.id, '👍'); B.react(t1.id, '😭'); B.react(t1.id, '😭'); // 👍 lalu 😭 lalu cabut: satu slot, yang terakhir menang
  await until(() => A.reactions(t1.id).length === 1 && A.reactions(t1.id)[0].n === 1 && A.reactions(t1.id)[0].e === '🥺', 8000, 'tercabut');
  assert.strictEqual(carriers(A, B.id).length, nB + 1, 'tiga ketukan = satu pesan kontrol');
  assert.strictEqual(sum(B, t1.id), '🥺1', 'B tidak punya reaksi lagi, chip tinggal milik C');
  assert.deepStrictEqual(Rx.parseCtl(A._open(carriers(A, B.id).sort((a, b) => b.ts - a.ts)[0])).map((r) => r.e), [''], 'yang dikirim: pencabutan');
  ok('satu orang satu reaksi: ganti, cabut, dan ketukan beruntun pada satu pesan digabung menjadi satu rekaman');

  // ---- D. beberapa pesan sekaligus = satu pesan kontrol ----
  const t2 = A.sendText('bawa laptop masing-masing', G), t3 = A.sendText('konsumsi ditanggung kantor', G);
  await arrived(all, t3.id); await arrived(all, t2.id);
  const nB2 = carriers(A, B.id).length;
  B.react(t1.id, '🤣'); B.react(t2.id, '😭'); B.react(t3.id, '🩷');
  await until(() => [t1, t2, t3].every((t) => A.reactions(t.id).some((x) => x.by.includes(B.id))), 8000, 'tiga reaksi');
  assert.strictEqual(carriers(A, B.id).length, nB2 + 1, 'tiga pesan berbeda dalam satu batch = satu pesan kontrol');
  assert.strictEqual(Rx.parseCtl(A._open(carriers(A, B.id).sort((a, b) => b.ts - a.ts)[0])).length, 3);
  ok('batching: reaksi ke tiga pesan berbeda dikirim sebagai satu pesan kontrol');

  // ---- E. DM ----
  const d1 = A.sendText('halo B', B.id);
  await until(() => B.store.msgs[d1.id], 8000, 'DM tiba');
  B.react(d1.id, '\u2764'); // ❤ tanpa VS16: dikanonkan
  await until(() => A.reactions(d1.id).length === 1, 8000, 'reaksi DM');
  assert.strictEqual(A.reactions(d1.id)[0].e, '\u2764\uFE0F', 'bentuk kanonis di penerima');
  A.react(d1.id, '\u2764\uFE0F');
  await until(() => B.reactions(d1.id)[0] && B.reactions(d1.id)[0].n === 2, 8000, 'dua orang, satu chip');
  assert.strictEqual(C.reactions(d1.id).length, 0, 'DM tidak bocor ke C');
  assert(!Object.values(C.store.msgs).some((m) => m.kind === 'e1' && C._isRxCtl(m)), 'pembawa DM tidak dititipkan sebagai pesan C');
  ok('DM: dua arah, ❤ dan ❤️ menjadi satu chip, tidak bocor ke pihak ketiga');

  // ---- F. batas yang dijaga Core ----
  assert.throws(() => A.react(t1.id, 'abc'), /Emoji tidak valid/);
  assert.throws(() => A.react(t1.id, '👍👍'), /Emoji tidak valid/, 'tepat satu emoji');
  assert.throws(() => A.react('f'.repeat(32), '👍'), /tidak ditemukan/);
  assert.throws(() => A.react('nope', '👍'), /tidak ditemukan/);
  const ts0 = Date.now() + 1000, car = carriers(A, B.id)[0];
  const x = 'ab'.repeat(8); // bukan peserta
  assert.strictEqual(A._rxApplyOne(x, { m: t1.id, e: '😭', ts: ts0 }, G, ts0 + HLC_DRIFT), 'reject', 'bukan anggota grup');
  assert.strictEqual(A._rxApplyOne(B.id, { m: t1.id, e: '😭', ts: ts0 }, B.id, ts0 + HLC_DRIFT), 'reject', 'sasaran di chat lain');
  assert.strictEqual(A._rxApplyOne(B.id, { m: car.id, e: '😭', ts: ts0 }, G, ts0 + HLC_DRIFT), 'reject', 'sasaran pesan kontrol');
  assert.strictEqual(A._rxApplyOne(B.id, { m: t1.id, e: '😭', ts: ts0 + 10 * HLC_DRIFT }, G, ts0 + HLC_DRIFT), 'reject', 'ts jauh di masa depan');
  assert.strictEqual(A._rxApplyOne(B.id, { m: t1.id, e: '😭', ts: 1 }, G, ts0 + HLC_DRIFT), 'stale', 'rekaman lama kalah');
  assert.strictEqual(A._rxApplyOne(B.id, { m: t1.id, e: 'bukan emoji', ts: ts0 }, G, ts0 + HLC_DRIFT), 'reject');
  assert.strictEqual(A._rxApplyOne(B.id, null, G, ts0), 'reject');
  assert.strictEqual(sum(A, t1.id), '🥺1 🤣1', 'tidak ada yang bocor ke keadaan');
  ok('batas Core: bukan peserta / chat lain / pesan kontrol / ts masa depan / emoji palsu ditolak, rekaman lama kalah');

  // ---- F2. jalur terima sungguhan: rekaman ber-ts masa depan ditolak, tetapi tidak meracuni rekaman sah di pesan kontrol yang sama ----
  const nA4 = carriers(A, B.id).length, nC4 = carriers(C, B.id).length, future = Date.now() + 10 * HLC_DRIFT; // A punya satu pembawa DM B tambahan yang tidak sampai ke C: hitung per node
  B._send(Rx.encodeCtl([{ m: t1.id, e: '😭', ts: future }, { m: t2.id, e: '\u{1FA77}', ts: B._tsNow() }]), G); // dari pengirim yang curang: dilewatkan _send, bukan react()
  await until(() => carriers(A, B.id).length === nA4 + 1 && carriers(C, B.id).length === nC4 + 1, 8000, 'pembawa tiba');
  for (const n of [A, C]) {
    assert.strictEqual(n.store.react[t1.id][B.id].e, '🤣', 'ts masa depan tidak menang');
    assert(n.store.react[t1.id][B.id].ts < future);
    assert.deepStrictEqual(n.reactWho(t2.id, '🩷').map((x) => x.id), [B.id], 'rekaman sah di pesan kontrol yang sama tetap diterapkan');
  }
  ok('jalur terima: ts masa depan ditolak (tidak menang selamanya), rekaman sah dalam pesan kontrol yang sama tetap diterapkan');

  // ---- G. caps: peer versi lama diblokir dari reaksi, peer yang belum dikenal tidak ----
  assert.deepStrictEqual(A.rxSupport(G), { ok: true, old: [] });
  const pB = A.peers.get(B.id), keep = pB.caps;
  pB.caps = []; // hello B tidak memuat 'rx' = versi lama
  assert.deepStrictEqual(A.rxSupport(G), { ok: false, old: [B.id] }); assert.deepStrictEqual(A.rxSupport(B.id), { ok: false, old: [B.id] });
  assert.throws(() => A.react(t2.id, '👍'), /versi lama/, 'grup dengan anggota versi lama');
  assert.throws(() => A.react(d1.id, '👍'), /versi lama/, 'DM dengan peer versi lama');
  delete pB.caps; // belum pernah mengabari: dianggap bisa
  assert.strictEqual(A.rxSupport(G).ok, true);
  pB.caps = keep;
  ok('caps: anggota yang hello-nya tanpa rx menutup reaksi; peer yang belum dikenal tidak menutupnya');

  // ---- H. pembatalan pesan: reaksinya ikut hilang di semua perangkat ----
  const t4 = A.sendText('salah kirim, abaikan', G);
  await arrived(all, t4.id);
  B.react(t4.id, '😭'); C.react(t4.id, '😭');
  await until(() => all.every((n) => sum(n, t4.id).startsWith('😭2')), 8000, 'reaksi t4');
  A.deleteMessage(t4.id);
  await until(() => all.every((n) => !n.store.msgs[t4.id] && !n.store.react[t4.id]), 8000, 'reaksi ikut terhapus');
  assert.deepStrictEqual(B.reactions(t4.id), []);
  assert.deepStrictEqual(B.reactWho(t4.id, '😭'), []);
  ok('batal kirim: pesan dan semua reaksinya hilang di semua anggota');

  // ---- I. blokir: reaksinya hilang dari tampilan, pesan kontrolnya tidak diterapkan; buka blokir memulihkan ----
  assert.strictEqual(sum(C, t1.id), '🥺1* 🤣1');
  C.blockUser(B.id);
  assert.strictEqual(sum(C, t1.id), '🥺1*', 'reaksi B hilang dari tampilan C, reaksi C sendiri tetap');
  assert(C.store.react[t1.id][B.id], 'datanya tetap');
  const t5 = A.sendText('notulen sudah dikirim', G);
  await arrived([A, B], t5.id); await until(() => C.store.msgs[t5.id], 8000, 't5 di C');
  B.react(t5.id, '🩷');
  await until(() => A.reactions(t5.id).length === 1, 8000, 'A menerima');
  await until(() => carriers(C, B.id).some((m) => Rx.parseCtl(C._open(m)).some((r) => r.m === t5.id)), 8000, 'pembawa tersimpan di C (tersembunyi)');
  assert.deepStrictEqual(C.reactions(t5.id), [], 'tidak diterapkan selama diblokir');
  assert(!C.store.react[t5.id], 'tidak ada register');
  C.unblockUser(B.id);
  assert.strictEqual(sum(C, t5.id), '🩷1', 'diterapkan dari simpanan saat blokir dibuka');
  assert.strictEqual(sum(C, t1.id), '🥺1* 🤣1');
  ok('blokir: reaksi disembunyikan, pesan kontrol disimpan tapi tidak diterapkan, dipulihkan saat blokir dibuka');

  // ---- J. reaksi yatim: sasaran belum tiba, ditahan, lalu diterapkan saat tiba; selamat dari restart ----
  const t6 = A.sendText('lokasi: ruang 3B', G);
  await arrived(all, t6.id);
  B.react(t6.id, '🤣');
  await until(() => sum(C, t6.id) === '🤣1', 8000, 'reaksi t6 di C');
  const car6 = carriers(C, B.id).find((m) => Rx.parseCtl(C._open(m)).some((r) => r.m === t6.id)), tgt6 = C.store.msgs[t6.id];
  for (const m of [car6, tgt6]) { delete C.store.msgs[m.id]; C._plain.delete(m.id); }
  delete C.store.react[t6.id];
  assert.strictEqual(C._ingest(car6), 'new');
  assert.strictEqual(C.reactions(t6.id).length, 0, 'sasaran belum ada: reaksi menunggu');
  assert.strictEqual(C._rxPend.size, 1); assert.strictEqual(C.store.reactHold.length, 1, 'salinan di store untuk restart');
  assert.strictEqual(C._ingest(car6), 'dup');
  const mid6 = t6.id;
  await C.stop();
  const C2 = mk('C'); await C2.start();
  assert.strictEqual(C2._rxPend.size, 1, 'reaksi yatim selamat dari restart');
  assert.strictEqual(C2.reactions(mid6).length, 0);
  assert.strictEqual(C2._ingest(tgt6), 'new');
  assert.strictEqual(C2._rxPend.size, 0); assert.strictEqual(C2.store.reactHold.length, 0);
  assert.strictEqual(C2.reactions(mid6)[0].e, '🤣', 'diterapkan begitu sasaran tiba');
  assert.strictEqual(C2.reactions(mid6)[0].by[0], B.id);
  ok('reaksi yatim: ditahan sampai sasarannya tiba, selamat dari restart, lalu diterapkan');

  // ---- K. reaksi selamat dari restart; dan keadaan di disk dibersihkan saat dimuat ----
  const before = sum(C2, t1.id);
  await C2.stop();
  const f = path.join(tmp, 'C', 'store.json'), j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert(j.react[t6.id][B.id], 'tersimpan di store.json');
  j.react['zz'] = { [B.id]: { e: '👍', ts: 1 } }; j.react[t1.id]['bad'] = { e: '👍', ts: 1 }; j.react[t1.id][A.id] = { e: 'abc', ts: 1 }; j.react['f'.repeat(32)] = { [B.id]: { e: '👍', ts: 1 } };
  j.reactRecent = ['👍', 'abc', '👍', '🩷']; j.reactHold = [{ from: 'x', rec: {}, at: 1 }, null, 5];
  fs.writeFileSync(f, JSON.stringify(j));
  const C3 = mk('C'); await C3.start();
  assert.strictEqual(sum(C3, t1.id), before, 'reaksi selamat dari restart');
  assert(!C3.store.react.zz && !C3.store.react['f'.repeat(32)] && !C3.store.react[t1.id].bad && !C3.store.react[t1.id][A.id], 'rekaman rusak / sasaran yang tidak ada dibuang');
  assert.deepStrictEqual(C3.reactRecent(), ['👍', '🩷']); assert.strictEqual(C3._rxPend.size, 0);
  ok('restart: reaksi bertahan; rekaman rusak, sasaran hilang, dan daftar terakhir-dipakai dibersihkan saat dimuat');

  // ---- L. pembatas laju kirim ----
  let n = 0;
  try { for (; n < 60; n++) C3.react(t1.id, n % 2 ? '😭' : '🥺'); } catch (e) { assert(/Terlalu cepat/.test(e.message), e.message); }
  assert(n >= 20 && n <= 30, 'dibatasi ' + n + ' ketukan per menit');
  assert.deepStrictEqual(C3.reactRecent().slice(0, 2).sort(), ['😭', '🥺'].sort());
  ok('pembatas laju: ' + n + ' ketukan lalu ditolak');

  // ---- M. stop() mengirim ketukan yang masih menunggu batch ----
  const nB3 = carriers(B, B.id).length;
  B.react(t2.id, '🥺');
  assert.strictEqual(carriers(B, B.id).length, nB3, 'belum dikirim');
  await B.stop();
  assert.strictEqual(carriers(B, B.id).length, nB3 + 1, 'stop() mengosongkan antrean batch');
  assert.strictEqual(B._rxT, null);
  ok('stop() mengosongkan antrean batch: ketukan terakhir tidak hilang');

  await A.stop(); await C3.stop();
  console.log('\n' + pass + ' kelompok tes lulus');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

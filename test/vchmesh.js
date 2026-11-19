'use strict';
// Tes channel voice grup (v0.19.0, langkah 4): sambungan audio (mesh) di dalam channel. UI diganti pemeran palsu yang hanya bertukar SDP rekaan.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-vchm-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false, tickMs: 100, vcBeatMs: 300, vcTtlMs: 1500, vcRetryMs: 150 }, o || {}));
const lan = (c, ...o) => Promise.all(o.map((x) => c.addPeer('127.0.0.1', x.port)));

// Pemeran UI: legneed -> callLeg, tawaran otomatis -> jawab + tersambung, jawaban -> tersambung. Mencatat event untuk diperiksa.
function actor(c, o) {
  o = o || {};
  const a = { ev: [], need: 0, ends: [], auto: 0 };
  c.on('call', (e) => {
    a.ev.push(e);
    try {
      if (e.ev === 'legneed') { a.need++; if (!o.deaf) c.callLeg(e.room, e.peer, 'OFFER-' + c.name); }
      else if (e.ev === 'incoming' && e.auto) { a.auto++; c.callAnswer(e.cid, 'ANSWER-' + c.name); c.callConnected(e.cid); }
      else if (e.ev === 'answer') c.callConnected(e.cid);
      else if (e.ev === 'end') a.ends.push(e);
    } catch (err) { a.err = err; }
  });
  return a;
}
const legsOf = (c, room) => c._legs(room).map((l) => c.peers.get(l.peer).name + ':' + l.state).sort().join();
const active = (c, room, names) => legsOf(c, room) === names.map((n) => n + ':active').sort().join();

(async () => {
  console.log('Archne vchan mesh test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D'), E = mk('E');
  const all = [A, B, C, D, E];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 4), 8000, 'mesh');
  const gid = A.createGroup('Tim', [B.id, C.id, D.id]).id; // E bukan anggota
  await until(() => [B, C, D].every((n) => n.getState().groups.some((g) => g.id === gid)), 8000, 'undangan');
  const santai = C.vcCreate(gid, 'Santai', false);
  const rapat = A.vcCreate(gid, 'Rapat', true, [B.id]);
  await until(() => [A, B, C, D].every((n) => n.vcList(gid).length === 2), 8000, 'sync channel');
  const ac = { A: actor(A), B: actor(B), C: actor(C), D: actor(D) };

  // ---- A. sendirian boleh menunggu; yang datang disambungkan; semua terhubung penuh ----
  B.vcEnter(gid, santai);
  await sleep(700);
  assert(B._vcMe, 'sendirian: tetap di channel');
  assert.strictEqual(B._legs(santai).length, 0);
  assert.strictEqual(ac.B.ends.length, 0, 'tidak ada event akhir untuk ruang yang sepi');
  assert.strictEqual(B.callInfo(), null);
  C.vcEnter(gid, santai);
  await until(() => active(B, santai, ['C']) && active(C, santai, ['B']), 6000, 'B-C');
  D.vcEnter(gid, santai);
  await until(() => active(B, santai, ['C', 'D']) && active(C, santai, ['B', 'D']) && active(D, santai, ['B', 'C']), 8000, 'mesh penuh');
  assert.strictEqual(ac.B.err || ac.C.err || ac.D.err, undefined);
  assert.strictEqual(B.callInfo().vc.cid, santai, 'callInfo menandai ruang channel');
  const nlegs = [B, C, D].reduce((n, x) => n + x._legs(santai).length, 0);
  assert.strictEqual(nlegs, 6, 'tiap pasangan satu kaki di tiap sisi, tidak dobel');
  ok('sendirian tetap di channel tanpa event akhir; yang datang disambung; tiga orang saling terhubung, tanpa kaki dobel');

  // ---- B. keluar: kaki orang itu ditutup, sisanya tetap; ruang tidak bubar walau tinggal satu ----
  const endsB = ac.B.ends.length;
  D.vcLeave();
  await until(() => active(B, santai, ['C']) && active(C, santai, ['B']) && D._legs(santai).length === 0, 6000, 'D keluar');
  assert(ac.B.ends.slice(endsB).every((e) => e.last === false && e.vc && e.vc.cid === santai), 'kaki D selesai tanpa last, ditandai vc');
  C.vcLeave();
  await until(() => B._legs(santai).length === 0, 6000, 'C keluar');
  assert(B._vcMe, 'B masih di channel sendirian');
  assert(ac.B.ends.every((e) => e.last === false), 'tidak pernah ada last=true untuk ruang channel');
  assert.strictEqual(A.store.calls.length + B.store.calls.length + C.store.calls.length + D.store.calls.length, 0, 'channel tidak masuk riwayat panggilan');
  // yang masuk lagi disambung lagi, walau B sudah sendirian
  C.vcEnter(gid, santai);
  await until(() => active(B, santai, ['C']) && active(C, santai, ['B']), 6000, 'C masuk lagi');
  ok('keluar menutup kaki orang itu saja; B tetap menunggu sendirian; masuk lagi tersambung lagi; tidak masuk riwayat');

  // ---- C. pindah channel: kaki lama ditutup, lalu bergabung ke yang baru ----
  A.vcEnter(gid, rapat); // pemilik boleh masuk Rapat
  B.vcEnter(gid, rapat); // pindah dari Santai (B diizinkan)
  await until(() => active(A, rapat, ['B']) && active(B, rapat, ['A']) && B._legs(santai).length === 0 && C._legs(santai).length === 0, 8000, 'pindah');
  assert.strictEqual(B._vcMe.cid, rapat);
  ok('pindah channel: kaki lama ditutup, tersambung ke penghuni channel baru');

  // ---- D. tempaan di sisi penerima: tawaran sah-tanda-tangan dari yang tidak berhak ditolak ----
  const offer = (from, to, room) => to._callIn(from._makeMsg(to.id, 'c1', JSON.stringify({ t: 'offer', cid: 'ab'.repeat(8), room, sdp: 'FORGED' })));
  const inc0 = ac.B.ev.filter((e) => e.ev === 'incoming').length;
  const r1 = await offer(D, B, rapat); // D bukan anggota daftar izin Rapat
  assert.strictEqual(r1.ok, true);
  await sleep(200);
  assert.strictEqual(ac.B.ev.filter((e) => e.ev === 'incoming').length, inc0, 'D ditolak: tidak berdering, tidak ada kaki');
  assert(!B._legs(rapat).some((l) => l.peer === D.id));
  assert.strictEqual(B._calls.has('ab'.repeat(8)), false);
  const rE = await offer(E, B, rapat); // E bukan anggota grup
  assert.strictEqual(rE.ok, true); assert(!B._legs(rapat).some((l) => l.peer === E.id));
  const rC = await offer(C, B, 'cd'.repeat(8)); // ruang yang bukan milikku
  assert.strictEqual(rC.ok, true); assert(!B._legs(rapat).some((l) => l.peer === C.id));
  assert.throws(() => D.callLeg(rapat, B.id, 'X'), /izin/, 'D juga tidak bisa membuat kaki ke sana dari sisinya');
  ok('penerima menolak tawaran dari yang tidak berhak masuk channel terkunci, dari bukan anggota, dan untuk ruang yang bukan miliknya');

  // ---- E. sedang di channel = sibuk untuk panggilan lain; tidak bisa memulai panggilan / masuk channel saat menelepon ----
  A.vcLeave(); await until(() => B._legs(rapat).length === 0, 6000, 'A keluar'); // B sendirian di Rapat
  assert.throws(() => B.callStart(D.id, 'X'), /panggilan/, 'sendirian di channel pun tidak bisa menelepon');
  const missed0 = ac.B.ev.filter((e) => e.ev === 'incoming' && !e.auto).length;
  const cid = D.callStart(B.id, 'OFFER-D');
  await until(() => ac.D.ends.some((e) => e.cid === cid && e.reason === 'busy'), 6000, 'busy');
  assert.strictEqual(ac.B.ev.filter((e) => e.ev === 'incoming' && !e.auto).length, missed0, 'B tidak berdering');
  assert(B._vcMe, 'B tetap di channel');
  const cid2 = D.callStart(A.id, 'OFFER-D'); // A tidak di channel: berdering
  assert.throws(() => D.vcEnter(gid, santai), /panggilan/, 'sedang menelepon: tidak bisa masuk channel');
  D.callEnd(cid2);
  ok('di channel = sibuk bagi panggilan 1-1 (walau sendirian); sedang menelepon tidak bisa masuk channel');

  // ---- F. izin dicabut saat ada di dalam: kaki ditutup dan keluar otomatis ----
  A.vcEnter(gid, rapat);
  await until(() => active(A, rapat, ['B']) && active(B, rapat, ['A']), 8000, 'A-B lagi');
  A.vcUpdate(gid, rapat, { allow: [] });
  await until(() => B._vcMe === null && A._legs(rapat).length === 0 && B._legs(rapat).length === 0, 8000, 'dicabut');
  assert(A._vcMe && A._vcMe.cid === rapat, 'pemilik tetap di sana');
  ok('izin dicabut: B keluar otomatis dan kakinya di kedua sisi ditutup; pemilik tetap di channel');

  // ---- G. kaki yang gagal dicoba ulang, dibatasi, dan direset saat orangnya masuk ulang ----
  A.vcLeave(); await sleep(300);
  const lo = [A, D].sort((x, y) => (x.id < y.id ? -1 : 1))[0], hi = lo === A ? D : A;
  lo.removeAllListeners('call'); const acts = []; lo.on('call', (e) => { if (e.ev === 'legneed' && e.peer === hi.id) acts.push(e); }); // sisi penelepon: UI tidak membuat kaki
  hi.vcEnter(gid, santai); lo.vcEnter(gid, santai);
  await sleep(1800);
  assert.strictEqual(acts.length, 5, 'dicoba 5 kali lalu berhenti, bukan tanpa henti');
  await sleep(600);
  assert.strictEqual(acts.length, 5, 'tidak bertambah');
  hi.vcLeave(); await sleep(200); hi.vcEnter(gid, santai);
  await until(() => acts.length > 5, 4000, 'reset saat masuk ulang');
  ok('kaki yang gagal dicoba ulang paling banyak 5 kali berturut-turut; masuk ulang mengulang dari awal');

  for (const n of all) await n.stop();
  console.log('\n' + pass + ' skenario lolos');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

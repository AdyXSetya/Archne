'use strict';
// Tes sinyal panggilan suara (v0.13.0): urutan, kedaluwarsa, blokir, sibuk, glare, pemalsuan, dan tidak ada yang disimpan.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-call-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); }
  throw new Error('timeout: ' + label);
}
const mk = (n, extra) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false }, extra));
const lan = (c, ...o) => Promise.all(o.map((x) => c.addPeer('127.0.0.1', x.port)));
const rec = (c) => { const ev = []; c.on('call', (e) => ev.push(e)); return ev; };
const of = (ev, name, cid) => ev.filter((e) => e.ev === name && (!cid || e.cid === cid));
const nstored = (c) => Object.values(c.store.msgs).filter((m) => m.kind === 'c1').length + Object.keys(c.store.custody).length;
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };

(async () => {
  console.log('Archne call-signal test, dir: ' + tmp);
  const A = mk('A', { callRingMs: 1200, callConnMs: 1500 }), B = mk('B', { callRingMs: 1200, callConnMs: 1500 }), C = mk('C', { callRingMs: 1200 });
  const E = mk('E', { now: () => Date.now() - 10 * 60e3 }); // jam 10 menit tertinggal
  const all = [A, B, C, E];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 3), 8000, 'mesh');
  const ea = rec(A), eb = rec(B), ec = rec(C);

  // ---------- panggilan normal: tawaran -> jawaban -> ICE dua arah -> tersambung -> akhir ----------
  assert.strictEqual(A.getState().call, null);
  const cid = A.callStart(B.id, 'SDP-OFFER-A');
  assert(/^[0-9a-f]{16}$/.test(cid));
  assert.strictEqual(A.getState().call.state, 'dialing');
  A.callIce(cid, 'ice-A-1'); A.callIce(cid, 'ice-A-2'); // dikirim segera setelah tawaran: harus tetap berurutan
  await until(() => of(eb, 'incoming', cid).length === 1 && of(eb, 'ice', cid).length === 2, 5000, 'B menerima tawaran + ICE');
  const inc = of(eb, 'incoming', cid)[0];
  assert(inc.peer === A.id && inc.name === 'A' && inc.sdp === 'SDP-OFFER-A');
  assert.deepStrictEqual(of(eb, 'ice', cid).map((e) => e.data), ['ice-A-1', 'ice-A-2'], 'ICE tidak mendahului tawaran dan tetap berurutan');
  assert.strictEqual(B.getState().call.state, 'ringing');
  assert.strictEqual(B.getState().call.dir, 'in');
  ok('tawaran masuk + ICE berurutan, terdekripsi, nama peneleponnya benar');
  assert.throws(() => B.callAnswer(cid, ''), /SDP/);
  B.callAnswer(cid, 'SDP-ANSWER-B');
  await until(() => of(ea, 'answer', cid).length === 1, 5000, 'A menerima jawaban');
  assert.strictEqual(of(ea, 'answer', cid)[0].sdp, 'SDP-ANSWER-B');
  B.callIce(cid, 'ice-B-1');
  await until(() => of(ea, 'ice', cid).length === 1, 5000, 'A menerima ICE B');
  assert.strictEqual(A.getState().call.state, 'connecting');
  assert(A.callConnected(cid) && B.callConnected(cid));
  assert.strictEqual(A.getState().call.state, 'active');
  assert.strictEqual(A.callConnected(cid), false, 'callConnected idempoten');
  ok('jawaban, ICE balik, dan keadaan active');

  // ---------- sibuk: C menelepon B yang sedang dalam panggilan ----------
  const cidC = C.callStart(B.id, 'SDP-C');
  await until(() => of(ec, 'end', cidC).length === 1, 5000, 'C ditolak sibuk');
  assert.strictEqual(of(ec, 'end', cidC)[0].reason, 'busy');
  assert(of(eb, 'incoming', cidC).length === 0, 'B tidak berdering untuk panggilan kedua');
  assert.strictEqual(of(eb, 'missed', cidC)[0].reason, 'busy', 'B dicatat tak terjawab (sibuk)');
  assert.strictEqual(B.getState().call.cid, cid, 'panggilan pertama tidak terganggu');
  assert.throws(() => B.callStart(C.id, 'x'), /berlangsung/);
  ok('sibuk: penelepon kedua diberi tahu, panggilan pertama utuh');

  // ---------- pemalsuan: pihak ketiga tidak bisa mengakhiri/menyela panggilan orang lain ----------
  const m1 = C._makeMsg(B.id, 'c1', JSON.stringify({ t: 'end', cid })); // C menandatangani 'end' untuk cid milik A-B
  let r = B._callIn(m1);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(B.getState().call.cid, cid, 'end dari orang ketiga diabaikan');
  const m2 = C._makeMsg(B.id, 'c1', JSON.stringify({ t: 'ice', cid, data: 'racun' }));
  const nIce = of(eb, 'ice', cid).length;
  B._callIn(m2);
  assert.strictEqual(of(eb, 'ice', cid).length, nIce, 'ICE dari orang ketiga diabaikan');
  const forged = C._makeMsg(B.id, 'c1', JSON.stringify({ t: 'end', cid }));
  forged.from = A.id; // klaim dari A tanpa tanda tangan A
  assert.strictEqual(B._callIn(forged).ok, false, 'tanda tangan palsu ditolak');
  const plain = { from: C.id, to: B.id, ts: Date.now(), text: JSON.stringify({ t: 'offer', cid: 'a'.repeat(16), sdp: 'x' }) };
  assert.strictEqual(B._callIn(plain).ok, false, 'tanpa kind/tanda tangan ditolak');
  ok('pemalsuan: orang ketiga, tanda tangan palsu, tanpa enkripsi');

  // ---------- pemutaran ulang ----------
  const mi = A._makeMsg(B.id, 'c1', JSON.stringify({ t: 'ice', cid, data: 'sekali' }));
  const n0 = of(eb, 'ice', cid).length;
  B._callIn(mi); B._callIn(mi);
  assert.strictEqual(of(eb, 'ice', cid).length, n0 + 1, 'sinyal yang sama dua kali hanya diproses sekali');
  ok('pemutaran ulang sinyal yang sama diabaikan');

  // ---------- akhir panggilan: sisi lain ikut berakhir ----------
  B.callEnd(cid);
  await until(() => of(ea, 'end', cid).length === 1, 5000, 'A tahu panggilan berakhir');
  assert.strictEqual(of(ea, 'end', cid)[0].reason, 'ended');
  assert(of(ea, 'end', cid)[0].wasActive);
  assert(A.getState().call === null && B.getState().call === null);
  assert.strictEqual(B.callEnd(cid), false, 'callEnd idempoten');
  ok('akhir panggilan di kedua sisi, bebas lagi');

  // ---------- tolak ----------
  const c2 = A.callStart(B.id, 'S2');
  await until(() => of(eb, 'incoming', c2).length === 1, 5000, 'tawaran 2');
  B.callReject(c2);
  await until(() => of(ea, 'end', c2).length === 1, 5000, 'A tahu ditolak');
  assert.strictEqual(of(ea, 'end', c2)[0].reason, 'rejected');
  assert.strictEqual(of(eb, 'end', c2)[0].reason, 'rejected');
  ok('tolak');

  // ---------- batal sebelum diangkat ----------
  const c3 = A.callStart(B.id, 'S3');
  await until(() => of(eb, 'incoming', c3).length === 1, 5000, 'tawaran 3');
  A.callEnd(c3);
  await until(() => of(eb, 'end', c3).length === 1, 5000, 'B tahu dibatalkan');
  assert.strictEqual(of(eb, 'end', c3)[0].reason, 'missed');
  assert.strictEqual(of(ea, 'end', c3)[0].reason, 'cancelled');
  ok('batal sebelum diangkat -> tak terjawab di penerima');

  // ---------- kedaluwarsa: tidak diangkat ----------
  const c4 = A.callStart(B.id, 'S4');
  await until(() => of(eb, 'incoming', c4).length === 1, 5000, 'tawaran 4');
  await until(() => of(ea, 'end', c4).length === 1 && of(eb, 'end', c4).length === 1, 5000, 'kedaluwarsa');
  assert.strictEqual(of(ea, 'end', c4)[0].reason, 'noanswer');
  assert.strictEqual(of(eb, 'end', c4)[0].reason, 'missed');
  assert(A.getState().call === null && B.getState().call === null);
  assert.throws(() => B.callAnswer(c4, 'terlambat'), /tidak ditemukan/, 'menjawab setelah kedaluwarsa ditolak');
  ok('kedaluwarsa dalam hitungan detik, jawaban terlambat ditolak');

  // ---------- gagal tersambung ----------
  const c5 = A.callStart(B.id, 'S5');
  await until(() => of(eb, 'incoming', c5).length === 1, 5000, 'tawaran 5');
  B.callAnswer(c5, 'A5');
  await until(() => of(ea, 'end', c5).length === 1 && of(eb, 'end', c5).length === 1, 6000, 'gagal tersambung');
  for (const e of [of(ea, 'end', c5)[0], of(eb, 'end', c5)[0]]) assert(['failed', 'ended'].includes(e.reason) && !e.wasActive, 'berakhir sebelum aktif (siapa yang habis waktu duluan memberi tahu lawannya)');
  assert(A.getState().call === null && B.getState().call === null);
  ok('media tidak tersambung dalam batas waktu -> gagal di kedua sisi');

  // ---------- offline: tidak dititipkan ----------
  const D = mk('D'); await D.start();
  assert.throws(() => A.callStart(D.id, 'x'), /offline/);
  await lan(A, D); await until(() => A.peers.get(D.id) && A.isOnline(A.peers.get(D.id)), 5000, 'D terlihat');
  await D.stop();
  A.peers.get(D.id).lastSeen = 0; // dianggap offline
  assert.throws(() => A.callStart(D.id, 'x'), /offline/);
  assert.strictEqual(nstored(A) + nstored(B) + nstored(C), 0, 'tidak ada sinyal yang disimpan/dititipkan');
  assert(!Object.values(A.store.status).includes('pending'), 'tidak masuk antrean kirim DM');
  ok('penerima offline: langsung ditolak, tidak ada antrean/kurir');

  // ---------- jam basi ----------
  const ee = rec(E), ebStart = eb.length;
  const cE = E.callStart(B.id, 'SE');
  await until(() => of(ee, 'end', cE).length === 1, 5000, 'E ditolak');
  assert.strictEqual(of(ee, 'end', cE)[0].reason, 'refused');
  assert.strictEqual(eb.length, ebStart, 'B tidak melihat apa pun dari sinyal basi');
  ok('sinyal dengan stempel waktu basi ditolak');

  // ---------- blokir: dibuang diam-diam ----------
  B.blockUser(A.id);
  const c6 = A.callStart(B.id, 'S6'); // A tidak tahu diblokir (peer masih online di sisi A)
  await sleep(500);
  assert(!eb.some((e) => e.cid === c6), 'B tidak mendapat event apa pun');
  assert(B.getState().call === null);
  assert.strictEqual(A.getState().call.state, 'dialing', 'A tetap menunggu: tidak ada tanda ditolak/diblokir');
  await until(() => of(ea, 'end', c6).length === 1, 5000, 'A tak terjawab');
  assert.strictEqual(of(ea, 'end', c6)[0].reason, 'noanswer');
  assert.throws(() => B.callStart(A.id, 'x'), /memblokir/);
  ok('diblokir: dibuang diam-diam, penelepon hanya melihat tak terjawab');

  // ---------- blokir saat panggilan berjalan ----------
  B.unblockUser(A.id);
  await sleep(300);
  const c7 = C.callStart(B.id, 'S7');
  await until(() => of(eb, 'incoming', c7).length === 1, 5000, 'tawaran 7');
  B.callAnswer(c7, 'A7');
  await until(() => of(ec, 'answer', c7).length === 1, 5000, 'C dijawab');
  B.blockUser(C.id);
  assert.strictEqual(B.getState().call, null);
  assert.strictEqual(of(eb, 'end', c7)[0].reason, 'blocked');
  ok('memblokir saat panggilan berjalan memutusnya');
  B.unblockUser(C.id);

  // ---------- saling menelepon bersamaan (glare) ----------
  await sleep(2500); // biarkan sisa panggilan sebelumnya selesai
  for (const n of [A, B]) assert(n.getState().call === null, 'bebas sebelum glare');
  const ea2 = ea.length, eb2 = eb.length;
  const cg1 = A.callStart(B.id, 'GA'), cg2 = B.callStart(A.id, 'GB');
  const [lo, hi] = A.id < B.id ? [A, B] : [B, A];
  const [clo, chi] = A.id < B.id ? [cg1, cg2] : [cg2, cg1];
  await until(() => hi.getState().call && hi.getState().call.dir === 'in', 5000, 'yang id-nya besar mengalah');
  assert.strictEqual(hi.getState().call.cid, clo, 'yang menjadi penelepon: id lebih kecil');
  assert.strictEqual(lo.getState().call.dir, 'out');
  assert.strictEqual(lo.getState().call.cid, clo);
  const ehi = hi === A ? ea : eb, evHi = ehi.slice(hi === A ? ea2 : eb2);
  assert.strictEqual(of(evHi, 'end', chi)[0].reason, 'glare');
  assert.strictEqual(of(evHi, 'incoming', clo).length, 1);
  hi.callAnswer(clo, 'G-ANS');
  await until(() => lo.getState().call.state === 'connecting', 5000, 'tersambung setelah glare');
  lo.callEnd(clo);
  ok('saling menelepon bersamaan: satu panggilan saja yang jadi');

  // ---------- tidak ada jejak ----------
  for (const n of all) assert.strictEqual(nstored(n), 0, 'tidak ada sinyal tersimpan di ' + n.name);
  assert(!JSON.stringify(A.getState().messages).includes('SDP'), 'tidak muncul di chat');
  ok('tidak ada sinyal tersimpan dan tidak ada yang muncul di chat');

  for (const n of all) { try { await n.stop(); } catch {} }
  console.log(`\n${pass} kelompok tes lolos`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

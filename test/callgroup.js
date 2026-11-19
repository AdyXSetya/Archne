'use strict';
// Tes panggilan grup: 1a model ruang + undangan, 1b bergabung + kaki antar-peserta, 1c keluar/putus + ruang bubar, 1d riwayat grup.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-cg-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, callRingMs: 1200, callConnMs: 1500 });
const rec = (c) => { const ev = []; c.on('call', (e) => ev.push(e)); return ev; };
const of = (ev, name) => ev.filter((e) => e.ev === name);
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };

(async () => {
  console.log('Archne group-call test (1a-1d), dir: ' + tmp);
  const [A, B, C, D] = ['A', 'B', 'C', 'D'].map(mk);
  const all = [A, B, C, D];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await Promise.all(all.slice(i + 1).map((x) => all[i].addPeer('127.0.0.1', x.port)));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 3), 8000, 'mesh');
  const ea = rec(A), ec = rec(C);

  const cid = A.callStart(B.id, 'SDP-A');
  assert.throws(() => A.callInvite(cid, C.id), /tidak ditemukan|keadaannya/, 'belum aktif: tidak boleh mengundang');
  await until(() => B.getState().call && B.getState().call.state === 'ringing', 5000, 'B berdering');
  B.callAnswer(cid, 'SDP-B');
  await until(() => A.getState().call.state === 'connecting', 5000, 'A connecting');
  A.callConnected(cid); B.callConnected(cid);
  const info = A.getState().call;
  assert.strictEqual(info.room, cid);
  assert.deepStrictEqual(info.members.map((m) => m.id).sort(), [A.id, B.id].sort());
  ok('ruang punya id + daftar anggota (aku + lawan bicara)');

  assert.throws(() => A.callInvite(cid, B.id), /sudah ada/);
  assert.throws(() => A.callInvite(cid, A.id), /ID tidak valid/);
  assert.throws(() => A.callInvite(cid, 'abcdefabcdefabcd'), /offline/);
  ok('undangan ditolak: sudah di panggilan, diri sendiri, tidak dikenal/offline');

  A.callInvite(cid, C.id);
  assert.throws(() => A.callInvite(cid, C.id), /menunggu/);
  await until(() => of(ec, 'invited').length === 1, 5000, 'C menerima undangan');
  const iv = of(ec, 'invited')[0];
  assert(iv.room === cid && iv.peer === A.id && iv.name === 'A');
  assert.deepStrictEqual(iv.members.map((m) => m.id).sort(), [A.id, B.id].sort());
  assert(C._calls.size === 0 && C._joins.size === 0, 'undangan belum membuat panggilan');
  assert(C.getState().call.invite === true && C.getState().call.legs.length === 0, 'snapshot menampilkannya sebagai undangan (bukan panggilan), supaya UI yang baru terpasang tetap berdering');
  ok('undangan sampai ke C bersama daftar peserta; belum jadi panggilan');

  C.callInviteDecline(cid);
  await until(() => of(ea, 'invitefail').length === 1, 5000, 'A tahu ditolak');
  assert.strictEqual(of(ea, 'invitefail')[0].reason, 'declined');
  assert.throws(() => C.callInviteDecline(cid), /tidak ditemukan/);
  ok('undangan ditolak: pengundang diberi tahu, undangan hilang');

  A.callInvite(cid, C.id);
  await until(() => of(ea, 'invitefail').length === 2 && of(ec, 'inviteend').length === 1, 5000, 'kedaluwarsa');
  assert.strictEqual(of(ea, 'invitefail')[1].reason, 'noanswer');
  assert.strictEqual(of(ec, 'inviteend')[0].reason, 'expired');
  ok('undangan tidak dijawab: kedaluwarsa di kedua sisi');

  C.callStart(D.id, 'SDP-C');
  await until(() => C.getState().call, 3000, 'C menelepon D');
  A.callInvite(cid, C.id);
  await until(() => of(ea, 'invitefail').length === 3, 5000, 'sibuk');
  assert.strictEqual(of(ea, 'invitefail')[2].reason, 'busy');
  assert.strictEqual(of(ec, 'invited').length, 2, 'C yang sibuk tidak menerima undangan baru');
  ok('penerima yang sedang menelepon menjawab sibuk otomatis');

  A.callEnd(cid);
  await until(() => B.getState().call === null, 5000, 'B selesai');
  assert.strictEqual(A._invOut.size, 0);
  ok('ruang bubar: tidak ada undangan keluar yang tersisa');

  // ---------- 1b: bergabung ----------
  // UI palsu: legneed -> buat tawaran, incoming otomatis -> jawab + tersambung, answer -> tersambung
  for (const n of all) n.on('call', (e) => {
    if (e.ev === 'legneed') n.callLeg(e.room, e.peer, 'SDP-' + n.name + '-' + e.peer.slice(0, 4));
    else if (e.ev === 'incoming' && e.auto) { n.callAnswer(e.cid, 'ANS'); n.callConnected(e.cid); }
    else if (e.ev === 'answer') n.callConnected(e.cid);
  });
  await until(() => all.every((n) => !n.getState().call && !n._invIn.size), 6000, 'semua bersih');
  const t0 = Date.now(), iC = rec(C), iD = rec(D);
  const g = A.callStart(B.id, 'S1');
  await until(() => B.getState().call && B.getState().call.state === 'ringing', 5000, 'B berdering');
  B.callAnswer(g, 'S2'); B.callConnected(g);
  await until(() => A.getState().call.state === 'active', 5000, 'A-B aktif');
  A.callInvite(g, C.id);
  await until(() => of(iC, 'invited').length === 1, 5000, 'C diundang');
  const full = (n, k, rm = g) => n._calls.size === k - 1 && [...n._calls.values()].every((l) => l.state === 'active' && l.room === rm) && n.getState().call.members.length === k;
  C.callInviteAccept(g);
  assert.throws(() => C.callInviteAccept(g), /tidak ditemukan/);
  await until(() => [A, B, C].every((n) => full(n, 3)), 8000, 'C tersambung ke A dan B');
  assert.deepStrictEqual(C.getState().call.members.map((m) => m.id).sort(), [A.id, B.id, C.id].sort());
  ok('C bergabung: tersambung langsung ke A dan B (mesh 3 orang), id lebih kecil jadi penelepon');

  const eg = B.getState().call.cid; // satu kaki milik B: peserta mana pun boleh mengundang
  B.callInvite(eg, D.id);
  await until(() => of(iD, 'invited').length === 1, 5000, 'D diundang B');
  D.callInviteAccept(g);
  await until(() => all.every((n) => full(n, 4)), 8000, 'D tersambung ke semua');
  assert.strictEqual(A._joins.size + B._joins.size, 0);
  ok('D diundang peserta lain (B) dan tersambung ke ketiganya: mesh 4 orang');

  const E = new Core({ dataDir: path.join(tmp, 'E'), name: 'E', discovery: false });
  assert.throws(() => E.callLeg(g, A.id, 'x'), /izin/);
  assert.throws(() => A.callLeg(g, D.id, 'x'), /Sudah tersambung/);
  ok('orang luar tidak bisa menyambung ke ruang; kaki ganda ditolak');

  for (const n of all) for (const l of [...n._calls.values()]) n.callEnd(l.cid);
  await until(() => all.every((n) => !n.getState().call && !n._joins.size && !n._invOut.size), 5000, 'bubar');
  assert(all.every((n) => n.store.calls.filter((r) => r.at >= t0).every((r) => r.id === g)), 'kaki tambahan tidak masuk riwayat per kaki');
  ok('semua keluar: ruang bersih, kaki tambahan tidak mengotori riwayat');

  // ---------- 1c: keluar / putus / ruang bubar ----------
  const idle = () => until(() => all.every((n) => !n.getState().call && !n._joins.size && !n._invOut.size && !n._invIn.size && !n._expect.size), 6000, 'semua bersih');
  const room3 = async (host, b, c) => { // host menelepon b, lalu mengundang c; hasilnya mesh 3 orang
    const r = host.callStart(b.id, 'S1');
    await until(() => b.getState().call && b.getState().call.state === 'ringing', 5000, 'berdering');
    b.callAnswer(r, 'S2'); b.callConnected(r);
    await until(() => host.getState().call.state === 'active', 5000, 'aktif');
    const ic = rec(c);
    host.callInvite(r, c.id);
    await until(() => of(ic, 'invited').length === 1, 5000, 'diundang');
    c.callInviteAccept(r);
    await until(() => [host, b, c].every((n) => full(n, 3, r) && !n._joins.size), 8000, 'mesh 3');
    return r;
  };
  await idle();

  // (a) satu peserta keluar: yang lain tetap tersambung; yang terakhir ditinggal -> ruang bubar
  const r1 = await room3(A, B, C);
  const eaa = rec(A), ebb = rec(B);
  C.callLeave(r1);
  assert.strictEqual(C.getState().call, null);
  await until(() => of(eaa, 'end').length === 1 && of(ebb, 'end').length === 1, 5000, 'A dan B tahu C keluar');
  const ec1 = of(eaa, 'end')[0];
  assert(ec1.peer === C.id && ec1.last === false && ec1.room === r1, 'C keluar: bukan akhir ruang');
  assert(A.getState().call && A.getState().call.state === 'active' && B.getState().call.state === 'active', 'A dan B tetap berbicara');
  assert.deepStrictEqual(A.getState().call.members.map((m) => m.id).sort(), [A.id, B.id].sort());
  ok('satu peserta keluar: lainnya tetap tersambung, daftar anggota menyusut, event end last=false');
  B.callLeave(r1);
  await until(() => of(eaa, 'end').length === 2, 5000, 'A ditinggal B');
  assert.strictEqual(of(eaa, 'end')[1].last, true);
  await idle();
  ok('tinggal satu orang: ruang bubar (event end last=true), tidak ada sisa keadaan');

  // (b) pembuat panggilan keluar lebih dulu: peserta lain tetap jalan tanpa dia
  const r2 = await room3(A, B, C);
  const ebc = rec(B), ecc = rec(C);
  A.callLeave(r2);
  await until(() => of(ebc, 'end').length === 1 && of(ecc, 'end').length === 1, 5000, 'B dan C tahu A keluar');
  assert(of(ebc, 'end')[0].last === false && of(ecc, 'end')[0].last === false);
  assert.strictEqual(B._calls.size, 1); assert.strictEqual(C._calls.size, 1);
  assert([...B._calls.values()][0].peer === C.id && [...B._calls.values()][0].state === 'active', 'B-C tetap aktif');
  C.callLeave(r2);
  await idle();
  ok('pembuat panggilan keluar duluan: B dan C tetap tersambung, bubar setelah salah satu keluar');

  // (c) satu kaki putus (mis. ICE gagal): kaki itu saja yang ditutup
  const r3 = await room3(A, B, C);
  const eca = rec(A);
  const legAB = [...A._calls.values()].find((l) => l.peer === B.id);
  A.callEnd(legAB.cid);
  await until(() => of(eca, 'end').length === 1 && B._calls.size === 1, 5000, 'kaki A-B putus');
  assert(of(eca, 'end')[0].last === false && A._calls.size === 1 && C._calls.size === 2, 'kaki lain tidak ikut putus');
  for (const n of [A, B, C]) n.callLeave(r3);
  await idle();
  ok('satu kaki putus: hanya kaki itu yang ditutup, kaki lain utuh');

  // (d) ruang bubar saat undangan masih menggantung: yang diundang diberi tahu, undangan hilang
  const r4 = A.callStart(B.id, 'S1');
  await until(() => B.getState().call && B.getState().call.state === 'ringing', 5000, 'B berdering');
  B.callAnswer(r4, 'S2'); B.callConnected(r4);
  await until(() => A.getState().call.state === 'active', 5000, 'aktif');
  const icd = rec(C);
  A.callInvite(r4, C.id);
  await until(() => of(icd, 'invited').length === 1, 5000, 'C diundang');
  B.callLeave(r4);
  await until(() => of(icd, 'inviteend').length === 1, 5000, 'undangan dibatalkan');
  assert.strictEqual(of(icd, 'inviteend')[0].reason, 'cancelled');
  assert.strictEqual(C._invIn.size, 0);
  assert.throws(() => C.callInviteAccept(r4), /tidak ditemukan/);
  await idle();
  ok('ruang bubar saat undangan menggantung: yang diundang diberi tahu, tidak bisa lagi bergabung');

  // (e) keluar di tengah proses bergabung: peserta lama tidak terganggu, tidak ada kaki sisa
  const r5 = A.callStart(B.id, 'S1');
  await until(() => B.getState().call && B.getState().call.state === 'ringing', 5000, 'B berdering');
  B.callAnswer(r5, 'S2'); B.callConnected(r5);
  await until(() => A.getState().call.state === 'active', 5000, 'aktif');
  const ice = rec(C);
  A.callInvite(r5, C.id);
  await until(() => of(ice, 'invited').length === 1, 5000, 'C diundang');
  C.callInviteAccept(r5);
  assert(C.getState().call && C.getState().call.room === r5, 'selama bergabung, UI tetap melihat panggilan');
  C.callLeave(r5);
  assert.strictEqual(C.getState().call, null);
  assert.strictEqual(C.callLeave(r5), false, 'keluar dua kali: tidak melakukan apa-apa');
  await until(() => A._calls.size === 1 && B._calls.size === 1 && !A._expect.size && !B._expect.size && !C._calls.size && !C._joins.size, 6000, 'tidak ada kaki sisa');
  assert(A.getState().call.state === 'active' && B.getState().call.state === 'active', 'A dan B tetap tersambung');
  ok('keluar saat masih bergabung: A dan B tidak terganggu, tidak ada kaki atau izin yang tersisa');

  // (f) tawaran ber-room dari yang tidak diizinkan tidak berdering dan tidak dicatat
  B.callLeave(r5);
  await idle();
  const logN = A.store.calls.length, ica = rec(A);
  D._callSend(A.id, { t: 'offer', cid: 'aaaaaaaaaaaaaaaa', room: 'bbbbbbbbbbbbbbbb', sdp: 'X' });
  await sleep(500);
  assert.strictEqual(of(ica, 'incoming').length, 0); assert.strictEqual(A.getState().call, null); assert.strictEqual(A.store.calls.length, logN);
  ok('tawaran ruang dari orang tak berizin: tidak berdering, tidak masuk riwayat');

  // ---------- 1d: riwayat grup ----------
  const ids5 = (q) => q.members.map((m) => m.id);
  // catatan 1-1 tetap berbentuk lama (tanpa group/members), termasuk yang sempat gagal menambah orang (r4/r5 di atas)
  const q4 = A.store.calls.find((z) => z.id === r4);
  assert(q4 && q4.group === undefined && q4.members === undefined && q4.out === 'done' && q4.peer === B.id, 'catatan 1-1 tetap bentuk lama');
  const q5 = A.store.calls.find((z) => z.id === r5); // C sempat bergabung lalu keluar: kaki A-C mungkin sempat tersambung (balapan), jadi dua bentuk sama-sama sah
  assert(q5 && q5.out === 'done' && (q5.group ? ids5(q5).includes(B.id) && ids5(q5).includes(C.id) : q5.members === undefined && q5.peer === B.id), 'catatan r5');
  ok('panggilan 1-1 tetap satu catatan bentuk lama; yang sempat ketambahan orang tercatat konsisten');

  // (a) satu ruang = satu catatan, ditulis saat ruang bubar; yang keluar duluan tetap tercatat sebagai peserta
  const nA = A.store.calls.length, nB = B.store.calls.length, nC = C.store.calls.length;
  const r6 = await room3(A, B, C);
  B.callLeave(r6); // lawan 1-1 awal keluar duluan; A dan C lanjut
  await until(() => A._calls.size === 1 && C._calls.size === 1, 5000, 'B keluar');
  assert(A.store.calls.length === nA && C.store.calls.length === nC && B.store.calls.length === nB + 1, 'A dan C belum bubar: belum ada catatan; B sudah');
  A.callLeave(r6);
  await idle();
  const ids = (q) => q.members.map((m) => m.id).sort();
  const qa = A.store.calls.find((z) => z.id === r6), qb = B.store.calls.find((z) => z.id === r6), qc = C.store.calls.find((z) => z.id === r6);
  assert(A.store.calls.length === nA + 1 && B.store.calls.length === nB + 1 && C.store.calls.length === nC + 1, 'tepat satu catatan per ruang per perangkat');
  assert(qa.group === 1 && qa.dir === 'out' && qa.out === 'done' && Number.isFinite(qa.dur) && qa.dur >= 0);
  assert.deepStrictEqual(ids(qa), [B.id, C.id].sort());
  assert.deepStrictEqual(ids(qb), [A.id, C.id].sort());
  assert(qc.group === 1 && qc.dir === 'in' && qc.out === 'done');
  assert.deepStrictEqual(ids(qc), [A.id, B.id].sort());
  assert(qa.members.every((m) => m.id !== A.id) && ids(qa).includes(qa.peer), 'aku tidak masuk members; peer adalah salah satu anggota');
  ok('ruang 3 orang: satu catatan per perangkat (group + members tanpa aku), yang keluar duluan tetap tercatat');

  // (b) keluaran getState untuk UI + blokir + hapus dari chat + hapus riwayat
  const st = A.getState().calls.find((z) => z.id === r6);
  assert(st.group === true && st.members.map((m) => m.name).sort().join() === 'B,C' && st.hc === false && Array.isArray(st.hcs));
  assert(A.getState().calls.find((z) => z.id === r4).group === undefined, '1-1 di state tetap tanpa group');
  A.blockUser(B.id);
  assert.deepStrictEqual(A.getState().calls.find((z) => z.id === r6).members.map((m) => m.id), [C.id], 'anggota terblokir tidak tampil');
  A.blockUser(C.id);
  assert(!A.getState().calls.some((z) => z.id === r6), 'semua anggota terblokir: catatan disembunyikan');
  A.unblockUser(B.id); A.unblockUser(C.id);
  A.clearChat(B.id);
  const hb = A.getState().calls.find((z) => z.id === r6);
  assert.deepStrictEqual(hb.hcs, [B.id], 'kartu grup hilang hanya dari DM dengan B');
  assert(A.store.calls.find((z) => z.id === r4).hc === 1, '1-1 dengan B ikut hilang dari chat');
  A.clearCalls(C.id);
  assert(!A.store.calls.some((z) => z.id === r6) && A.store.calls.some((z) => z.id === r4), 'hapus riwayat dengan C: catatan grup yang memuat C ikut hilang, catatan 1-1 dengan B utuh');
  ok('state: anggota terblokir disaring, hapus-dari-chat per DM, hapus riwayat per orang mencakup grup');

  // (c) data tersimpan yang rusak dibersihkan saat dimuat
  A.store.calls.push({ id: 'cccccccccccccccc', peer: B.id, dir: 'in', out: 'done', at: 1, dur: 1, group: 1, members: [null, { id: 'zz' }, { id: C.id, name: 'x'.repeat(60) }], hcs: ['bad', D.id] });
  A.store.calls.push({ id: 'dddddddddddddddd', peer: B.id, dir: 'in', out: 'done', at: 2, dur: 1, members: [{ id: C.id }], hcs: [D.id] });
  A._migrate();
  const g1 = A.store.calls.find((z) => z.id === 'cccccccccccccccc'), g2 = A.store.calls.find((z) => z.id === 'dddddddddddddddd');
  assert(g1.members.length === 1 && g1.members[0].id === C.id && g1.members[0].name.length === 32 && g1.hcs.length === 1 && g1.hcs[0] === D.id);
  assert(g2.group === undefined && g2.members === undefined && g2.hcs === undefined, 'bukan grup: sisa field dibuang');
  ok('catatan grup yang rusak dibersihkan saat dimuat (members, hcs, field yatim)');

  console.log('\n' + pass + ' tes lulus');
  for (const n of all) await n.stop();
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

'use strict';
// Tes sematan pesan (v0.20.0, pin2): penyimpanan dan penyebaran. Sematan bersama = pesan kontrol tersembunyi (g1 di grup, e1 di DM);
// keadaannya disimpan terpisah dari riwayat pesan; sematan pribadi hanya lokal.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const Pins = require('../src/archne-pins');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pins-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const reopen = (c, n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const lan = (c, ...o) => Promise.all(o.map((x) => c.addPeer('127.0.0.1', x.port)));
const grp = (c, gid) => c.getState().groups.find((g) => g.id === gid);
const texts = (c, scope) => c.pinList(scope).shared.map((p) => p.text).sort();
const mine = (c, scope) => c.pinList(scope).mine.map((p) => p.text).sort();
const waitCarrier = (c, id) => until(() => c.store.msgs[id], 8000, 'pesan kontrol tiba');
const hiddenCtl = (c) => Object.values(c.store.msgs).filter((m) => c._isPinCtl(m));

(async () => {
  console.log('Archne pins sync test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D'), E = mk('E');
  let all = [A, B, C, D, E];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 4), 8000, 'mesh');
  const gid = A.createGroup('Tim', [B.id, C.id, D.id]).id, G = 'g:' + gid;
  await until(() => [B, C, D].every((n) => grp(n, gid)), 8000, 'undangan');
  A.setAdmin(gid, B.id, true);
  await until(() => [A, B, C, D].every((n) => grp(n, gid).epoch === 1), 10000, 'admin B');
  const members = [A, B, C, D];

  // ---- A. sematan bersama di grup: admin menyematkan, semua melihat; member hanya pribadi ----
  const t1 = A.sendText('rapat jam 9 di aula', G);
  await until(() => members.every((n) => n.getState().messages.some((m) => m.id === t1.id)), 8000, 'pesan tiba');
  const seen = []; for (const n of members) n.on('message', (m) => seen.push(m));
  const pidB = B.pinAdd(G, t1.id, true);
  await until(() => members.every((n) => n.pinList(G).shared.length === 1), 8000, 'sematan tersebar');
  const v = A.pinList(G).shared[0];
  assert.strictEqual(v.text, 'rapat jam 9 di aula'); assert.strictEqual(v.from, A.id); assert.strictEqual(v.by, B.id);
  assert.strictEqual(v.mid, t1.id); assert.strictEqual(v.kind, 'msg'); assert.strictEqual(v.name, 'A');
  assert.deepStrictEqual(members.map((n) => n.pinList(G).canShare), [true, true, false, false]);
  assert.deepStrictEqual(members.map((n) => n.pinList(G).shared[0].canRemove), [true, true, false, false], 'admin dan pemilik boleh melepas, member tidak');
  for (const n of members) {
    assert(n.getState().messages.every((m) => !String(m.text).includes('\u0001') && !String(m.text).includes('pin:')), 'pesan kontrol tidak tampil');
    assert(hiddenCtl(n).length >= 1, 'tersimpan sebagai pesan kontrol (ikut sinkron)');
  }
  assert.strictEqual(seen.length, 0, 'tidak memicu notifikasi pesan');
  assert.throws(() => A.sendText('balas', G, hiddenCtl(A)[0].id), /tidak ditemukan/, 'pesan kontrol tidak bisa dibalas');
  ok('admin B menyematkan, semua anggota melihat salinan lengkap; pesan kontrol tersembunyi dan tidak menimbulkan notifikasi');

  // member: bersama ditolak, pribadi lokal saja (tanpa pesan apa pun)
  assert.throws(() => C.pinAdd(G, t1.id, true), /admin atau pemilik/);
  assert.throws(() => B.pinAdd(G, t1.id, true), /sudah disematkan/);
  const before = Object.keys(A.store.msgs).length + Object.keys(C.store.msgs).length;
  C.pinAdd(G, t1.id, false);
  await sleep(300);
  assert.strictEqual(Object.keys(A.store.msgs).length + Object.keys(C.store.msgs).length, before, 'sematan pribadi tidak membuat pesan');
  assert.deepStrictEqual(mine(C, G), ['rapat jam 9 di aula']); assert.deepStrictEqual(mine(A, G), []); assert.deepStrictEqual(mine(D, G), []);
  assert.deepStrictEqual(texts(C, G), ['rapat jam 9 di aula'], 'bersama dan pribadi terpisah');
  ok('member biasa: sematan bersama ditolak; sematan pribadi hanya lokal dan tidak menyebar');

  // ---- B. tidak terpengaruh Bersihkan chat dan batal kirim pesan asli ----
  C.clearChat(G);
  assert(!C.getState().messages.some((m) => m.to === G), 'chat bersih');
  assert.strictEqual(C.pinList(G).shared.length, 1); assert.strictEqual(C.pinList(G).mine.length, 1);
  A.deleteMessage(t1.id);
  await until(() => members.every((n) => !n.getState().messages.some((m) => m.id === t1.id)), 8000, 'batal kirim');
  assert(members.every((n) => n.pinList(G).shared.length === 1 && n.pinList(G).shared[0].text === 'rapat jam 9 di aula'));
  assert.throws(() => C.pinAdd(G, t1.id, false), /tidak ditemukan/, 'pesan yang sudah hilang tidak bisa disematkan');
  ok('Bersihkan chat dan batal kirim pesan asli tidak menghapus sematan (salinan, bukan penunjuk)');

  // ---- C. anggota offline: bertahan setelah restart, lalu menyusul lewat sinkron ----
  const dMine = D.pinNote(G, 'catatan pribadi D', false);
  await C.stop();
  const t2 = A.sendText('bawa laptop masing-masing', G);
  await sleep(200);
  const pidT2 = B.pinAdd(G, t2.id, true);
  const pidNote = A.pinNote(G, 'Rapat pindah ke ruang 2', true);
  await until(() => [A, B, D].every((n) => n.pinList(G).shared.length === 3), 8000, 'tiga sematan');
  const C2 = reopen(C, 'C');
  await C2.start(); // store dimuat saat start(); belum ada koneksi ke siapa pun
  assert.deepStrictEqual(texts(C2, G), ['rapat jam 9 di aula'], 'sematan lama selamat dari restart');
  assert.deepStrictEqual(mine(C2, G), ['rapat jam 9 di aula'], 'sematan pribadi selamat dari restart');
  await C2.addPeer('127.0.0.1', A.port); await C2.addPeer('127.0.0.1', B.port);
  await until(() => C2.pinList(G).shared.length === 3, 10000, 'C menyusul');
  assert.deepStrictEqual(texts(C2, G), texts(A, G));
  all = [A, B, C2, D, E]; members.splice(0, 4, A, B, C2, D);
  await lan(D, C2); await lan(A, C2);
  ok('sematan dan sematan pribadi selamat dari restart; anggota yang offline menyusul begitu online');

  // ---- D. pengumuman bebas: edit oleh admin, anggota lain melihat; hapus final ----
  assert.throws(() => C2.pinEdit(G, pidNote, 'bajak'), /admin atau pemilik/);
  B.pinEdit(G, pidNote, 'Rapat pindah ke ruang 3');
  await until(() => members.every((n) => texts(n, G).includes('Rapat pindah ke ruang 3')), 8000, 'edit tersebar');
  assert.throws(() => A.pinEdit(G, pidB, 'ubah isi pesan'), /Hanya pengumuman/);
  A.pinRemove(G, pidT2); // pemilik melepas sematan milik admin
  await until(() => members.every((n) => n.pinList(G).shared.length === 2), 8000, 'lepas tersebar');
  assert(members.every((n) => !texts(n, G).includes('bawa laptop masing-masing')));
  assert.throws(() => A.pinRemove(G, pidT2), /tidak ditemukan/);
  ok('pengumuman bebas dapat diedit admin; pemilik melepas sematan milik admin; yang dilepas hilang di semua anggota');

  // ---- E. obrolan ramai tidak mendorong sematan keluar dari sinkron ----
  const dDir = 'D';
  await D.stop();
  const pidOld = A.pinNote(G, 'Aturan: jangan spam', true);
  for (let i = 0; i < 520; i++) { const m = A._makeMsg(G, 'g1', 'padding ' + i + ' ' + Math.random()); A.store.msgs[m.id] = m; }
  const carrier = A.store.pins[G].r[pidOld];
  const res = A._handle({ t: 'sync_req', have: [], gh: { [gid]: [] }, hi: { id: D.id, name: 'D', port: 1, pub: D.pub, xpub: D.xpub, xsig: D.xsig } }, '127.0.0.1');
  assert(res.gmsgs.some((m) => m.id === carrier), 'pesan pembawa sematan ikut walau di luar 500 pesan terbaru');
  const D2 = reopen(D, dDir);
  await D2.start();
  assert.deepStrictEqual(mine(D2, G), ['catatan pribadi D']);
  await D2.addPeer('127.0.0.1', A.port);
  await until(() => texts(D2, G).includes('Aturan: jangan spam'), 15000, 'D dapat sematan lama');
  assert.deepStrictEqual(texts(D2, G), texts(A, G));
  all = [A, B, C2, D2, E]; members.splice(3, 1, D2);
  await lan(B, D2); await lan(C2, D2);
  ok('putaran sync pertama sudah membawa pesan pembawa sematan walau di luar 500 pesan terbaru; anggota yang offline mendapat sematan lama');

  // ---- F. anggota baru langsung melihat sematan yang hidup (pengumuman ulang), bukan yang sudah dilepas ----
  A.addMembers(gid, [E.id]);
  await until(() => grp(E, gid) && E.pinList(G).shared.length === 3, 12000, 'E dapat sematan');
  assert.deepStrictEqual(texts(E, G), texts(A, G));
  assert(!texts(E, G).includes('bawa laptop masing-masing'), 'tombstone tidak dihidupkan lagi');
  assert.strictEqual(E.pinList(G).canShare, false);
  members.push(E);
  await until(() => [A, B, C2, D2].every((n) => grp(n, gid).members.length === 5 && grp(n, gid).epoch === 2), 12000, 'epoch baru');
  ok('anggota baru E langsung melihat sematan yang hidup, tanpa yang sudah dilepas');

  // ---- G. admin yang dicopot: sematannya tetap, hanya admin aktif yang bisa melepas; palsu ditolak ----
  A.setAdmin(gid, B.id, false);
  await until(() => [A, B, C2, D2, E].every((n) => !grp(n, gid).admins.includes(B.id)), 12000, 'B dicopot');
  assert(members.every((n) => n.pinList(G).shared.some((p) => p.by === B.id)), 'sematan milik mantan admin tetap ada');
  assert.strictEqual(B.pinList(G).canShare, false);
  assert.throws(() => B.pinRemove(G, pidB), /admin atau pemilik/);
  assert.throws(() => B.pinNote(G, 'masih admin?', true), /admin atau pemilik/);
  const rec = Object.assign({}, A.store.pins[G].m[pidB]);
  const forgedDel = B._send(Pins.encodeCtl([Object.assign({}, rec, { del: true, v: rec.v + 1, ts: Date.now() + 5 })]), G);
  const fakeId = Pins.newId(C2.id);
  const forgedNew = C2._send(Pins.encodeCtl([{ id: fakeId, by: C2.id, kind: 'note', text: 'palsu', from: C2.id, name: 'C', at: 1, mid: '', ts: Date.now(), v: 1, del: false }]), G);
  const farTs = Date.now() + 10 * 3600e3;
  const forgedFar = A._send(Pins.encodeCtl([{ id: Pins.newId(A.id), by: A.id, kind: 'note', text: 'dari masa depan', from: A.id, name: 'A', at: 1, mid: '', ts: farTs, v: 1, del: false }]), G);
  for (const id of [forgedDel.id, forgedNew.id, forgedFar.id]) await Promise.all([A, B, D2, E].map((n) => waitCarrier(n, id)));
  await sleep(300);
  for (const n of [A, B, D2, E]) {
    assert(texts(n, G).includes('rapat jam 9 di aula'), 'pencopotan palsu oleh mantan admin ditolak');
    assert(!texts(n, G).includes('palsu'), 'member biasa tidak bisa menyematkan untuk semua');
    assert(!texts(n, G).includes('dari masa depan'), 'ts jauh di masa depan ditolak');
  }
  A.pinRemove(G, pidB); // admin aktif boleh melepas sematan mantan admin
  await until(() => [A, B, C2, D2, E].every((n) => !texts(n, G).includes('rapat jam 9 di aula')), 8000, 'dilepas admin aktif');
  ok('mantan admin: sematan tetap, tidak bisa melepas atau menambah; pemalsuan (hapus, member, ts masa depan) ditolak; admin aktif bisa melepas');

  // ---- H. orang yang kublokir tidak mengubah sematanku ----
  C2.blockUser(A.id);
  const nBefore = texts(C2, G).length;
  const pidBlk = A.pinNote(G, 'dari A setelah diblokir C', true);
  await until(() => [B, D2, E].every((n) => texts(n, G).includes('dari A setelah diblokir C')), 8000, 'tersebar ke lain');
  await sleep(300);
  assert.strictEqual(texts(C2, G).length, nBefore, 'sematan baru dari orang yang diblokir tidak diterapkan');
  assert(pidBlk);
  ok('sematan baru dari orang yang kublokir diabaikan');

  // ---- I. keluar grup menghapus sematan grup itu (bersama dan pribadi) ----
  D2.leaveGroup(gid);
  assert.strictEqual(D2.store.pins[G], undefined); assert.strictEqual(D2.store.mypins[G], undefined);
  assert.deepStrictEqual(D2.pinList(G), { shared: [], mine: [], canShare: false });
  assert.throws(() => D2.pinNote(G, 'x', false), /Grup tidak dikenal/);
  ok('keluar dari grup menghapus sematannya');

  // ---- J. DM: kedua orang boleh menyematkan dan melepas; pribadi terpisah; pihak ketiga tidak melihat ----
  const d1 = A.sendText('nomor rekening 1234', B.id);
  await until(() => B.getState().messages.some((m) => m.id === d1.id), 8000, 'DM tiba');
  const pidD = A.pinAdd(B.id, d1.id, true);
  await until(() => B.pinList(A.id).shared.length === 1, 8000, 'DM sematan tiba');
  assert.strictEqual(B.pinList(A.id).shared[0].text, 'nomor rekening 1234'); assert.strictEqual(B.pinList(A.id).shared[0].by, A.id);
  assert(B.pinList(A.id).canShare && A.pinList(B.id).canShare);
  assert(B.getState().messages.every((m) => !String(m.text).includes('\u0001')), 'kontrol DM tidak tampil');
  B.pinAdd(A.id, d1.id, false);
  assert.deepStrictEqual(mine(B, A.id), ['nomor rekening 1234']); assert.deepStrictEqual(mine(A, B.id), []);
  assert.deepStrictEqual(texts(E, A.id), [], 'pihak ketiga tidak melihat sematan DM A-B');
  assert(!Object.values(E.store.msgs).some((m) => E._isPinCtl(m) && m.from === A.id && m.to === B.id), 'DM A-B tidak mampir ke E');
  const bNote = B.pinNote(A.id, 'jangan lupa transfer', true);
  await until(() => texts(A, B.id).includes('jangan lupa transfer'), 8000, 'B menyematkan untuk berdua');
  A.clearChat(B.id);
  assert.strictEqual(A.pinList(B.id).shared.length, 2, 'Bersihkan chat DM tidak menghapus sematan');
  B.pinRemove(A.id, pidD); // lawan bicara boleh melepas yang dipasang A
  await until(() => A.pinList(B.id).shared.length === 1, 8000, 'dilepas lawan bicara');
  assert.deepStrictEqual(texts(A, B.id), ['jangan lupa transfer']);
  // pemalsuan: by = pihak ketiga ditolak di DM
  const fk = B._send(Pins.encodeCtl([{ id: Pins.newId(E.id), by: E.id, kind: 'note', text: 'atas nama E', from: E.id, name: 'E', at: 1, mid: '', ts: Date.now(), v: 1, del: false }]), A.id);
  await waitCarrier(A, fk.id); await sleep(200);
  assert.deepStrictEqual(texts(A, B.id), ['jangan lupa transfer']);
  assert(bNote);
  ok('DM: kedua orang menyematkan dan melepas; sematan pribadi terpisah; pihak ketiga tidak melihat; atas nama orang lain ditolak');

  // ---- K. tab Publik: hanya pribadi, bertahan setelah Bersihkan chat ----
  const p1 = A.sendText('halo semua di publik', 'public');
  assert.throws(() => A.pinAdd('public', p1.id, true), /Publik/);
  assert.throws(() => A.pinNote('public', 'x', true), /Publik/);
  A.pinAdd('public', p1.id, false);
  A.clearChat('public');
  assert.deepStrictEqual(mine(A, 'public'), ['halo semua di publik']); assert.deepStrictEqual(A.pinList('public').shared, []);
  assert.strictEqual(A.pinList('public').canShare, false);
  assert.deepStrictEqual(mine(B, 'public'), []);
  ok('tab Publik: hanya sematan pribadi, bertahan setelah Bersihkan chat, tidak menyebar');

  // ---- L. berkas: hanya labelnya ----
  const f = path.join(tmp, 'laporan.txt'); fs.writeFileSync(f, 'isi rahasia berkas '.repeat(50));
  const fm = await A.sendFile(f, G);
  await until(() => B.getState().messages.some((m) => m.id === fm.id), 8000, 'tawaran berkas tiba');
  const pf = A.pinAdd(G, fm.id, true);
  const fv = A.pinList(G).shared.find((p) => p.id === pf);
  assert.strictEqual(fv.kind, 'file'); assert.strictEqual(fv.text, '📎 laporan.txt');
  assert(!JSON.stringify(A.store.pins[G]).includes('isi rahasia'));
  ok('berkas: yang disalin hanya labelnya');

  // ---- M. gagal kirim: perubahan lokal dibatalkan ----
  const snap = JSON.stringify(A.store.pins[G]);
  const origSend = A._send; A._send = () => { throw new Error('boom'); };
  assert.throws(() => A.pinNote(G, 'tidak terkirim', true), /boom/);
  assert.throws(() => A.pinRemove(G, pf), /boom/);
  A._send = origSend;
  assert.strictEqual(JSON.stringify(A.store.pins[G]), snap, 'tidak ada perubahan setengah jalan');
  ok('kirim gagal: perubahan lokal dibatalkan (tidak menyimpang dari anggota lain)');

  // ---- N. store rusak dibersihkan saat dimuat ----
  const Z = mk('Z'); await Z.start(); await Z.stop();
  const sf = path.join(tmp, 'Z', 'store.json'), js = JSON.parse(fs.readFileSync(sf, 'utf8'));
  js.pins = { public: { m: {}, r: {} }, zzz: { m: { a: 1 }, r: {} }, ['g:' + 'a'.repeat(16)]: { m: { x: 'rusak' }, r: { x: 'y' } } };
  js.mypins = 5; fs.writeFileSync(sf, JSON.stringify(js));
  const Z2 = reopen(Z, 'Z'); await Z2.start();
  assert.deepStrictEqual(Z2.store.pins, {}); assert.deepStrictEqual(Z2.store.mypins, {});
  ok('catatan sematan yang rusak dibuang saat memuat');

  for (const n of [A, B, C2, D2, E, Z2]) await n.stop();

  // ---- O. kurir DM: penerima offline, pembawa titipan, pengirim pun sudah offline ----
  const X = mk('X'), Y = mk('Y'), W = mk('W');
  await X.start(); await Y.start(); await W.start();
  await X.addPeer('127.0.0.1', Y.port); await X.addPeer('127.0.0.1', W.port); await Y.addPeer('127.0.0.1', W.port);
  await until(() => [X, Y, W].every((x) => x.getState().peers.filter((p) => p.online).length === 2), 6000, 'saling kenal');
  const wId = W.id, xId = X.id;
  await W.stop();
  X.pinNote(wId, 'sematan untuk W lewat kurir', true);
  await sleep(200);
  await Y._syncFrom(Y.peers.get(X.id));
  assert(Object.values(Y.store.custody).some((c) => c.m.to === wId), 'Y membawa titipan');
  assert.deepStrictEqual(Y.getState().messages, [], 'titipan tidak tampil di Y');
  assert(!/kurir/.test(JSON.stringify(Y.store.custody)), 'Y tidak bisa membaca isinya');
  await X.stop();
  const W2 = reopen(W, 'W'); await W2.start(); await W2.addPeer('127.0.0.1', Y.port);
  await until(() => texts(W2, xId).includes('sematan untuk W lewat kurir'), 10000, 'W menerima lewat Y');
  assert.deepStrictEqual(W2.getState().messages, [], 'tidak muncul sebagai pesan');
  ok('sematan DM sampai lewat kurir ke penerima yang offline, padahal pengirim dan penerima tidak pernah online bersamaan');
  await Y.stop(); await W2.stop();

  // ---- P. ujung ke ujung lewat anggota lain: pengirim sudah mati, chat ramai di pembawa, penerima hanya bertemu pembawa ----
  const P = mk('P'), Q = mk('Q'), R = mk('R');
  await P.start(); await Q.start(); await R.start();
  await P.addPeer('127.0.0.1', Q.port); await P.addPeer('127.0.0.1', R.port); await Q.addPeer('127.0.0.1', R.port);
  await until(() => [P, Q, R].every((x) => x.getState().peers.filter((p) => p.online).length === 2), 6000, 'P Q R kenal');
  const pgid = P.createGroup('Trio', [Q.id, R.id]).id, PG = 'g:' + pgid;
  await until(() => grp(Q, pgid) && grp(R, pgid), 8000, 'undangan trio');
  const rId = R.id; await R.stop();
  P.pinNote(PG, 'Pengumuman penting trio', true);
  await until(() => texts(Q, PG).length === 1, 8000, 'Q menerima');
  for (let i = 0; i < 520; i++) { const m = Q._makeMsg(PG, 'g1', 'ramai ' + i + ' ' + Math.random()); Q.store.msgs[m.id] = m; }
  await P.stop();
  const R2 = reopen(R, 'R'); await R2.start();
  assert.deepStrictEqual(texts(R2, PG), [], 'R belum tahu apa-apa');
  await R2.addPeer('127.0.0.1', Q.port);
  await until(() => texts(R2, PG).includes('Pengumuman penting trio'), 15000, 'R dapat lewat Q');
  assert(R2.getState().messages.filter((m) => m.to === PG).every((m) => String(m.text).startsWith('ramai')), 'hanya pesan ramai yang tampil');
  assert.strictEqual(rId, R2.id);
  ok('penerima offline mendapat sematan dari anggota lain saat pengirimnya sudah mati, di tengah obrolan ramai');
  await Q.stop(); await R2.stop();

  // ---- batas 10.000 karakter: "Baca selengkapnya" berisi utuh, juga untuk teks terburuk (CJK ~30 KB), lewat dorongan langsung dan lewat sync ----
  {
    const { MAX_TEXT } = require('../src/archne-core');
    assert.strictEqual(Pins.PIN_TEXT_MAX, MAX_TEXT, 'batas salinan sematan = batas pesan, supaya isi tidak terpotong');
    const X = mk('X'), Y = mk('Y'), Z = mk('Z');
    for (const n of [X, Y, Z]) await n.start();
    await lan(X, Y, Z); await lan(Y, Z);
    await until(() => [X, Y, Z].every((n) => n.getState().peers.filter((p) => p.online).length === 2), 8000, 'mesh XYZ');
    const lgid = X.createGroup('Panjang', [Y.id, Z.id]).id, LG = 'g:' + lgid;
    await until(() => grp(Y, lgid) && grp(Z, lgid), 8000, 'undangan XYZ');
    const zid = Z.id; await Z.stop(); // Z offline selama sematan dibuat: nanti menyusul lewat sync
    const cjk = '漢'.repeat(MAX_TEXT), emo = '😀'.repeat(MAX_TEXT / 2), lat = ('baris panjang \\"kutip\\"\n').repeat(400).slice(0, MAX_TEXT);
    const mc = X.sendText(cjk, LG), me = X.sendText(emo, LG), ml = X.sendText(lat, LG);
    await until(() => [mc, me, ml].every((m) => Y.getState().messages.some((x) => x.id === m.id)), 15000, 'pesan panjang tiba di Y');
    const pc = X.pinAdd(LG, mc.id, true), pe = X.pinAdd(LG, me.id, true), pl = X.pinAdd(LG, ml.id, true);
    await until(() => Y.pinList(LG).shared.length === 3, 15000, 'tiga sematan panjang tiba di Y');
    const full = (n, pid) => n.pinList(LG).shared.find((p) => p.id === pid).text;
    const expectLat = Pins.cleanText(lat);
    assert.strictEqual(full(X, pc), cjk); assert.strictEqual(full(Y, pc), cjk, 'CJK 10.000 karakter utuh, tanpa …');
    assert.strictEqual(full(Y, pe), emo, 'emoji 10.000 unit utuh'); assert.strictEqual(full(Y, pl), expectLat, 'baris baru dan kutip utuh');
    for (const n of [X, Y]) for (const m of hiddenCtl(n)) assert(m.text.length <= 48000, 'pesan kontrol di bawah batas ciphertext Core');
    // pembatalan pesan asli tidak mengubah salinan penuh
    X.clearChat && X.clearChat(LG);
    assert.strictEqual(full(X, pc), cjk, 'salinan penuh selamat dari Bersihkan chat');
    // Z offline lalu menyusul lewat sync dari Y (X sudah mati)
    await X.stop();
    const Z2 = reopen(Z, 'Z'); await Z2.start();
    assert.strictEqual(Z2.pinList(LG).shared.length, 0);
    await Z2.addPeer('127.0.0.1', Y.port);
    await until(() => Z2.pinList(LG).shared.length === 3, 20000, 'Z menyusul lewat Y');
    assert.strictEqual(zid, Z2.id);
    assert.strictEqual(full(Z2, pc), cjk, 'lewat sync: CJK utuh'); assert.strictEqual(full(Z2, pe), emo); assert.strictEqual(full(Z2, pl), expectLat);
    ok('sematan 10.000 karakter (CJK, emoji, baris baru) utuh di anggota lain, lewat dorongan langsung dan lewat sync; batas = MAX_TEXT');
    await Y.stop(); await Z2.stop();
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(pass + ' tes lolos');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

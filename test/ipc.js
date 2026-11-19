'use strict';
// Tes jembatan IPC (v0.7.0 tahap 5a): src/archne-ipc.js dengan Electron palsu (ipcMain/shell/dialog), dua Core sungguhan.
// Juga tes bidang baru di getState (file.mine/pushed/pushing/held, downloadDir) dan Core.discardIncoming.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register, isRisky } = require('../src/archne-ipc');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-ipc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150, escBackoff: 0.02 }, o));
const f = (n) => path.join(tmp, n);
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
const online = (c, n) => c.getState().peers.filter((p) => p.online).length >= n;

// Electron palsu: satu "jendela" per Core
function fake(core, extra) {
  const handlers = {}, sent = [], shellCalls = [];
  const ipcMain = { handle: (n, fn) => { handlers[n] = fn; } };
  const shell = { showItemInFolder: (p) => shellCalls.push(['show', p]), openPath: async (p) => { shellCalls.push(['open', p]); return ''; } };
  const api = register(Object.assign({ ipcMain, core, shell, send: (ch, p) => sent.push([ch, p]), log: () => {}, pickFiles: async () => [f('pick1.txt'), 42, f('pick2.txt')] }, extra));
  const call = (n, ...a) => handlers[n]({}, ...a);
  return { handlers, sent, shellCalls, call, api, st: () => call('state') };
}

(async () => {
  // ---- 1. daftar ekstensi berisiko ----
  for (const n of ['a.exe', 'B.BAT', 'x.ps1', 'x.JS', 'x.lnk', 'x.dll', 'x.tar.exe']) assert(isRisky(n), n);
  for (const n of ['a.txt', 'foto.jpg', 'laporan.pdf', 'x.docx', 'exe', 'x.exe.txt', '']) assert(!isRisky(n), n);
  ok('ekstensi yang bisa dieksekusi dikenali (tanpa mengira huruf besar/kecil), berkas biasa tidak');

  const A = mk('A'), B = mk('B');
  await A.start(); await B.start();
  await A.addPeer('127.0.0.1', B.port);
  await until(() => online(A, 1) && online(B, 1) && A.peers.get(B.id).xpub && B.peers.get(A.id).xpub, 6000, 'A-B online');
  const ea = fake(A), eb = fake(B);

  // ---- 2. state: sending kosong, downloadDir, handler lama tetap jalan ----
  {
    const s = await ea.st();
    assert.deepStrictEqual(s.sending, []);
    assert.strictEqual(s.downloadDir, path.join(tmp, 'A-dl'));
    assert(s.me.id === A.id && Array.isArray(s.messages) && s.limits.maxFile.public);
    assert.strictEqual(await ea.call('send', 'halo dari A', 'public'), true);
    assert.strictEqual(typeof (await ea.call('send', 'x'.repeat(10001), 'public')), 'string');
    const g = await ea.call('createGroup', 'tes', [B.id]); assert(g.ok && g.id);
    const bad = await ea.call('clearChat', 'bukan-chat'); assert(bad.ok === false && /Unknown chat/.test(bad.err), 'galat Core diteruskan apa adanya');
    assert.deepStrictEqual(await ea.call('clearChat', 'public'), { ok: true });
    assert.strictEqual((await ea.call('deleteMessage', 'tidak-ada')).ok, false);
    ok('state membawa sending + downloadDir; kirim teks, grup, bersihkan, batalkan tetap seperti sebelumnya (galat Core diteruskan)');
  }

  // ---- 3. pickFiles menyaring yang bukan string ----
  assert.deepStrictEqual(await ea.call('pickFiles'), [f('pick1.txt'), f('pick2.txt')]);
  assert.deepStrictEqual(await fake(A, { pickFiles: undefined }).call('pickFiles'), []);
  assert.deepStrictEqual(await fake(A, { pickFiles: async () => { throw new Error('x'); } }).call('pickFiles'), []);
  ok('pickFiles: hanya string yang lolos; tanpa dialog atau dialog error -> daftar kosong');

  // ---- 4. sendFile: masukan tidak sah ditolak tanpa meninggalkan pekerjaan ----
  {
    fs.writeFileSync(f('a.txt'), 'isi A\n'.repeat(100));
    fs.mkdirSync(f('dir'), { recursive: true });
    const bad = [['', f('a.txt'), 'public'], ['j 1', f('a.txt'), 'public'], ['j1', 'a.txt', 'public'], ['j1', f('dir'), 'public'], ['j1', f('tidak-ada.txt'), 'public'], ['j1', f('a.txt'), ''], [5, f('a.txt'), 'public'], ['j1', null, 'public']];
    for (const a of bad) { const r = await ea.call('sendFile', ...a); assert.strictEqual(r.ok, false, JSON.stringify(a)); }
    const r = await ea.call('sendFile', 'j1', f('a.txt'), 'bukan-tujuan'); assert.strictEqual(r.ok, false);
    assert.deepStrictEqual((await ea.st()).sending.filter((j) => j.phase === 'pack'), []);
    ok('sendFile: job/path/tujuan tidak sah, folder, berkas hilang ditolak');
    assert.deepStrictEqual((await ea.st()).sending.map((j) => j.job), ['j1'], 'tujuan tak dikenal tercatat gagal');
    assert.strictEqual(await ea.call('dismissSend', 'j1'), true);
    assert.deepStrictEqual((await ea.st()).sending, []);
    assert.strictEqual(await ea.call('dismissSend', 'j1'), false);
    ok('pekerjaan gagal tampil di state sampai ditutup (dismissSend); yang tidak ada -> false');
  }

  // ---- 5. sendFile sukses (publik): hasil id, pekerjaan hilang, update + progres terkirim, B menerima tawaran ----
  let pubId;
  {
    const before = ea.sent.length;
    const r = await ea.call('sendFile', 'j2', f('a.txt'), 'public');
    assert(r.ok && /^[0-9a-f]{32}$/.test(r.id), JSON.stringify(r));
    pubId = r.id;
    assert.deepStrictEqual((await ea.st()).sending, []);
    const evs = ea.sent.slice(before);
    assert(evs.some(([c]) => c === 'update'), 'renderer diberi tahu');
    assert(evs.filter(([c, p]) => c === 'fprog' && p.job === 'j2').every(([, p]) => p.phase === 'pack' && p.done <= p.total));
    const mine = (await ea.st()).messages.find((m) => m.id === pubId);
    assert(mine.file && mine.file.mine === true && !mine.file.pushed && !mine.file.pushing, JSON.stringify(mine.file));
    await until(() => B.store.msgs[pubId], 4000, 'B menerima tawaran');
    const theirs = (await eb.st()).messages.find((m) => m.id === pubId);
    assert(theirs.file && theirs.file.name === 'a.txt' && !theirs.file.mine && !theirs.file.saved && !theirs.file.rx && !theirs.file.held);
    ok('sendFile publik: id dikembalikan, pekerjaan selesai dibersihkan, renderer diberi tahu, bidang file.mine di pengirim');
  }

  // ---- 6. batas ukuran: berkas 51 MB ke publik ditolak sebelum ada yang ditulis ----
  {
    const fd = fs.openSync(f('besar.bin'), 'w'); fs.ftruncateSync(fd, 51 * 1048576); fs.closeSync(fd);
    const r = await ea.call('sendFile', 'j3', f('besar.bin'), 'public');
    assert(!r.ok && r.code === 'limit', JSON.stringify(r));
    const j = (await ea.st()).sending.find((x) => x.job === 'j3');
    assert(j && j.phase === 'error' && j.code === 'limit' && /besar/.test(j.err));
    assert.deepStrictEqual(ls(path.join(A.opts.dataDir, 'out')).filter((n) => !n.endsWith('.br')), []);
    await ea.call('dismissSend', 'j3');
    ok('berkas melebihi batas: gagal dengan kode limit dan tampil di state; tidak ada sisa di out/');
  }

  // ---- 7. cancelSend menghentikan kompresi; tidak ada sisa ----
  {
    fs.writeFileSync(f('hex.txt'), crypto.randomBytes(16 * 1048576).toString('hex')); // 32 MB, kompres lambat
    const outBefore = ls(path.join(A.opts.dataDir, 'out')), msgsBefore = Object.keys(A.store.msgs).length;
    const p = ea.call('sendFile', 'j4', f('hex.txt'), 'public');
    await until(async () => (await ea.st()).sending.some((x) => x.job === 'j4' && x.phase === 'pack'), 3000, 'pekerjaan tampil');
    assert.strictEqual(await ea.call('cancelSend', 'j4'), true);
    const r = await p;
    assert(!r.ok && r.code === 'abort', JSON.stringify(r));
    assert.deepStrictEqual((await ea.st()).sending, []);
    assert.strictEqual(await ea.call('cancelSend', 'j4'), false);
    assert.deepStrictEqual(ls(path.join(A.opts.dataDir, 'out')), outBefore, 'out/ tidak bertambah');
    assert.strictEqual(Object.keys(A.store.msgs).length, msgsBefore, 'tidak ada tawaran terkirim');
    ok('cancelSend: kompresi dihentikan (abort), pekerjaan hilang dari state, tidak ada pesan atau berkas setengah jadi');
  }

  // ---- 8. pekerjaan dengan id sama ditolak; dispose menghentikan yang berjalan ----
  {
    const p1 = ea.call('sendFile', 'j5', f('hex.txt'), 'public');
    await until(async () => (await ea.st()).sending.some((x) => x.job === 'j5'), 3000, 'j5 tampil');
    const dup = await ea.call('sendFile', 'j5', f('a.txt'), 'public');
    assert(!dup.ok && /sudah ada/.test(dup.err));
    ea.api.dispose();
    const r = await p1; assert(!r.ok && r.code === 'abort');
    assert.deepStrictEqual((await ea.st()).sending, []);
    ok('id pekerjaan kembar ditolak; dispose() (aplikasi ditutup) menghentikan kompresi yang berjalan');
  }

  // ---- 9. terima lewat IPC: segera kembali, hasil di state, openFile/showFile hanya lewat id ----
  {
    assert(!(await eb.call('receiveFile', 'zzzz')).ok);
    assert(!(await eb.call('receiveFile', '0'.repeat(32))).ok);
    const r = await eb.call('receiveFile', pubId);
    assert.deepStrictEqual(r, { ok: true });
    await until(async () => { const m = (await eb.st()).messages.find((x) => x.id === pubId); return m && m.file.saved; }, 6000, 'berkas tersimpan');
    const m = (await eb.st()).messages.find((x) => x.id === pubId);
    assert(fs.readFileSync(m.file.saved.path, 'utf8') === 'isi A\n'.repeat(100) && m.file.saved.path.startsWith(path.join(tmp, 'B-dl')));
    assert(!m.file.rx && !m.file.held);
    assert.deepStrictEqual(await eb.call('receiveFile', pubId), { ok: true }, 'sudah tersimpan: tetap ok (cached)');
    assert.deepStrictEqual(await eb.call('openFile', pubId), { ok: true });
    assert.deepStrictEqual(await eb.call('showFile', pubId), { ok: true });
    assert.deepStrictEqual(eb.shellCalls, [['open', m.file.saved.path], ['show', m.file.saved.path]]);
    assert(eb.sent.some(([c, p]) => c === 'fprog' && p.id === pubId && p.phase === 'done'), 'progres akhir (done) terkirim');
    // path dari renderer tidak dipercaya
    for (const evil of [m.file.saved.path, f('a.txt'), '../x', '..', '']) {
      assert(!(await eb.call('openFile', evil)).ok); assert(!(await eb.call('showFile', evil)).ok);
    }
    assert.strictEqual(eb.shellCalls.length, 2, 'shell tidak dipanggil untuk path dari renderer');
    // berkas dihapus pengguna -> pesan jelas, bukan crash
    fs.rmSync(m.file.saved.path);
    const gone = await eb.call('openFile', pubId); assert(!gone.ok && /not found/.test(gone.err));
    ok('receiveFile via IPC: kembali segera, berkas tersimpan utuh, open/show hanya lewat id; path dari renderer ditolak; berkas dihapus -> pesan jelas');
  }

  // ---- 10. berkas berekstensi berbahaya: tidak dibuka, hanya ditampilkan di folder ----
  {
    fs.writeFileSync(f('alat.exe'), 'bukan exe sungguhan\n'.repeat(50));
    const r = await ea.call('sendFile', 'j6', f('alat.exe'), 'public'); assert(r.ok);
    await until(() => B.store.msgs[r.id], 4000, 'B menerima tawaran exe');
    assert((await eb.call('receiveFile', r.id)).ok);
    await until(() => B.store.got[r.id], 6000, 'exe tersimpan');
    eb.shellCalls.length = 0;
    const o = await eb.call('openFile', r.id);
    assert(!o.ok && o.risky === true && eb.shellCalls.length === 0);
    assert.deepStrictEqual(await eb.call('showFile', r.id), { ok: true });
    assert.deepStrictEqual(eb.shellCalls, [['show', B.store.got[r.id].path]]);
    ok('.exe: openFile ditolak (risky), shell tidak dipanggil; showFile tetap bisa');
  }

  // ---- 11. discardIncoming: buang sisa unduhan, tawaran tetap ada; bukan milik sendiri -> false ----
  {
    const r = await ea.call('sendFile', 'j7', f('a.txt'), 'public'); assert(r.ok);
    await until(() => B.store.msgs[r.id], 4000, 'B menerima tawaran');
    const inDir = path.join(B.opts.dataDir, 'in'); fs.mkdirSync(inDir, { recursive: true });
    for (const ext of ['.part', '.pk']) fs.writeFileSync(path.join(inDir, r.id + ext), 'sisa');
    fs.writeFileSync(path.join(inDir, 'lain.part'), 'bukan milik tawaran ini');
    B._prog[r.id] = { phase: 'error', done: 0, total: 1, code: 'net', err: 'x' };
    assert((await eb.st()).messages.find((m) => m.id === r.id).file.rx.code === 'net');
    assert.deepStrictEqual(await eb.call('discardIncoming', r.id), { ok: true });
    assert.deepStrictEqual(ls(inDir).filter((n) => n.startsWith(r.id)), []);
    assert(ls(inDir).includes('lain.part'), 'berkas lain tidak disentuh');
    const m = (await eb.st()).messages.find((x) => x.id === r.id);
    assert(m && m.file && !m.file.rx, 'tawaran tetap ada, keadaan galat hilang');
    assert.deepStrictEqual(await ea.call('discardIncoming', r.id), { ok: false }, 'tawaran milik sendiri bukan unduhan');
    assert.deepStrictEqual(await eb.call('discardIncoming', '1'.repeat(32)), { ok: false });
    assert.deepStrictEqual(await eb.call('discardIncoming', 'x'), { ok: false });
    assert.strictEqual(await eb.call('cancelReceive', r.id), false, 'tidak ada penerimaan berjalan');
    ok('discardIncoming: .part/.pk tawaran itu dibuang, berkas lain dan tawaran tidak disentuh; id asing/milik sendiri -> false');
  }

  // ---- 12. progres dibatasi (banjir event 'file' tidak membanjiri renderer), fase akhir selalu lewat ----
  {
    const id = 'a'.repeat(32), before = eb.sent.length;
    for (let i = 0; i < 300; i++) B.emit('file', { id, phase: 'download', done: i, total: 300 });
    B.emit('file', { id, phase: 'done', done: 300, total: 300 });
    const ev = eb.sent.slice(before).filter(([c, p]) => c === 'fprog' && p.id === id);
    assert(ev.length <= 3 && ev.length >= 2, 'event: ' + ev.length);
    assert(ev[ev.length - 1][1].phase === 'done');
    ok('progres ke renderer dibatasi (300 event -> ' + (ev.length - 1) + ' + fase akhir); fase done selalu terkirim');
  }

  await Promise.all([A, B].map((c) => c.stop()));

  // ---- 13. status kurir di getState: pengirim (file.pushed) dan penerima (file.held), hilang setelah tersimpan ----
  {
    fs.writeFileSync(f('rand.bin'), crypto.randomBytes(400000));
    const A2 = mk('A2'), K = mk('K2'), C = mk('C2');
    for (const c of [A2, K, C]) await c.start();
    for (const c of [K, C]) await A2.addPeer('127.0.0.1', c.port);
    await until(() => online(A2, 2) && A2.peers.get(C.id).xpub, 6000, 'A2 kenal semua');
    await C.stop();
    const m = await A2.sendFile(f('rand.bin'), C.id);
    const mineNow = A2.getState().messages.find((x) => x.id === m.id);
    assert(mineNow.file.mine === true);
    await until(() => K.store.esc[m.id] && K.store.esc[m.id].done, 20000, 'kurir memegang berkas');
    await until(() => (A2.getState().messages.find((x) => x.id === m.id).file.pushed || 0) === 1, 4000, 'file.pushed = 1');
    assert(!A2.getState().messages.find((x) => x.id === m.id).file.pushing);
    // 'pushing': ada dorongan berjalan
    A2._pushes.set(m.id + ':zz', { ac: new AbortController() });
    assert(A2.getState().messages.find((x) => x.id === m.id).file.pushing === true);
    A2._pushes.delete(m.id + ':zz');
    await A2.stop();
    const C2 = mk('C2'), ec = fake(C2);
    await C2.start(); await C2.addPeer('127.0.0.1', K.port);
    await until(() => C2._holdersOf(m.id).length === 1, 8000, 'kurir mengumumkan');
    const seen = (await ec.st()).messages.find((x) => x.id === m.id);
    assert.strictEqual(seen.file.held, 1);
    assert((await ec.call('receiveFile', m.id)).ok);
    await until(() => C2.store.got[m.id], 10000, 'diambil dari kurir');
    const after = (await ec.st()).messages.find((x) => x.id === m.id);
    assert(after.file.saved && after.file.held === undefined && !after.file.rx);
    ok('getState: file.pushed/pushing di pengirim, file.held di penerima (dari pengumuman kurir), hilang setelah tersimpan');
    await Promise.all([K, C2].map((c) => c.stop()));
  }

  // ---- v0.7.4: profil (foto), teman dua arah lewat IPC ----
  {
    const X = mk('PX'), Y = mk('PY'), ex = fake(X), ey = fake(Y);
    await X.start(); await Y.start();
    await X.addPeer('127.0.0.1', Y.port);
    await until(() => online(X, 1) && online(Y, 1) && X.peers.get(Y.id).xpub && Y.peers.get(X.id).xpub, 6000, 'X-Y online');
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x40, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), sof, Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), crypto.randomBytes(300), Buffer.from([0xff, 0xd9])]).toString('base64');
    let r = await ex.call('setAvatar', jpg);
    assert.deepStrictEqual(r, { ok: true, has: true });
    assert((await ex.st()).avatars[X.id].startsWith('data:image/jpeg;base64,'), 'state membawa foto');
    r = await ex.call('setAvatar', 'bukan-gambar'); assert(r.ok === false && /Invalid photo/.test(r.err), 'galat Core diteruskan');
    r = await ex.call('setAvatar', { x: 1 }); assert(r.ok === false, 'bukan string ditolak');
    await until(() => Y.avatarOf(X.id) === jpg, 6000, 'foto sampai ke Y');
    assert.deepStrictEqual(await ex.call('setAvatar', ''), { ok: true, has: false });
    assert.deepStrictEqual((await ex.st()).avatars, {});
    r = await ex.call('addFriend', Y.id); assert.deepStrictEqual(r, { ok: true, st: 'out' });
    await until(() => Y.fstate(X.id) === 'in', 6000, 'permintaan sampai');
    assert.strictEqual((await ey.st()).peers.find((p) => p.id === X.id).fst, 'in');
    r = await ey.call('addFriend', X.id); assert.deepStrictEqual(r, { ok: true, st: 'ok' });
    await until(() => X.fstate(Y.id) === 'ok', 6000, 'persetujuan sampai');
    assert.strictEqual((await ex.st()).peers.find((p) => p.id === Y.id).friend, true);
    assert.deepStrictEqual(await ex.call('removeFriend', Y.id), { ok: true });
    assert.strictEqual((await ex.call('addFriend', 'bukan-id')).ok, false);
    await Promise.all([X, Y].map((c) => c.stop()));
    ok('IPC: setAvatar (sah, galat diteruskan, bukan string ditolak, hapus), addFriend mengembalikan keadaan (out/ok), removeFriend, state membawa avatars dan fst');
  }

  // ---- v0.8.0: admin/ganti nama/bubarkan grup dan blokir lewat IPC ----
  {
    const X = mk('GX'), Y = mk('GY'), Z = mk('GZ'), ex = fake(X), ey = fake(Y), ez = fake(Z);
    for (const c of [X, Y, Z]) await c.start();
    await X.addPeer('127.0.0.1', Y.port); await X.addPeer('127.0.0.1', Z.port); await Y.addPeer('127.0.0.1', Z.port);
    await until(() => [X, Y, Z].every((c) => online(c, 2)) && X.peers.get(Y.id).xpub && X.peers.get(Z.id).xpub, 8000, 'mesh XYZ');
    let r = await ex.call('createGroup', 'Awal', [Y.id, Z.id]); assert(r.ok && r.id);
    const gid = r.id;
    await until(() => Y.store.groups[gid] && Z.store.groups[gid], 8000, 'undangan');
    // wewenang diteruskan dari Core sebagai galat (bukan exception)
    r = await ey.call('setGroupAdmin', gid, Z.id, true); assert(r.ok === false && /group creator/.test(r.err));
    r = await ey.call('disbandGroup', gid); assert(r.ok === false && /group creator/.test(r.err));
    r = await ey.call('renameGroup', gid, 'Retas'); assert(r.ok === false && /creator and admins/.test(r.err));
    assert.deepStrictEqual(await ex.call('setGroupAdmin', gid, Y.id, true), { ok: true });
    await until(() => Y.store.groups[gid].admins.includes(Y.id), 8000, 'Y admin');
    assert.deepStrictEqual((await ey.st()).groups[0].admins, [Y.id], 'state membawa admins');
    assert.deepStrictEqual(await ey.call('renameGroup', gid, 'Nama Admin'), { ok: true });
    await until(() => X.store.groups[gid].name === 'Nama Admin' && Z.store.groups[gid].name === 'Nama Admin', 8000, 'nama');
    r = await ey.call('removeMember', gid, X.id); assert(r.ok === false && /creator cannot be removed/.test(r.err));
    r = await ex.call('renameGroup', gid, '   '); assert(r.ok === false && /empty/.test(r.err));
    assert.deepStrictEqual(await ex.call('disbandGroup', gid), { ok: true });
    await until(() => !Y.store.groups[gid] && !Z.store.groups[gid], 8000, 'bubar');
    assert.deepStrictEqual((await ex.st()).groups, []);
    r = await ex.call('disbandGroup', gid); assert(r.ok === false && /Unknown group/.test(r.err));
    ok('IPC grup: renameGroup/setGroupAdmin/disbandGroup mengembalikan {ok} atau galat Core (wewenang), state membawa admins, grup bubar di semua anggota');

    // v0.9.0: pindah pemilik dan keluar dari grup lewat IPC
    r = await ex.call('createGroup', 'Serah', [Y.id, Z.id]); assert(r.ok && r.id);
    const gid2 = r.id;
    await until(() => Y.store.groups[gid2] && Z.store.groups[gid2], 8000, 'undangan 2');
    r = await ey.call('transferOwner', gid2, Z.id); assert(r.ok === false && /group creator/.test(r.err));
    r = await ex.call('transferOwner', gid2, 'f'.repeat(16)); assert(r.ok === false && /Not a member/.test(r.err));
    r = await ex.call('leaveGroup', gid2, 'f'.repeat(16)); assert(r.ok === false && /must be a member/.test(r.err));
    assert.deepStrictEqual(await ex.call('transferOwner', gid2, Y.id), { ok: true });
    await until(() => [X, Y, Z].every((c) => c.store.groups[gid2].creator === Y.id), 8000, 'Y pemilik');
    assert.strictEqual((await ey.st()).groups.find((g) => g.id === gid2).creator, Y.id, 'state membawa pemilik baru');
    r = await ex.call('leaveGroup', gid2); assert.deepStrictEqual(r, { ok: true, notified: 2 });
    r = await ex.call('leaveGroup', gid2); assert(r.ok === false && /Unknown group/.test(r.err));
    assert.deepStrictEqual((await ex.st()).groups, [], 'grup hilang di X');
    await until(() => Y.store.groups[gid2].members.length === 2 && Z.store.groups[gid2].members.length === 2, 10000, 'X dikeluarkan dari daftar');
    assert.deepStrictEqual(await ez.call('leaveGroup', gid2, ''), { ok: true, notified: 1 }, 'penerima kosong = otomatis (tidak dipakai anggota biasa)');
    await until(() => Y.store.groups[gid2].members.length === 1, 10000, 'Z dikeluarkan dari daftar');
    ok('IPC: transferOwner dan leaveGroup mengembalikan {ok} atau galat Core; state membawa pemilik baru; anggota yang keluar dikeluarkan dari daftar oleh pemilik');

    assert.deepStrictEqual(await ex.call('blockUser', Z.id), { ok: true });
    let st = await ex.st();
    assert(st.blocked.length === 1 && st.blocked[0].id === Z.id && !st.peers.some((p) => p.id === Z.id), 'state: blocked + peer hilang');
    r = await ex.call('send', 'halo', Z.id); assert(/blocked this person/.test(r), String(r));
    r = await ex.call('addFriend', Z.id); assert(r.ok === false && /blocked/.test(r.err));
    assert((await ex.call('blockUser', 'bukan-id')).ok === false);
    assert.deepStrictEqual(await ex.call('unblockUser', Z.id), { ok: true });
    assert.deepStrictEqual(await ex.call('unblockUser', Z.id), { ok: false });
    st = await ex.st(); assert(st.blocked.length === 0 && st.peers.some((p) => p.id === Z.id));
    assert.strictEqual(await ex.call('send', 'halo lagi', Z.id), true);
    await Promise.all([X, Y, Z].map((c) => c.stop()));
    ok('IPC blokir: blockUser/unblockUser, state membawa blocked dan menyembunyikan peer, kirim dan tambah teman ke yang diblokir ditolak dengan pesan jelas, galat id diteruskan');
  }

  console.log(`\n${pass} tes IPC OK`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

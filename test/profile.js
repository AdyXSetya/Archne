'use strict';
// Tes profil (v0.7.3): deskripsi (bio) bertanda tangan yang tersinkron ke semua akun (juga lewat peer perantara), bawaan "Hallo...",
// pemalsuan ditolak, dan daftar teman (lokal).
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-profile-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 }, o));
const online = (c, n) => c.getState().peers.filter((p) => p.online).length >= n;
const connect = async (a, ...others) => {
  for (const o of others) await a.addPeer('127.0.0.1', o.port);
  await until(() => online(a, others.length) && others.every((o) => o.peers.get(a.id) && o.peers.get(a.id).xpub), 6000, 'saling kenal');
};
const sign = (core, id, ts, bio) => crypto.sign(null, Buffer.from('archne-prof1:' + id + ':' + ts + ':' + bio), core.privKey).toString('base64');
const prof = (core, bio, ts) => ({ id: core.id, pub: core.pub, bio, ts, sig: sign(core, core.id, ts, bio) });

(async () => {
  // ---- 1. bawaan "Hallo...", pembersihan, dan bertahan setelah restart ----
  {
    const A = mk('pA');
    await A.start();
    assert.strictEqual(A.bioOf(A.id), 'Hallo...');
    assert.strictEqual(A.getState().me.bio, 'Hallo...');
    assert.strictEqual(A.getState().bios[A.id], 'Hallo...');
    assert.strictEqual(A.getState().limits.maxBio, 140);
    assert.deepStrictEqual(Object.keys(A.store.profiles), [], 'tanpa pengaturan: tidak ada yang disimpan atau disinkronkan');
    ok('tanpa pengaturan deskripsi bawaannya "Hallo..." dan tidak ada catatan profil');

    assert.strictEqual(A.setBio('  baris satu\nbaris dua\t\u0007\u202etiga  '), 'baris satu baris dua tiga', 'baris baru jadi spasi; kontrol dan pembalik arah dibuang; dipangkas');
    assert.strictEqual(A.setBio('😀'.repeat(200)).length, 280, '140 karakter (emoji = 2 unit)');
    assert.strictEqual(Array.from(A.bioOf(A.id)).length, 140);
    A.setBio('Hidup itu indah');
    const ts1 = A.store.profiles[A.id].ts;
    A.setBio('Hidup itu indah');
    assert.strictEqual(A.store.profiles[A.id].ts, ts1, 'isi sama: tidak membuat versi baru');
    await A.stop();
    const A2 = mk('pA'); await A2.start();
    assert.strictEqual(A2.bioOf(A2.id), 'Hidup itu indah', 'bertahan setelah restart');
    A2.setBio('   ');
    assert.strictEqual(A2.bioOf(A2.id), 'Hallo...', 'kosong = kembali ke bawaan');
    assert(A2.store.profiles[A2.id].ts > ts1, 'dikosongkan = versi baru yang bertanda tangan (menimpa yang lama di peer lain)');
    await A2.stop();
    ok('deskripsi dibersihkan (baris baru, kontrol, bidi), dibatasi 140 karakter, bertahan setelah restart; kosong = bawaan');
  }

  // ---- 2. sinkron: langsung, versi terbaru menang, dan lewat peer perantara (A - B - C, A dan C tidak saling terhubung) ----
  {
    const A = mk('sA'), B = mk('sB'), C = mk('sC');
    await A.start(); await B.start(); await C.start();
    await connect(A, B); await connect(C, B);
    assert(!C.peers.get(A.id) || !C.isOnline(C.peers.get(A.id)), 'C tidak terhubung langsung ke A');
    A.setBio('Kata mutiara dari A');
    await until(() => B.bioOf(A.id) === 'Kata mutiara dari A', 6000, 'B menerima profil A');
    ok('deskripsi tersinkron ke peer yang terhubung langsung');
    await until(() => C.bioOf(A.id) === 'Kata mutiara dari A', 6000, 'C menerima profil A lewat B');
    assert.strictEqual(C.store.profiles[A.id].pub, A.pub);
    assert.strictEqual(C.bioOf(B.id), 'Hallo...', 'yang belum mengatur tetap "Hallo..."');
    ok('deskripsi sampai ke akun yang tidak terhubung langsung (diteruskan lewat peer lain, tetap bertanda tangan pemiliknya)');
    let upd = 0; B.on('update', () => upd++);
    A.setBio('Versi dua');
    await until(() => B.bioOf(A.id) === 'Versi dua' && C.bioOf(A.id) === 'Versi dua', 6000, 'versi baru sampai');
    assert(upd > 0, 'UI diberi tahu saat profil berubah');
    ok('versi terbaru menang di semua akun dan UI diberi tahu');

    // ---- 3. pemalsuan ditolak ----
    const ts = C.store.profiles[A.id].ts;
    assert.strictEqual(C._addProfile(prof(A, 'Versi lama', ts - 1000)), false, 'versi lebih lama diabaikan (replay)');
    assert.strictEqual(C._addProfile(prof(A, 'Sama', ts)), false, 'ts sama tidak menimpa');
    assert.strictEqual(C._addProfile(Object.assign(prof(A, 'Palsu', ts + 5), { bio: 'Diubah di jalan' })), false, 'isi diubah setelah ditandatangani');
    assert.strictEqual(C._addProfile({ id: A.id, pub: A.pub, bio: 'Dari B', ts: ts + 5, sig: sign(B, A.id, ts + 5, 'Dari B') }), false, 'ditandatangani orang lain atas nama A');
    assert.strictEqual(C._addProfile({ id: A.id, pub: B.pub, bio: 'Kunci B', ts: ts + 5, sig: sign(B, A.id, ts + 5, 'Kunci B') }), false, 'kunci tidak cocok dengan id');
    assert.strictEqual(C._addProfile(prof(A, 'Dari masa depan', Date.now() + 3600e3)), false, 'ts jauh di depan ditolak (tidak bisa mengunci profil)');
    assert.strictEqual(C._addProfile(prof(A, 'x'.repeat(141), ts + 5)), false, 'terlalu panjang');
    assert.strictEqual(C._addProfile(prof(A, 'ab\ncd', ts + 5)), false, 'karakter kontrol');
    assert.strictEqual(C._addProfile(prof(A, 'ab\u202ecd', ts + 5)), false, 'pembalik arah teks');
    assert.strictEqual(C._addProfile(null) || C._addProfile({}) || C._addProfile({ id: 'zz' }) || C._addProfile(prof(A, 123, ts + 5)), false, 'bentuk tidak sah');
    assert.strictEqual(C.bioOf(A.id), 'Versi dua', 'tidak ada yang berubah');
    assert.strictEqual(C._addProfile(prof(A, 'Sah dan lebih baru', ts + 5)), true);
    assert.strictEqual(C.bioOf(A.id), 'Sah dan lebih baru');
    ok('pemalsuan ditolak: replay lama, isi diubah, tanda tangan/kunci orang lain, ts masa depan, terlalu panjang, karakter kontrol/bidi');
    await Promise.all([A, B, C].map((c) => c.stop()));
  }

  // ---- 4. foto profil: JPEG kecil bertanda tangan, tersinkron (juga lewat peer perantara), pemalsuan ditolak ----
  // JPEG minimal yang sah secara struktur: SOI, SOF0 (w x h), SOS, data, EOI. Bukan gambar yang tampil bagus, cukup untuk uji validasi.
  const jpeg = (w, h, pad = 300) => {
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00]);
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), sof, Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), crypto.randomBytes(pad), Buffer.from([0xff, 0xd9])]).toString('base64');
  };
  const sign2 = (core, ts, bio, av) => crypto.sign(null, Buffer.from('archne-prof2:' + JSON.stringify([core.id, ts, bio, av ? crypto.createHash('sha256').update(av).digest('hex') : ''])), core.privKey).toString('base64');
  const prof2 = (core, bio, av, ts) => ({ id: core.id, pub: core.pub, bio, av, ts, sig: sign2(core, ts, bio, av) });
  {
    const A = mk('vA'), B = mk('vB'), C = mk('vC');
    await A.start(); await B.start(); await C.start();
    const good = jpeg(128, 128);
    assert.strictEqual(A.avatarOf(A.id), '');
    assert.deepStrictEqual(A.getState().avatars, {}, 'tanpa foto: tidak ada yang dikirim ke UI');
    assert.throws(() => A.setAvatar('bukan-gambar'), /Foto tidak valid/);
    assert.throws(() => A.setAvatar(jpeg(500, 500)), /Foto tidak valid/, 'dimensi terlalu besar');
    assert.throws(() => A.setAvatar(jpeg(128, 128, 20000)), /Foto tidak valid/, 'terlalu besar');
    assert.throws(() => A.setAvatar(Buffer.from('GIF89a' + 'x'.repeat(300)).toString('base64')), /Foto tidak valid/, 'bukan JPEG');
    assert.throws(() => A.setAvatar(jpeg(0, 10)), /Foto tidak valid/, 'dimensi nol');
    assert.strictEqual(A.setAvatar('data:image/jpeg;base64,' + good), true, 'boleh berawalan data URL');
    assert.strictEqual(A.avatarOf(A.id), good);
    assert.strictEqual(A.getState().avatars[A.id], 'data:image/jpeg;base64,' + good);
    assert.strictEqual(A.bioOf(A.id), 'Hallo...', 'foto tidak mengubah deskripsi');
    const tsAv = A.store.profiles[A.id].ts;
    A.setAvatar(good);
    assert.strictEqual(A.store.profiles[A.id].ts, tsAv, 'foto sama: tidak membuat versi baru');
    A.setBio('Punya foto');
    assert.strictEqual(A.avatarOf(A.id), good, 'mengubah deskripsi tidak menghapus foto');
    ok('foto profil: hanya JPEG kecil yang sah (ukuran, dimensi, bentuk), tidak mengubah deskripsi dan sebaliknya');

    await connect(A, B); await connect(C, B);
    await until(() => B.avatarOf(A.id) === good, 6000, 'B menerima foto A');
    await until(() => C.avatarOf(A.id) === good && C.bioOf(A.id) === 'Punya foto', 6000, 'C menerima foto A lewat B');
    assert.strictEqual(C.store.profiles[A.id].pub, A.pub);
    ok('foto tersinkron seperti deskripsi: langsung dan lewat peer perantara (A - B - C), tetap bertanda tangan pemiliknya');

    const good2 = jpeg(96, 96);
    A.setAvatar(good2);
    await until(() => C.avatarOf(A.id) === good2, 6000, 'versi foto baru sampai');
    A.setAvatar('');
    await until(() => C.avatarOf(A.id) === '' && C.bioOf(A.id) === 'Punya foto', 6000, 'foto dihapus tersinkron');
    assert.strictEqual(C.getState().avatars[A.id], undefined);
    ok('mengganti dan menghapus foto tersinkron ke semua akun (versi terbaru menang)');

    // pemalsuan
    const ts = C.store.profiles[A.id].ts;
    assert.strictEqual(C._addProfile(prof2(A, 'x', good, ts - 100)), false, 'versi lama (replay)');
    assert.strictEqual(C._addProfile(Object.assign(prof2(A, 'x', good, ts + 5), { av: good2 })), false, 'foto diganti setelah ditandatangani');
    assert.strictEqual(C._addProfile(Object.assign(prof2(A, 'x', good, ts + 5), { bio: 'lain' })), false, 'bio diubah setelah ditandatangani');
    assert.strictEqual(C._addProfile(Object.assign(prof2(A, 'x', good, ts + 5), { av: undefined })), false, 'foto dibuang peer perantara: dianggap v1, tanda tangan tidak cocok');
    assert.strictEqual(C._addProfile({ id: A.id, pub: A.pub, bio: 'x', av: good, ts: ts + 5, sig: sign2(B, ts + 5, 'x', good) }), false, 'ditandatangani orang lain');
    assert.strictEqual(C._addProfile(prof2(A, 'x', jpeg(500, 500), ts + 5)), false, 'foto terlalu besar dimensinya walau tanda tangan sah');
    assert.strictEqual(C._addProfile(prof2(A, 'x', 'AAAA'.repeat(4000), ts + 5)), false, 'bukan JPEG walau tanda tangan sah');
    assert.strictEqual(C._addProfile(prof2(A, 'x', good, Date.now() + 3600e3)), false, 'ts masa depan');
    // v1 yang menyamar: bio dibuat menyerupai "bio:sha(foto)" tidak boleh cocok dengan tanda tangan v2
    const h = crypto.createHash('sha256').update(good).digest('hex');
    assert.strictEqual(C._addProfile({ id: A.id, pub: A.pub, bio: 'x:' + h, ts: ts + 5, sig: sign2(A, ts + 5, 'x', good) }), false, 'bio meniru potongan pesan v2');
    assert.strictEqual(C.avatarOf(A.id), '');
    assert.strictEqual(C._addProfile(prof2(A, 'sah', good, ts + 5)), true);
    assert.strictEqual(C.avatarOf(A.id), good);
    assert.strictEqual(C._addProfile(prof(A, 'versi v1 lebih baru', ts + 9)), true, 'catatan v1 (v0.7.3) tetap diterima');
    assert.strictEqual(C.avatarOf(A.id), '', 'v1 tidak punya foto');
    ok('pemalsuan foto ditolak: replay, foto/bio diganti, foto dibuang, tanda tangan orang lain, dimensi/bentuk salah, ts masa depan; v1 tetap diterima');

    // anggaran sync: banyak foto besar tidak membuat satu balasan raksasa
    {
      const D = mk('vD'); await D.start();
      const { idFromPub } = require('../src/archne-core');
      for (let i = 0; i < 80; i++) {
        const kp = crypto.generateKeyPairSync('ed25519');
        const pub = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), id = idFromPub(pub);
        const av = jpeg(128, 128, 9000), ts = Date.now() - i, bio = 'orang ' + i;
        const sig = crypto.sign(null, Buffer.from('archne-prof2:' + JSON.stringify([id, ts, bio, crypto.createHash('sha256').update(av).digest('hex')])), kp.privateKey).toString('base64');
        assert(D._addProfile({ id, pub, bio, av, ts, sig }));
      }
      assert.strictEqual(Object.keys(D.store.profiles).length, 80);
      const res = D._handle({ t: 'sync_req', have: [], gh: {}, ch: [], rh: [], vh: [], eq: [], pv: {}, hi: B.hello() }, '127.0.0.1');
      const n = res.pf.length, bytes = Buffer.byteLength(JSON.stringify(res.pf));
      assert(n > 0 && n < 80 && bytes <= 6e5, `balasan sync dibatasi anggaran byte: ${n} profil, ${bytes} byte`);
      const pv = {}; for (const x of res.pf) pv[x.id] = x.ts;
      const res2 = D._handle({ t: 'sync_req', have: [], gh: {}, ch: [], rh: [], vh: [], eq: [], pv, hi: B.hello() }, '127.0.0.1');
      assert(res2.pf.length > 0 && !res2.pf.some((x) => pv[x.id]), 'putaran berikutnya membawa sisanya, bukan yang sudah dimiliki');
      await D.stop();
    }
    await Promise.all([A, B, C].map((c) => c.stop()));
    ok('sync profil dibatasi anggaran byte (foto besar tidak membuat balasan raksasa; sisanya menyusul)');
  }

  // ---- 5. pertemanan dua arah (permintaan + persetujuan lewat DM terenkripsi) ----
  const fst = (c, id) => c.getState().peers.find((p) => p.id === id).fst;
  {
    const A = mk('fA'), B = mk('fB'), C = mk('fC');
    await A.start(); await B.start(); await C.start(); await connect(A, B, C);
    assert.throws(() => A.addFriend('0123456789abcdef'), /belum pernah terlihat/);
    assert.throws(() => A.addFriend(A.id), /tidak valid/);
    assert.throws(() => A.addFriend('bukan-id'), /tidak valid/);
    assert.strictEqual(fst(A, B.id), '', 'bukan teman secara bawaan');

    assert.strictEqual(A.addFriend(B.id), 'out');
    assert.strictEqual(fst(A, B.id), 'out');
    assert.strictEqual(A.getState().peers.find((p) => p.id === B.id).friend, false, 'belum teman sebelum disetujui');
    assert.strictEqual(A.addFriend(B.id), 'out', 'mengulang tidak mengirim permintaan kedua');
    await until(() => fst(B, A.id) === 'in', 6000, 'B menerima permintaan');
    assert.strictEqual(B.getState().peers.find((p) => p.id === A.id).friend, false);
    assert.strictEqual(fst(C, A.id), '', 'orang lain tidak tahu (privat, bukan disebarkan)');
    assert(!B.getState().messages.some((m) => m.text.includes('\u0001')) && !A.getState().messages.some((m) => m.text.includes('\u0001')), 'pesan kontrol tidak tampil sebagai chat');
    let msgEv = 0; A.on('message', () => msgEv++);
    ok('Tambah teman mengirim permintaan: penerima melihat "in", pengirim "out", belum saling berteman, orang lain tidak tahu, tidak tampil sebagai pesan');

    assert.strictEqual(B.addFriend(A.id), 'ok', 'menyetujui');
    assert.strictEqual(fst(B, A.id), 'ok');
    await until(() => fst(A, B.id) === 'ok', 6000, 'A melihat persetujuan');
    assert.strictEqual(A.getState().peers.find((p) => p.id === B.id).friend, true);
    assert.strictEqual(msgEv, 0, 'persetujuan tidak memicu notifikasi pesan');
    ok('persetujuan: kedua sisi jadi teman');

    // putus: orang di seberang diberi tahu
    assert.strictEqual(A.removeFriend(B.id), true);
    assert.strictEqual(A.removeFriend(B.id), false);
    await until(() => fst(B, A.id) === '', 6000, 'B tahu diputus');
    assert.strictEqual(B.getState().peers.find((p) => p.id === A.id).friend, false);
    ok('hapus teman: dua sisi putus');

    // batalkan permintaan terkirim: permintaan masuk di seberang hilang; tolak = diam-diam
    A.addFriend(B.id);
    await until(() => fst(B, A.id) === 'in', 6000, 'B menerima lagi');
    assert.strictEqual(A.removeFriend(B.id), true);
    await until(() => fst(B, A.id) === '', 6000, 'permintaan dibatalkan');
    A.addFriend(C.id);
    await until(() => fst(C, A.id) === 'in', 6000, 'C menerima');
    assert.strictEqual(C.removeFriend(A.id), true, 'menolak');
    assert.strictEqual(fst(C, A.id), '');
    await sleep(700);
    assert.strictEqual(fst(A, C.id), 'out', 'penolakan diam-diam: pengirim tidak diberi tahu (tetap menunggu sampai membatalkan)');
    A.removeFriend(C.id);
    ok('batalkan permintaan menghapusnya di seberang; menolak permintaan diam-diam');

    // saling meminta bersamaan -> langsung berteman
    {
      const X = mk('fX'), Y = mk('fY'); await X.start(); await Y.start(); await connect(X, Y);
      X.addFriend(Y.id); Y.addFriend(X.id);
      await until(() => fst(X, Y.id) === 'ok' && fst(Y, X.id) === 'ok', 6000, 'saling meminta');
      await X.stop(); await Y.stop();
    }
    ok('saling meminta bersamaan: langsung berteman di kedua sisi');

    // permintaan lama yang telat sampai (urutan terbalik) tidak menghidupkan keadaan lama
    {
      const old = { from: A.id, to: B.id }; // tiru: FRQ ts=100 diterapkan setelah FDL ts=200
      B.store.friends[A.id] = { st: '', rts: 200, at: 0 };
      const fake = { from: A.id, ts: 100 };
      B._applyFriendCtl(fake, 'frq');
      assert.strictEqual(fst(B, A.id), '', 'kontrol lebih tua dari yang sudah diterapkan diabaikan');
      B._applyFriendCtl({ from: A.id, ts: Date.now() + 3600e3 }, 'frq');
      assert.strictEqual(fst(B, A.id), '', 'ts jauh di masa depan diabaikan (tidak bisa mengunci)');
      B._applyFriendCtl({ from: A.id, ts: 300 }, 'frq');
      assert.strictEqual(fst(B, A.id), 'in');
      B._applyFriendCtl({ from: A.id, ts: 400 }, 'fac');
      assert.strictEqual(fst(B, A.id), 'in', 'persetujuan tanpa kita meminta diabaikan');
      B.removeFriend(A.id);
    }
    ok('kontrol yang lebih tua (telat sampai), ts masa depan, dan persetujuan yang tidak diminta diabaikan');

    // pengguna tidak bisa memalsukan kontrol lewat chat biasa
    A.sendText('\u0001frq', B.id);
    await sleep(500);
    assert.strictEqual(fst(B, A.id), '', 'teks kontrol dari kotak chat disaring');
    ok('teks kontrol tidak bisa diketik lewat chat');
    await Promise.all([A, B, C].map((c) => c.stop()));
  }

  // ---- 6. teman tetap ada setelah restart; permintaan ke yang offline terkirim saat dia online; daftar lama (v0.7.3) jadi permintaan ----
  {
    const A = mk('rA'), B = mk('rB');
    await A.start(); await B.start(); await connect(A, B);
    A.addFriend(B.id);
    await until(() => fst(B, A.id) === 'in', 6000, 'B menerima');
    await B.stop();
    await A.stop();
    const A2 = mk('rA'); await A2.start();
    assert.strictEqual(fst(A2, B.id), 'out', 'permintaan terkirim bertahan setelah restart');
    const B2 = mk('rB'); await B2.start();
    assert.strictEqual(fst(B2, A.id), 'in', 'permintaan masuk bertahan setelah restart');
    await connect(A2, B2);
    B2.addFriend(A.id);
    await until(() => fst(A2, B.id) === 'ok', 6000, 'sampai setelah restart');
    await A2.stop(); await B2.stop();

    // peer offline saat permintaan dikirim: sampai begitu dia online
    const P = mk('oP'), Q = mk('oQ');
    await P.start(); await Q.start(); await connect(P, Q);
    await Q.stop();
    P.peers.get(Q.id).lastSeen = 0; // Q dianggap baru saja offline (tanpa menunggu 12 dtk)
    P.addFriend(Q.id);
    assert.strictEqual(fst(P, Q.id), 'out');
    const Q2 = mk('oQ'); await Q2.start();
    await P.addPeer('127.0.0.1', Q2.port);
    await until(() => fst(Q2, P.id) === 'in', 8000, 'permintaan sampai saat Q online lagi');
    await P.stop(); await Q2.stop();
    ok('permintaan dan persetujuan bertahan setelah restart; permintaan ke peer offline terkirim begitu dia online');

    // migrasi daftar teman v0.7.3 ({ at, name } tanpa st): jadi permintaan terkirim dan dikirim
    const L = mk('lA'), M = mk('lB');
    await L.start(); await M.start(); await connect(L, M);
    await L.stop();
    const sf = path.join(tmp, 'lA', 'store.json'), st = JSON.parse(fs.readFileSync(sf, 'utf8'));
    st.friends = { [M.id]: { at: 1, name: 'lB' }, 'rusak': { at: 1 } };
    fs.writeFileSync(sf, JSON.stringify(st));
    const L2 = mk('lA'); await L2.start();
    assert.strictEqual(fst(L2, M.id), 'out', 'entri lama jadi permintaan terkirim');
    assert(!L2.store.friends.rusak, 'entri rusak dibuang');
    await connect(L2, M);
    await until(() => fst(M, L.id) === 'in', 8000, 'permintaan dari daftar lama sampai');
    await L2.stop(); await M.stop();
    ok('daftar teman lama (satu arah) dimigrasi: jadi permintaan terkirim yang benar-benar dikirim');
  }

  console.log(`\nSEMUA TES PROFIL LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('\nTES GAGAL: ' + e.stack); process.exit(1); });

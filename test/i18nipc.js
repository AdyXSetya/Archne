'use strict';
// Tes i18n E3: galat Core diterjemahkan di perbatasan (src/archne-ipc.js, src/archne-ipc-direct.js) sesuai bahasa di settings.json.
// Plus penjaga (berlaku untuk semua step E): teks Indonesia cadangan di src/ HARUS sama dengan archne-id.js (ek/T/tr dengan kunci e.*).
const os = require('os'), path = require('path'), fs = require('fs'), vm = require('vm'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { ek } = require('../src/core/archne-ecode');
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-i18nipc-'));
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };

function fake(core, extra) {
  const handlers = {};
  const ipcMain = { handle: (n, fn) => { handlers[n] = fn; } };
  register(Object.assign({ ipcMain, core, shell: { showItemInFolder() {}, openPath: async () => '' }, send() {}, log() {} }, extra));
  return { call: (n, ...a) => handlers[n]({}, ...a) };
}

(async () => {
  const core = new Core({ dataDir: path.join(tmp, 'A'), downloadDir: path.join(tmp, 'A-dl'), name: 'A', discovery: false });
  const w = fake(core);

  // ---- 1. bawaan English; ganti ke id lewat settings (dibaca saat dipanggil) ----
  let r = await w.call('captureSave', 'x.zip', Buffer.alloc(20));
  assert(r.ok === false && r.err === 'Unknown camera file type', JSON.stringify(r));
  assert.strictEqual((await w.call('openFile', 'a'.repeat(32))).err, 'File not found (it may have been moved or deleted)');
  assert.strictEqual((await w.call('webOpen', 'https://x.test')).err, 'The in-app browser is not available');
  assert.strictEqual((await w.call('sendVoice', 'j1', '/x', 'public', 100)).err, 'Voice messages cannot be sent in Public');
  assert.strictEqual((await w.call('sendVoice', 'j1', '/x', 'abc', 1.5)).err, 'Invalid voice message duration');
  assert.strictEqual((await w.call('dxChooseDir')).err, 'The folder picker is not available');
  ok('bawaan English: kamera, berkas hilang, peramban, pesan suara, pemilih folder');

  assert((await w.call('setSettings', { lang: 'id' })).ok);
  assert.strictEqual((await w.call('captureSave', 'x.zip', Buffer.alloc(20))).err, 'Jenis berkas kamera tidak dikenal');
  assert.strictEqual((await w.call('openFile', 'a'.repeat(32))).err, 'Berkas tidak ditemukan (mungkin sudah dipindah atau dihapus)');
  assert.strictEqual((await w.call('webOpen', 'https://x.test')).err, 'Peramban dalam aplikasi tidak tersedia');
  assert.strictEqual((await w.call('sendVoice', 'j1', '/x', 'public', 100)).err, 'Pesan suara tidak bisa dikirim di Publik');
  assert.strictEqual((await w.call('dxChooseDir')).err, 'pemilih folder tidak tersedia');
  ok('setelah lang=id: pesan yang sama berbahasa Indonesia (tanpa restart)');

  assert((await w.call('setSettings', { lang: null })).ok);
  assert.strictEqual((await w.call('captureSave', 'x.zip', Buffer.alloc(20))).err, 'Unknown camera file type', 'kembali ke bawaan en');

  // ---- 2. fail() dan send: galat berkunci diterjemahkan, galat polos apa adanya, code diteruskan ----
  core.createGroup = () => { throw ek('call.ariaTo', { name: 'Budi' }, 'Telepon Budi', 'bad'); };
  r = await w.call('createGroup', 'n', []);
  assert.deepStrictEqual({ ok: r.ok, err: r.err, code: r.code }, { ok: false, err: 'Call Budi', code: 'bad' });
  await w.call('setSettings', { lang: 'id' });
  r = await w.call('createGroup', 'n', []);
  assert.strictEqual(r.err, 'Telepon Budi'); assert.strictEqual(r.code, 'bad');
  core.createGroup = () => { throw Object.assign(new Error('Galat polos'), { code: 'xx' }); };
  r = await w.call('createGroup', 'n', []);
  assert.deepStrictEqual({ err: r.err, code: r.code }, { err: 'Galat polos', code: 'xx' }, 'tanpa kunci: .message apa adanya');
  core.sendText = () => { throw ek('call.ariaTo', { name: 'Ani' }, 'Telepon Ani'); };
  assert.strictEqual(await w.call('send', 'hi', 'x'), 'Telepon Ani');
  await w.call('setSettings', { lang: null });
  assert.strictEqual(await w.call('send', 'hi', 'x'), 'Call Ani', 'send mengembalikan teks terjemahan');
  core.sendText = () => { throw new Error('polos'); };
  assert.strictEqual(await w.call('send', 'hi', 'x'), 'polos');
  ok('fail(): ek diterjemahkan (en/id), code diteruskan, galat polos tak berubah; send() mengembalikan teks terjemahan');

  // ---- 3. Penjaga: cadangan Indonesia di kode == archne-id.js; kunci e.* ada di kedua kamus; id != en bila bukan istilah sama ----
  const ctx = vm.createContext({});
  for (const f of ['archne-i18n.js', 'i18n/archne-en.js', 'i18n/archne-id.js']) vm.runInContext(fs.readFileSync(path.join(root, 'renderer', f), 'utf8'), ctx);
  const D = vm.runInContext('I18N._dict', ctx);
  const files = [];
  (function walk(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (n.endsWith('.js')) files.push(p); } })(path.join(root, 'src'));
  for (const extra of ['main.js', 'server.js']) if (fs.existsSync(path.join(root, extra))) files.push(path.join(root, extra));
  const re = /\b(?:T|tr|ek|trn)\(\s*'(e\.[\w.]+)'\s*,\s*(?:null|\{[^}]*\})\s*,\s*'((?:[^'\\]|\\.)*)'/g;
  let n = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'); // baris komentar penuh (contoh di archne-ecode.js) diabaikan
    let m;
    while ((m = re.exec(src))) {
      const key = m[1], fb = m[2].replace(/\\(.)/g, '$1');
      const rel = path.relative(root, f);
      assert(D.en && D.en[key] != null, rel + ': kunci ' + key + ' tidak ada di archne-en.js');
      assert(D.id && D.id[key] != null, rel + ': kunci ' + key + ' tidak ada di archne-id.js');
      assert.strictEqual(D.id[key], fb, rel + ': cadangan Indonesia untuk ' + key + ' berbeda dari archne-id.js');
      n++;
    }
  }
  assert(n >= 19, 'penjaga memeriksa kunci e.* yang ditulis E3 (ditemukan ' + n + ')');
  ok('penjaga cadangan: ' + n + ' pemakaian e.* di src/ == archne-id.js, kunci ada di archne-en.js dan archne-id.js');

  // ---- 3b. archne-ipc-pages.js (E4): pemilih berkas, arsip kedaluwarsa; en lalu id ----
  await w.call('setSettings', { lang: null });
  let rp = await w.call('pgArcExport', { comments: true });
  assert.deepStrictEqual({ err: rp.err, code: rp.code }, { err: 'The file picker is not available on this device', code: 'nodialog' }, JSON.stringify(rp));
  rp = await w.call('pgArcImport', 'a'.repeat(16), { comments: true });
  assert.deepStrictEqual({ err: rp.err, code: rp.code }, { err: 'Choose the archive again', code: 'gone' }, JSON.stringify(rp));
  await w.call('setSettings', { lang: 'id' });
  assert.strictEqual((await w.call('pgArcExport', { comments: true })).err, 'Pemilih berkas tidak tersedia di perangkat ini');
  assert.strictEqual((await w.call('pgArcImport', 'a'.repeat(16), { comments: true })).err, 'Pilih arsip lagi');
  await w.call('setSettings', { lang: null });
  ok('ipc-pages: pemilih berkas dan arsip kedaluwarsa berganti bahasa (en/id)');

  // ---- 3c. archne-pagestore.js (E5): teks kosong, gambar cacat, awalan "Gambar ke-N" bersarang; en lalu id ----
  {
    const { errText } = require('../src/core/archne-ecode');
    const { PageStore } = require('../src/archne-pagestore');
    const ps = new PageStore(path.join(tmp, 'PS'));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const good = path.join(tmp, 'ok.png'), bad = path.join(tmp, 'bad.png'); fs.writeFileSync(good, png); fs.writeFileSync(bad, 'bukan gambar');
    const errOf = async (fn) => { try { await fn(); } catch (e) { return e; } throw new Error('harus gagal'); };
    const eEmpty = await errOf(() => ps.create({ text: '   ' }));
    const eSolo = await errOf(() => ps.addMedias([{ src: bad }]));
    const eNth = await errOf(() => ps.addMedias([{ src: good }, { src: bad }]));
    const eNone = await errOf(() => ps.addMedias([{ src: good }, 5]));
    await w.call('setSettings', { lang: null });
    assert.strictEqual(errText(eEmpty), 'The post text is empty');
    assert.strictEqual(errText(eSolo), 'Not a supported image (jpg, png, webp, gif)', 'satu gambar: tanpa awalan');
    assert.strictEqual(errText(eNth), 'Image 2: Not a supported image (jpg, png, webp, gif)', 'awalan + galat dasar sama-sama diterjemahkan');
    assert.strictEqual(errText(eNone), 'Image 2: Invalid image');
    await w.call('setSettings', { lang: 'id' });
    assert.strictEqual(errText(eEmpty), 'Teks postingan kosong');
    assert.strictEqual(errText(eNth), 'Gambar ke-2: Bukan gambar yang didukung (jpg, png, webp, gif)');
    assert.strictEqual(eNth.message, 'Gambar ke-2: Bukan gambar yang didukung (jpg, png, webp, gif)', '.message tetap Indonesia (log, tes lama)');
    await w.call('setSettings', { lang: null });
    // E6: berkas, video, lampiran belum disalin, postingan ganda
    const empty = path.join(tmp, 'kosong.bin'); fs.writeFileSync(empty, '');
    const fFile = await errOf(() => ps.addFiles([{ src: good }, { src: empty }]));
    const fVid = await errOf(() => ps.addVideos([{ src: bad }]));
    const fVid2 = await errOf(() => ps.addVideos([{ src: good }, { src: bad }]));
    const fMiss = await errOf(() => ps.create({ text: 'x', media: [{ id: 'a'.repeat(16), mime: 'image/png', size: 5, name: 'a.png' }] }));
    await w.call('setSettings', { lang: null });
    assert.strictEqual(errText(fFile), 'File 2: The file is empty');
    assert.strictEqual(errText(fVid), 'Not a supported video (mp4 or webm)');
    assert.strictEqual(errText(fVid2), 'Video 1: Not a supported video (mp4 or webm)');
    assert.strictEqual(errText(fMiss), 'The image file has not been copied yet');
    await w.call('setSettings', { lang: 'id' });
    assert.strictEqual(errText(fFile), 'Berkas ke-2: Berkas kosong');
    assert.strictEqual(errText(fVid), 'Bukan video yang didukung (mp4 atau webm)');
    assert.strictEqual(errText(fMiss), 'Berkas gambar belum disalin');
    await w.call('setSettings', { lang: null });
    // E7: reaksi penuh (256 orang) pada postingan dan komentar
    const { PageRx, PageCmtRx } = require('../src/archne-pagerx');
    const prx = new PageRx(path.join(tmp, 'rx1.json')), crx = new PageCmtRx(path.join(tmp, 'rx2.json'));
    const hex = (n) => n.toString(16).padStart(16, '0'), pid = 'a'.repeat(16), cid = 'b'.repeat(16);
    for (let i = 1; i <= 256; i++) { prx.set(hex(i), pid, '👍', 1000 + i); crx.set(hex(i), pid, cid, '👍', 1000 + i); }
    const rxP = (() => { try { prx.set(hex(999), pid, '👍', 5000); } catch (e) { return e; } })();
    const rxC = (() => { try { crx.set(hex(999), pid, cid, '👍', 5000); } catch (e) { return e; } })();
    assert(rxP && rxC, 'batas 256 harus menolak');
    assert.strictEqual(errText(rxP), 'Too many reactions on this post'); assert.strictEqual(errText(rxC), 'Too many reactions on this comment');
    await w.call('setSettings', { lang: 'id' });
    assert.strictEqual(errText(rxP), 'Terlalu banyak reaksi pada postingan ini'); assert.strictEqual(rxC.message, 'Terlalu banyak reaksi pada komentar ini');
    await w.call('setSettings', { lang: null });
    // E8: sematan (kebijakan per lingkup, jadi dihitung saat dilempar), reaksi pesan, jalur Kirim Langsung
    const Pins = require('../src/archne-pins'), Rx = require('../src/archne-reactions');
    const H = (c) => c.repeat(16), me = H('a'), other = H('b'), map = {};
    const thr = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('harus gagal'); };
    const ePinSelf = thr(() => Pins.create(map, Pins.selfPolicy(me), other, H('1'), { kind: 'note', text: 'x' }, 1));
    const ePinDm = thr(() => Pins.create(map, Pins.dmPolicy(me, other), H('c'), H('2'), { kind: 'note', text: 'x' }, 1));
    const ePinEmpty = thr(() => Pins.cleanText('   '));
    const ePinNone = thr(() => Pins.remove(map, Pins.selfPolicy(me), me, H('9'), 2));
    const eMsgRx = thr(() => { const m = {}; for (let i = 1; i <= 256; i++) Rx.toggle(m, hex(i), 'f'.repeat(32), '👍', 1000 + i); Rx.toggle(m, hex(999), 'f'.repeat(32), '👍', 5000); });
    await w.call('setSettings', { lang: null });
    assert.strictEqual(errText(ePinSelf), 'Private pins are only for their owner.');
    assert.strictEqual(errText(ePinDm), 'You are not a participant of this chat.');
    assert.strictEqual(errText(ePinEmpty), 'The pin text is empty');
    assert.strictEqual(errText(ePinNone), 'Pin not found');
    assert.strictEqual(errText(eMsgRx), 'Too many reactions on this message');
    await w.call('setSettings', { lang: 'id' });
    assert.strictEqual(errText(ePinSelf), 'Sematan pribadi hanya untuk pemiliknya.');
    assert.strictEqual(errText(ePinDm), 'Kamu bukan peserta chat ini.');
    assert.strictEqual(errText(ePinNone), 'Sematan tidak ditemukan'); assert.strictEqual(eMsgRx.message, 'Terlalu banyak reaksi pada pesan ini');
    await w.call('setSettings', { lang: null });
    // parameter diisi juga di .message Indonesia
    const ePinFull = ek('e.pin.full', { max: 100 }, 'Sudah ada {max} sematan. Lepas salah satu dulu.');
    assert.strictEqual(ePinFull.message, 'Sudah ada 100 sematan. Lepas salah satu dulu.'); assert.strictEqual(errText(ePinFull), 'There are already 100 pins. Unpin one first.');
    // dxcard: setiap kode TEXT/DxError yang bisa sampai UI punya peta
    const dxsrc = fs.readFileSync(path.join(root, 'renderer', 'archne-dxcard.js'), 'utf8');
    for (const c of ['bad', 'range', 'gone', 'denied', 'changed', 'busy', 'lan', 'net', 'timeout', 'proto', 'disk', 'io', 'unsafe']) assert(new RegExp('\\b' + c + ": \\['dxc\\.code\\.").test(dxsrc), 'CODE_DEF tanpa kode ' + c);
    // galat bersarang meneruskan code (ENOSPC dari disk penuh tetap terbaca renderer lewat code)
    const nested = ek('e.pg.imgN', { n: 3, why: ek('e.io.full', null, 'Penyimpanan penuh', 'ENOSPC') }, 'Gambar ke-3: Penyimpanan penuh', 'ENOSPC');
    assert.strictEqual(errText(nested), 'Image 3: Storage is full'); assert.strictEqual(nested.code, 'ENOSPC');
    // E9a: archne-group-admin.js + archne-profile-social.js (galat grup dan profil)
    const eGName = thr(() => Core.prototype.createGroup.call(core, '   ', ['f'.repeat(16)]));
    const eGNone = thr(() => core.leaveGroup('0'.repeat(16)));
    const eGPick = thr(() => Core.prototype.createGroup.call(core, 'G', []));
    const eAv = thr(() => core.setAvatar('bukan-gambar'));
    const eFr = thr(() => core.addFriend('0123456789abcdef'));
    await w.call('setSettings', { lang: null });
    assert.strictEqual(errText(eGName), 'Group name is empty'); assert.strictEqual(errText(eGNone), 'Unknown group');
    assert.strictEqual(errText(eGPick), 'Pick at least 1 member');
    assert(/^Invalid photo: must be JPEG, max 192x192 px and \d+ KB$/.test(errText(eAv)), errText(eAv));
    assert.strictEqual(errText(eFr), 'This person has never been seen on the network');
    await w.call('setSettings', { lang: 'id' });
    assert.strictEqual(errText(eGName), 'Nama grup kosong'); assert.strictEqual(errText(eGNone), 'Grup tidak dikenal');
    assert(/^Foto tidak valid: harus JPEG maks 192x192 px dan \d+ KB$/.test(errText(eAv)), errText(eAv));
    assert.strictEqual(errText(eFr), 'Orang ini belum pernah terlihat di jaringan'); assert.strictEqual(eFr.message, errText(eFr));
    await w.call('setSettings', { lang: null });
    // semua 'throw new Error(' yang tersisa di archne-group-admin.js harus nol (semuanya berkunci)
    assert(!/new Error\(/.test(fs.readFileSync(path.join(root, 'src', 'core', 'archne-group-admin.js'), 'utf8')), 'archne-group-admin.js: semua galat berkunci');
    // E9a-2: catatan grup disimpan sebagai kunci + parameter, diterjemahkan saat getState(); catatan lama (teks saja) tetap apa adanya
    const gc = new Core({ dataDir: path.join(tmp, 'GN'), downloadDir: path.join(tmp, 'GN-dl'), name: 'GN', discovery: false }); // Core segar: terakhir dibuat = yang dipakai I18N.bind
    gc._save = () => {}; // Core belum start(): primFile kosong, tanpa ini timer simpan menulis undefined.tmp ke folder kerja
    gc.store.pins = gc.store.pins || {}; gc.store.mypins = gc.store.mypins || {}; // belum start(): isi bagian yang dibaca getState()
    gc._note('a'.repeat(16), 'note.renamed', { who: 'Ani', old: 'Lama', name: 'Baru' }, '{who} mengganti nama grup dari "{old}" menjadi "{name}"');
    gc._note('a'.repeat(16), 'note.left', { name: 'Budi' }, '{name} keluar dari grup');
    gc._note('a'.repeat(16), 'Catatan lama sebelum i18n');
    const sysTexts = () => gc.getState().messages.filter((m) => m.sys).map((m) => m.text);
    const last3 = () => sysTexts().slice(-3);
    assert.deepStrictEqual(last3(), ['Ani renamed the group from "Lama" to "Baru"', 'Budi left the group', 'Catatan lama sebelum i18n']);
    gc.setSettings({ lang: 'id' });
    assert.deepStrictEqual(last3(), ['Ani mengganti nama grup dari "Lama" menjadi "Baru"', 'Budi keluar dari grup', 'Catatan lama sebelum i18n']);
    assert.strictEqual(gc.store.notes[gc.store.notes.length - 2].text, 'Budi keluar dari grup', 'text Indonesia tetap tersimpan sebagai cadangan');
    gc.setSettings({ lang: null }); require('../src/core/archne-i18n-node').bind(() => core.getSettings().lang);
    // E9b: core/archne-media.js (hasil {ok:false, code, err}) dan core/archne-file-send.js (throw)
    const gone = 'f'.repeat(32);
    await w.call('setSettings', { lang: null });
    let mr = await core.mediaRead(gone), pr = await core.mediaPlay(gone);
    assert.deepStrictEqual([mr.code, mr.err], ['gone', 'The photo has not been downloaded or was deleted']);
    assert.deepStrictEqual([pr.code, pr.err], ['gone', 'The file has not been downloaded or was deleted']);
    const sErr = async (fn) => { try { await fn(); } catch (e) { return e; } throw new Error('harus gagal'); };
    const eDest = await sErr(() => core.sendFile(path.join(tmp, 'x'), 'zzz'));
    const eVoice = await sErr(() => core.sendVoice(path.join(tmp, 'tidak-ada.ogg'), 'a'.repeat(16), { durMs: 2000 }));
    const eVPub = await sErr(() => core.sendVoice(path.join(tmp, 'x'), 'public', { durMs: 2000 }));
    assert.strictEqual(errText(eDest), 'Unknown destination'); assert.strictEqual(errText(eVPub), 'Voice messages cannot be sent in Public');
    await w.call('setSettings', { lang: 'id' });
    mr = await core.mediaRead(gone); pr = await core.mediaPlay(gone);
    assert.deepStrictEqual([mr.code, mr.err], ['gone', 'Foto belum diunduh atau sudah dihapus']);
    assert.strictEqual(pr.err, 'Berkas belum diunduh atau sudah dihapus');
    assert.strictEqual(errText(eDest), 'Tujuan tidak dikenal'); assert.strictEqual(eDest.message, 'Tujuan tidak dikenal');
    assert.strictEqual(errText(eVPub), 'Pesan suara tidak bisa dikirim di Publik');
    assert.strictEqual(errText(eVoice), eVoice.message, 'id: terjemahan == .message Indonesia (' + eVoice.message + ')');
    await w.call('setSettings', { lang: null });
    assert(!/new Error\(/.test(fs.readFileSync(path.join(root, 'src', 'core', 'archne-media.js'), 'utf8')), 'archne-media.js: semua galat berkunci');
    // E9c: call-room, voice-group, direct-send/recv, wan (undangan WAN: kalimat pengantar mengikuti bahasa pengirim)
    await w.call('setSettings', { lang: null });
    const eCallNone = await sErr(() => core.callInvite('0'.repeat(16), 'a'.repeat(16)));
    const eDxPeer = await sErr(() => core._directSend('b'.repeat(16), [path.join(tmp, 'x')]));
    const eWan = await sErr(() => core.inviteMake(false));
    assert.strictEqual(errText(eDxPeer), 'Unknown peer'); assert.strictEqual(eDxPeer.code, 'peer');
    assert.strictEqual(errText(eWan), 'Cross-network mode is not set up yet'); assert(errText(eCallNone).length > 0);
    const sharedTxt = (lang) => require('../src/core/archne-i18n-node').tr('wan.shareText', null, 'x');
    assert.strictEqual(sharedTxt(), 'Join my Archne network (tap Add, or paste it in the Cross-network menu):');
    await w.call('setSettings', { lang: 'id' });
    assert.strictEqual(errText(eDxPeer), 'Peer tidak dikenal'); assert.strictEqual(eDxPeer.message, 'Peer tidak dikenal');
    assert.strictEqual(sharedTxt(), 'Gabung ke jaringan Archne-ku (ketuk Tambah, atau tempel di menu Lintas jaringan):');
    assert(/I18N\.tr\('wan\.shareText'/.test(fs.readFileSync(path.join(root, 'src', 'core', 'archne-wan.js'), 'utf8')), 'archne-wan.js memakai wan.shareText');
    await w.call('setSettings', { lang: null });
    for (const f of ['call-room', 'voice-group', 'direct-send', 'direct-recv', 'wan']) {
      const left = fs.readFileSync(path.join(root, 'src', 'core', 'archne-' + f + '.js'), 'utf8').split('\n').filter((l) => /new Error\(/.test(l) && !/ID tidak valid|SDP tidak valid|Direct\.TEXT|e\.message|'io'/.test(l));
      assert.deepStrictEqual(left, [], f + '.js: masih ada galat Indonesia polos');
    }
    // E9d: messages, notify-state, reactions, pin-sync, file-receive, pages* (angka ribuan mengikuti bahasa; code SPAM tetap)
    await w.call('setSettings', { lang: null });
    const I = require('../src/core/archne-i18n-node');
    const sendT = (...a) => Core.prototype.sendText.apply(core, a); // core.sendText diganti stub oleh bagian 1
    const eUnsend = await sErr(() => core.deleteMessage('f'.repeat(32)));
    const eChat = await sErr(() => core.clearChat('zz'));
    const eLong = await sErr(() => sendT('b'.repeat(10001), 'public'));
    const eGrp = await sErr(() => sendT('halo', 'g:' + 'c'.repeat(16)));
    const eRxMsg = await sErr(() => core.react('e'.repeat(32), '👍'));
    const fk = { id: 'a'.repeat(16), store: { msgs: { m1: { id: 'm1', from: 'a'.repeat(16), to: 'public', ts: Date.now(), text: 'pesan uji spam satu dua tiga' } } }, _chatKey: () => 'public', _isCtlMsg: () => false, _offerOf: () => undefined, _splitReply: Core.prototype._splitReply }; // Core segar belum punya kunci tanda tangan: pakai this palsu untuk _checkSpam
    const eSpam = await sErr(() => Core.prototype._checkSpam.call(fk, 'pesan uji spam satu dua tiga', 'public'));
    const eRecv = await core.receiveFile('d'.repeat(32)).catch((e) => e);
    assert.strictEqual(errText(eUnsend), 'This message cannot be unsent');
    assert.strictEqual(errText(eChat), 'Unknown chat');
    assert.strictEqual(errText(eLong), 'Message is too long: 10,001 of max 10,000 characters. Shorten it or split it into several messages; the message was not sent.');
    assert.strictEqual(errText(eGrp), 'Unknown group');
    assert.strictEqual(errText(eRxMsg), 'Message not found (it may have been unsent or cleared)');
    assert.strictEqual(eSpam.code, 'SPAM'); assert(/^This message is the same as/.test(errText(eSpam)), errText(eSpam));
    assert.strictEqual(errText(eRecv), 'File offer not found');
    assert.strictEqual(I.tr('rx.notice', { who: 'Ani', emoji: '👍' }, 'x'), 'Ani reacted 👍');
    assert.strictEqual(I.tr('rx.noticeOn', { who: 'Ani', emoji: '👍', quote: 'halo' }, 'x'), 'Ani reacted 👍 to: halo');
    assert.deepStrictEqual(['prev.undecrypted', 'prev.voice', 'prev.fileUnknown', 'prev.badOffer'].map((k) => I.tr(k, null, 'x')), ['🔒 (cannot be decrypted)', '🎤 Voice message', '📎 (file)', '📎 (invalid file offer)']);
    await w.call('setSettings', { lang: 'id' });
    assert.strictEqual(errText(eUnsend), 'Pesan tidak bisa dibatalkan'); assert.strictEqual(eUnsend.message, 'Pesan tidak bisa dibatalkan');
    assert.strictEqual(errText(eChat), 'Chat tidak dikenal');
    assert.strictEqual(errText(eLong), 'Pesan terlalu panjang: 10.001 dari maks 10.000 karakter. Persingkat atau pecah jadi beberapa pesan; pesan tidak dikirim.');
    assert.strictEqual(eLong.message, errText(eLong), '.message Indonesia memakai pemisah ribuan titik (test/limits.js bergantung padanya)');
    assert.strictEqual(errText(eGrp), 'Grup tidak dikenal'); assert.strictEqual(errText(eRecv), 'Tawaran berkas tidak ditemukan');
    assert.strictEqual(errText(eSpam), eSpam.message); assert.strictEqual(eSpam.code, 'SPAM');
    assert.strictEqual(I.tr('rx.noticeOn', { who: 'Ani', emoji: '👍', quote: 'halo' }, 'x'), 'Ani bereaksi 👍 pada: halo');
    assert.deepStrictEqual(['prev.undecrypted', 'prev.voice', 'prev.fileUnknown', 'prev.badOffer'].map((k) => I.tr(k, null, 'x')), ['🔒 (tidak bisa didekripsi)', '🎤 Pesan suara', '📎 (berkas)', '📎 (tawaran berkas tidak valid)']);
    // angka >= 1000 pada parameter: id '.', en ','; angka kecil dan teks tak berubah
    assert.strictEqual(I.numFmt({ a: 1234567, b: 999, c: '1234' }, ',').a, '1,234,567'); assert.strictEqual(I.numFmt({ b: 999, c: '1234' }, ',').c, '1234');
    // sematan membawa kode berkunci; kode 'old' dari halaman tetap ada
    const ePin = await sErr(() => core._pinSnap('public', 'a'.repeat(32)));
    assert.strictEqual(ePin.ek, 'e.msg.notFound'); assert.strictEqual(errText(ePin), 'Pesan tidak ditemukan (mungkin sudah dibatalkan atau dibersihkan)');
    await w.call('setSettings', { lang: null });
    assert.strictEqual(errText(ePin), 'Message not found (it may have been unsent or cleared)');
    const eOld = ek('e.pg.oldReply', null, 'Aplikasi pemilik belum mendukung balasan komentar.', 'old');
    assert.strictEqual(eOld.code, 'old'); assert.strictEqual(errText(eOld), 'The owner\u2019s app does not support comment replies yet.');
    for (const f of ['messages', 'notify-state', 'reactions', 'pin-sync', 'file-receive', 'pages-cd', 'pages-cmt', 'pages-rx', 'pages']) {
      const left = fs.readFileSync(path.join(root, 'src', 'core', 'archne-' + f + '.js'), 'utf8').split('\n').filter((l) => /new Error\(/.test(l) && !/^\s*\/\//.test(l) && !/Chat tidak valid|Emoji tidak valid|Pesan tidak valid/.test(l));
      assert.deepStrictEqual(left, [], f + '.js: masih ada galat Indonesia polos');
    }
    // penjaga: setiap _note( di src/ membawa kunci note.* dan cadangan Indonesia yang sama persis dengan archne-id.js
    {
      const idDict = {}; vm.runInNewContext(fs.readFileSync(path.join(root, 'renderer', 'i18n', 'archne-id.js'), 'utf8'), { I18N: { add: (l, d) => Object.assign(idDict, d) } });
      let cnt = 0;
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.js$/.test(e.name)) scanNotes(f); });
      const scanNotes = (f) => { for (const ln of fs.readFileSync(f, 'utf8').split('\n')) {
        const m = /this\._note\((.*)\);/.exec(ln); if (!m || /^\s*\/\//.test(ln)) continue;
        const keys = (m[1].match(/'note\.\w+'/g) || []).map((k) => k.slice(1, -1));
        assert(keys.length, f + ': _note tanpa kunci note.*: ' + ln.trim());
        const fb = (m[1].replace(/'note\.\w+'/g, '').match(/'((?:[^'\\]|\\.)*)'/g) || []).map((x) => x.slice(1, -1).replace(/\\"/g, '"'));
        assert.strictEqual(fb.length, keys.length, f + ': jumlah cadangan != jumlah kunci: ' + ln.trim());
        for (const k of keys) { assert(idDict[k], 'kunci hilang di archne-id.js: ' + k); assert(fb.includes(idDict[k]), f + ': cadangan != archne-id.js untuk ' + k); cnt++; }
      } };
      walk(path.join(root, 'src'));
      assert(cnt >= 18, 'penjaga catatan: ' + cnt);
    }
    ok('pagestore: teks kosong, gambar cacat, awalan Gambar ke-N bersarang berganti bahasa (en/id); .message tetap Indonesia');
  }

  // ---- 3j. E9e: archne-invite.js, archne-turn.js, archne-vchan.js, archne-pvch.js, archne-webbrowser.js (+ pvEnter di archne-voice-public.js); en lalu id ----
  {
    const NI = require('../src/core/archne-i18n-node'); NI.bind(() => core.getSettings().lang);
    const { errText } = require('../src/core/archne-ecode');
    const Invite = require('../src/archne-invite'), Turn = require('../src/archne-turn'), Vc = require('../src/archne-vchan'), Pv = require('../src/archne-pvch'), WB = require('../src/archne-webbrowser');
    const thr = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('harus gagal'); };
    const wb = WB.createWebBrowser({ getWindow: () => null, shell: { openExternal: async () => { throw new Error('x'); } }, log() {} });
    const by = 'a'.repeat(16);
    const gid = { id: 'g', creator: by, admins: [], members: [{ id: by }, { id: 'b'.repeat(16) }], vch: {} };
    // tiap bahasa: [invite tanpa tautan, versi asing, turn app salah, alamat manual salah, vchan nama kosong, pvch PIN, web tautan salah, web tanpa jendela]
    for (const [lang, L] of [['en', ['No invitation link (archne://join?...) found in that text', 'Unknown invitation version (9). Please update Archne.', 'Invalid Metered app name', 'Invalid address: http://x (must start with turn:, turns:, stun: or stuns:)', 'The channel name is empty', 'The PIN must be 6 digits', 'The link cannot be opened (only http and https)', 'The window is not available']],
                             ['id', ['Tidak ada tautan undangan (archne://join?...) di teks itu', 'Versi undangan tidak dikenal (9). Perbarui Archne.', 'Nama app Metered tidak valid', 'Alamat tidak sah: http://x (harus diawali turn:, turns:, stun: atau stuns:)', 'Nama channel kosong', 'PIN harus 6 angka', 'Tautan tidak bisa dibuka (hanya http dan https)', 'Jendela tidak tersedia']]]) {
      await w.call('setSettings', { lang: lang === 'id' ? 'id' : null });
      assert.strictEqual(errText(thr(() => Invite.parse('halo tanpa tautan'))), L[0]);
      assert.strictEqual(errText(thr(() => Invite.parse('archne://join?v=9'))), L[1]);
      assert.strictEqual(errText(thr(() => Turn.normalize({ provider: 'metered', app: '', apiKey: 'k' }))), L[2]);
      assert.strictEqual(errText(thr(() => Turn.normalize({ provider: 'manual', urls: 'http://x' }))), L[3]);
      assert.strictEqual(errText(thr(() => Vc.create(gid, by, 'c'.repeat(16), '   ', false, [], 1))), L[4]);
      assert.strictEqual(errText(thr(() => Pv.create({}, by, Pv.newId(by), 'x', '12', 1))), L[5]);
      assert.strictEqual(wb.open('ftp://x').err, L[6]); assert.strictEqual(wb.open('https://a.test').err, L[7]);
    }
    // .message tetap Indonesia (log dan tes lama)
    await w.call('setSettings', { lang: null });
    assert.strictEqual(thr(() => Invite.parse('halo tanpa tautan')).message, 'Tidak ada tautan undangan (archne://join?...) di teks itu');
    // batas dengan parameter angka + kode pemilik/izin
    const full = {}; for (let i = 0; i < 3; i++) { const id = Pv.newId(by); Pv.create(full, by, id, 'c' + i, null, i + 1); }
    assert.strictEqual(errText(thr(() => Pv.create(full, by, Pv.newId(by), 'x', null, 9))), 'You already have 3 channels. Delete one first');
    const ch = Vc.create(gid, by, 'd'.repeat(16), 'Room', false, [], 1);
    assert.strictEqual(errText(thr(() => Vc.remove(gid, 'b'.repeat(16), ch.id, 2))), 'Only the channel creator or an admin can delete it');
    assert.strictEqual(errText(thr(() => Vc.remove(gid, by, 'e'.repeat(16), 2))), 'Channel not found');
    // err hasil Turn.ice() mengikuti bahasa SAAT dikembalikan (gagal yang sama, tanpa mengambil ulang)
    let now = 1e9; const reqs = [];
    const t = Turn.createTurn({ https: async (o) => { reqs.push(o); return { status: 401, body: '' }; }, now: () => now });
    t.set({ provider: 'cloudflare', keyId: 'k1', token: 'tok' });
    assert.strictEqual((await t.ice()).err, 'The Cloudflare token was rejected');
    await w.call('setSettings', { lang: 'id' });
    assert.strictEqual((await t.ice()).err, 'Token Cloudflare ditolak'); assert.strictEqual(reqs.length, 1, 'jeda: tidak menghujani penyedia');
    await w.call('setSettings', { lang: null });
    const t2 = Turn.createTurn({ https: async () => ({ status: 503, body: '' }), now: () => now }); t2.set({ provider: 'metered', app: 'abc', apiKey: 'k' });
    assert.strictEqual((await t2.ice()).err, 'Metered responded with 503');
    const t3 = Turn.createTurn({ https: async () => ({ status: 200, body: '{bad' }), now: () => now }); t3.set({ provider: 'metered', app: 'abc', apiKey: 'k' });
    assert.strictEqual((await t3.ice()).err, 'The TURN provider response could not be read');
    // sisa 'new Error(' di kelima berkas hanya validasi internal (kelas I)
    const left = { 'archne-invite.js': 0, 'archne-turn.js': 1, 'archne-vchan.js': 3, 'archne-pvch.js': 3, 'archne-webbrowser.js': 0 };
    for (const f of Object.keys(left)) {
      const c = (fs.readFileSync(path.join(root, 'src', f), 'utf8').match(/^[^/\n]*new Error\(/gm) || []).length;
      assert.strictEqual(c, left[f], f + ': sisa new Error polos (kelas I) harus ' + left[f] + ', ada ' + c);
    }
    // label sematan pesan suara (archne-pin-sync.js) ikut terkirim ke peer: English tetap, tidak berganti bahasa
    assert(fs.readFileSync(path.join(root, 'src', 'core', 'archne-pin-sync.js'), 'utf8').includes("PIN_VOICE_LABEL = '🎤 Voice message'") && !/'🎤 Pesan suara'/.test(fs.readFileSync(path.join(root, 'src', 'core', 'archne-pin-sync.js'), 'utf8')), 'pin-sync: label suara English');
    ok('E9e: undangan, TURN (err mengikuti bahasa saat dikembalikan), channel grup/publik, peramban web; en/id; .message tetap Indonesia');
  }

  // ---- 3k. E10: main.js (judul dialog native, notifikasi panggilan) dan src/archne-rpc.js (respons yang tampil ke pengguna) ----
  {
    // main.js butuh Electron: dicek statis. Tidak ada lagi judul/filter/notifikasi Indonesia polos; semua lewat I18N.tr('e.native.*').
    const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    for (const old of ["title: 'Kirim berkas'", "title: 'Kirim folder'", "title: 'Ekspor halaman'", "title: 'Impor halaman'", "title: 'Simpan ke folder'", "name: 'Arsip Halaman Archne'", "name: 'Semua berkas'", "'Panggilan video masuk' :", "|| 'Seseorang'"]) assert(!mainSrc.includes(old), 'main.js masih memuat teks polos: ' + old);
    const used = new Set([...mainSrc.matchAll(/I18N\.tr\('(e\.native\.\w+)'/g)].map((x) => x[1]));
    assert.deepStrictEqual([...used].sort(), ['e.native.allFiles', 'e.native.callVideo', 'e.native.callVoice', 'e.native.exportPage', 'e.native.importPage', 'e.native.pageArchive', 'e.native.saveToFolder', 'e.native.sendFile', 'e.native.sendFolder', 'e.native.someone']);
    // archne-rpc.js: 401 tanpa token + pesan Android 'openDownloads', en lalu id (Core headless = Core terakhir dibuat = sumber bahasa)
    const { startHeadless } = require('../src/archne-headless'), http = require('http');
    const app = await startHeadless({ dataDir: path.join(tmp, 'RPC'), downloadDir: path.join(tmp, 'RPC-dl'), name: 'R', canOpenFolder: false });
    const get = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: app.rpc.port, path: p }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(c).toString() })); }).on('error', rej));
    const post = (p) => new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port: app.rpc.port, method: 'POST', path: p, headers: { 'content-type': 'application/json', cookie: 'lc=' + app.rpc.token } }, (x) => { const c = []; x.on('data', (d) => c.push(d)); x.on('end', () => res(JSON.parse(Buffer.concat(c).toString()))); }); r.on('error', rej); r.end('[]'); });
    const tokenOf = app.rpc.url().match(/t=([0-9a-f]+)/)[1]; app.rpc.token = tokenOf;
    let g = await get('/'); assert.strictEqual(g.status, 401); assert(/Open this through the link that contains the token/.test(g.body), g.body);
    let d = await post('/rpc/openDownloads'); assert(d.err.startsWith('Received files are copied to the device\u2019s Download folder'), JSON.stringify(d));
    app.core.setSettings({ lang: 'id' });
    g = await get('/'); assert(/buka lewat tautan yang berisi token/.test(g.body), g.body);
    d = await post('/rpc/openDownloads'); assert(/Berkas yang diterima disalin ke folder Download perangkat/.test(JSON.stringify(d)), JSON.stringify(d));
    await app.stop();
    require('../src/core/archne-i18n-node').bind(() => core.getSettings().lang);
    ok('E10: main.js tanpa teks native polos (10 kunci e.native.*); archne-rpc.js: 401 tanpa token dan openDownloads berganti bahasa (en/id)');
  }

  // ---- 4. dxcard: peta kode (terjemahan) lebih dulu dari it.err (Indonesia dari Core) ----
  assert(/const whyText = \(it\) => esc\(CODE_TEXT\[it\.code\] \|\| it\.err/.test(fs.readFileSync(path.join(root, 'renderer', 'archne-dxcard.js'), 'utf8')), 'dxcard.whyText: CODE_TEXT sebelum it.err');
  ok('dxcard.whyText mendahulukan peta kode');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log(pass + ' tes i18nipc OK');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

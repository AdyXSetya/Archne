'use strict';
// Tes foto (v0.25.0 Step 1), sisi Core dan IPC: pemeriksaan byte gambar, mediaRead, unduh otomatis (syarat dan pengecualiannya),
// pengaturan autoImg, serta sendFile/mediaPrep lewat IPC (info media dari renderer tidak dipercaya).
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const MC = require('../src/archne-mediacheck');
const O = require('../src/archne-fileoffer');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-mediasend-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150, escBackoff: 0.02 }, o));
const msg = (c, id) => c.getState().messages.find((x) => x.id === id);
const f = (n) => path.join(tmp, n);

// ---- gambar buatan (hanya header yang sah; cukup untuk uji pemeriksaan) ----
function jpeg(w, h, bytes) {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
  const head = Buffer.from([0xff, 0xd8]), end = Buffer.from([0xff, 0xd9]);
  const pad = Math.max(0, (bytes || 0) - head.length - sof.length - end.length - 4);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, (pad + 2) >> 8, (pad + 2) & 255]), Buffer.alloc(pad, 0x41)]);
  return Buffer.concat([head, pad ? com : Buffer.alloc(0), sof, end]);
}
function png(w, h, extra) {
  const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 2;
  return Buffer.concat([b, Buffer.alloc(extra || 0, 7)]);
}
function gif(w, h) { const b = Buffer.alloc(20); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; }
function webpX(w, h) { const b = Buffer.alloc(30); b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(22, 4); b.write('WEBPVP8X', 8, 'latin1'); b.writeUInt32LE(10, 16); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; }
function webpL(w, h) { const b = Buffer.alloc(30); b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(22, 4); b.write('WEBPVP8L', 8, 'latin1'); b[20] = 0x2f; const v = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14); b.writeUInt32LE(v >>> 0, 21); return b; }
function webpLossy(w, h) { const b = Buffer.alloc(32); b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(24, 4); b.write('WEBPVP8 ', 8, 'latin1'); b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); return b; }

(async () => {
  // ---- 1. sniffImage ----
  assert.deepStrictEqual(MC.sniffImage(jpeg(640, 480, 2000)), { mime: 'image/jpeg', w: 640, h: 480 });
  assert.deepStrictEqual(MC.sniffImage(png(800, 600)), { mime: 'image/png', w: 800, h: 600 });
  assert.deepStrictEqual(MC.sniffImage(gif(120, 90)), { mime: 'image/gif', w: 120, h: 90 });
  assert.deepStrictEqual(MC.sniffImage(webpX(1000, 500)), { mime: 'image/webp', w: 1000, h: 500 });
  assert.deepStrictEqual(MC.sniffImage(webpL(321, 123)), { mime: 'image/webp', w: 321, h: 123 });
  assert.deepStrictEqual(MC.sniffImage(webpLossy(256, 128)), { mime: 'image/webp', w: 256, h: 128 });
  ok('sniffImage: JPEG, PNG, GIF, WebP (VP8, VP8L, VP8X) dibaca dari header: jenis, lebar, tinggi');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
  for (const [n, b] of [['SVG', svg], ['teks', Buffer.from('halo ini bukan gambar sama sekali')], ['acak', crypto.randomBytes(64)], ['kosong', Buffer.alloc(0)], ['PNG terpotong', png(5, 5).subarray(0, 20)],
    ['PNG 0x0', png(0, 0)], ['GIF 0x0', gif(0, 0)], ['PDF', Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj')], ['EXE', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)])], ['null', null], ['string', 'GIF89a......']]) {
    assert.strictEqual(MC.sniffImage(b), null, n + ' bukan gambar yang diterima');
  }
  assert(MC.pixelsOk({ w: 8000, h: 8000 }) && !MC.pixelsOk({ w: 20000, h: 20000 }) && !MC.pixelsOk(null));
  assert(MC.viewName('a.JPG') && MC.viewName('b.png') && MC.viewName('c.webp') && !MC.viewName('d.svg') && !MC.viewName('e.heic') && !MC.viewName('f.jpg.exe') && !MC.viewName('g'));
  assert(MC.thumbName('a.heic') && MC.thumbName('b.avif') && !MC.thumbName('c.pdf'));
  ok('sniffImage: SVG, teks, acak, PDF, EXE, header terpotong, dimensi 0 ditolak; batas piksel dan daftar ekstensi');

  // ---- 2. dua Core ----
  const A = mk('A'), B = mk('B');
  await A.start(); await B.start();
  await A.addPeer('127.0.0.1', B.port);
  await until(() => A.getState().peers.some((p) => p.online && p.secure) && B.getState().peers.some((p) => p.online && p.secure), 6000, 'A-B online');
  const thumb = jpeg(96, 64, 1200).toString('base64');
  const photo = (name, buf) => { const p = f(name); fs.writeFileSync(p, buf); return p; };
  const saved = (c, id) => { const m = msg(c, id); return !!(m && m.file && m.file.saved); };

  // DM: foto kecil dari LAN diunduh otomatis (bawaan), lalu bisa dibaca penampil
  const real = jpeg(1600, 1200, 30000);
  const m1 = await A.sendFile(photo('dm1.jpg', real), B.id, { media: { k: 'img', w: 1600, h: 1200, th: thumb } });
  await until(() => msg(B, m1.id), 4000, 'B menerima tawaran');
  assert.strictEqual(msg(B, m1.id).file.x.th, thumb);
  await until(() => saved(B, m1.id), 8000, 'unduh otomatis foto DM');
  let r = await B.mediaRead(m1.id);
  assert(r.ok && r.mime === 'image/jpeg' && r.w === 1600 && r.h === 1200 && r.size === real.length && Buffer.from(r.b64, 'base64').equals(real));
  ok('foto DM dari LAN diunduh otomatis (bawaan); mediaRead mengembalikan isi, jenis, dan dimensi dari berkasnya sendiri');

  // pengecualian: tidak otomatis
  const stays = async (m, why, wait = 1200) => { await until(() => msg(B, m.id), 4000, 'tawaran ' + why); await sleep(wait); assert(!saved(B, m.id) && !B._rx.has(m.id), 'tidak otomatis: ' + why); };
  const mPub = await A.sendFile(photo('pub.jpg', jpeg(300, 200, 3000)), 'public', { media: { k: 'img', w: 300, h: 200 } });
  await stays(mPub, 'Publik');
  const mBig = await A.sendFile(photo('big.jpg', Buffer.concat([jpeg(4000, 3000, 100), crypto.randomBytes(9 * 1048576)])), B.id, { media: { k: 'img', w: 4000, h: 3000 } });
  await stays(mBig, 'lebih dari 8 MB');
  const mNoX = await A.sendFile(photo('nox.jpg', jpeg(300, 200, 3000)), B.id);
  await stays(mNoX, 'tanpa info media');
  const mPdf = await A.sendFile(photo('palsu.pdf', Buffer.from('%PDF-1.4 bukan foto')), B.id, { media: { k: 'img', th: thumb } });
  await stays(mPdf, 'nama bukan gambar walau mengaku foto');
  const mVid = await A.sendFile(photo('klip.mp4', crypto.randomBytes(2000)), B.id, { media: { k: 'vid', d: 1000, w: 10, h: 10 } });
  await stays(mVid, 'bukan foto');
  // pengirim bukan LAN
  B.opts.directAllow = () => false;
  const mWan = await A.sendFile(photo('wan.jpg', jpeg(300, 200, 3000)), B.id, { media: { k: 'img', w: 300, h: 200 } });
  await stays(mWan, 'pengirim tidak lewat LAN');
  delete B.opts.directAllow;
  // pesan lama (riwayat tersinkron): tidak diunduh massal
  const mOld = { id: 'c'.repeat(32), from: A.id, to: B.id, ts: Date.now() - 3600e3, kind: 'e1' };
  assert.strictEqual(B._autoImg(mOld), false);
  // diri sendiri dan pemblokiran
  assert.strictEqual(A._autoImg(msg(A, m1.id) && A.store.msgs[m1.id]), false, 'pesan sendiri tidak pernah diunduh');
  ok('tidak otomatis: Publik, > 8 MB, tanpa info media, nama bukan gambar, bukan foto, pengirim non-LAN, pesan lama, pesan sendiri');

  // setelah diketuk (receiveFile), foto Publik tetap bisa dibuka
  await B.receiveFile(mPub.id);
  r = await B.mediaRead(mPub.id);
  assert(r.ok && r.w === 300 && r.h === 200);
  ok('foto yang tidak otomatis tetap bisa diunduh manual lalu dibaca penampil');

  // pengaturan
  assert.deepStrictEqual(B.getSettings().autoImg, { mode: 'lan', def: 'lan', max: 8 * 1048576 });
  assert.strictEqual(B.setSettings({ autoImg: 'off' }).autoImg.mode, 'off');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(B.opts.dataDir, 'settings.json'), 'utf8')).autoImg, 'off');
  const mOff = await A.sendFile(photo('off.jpg', jpeg(300, 200, 3000)), B.id, { media: { k: 'img', w: 300, h: 200 } });
  await stays(mOff, 'pengaturan mati');
  for (const bad of ['on', 'always', 1, true, {}, []]) assert.deepStrictEqual(B.setSettings({ autoImg: bad }), { ok: false, code: 'bad', key: 'autoImg' }, JSON.stringify(bad));
  assert.strictEqual(B.getSettings().autoImg.mode, 'off', 'nilai tidak sah tidak mengubah apa pun');
  assert.strictEqual(B.setSettings({ autoImg: null }).autoImg.mode, 'lan');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(B.opts.dataDir, 'settings.json'), 'utf8')).autoImg, undefined, 'bawaan: kuncinya dibuang');
  assert.strictEqual(B.setSettings({ autoImg: 'off' }).ok !== false && B.setSettings({ autoImg: 'lan' }).autoImg.mode, 'lan');
  ok('pengaturan autoImg: bawaan lan, off mematikan, nilai tidak sah ditolak, kembali ke bawaan membuang kuncinya');
  await B.stop(); // muat ulang: pilihan 'off' bertahan
  const B2 = mk('B'); await B2.start(); B2.setSettings({ autoImg: 'off' }); await B2.stop();
  const B3 = mk('B'); await B3.start(); assert.strictEqual(B3.getSettings().autoImg.mode, 'off'); await B3.stop();
  ok('pilihan autoImg tersimpan di settings.json dan dibaca lagi saat Core dimulai');

  // ---- 3. mediaRead menolak yang bukan foto ----
  const C = mk('C'), D = mk('D');
  await C.start(); await D.start();
  await C.addPeer('127.0.0.1', D.port);
  await until(() => C.getState().peers.some((p) => p.online && p.secure) && D.getState().peers.some((p) => p.online && p.secure), 6000, 'C-D online');
  D.setSettings({ autoImg: 'off' });
  const dl = async (m, from = C, to = D) => { await until(() => msg(to, m.id), 4000, 'tawaran'); await to.receiveFile(m.id); };
  assert.deepStrictEqual((await D.mediaRead('zz')).code, 'bad');
  assert.strictEqual((await D.mediaRead('d'.repeat(32))).code, 'gone', 'id tidak dikenal');
  const mFake = await C.sendFile(photo('palsu.jpg', Buffer.from('ini teks biasa yang menyamar sebagai foto')), D.id, { media: { k: 'img', th: thumb } });
  await until(() => msg(D, mFake.id), 4000, 'tawaran palsu');
  assert.strictEqual((await D.mediaRead(mFake.id)).code, 'gone', 'belum diunduh');
  await dl(mFake);
  r = await D.mediaRead(mFake.id);
  assert(r.ok === false && r.code === 'notimg' && !r.b64, 'berkas yang menyamar sebagai foto ditolak dari isinya');
  const mSvg = await C.sendFile(photo('gambar.svg', svg), D.id, { media: { k: 'img', th: thumb } }); await dl(mSvg);
  assert.strictEqual((await D.mediaRead(mSvg.id)).code, 'notimg', 'SVG tidak masuk penampil (ekstensi)');
  const mHeic = await C.sendFile(photo('foto.heic', crypto.randomBytes(500)), D.id, { media: { k: 'img', th: thumb } }); await dl(mHeic);
  assert.strictEqual((await D.mediaRead(mHeic.id)).code, 'notimg');
  const mPix = await C.sendFile(photo('raksasa.png', png(20000, 20000, 200)), D.id, { media: { k: 'img', th: thumb } }); await dl(mPix);
  assert.strictEqual((await D.mediaRead(mPix.id)).code, 'big', 'terlalu banyak piksel');
  const mExt = await C.sendFile(photo('ok.png', png(10, 10, 100)), D.id); await dl(mExt);
  assert((await D.mediaRead(mExt.id)).ok, 'foto dari versi lama (tanpa x) tetap bisa dilihat: yang menentukan isinya');
  // berkas hasil unduhan dihapus pengguna
  fs.rmSync(D.store.got[mExt.id].path);
  assert.strictEqual((await D.mediaRead(mExt.id)).code, 'gone');
  // milik sendiri: tidak dibaca lewat jalur ini
  assert.strictEqual((await C.mediaRead(mExt.id)).code, 'gone');
  ok('mediaRead: berkas palsu, SVG, HEIC, gambar raksasa, id buruk/tidak dikenal, belum diunduh, sudah dihapus ditolak dengan kode jelas; foto tanpa x tetap lolos');

  // ---- 4. IPC: sendFile dengan info media, mediaPrep ----
  const handlers = {}, logs = [];
  register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core: C, shell: {}, send: () => {}, log: (s) => logs.push(s), pickFiles: async () => [] });
  const call = (n, ...a) => handlers[n]({}, ...a);
  const send = async (job, src, to, media) => { const r = await call('sendFile', job, src, to, media); if (r.ok) await until(() => msg(C, r.id), 3000, 'pesan'); return r; };
  let rr = await send('jobA1', photo('ipc1.jpg', jpeg(500, 300, 4000)), D.id, { k: 'img', w: 500, h: 300, th: thumb });
  assert(rr.ok && msg(C, rr.id).file.x.th === thumb, 'info media sah ikut tawaran');
  rr = await send('jobA2', photo('ipc2.jpg', jpeg(500, 300, 4000)), D.id, { k: 'img', th: 'bukan base64!' });
  assert(rr.ok && msg(C, rr.id).file.x === undefined, 'info media tidak sah dibuang, berkas tetap terkirim');
  rr = await send('jobA3', photo('ipc3.jpg', jpeg(500, 300, 4000)), D.id, { k: 'vc', d: 3000 });
  assert(rr.ok && msg(C, rr.id).file.x === undefined, 'voice chat lewat jalur berkas dibuang');
  rr = await send('jobA4', photo('ipc4.jpg', jpeg(500, 300, 4000)), 'public', { k: 'img', th: jpeg(100, 100, 5000).toString('base64') });
  assert(rr.ok && msg(C, rr.id).file.x === undefined, 'thumbnail DM terlalu besar untuk Publik: dibuang');
  for (const [i, bad] of [[5, 'img'], [6, 12], [7, ['img']], [8, null]]) { rr = await send('jobA' + i, photo('ipc' + i + '.jpg', jpeg(50, 50, 500)), D.id, bad); assert(rr.ok && msg(C, rr.id).file.x === undefined, 'bentuk aneh: ' + JSON.stringify(bad)); }
  assert(logs.some((l) => /info media dibuang/.test(l)));
  ok('IPC sendFile: info media sah ikut; tidak sah/voice/terlalu besar untuk Publik/bentuk aneh dibuang tanpa menggagalkan pengiriman');

  const prep = await call('mediaPrep', f('ipc1.jpg'));
  assert(prep.ok && prep.mime === 'image/jpeg' && prep.w === 500 && prep.h === 300 && Buffer.from(prep.b64, 'base64').equals(fs.readFileSync(f('ipc1.jpg'))));
  assert.strictEqual((await call('mediaPrep', 'relatif/foto.jpg')).ok, false);
  assert.strictEqual((await call('mediaPrep', 42)).ok, false);
  assert.strictEqual((await call('mediaPrep', f('tidakada.jpg'))).ok, false);
  assert.strictEqual((await call('mediaPrep', tmp)).ok, false, 'folder');
  assert.strictEqual((await call('mediaPrep', f('palsu.pdf'))).ok, false, 'ekstensi bukan gambar');
  assert.strictEqual((await call('mediaPrep', f('palsu.jpg'))).ok, false, 'isi bukan gambar');
  assert.strictEqual((await call('mediaPrep', f('gambar.svg'))).ok, false, 'SVG');
  const huge = photo('besar.png', png(20000, 20000, 100)); assert.strictEqual((await call('mediaPrep', huge)).ok, false, 'terlalu banyak piksel');
  ok('IPC mediaPrep: hanya path absolut berkas biasa berekstensi gambar yang isinya benar-benar gambar dan tidak raksasa');

  const rd = await call('mediaRead', m1.id);
  assert.strictEqual(rd.ok, false, 'C tidak punya m1 sebagai penerima');
  await C.stop(); await D.stop(); await A.stop();
  console.log('\nOK: ' + pass + ' kelompok');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

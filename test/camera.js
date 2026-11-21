'use strict';
// Tes kamera (v0.25.0 Step 3): hitungan murni, captureSave (IPC), kartu dengan thumbnail video, alur antarmuka dengan DOM palsu, dan kontrak.
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), assert = require('assert');
const Cam = require('../renderer/archne-camera'), Media = require('../renderer/archne-media'), FC = require('../renderer/archne-filecard'), O = require('../src/archne-fileoffer');
const { register } = require('../src/archne-ipc');
const root = path.join(__dirname, '..');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');

(async () => {
  // ---- 1. hitungan murni ----
  assert.deepStrictEqual(Cam.pickRecMime((m) => m.startsWith('video/webm')), { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' });
  assert.strictEqual(Cam.pickRecMime((m) => m === 'video/mp4').ext, 'mp4'); assert.strictEqual(Cam.pickRecMime(() => true).ext, 'mp4', 'MP4 diutamakan (durasi di header)');
  assert.strictEqual(Cam.pickRecMime(() => false), null); assert.strictEqual(Cam.pickRecMime(() => { throw new Error('x'); }), null); assert.strictEqual(Cam.pickRecMime(null), null);
  const d = new Date(2026, 10, 16, 14, 30, 5);
  assert.strictEqual(Cam.shotName('img', d, 'mp4'), 'IMG_20261116_143005.jpg', 'foto selalu .jpg'); assert.strictEqual(Cam.shotName('vid', d, 'mp4'), 'VID_20261116_143005.mp4'); assert.strictEqual(Cam.shotName('vid', d, '../x'), 'VID_20261116_143005.webm', 'ekstensi aneh -> webm');
  assert(/^IMG_\d{8}_\d{6}\.jpg$/.test(Cam.shotName('img', 'bukan tanggal')));
  const cp = Cam.constraints('photo', 'environment'), cv = Cam.constraints('video', 'user');
  assert(cp.audio === false && cp.video.facingMode.ideal === 'environment' && cp.video.width.ideal === 1920, 'foto: tanpa mikrofon');
  assert(cv.audio && cv.video.facingMode.ideal === 'user' && cv.video.height.ideal === 720 && cv.video.frameRate.max === 30, 'video: 720p 30fps dengan mikrofon'); assert.strictEqual(Cam.constraints('photo', 'aneh').video.facingMode.ideal, 'environment');
  assert.deepStrictEqual(Cam.photoDims(4000, 3000), { w: 2560, h: 1920 }); assert.deepStrictEqual(Cam.photoDims(1280, 720), { w: 1280, h: 720 }, 'tidak diperbesar'); assert.strictEqual(Cam.photoDims(0, 5), null); assert.strictEqual(Cam.photoDims(NaN, 5), null);
  assert.deepStrictEqual(Cam.buildX('img', { w: 640, h: 480, th: 'QUJD' }), { k: 'img', w: 640, h: 480, th: 'QUJD' });
  assert.deepStrictEqual(Cam.buildX('vid', { w: 1280, h: 720, d: 7432.6 }), { k: 'vid', w: 1280, h: 720, d: 7433 });
  assert.deepStrictEqual(Cam.buildX('img', { w: -1, h: 1e9, d: 5, th: '' }), { k: 'img' }, 'nilai tidak sah dibuang; foto tanpa durasi'); assert.deepStrictEqual(Cam.buildX('vid', { d: 0 }), { k: 'vid' });
  for (const [k, o, to] of [['img', { w: 1920, h: 1080, th: 'QUJD' }, 'public'], ['vid', { w: 1280, h: 720, d: 119000, th: 'QUJD' }, '0123456789abcdef']]) { const x = Cam.buildX(k, o); const c = O.checkX(Object.assign({}, x, { th: undefined }), to); assert(c.ok, JSON.stringify(c)); }
  assert.strictEqual(Cam.fmtClock(0), '0:00'); assert.strictEqual(Cam.fmtClock(65999), '1:05'); assert.strictEqual(Cam.fmtClock(-5), '0:00'); assert.strictEqual(Cam.fmtClock('x'), '0:00');
  assert(!Cam.shouldStop(1000, 1000) && Cam.shouldStop(Cam.VIDEO_MAX_MS, 0) && Cam.shouldStop(0, Cam.REC_BYTES_MAX) && Cam.REC_BYTES_MAX < 64 * 1048576);
  const mp4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]), webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]), jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert(Cam.looksRight('img', 'jpg', jpg) && Cam.looksRight('vid', 'mp4', mp4) && Cam.looksRight('vid', 'webm', webm) && !Cam.looksRight('vid', 'mp4', webm) && !Cam.looksRight('img', 'jpg', mp4) && !Cam.looksRight('img', 'jpg', null) && !Cam.looksRight('vid', 'mp4', Buffer.alloc(4)));
  assert.strictEqual(Media.thumbFrom(null, 10, 10, 'public'), null); assert.strictEqual(Media.thumbFrom({}, 0, 10, 'public'), null);
  ok('hitungan murni: format rekam (MP4 dulu), nama berkas, syarat kamera, ukuran foto, info media lolos checkX, penghentian rekaman, tanda tangan isi');

  // ---- 2. IPC captureSave ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-')), handlers = {};
  register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core: { opts: { dataDir: dir }, on() {}, off() {} }, shell: {}, send: () => {}, log: () => {}, pickFiles: async () => [] });
  const save = (...a) => handlers.captureSave({}, ...a);
  let r = await save('IMG_1.jpg', jpg); assert(r.ok && r.path.startsWith(path.join(dir, 'capture')) && /cap-[0-9a-f]{16}\.jpg$/.test(r.path) && fs.readFileSync(r.path).equals(jpg), JSON.stringify(r));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(r.path).mode & 0o077, 0, 'izin hanya pemilik'); // Windows tidak punya bit izin POSIX (selalu 0o666)
  r = await save('VID.mp4', new Uint8Array(mp4)); assert(r.ok && /\.mp4$/.test(r.path), 'Uint8Array dari renderer');
  r = await save('v.webm', mp4.buffer.slice(mp4.byteOffset, mp4.byteOffset + 12)); assert(!r.ok, 'ArrayBuffer MP4 diberi nama .webm: isi tidak cocok');
  for (const [n, b, why] of [['x.exe', jpg, 'ekstensi'], ['x.jpg', mp4, 'isi tidak cocok'], ['x.jpg', Buffer.alloc(3), 'terlalu kecil'], ['x.jpg', 'teks', 'bukan byte'], ['../../x.jpg', 'teks', 'traversal'], [null, jpg, 'tanpa nama'], ['x.mp4', Buffer.concat([mp4, Buffer.alloc(64 * 1048576)]), 'terlalu besar']]) { r = await save(n, b); assert(!r.ok && r.err, why); }
  r = await save('../../../etc/evil.jpg', jpg); assert(r.ok && path.dirname(r.path) === path.join(dir, 'capture'), 'nama dari renderer tidak dipakai untuk jalur: tetap di folder capture');
  const old = path.join(dir, 'capture', 'cap-' + '0'.repeat(16) + '.jpg'), keep = path.join(dir, 'capture', 'catatan.txt'); fs.writeFileSync(old, jpg); fs.writeFileSync(keep, 'x'); const past = new Date(Date.now() - 15 * 864e5); fs.utimesSync(old, past, past); fs.utimesSync(keep, past, past);
  await save('a.jpg', jpg); assert(!fs.existsSync(old) && fs.existsSync(keep), 'hasil lebih dari 14 hari disapu; berkas lain tidak disentuh');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('captureSave: byte jadi berkas acak di dataDir/capture (0600), ekstensi tetap, isi diperiksa, ukuran dibatasi, nama tidak jadi jalur, sapu 14 hari');

  // ---- 3. kartu: thumbnail video ----
  const th = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 64, 0, 96, 1, 1, 0x11, 0, 0xff, 0xd9]).toString('base64'), ID = 'ab'.repeat(16), DM = '0123456789abcdef';
  const card = (file, to) => FC.cardHtml({ id: ID, to: to || DM, file: Object.assign({ name: 'VID_1.mp4', size: 9e6, psize: 9e6, mode: 'raw', x: { k: 'vid', w: 1280, h: 720, d: 83000, th } }, file) }, {});
  let h = card({}); assert(h.includes('data:image/jpeg;base64,') && h.includes('data-act="recv"') && h.includes('fthp') && h.includes('1:23') && h.includes('fcimg') && h.includes('aria-label="Unduh video'), 'belum diunduh: thumbnail + durasi + unduh');
  h = card({ saved: { name: 'VID_1.mp4' } }); assert(h.includes('class="fth play"') && h.includes('data-act="play"') && h.includes('aria-label="Putar video'), 'tersimpan: ketuk memutar');
  h = card({ mine: true }); assert(h.includes('1:23') && !h.includes('fthp') && !/class="fth (recv|play)"/.test(h), 'milik sendiri: thumbnail polos tanpa ikon aksi');
  assert(!card({ name: 'film.mkv' }).includes('data:image'), 'bukan format pemutar: tanpa thumbnail'); assert(!card({ name: 'VID_1.mp4.exe' }).includes('data:image'), 'berisiko: tanpa thumbnail');
  assert(!card({ x: { k: 'vid', th: 'bukan base64!!' } }).includes('data:image') && !card({ x: { k: 'aud', th } }).includes('data:image'), 'th tidak sah / jenis lain: tidak tampil');
  assert(card({ x: { k: 'vid', w: 1, h: 1, d: -5, th } }).includes('data:image') && !card({ x: { k: 'vid', d: -5, th } }).includes('fthd'), 'durasi tidak sah tidak ditampilkan');
  h = card({ name: 'a"<b>.mp4' }); assert(!h.includes('<b>'), 'nama di-escape');
  ok('kartu video: thumbnail + lencana putar + durasi; unduh/putar sesuai status; ekstensi aneh, base64 rusak, jenis lain tidak tampil');

  // ---- 4. alur antarmuka dengan DOM palsu ----
  const els = {}, hist = [], toasts = [], sent = [], saved = [], asks = [], gums = [], recs = [];
  const mk = (id) => ({ id, textContent: '', style: {}, onclick: null, srcObject: null, videoWidth: 1280, videoHeight: 720, width: 0, height: 0, classList: { _s: new Set(), add(c) { if (!c) throw new Error('kelas kosong'); this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); } },
    play() { return Promise.resolve(); }, pause() {}, removeAttribute() {}, getContext: () => ({ drawImage() {}, fillRect() {} }), toBlob(cb, type) { cb(new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3])], { type })); }, toDataURL: () => 'data:image/jpeg;base64,QUJD' });
  const $ = (id) => els[id] || (els[id] = mk(id));
  const track = () => ({ stopped: false, stop() { this.stopped = true; } });
  let denyCam = false, electron = true, gumFail = null, tracks = [];
  class MR { constructor(s, o) { this.s = s; this.o = o; this.state = 'inactive'; recs.push(this); } start() { this.state = 'recording'; setTimeout(() => this.ondataavailable && this.ondataavailable({ data: new Blob([Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 9, 9])]) }), 5); } stop() { this.state = 'inactive'; setTimeout(() => this.onstop && this.onstop(), 5); } static isTypeSupported(m) { return m === 'video/mp4'; } }
  const ctx = {
    $, S: { call: null, messages: [], sending: [] }, cur: '0123456789abcdef', jobN: 0, toast: (t) => toasts.push(t), refresh: async () => {}, callCtl: { cur: null }, playerStop() {}, canFlipCam: () => true, Camera: Cam, Media: Object.assign({}, Media, { thumbFrom: () => 'QUJD' }),
    nbridge: { ask: async (a) => { asks.push(a); return denyCam ? { ok: false, res: 'denied' } : { ok: true, res: 'granted' }; } }, MediaRecorder: MR, Blob, File, Uint8Array, setTimeout, setInterval, clearInterval, console,
    URL: { createObjectURL: () => 'blob:v', revokeObjectURL() {} }, document: { createElement: () => mk('cv'), addEventListener() {} },
    navigator: { mediaDevices: { getUserMedia: async (c) => { gums.push(c); if (gumFail) { const e = new Error('x'); e.name = gumFail; throw e; } const t = [track()]; tracks.push(t); return { getTracks: () => t }; } } },
    window: { history: { pushState: (s) => hist.push(s), back: () => { hist.pop(); ctx.cameraPop(); } }, api: { sendFile: async (job, src, to, media) => { sent.push({ job, src, to, media }); return { ok: true }; } } },
  };
  Object.defineProperty(ctx.window.api, 'captureSave', { get: () => (electron ? async (n, b) => { saved.push([n, b.length]); return { ok: true, path: '/data/capture/cap-1.' + n.split('.').pop() }; } : undefined) });
  vm.createContext(ctx); vm.runInContext(require('./_src').txfJs() + '\n' + rd('renderer/js/archne-camera.js') + '\nglobalThis.__t = { openCamera, closeCamera, cameraOpen, cmSend };', ctx);
  const T = ctx.__t, cls = (c) => $('cam').classList.contains(c);
  // izin ditolak
  denyCam = true; await T.openCamera(); assert(T.cameraOpen() && !gums.length && $('cmm').textContent.includes('Izin'), 'izin ditolak: pesan, kamera tidak dibuka'); T.closeCamera(); assert(!T.cameraOpen() && hist.length === 0 && !cls('on')); denyCam = false;
  // foto (Electron)
  asks.length = 0; await T.openCamera(); assert(T.cameraOpen() && cls('on') && cls('live') && asks.join() === 'cam' && gums.length === 1 && gums[0].audio === false && hist.length === 1, 'foto: hanya izin kamera, satu entri riwayat');
  $('cmshot').onclick(); await sleep(20); assert(cls('shot') && !cls('live') && tracks[tracks.length - 1][0].stopped, 'jepret: tinjau, kamera dilepas');
  $('cmredo').onclick(); await sleep(20); assert(cls('live') && !cls('shot') && gums.length === 2, 'ulangi: kamera dibuka lagi');
  $('cmshot').onclick(); await sleep(20); await $('cmsend').onclick(); await sleep(30);
  assert(sent.length === 1 && /^\/data\/capture\/cap-1\.jpg$/.test(sent[0].src) && sent[0].media.k === 'img' && sent[0].media.w === 1280 && sent[0].media.th === 'QUJD' && saved[0][0].endsWith('.jpg') && /^IMG_\d{8}_\d{6}\.jpg$/.test(saved[0][0]) && !T.cameraOpen() && hist.length === 0, 'Electron: captureSave lalu sendFile(path, media)');
  // foto (Android/peramban: File)
  electron = false; await T.openCamera(); $('cmshot').onclick(); await sleep(20); await $('cmsend').onclick(); await sleep(30);
  assert(sent.length === 2 && sent[1].src instanceof File && sent[1].src.name.endsWith('.jpg') && sent[1].src.type === 'image/jpeg' && sent[1].media.k === 'img', 'Android: File dikirim, api-http yang mengunggah'); electron = true;
  // video
  asks.length = 0; await T.openCamera(); $('cmmv').onclick(); await sleep(20); assert(asks.join() === 'cam,cam,mic' && gums[gums.length - 1].audio && cls('vid'), 'video: izin kamera dan mikrofon');
  $('cmshot').onclick(); assert(cls('rec') && recs.length === 1 && recs[0].o.mimeType === 'video/mp4' && recs[0].o.videoBitsPerSecond === 2000000, 'rekam: MP4, bitrate tetap');
  await sleep(700); $('cmshot').onclick(); await sleep(40); assert(cls('vrev') && !cls('rec') && !cls('live'), 'berhenti: tinjau rekaman');
  await $('cmsend').onclick(); await sleep(30);
  const v = sent[2]; assert(v && /\.mp4$/.test(v.src) && v.media.k === 'vid' && v.media.d >= 600 && v.media.d < 5000 && v.media.th === 'QUJD' && v.media.w === 1280 && /^VID_\d{8}_\d{6}\.mp4$/.test(saved[saved.length - 1][0]), JSON.stringify(v));
  // ditutup saat merekam: semua dilepas, tidak ada pengiriman
  await T.openCamera(); $('cmmv').onclick(); await sleep(20); $('cmshot').onclick(); const nSent = sent.length; T.closeCamera(); await sleep(40);
  assert(!T.cameraOpen() && recs[recs.length - 1].state === 'inactive' && tracks[tracks.length - 1][0].stopped && sent.length === nSent, 'tutup saat merekam: berhenti, kamera dilepas, tidak terkirim');
  // galat kamera, panggilan, isi tidak valid
  gumFail = 'NotFoundError'; await T.openCamera(); assert($('cmm').textContent.includes('tidak ditemukan')); T.closeCamera(); gumFail = null;
  ctx.S.call = { id: 1 }; await T.openCamera(); assert(!T.cameraOpen() && toasts.some((t) => t.includes('panggilan')), 'saat panggilan: ditolak'); ctx.S.call = null;
  ok('antarmuka: izin ditolak, foto (jepret/ulangi/kirim) via path Electron dan File Android, video (izin mic, MP4, durasi, thumbnail), tutup saat merekam melepas semuanya, galat kamera, tolak saat panggilan');

  // ---- 5. kontrak ----
  const html = rd('renderer/archne-index.html');
  for (const id of ['cam', 'cmt', 'cms', 'cmv', 'cmc', 'cmr', 'cmm', 'cmrec', 'cmmp', 'cmmv', 'cmflip', 'cmshot', 'cmredo', 'cmsend', 'cmx', 'cambtn']) assert(html.includes('id="' + id + '"'), id);
  assert(html.indexOf('archne-media.js') < html.indexOf('archne-camera.js') && html.indexOf('js/archne-player.js') < html.indexOf('js/archne-camera.js') && html.indexOf('js/archne-camera.js') < html.indexOf('js/archne-settings.js') && html.indexOf('js/archne-voice-public.js') < html.indexOf('js/archne-camera.js'), 'urutan skrip');
  assert(/captureSave: \(name, bytes\) => ipcRenderer\.invoke\('captureSave', name, bytes\)/.test(rd('preload.js')) && /api\.captureSave = undefined/.test(rd('renderer/archne-api-http.js')), 'HTTP/Android: tanpa captureSave, hasil kamera dikirim sebagai File');
  assert(/cameraOpen\(\)/.test(rd('renderer/js/archne-render.js')) && /id="cmv" muted playsinline/.test(html), 'Kembali menutup kamera; pratinjau dibisukan (tanpa gema)');
  assert(/android\.permission\.CAMERA/.test(rd('mobile/android/app/src/main/AndroidManifest.xml')) && /RECORD_AUDIO/.test(rd('mobile/android/app/src/main/AndroidManifest.xml')) && /allow="clipboard-write; microphone; camera/.test(rd('mobile/shell/index.html')), 'Android: izin dan iframe sudah mengizinkan kamera/mikrofon');
  ok('kontrak: markup, urutan skrip, captureSave hanya di preload, Kembali, izin Android sudah ada');

  console.log('\nOK: ' + pass + ' kelompok');
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

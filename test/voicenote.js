'use strict';
// Tes pesan suara (v0.25.0 Step 4): hitungan murni, aturan tawaran `vc`, Core.sendVoice (dua Core nyata), IPC sendVoice/captureSave, kartu, alur antarmuka dengan DOM palsu, dan kontrak.
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), assert = require('assert');
const VN = require('../renderer/archne-voicenote'), FC = require('../renderer/archne-filecard'), O = require('../src/archne-fileoffer'), Pack = require('../src/archne-pack');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const root = path.join(__dirname, '..');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); } throw new Error('timeout: ' + label); }
const rej = async (p, re, why) => { let e = null; try { await p; } catch (x) { e = x; } assert(e && re.test(e.message), why + ' (dapat: ' + (e && e.message) + ')'); return e; };
const B_ = (...a) => Buffer.concat(a.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x, 'latin1'))));
const OGG = (n) => B_('OggS', Buffer.alloc(n - 4, 7)), WEBA = (n) => B_([0x1a, 0x45, 0xdf, 0xa3], Buffer.alloc(8, 1), 'webm', Buffer.alloc(n - 16, 3)), M4A = (n) => B_([0, 0, 0, 0x18], 'ftypM4A ', Buffer.alloc(n - 12, 5));
const offerText = (name, size, x) => O.FILE + JSON.stringify({ n: name, m: { v: Pack.FORMAT === undefined ? 1 : Pack.FORMAT, mode: 'raw', size, psize: size, hash: 'a'.repeat(64) }, x });

(async () => {
  // ---- 1. hitungan murni ----
  assert.deepStrictEqual(VN.pickRecMime((m) => m.startsWith('audio/webm')), { mime: 'audio/webm;codecs=opus', ext: 'weba' });
  assert.strictEqual(VN.pickRecMime((m) => m.startsWith('audio/mp4')).ext, 'm4a'); assert.strictEqual(VN.pickRecMime(() => true).ext, 'weba', 'Opus/WebM diutamakan');
  assert.strictEqual(VN.pickRecMime((m) => m === 'audio/ogg;codecs=opus').ext, 'ogg'); assert.strictEqual(VN.pickRecMime(() => false), null); assert.strictEqual(VN.pickRecMime(() => { throw new Error('x'); }), null); assert.strictEqual(VN.pickRecMime(null), null);
  for (const [, ext] of VN.MIMES) assert(O.VC_NAME.test('a.' + ext), 'ekstensi perekam harus lolos VC_NAME: ' + ext);
  const d = new Date(2026, 10, 16, 14, 30, 5);
  assert.strictEqual(VN.fileName(d, 'ogg'), 'suara_20261116_143005.ogg'); assert.strictEqual(VN.fileName(d, 'm4a'), 'suara_20261116_143005.m4a'); assert.strictEqual(VN.fileName(d, '../x'), 'suara_20261116_143005.weba', 'ekstensi dari daftar tetap'); assert(/^suara_\d{8}_\d{6}\.weba$/.test(VN.fileName('bukan tanggal')));
  const c = VN.constraints(); assert(c.video === false && c.audio.echoCancellation && c.audio.noiseSuppression && c.audio.channelCount === 1, 'hanya mikrofon, tanpa video');
  assert(!VN.shouldStop(1000, 1000) && VN.shouldStop(VN.MAX_MS, 0) && VN.shouldStop(0, VN.MAX_BYTES) && VN.MAX_MS === O.VC_MAX_MS && VN.MAX_BYTES < O.VC_MAX_BYTES, 'batas perekam di bawah/sama dengan batas penerima');
  assert(VN.tooShort(0) && VN.tooShort(999) && !VN.tooShort(1000) && VN.tooShort('x') && VN.tooShort(NaN));
  assert.strictEqual(VN.clampDur(4321.6), 4322); assert.strictEqual(VN.clampDur(5), VN.MIN_MS); assert.strictEqual(VN.clampDur(9e9), VN.MAX_MS); assert.strictEqual(VN.clampDur('x'), VN.MIN_MS);
  for (const [bytes, ms] of [[30000, 4000], [VN.MAX_BYTES, VN.MAX_MS], [1, 1000]]) assert.strictEqual(VN.sizeOk(bytes, ms), O.vcSizeOk(bytes, ms), 'cermin fileoffer.vcSizeOk: ' + bytes + '/' + ms);
  assert(!VN.sizeOk(1e6, 1000) && !VN.sizeOk(0, 1000) && !VN.sizeOk(6 * 1048576, 300e3) && !VN.sizeOk(1.5, 1000));
  assert(VN.looksRight('weba', WEBA(40)) && VN.looksRight('ogg', OGG(40)) && VN.looksRight('m4a', M4A(40)) && !VN.looksRight('ogg', WEBA(40)) && !VN.looksRight('weba', M4A(40)) && !VN.looksRight('m4a', OGG(40)) && !VN.looksRight('exe', OGG(40)) && !VN.looksRight('ogg', null) && !VN.looksRight('ogg', Buffer.alloc(5)));
  assert.strictEqual(VN.fmtClock(0), '0:00'); assert.strictEqual(VN.fmtClock(65999), '1:05'); assert.strictEqual(VN.fmtClock(-1), '0:00');
  ok('hitungan murni: format rekam (Opus/WebM dulu, semua ekstensi lolos VC_NAME), nama, hanya mikrofon, batas ≤ batas penerima, kewajaran ukuran sama dengan fileoffer, tanda tangan isi');

  // ---- 2. aturan tawaran vc (sisi penerima tidak percaya klaim) ----
  const DM = '0123456789abcdef';
  assert(O.checkX({ k: 'vc', d: 4000 }, DM).ok, 'vc sah di DM'); assert(!O.checkX({ k: 'vc', d: 4000 }, 'public').ok, 'vc di Publik ditolak');
  assert(!O.checkX({ k: 'vc' }, DM).ok && !O.checkX({ k: 'vc', d: O.VC_MAX_MS + 1 }, DM).ok && !O.checkX({ k: 'vc', d: 1000, w: 1, h: 1 }, DM).ok && !O.checkX({ k: 'vc', d: 1000, th: 'QUJD' }, DM).ok, 'vc: wajib durasi, ≤ 5 menit, tanpa gambar');
  const px = (name, size, x, to) => O.parseOffer(offerText(name, size, x), to || DM);
  let p = px('suara-20261116-143005.weba', 30000, { k: 'vc', d: 4000 }); assert(p && p.x && p.x.k === 'vc' && p.x.d === 4000, JSON.stringify(p));
  assert(px('suara.ogg', 30000, { k: 'vc', d: 4000 }).x && px('SUARA.M4A', 30000, { k: 'vc', d: 4000 }).x, 'ekstensi ogg/m4a/huruf besar');
  for (const [why, q] of [['nama bukan ekstensi suara', px('foto.jpg', 30000, { k: 'vc', d: 4000 })], ['mp3 bukan perekam', px('lagu.mp3', 30000, { k: 'vc', d: 4000 })], ['exe', px('a.exe', 30000, { k: 'vc', d: 4000 })], ['ganda suara.ogg.exe', px('suara.ogg.exe', 30000, { k: 'vc', d: 4000 })],
    ['lebih dari 5 MB', px('s.ogg', O.VC_MAX_BYTES + 1, { k: 'vc', d: 300e3 })], ['tidak wajar untuk durasi (1 MB / 1 dtk)', px('s.ogg', 1e6, { k: 'vc', d: 1000 })], ['di Publik', px('s.ogg', 30000, { k: 'vc', d: 4000 }, 'public')]]) {
    assert(q && !q.x, 'x dibuang: ' + why); assert(q.name && q.meta, 'tawaran tetap sah sebagai berkas biasa: ' + why);
  }
  assert(px('s.ogg', O.VC_MAX_BYTES, { k: 'vc', d: 300e3 }) && px('s.ogg', 0, { k: 'vc', d: 4000 }) && !px('s.ogg', 0, { k: 'vc', d: 4000 }).x, 'berkas kosong: bukan suara');
  const t5 = O.encodeOffer('suara.ogg', { v: 1, mode: 'raw', size: 30000, psize: 30000, hash: 'a'.repeat(64) }, { k: 'vc', d: 4000 }, DM); assert(t5.startsWith(O.FILE), 'encodeOffer menerima vc (dipakai Core.sendVoice)');
  ok('tawaran vc: Publik ditolak, durasi wajib, ukuran ≤ 5 MB dan wajar untuk durasi, nama harus .weba/.ogg/.m4a; selain itu x dibuang dan tampil sebagai berkas biasa');

  // ---- 3. Core.sendVoice dengan dua Core nyata ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-vn-'));
  const mk = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 });
  const A = mk('A'), Bn = mk('B');
  await A.start(); await Bn.start(); await A.addPeer('127.0.0.1', Bn.port);
  await until(() => A.getState().peers.some((q) => q.online) && A._pairKey(Bn.id) && Bn._pairKey(A.id), 6000, 'jaringan dan kunci pasangan');
  const f = (n, b) => { const q = path.join(tmp, n); fs.writeFileSync(q, b); return q; };
  const voice = f('rec.ogg', OGG(2400)); const mA = await A.sendVoice(voice, Bn.id, { durMs: 4000 });
  assert(mA && mA.id, 'terkirim'); await until(() => Bn.store.msgs[mA.id], 5000, 'tawaran sampai');
  const view = (c, id) => c.getState().messages.find((m) => m.id === id);
  const vb = view(Bn, mA.id); assert(vb.file && vb.file.x && vb.file.x.k === 'vc' && vb.file.x.d === 4000 && /^suara-\d{8}-\d{6}\.ogg$/.test(vb.file.name) && vb.text === '🎤 Voice message', JSON.stringify(vb));
  assert.strictEqual(view(A, mA.id).text, '🎤 Voice message', 'pengirim juga melihat label suara');
  assert(fs.readdirSync(path.join(tmp, 'A', 'out')).every((q) => !/suara/.test(q)), 'nama sumber tidak dipakai di mana pun; nama tawaran dibuat Core');
  await until(() => Bn.store.got[mA.id], 6000, 'unduh otomatis voice chat dari LAN'); // _autoImg: voice chat kecil dari kontak LAN diunduh otomatis (tidak pernah diputar otomatis)
  const pl = await Bn.mediaPlay(mA.id); assert(pl.ok && pl.kind === 'aud' && pl.mime === 'audio/ogg', JSON.stringify(pl).slice(0, 200)); assert(Buffer.from(pl.b64, 'base64').equals(OGG(2400)), 'isi sama persis');
  assert.strictEqual(path.dirname(Bn.store.got[mA.id].path), Bn.opts.downloadDir);
  // WebM dan MP4 mendapat ekstensi dari ISI, bukan dari nama sumber
  const mW = await A.sendVoice(f('apa-saja.mp3', WEBA(3000)), Bn.id, { durMs: 5000 }); assert(/\.weba$/.test(view(A, mW.id).file.name), 'isi WebM -> .weba walau sumber bernama .mp3');
  const mM = await A.sendVoice(f('x.bin', M4A(3000)), Bn.id, { durMs: 5000 }); assert(/\.m4a$/.test(view(A, mM.id).file.name));
  // penolakan di pengirim
  await rej(A.sendVoice(voice, 'public', { durMs: 4000 }), /Publik/, 'Publik');
  for (const dm of [100, 400, 300001, NaN, undefined, 'x']) await rej(A.sendVoice(voice, Bn.id, { durMs: dm }), /Durasi/, 'durasi ' + dm);
  await rej(A.sendVoice(f('x1.ogg', B_('MZ', Buffer.alloc(3000))), Bn.id, { durMs: 4000 }), /Format/, 'EXE bernama .ogg');
  await rej(A.sendVoice(f('x2.ogg', B_('ID3\x03\x00\x00\x00\x00\x00\x00', Buffer.alloc(3000))), Bn.id, { durMs: 4000 }), /Format/, 'mp3 bukan hasil perekam');
  await rej(A.sendVoice(f('x3.ogg', OGG(O.VC_MAX_BYTES + 1)), Bn.id, { durMs: 300e3 }), /terlalu besar/, '> 5 MB');
  await rej(A.sendVoice(f('x4.ogg', OGG(1e6)), Bn.id, { durMs: 1000 }), /tidak wajar/, '1 MB untuk 1 detik');
  await rej(A.sendVoice(f('x5.ogg', Buffer.alloc(5)), Bn.id, { durMs: 4000 }), /kosong/, 'terlalu kecil');
  await rej(A.sendVoice(path.join(tmp, 'tidak-ada.ogg'), Bn.id, { durMs: 4000 }), /tidak ditemukan/, 'tidak ada'); await rej(A.sendVoice(tmp, Bn.id, { durMs: 4000 }), /tidak ditemukan/, 'folder');
  await rej(A.sendVoice(voice, 'g:' + 'a'.repeat(16), { durMs: 4000 }), /Grup tidak dikenal/, 'grup tak dikenal'); await rej(A.sendVoice(voice, 'zzz', { durMs: 4000 }), /Tujuan/, 'tujuan aneh'); await rej(A.sendVoice(voice, 'fedcba9876543210', { durMs: 4000 }), /Kunci/, 'peer tanpa kunci');
  await rej(A.sendFile(voice, Bn.id, { media: { k: 'vc', d: 4000 } }), /Voice chat/, 'sendFile tidak boleh membuat vc');
  const nF = Object.keys(A.store.files).length; const e = await rej(A._sendPacked(voice, 'suara.ogg', Bn.id, { k: 'vc', d: 4000 }, { expectSize: 1 }), /berubah/, 'ukuran berubah'); assert.strictEqual(e.code, 'changed'); assert.strictEqual(Object.keys(A.store.files).length, nF, 'tidak ada catatan kiriman tersisa');
  // unduh otomatis hanya untuk pesan baru dari LAN; dimatikan lewat pengaturan yang sama dengan foto
  Bn._settings.autoImg = 'off'; const mO = await A.sendVoice(voice, Bn.id, { durMs: 4000 }); await until(() => Bn.store.msgs[mO.id], 5000, 'sampai'); await sleep(500); assert(!Bn.store.got[mO.id] && !Bn._rx.has(mO.id), 'autoImg off: tidak diunduh otomatis'); Bn._settings.autoImg = 'lan';
  await A.stop(); await Bn.stop(); fs.rmSync(tmp, { recursive: true, force: true });
  ok('Core.sendVoice: DM terkirim dan terunduh otomatis, diputar lewat mediaPlay, ekstensi dari isi, label suara; ditolak: Publik, durasi/ukuran/format salah, tujuan salah, vc lewat sendFile, berkas berubah');

  // ---- 4. IPC ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-')), handlers = {}, calls = [];
  const fakeCore = { opts: { dataDir: dir }, on() {}, off() {}, sendVoice: async (src, to, o) => { calls.push({ src, to, o }); if (o.durMs === 7777) throw Object.assign(new Error('Format rekaman suara tidak dikenal'), { code: 'x' }); return { id: 'm1' }; }, sendFile: async () => ({ id: 'm2' }) };
  register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core: fakeCore, shell: {}, send: () => {}, log: () => {}, pickFiles: async () => [] });
  const rec = path.join(dir, 'rec.weba'); fs.writeFileSync(rec, WEBA(100));
  let r = await handlers.sendVoice({}, 'j1', rec, DM, 4000); assert(r.ok && r.id === 'm1' && calls.length === 1 && calls[0].o.durMs === 4000 && calls[0].to === DM && typeof calls[0].o.signal === 'object', JSON.stringify(r));
  r = await handlers.sendVoice({}, 'j2', rec, 'public', 4000); assert(!r.ok && /Public/.test(r.err) && calls.length === 1, 'Publik ditolak di IPC sebelum menyentuh Core');
  for (const dm of [undefined, '4000', 4000.5, NaN, null]) { r = await handlers.sendVoice({}, 'j3', rec, DM, dm); assert(!r.ok && /duration/.test(r.err), 'durasi ' + dm); }
  r = await handlers.sendVoice({}, 'j4', 'relatif.weba', DM, 4000); assert(!r.ok && /absolut/.test(r.err)); r = await handlers.sendVoice({}, '../j', rec, DM, 4000); assert(!r.ok && /pekerjaan/.test(r.err)); r = await handlers.sendVoice({}, 'j5', dir, DM, 4000); assert(!r.ok);
  r = await handlers.sendVoice({}, 'j6', rec, DM, 7777); assert(!r.ok && /Format/.test(r.err), 'galat Core diteruskan'); assert.strictEqual(calls.length, 2);
  const nVoice = calls.length; r = await handlers.sendFile({}, 'j7', rec, DM, { k: 'vc', d: 4000 }); assert(r.ok && calls.length === nVoice, 'sendFile dengan media vc: dibuang, tetap berkas biasa (tidak lewat sendVoice)');
  const save = (...a) => handlers.captureSave({}, ...a);
  for (const [n, b] of [['a.weba', WEBA(50)], ['a.ogg', OGG(50)], ['a.m4a', M4A(50)]]) { r = await save(n, new Uint8Array(b)); assert(r.ok && new RegExp('cap-[0-9a-f]{16}\\.' + n.split('.')[1] + '$').test(r.path) && fs.readFileSync(r.path).equals(b), n + ' ' + JSON.stringify(r)); }
  for (const [n, b, why] of [['a.ogg', WEBA(50), 'isi tidak cocok'], ['a.weba', OGG(50), 'isi tidak cocok'], ['a.m4a', OGG(50), 'isi tidak cocok'], ['a.ogg', OGG(O.VC_MAX_BYTES + 1), 'suara > 5 MB'], ['a.mp3', OGG(50), 'ekstensi']]) assert(!(await save(n, b)).ok, why);
  r = await save('v.mp4', B_([0, 0, 0, 0x18], 'ftypisom', Buffer.alloc(6 * 1048576))); assert(r.ok, 'video tetap boleh > 5 MB (batas 64 MB)');
  const old = path.join(dir, 'capture', 'cap-' + '0'.repeat(16) + '.ogg'); fs.writeFileSync(old, OGG(50)); const past = new Date(Date.now() - 15 * 864e5); fs.utimesSync(old, past, past); await save('b.ogg', OGG(50)); assert(!fs.existsSync(old), 'sapu 14 hari juga untuk rekaman suara');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('IPC: sendVoice memakai jalur job yang sama, Publik/durasi/path ditolak sebelum Core, sendFile membuang klaim vc, captureSave menerima .weba/.ogg/.m4a (isi dicek, ≤ 5 MB) dan menyapu 14 hari');

  // ---- 5. kartu ----
  const ID = 'ab'.repeat(16), GRP = 'g:' + 'c'.repeat(16);
  const card = (file, to) => FC.cardHtml({ id: ID, to: to || DM, file: Object.assign({ name: 'suara-20261116-143005.weba', size: 30000, psize: 30000, mode: 'raw', x: { k: 'vc', d: 83000 } }, file) }, {});
  let h = card({}); assert(h.includes('title="Pesan suara"') && h.includes('1:23') && h.includes('fcvc') && h.includes('data-act="recv"') && h.includes('title="Unduh suara"') && !h.includes('class="fn"') && !h.includes('suara-2026'), 'belum diunduh: label, durasi, tombol unduh; nama berkas tidak tampil');
  h = card({ saved: { name: 'suara-20261116-143005.weba' } }); assert(h.includes('data-act="play"') && h.includes('title="Putar"') && !h.includes('data-act="open"') && (() => { const mi = FC.menuItems({ id: ID, to: DM, file: { name: 'suara-20261116-143005.weba', size: 30000, mode: 'raw', x: { k: 'vc', d: 83000 }, saved: { name: 'suara-20261116-143005.weba' } } }).map((i) => i.act); return mi.includes('f:show') && !mi.includes('f:open'); })(), 'tersimpan: putar; menu hanya Tampilkan di folder (tanpa buka dengan aplikasi lain)');
  h = card({ mine: true }); assert(h.includes('title="Pesan suara"') || h.includes('aria-label="Pesan suara"')) && (!h.includes('data-act="recv"') && !h.includes('data-act="play"'), 'milik sendiri');
  h = card({ rx: { phase: 'download', done: 100, total: 30000 } }); assert(h.includes('data-act="cancelrx"') && h.includes('fcvc'), 'sedang diunduh: bilah kemajuan');
  assert(FC.hasVc({ name: 'a.ogg', x: { k: 'vc', d: 1000 } }, false) && !FC.hasVc({ name: 'a.mp3', x: { k: 'vc', d: 1000 } }, false) && !FC.hasVc({ name: 'a.ogg', x: { k: 'vc', d: 0 } }, false) && !FC.hasVc({ name: 'a.ogg', x: { k: 'vc', d: 1000 } }, true) && !FC.hasVc({ name: 'a.ogg', x: { k: 'aud', d: 1000 } }, false) && !FC.hasVc({ name: 'a.ogg' }, false));
  for (const fl of [{ name: 'lagu.mp3' }, { name: 'suara.ogg.exe' }, { x: { k: 'vc', d: -5 } }, { x: { k: 'vc' } }, { x: { k: 'vc', d: 1.5 } }]) assert(!card(fl).includes('fcvc'), 'klaim vc tidak sah: kartu biasa ' + JSON.stringify(fl));
  assert(card({ name: 'a"<b>.ogg', x: { k: 'vc', d: 1000 } }).indexOf('<b>') < 0 && card({ x: { k: 'vc', d: 1000 } }, GRP).includes('fcvc'), 'escape; grup juga'); assert(FC.hasVc && h.indexOf('<script') < 0);
  ok('kartu suara: label + durasi (nama berkas disembunyikan), unduh/putar sesuai status, klaim tidak sah (ekstensi lain, durasi aneh, berisiko) jatuh ke kartu berkas biasa');

  // ---- 6. alur antarmuka dengan DOM palsu ----
  const els = {}, hist = [], toasts = [], sent = [], saved = [], asks = [], gums = [], recs = [], docL = {};
  const mk2 = (id) => ({ id, textContent: '', style: {}, onclick: null, src: '', classList: { _s: new Set(), add(c) { if (!c) throw new Error('kelas kosong'); this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } }, play() { return Promise.resolve(); }, pause() {}, removeAttribute(a) { if (a === 'src') this.src = ''; } });
  const $ = (id) => els[id] || (els[id] = mk2(id));
  const track = () => ({ stopped: false, stop() { this.stopped = true; } });
  let denyMic = false, electron = true, gumFail = null, tracks = [], bytesFor = () => WEBA(40);
  class MR { constructor(s, o) { this.s = s; this.o = o; this.state = 'inactive'; recs.push(this); } start() { this.state = 'recording'; setTimeout(() => this.ondataavailable && this.state === 'recording' && this.ondataavailable({ data: new Blob([bytesFor()]) }), 5); } stop() { this.state = 'inactive'; setTimeout(() => this.onstop && this.onstop(), 5); } static isTypeSupported(m) { return m === 'audio/webm;codecs=opus'; } }
  const ctx = {
    $, S: { call: null, messages: [], sending: [] }, cur: DM, jobN: 0, toast: (t) => toasts.push(t), refresh: async () => {}, callCtl: { cur: null }, playerStop() { ctx.stopped = (ctx.stopped || 0) + 1; }, VoiceNote: VN,
    nbridge: { ask: async (a) => { asks.push(a); return denyMic ? { ok: false } : { ok: true }; } }, MediaRecorder: MR, Blob, File, Uint8Array, setTimeout, setInterval, clearInterval, console,
    URL: { createObjectURL: () => 'blob:v', revokeObjectURL() {} }, document: { hidden: false, addEventListener: (t, fn) => { (docL[t] = docL[t] || []).push(fn); } },
    navigator: { mediaDevices: { getUserMedia: async (c) => { gums.push(c); if (gumFail) { const e = new Error('x'); e.name = gumFail; throw e; } const t = [track()]; tracks.push(t); return { getTracks: () => t }; } } },
    window: { history: { pushState: (s) => hist.push(s), back: () => { hist.pop(); ctx.voicePop(); } }, api: { sendVoice: async (job, src, to, dur) => { sent.push({ job, src, to, dur }); return { ok: true }; } } },
  };
  Object.defineProperty(ctx.window.api, 'captureSave', { get: () => (electron ? async (n, b) => { saved.push([n, b.length]); return { ok: true, path: '/data/capture/cap-1.' + n.split('.').pop() }; } : undefined) });
  vm.createContext(ctx); vm.runInContext(require('./_src').txfJs() + '\n' + rd('renderer/js/archne-voicenote.js') + '\nglobalThis.__t = { openVoice, closeVoice, voiceOpen, vnSend, voiceBtnSync };', ctx);
  const T = ctx.__t, cls = (c) => $('vrec').classList.contains(c), keydown = (k) => { const e = { key: k, prevented: 0, preventDefault() { this.prevented++; }, stopPropagation() {} }; for (const fn of docL.keydown || []) fn(e); return e; };
  // izin ditolak
  denyMic = true; await T.openVoice(); assert(T.voiceOpen() && !gums.length && $('vrm').textContent.includes('Izin') && cls('err'), 'izin ditolak: pesan, mikrofon tidak dibuka'); T.closeVoice(); assert(!T.voiceOpen() && hist.length === 0 && !cls('on')); denyMic = false;
  // rekam -> selesai -> tinjau -> kirim (Electron)
  asks.length = 0; await T.openVoice(); assert(T.voiceOpen() && cls('on') && cls('rec') && asks.join() === 'mic' && gums.length === 1 && gums[0].video === false && hist.length === 1 && ctx.stopped >= 1 && recs[0].o.mimeType === 'audio/webm;codecs=opus' && recs[0].o.audioBitsPerSecond === 32000, 'rekam langsung dimulai: izin mic saja, tanpa video, pemutar dihentikan, satu entri riwayat');
  assert($('vrt').textContent.startsWith('● 0:0'), 'penanda rekaman tampak');
  $('vrstop').onclick(); await sleep(40); // langsung berhenti (< 1 dtk): dianggap ketukan tidak sengaja
  assert(cls('err') && !cls('rev') && !cls('rec') && $('vrm').textContent.includes('pendek') && tracks[0][0].stopped, 'terlalu pendek: ditolak, tidak ada tombol kirim, mikrofon dilepas'); T.closeVoice(); assert(hist.length === 0 && !T.voiceOpen());
  // rekaman cukup lama: Electron
  await T.openVoice(); await sleep(1150); $('vrstop').onclick(); await sleep(40); assert(cls('rev') && $('vrd').textContent === '0:01' && $('vra').src === 'blob:v', 'tinjau: audio dan durasi');
  await $('vrsend').onclick(); await sleep(30);
  assert(sent.length === 1 && /^\/data\/capture\/cap-1\.weba$/.test(sent[0].src) && sent[0].to === DM && sent[0].dur >= 1000 && sent[0].dur < 3000 && /^suara_\d{8}_\d{6}\.weba$/.test(saved[0][0]) && !T.voiceOpen() && hist.length === 0 && tracks.every((t) => t[0].stopped), 'Electron: captureSave lalu sendVoice(path, tujuan, durasi); lembar tertutup, mikrofon lepas');
  // Android/peramban: File
  electron = false; await T.openVoice(); await sleep(1150); $('vrstop').onclick(); await sleep(40); await $('vrsend').onclick(); await sleep(30);
  assert(sent.length === 2 && sent[1].src instanceof File && /\.weba$/.test(sent[1].src.name) && sent[1].src.type === 'audio/webm', 'Android: File dikirim, api-http yang mengunggah'); electron = true;
  // tujuan ditentukan saat dibuka, bukan saat kirim
  ctx.cur = 'g:' + 'd'.repeat(16); await T.openVoice(); ctx.cur = DM; await sleep(1150); $('vrstop').onclick(); await sleep(40); await $('vrsend').onclick(); await sleep(30); assert.strictEqual(sent[2].to, 'g:' + 'd'.repeat(16), 'grup'); 
  // isi tidak valid tidak dikirim
  bytesFor = () => OGG(40); await T.openVoice(); await sleep(1150); $('vrstop').onclick(); await sleep(40); await $('vrsend').onclick(); await sleep(30); assert(sent.length === 3 && toasts.some((t) => t.includes('tidak valid')) && T.voiceOpen(), 'isi tidak cocok ekstensi: tidak dikirim, lembar tetap terbuka'); bytesFor = () => WEBA(40); T.closeVoice();
  // ulangi
  await T.openVoice(); await sleep(1150); $('vrstop').onclick(); await sleep(40); const nG = gums.length; $('vrredo').onclick(); await sleep(40); assert(cls('rec') && gums.length === nG + 1, 'ulangi: rekam lagi'); T.closeVoice();
  // Esc / Kembali saat merekam: semua dilepas, tidak terkirim
  const nSent = sent.length; await T.openVoice(); assert(cls('rec')); const rr = recs[recs.length - 1], tt = tracks[tracks.length - 1]; const ev = keydown('Escape'); await sleep(30);
  assert(ev.prevented === 1 && !T.voiceOpen() && rr.state === 'inactive' && tt[0].stopped && sent.length === nSent && hist.length === 0 && !cls('on'), 'Esc saat merekam: berhenti, mikrofon lepas, tidak terkirim'); keydown('Escape');
  // ke latar saat merekam: berhenti dan mikrofon dilepas, hasil masuk tinjauan
  await T.openVoice(); await sleep(1150); const tb = tracks[tracks.length - 1]; ctx.document.hidden = true; for (const fn of docL.visibilitychange) fn(); await sleep(40); ctx.document.hidden = false;
  assert(cls('rev') && tb[0].stopped, 'ke latar: rekaman dihentikan, mikrofon dilepas'); T.closeVoice();
  // panggilan datang saat merekam
  await T.openVoice(); const tc = tracks[tracks.length - 1]; ctx.S.call = { id: 1 }; await sleep(400); assert(!T.voiceOpen() && tc[0].stopped && toasts.some((t) => t.includes('panggilan')), 'panggilan saat merekam: dibatalkan dan mikrofon dilepas'); 
  const ng = gums.length; await T.openVoice(); assert(!T.voiceOpen() && gums.length === ng, 'saat panggilan: tidak dibuka'); ctx.S.call = null;
  // Publik, kamera terbuka, galat mikrofon
  ctx.cur = 'public'; await T.openVoice(); assert(!T.voiceOpen() && toasts.some((t) => t.includes('Publik')), 'Publik: ditolak'); T.voiceBtnSync(); assert.strictEqual($('micbtn').style.display, 'none', 'tombol disembunyikan di Publik'); ctx.cur = DM; T.voiceBtnSync(); assert.strictEqual($('micbtn').style.display, '');
  ctx.cameraOpen = () => true; await T.openVoice(); assert(!T.voiceOpen(), 'kamera terbuka: tidak dibuka'); ctx.cameraOpen = undefined;
  gumFail = 'NotFoundError'; await T.openVoice(); assert($('vrm').textContent.includes('tidak ditemukan')); T.closeVoice(); gumFail = null;
  ctx.MediaRecorder = { isTypeSupported: () => false }; const nGum = gums.length; await T.openVoice(); assert($('vrm').textContent.includes('tidak didukung') && gums.length === nGum, 'format rekam tidak didukung: pesan jelas, mikrofon tidak pernah dibuka'); T.closeVoice(); ctx.MediaRecorder = MR;
  ok('antarmuka: izin ditolak, rekam/tinjau/kirim via path Electron dan File Android, tujuan dikunci saat dibuka, isi tidak valid tidak dikirim, ulangi, Esc/Kembali/latar/panggilan melepas mikrofon, Publik dan kamera terbuka ditolak');

  // ---- 7. kontrak ----
  const html = rd('renderer/archne-index.html');
  for (const id of ['vrec', 'vrm', 'vrt', 'vrstop', 'vra', 'vrd', 'vrredo', 'vrsend', 'vrx', 'micbtn']) assert(html.includes('id="' + id + '"'), id);
  assert(html.indexOf('archne-voicenote.js') > html.indexOf('archne-camera.js') && html.indexOf('js/archne-voicenote.js') > html.indexOf('js/archne-camera.js') && html.indexOf('js/archne-voicenote.js') < html.indexOf('js/archne-call-ui.js') && html.indexOf('archne-voicenote.js') < html.indexOf('js/archne-state-util.js'), 'urutan skrip');
  assert(/sendVoice: \(job, src, to, durMs\) => ipcRenderer\.invoke\('sendVoice', job, src, to, durMs\)/.test(rd('preload.js')) && /api\.sendVoice = async/.test(rd('renderer/archne-api-http.js')) && /handlers\.set\('sendVoice'/.test(rd('src/archne-rpc.js')), 'preload, api-http, rpc');
  assert(/voiceOpen\(\)\) \{ voicePop\(\)/.test(rd('renderer/js/archne-render.js')) && /voiceBtnSync/.test(rd('renderer/js/archne-render.js')) && /voiceOpen\(\)\) return;/.test(rd('renderer/js/archne-camera.js')), 'Kembali menutup perekam; kamera tidak bisa dibuka bersamaan');
  assert(!/sendFile\(/.test(rd('renderer/js/archne-voicenote.js').replace(/\/\/.*$/gm, '')), 'perekam tidak pernah memakai sendFile');
  assert(/audio\/webm/.test(rd('renderer/archne-voicenote.js')) && !/video\//.test(rd('renderer/archne-voicenote.js').replace(/\/\/.*$/gm, '')), 'hanya audio');
  ok('kontrak: markup, urutan skrip, sendVoice di preload/api-http/rpc, Kembali menutup perekam, perekam tidak memakai sendFile');

  console.log('\nOK: ' + pass + ' kelompok');
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

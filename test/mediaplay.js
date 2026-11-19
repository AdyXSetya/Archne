'use strict';
// Tes pemutar audio/video (v0.25.0 Step 2): pengenal kontainer, Core.mediaPlay, kartu berkas, kontrak, dan modul pemutar (js/archne-player.js) dengan DOM palsu.
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), assert = require('assert');
const M = require('../src/archne-mediacheck');
const FC = require('../renderer/archne-filecard');
const mediaMixin = require('../src/core/archne-media');
const root = path.join(__dirname, '..');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const B = (...a) => Buffer.concat(a.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x, 'latin1'))));
const pad = (n) => Buffer.alloc(n);
const S = {
  mp3id3: B('ID3\x03\x00\x00\x00\x00\x00\x00', pad(8)), mp3raw: B([0xff, 0xfb, 0x90, 0x00], pad(12)), aac: B([0xff, 0xf1, 0x50, 0x80], pad(12)),
  m4a: B([0, 0, 0, 0x18], 'ftypM4A ', pad(12)), mp4: B([0, 0, 0, 0x18], 'ftypisom', pad(12)), ogg: B('OggS', pad(20)), flac: B('fLaC', pad(20)),
  wav: B('RIFF', pad(4), 'WAVEfmt ', pad(8)), webm: B([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], 'webm', pad(20)), mkv: B([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88], 'matroska', pad(20)),
};

(async () => {
  // ---- 1. pengenal kontainer dan pencocokan dengan ekstensi ----
  assert.strictEqual(M.sniffAv(S.mp3id3), 'mp3'); assert.strictEqual(M.sniffAv(S.mp3raw), 'mp3'); assert.strictEqual(M.sniffAv(S.aac), 'aac');
  assert.strictEqual(M.sniffAv(S.m4a), 'mp4'); assert.strictEqual(M.sniffAv(S.ogg), 'ogg'); assert.strictEqual(M.sniffAv(S.flac), 'flac');
  assert.strictEqual(M.sniffAv(S.wav), 'wav'); assert.strictEqual(M.sniffAv(S.webm), 'webm'); assert.strictEqual(M.sniffAv(S.mkv), 'mkv');
  assert.strictEqual(M.sniffAv(B('<html><script>alert(1)</script>')), null); assert.strictEqual(M.sniffAv(B('MZ', pad(30))), null);
  assert.strictEqual(M.sniffAv(B([0xff, 0xfb, 0xf0, 0], pad(12))), null, 'indeks bitrate 15 tidak sah');
  assert.strictEqual(M.sniffAv(Buffer.alloc(4)), null); assert.strictEqual(M.sniffAv('x'), null);
  assert.strictEqual(M.playMime('a.mp3', 'mp3'), 'audio/mpeg'); assert.strictEqual(M.playMime('a.m4a', 'mp4'), 'audio/mp4'); assert.strictEqual(M.playMime('v.mp4', 'mp4'), 'video/mp4');
  assert.strictEqual(M.playMime('v.webm', 'webm'), 'video/webm'); assert.strictEqual(M.playMime('a.weba', 'webm'), 'audio/webm'); assert.strictEqual(M.playMime('a.opus', 'ogg'), 'audio/ogg');
  assert.strictEqual(M.playMime('a.mp3', 'mp4'), null, 'isi tidak cocok dengan ekstensi'); assert.strictEqual(M.playMime('v.mp4', 'mkv'), null); assert.strictEqual(M.playMime('v.mkv', 'mkv'), null, 'mkv tidak diputar bawaan');
  assert.strictEqual(M.playMime('a.mp3', null), null); assert.strictEqual(M.playMime('a.exe', 'mp3'), null);
  for (const n of ['x.avi', 'x.wmv', 'x.mov', 'x.mkv', 'x.exe', 'x.mp3.exe', 'x', '', null, 'x.constructor', 'x.__proto__']) assert.strictEqual(M.playKind(n), null, String(n));
  assert.deepStrictEqual(M.playKind('Lagu.MP3'), { kind: 'aud', ext: 'mp3' }); assert.deepStrictEqual(M.playKind('f.WebM'), { kind: 'vid', ext: 'webm' });
  ok('pengenal kontainer: tiap format dikenali dari byte, isi harus cocok dengan ekstensi, HTML/EXE/mkv/ekstensi aneh ditolak');

  // ---- 2. Core.mediaPlay ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mplay-'));
  const ID = (n) => String(n).padStart(32, 'a');
  const files = { 1: ['lagu.mp3', S.mp3id3], 2: ['klip.mp4', S.mp4], 3: ['palsu.mp3', B('MZ', pad(40))], 4: ['video.mkv', S.mkv], 5: ['x.mp3', S.mp4], 6: ['besar.mp3', null], 7: ['doc.pdf', B('%PDF-1.4', pad(20))] };
  const store = { msgs: {}, got: {} };
  for (const [n, [name, data]] of Object.entries(files)) {
    const pth = path.join(dir, name);
    if (data) fs.writeFileSync(pth, data); else { fs.writeFileSync(pth, S.mp3id3); fs.truncateSync(pth, M.PLAY_MAX + 1); }
    store.msgs[ID(n)] = { from: 'bb'.repeat(8) }; store.got[ID(n)] = { name, path: pth };
  }
  store.msgs[ID(8)] = { from: 'me' }; store.got[ID(8)] = { name: 'milikku.mp3', path: path.join(dir, 'lagu.mp3') }; // salinan kirim sendiri
  store.msgs[ID(9)] = { from: 'bb'.repeat(8) }; // belum diunduh
  const core = Object.assign({ id: 'me', store, _offerOf: (m) => (m && m.from ? { name: 'x' } : undefined) }, mediaMixin);
  let r = await core.mediaPlay(ID(1)); assert(r.ok && r.kind === 'aud' && r.mime === 'audio/mpeg' && Buffer.from(r.b64, 'base64').equals(S.mp3id3), JSON.stringify(r).slice(0, 120));
  r = await core.mediaPlay(ID(2)); assert(r.ok && r.kind === 'vid' && r.mime === 'video/mp4');
  for (const [n, code] of [[3, 'notmedia'], [4, 'format'], [5, 'notmedia'], [6, 'big'], [7, 'format'], [8, 'gone'], [9, 'gone']]) { r = await core.mediaPlay(ID(n)); assert(r.ok === false && r.code === code, n + ' -> ' + JSON.stringify(r)); }
  for (const bad of ['x', '../etc/passwd', '', undefined, ID(1) + 'z']) { r = await core.mediaPlay(bad); assert(r.ok === false && r.code === 'bad', String(bad)); }
  fs.unlinkSync(store.got[ID(1)].path); r = await core.mediaPlay(ID(1)); assert(r.ok === false && r.code === 'gone', 'berkas dihapus');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('Core.mediaPlay: lagu/klip lolos; isi palsu, mkv, pdf, terlalu besar, salinan sendiri, belum diunduh, id jelek, berkas hilang -> ditolak dengan kode jelas');

  // ---- 3. kartu berkas ----
  assert.strictEqual(FC.playKind('a.mp3'), 'aud'); assert.strictEqual(FC.playKind('a.WEBM'), 'vid'); assert.strictEqual(FC.playKind('a.mkv'), '');
  for (const n of ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba', 'mp4', 'm4v', 'webm', 'mkv', 'avi', 'mov', 'wmv', 'exe', 'js', 'png']) assert.strictEqual(!!FC.playKind('f.' + n), !!M.playKind('f.' + n), 'ekstensi ' + n + ' sama dengan Core');
  const ID1 = 'ab'.repeat(16), card = (name, saved) => FC.cardHtml({ id: ID1, to: '0123456789abcdef', file: { name, size: 1000, psize: 1000, mode: 'raw', saved: saved === undefined ? { name } : saved } }, {});
  let h = card('lagu.mp3'); assert(h.includes('data-act="play"') && h.includes('title="Putar"') && h.includes('data-k="aud"') && !h.includes('▶'));
  h = card('klip.mp4'); assert(h.includes('data-act="play"') && h.includes('data-k="vid"'));
  h = card('film.mkv'); assert(!h.includes('data-act="play"') && h.includes('data-act="open"') && h.includes('data-k="file"'), 'mkv: hanya Buka');
  h = card('invoice.exe.mp3'); assert(h.includes('data-act="play"'), 'ekstensi terakhir yang menentukan');
  h = card('lagu.mp3.exe'); assert(!h.includes('data-act="play"') && !h.includes('data-act="open"') && h.includes('tidak dibuka dari Archne'), 'berisiko: tidak ada Putar/Buka');
  h = FC.cardHtml({ id: ID1, to: '0123456789abcdef', file: { name: 'lagu.mp3', size: 1000, psize: 1000, mode: 'raw' } }, {}); assert(!h.includes('data-act="play"') && h.includes('data-act="recv"'), 'belum diunduh: Terima dulu');
  h = card('lagu<img onerror=1>.mp3'); assert(!h.includes('<img onerror') && h.includes('data-act="play"'), 'nama di-escape');
  ok('kartu berkas: Putar hanya untuk audio/video terunduh yang tidak berisiko; daftar ekstensi sama dengan Core');

  // ---- 4. kontrak ----
  const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  assert(/mediaPlay: \(id\) => ipcRenderer\.invoke\('mediaPlay', id\)/.test(rd('preload.js')));
  assert(/'mediaPlay'/.test(rd('renderer/archne-api-http.js')) && /ipcMain\.handle\('mediaPlay'/.test(rd('src/archne-ipc.js')));
  const html = rd('renderer/archne-index.html');
  assert(/media-src blob: 'self' archne-media:;/.test(html) && !/media-src[^;]*(https?:|data:|file:|\*)/.test(html) && /img-src data: archne-media: 'self';/.test(html) && !/default-src[^;]*blob:/.test(html), 'CSP: hanya blob: untuk media');
  assert(html.indexOf('js/archne-imgview.js') < html.indexOf('js/archne-player.js') && html.indexOf('js/archne-player.js') < html.indexOf('js/archne-settings.js'));
  for (const id of ['mpl', 'mpt', 'mpb', 'mpm', 'mpsp', 'mpopen', 'mpx']) assert(html.includes('id="' + id + '"'), id);
  assert(/act === 'play'/.test(rd('renderer/js/archne-profile-compose.js')) && /playerModal\(\)/.test(rd('renderer/js/archne-render.js')) && /playerStop\(\)/.test(rd('renderer/js/archne-call-ui.js')));
  ok('kontrak: mediaPlay di preload/api-http/ipc, CSP hanya media-src blob:, markup dan urutan skrip, kait klik/Kembali/panggilan');

  // ---- 5. modul pemutar dengan DOM palsu ----
  const els = {}, hist = [];
  const mk = (id) => ({ id, textContent: '', innerHTML: '', onclick: null, firstChild: null, classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    appendChild(c) { this.firstChild = c; }, removeAttribute() {}, setAttribute() {}, pause() { this.paused = true; }, load() {}, play() { this.played = true; return Promise.resolve(); } });
  Object.defineProperty(mk('x'), 'x', {});
  const $ = (id) => els[id] || (els[id] = mk(id));
  Object.defineProperty(els, 'mpb', { configurable: true, writable: true, value: null }); els.mpb = mk('mpb'); // innerHTML = '' harus mengosongkan firstChild
  const mpb = els.mpb; Object.defineProperty(mpb, 'innerHTML', { get() { return ''; }, set() { mpb.firstChild = null; } });
  const created = [], revoked = [], toasts = []; let plays = [], playRet = null, gate = null;
  const ctx = {
    $, S: { messages: [{ id: 'm1', file: { name: 'lagu.mp3' } }, { id: 'm2', file: { name: 'klip.mp4' } }], call: null }, toast: (t) => toasts.push(t),
    document: { createElement: (t) => { const e = mk(t); e.tag = t; created.push(e); return e; } }, Blob: function (parts, o) { this.parts = parts; this.type = o.type; },
    URL: { createObjectURL: (b) => 'blob:' + b.type + '#' + created.length, revokeObjectURL: (u) => revoked.push(u) }, atob: (s) => Buffer.from(s, 'base64').toString('latin1'), Uint8Array,
    window: { api: { mediaPlay: async (id) => { plays.push(id); if (gate) await gate; return playRet(id); }, openFile: async () => ({ ok: true }) }, history: { pushState: (s) => hist.push(s), back: () => { hist.pop(); ctx.playerPop(); } }, addEventListener() {} },
    callCtl: { cur: null }, console, String, Array, Math,
  };
  ctx.document.addEventListener = () => {};
  vm.createContext(ctx);
  vm.runInContext(require('./_src').txfJs() + '\n' + fs.readFileSync(path.join(root, 'renderer/js/archne-player.js'), 'utf8') + '\nglobalThis.__t = { openPlayer, playerStop, playerModal, playerOpenNow, playerPop };', ctx);
  const T = ctx.__t, b64 = Buffer.from('hello').toString('base64');
  playRet = (id) => (id === 'm1' ? { ok: true, kind: 'aud', mime: 'audio/mpeg', size: 5, b64 } : { ok: true, kind: 'vid', mime: 'video/mp4', size: 5, b64 });
  await T.openPlayer('m1');
  assert(T.playerOpenNow() && !T.playerModal() && els.mpl.classList.contains('on') && els.mpl.classList.contains('aud') && created.length === 1 && created[0].tag === 'audio' && created[0].played && created[0].controls, 'audio: bilah, otomatis putar');
  assert(created[0].src.startsWith('blob:audio/mpeg') && els.mpt.textContent === 'lagu.mp3' && hist.length === 0, 'audio: tanpa entri riwayat');
  await T.openPlayer('m2');
  assert(T.playerModal() && els.mpl.classList.contains('vid') && !els.mpl.classList.contains('aud') && created[1].tag === 'video' && hist.length === 1 && revoked.length === 1 && created[0].paused, 'video menggantikan audio: yang lama berhenti dan blob-nya dilepas; satu entri riwayat');
  els.mpsp.onclick(); assert(created[1].playbackRate === 1.5 && els.mpsp.textContent === '1,5×'); els.mpsp.onclick(); assert(created[1].playbackRate === 2); els.mpsp.onclick(); assert(created[1].playbackRate === 1 && els.mpsp.textContent === '1×', 'kecepatan 1 -> 1,5 -> 2 -> 1');
  T.playerStop(); assert(!T.playerOpenNow() && !els.mpl.classList.contains('on') && hist.length === 0 && revoked.length === 2 && created[1].paused, 'tutup: berhenti, blob dilepas, riwayat kembali');
  T.playerStop(); // tidak melempar bila sudah tertutup
  // panggilan
  ctx.S.call = { id: 'c' }; await T.openPlayer('m1'); assert(!T.playerOpenNow() && toasts.length === 1, 'panggilan berjalan: ditolak dengan pesan');
  const nPlays = plays.length; ctx.S.call = null; ctx.callCtl.cur = { room: 1 }; await T.openPlayer('m1'); assert(!T.playerOpenNow() && plays.length === nPlays && toasts.length === 2, 'saat panggilan: tidak memutar dan tidak memanggil Core'); ctx.callCtl.cur = null;
  await T.openPlayer('m1'); T.playerStop(); assert(!T.playerOpenNow(), 'panggilan masuk (playerStop) menghentikan audio');
  // galat dari Core, ditutup selagi memuat
  playRet = () => ({ ok: false, err: 'Isi berkas tidak cocok dengan jenisnya, jadi tidak diputar.' }); await T.openPlayer('m1');
  assert(els.mpm.textContent.includes('tidak cocok') && els.mpb.firstChild === null, 'galat Core ditampilkan, tidak ada elemen media'); T.playerStop();
  let rel; gate = new Promise((r2) => { rel = r2; }); playRet = () => ({ ok: true, kind: 'aud', mime: 'audio/mpeg', size: 5, b64 });
  const n0 = created.length, pr = T.openPlayer('m1'); T.playerStop(); rel(); await pr; gate = null;
  assert(!T.playerOpenNow() && created.length === n0, 'ditutup selagi memuat: tidak ada elemen terpasang terlambat');
  playRet = () => ({ ok: true, kind: 'aud', mime: 'audio/mpeg', size: 5, b64 }); await T.openPlayer('m1'); created[created.length - 1].onerror();
  assert(els.mpm.textContent.includes('tidak didukung'), 'format tak didukung perangkat: pesan + tombol Buka dengan aplikasi lain tetap ada'); T.playerStop();
  ok('pemutar: audio bilah tanpa riwayat, video modal dengan riwayat, satu pemutar, kecepatan, tutup melepas blob, tolak saat panggilan, galat Core, tutup selagi memuat, format tak didukung');

  console.log('\nOK: ' + pass + ' kelompok');
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

'use strict';
// Tes Fase C berbagi layar (v0.32.0), sisi desktop tanpa Electron:
//  - izin 'display-capture' (C.3): hanya halaman Archne, tanpa audio/tipe lain; izin lain tetap ditolak
//  - pemilih sumber (C.1/C.2): hanya halaman Archne dilayani, jendela Archne sendiri tidak ditawarkan, pengguna harus memilih,
//    id karangan ditolak, batal/waktu habis/permintaan kedua/dispose ditolak, setiap permintaan dijawab tepat sekali, tanpa audio sistem
//  - jembatan IPC (C.4): screenPickDone diteruskan ke pemilih, tanpa pemilih (browser/headless) aman
//  - tampilan (C.5): tombol Bagikan layar, indikator permanen, bilah kecil; tombol tersembunyi bila fitur tidak ada
//  - kabel main.js/preload.js dan berkas yang dikemas
const fs = require('fs'), path = require('path'), assert = require('assert');
const { allowMedia, allowDisplay, allowPermission } = require('../src/archne-permissions');
const { createScreenPicker } = require('../src/archne-screenpick');
const { register } = require('../src/archne-ipc');
const LC = require('../renderer/archne-call');
const root = path.join(__dirname, '..');
const rendererDir = path.join(root, 'renderer');
const appUrl = 'file://' + path.join(rendererDir, 'archne-index.html').replace(/\\/g, '/');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- C.3 izin ----------
{
  const d = (info) => allowDisplay('display-capture', info, rendererDir);
  assert.strictEqual(d({ url: appUrl }), true, 'halaman Archne boleh');
  assert.strictEqual(d({ url: appUrl, mediaTypes: ['video'] }), true);
  assert.strictEqual(d({ origin: 'file:///' }), true, 'pemeriksaan hanya dengan origin file://');
  assert.strictEqual(d({ url: appUrl, mediaTypes: ['video', 'audio'] }), true, 'video+audio sistem boleh diminta (C.6); ikut atau tidak diputuskan pemilih + kotak centang');
  assert.strictEqual(d({ url: appUrl, mediaTypes: ['video', 'screen'] }), false, 'tipe lain ditolak');
  assert.strictEqual(d({ url: 'https://evil.example/' }), false, 'halaman luar');
  assert.strictEqual(d({ url: 'file:///etc/passwd' }), false, 'berkas lokal lain');
  assert.strictEqual(d({ url: 'file://' + path.join(rendererDir, '..', 'x.html').replace(/\\/g, '/') }), false, 'keluar dari renderer/');
  assert.strictEqual(d({ origin: 'https://evil.example' }), false);
  assert.strictEqual(d({}), false);
  assert.strictEqual(d(null), false);
  assert.strictEqual(allowDisplay('media', { url: appUrl }, rendererDir), false, 'allowDisplay hanya untuk display-capture');
  ok('display-capture: hanya halaman Archne, video/audio saja; halaman luar dan jalur keluar renderer/ ditolak');

  assert.strictEqual(allowPermission('display-capture', { url: appUrl }, rendererDir), true);
  assert.strictEqual(allowPermission('media', { url: appUrl, mediaTypes: ['audio', 'video'] }, rendererDir), true, 'mikrofon dan kamera tetap jalan');
  assert.strictEqual(allowMedia('display-capture', { url: appUrl }, rendererDir), false, 'allowMedia tidak berubah: tetap hanya media');
  for (const p of ['geolocation', 'notifications', 'camera', 'clipboard-read', 'openExternal', 'midi', 'fullscreen', 'window-management']) assert.strictEqual(allowPermission(p, { url: appUrl, mediaTypes: ['video'] }, rendererDir), false, p);
  assert.strictEqual(allowPermission('display-capture', { url: 'https://evil.example/' }, rendererDir), false);
  ok('allowPermission: izin lama tidak berubah, izin lain tetap ditolak');
}

// ---------- C.1/C.2 pemilih sumber ----------
const jpg = Buffer.from('JPEGDATA');
const mkSrc = (id, name, empty) => ({ id, name, thumbnail: { isEmpty: () => !!empty, toJPEG: () => jpg } });
function rig(o) {
  o = o || {};
  const sent = [], logs = [], answers = [];
  const win = { isDestroyed: () => !!o.destroyed, getMediaSourceId: () => 'window:99:0' };
  const sources = o.sources || [mkSrc('screen:0:0', 'Layar 1'), mkSrc('screen:1:0', 'Layar 2'), mkSrc('window:11:0', 'Catatan'), mkSrc('window:99:0', 'Archne'), mkSrc('window:12:0', '<b>x</b>'.repeat(40))];
  const dc = { calls: [], getSources: async (opt) => { dc.calls.push(opt); if (o.fail) throw new Error('boom'); await tick(); return sources; } };
  const picker = createScreenPicker({ desktopCapturer: dc, getWindow: () => (o.noWin ? null : win), rendererDir, send: (ch, p) => sent.push([ch, p]), log: (m) => logs.push(m), timeoutMs: o.timeoutMs, platform: o.platform });
  const req = (over) => Object.assign({ frame: { url: appUrl }, videoRequested: true, audioRequested: false }, over);
  const ask = (over) => { const a = { n: 0, v: undefined }; answers.push(a); const p = picker.handler(req(over), (x) => { a.n++; a.v = x; }); return Promise.resolve(p).then(() => a); };
  return { picker, sent, logs, dc, ask, win, answers };
}
const emptyAns = (a) => a.n === 1 && a.v && Object.keys(a.v).length === 0;

(async () => {
  // layanan normal: daftar dikirim, pengguna memilih
  {
    const r = rig();
    const a = await r.ask();
    assert.strictEqual(a.n, 0, 'belum dijawab sebelum pengguna memilih (tidak ada berbagi otomatis)');
    assert.strictEqual(r.sent.length, 1); assert.strictEqual(r.sent[0][0], 'screenpick');
    const { rid, items } = r.sent[0][1];
    assert.deepStrictEqual(r.dc.calls[0].types, ['screen', 'window']);
    assert(!items.some((i) => i.id === 'window:99:0'), 'jendela Archne sendiri tidak ditawarkan');
    assert.deepStrictEqual(items.map((i) => i.type), ['screen', 'screen', 'window', 'window']);
    assert(items.every((i) => i.thumb.indexOf('data:image/jpeg;base64,') === 0 && i.name.length <= 120));
    assert.strictEqual(r.picker.isPending(), true);
    assert.deepStrictEqual(r.picker.choose(rid, 'window:11:0'), { ok: true, audio: false });
    assert.strictEqual(a.n, 1); assert.strictEqual(a.v.video.id, 'window:11:0'); assert(!('audio' in a.v), 'tanpa audio sistem');
    assert.strictEqual(r.picker.isPending(), false);
    assert.deepStrictEqual(r.picker.choose(rid, 'window:11:0'), { ok: false }, 'jawaban kedua tidak berlaku'); assert.strictEqual(a.n, 1, 'dijawab tepat sekali');
    ok('pemilih: daftar dikirim, tidak berbagi sebelum dipilih, jendela Archne dikeluarkan, hasil tanpa audio, dijawab sekali');
  }
  // C.6 audio sistem: hanya Windows + diminta + dicentang + layar penuh; selain itu tidak pernah ada audio
  {
    const run = async (platform, reqAudio, ans, id) => {
      const r = rig({ platform }); const a = await r.ask({ audioRequested: reqAudio });
      const offered = r.sent[0][1].audio; const res = r.picker.choose(r.sent[0][1].rid, id || 'screen:0:0', ans);
      return { a, offered, res };
    };
    let x = await run('win32', true, true); assert.strictEqual(x.offered, true); assert.deepStrictEqual(x.a.v, { video: x.a.v.video, audio: 'loopback' }); assert.strictEqual(x.a.v.video.id, 'screen:0:0'); assert.strictEqual(x.res.audio, true);
    x = await run('win32', true, false); assert(!('audio' in x.a.v), 'tidak dicentang: tanpa audio'); assert.strictEqual(x.offered, true, 'tetap ditawarkan');
    x = await run('win32', true, undefined); assert(!('audio' in x.a.v), 'tanpa jawaban audio: tanpa audio');
    for (const bad of ['loopback', 1, 'true', {}, null]) { x = await run('win32', true, bad); assert(!('audio' in x.a.v), 'hanya boolean true: ' + JSON.stringify(bad)); }
    x = await run('win32', false, true); assert.strictEqual(x.offered, false, 'renderer tidak meminta audio: tidak ditawarkan'); assert(!('audio' in x.a.v), 'dicentang tapi tidak diminta: tanpa audio');
    for (const pf of ['linux', 'darwin']) { x = await run(pf, true, true); assert.strictEqual(x.offered, false, 'bukan Windows: tidak ditawarkan ' + pf); assert(!('audio' in x.a.v), 'bukan Windows: tanpa audio ' + pf); }
    x = await run('win32', true, true, 'window:11:0'); assert(!('audio' in x.a.v), 'jendela: audio sistem tidak ikut (loopback merekam seluruh perangkat)'); assert.strictEqual(x.res.audio, false);
    const r = rig({ platform: 'win32' }); const a = await r.ask({ audioRequested: true }); r.picker.choose(r.sent[0][1].rid, 'screen:9:9', true); assert(emptyAns(a), 'id karangan tetap ditolak, tanpa audio');
    const r2 = rig({ platform: 'win32' }); const a2 = await r2.ask({ audioRequested: true }); r2.picker.choose(r2.sent[0][1].rid, null, true); assert(emptyAns(a2), 'batal = ditolak, audio tidak lolos sendiri');
    ok('audio sistem: hanya Windows + diminta renderer + dicentang (boolean true) + layar penuh; selain itu tidak pernah, nilai literal dari proses utama');
  }
  // halaman lain / tanpa video / tanpa jendela
  {
    const r = rig();
    for (const frame of [{ url: 'https://evil.example/' }, { url: 'file:///etc/passwd' }, { url: '' }, null]) { const a = await r.ask({ frame }); assert(emptyAns(a), 'ditolak: ' + JSON.stringify(frame)); }
    assert(emptyAns(await r.ask({ videoRequested: false })));
    assert.strictEqual(r.dc.calls.length, 0, 'daftar layar tidak pernah diambil untuk permintaan yang ditolak'); assert.strictEqual(r.sent.length, 0);
    assert(emptyAns(await rig({ noWin: true }).ask())); assert(emptyAns(await rig({ destroyed: true }).ask()));
    ok('halaman selain Archne, permintaan tanpa video, dan jendela hilang ditolak tanpa mengambil daftar layar');
  }
  // id karangan, rid salah, batal
  {
    const r = rig(); const a = await r.ask(); const { rid } = r.sent[0][1];
    assert.deepStrictEqual(r.picker.choose('rid-lain', 'screen:0:0'), { ok: false }); assert.strictEqual(a.n, 0, 'rid salah diabaikan, permintaan tetap terbuka');
    assert.deepStrictEqual(r.picker.choose(rid, 'window:99:0'), { ok: false }); assert(emptyAns(a), 'jendela Archne sendiri tidak bisa dipilih walau id ditebak');
    const r2 = rig(); const a2 = await r2.ask(); assert.deepStrictEqual(r2.picker.choose(r2.sent[0][1].rid, 'screen:7:7'), { ok: false }); assert(emptyAns(a2), 'id karangan ditolak');
    const r3 = rig(); const a3 = await r3.ask(); r3.picker.choose(r3.sent[0][1].rid, null); assert(emptyAns(a3), 'batal');
    const r4 = rig(); const a4 = await r4.ask(); r4.picker.choose(r4.sent[0][1].rid, { id: 'screen:0:0' }); assert(emptyAns(a4), 'id bukan string ditolak');
    ok('id karangan, jendela Archne, id bukan string ditolak; rid salah diabaikan; batal menolak');
  }
  // permintaan kedua saat satu terbuka, lalu bisa lagi setelah selesai
  {
    const r = rig(); const a = await r.ask(); const b = await r.ask();
    assert(emptyAns(b), 'permintaan kedua ditolak'); assert.strictEqual(a.n, 0, 'yang pertama tidak terganggu');
    r.picker.choose(r.sent[0][1].rid, 'screen:0:0'); assert.strictEqual(a.v.video.id, 'screen:0:0');
    const c = await r.ask(); assert.strictEqual(c.n, 0); assert.strictEqual(r.sent.length, 2, 'setelah selesai, permintaan baru dilayani');
    r.picker.choose(r.sent[1][1].rid, null);
    // dua permintaan beruntun tanpa menunggu: hanya satu yang lolos
    const r2 = rig(); const x = { n: 0 }, y = { n: 0 };
    const p1 = r2.picker.handler({ frame: { url: appUrl }, videoRequested: true }, () => { x.n++; }), p2 = r2.picker.handler({ frame: { url: appUrl }, videoRequested: true }, (v) => { y.n++; y.v = v; });
    await Promise.all([p1, p2]); assert.strictEqual(y.n, 1); assert.strictEqual(x.n, 0); assert.strictEqual(r2.sent.length, 1);
    ok('satu pemilih sekali waktu, termasuk dua permintaan beruntun');
  }
  // gagal ambil daftar / daftar kosong / waktu habis / dispose
  {
    assert(emptyAns(await rig({ fail: true }).ask()), 'getSources gagal');
    assert(emptyAns(await rig({ sources: [] }).ask()), 'tanpa sumber');
    assert(emptyAns(await rig({ sources: [mkSrc('window:99:0', 'Archne')] }).ask()), 'hanya jendela Archne: tidak ada yang bisa dibagikan');
    const t = rig({ timeoutMs: 40 }); const a = await t.ask(); assert.strictEqual(a.n, 0);
    await sleep(120); assert(emptyAns(a), 'waktu habis menolak'); assert.deepStrictEqual(t.sent[1], ['screenpick', { rid: t.sent[0][1].rid, cancel: true }], 'dialog di renderer ikut ditutup');
    assert.strictEqual(t.picker.isPending(), false);
    const d = rig(); const a2 = await d.ask(); d.picker.dispose(); assert(emptyAns(a2), 'dispose menolak'); d.picker.dispose();
    // dispose saat masih menunggu daftar
    const e = rig(); const a3 = { n: 0 }; const pr = e.picker.handler({ frame: { url: appUrl }, videoRequested: true }, (v) => { a3.n++; a3.v = v; }); e.picker.dispose(); await pr; assert.strictEqual(a3.n, 1, 'dijawab sekali'); assert.strictEqual(e.sent.length, 0, 'dialog tidak dibuka setelah dispose');
    // callback yang melempar tidak mematikan pemilih
    const f = rig(); await f.picker.handler({ frame: { url: appUrl }, videoRequested: true }, () => { throw new Error('x'); }); assert.doesNotThrow(() => f.picker.choose(f.sent[0][1].rid, 'screen:0:0'));
    ok('gagal ambil daftar, daftar kosong, waktu habis, dispose (juga saat menunggu daftar), dan callback melempar ditangani; selalu dijawab sekali');
  }
  // thumbnail kosong tetap ditawarkan tanpa gambar
  {
    const r = rig({ sources: [mkSrc('screen:0:0', 'Layar 1', true)] }); await r.ask();
    assert.strictEqual(r.sent[0][1].items[0].thumb, '');
    ok('thumbnail kosong: tetap ditawarkan tanpa gambar');
  }

  // ---------- C.4 IPC ----------
  {
    const handlers = {}; const core = new (require('events'))();
    core.getState = () => ({}); core._downloadDir = () => '';
    const calls = [];
    register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core, send: () => {}, log: () => {}, shell: {}, screen: { choose: (rid, id, audio) => { calls.push([rid, id, audio]); return { ok: true }; }, dispose: () => calls.push('dispose') } });
    assert.deepStrictEqual(await handlers.screenPickDone({}, 'sp1', 'screen:0:0'), { ok: true }); assert.deepStrictEqual(calls[0], ['sp1', 'screen:0:0', false]);
    await handlers.screenPickDone({}, 'sp1', 'screen:0:0', true); assert.strictEqual(calls[calls.length - 1][2], true, 'audio true diteruskan'); const ac = calls.length;
    await handlers.screenPickDone({}, 'sp1', 'screen:0:0', 'true'); assert.strictEqual(calls[ac][2], false, 'audio bukan boolean true dinetralkan');
    await handlers.screenPickDone({}, { x: 1 }, { y: 2 }); assert.deepStrictEqual(calls[ac + 1], ['', null, false], 'argumen bukan string dinetralkan');
    await handlers.screenPickDone({}, 'r'.repeat(500), 'i'.repeat(900)); assert(calls[ac + 2][0].length <= 64 && calls[ac + 2][1].length <= 200, 'panjang dibatasi');
    const bare = {}; register({ ipcMain: { handle: (n, fn) => { bare[n] = fn; } }, core, send: () => {}, log: () => {}, shell: {} });
    assert.deepStrictEqual(await bare.screenPickDone({}, 'sp1', 'screen:0:0'), { ok: false }, 'tanpa pemilih (headless) aman');
    ok('IPC screenPickDone: diteruskan ke pemilih, argumen dinetralkan dan dibatasi, aman tanpa pemilih');
  }

  // ---------- C.5 tampilan ----------
  {
    const h = { esc: (s) => String(s).replace(/</g, '&lt;'), avatar: (id) => `<av ${id}>`, icons: { phone: '<P/>', mic: '<M/>', micOff: '<X/>', screen: '<SCR/>', screenOff: '<SCROFF/>' } };
    const acts = (v, hh) => [...LC.overlayHtml(v, hh || h).matchAll(/data-cact="(\w+)"/g)].map((x) => x[1]);
    const base = { phase: 'active', peer: 'p', name: 'N', since: 1 };
    assert.deepStrictEqual(acts(base), ['min', 'mute', 'cam', 'deafen', 'add', 'hang'], 'tanpa scrCan: tampilan v0.31 tidak berubah');
    assert.deepStrictEqual(acts(Object.assign({ scrCan: false }, base)), ['min', 'mute', 'cam', 'deafen', 'add', 'hang'], 'fitur tidak ada: tombol disembunyikan');
    const can = Object.assign({ scrCan: true }, base);
    assert.deepStrictEqual(acts(can), ['min', 'mute', 'scr', 'cam', 'deafen', 'add', 'hang']);
    let html = LC.overlayHtml(can, h);
    assert(/Bagikan layar/.test(html) && /<SCR\/>/.test(html) && !/cscr/.test(html), 'belum berbagi: tombol Bagikan, tanpa indikator');
    for (const ph of ['dialing', 'connecting', 'ringing']) assert(!acts({ scrCan: true, phase: ph, peer: 'p', name: 'N', canAccept: ph === 'ringing' }).includes('scr'), 'tidak ada tombol layar saat ' + ph);
    assert(!acts({ scrCan: true, phase: 'active', invite: true, peer: 'p', name: 'N' }).includes('scr'), 'layar undangan tanpa tombol');
    const on = Object.assign({ scr: true }, can);
    html = LC.overlayHtml(on, h);
    assert(/class="cscr" role="status"/.test(html) && /Kamu sedang berbagi layar/.test(html), 'indikator permanen');
    assert(/Hentikan layar/.test(html) && /<SCROFF\/>/.test(html) && /cbtn tog on/.test(html.slice(html.indexOf('data-cact="scr"') - 40)), 'tombol menjadi Hentikan layar (menyala)');
    assert.deepStrictEqual(acts(on), ['min', 'scrstop', 'mute', 'scr', 'cam', 'deafen', 'add', 'hang']);
    // grup, video, channel: indikator tetap ada
    assert(/cscr/.test(LC.overlayHtml(Object.assign({ video: true, camOff: false, legs: [{ peer: 'p', name: 'N', state: 'active' }, { peer: 'q', name: 'M', state: 'active' }] }, on), h)), 'indikator di panggilan video/grup');
    assert(/cscr/.test(LC.overlayHtml(Object.assign({ vc: { gid: 'g', cid: 'c', name: 'Ch' }, camMax: 4, camCount: 1, legs: [] }, on), h)), 'indikator di channel');
    // dikecilkan: tombol berhenti di bilah kecil
    const mini = LC.overlayHtml(on, Object.assign({ minimized: true }, h));
    assert(/data-cact="scrstop"/.test(mini) && /<SCROFF\/>/.test(mini) && /Kamu sedang berbagi layar/.test(mini), 'bilah kecil: indikator + berhenti');
    assert(!/scrstop/.test(LC.overlayHtml(can, Object.assign({ minimized: true }, h))), 'bilah kecil tanpa berbagi: tidak ada tombol berhenti');
    // pemilik: tidak ada indikator pada kaki lawan yang berbagi (itu urusan Fase D)
    assert(!/cscr/.test(LC.overlayHtml(Object.assign({ legs: [{ peer: 'p', name: 'N', state: 'active', scr: true, cam: true }] }, can), h)), 'indikator hanya untuk layarmu sendiri');
    ok('tampilan: tombol Bagikan layar hanya bila fitur ada dan panggilan aktif; indikator permanen (juga grup/channel/bilah kecil); v0.31 tidak berubah');
  }

  // ---------- kabel main.js, preload, renderer, kemasan ----------
  {
    const main = read('main.js'), pre = read('preload.js'), ui = read('renderer/js/archne-call-ui.js'), idx = read('renderer/archne-index.html'), pick = read('renderer/js/archne-screen-picker.js'), pkg = JSON.parse(read('package.json'));
    assert(/setDisplayMediaRequestHandler\(/.test(main) && /createScreenPicker\(/.test(main) && /desktopCapturer/.test(main), 'main.js memasang handler dan pemilih');
    assert(/allowPermission\(permission/.test(main) && !/allowMedia\(/.test(main), 'main.js memakai allowPermission untuk izin');
    assert(!/useSystemPicker\s*:\s*true/.test(main), 'pemilih sistem hanya macOS: tidak dipakai');
    assert(/register\(\{[^}]*\bscreen\b/.test(main), 'pemilih diteruskan ke IPC (dispose saat tutup)');
    assert(/screenPickDone/.test(pre) && /onScreenPick/.test(pre) && !/require\((?!'electron')/.test(pre), 'preload: kanal baru, hanya require electron');
    assert(/data-cact="scr"|a === 'scr'/.test(ui) && /a === 'scrstop'/.test(ui), 'call-ui menangani tombol');
    assert(/key === 'me' \? \(v\.scr \? 'scr'/.test(ui), 'pratinjau layar tidak dicerminkan');
    assert(idx.indexOf('js/archne-screen-picker.js') > idx.indexOf('js/archne-call-ui.js'), 'skrip pemilih dimuat');
    assert(!/innerHTML|insertAdjacentHTML|outerHTML/.test(pick), 'nama jendela (dari aplikasi lain) hanya lewat textContent');
    assert((pkg.build.files || []).some((g) => /^src\/\*\*/.test(g)) && (pkg.build.files || []).some((g) => /^renderer\/\*\*/.test(g)), 'berkas baru ikut dikemas (src/** dan renderer/**)');
    // i18n: kunci baru ada di dua bahasa
    const idl = read('renderer/i18n/archne-id.js'), enl = read('renderer/i18n/archne-en.js');
    const keys = ['cl.scr.share', 'cl.scr.stop', 'cl.scr.you', 'cl.scr.stopBtn', 'scr.pick.title', 'scr.pick.aria', 'scr.pick.screens', 'scr.pick.windows', 'scr.pick.hint', 'scr.pick.empty', 'scr.pick.item', 'scr.pick.audio', 'scr.pick.audioHint', 'cl.scr.audioYou', 'cl.scr.audioEcho', 'cl.scr.audioFail'];
    for (const k of keys) { assert(idl.includes("'" + k + "'"), 'id: ' + k); assert(enl.includes("'" + k + "'"), 'en: ' + k); }
    ok('kabel: main.js, preload (hanya electron), call-ui, skrip pemilih (tanpa innerHTML), kemasan, i18n dua bahasa');
  }
  console.log('screendesktop: ' + pass + ' kelompok OK');
})().catch((e) => { console.error(e); process.exit(1); });

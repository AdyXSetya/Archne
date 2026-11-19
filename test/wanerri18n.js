'use strict';
// Tes i18n D4: galat yang tampil di UI dari renderer/archne-wan.js, archne-wansetup.js, archne-api-http.js dua bahasa.
// Tanpa I18N = teks Indonesia cadangan (dijaga test/archne-wan.js, archne-wansetup.js, pageui.js). Baris log teknis (dbg/note) sengaja tidak diterjemahkan.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const R = path.join(__dirname, '..', 'renderer'), rd = (f) => fs.readFileSync(path.join(R, f), 'utf8');
const ok = (n) => console.log('  OK  ' + n);
function ctxFor(lang, extra) {
  const c = Object.assign({ Intl, Object, Set, Map, String, console, Error, Promise, setTimeout, clearTimeout, setInterval, clearInterval, URL, TextDecoder, Uint8Array, Array, Date, Math, JSON, module: { exports: {} } }, extra || {});
  vm.createContext(c);
  if (lang) { for (const x of ['archne-i18n.js', 'i18n/archne-en.js', 'i18n/archne-id.js']) vm.runInContext(rd(x), c); c.I18N.setLang(lang); }
  return c;
}
const load = (f, lang, extra) => { const c = ctxFor(lang, extra); vm.runInContext(rd(f), c); return c; };
const rej = async (p) => { try { await p; } catch (e) { return e.message; } return null; };

(async () => {
  // ---- archne-wan.js
  for (const [lang, bad, nocode, seal] of [[null, 'Alamat broker tidak valid (harus wss://)', 'Kode jaringan belum diatur', 'wanSeal gagal'], ['id', 'Alamat broker tidak valid (harus wss://)', 'Kode jaringan belum diatur', 'wanSeal gagal'], ['en', 'Invalid broker address (must be wss://)', 'The network code has not been set yet', 'wanSeal failed']]) {
    const W = load('archne-wan.js', lang).module.exports;
    const mk = (api) => W.createWan({ api, mqtt: {}, rand: () => '0123456789abcdef' });
    assert.strictEqual(await rej(mk({}).start({ broker: 'http://x' })), bad);
    assert.strictEqual(await rej(mk({ wanTopics: async () => ({ ok: false }) }).start({ broker: 'wss://x/mqtt' })), nocode);
    assert.strictEqual(await rej(mk({ wanTopics: async () => ({ ok: true, id: 'a'.repeat(16) }), wanSeal: async () => ({ ok: false }) }).start({ broker: 'wss://x/mqtt' })), seal);
  }
  const wsMsg = async (lang) => { // galat WebSocket tanpa pesan (Event) -> petunjuk
    const W = load('archne-wan.js', lang).module.exports; const h = {};
    const mqtt = { connect: () => ({ on: (k, f) => { h[k] = f; }, end() {}, removeAllListeners() {}, publish() {}, subscribe() {} }) };
    const api = { wanTopics: async () => ({ ok: true, id: 'a'.repeat(16), presence: 'p', inbox: 'i', mine: 'm' }), wanSeal: async () => ({ ok: true, topic: 't', payload: 'x' }) };
    const w = W.createWan({ api, mqtt, rand: () => '0123456789abcdef', timers: { setInterval: () => 0, clearInterval() {} } }); let st = null; w.on('status', (s) => { if (s.state === 'error') st = s; });
    await w.start({ broker: 'wss://x/mqtt', name: 'n' }); h.error({}); await w.stop().catch(() => {}); return st;
  };
  assert(/^WebSocket tidak bisa dibuka: port broker/.test((await wsMsg(null)).err) && /^WebSocket tidak bisa dibuka: port broker/.test((await wsMsg('id')).err) && /^Could not open the WebSocket: the broker port/.test((await wsMsg('en')).err));
  ok('archne-wan.js: alamat broker, kode jaringan, wanSeal, galat WebSocket (tanpa I18N / id / en)');

  // ---- archne-wansetup.js
  const app = (lang, o) => {
    const S = load('archne-wansetup.js', lang).module.exports;
    const api = { onRtcb() {}, wanSettings: async () => ({ ok: true, settings: { enabled: true, hasCode: true, netId: 'n', broker: 'wss://x' } }), turnIce: async () => ({ ok: false }) };
    return S.createWanApp(Object.assign({ api, mqtt: {}, createWan: () => ({ on() {}, start: () => new Promise(() => {}), stop: async () => {}, peers: () => [] }), createRtcMux: () => ({ on() {}, links: () => [], stop: async () => {} }), createRtcGlue: () => ({ start: async () => {}, stop() {}, feed() {} }), stageMs: 30 }, o));
  };
  for (const [lang, stuck, nomqtt] of [[null, /^Macet di tahap: wan\.start \(>0 dtk\)$/, 'Pustaka MQTT tidak termuat'], ['id', /^Macet di tahap: wan\.start \(>0 dtk\)$/, 'Pustaka MQTT tidak termuat'], ['en', /^Stuck at stage: wan\.start \(>0 sec\)$/, 'The MQTT library did not load']]) {
    const a = app(lang); await a.sync(); assert(stuck.test(a.view().err), lang + ': ' + a.view().err);
    const b = app(lang, { mqtt: null }); await b.sync(); assert.strictEqual(b.view().err, nomqtt);
  }
  ok('archne-wansetup.js: macet di tahap, pustaka MQTT (tanpa I18N / id / en)');

  // ---- archne-api-http.js (mode peramban): unggahan Halaman
  for (const [lang, img, prep, file, vid] of [[null, 'Gambar tidak valid', 'Gagal menyiapkan gambar: boom', 'Berkas tidak valid', 'Video tidak valid'], ['id', 'Gambar tidak valid', 'Gagal menyiapkan gambar: boom', 'Berkas tidak valid', 'Video tidak valid'], ['en', 'Invalid image', 'Could not prepare the image: boom', 'Invalid file', 'Invalid video']]) {
    const win = {}, c = ctxFor(lang, { window: win, location: { pathname: '/' }, fetch: async () => { throw new Error('boom'); }, document: { addEventListener() {} } });
    vm.runInContext(rd('archne-api-http.js'), c); const api = win.api;
    let r = await api.pgCreate('hai', 'public', [{ src: { name: 'x' } }]); assert.strictEqual(r.err, img, lang);
    r = await api.pgCreate('hai', 'public', [{ src: { name: 'x', size: 1 } }]); assert.strictEqual(r.err, prep, lang);
    r = await api.pgCreate('hai', 'public', [], [{ src: { name: 'x' } }]); assert.strictEqual(r.err, file, lang);
    r = await api.pgCreate('hai', 'public', [], [], { videos: [{ src: { name: 'x' } }] }); assert.strictEqual(r.err, vid, lang);
  }
  {
    const win = {}, c = ctxFor('en', { window: win, location: { pathname: '/' }, fetch: async () => { throw new Error('boom'); }, document: { addEventListener() {} } });
    vm.runInContext(rd('archne-api-http.js'), c);
    const r = await win.api.pgCreate('hai', 'public', [], [{ src: { name: 'x', size: 1 } }]); assert.strictEqual(r.err, 'Could not prepare the file: boom');
  }
  ok('archne-api-http.js: unggahan gambar/berkas/video tidak valid atau gagal (tanpa I18N / id / en)');
  console.log('wanerri18n: semua lulus');
})().catch((e) => { console.error(e); process.exit(1); });

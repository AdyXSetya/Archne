'use strict';
// Tes i18n D5: penjelasan galat sambungan (EXPLAIN / explain / rerr / event 'link') dari renderer/archne-rtcmux.js dua bahasa.
// Tanpa I18N = teks Indonesia cadangan (dijaga test/archne-rtcmux.js). archne-rtcglue.js dan archne-nativews.js tidak punya teks UI (hanya log teknis).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const R = path.join(__dirname, '..', 'renderer'), rd = (f) => fs.readFileSync(path.join(R, f), 'utf8');
const ok = (n) => console.log('  OK  ' + n);
function load(lang) {
  const c = { Intl, Object, Set, Map, String, console, Error, TypeError, Promise, setTimeout, clearTimeout, Uint8Array, ArrayBuffer, DataView, module: { exports: {} } };
  c.self = c; vm.createContext(c);
  if (lang) { for (const x of ['archne-i18n.js', 'i18n/archne-en.js', 'i18n/archne-id.js']) vm.runInContext(rd(x), c); c.I18N.setLang(lang); }
  vm.runInContext(rd('archne-rtcmux.js'), c);
  return c.module.exports;
}
const REASONS = ['ice-failed', 'timeout', 'offline', 'busy', 'connection-lost', 'channel-closed', 'remote-bye', 'closed', 'stopped', 'setup', 'superseded', 'bad-channel'];
const none = load(null), id = load('id'), en = load('en');

// Mode ID (dan tanpa I18N) identik dengan teks asli
for (const r of REASONS) assert.strictEqual(id.explain(r), none.explain(r), 'id == cadangan: ' + r);
assert(/tidak menjawab/.test(id.explain('timeout')) && /TURN/.test(id.explain('ice-failed')) && /batas/.test(id.explain('busy')));
ok('explain(): mode ID identik dengan teks asli (12 alasan)');

// EN: berbeda dari ID, tidak menyisakan kata Indonesia
const IDW = /\b(tidak|perangkat|sambungan|saluran|gagal|ditutup|dimatikan|digantikan|percobaan|bisa|yang|itu|ini)\b/i;
const seen = new Set();
for (const r of REASONS) {
  const t = en.explain(r);
  assert(t && t !== id.explain(r), 'EN beda dari ID: ' + r);
  assert(!IDW.test(t), 'EN tanpa kata Indonesia: ' + r + ' -> ' + t);
  assert(!seen.has(t), 'teks EN unik: ' + r); seen.add(t);
}
assert(/TURN/.test(en.explain('ice-failed')) && /directly/.test(en.explain('ice-failed')));
ok('explain(): mode EN (12 alasan, tanpa teks Indonesia, unik)');

// Alasan tak dikenal diteruskan apa adanya; nama prototipe tidak bocor
for (const m of [none, id, en]) {
  assert.strictEqual(m.explain('xyz-aneh'), 'xyz-aneh');
  assert.strictEqual(m.explain('constructor'), 'constructor');
  assert.strictEqual(m.explain('toString'), 'toString');
}
ok('explain(): alasan tak dikenal (termasuk nama prototipe) -> teks alasan itu sendiri');

// Bahasa diikuti saat dipanggil (tanpa muat ulang modul)
{
  const c = { Intl, Object, Set, Map, String, console, Error, TypeError, Promise, setTimeout, clearTimeout, Uint8Array, ArrayBuffer, DataView, module: { exports: {} } };
  c.self = c; vm.createContext(c);
  for (const x of ['archne-i18n.js', 'i18n/archne-en.js', 'i18n/archne-id.js']) vm.runInContext(rd(x), c);
  vm.runInContext(rd('archne-rtcmux.js'), c);
  const M = c.module.exports;
  c.I18N.setLang('en'); const a = M.explain('closed');
  c.I18N.setLang('id'); const b = M.explain('closed');
  c.I18N.setLang('en'); const d = M.explain('closed');
  assert.strictEqual(a, 'Connection closed.'); assert.strictEqual(b, 'Sambungan ditutup.'); assert.strictEqual(d, a);
  ok('explain(): mengikuti pergantian bahasa saat dipakai');
}

// Jalur nyata: openStream ke peer offline -> galat membawa teks sesuai bahasa; reason tetap kode
(async () => {
  for (const [lang, M, want] of [[null, none, /tidak sedang online/], ['id', id, /tidak sedang online/], ['en', en, /not online/]]) {
    const wan = { sendSignal: async () => ({ ok: true }), on() {}, off() {}, isOfferer: () => true, peers: () => [], id: 'a'.repeat(16) };
    const rm = M.createRtcMux({ wan, RTCPeerConnection: function () {} });
    let e = null; try { await rm.openStream('b'.repeat(16)); } catch (x) { e = x; }
    assert(e && e.reason === 'offline' && want.test(e.message), 'openStream offline (' + lang + '): ' + (e && e.message));
    if (rm.stop) await Promise.resolve(rm.stop()).catch(() => {});
  }
  ok('createRtcMux: galat peer offline memuat teks per bahasa, reason tetap kode');
  console.log('rtcmuxi18n: semua lulus');
})().catch((e) => { console.error(e); process.exit(1); });

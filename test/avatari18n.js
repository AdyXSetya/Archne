'use strict';
// Tes i18n D3: pesan galat renderer/archne-avatar.js dua bahasa (archne-media.js, archne-camera.js, archne-voicenote.js tidak punya teks UI).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const R = path.join(__dirname, '..', 'renderer'), rd = (f) => fs.readFileSync(path.join(R, f), 'utf8');
function load(lang) {
  const c = { Intl, Object, Set, String, console, Error, Promise, module: { exports: {} } };
  vm.createContext(c);
  if (lang) { for (const x of ['archne-i18n.js', 'i18n/archne-en.js', 'i18n/archne-id.js']) vm.runInContext(rd(x), c); c.I18N.setLang(lang); }
  vm.runInContext(rd('archne-avatar.js'), c); return c.module.exports;
}
const msg = async (A, f) => { try { await A.fromFile(f); } catch (e) { return e.message; } return null; };
(async () => {
  const none = load(null), id = load('id'), en = load('en');
  const big = { size: 26 * 1048576 };
  assert.strictEqual(await msg(none, null), 'Berkas tidak dipilih'); assert.strictEqual(await msg(id, null), 'Berkas tidak dipilih');
  assert.strictEqual(await msg(en, null), 'No file selected');
  assert.strictEqual(await msg(none, big), 'Gambar terlalu besar (maks 25 MB)'); assert.strictEqual(await msg(id, big), 'Gambar terlalu besar (maks 25 MB)');
  assert.strictEqual(await msg(en, big), 'The image is too large (max 25 MB)');
  console.log('  OK  avatar: pesan galat tanpa I18N / id / en');
  console.log('avatari18n: semua lulus');
})().catch((e) => { console.error(e); process.exit(1); });

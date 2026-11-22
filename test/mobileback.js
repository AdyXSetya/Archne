'use strict';
// Tombol Kembali perangkat + tepi-ke-tepi (Fase 2G.1 / 2G.5): jembatan UI <-> cangkang, urutan penanganan di UI, dan isi MainActivity.
const assert = require('assert'), fs = require('fs'), path = require('path');
const LC = require('../renderer/archne-call');
const src = require('./_src').htmlSrc();
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const root = path.join(__dirname, '..');

// 1. nativeBridge: kabar 'back' selalu dijawab; onBack true/false/melempar
{
  const handlers = [], posted = [];
  const parent = { postMessage: (m) => posted.push(m) };
  const w = { parent, addEventListener: (t, f) => { if (t === 'message') handlers.push(f); } };
  const b = LC.nativeBridge(w);
  const send = (d) => handlers.forEach((f) => f({ source: parent, data: d }));
  send({ archne: 'native-app', state: 'back', id: 1 });
  assert.deepStrictEqual(posted.pop(), { archne: 'native', action: 'back-result', id: 1, on: false }); // tanpa pengendali: tidak ditangani
  b.onBack = () => true; send({ archne: 'native-app', state: 'back', id: 2 });
  assert.deepStrictEqual(posted.pop(), { archne: 'native', action: 'back-result', id: 2, on: true });
  b.onBack = () => { throw new Error('x'); }; send({ archne: 'native-app', state: 'back', id: 3 });
  assert.strictEqual(posted.pop().on, false);
  b.onBack = () => 'ya'; send({ archne: 'native-app', state: 'back', id: 4 });
  assert.strictEqual(posted.pop().on, false, 'hanya true yang dihitung');
  handlers.forEach((f) => f({ source: {}, data: { archne: 'native-app', state: 'back', id: 5 } })); // bukan dari induk
  assert.strictEqual(posted.length, 0);
}
ok('jembatan: kabar Kembali dijawab (true / false / galat), hanya dari induk');

// 2. urutan di UI: lembar tambah orang -> kartu diperbesar -> kecilkan panggilan -> dialog
assert(/nbridge\.onBack = \(\) => uiBack\(\)/.test(src));
const ui = src.slice(src.indexOf('function uiBack()'), src.indexOf('// </back>'));
const iView = ui.indexOf('viewKey'), iPick = ui.indexOf('callPick'), iFocus = ui.indexOf('vidFocus'), iMin = ui.indexOf('callMin = true'), iModal = ui.indexOf('backModal()');
assert(iView >= 0 && iView < iPick && iPick < iFocus && iFocus < iMin && iMin < iModal, 'urutan: layar penuh (D.1f), picker, fokus, kecilkan, dialog');
assert(/if \(viewKey\) \{ viewerExit\(\);[^}]*return true; \}/.test(ui), 'layar penuh ditutup dan Kembali dianggap ditangani');
assert(/function backModal/.test(src) && /'#dlgno,#vcancel,#mclose/.test(src) && /dlg && vis\(dlg\)/.test(src), 'dialog konfirmasi didahulukan');
ok('UI: Kembali menutup layar penuh, picker, mengecilkan kartu, mengecilkan panggilan, lalu menutup dialog');

// 3. MainActivity: tepi-ke-tepi
{
  const j = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/xyraori/archne/MainActivity.java'), 'utf8');
  assert(/edgeToEdge\(\);/.test(j) && /setOnApplyWindowInsetsListener\(root/.test(j) && /Type\.ime\(\)/.test(j) && /Type\.displayCutout\(\)/.test(j) && /WindowInsetsCompat\.CONSUMED/.test(j));
  assert(/0xFF0E141B/.test(j) && /setAppearanceLightStatusBars\(false\)/.test(j));
  for (const im of ['androidx.core.graphics.Insets', 'androidx.core.view.ViewCompat', 'androidx.core.view.WindowCompat', 'androidx.core.view.WindowInsetsCompat', 'androidx.core.view.WindowInsetsControllerCompat', 'android.view.View']) assert(j.includes('import ' + im + ';'), 'import ' + im);
  const st = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/res/values/styles.xml'), 'utf8');
  assert(/statusBarColor">#0E141B/.test(st) && /navigationBarColor">#0E141B/.test(st));
}
ok('MainActivity: jarak sebesar sisipan sistem + keyboard, latar dan ikon bilah');
console.log('\nmobileback: ' + pass + ' OK');

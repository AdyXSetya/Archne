'use strict';
// Tes kontrak plugin native Capacitor (Fase 2D). Java tidak bisa dikompilasi di sini (tanpa Android SDK), jadi yang dijaga:
// setiap panggilan pembungkus ke plugin lokal ada metode @PluginMethod-nya, plugin terdaftar di MainActivity, manifest lengkap,
// kode galat "e:<nama>" punya terjemahan, teks native en == id, dan proyek Android tidak lagi memuat Cordova.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const J = (f) => ['mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'xyraori', 'archne', f];
// buang komentar Java tanpa merusak string (mis. "*/*" bukan awal komentar)
const nojc = (s) => s.replace(/"(?:\\.|[^"\\\n])*"|\/\*[\s\S]*?\*\/|\/\/.*$/gm, (m) => (m[0] === '"' ? m : ''));

const wrapper = rd('mobile', 'shell', 'index.html');
const java = { ArchneAudio: rd(...J('ArchneAudio.java')), ArchneDownloads: rd(...J('ArchneDownloads.java')), ArchneBackground: rd(...J('ArchneBackground.java')), ArchneScreen: rd(...J('ArchneScreen.java')) };
const methods = (src) => new Set([...nojc(src).matchAll(/@PluginMethod\s+public void (\w+)\(PluginCall/g)].map((m) => m[1]));

// 1. kontrak pembungkus -> Java
const used = new Map();
const add = (p, m) => { if (!used.has(p)) used.set(p, new Set()); used.get(p).add(m); };
for (const m of wrapper.matchAll(/nat\('(Archne\w+)', '(\w+)'/g)) add(m[1], m[2]);
const act = /var AUDIO_ACT = (\{[^}]*\})/.exec(wrapper); assert(act, 'AUDIO_ACT');
for (const [k, v] of Object.entries(vm.runInNewContext('(' + act[1] + ')'))) if (k !== 'hello') add('ArchneAudio', v); // hello dijawab pembungkus sendiri
add('ArchneDownloads', 'open'); add('ArchneDownloads', 'openWith');
for (const [p, ms] of used) {
  assert(java[p], 'ada Java untuk ' + p);
  const have = methods(java[p]);
  for (const m of ms) assert(have.has(m), p + '.' + m + ' dipanggil pembungkus tapi tidak ada @PluginMethod-nya');
}
ok('semua panggilan nat() pembungkus punya @PluginMethod (' + [...used].map(([p, s]) => p + ':' + s.size).join(' ') + ')');
// metode yang tak dipanggil siapa pun = kemungkinan salah nama
for (const [p, src] of Object.entries(java)) for (const m of methods(src)) assert(used.get(p) && used.get(p).has(m), p + '.' + m + ' tidak dipanggil pembungkus');
ok('tidak ada @PluginMethod yatim');

// 2. nama plugin dan MainActivity
const main = nojc(rd(...J('MainActivity.java')));
for (const [p, src] of Object.entries(java)) {
  assert(new RegExp('@CapacitorPlugin\\(name = "' + p + '"').test(src), p + ': nama @CapacitorPlugin');
  assert(new RegExp('class ' + p + ' extends Plugin').test(src), p + ' extends Plugin');
  assert(main.includes('registerPlugin(' + p + '.class)'), p + ' didaftarkan di MainActivity');
  assert(main.indexOf('registerPlugin(' + p) < main.indexOf('super.onCreate'), 'registerPlugin sebelum super.onCreate');
}
ok('plugin terdaftar di MainActivity sebelum super.onCreate');
assert(!/cordova/i.test(nojc(Object.values(java).join(''))), 'tanpa referensi cordova di kode Java');
ok('Java tanpa referensi Cordova');

// 3. manifest
const mf = rd('mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const need = ['INTERNET', 'ACCESS_NETWORK_STATE', 'ACCESS_WIFI_STATE', 'CHANGE_WIFI_MULTICAST_STATE', 'RECORD_AUDIO', 'CAMERA', 'MODIFY_AUDIO_SETTINGS', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_DATA_SYNC', 'FOREGROUND_SERVICE_MICROPHONE', 'FOREGROUND_SERVICE_MEDIA_PROJECTION', 'WAKE_LOCK', 'POST_NOTIFICATIONS', 'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', 'MANAGE_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE'];
for (const p of need) assert(mf.includes('android.permission.' + p), 'manifest: ' + p);
assert(/<service android:name="com\.xyraori\.archne\.ArchneService"[^>]*foregroundServiceType="dataSync\|microphone\|mediaProjection"/.test(mf), 'service');
assert(/<receiver android:name="com\.xyraori\.archne\.ArchneReceiver"[^>]*exported="false"/.test(mf), 'receiver');
assert(/usesCleartextTraffic="true"/.test(mf), 'cleartext');
assert(/android:required="false"/.test(mf) && mf.includes('android.hardware.camera'), 'kamera opsional');
ok('manifest: izin, service (dataSync|microphone|mediaProjection), receiver, cleartext, kamera opsional');
const fp = rd('mobile', 'android', 'app', 'src', 'main', 'res', 'xml', 'file_paths.xml');
assert(/<files-path /.test(fp), 'file_paths: files-path untuk berkas unduhan'); ok('FileProvider mencakup getFilesDir()');
assert(/ArchneService\.callMode/.test(java.ArchneAudio) && /static void callMode/.test(rd(...J('ArchneService.java')))); ok('ArchneAudio -> ArchneService.callMode ada');
assert(/ArchneService\.screenMode/.test(java.ArchneScreen) && /static boolean screenMode/.test(rd(...J('ArchneService.java'))) && /FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION/.test(rd(...J('ArchneService.java')))); ok('ArchneScreen -> ArchneService.screenMode ada (tipe mediaProjection)');
assert(/io\.github\.webrtc-sdk:android:/.test(rd('mobile', 'android', 'app', 'build.gradle')), 'dependensi libwebrtc'); ok('build.gradle memuat libwebrtc untuk ArchneScreen');

// 4. galat e:<nama> punya terjemahan
const W = /var W = (\{[\s\S]*?\n  \});\n  var lang/.exec(wrapper), dict = vm.runInNewContext('(' + W[1] + ')');
const codes = new Set([...nojc(java.ArchneDownloads + java.ArchneBackground + java.ArchneAudio).matchAll(/"e:(\w+)"/g)].map((m) => m[1]));
for (const c of codes) { assert(dict.en['e_' + c] != null && dict.id['e_' + c] != null, 'terjemahan e_' + c); }
ok('semua kode galat e:<nama> (' + [...codes].join(', ') + ') punya teks en dan id');

// 5. teks native en == id
const xml = (...p) => { const o = {}; for (const m of rd(...p).matchAll(/<string name="([^"]+)">([^<]*)<\/string>/g)) o[m[1]] = m[2]; return o; };
const res = ['mobile', 'android', 'app', 'src', 'main', 'res'];
const en = xml(...res, 'values', 'archne_strings.xml'), id = xml(...res, 'values-in', 'archne_strings.xml');
assert.deepStrictEqual(Object.keys(en).sort(), Object.keys(id).sort()); ok('archne_strings: kunci en == id (' + Object.keys(en).length + ')');
assert(fs.existsSync(path.join(root, ...res, 'drawable', 'ic_stat_archne.xml')), 'ikon notifikasi ada'); ok('ikon notifikasi ic_stat_archne.xml ada');
// 6. tanpa Cordova: tidak ada folder android/ lama, tidak ada skrip penambal, tidak ada dependensi Cordova di mobile/
assert(!fs.existsSync(path.join(root, 'android')), 'folder android/ (Cordova lama) sudah dihapus');
for (const f of ['scripts/cdv.js', 'scripts/android-build.ps1', 'scripts/android-setup.ps1', 'build-android.bat', 'build-android-release.bat', 'setup-android.bat']) assert(!fs.existsSync(path.join(root, f)), f + ' sudah dihapus');
const mpkg = JSON.parse(rd('mobile', 'package.json'));
assert(!Object.keys(Object.assign({}, mpkg.dependencies, mpkg.devDependencies)).some((k) => /cordova/i.test(k)), 'mobile/package.json tanpa dependensi cordova');
ok('tanpa Cordova: android/ lama dan skrip penambalnya sudah tidak ada, tanpa dependensi cordova');

// 7. APK kecil: hanya arm64-v8a secara bawaan, library native dikompres (libnode.so ~120 MB per ABI)
const gr = rd('mobile', 'android', 'app', 'build.gradle');
assert(/abiFilters/.test(gr) && /archne\.abis/.test(gr) && /arm64-v8a/.test(gr) && /armeabi-v7a/.test(gr) && /x86_64/.test(gr), 'build.gradle: abiFilters bawaan semua ABI, bisa diganti lewat -Parchne.abis');
assert(/useLegacyPackaging\s*=\s*true/.test(gr), 'build.gradle: library native dikompres di APK');
ok('ukuran APK: semua ABI bawaan (bisa dibatasi), library native dikompres');
// 8. mode tonton layar penuh (rencana 0.32.0 D.1a): wiring pembungkus -> plugin -> MainActivity
assert(/d\.action === 'viewer'[^;]*nat\('ArchneBackground', 'viewer', \{ on: d\.on === true \}\)/.test(wrapper), 'pembungkus meneruskan aksi viewer');
assert(/viewer\(\) \{[\s\S]*?\}/.test('') || /void viewer\(boolean on\)/.test(main), 'MainActivity.viewer(boolean)');
assert(/ActivityInfo\.SCREEN_ORIENTATION_SENSOR_LANDSCAPE/.test(main), 'landscape dua arah mengikuti sensor');
assert(/ActivityInfo\.SCREEN_ORIENTATION_UNSPECIFIED/.test(main), 'orientasi dipulihkan saat keluar');
assert(!/SCREEN_ORIENTATION_LANDSCAPE\b/.test(main) && !/SCREEN_ORIENTATION_REVERSE_LANDSCAPE/.test(main), 'tidak mengunci satu arah landscape saja');
assert(/c\.hide\(WindowInsetsCompat\.Type\.systemBars\(\)\)/.test(main) && /c\.show\(WindowInsetsCompat\.Type\.systemBars\(\)\)/.test(main), 'bilah sistem disembunyikan dan dimunculkan lagi');
assert(/LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES/.test(main) && /LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT/.test(main), 'mode takik masuk dan pulih');
assert(/viewerOn \? \(WindowInsetsCompat\.Type\.ime\(\) \| WindowInsetsCompat\.Type\.displayCutout\(\)\) : \(WindowInsetsCompat\.Type\.systemBars\(\)/.test(main), 'selama mode tonton jarak bilah dilepas; keyboard dan takik tetap diberi jarak (D.1d)');
assert(/root\.setBackgroundColor\(on \? 0xFF000000 : 0xFF0E141B\)/.test(main), 'latar hitam selama mode tonton, pulih saat keluar (D.1d)');
assert(/\(\(MainActivity\) getActivity\(\)\)\.viewer\(on\)/.test(nojc(java.ArchneBackground)), 'plugin memanggil MainActivity.viewer');
ok('mode tonton layar penuh: landscape dua arah, bilah dan takik masuk-keluar, terhubung dari pembungkus');
assert(/ARCHNE-PROBE getDisplayMedia/.test(wrapper), 'penanda spike A.3 ada'); ok('penanda spike getDisplayMedia (A.3) ada di pembungkus');
console.log('mobileplugins: ' + pass + ' lulus');

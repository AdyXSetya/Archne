'use strict';
// Proyek Android tidak boleh memuat kerangka "cordova". `cap sync` menulis ulangnya tiap build, jadi scripts/mobile-decordova.js
// membuangnya lagi. Tes ini: (1) berkas yang ada sekarang bersih, (2) mobile.ps1 memanggil pembersih SESUDAH cap sync,
// (3) pembersih benar-benar membuang apa yang ditulis ulang cap sync (dan aman diulang), (4) gagal keras bila ada sisa.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const root = path.resolve(__dirname, '..');
const ok = (m) => console.log('ok - ' + m);
const SKIP = new Set(['build', '.gradle', 'node_modules', '.idea', 'gradle', 'public']);
const EXT = /\.(gradle|xml|properties|java|kt|pro|json)$/;
const scan = (dir) => { const hit = []; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!SKIP.has(e.name)) w(p); } else if (EXT.test(e.name) && /cordova/i.test(fs.readFileSync(p, 'utf8'))) hit.push(path.relative(dir, p)); } })(dir); return hit; };

// 1. kondisi sekarang
const android = path.join(root, 'mobile', 'android');
assert.deepStrictEqual(scan(android), [], 'mobile/android bebas referensi cordova');
assert(!fs.existsSync(path.join(android, 'capacitor-cordova-android-plugins')), 'folder modul cordova tidak ada');
const mpkg = JSON.parse(fs.readFileSync(path.join(root, 'mobile', 'package.json'), 'utf8'));
assert(!mpkg.scripts || !mpkg.scripts['prepare-android'], 'skrip prepare-android (sisa spike, tools/ sudah tidak ada) dihapus');
assert(!fs.existsSync(path.join(root, 'spike')) && !fs.existsSync(path.join(root, 'spike.bat')), 'spike/ sudah dihapus');
ok('mobile/android bersih dari cordova');

// 2. mobile.ps1 memanggil pembersih setelah cap sync
const ps = fs.readFileSync(path.join(root, 'scripts', 'mobile.ps1'), 'utf8');
const iSync = ps.indexOf('cap sync android'), iDec = ps.indexOf('mobile-decordova.js'), iGradle = ps.indexOf('gradlew.bat');
assert(iSync > 0 && iDec > iSync && iGradle > iDec, 'urutan: cap sync -> mobile-decordova -> gradlew');
ok('mobile.ps1: cap sync -> decordova -> gradle');

// 3. pembersih pada keadaan pasca-cap-sync (isi persis seperti yang ditulis CLI Capacitor 8 / template)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decordova-'));
const w = (rel, txt) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
const rd = (rel) => fs.readFileSync(path.join(tmp, rel), 'utf8');
for (const rel of ['settings.gradle', 'variables.gradle', 'app/build.gradle', 'app/capacitor.build.gradle', 'app/src/main/res/xml/config.xml']) w(rel, fs.readFileSync(path.join(android, rel), 'utf8'));
w('settings.gradle', "include ':app'\r\ninclude ':capacitor-cordova-android-plugins'\r\nproject(':capacitor-cordova-android-plugins').projectDir = new File('./capacitor-cordova-android-plugins/')\r\n\r\napply from: 'capacitor.settings.gradle'");
w('variables.gradle', "ext {\n    junitVersion = '4.13.2'\n    cordovaAndroidVersion = '14.0.1'\n}");
w('app/build.gradle', "repositories {\n    flatDir{\n        dirs '../capacitor-cordova-android-plugins/src/main/libs', 'libs'\n    }\n}\n\ndependencies {\n    implementation project(':capacitor-android')\n    implementation project(':capacitor-cordova-android-plugins')\n}\n");
w('app/capacitor.build.gradle', '// DO NOT EDIT\n\napply from: "../capacitor-cordova-android-plugins/cordova.variables.gradle"\ndependencies {\n    implementation project(\':capacitor-app\')\n}\n');
w('app/src/main/res/xml/config.xml', "<?xml version='1.0' encoding='utf-8'?>\n<widget version=\"1.0.0\" xmlns=\"http://www.w3.org/ns/widgets\" xmlns:cdv=\"http://cordova.apache.org/ns/1.0\">\n  <access origin=\"*\" />\n</widget>");
w('capacitor-cordova-android-plugins/build.gradle', "ext { cordovaAndroidVersion = '14.0.1' }");
const run = () => cp.spawnSync(process.execPath, [path.join(root, 'scripts', 'mobile-decordova.js'), tmp], { encoding: 'utf8' });
let r = run();
assert.strictEqual(r.status, 0, 'pembersih sukses: ' + r.stdout + r.stderr);
assert(!fs.existsSync(path.join(tmp, 'capacitor-cordova-android-plugins')), 'folder modul dihapus');
assert.deepStrictEqual(scan(tmp), [], 'tidak ada sisa cordova');
assert(rd('settings.gradle').includes('\r\n') && !rd('settings.gradle').includes('cordova') && rd('settings.gradle').includes("apply from: 'capacitor.settings.gradle'"), 'settings.gradle: akhir baris CRLF terjaga, isi lain utuh');
assert(rd('app/build.gradle').includes("dirs 'libs'") && rd('app/build.gradle').includes("implementation project(':capacitor-android')"), 'app/build.gradle: flatDir tetap ada, dependensi lain utuh');
assert(rd('app/capacitor.build.gradle').includes("implementation project(':capacitor-app')"), 'capacitor.build.gradle: dependensi plugin utuh');
assert(rd('variables.gradle').includes('junitVersion'), 'variables.gradle: variabel lain utuh');
assert(/<access origin="\*" \/>/.test(rd('app/src/main/res/xml/config.xml')), 'config.xml tetap ada isinya');
const snap = ['settings.gradle', 'variables.gradle', 'app/build.gradle', 'app/capacitor.build.gradle', 'app/src/main/res/xml/config.xml'].map(rd).join('\0');
r = run();
assert.strictEqual(r.status, 0, 'jalan kedua sukses');
assert.strictEqual(['settings.gradle', 'variables.gradle', 'app/build.gradle', 'app/capacitor.build.gradle', 'app/src/main/res/xml/config.xml'].map(rd).join('\0'), snap, 'idempoten: jalan kedua tidak mengubah apa pun');
ok('pembersih membuang kerangka cordova pasca-cap-sync dan idempoten');

// 4. gagal keras bila ada sisa tak dikenal
w('app/extra.gradle', "// ref ke cordova di sini\n");
r = run();
assert.notStrictEqual(r.status, 0, 'harus gagal bila masih ada referensi cordova');
assert(/extra\.gradle/.test(r.stderr), 'pesan galat menyebut berkas yang bersisa');
fs.rmSync(tmp, { recursive: true, force: true });
ok('pembersih gagal keras dan menyebut berkas bila ada sisa');

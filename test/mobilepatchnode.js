'use strict';
// Crash "node::Assert" saat Activity dibuat ulang: Node dimulai dua kali dalam satu proses. scripts/mobile-patch-node.js menjadikan
// `started`/`ready` plugin bersifat tingkat proses. Tes: tambalan benar dan aman diulang, gagal keras bila plugin berubah, dan mobile.ps1 memanggilnya.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const root = path.resolve(__dirname, '..'), script = path.join(root, 'scripts', 'mobile-patch-node.js');
const ok = (m) => console.log('ok - ' + m);
const mk = (body) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pn-')); const dir = path.join(d, 'node_modules', '@capawesome', 'capacitor-nodejs', 'android', 'src', 'main', 'java', 'io', 'capawesome', 'capacitorjs', 'plugins', 'nodejs'); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'Nodejs.java'); fs.writeFileSync(f, body); return { d, f }; };
const run = (d) => cp.spawnSync(process.execPath, [script, d], { encoding: 'utf8' });

const src = '    private volatile boolean ready = false;\n\n    private volatile boolean started = false;\n';
const t = mk(src);
let r = run(t.d); assert.strictEqual(r.status, 0, r.stderr);
let out = fs.readFileSync(t.f, 'utf8');
assert(/private static volatile boolean ready/.test(out) && /private static volatile boolean started/.test(out), 'keduanya static');
r = run(t.d); assert.strictEqual(r.status, 0); assert.strictEqual(fs.readFileSync(t.f, 'utf8'), out, 'diulang: tidak berubah');
ok('started dan ready dibuat static; aman diulang');

const bad = mk('class X {}'); r = run(bad.d);
assert.notStrictEqual(r.status, 0); assert(/versi plugin berubah/.test(r.stderr));
ok('gagal keras bila plugin berubah (tidak diam-diam)');

const ps = fs.readFileSync(path.join(root, 'scripts', 'mobile.ps1'), 'utf8');
const iNpm = ps.indexOf('npm.cmd ci'), iP = ps.indexOf('mobile-patch-node.js'), iG = ps.indexOf('gradlew.bat');
assert(iNpm > 0 && iP > iNpm && iG > iP, 'urutan: npm ci -> patch-node -> gradlew');
ok('mobile.ps1: npm ci -> patch-node -> gradle');

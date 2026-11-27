'use strict';
// Menyiapkan PHP-WASM di mobile/www/nodejs untuk APK (0.34.0 P.2, Android). Dipanggil scripts/mobile-sync.js; bisa dipakai sendiri dan dites (test/mobilephp.js).
//   stageStub(root, nd)   SEBELUM `npm install`: salin vendor/fs-ext-stub ke <nd>/vendor/fs-ext-stub (package.json memakai "file:vendor/fs-ext-stub" + overrides).
//   finishPhp(root, nd)   SESUDAH `npm install`: (1) buang versi PHP selain 8.3 (±400 MB), (2) ganti setiap fs-ext-extra-prebuilt (symlink `file:` atau paket asli) dengan SALINAN stub
//                         yang nyata (symlink rusak saat aset disalin Gradle / APK), (3) periksa: tidak ada biner native (.node, .so) di node_modules, paket wajib lengkap, .wasm PHP 8.3 ada.
// Kenapa stub: fs-ext-extra-prebuilt adalah modul NATIVE (kunci berkas) tanpa biner android-arm64 (Spike P.1) maupun Node 24.22.3 / Electron 45 (P.1b): boot php-wasm gagal tanpanya.
// Konsekuensi (P.2): kunci berkas selalu "berhasil", jadi SATU Worker per situs adalah syarat keras (dijaga archne-phppool.js).
const fs = require('fs'), path = require('path');

const KEEP = 'node-8-3';
const REQUIRED = ['@php-wasm/node', '@php-wasm/universal', '@php-wasm/util', '@php-wasm/' + KEEP];
const STUB_MARK = 'Stub: kunci berkas selalu berhasil';

function isWasm(f) {
  let fd = -1;
  try { fd = fs.openSync(f, 'r'); const b = Buffer.alloc(4); return fs.readSync(fd, b, 0, 4, 0) === 4 && b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d; } catch { return false; } finally { if (fd >= 0) try { fs.closeSync(fd); } catch {} }
}

function stubDir(root) { return path.join(root, 'vendor', 'fs-ext-stub'); }

function stageStub(root, nd) {
  const src = stubDir(root), dst = path.join(nd, 'vendor', 'fs-ext-stub');
  if (!fs.existsSync(path.join(src, 'dist', 'fs-ext.js'))) throw new Error('vendor/fs-ext-stub tidak ada');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, dereference: true });
  return dst;
}

// Semua direktori bernama `name` di bawah node_modules (termasuk tersarang), tanpa mengikuti symlink.
function findDirs(dir, test, out, depth) {
  out = out || []; depth = depth || 0;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) { if (test(e.name, p)) out.push(p); continue; }
    if (!e.isDirectory()) continue;
    if (test(e.name, p)) { out.push(p); continue; }
    if (depth < 8) findDirs(p, test, out, depth + 1);
  }
  return out;
}
function findFiles(dir, test, out, depth) {
  out = out || []; depth = depth || 0;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (depth < 10) findFiles(p, test, out, depth + 1); } else if (test(e.name)) out.push(p);
  }
  return out;
}

function finishPhp(root, nd, log) {
  log = log || function () {};
  const nm = path.join(nd, 'node_modules'), res = { removed: [], stubs: 0, problems: [] };
  if (!fs.existsSync(path.join(nm, '@php-wasm'))) { res.problems.push('node_modules/@php-wasm tidak ada (npm install gagal?)'); return res; }

  // 1. versi PHP selain 8.3
  for (const d of findDirs(nm, (n, p) => /^node-\d+-\d+$/.test(n) && path.basename(path.dirname(p)) === '@php-wasm' && n !== KEEP)) {
    fs.rmSync(d, { recursive: true, force: true }); res.removed.push(path.relative(nm, d));
  }

  // 2. stub nyata di setiap tempat fs-ext-extra-prebuilt dipasang
  const stub = stubDir(root);
  for (const d of findDirs(nm, (n) => n === 'fs-ext-extra-prebuilt')) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.cpSync(stub, d, { recursive: true, dereference: true });
    res.stubs++;
  }
  if (!res.stubs) res.problems.push('fs-ext-extra-prebuilt tidak terpasang: php-wasm akan mencari biner native');

  // 3. pemeriksaan
  for (const d of findDirs(nm, (n) => n === 'fs-ext-extra-prebuilt')) {
    let l; try { l = fs.lstatSync(d); } catch { l = null; }
    const pj = path.join(d, 'package.json');
    if (!l || l.isSymbolicLink()) res.problems.push('stub berupa symlink: ' + path.relative(nm, d));
    else if (!fs.existsSync(pj) || String(JSON.parse(fs.readFileSync(pj, 'utf8')).description || '').indexOf(STUB_MARK) !== 0) res.problems.push('bukan stub: ' + path.relative(nm, d));
  }
  // .so di @php-wasm/*/extensions adalah modul samping WebAssembly (kepala \0asm), BUKAN biner ELF: hanya .so berkepala lain yang native. .node / .dll / .dylib selalu native.
  for (const f of findFiles(nm, (n) => /\.(node|so|dll|dylib)$/i.test(n))) if (!/\.so$/i.test(f) || !isWasm(f)) res.problems.push('biner native: ' + path.relative(nm, f));
  for (const m of REQUIRED) if (!fs.existsSync(path.join(nm, m, 'package.json'))) res.problems.push('paket wajib tidak ada: ' + m);
  if (!findFiles(path.join(nm, '@php-wasm', KEEP), (n) => /^php_8_3\.wasm$/.test(n)).length) res.problems.push('php_8_3.wasm tidak ada di ' + KEEP);
  for (const d of fs.readdirSync(path.join(nm, '@php-wasm'))) if (/^node-\d+-\d+$/.test(d) && d !== KEEP) res.problems.push('versi PHP lain masih ada: ' + d);
  log('PHP-WASM: ' + res.removed.length + ' versi PHP dibuang, ' + res.stubs + ' stub fs-ext');
  return res;
}

module.exports = { stageStub, finishPhp, isWasm, KEEP, REQUIRED };

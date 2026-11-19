'use strict';
// Tes kelola channel voice (v0.19.0, langkah 8) dengan Core asli di jaringan lokal: member biasa membuat channel terkunci dengan daftar izin awal,
// menambah dan mencabut orang, mengganti nama; semua node sepakat siapa yang boleh masuk, dan yang dicabut saat sedang di dalam otomatis keluar.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-vchm-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); } throw new Error('timeout: ' + label); }
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, vcBeatMs: 300, vcTtlMs: 1500 });
const lan = (c, ...o) => Promise.all(o.map((x) => c.addPeer('127.0.0.1', x.port)));
const ch = (n, gid, cid) => n.vcList(gid).find((x) => x.id === cid);
const who = (n, gid, cid) => (ch(n, gid, cid) ? ch(n, gid, cid).here.map((x) => x.id).sort().join() : '');

(async () => {
  console.log('Archne vchan manage test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D'); const all = [A, B, C, D];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 3), 8000, 'mesh');
  const gid = A.createGroup('Tim', [B.id, C.id, D.id]).id; // A pemilik; B, C, D member biasa
  await until(() => [B, C, D].every((n) => n.getState().groups.some((g) => g.id === gid)), 8000, 'undangan');

  // ---- A. member biasa (B) membuat channel terkunci dengan daftar izin awal [C] ----
  const cid = B.vcCreate(gid, 'Rahasia', true, [C.id]);
  await until(() => all.every((n) => ch(n, gid, cid)), 8000, 'sync');
  const can = (n, who_) => n.vcCanJoin(gid, cid, who_.id);
  for (const n of all) { assert.strictEqual(can(n, B), true, 'pembuat'); assert.strictEqual(can(n, A), true, 'pemilik grup'); assert.strictEqual(can(n, C), true, 'diizinkan'); assert.strictEqual(can(n, D), false, 'D belum diizinkan'); }
  assert.strictEqual(ch(D, gid, cid).canJoin, false); assert.strictEqual(ch(D, gid, cid).canManage, false); assert.strictEqual(ch(B, gid, cid).canManage, true);
  assert.throws(() => D.vcEnter(gid, cid), /tidak|izin|terkunci/i, 'D ditolak masuk');
  assert.throws(() => B.vcCreate(gid, 'X', true, ['f'.repeat(16)]), /anggota grup/, 'daftar izin berisi non-anggota ditolak Core (UI menyaringnya)');
  ok('member biasa membuat channel terkunci dengan daftar izin awal: pembuat, pemilik, dan yang diizinkan boleh; D ditolak di semua node');

  // ---- B. tambah D, ganti nama: sepakat di semua node ----
  B.vcUpdate(gid, cid, { name: 'Rapat tim', locked: true, allow: [C.id, D.id] });
  await until(() => all.every((n) => ch(n, gid, cid).name === 'Rapat tim' && can(n, D) === true), 8000, 'tambah D + ganti nama');
  assert.throws(() => C.vcUpdate(gid, cid, { name: 'bajak' }), /pembuat channel atau admin/, 'yang diizinkan bukan pengelola');
  ok('menambah D dan mengganti nama: semua node sepakat; yang hanya diizinkan tidak bisa mengelola');

  // ---- C. D dan C masuk; B mencabut D saat ia di dalam: D keluar otomatis, C tetap ----
  C.vcEnter(gid, cid); D.vcEnter(gid, cid);
  await until(() => who(A, gid, cid) === [C.id, D.id].sort().join(), 8000, 'presence');
  B.vcUpdate(gid, cid, { allow: [C.id] });
  await until(() => D._vcMe === null && who(A, gid, cid) === C.id, 8000, 'D dicabut');
  assert(C._vcMe && C._vcMe.cid === cid, 'C tetap di channel');
  assert.throws(() => D.vcEnter(gid, cid), /tidak|izin|terkunci/i, 'D tidak bisa masuk lagi');
  ok('izin D dicabut saat ia di dalam: D keluar otomatis, daftar kehadiran bersih, C tidak terganggu');

  // ---- D. dibuka kuncinya: semua boleh; dikunci lagi: D kembali ditolak ----
  B.vcUpdate(gid, cid, { locked: false });
  await until(() => can(D, D) === true, 8000, 'buka kunci');
  D.vcEnter(gid, cid); await until(() => who(A, gid, cid) === [C.id, D.id].sort().join(), 8000, 'D masuk');
  B.vcUpdate(gid, cid, { locked: true });
  await until(() => D._vcMe === null && who(A, gid, cid) === C.id, 8000, 'dikunci lagi');
  ok('buka kunci: D bisa masuk; kunci lagi: D keluar otomatis (izinnya memang sudah dicabut)');

  for (const n of all) { try { n.vcLeave(); } catch {} await n.stop(); }
  console.log('\n' + pass + ' skenario lolos'); process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

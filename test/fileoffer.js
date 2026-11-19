'use strict';
// Tes tawaran berkas (v0.7.0 tahap 3, langkah 1): pesan tawaran bertanda tangan, batas per chat, penolakan tawaran palsu.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core, verifyMsg } = require('../src/archne-core');
const O = require('../src/archne-fileoffer');
const MB = 1048576;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-offer-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false }, o));
const msg = (c, id) => c.getState().messages.find((x) => x.id === id);
const f = (n) => path.join(tmp, n);
const hash = crypto.createHash('sha256').update('x').digest('hex');
const meta = (o) => Object.assign({ v: 1, mode: 'raw', size: 10, psize: 10, hash }, o);

(async () => {
  // ---- 1. nama aman ----
  assert.strictEqual(O.safeName('a\\b/c.txt'), 'a_b_c.txt');
  for (const n of ['../../x.exe', 'a\\b\\c.txt', 'C:\\Windows\\x', 'ok\u0000.txt', 'CON.txt', '  ..  ', '']) {
    const s = O.safeName(n);
    assert(!/[\\/:\u0000-\u001f]/.test(s) && s && !/^\.+$/.test(s), 'nama tidak aman: ' + JSON.stringify(s));
  }
  assert(O.safeName('a'.repeat(500) + '.pdf').length <= O.NAME_MAX && O.safeName('a'.repeat(500) + '.pdf').endsWith('.pdf'));
  ok('nama berkas: tanpa folder/karakter kontrol/nama khusus Windows, ekstensi tetap ada saat dipotong');

  // ---- 2. parse tawaran: batas ukuran menurut jenis chat, meta rusak ditolak ----
  const enc = (m) => O.encodeOffer('a.txt', m);
  assert.strictEqual(O.parseOffer('halo biasa', 'public'), undefined);
  assert(O.parseOffer(enc(meta({ size: 50 * MB, psize: 50 * MB })), 'public'));
  assert.strictEqual(O.parseOffer(enc(meta({ size: 50 * MB + 1, psize: 50 * MB + 1 })), 'public'), null);
  assert(O.parseOffer(enc(meta({ size: 100 * MB, psize: 100 * MB })), 'g:abc'));
  assert.strictEqual(O.parseOffer(enc(meta({ size: 100 * MB + 1, psize: 100 * MB + 1 })), '0123456789abcdef'), null);
  assert.strictEqual(O.parseOffer(O.FILE + '{bukan json', 'public'), null);
  assert.strictEqual(O.parseOffer(O.FILE + JSON.stringify({ n: 'a', m: { v: 1, mode: 'zip', size: 1, psize: 1, hash } }), 'public'), null);
  assert.strictEqual(O.parseOffer(O.FILE + JSON.stringify({ n: 'a', m: { v: 1, mode: 'raw', size: 1, psize: 1, hash: 'xx' } }), 'public'), null);
  assert.strictEqual(O.parseOffer(O.FILE + JSON.stringify({ n: 'a', m: { v: 1, mode: 'br', size: 10, psize: 99999, hash } }), 'public'), null);
  ok('tawaran: batas 50 MB publik / 100 MB DM+grup dihitung pada ukuran asli; JSON, mode, hash, psize aneh ditolak');

  // ---- 3. kirim berkas: publik, DM, grup ----
  const A = mk('A', { tickMs: 100, syncMs: 150 }), B = mk('B', { tickMs: 100, syncMs: 150 });
  await A.start(); await B.start();
  await A.addPeer('127.0.0.1', B.port);
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 3000, 'A-B online');

  let s = 7; const lines = [];
  for (let i = 0; i < 20000; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; lines.push('INFO user=' + (s % 500) + ' GET /api/item/' + (s % 9000) + ' 200\n'); }
  fs.writeFileSync(f('log.txt'), lines.join(''));
  fs.writeFileSync(f('rand.bin'), crypto.randomBytes(300000));

  const m1 = await A.sendFile(f('log.txt'), 'public');
  const st1 = A.store.files[m1.id];
  assert(st1.staged && st1.meta.mode === 'br' && fs.existsSync(st1.path) && st1.path.startsWith(path.join(A.opts.dataDir, 'out')));
  assert(verifyMsg(m1) && m1.text.startsWith(O.FILE));
  await until(() => msg(B, m1.id), 3000, 'B menerima tawaran publik');
  const fb = msg(B, m1.id).file;
  assert.strictEqual(fb.name, 'log.txt'); assert.strictEqual(fb.mode, 'br');
  assert.strictEqual(fb.size, fs.statSync(f('log.txt')).size); assert(fb.psize < fb.size * 0.4);
  assert.strictEqual(msg(B, m1.id).text, '📎 log.txt');
  ok('publik: log dikompres ke ' + fb.psize + ' dari ' + fb.size + ' byte, B menerima tawaran bertanda tangan dengan meta benar');

  const m2 = await A.sendFile(f('rand.bin'), B.id);
  const st2 = A.store.files[m2.id];
  assert(!st2.staged && st2.path === f('rand.bin') && st2.meta.mode === 'raw');
  assert(!fs.readdirSync(path.join(A.opts.dataDir, 'out')).some((n) => n.endsWith('.part')));
  assert(m2.kind === 'e1' && !m2.text.includes('rand.bin'), 'DM: tawaran terenkripsi, nama berkas tidak terlihat');
  await until(() => msg(B, m2.id), 3000, 'B menerima tawaran DM');
  assert.strictEqual(msg(B, m2.id).file.mode, 'raw');
  assert(!fs.existsSync(path.join(A.opts.dataDir, 'out', 'rand.bin')));
  ok('DM: acak tetap raw tanpa salinan di disk; tawaran terenkripsi (nama berkas tidak bocor), dibuka B');

  await A.createGroup('G', [B.id]);
  await until(() => A.getState().groups.length && B.getState().groups.length, 4000, 'grup');
  const gid = 'g:' + A.getState().groups[0].id;
  const m3 = await A.sendFile(f('log.txt'), gid);
  await until(() => msg(B, m3.id), 3000, 'B menerima tawaran grup');
  assert.strictEqual(msg(B, m3.id).file.name, 'log.txt');
  ok('grup: tawaran sampai ke anggota');

  // ---- 4. batas & kegagalan: tidak ada sisa ----
  const big = f('big.bin'); const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, 50 * MB + 1); fs.closeSync(fd);
  const n0 = Object.keys(A.store.msgs).length, out0 = fs.readdirSync(path.join(A.opts.dataDir, 'out')).length;
  await assert.rejects(() => A.sendFile(big, 'public'), (e) => e.code === 'limit');
  await A.sendFile(big, B.id).then(() => {}, (e) => assert.fail('50 MB+1 harus lolos batas DM (100 MB): ' + e.message));
  fs.rmSync(big);
  assert.strictEqual(Object.keys(A.store.msgs).length, n0 + 1);
  await assert.rejects(() => A.sendFile(f('tidak-ada.txt'), 'public'));
  await assert.rejects(() => A.sendFile(f('log.txt'), 'g:nggakada'), /Grup tidak dikenal/);
  await assert.rejects(() => A.sendFile(f('log.txt'), 'ffffffffffffffff'), /Kunci enkripsi/);
  assert.strictEqual(Object.keys(A.store.msgs).length, n0 + 1);
  assert.strictEqual(fs.readdirSync(path.join(A.opts.dataDir, 'out')).filter((n) => n.endsWith('.part')).length, 0);
  ok('berkas 50 MB+1: publik ditolak (limit), DM lolos; tujuan/berkas tidak valid ditolak tanpa pesan atau sisa .part');

  // ---- 5. tawaran palsu dari peer: ditolak penerima ----
  const forged = A._makeMsg('public', null, O.FILE + JSON.stringify({ n: 'x', m: { v: 1, mode: 'raw', size: 60 * MB, psize: 60 * MB, hash } }));
  assert.strictEqual(B._ingest(forged, true), 'bad');
  const junk = A._makeMsg('public', null, O.FILE + '{{{');
  assert.strictEqual(B._ingest(junk, true), 'bad');
  assert(!B.store.msgs[forged.id] && !B.store.msgs[junk.id]);
  ok('peer yang melanggar batas atau mengirim tawaran rusak ditolak, tidak masuk store');

  // ---- 6. pengguna tidak bisa memalsukan tawaran lewat sendText ----
  const t = A.sendText(O.FILE + JSON.stringify({ n: 'p', m: meta() }), 'public');
  assert(!t.text.startsWith(O.FILE) && !msg(A, t.id).file);
  ok('sendText menyaring penanda kontrol: teks ketikan tidak pernah jadi tawaran berkas');

  // ---- 7. batal kirim membersihkan salinan kompres, berkas asli tidak disentuh ----
  const stagedPath = st1.path;
  A.deleteMessage(m1.id);
  assert(!A.store.files[m1.id]);
  await until(() => !fs.existsSync(stagedPath), 2000, 'salinan terhapus');
  assert(fs.existsSync(f('log.txt')) && fs.existsSync(f('rand.bin')));
  A.deleteMessage(m2.id);
  assert(fs.existsSync(f('rand.bin')), 'berkas asli pengguna tidak boleh ikut terhapus');
  ok('batal kirim: salinan kompres dihapus, berkas asli (raw) tetap utuh');

  // ---- 8. bertahan setelah restart ----
  A._saveNow(); await A.stop();
  const A2 = mk('A', {}); await A2.start();
  assert(A2.store.files[m3.id] && fs.existsSync(A2.store.files[m3.id].path));
  await A2.stop(); await B.stop();
  ok('daftar berkas kirim bertahan setelah restart');

  console.log(`\n${pass} tes lulus`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

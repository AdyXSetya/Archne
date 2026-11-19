'use strict';
// Tes Kirim Langsung (v0.24.0): transfer berkas/folder tanpa batas, HANYA LAN. Struktur sama, nama kembar, folder kosong, berkas 0 byte,
// putus di tengah -> sambung ulang otomatis, pause/resume, restart aplikasi di KEDUA sisi, banyak berkas kecil, dan sisi serangan:
// path traversal dari pengirim jahat, alamat non-LAN/rtc:, penyamar, berkas diubah setelah ditawarkan, batas koneksi.
const os = require('os'), path = require('path'), fs = require('fs'), net = require('net'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const Direct = require('../src/archne-direct');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-direct-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(10); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, extra) => new Core(Object.assign({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 }, extra));
const f = (...n) => path.join(tmp, ...n);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
// peta relpath -> sha256 | 'DIR' (folder kosong saja dihitung; folder berisi tak perlu)
function walk(root, rel = '', out = {}) {
  const ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  if (!ents.length && rel) out[rel] = 'DIR';
  for (const e of ents) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(root, r, out); else if (e.isFile()) out[r] = sha(path.join(root, r));
  }
  return out;
}
const inboxOf = (c, s) => c.directState().in.find((x) => x.id === s.id);
const st = (c, id) => { const r = c.directState().in.find((x) => x.id === id); return r && r.state; };
const code = (c) => (e) => e && e.code === c;
const raw = (port, obj) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port });
  let buf = ''; s.setEncoding('utf8');
  s.on('data', (d) => { buf += d; }); s.on('close', () => res(buf.split('\n')[0])); s.on('error', () => {});
  s.on('connect', () => s.write(JSON.stringify(obj) + '\n'));
});

(async () => {
  let A = mk('A'), B = mk('B');
  await A.start(); await B.start();
  await A.addPeer('127.0.0.1', B.port); await B.addPeer('127.0.0.1', A.port);
  await until(() => A.isOnline(A.peers.get(B.id)) && B.isOnline(B.peers.get(A.id)), 4000, 'peer online');

  // ---- sumber: folder bertingkat ----
  const src = f('src', 'Proyek');
  fs.mkdirSync(path.join(src, 'a', 'b', 'c'), { recursive: true });
  fs.mkdirSync(path.join(src, 'kosong'), { recursive: true });
  fs.mkdirSync(path.join(src, 'empty-parent', 'empty-child'), { recursive: true });
  fs.writeFileSync(path.join(src, 'halo.txt'), 'halo dunia');
  fs.writeFileSync(path.join(src, 'nol.bin'), '');
  fs.writeFileSync(path.join(src, 'a', 'b', 'c', 'dalam.dat'), crypto.randomBytes(300000));
  fs.writeFileSync(path.join(src, 'a', 'unicode ✓ ñ.txt'), 'uni');
  fs.writeFileSync(path.join(src, 'a', 'we?ird:name.txt'), 'karakter terlarang di Windows');
  fs.writeFileSync(path.join(src, 'besar.bin'), crypto.randomBytes(5 * 1048576));
  try { fs.symlinkSync('/etc', path.join(src, 'tautan')); } catch {}
  const srcMap = walk(src); delete srcMap['a/we?ird:name.txt']; srcMap['a/we_ird_name.txt'] = sha(path.join(src, 'a', 'we?ird:name.txt'));

  // ---- 0. aturan LAN ----
  assert.strictEqual(A._directOk('192.168.1.5'), true);
  assert.strictEqual(A._directOk('10.1.2.3'), true);
  assert.strictEqual(A._directOk('::ffff:172.16.0.9'), true);
  assert.strictEqual(A._directOk('127.0.0.1'), true);
  for (const bad of ['8.8.8.8', '203.0.113.5', 'rtc:' + 'a'.repeat(16), '100.64.1.1', 'bukan-ip', '', null]) assert.strictEqual(A._directOk(bad), false, 'harus ditolak: ' + bad);
  A.opts.directVpn = true; assert.strictEqual(A._directOk('100.64.1.1'), true, 'VPN hanya bila diizinkan'); A.opts.directVpn = false;
  ok('aturan LAN-only: pribadi/loopback boleh; publik, rtc:, VPN ditolak');

  const origIp = A.peers.get(B.id).ip;
  A.peers.get(B.id).ip = '8.8.8.8';
  await assert.rejects(A.directSend(B.id, [src]), code('lan'));
  A.peers.get(B.id).ip = 'rtc:' + B.id;
  await assert.rejects(A.directSend(B.id, [src]), code('lan'));
  A.peers.get(B.id).ip = origIp;
  B.opts.directAllow = () => false; // penerima menganggap pengirim bukan LAN
  await assert.rejects(A.directSend(B.id, [src]), code('denied'));
  delete B.opts.directAllow;
  assert.deepStrictEqual(A.directState().out, [], 'penolakan tidak meninggalkan sesi');
  ok('kirim ke peer non-LAN/rtc: ditolak di pengirim; penerima non-LAN menolak tawaran');

  // ---- 1. folder utuh ----
  const s1 = await A.directSend(B.id, [src]);
  assert.strictEqual(s1.kind, 'dir'); assert.strictEqual(s1.name, 'Proyek');
  await until(() => inboxOf(B, s1), 3000, 'tawaran sampai');
  assert.strictEqual(inboxOf(B, s1).state, 'offered');
  assert.strictEqual(fs.existsSync(B.opts.downloadDir), false, 'belum menerima = belum ada yang ditulis');
  const offers = []; B.on('direct_offer', (o) => offers.push(o));
  const got = []; B.on('direct_file', (e) => got.push(e));
  await B.directAccept(s1.id);
  await until(() => st(B, s1.id) === 'done', 15000, 'selesai');
  assert(got.length > 0 && got.every((e) => e.id === s1.id && path.isAbsolute(e.path) && fs.existsSync(e.path) && e.rel.startsWith('Proyek/')), 'direct_file: satu event per berkas lengkap (path absolut + rel di bawah folder teratas)');
  const dest1 = path.join(B.opts.downloadDir, 'file_transfer', 'Proyek');
  assert.deepStrictEqual(walk(dest1), srcMap, 'struktur dan isi sama persis (folder kosong, 0 byte, unicode, nama dibersihkan)');
  assert(!fs.existsSync(path.join(dest1, 'tautan')), 'symlink tidak ikut');
  assert.strictEqual(fs.statSync(path.join(dest1, 'halo.txt')).mtimeMs / 1000 | 0, fs.statSync(path.join(src, 'halo.txt')).mtimeMs / 1000 | 0, 'mtime dipertahankan');
  assert.deepStrictEqual(fs.readdirSync(dest1, { recursive: true }).filter((x) => x.endsWith(Direct.PART)), [], 'tidak ada sisa .part');
  await until(() => A.directState().out.find((x) => x.id === s1.id).state === 'done', 3000, 'pengirim tahu selesai');
  ok('folder utuh: struktur, isi, folder kosong, 0 byte, unicode, mtime; symlink dilewati; pengirim ikut tahu selesai');

  // ---- 2. nama kembar: kirim lagi -> "Proyek (2)" ----
  const s2 = await A.directSend(B.id, [src]);
  await until(() => inboxOf(B, s2)); await B.directAccept(s2.id);
  await until(() => st(B, s2.id) === 'done');
  assert.deepStrictEqual(walk(path.join(B.opts.downloadDir, 'file_transfer', 'Proyek (2)')), srcMap);
  assert.deepStrictEqual(walk(dest1), srcMap, 'yang lama tidak tertimpa');
  // berkas tunggal + beberapa item sekaligus
  const s3 = await A.directSend(B.id, [f('src', 'Proyek', 'halo.txt'), f('src', 'Proyek', 'a')]);
  assert.strictEqual(s3.kind, 'dir');
  await until(() => inboxOf(B, s3)); await B.directAccept(s3.id, { dir: f('alt') });
  await until(() => st(B, s3.id) === 'done');
  assert.strictEqual(fs.readFileSync(f('alt', 'halo.txt'), 'utf8'), 'halo dunia');
  assert(fs.existsSync(f('alt', 'a', 'b', 'c', 'dalam.dat')), 'beberapa item sekaligus + folder tujuan pilihan sendiri');
  const s3b = await A.directSend(B.id, [f('src', 'Proyek', 'halo.txt')]);
  assert.strictEqual(s3b.kind, 'file');
  await until(() => inboxOf(B, s3b)); await B.directAccept(s3b.id, { dir: f('alt') });
  await until(() => st(B, s3b.id) === 'done');
  assert.strictEqual(fs.readFileSync(f('alt', 'halo (2).txt'), 'utf8'), 'halo dunia', 'berkas kembar: akhiran sebelum ekstensi');
  ok('nama kembar tidak menimpa (folder & berkas), banyak item, folder tujuan bisa dipilih');

  // ---- 3. banyak berkas kecil ----
  const many = f('src', 'Banyak');
  for (let d = 0; d < 20; d++) { fs.mkdirSync(path.join(many, 'd' + d), { recursive: true }); for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(many, 'd' + d, 'f' + i + '.txt'), 'isi ' + d + '-' + i); }
  const mapMany = walk(many);
  const t0 = Date.now();
  const s4 = await A.directSend(B.id, [many]);
  assert.strictEqual(s4.count, 800);
  await until(() => inboxOf(B, s4)); await B.directAccept(s4.id);
  await until(() => st(B, s4.id) === 'done', 30000);
  assert.deepStrictEqual(walk(path.join(B.opts.downloadDir, 'file_transfer', 'Banyak')), mapMany);
  ok('800 berkas kecil paralel utuh (' + (Date.now() - t0) + ' ms)');

  // ---- 4. putus di tengah -> sambung ulang otomatis dari .part ----
  fs.writeFileSync(f('src', 'raksasa.bin'), crypto.randomBytes(96 * 1048576));
  const offs = []; let orig = Core.prototype._dxServe.bind(A);
  let cut = 0;
  A._dxServe = (sock, o, ip) => {
    offs.push(o.off); orig(sock, o, ip);
    if (!cut) { cut = 1; const iv = setInterval(() => { if (sock.bytesWritten > 3e6 || sock.destroyed) { clearInterval(iv); sock.destroy(); } }, 1); }
  };
  const s5 = await A.directSend(B.id, [f('src', 'raksasa.bin')]);
  await until(() => inboxOf(B, s5)); await B.directAccept(s5.id);
  const seen = new Set(); B.on('direct', (e) => seen.add(e.state));
  await until(() => st(B, s5.id) === 'done', 30000, 'sambung ulang selesai');
  assert.strictEqual(sha(path.join(B.opts.downloadDir, 'file_transfer', 'raksasa.bin')), sha(f('src', 'raksasa.bin')));
  assert(offs.length >= 2 && offs[0] === 0 && offs.slice(1).some((x) => x > 0), 'permintaan kedua melanjutkan dari posisi terakhir: ' + offs.join(','));
  ok('koneksi diputus di tengah 96 MB: sambung ulang otomatis dan melanjutkan dari offset ' + offs[1]);

  // ---- 5. pause -> resume ----
  const offs2 = []; let cut2 = 0;
  A._dxServe = (sock, o, ip) => {
    offs2.push(o.off); orig(sock, o, ip);
    if (!cut2) { cut2 = 1; const iv = setInterval(() => { if (sock.bytesWritten > 3e6 || sock.destroyed) { clearInterval(iv); sock.destroy(); } }, 1); }
  };
  const s6 = await A.directSend(B.id, [f('src', 'raksasa.bin')]);
  await until(() => inboxOf(B, s6)); await B.directAccept(s6.id);
  await until(() => st(B, s6.id) === 'waiting', 10000, 'menunggu sambung ulang');
  await B.directPause(s6.id);
  assert.strictEqual(st(B, s6.id), 'paused');
  const dest6 = path.join(B.opts.downloadDir, 'file_transfer', 'raksasa (2).bin');
  const part6 = dest6 + Direct.PART;
  assert(fs.existsSync(part6) && fs.statSync(part6).size > 0 && !fs.existsSync(dest6), '.part disimpan, berkas final belum ada');
  const had = fs.statSync(part6).size;
  await sleep(700); assert.strictEqual(fs.statSync(part6).size, had, 'dijeda = tidak ada byte baru');
  assert.strictEqual(st(B, s6.id), 'paused');
  assert(B.directResume(s6.id));
  await until(() => st(B, s6.id) === 'done', 30000);
  assert.strictEqual(sha(dest6), sha(f('src', 'raksasa.bin')));
  assert(offs2.slice(1).some((x) => x >= had), 'resume melanjutkan dari ukuran .part');
  A._dxServe = orig;
  ok('pause: .part tetap, tidak ada byte baru; resume melanjutkan dan hasilnya identik');

  // ---- 6. restart aplikasi di KEDUA sisi di tengah jalan ----
  let cut3 = 0;
  A._dxServe = (sock, o, ip) => { orig(sock, o, ip); if (!cut3) { cut3 = 1; const iv = setInterval(() => { if (sock.bytesWritten > 3e6 || sock.destroyed) { clearInterval(iv); sock.destroy(); } }, 1); } };
  const s7 = await A.directSend(B.id, [f('src', 'raksasa.bin')]);
  await until(() => inboxOf(B, s7)); await B.directAccept(s7.id);
  await until(() => st(B, s7.id) === 'waiting', 10000);
  await B.directPause(s7.id);
  await A.stop(); await B.stop();
  A = mk('A'); B = mk('B'); orig = Core.prototype._dxServe.bind(A); // instance baru: ikat ulang
  await A.start(); await B.start();
  await A.addPeer('127.0.0.1', B.port); await B.addPeer('127.0.0.1', A.port);
  await until(() => A.isOnline(A.peers.get(B.id)) && B.isOnline(B.peers.get(A.id)), 4000);
  assert.strictEqual(A.directState().out.find((x) => x.id === s7.id).state, 'active', 'sesi pengirim dimuat dari disk');
  assert.strictEqual(inboxOf(B, s7).state, 'paused');
  assert(B.directResume(s7.id));
  await until(() => st(B, s7.id) === 'done', 30000, 'selesai setelah restart');
  assert.strictEqual(sha(path.join(B.opts.downloadDir, 'file_transfer', 'raksasa (3).bin')), sha(f('src', 'raksasa.bin')));
  ok('aplikasi ditutup-buka di kedua sisi: sesi dimuat dari disk, resume lanjut sampai identik');

  // ---- 7. penolakan, pembatalan ----
  const s8 = await A.directSend(B.id, [f('src', 'Proyek', 'halo.txt')]);
  await until(() => inboxOf(B, s8)); assert(await B.directDecline(s8.id));
  await until(() => A.directState().out.find((x) => x.id === s8.id).state === 'declined', 3000);
  assert(!inboxOf(B, s8));
  const s9 = await A.directSend(B.id, [f('src', 'Proyek', 'halo.txt')]);
  await until(() => inboxOf(B, s9)); assert(await A.directCancelOut(s9.id));
  await until(() => !inboxOf(B, s9), 3000, 'tawaran yang dibatalkan hilang di penerima');
  // pengirim membatalkan saat penerima sedang menerima
  let cut4 = 0;
  A._dxServe = (sock, o, ip) => { orig(sock, o, ip); if (!cut4) { cut4 = 1; const iv = setInterval(() => { if (sock.bytesWritten > 3e6 || sock.destroyed) { clearInterval(iv); sock.destroy(); } }, 1); } };
  const s10 = await A.directSend(B.id, [f('src', 'raksasa.bin')]);
  await until(() => inboxOf(B, s10)); await B.directAccept(s10.id);
  await until(() => st(B, s10.id) === 'waiting', 10000);
  await A.directCancelOut(s10.id);
  await until(() => st(B, s10.id) === 'cancelled', 5000, 'penerima tahu dibatalkan');
  await until(() => !fs.readdirSync(path.join(B.opts.downloadDir, 'file_transfer')).some((x) => x.endsWith(Direct.PART)), 3000, '.part dibuang saat pengirim membatalkan');
  assert.strictEqual(inboxOf(B, s10).code, 'gone'); assert(!B.directResume(s10.id));
  A._dxServe = orig;
  // penerima membatalkan: .part dibuang, berkas lengkap dibiarkan
  let cut5 = 0;
  A._dxServe = (sock, o, ip) => { orig(sock, o, ip); if (!cut5) { cut5 = 1; const iv = setInterval(() => { if (sock.bytesWritten > 3e6 || sock.destroyed) { clearInterval(iv); sock.destroy(); } }, 1); } };
  const s11 = await A.directSend(B.id, [f('src', 'raksasa.bin')]);
  await until(() => inboxOf(B, s11)); await B.directAccept(s11.id);
  await until(() => st(B, s11.id) === 'waiting', 10000);
  await B.directCancel(s11.id);
  assert(!inboxOf(B, s11));
  const left = fs.readdirSync(path.join(B.opts.downloadDir, 'file_transfer')).filter((x) => x.endsWith(Direct.PART));
  assert.deepStrictEqual(left, [], 'cancel membuang .part');
  await until(() => A.directState().out.find((x) => x.id === s11.id) === undefined || A.directState().out.find((x) => x.id === s11.id).state === 'cancelled', 3000);
  A._dxServe = orig;
  ok('tolak, batal oleh pengirim (sebelum/sesudah menerima), batal oleh penerima membuang .part');

  // ---- 8. berkas berubah setelah ditawarkan: hanya itu yang gagal ----
  const chg = f('src', 'Ubah'); fs.mkdirSync(chg, { recursive: true });
  for (const n of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(chg, n), 'isi ' + n);
  const s12 = await A.directSend(B.id, [chg]);
  fs.writeFileSync(path.join(chg, 'b.txt'), 'DIUBAH SETELAH DITAWARKAN');
  await until(() => inboxOf(B, s12)); await B.directAccept(s12.id);
  await until(() => st(B, s12.id) === 'done', 8000, 'state=' + JSON.stringify(inboxOf(B, s12)));
  assert.strictEqual(inboxOf(B, s12).failed, 1);
  const d12 = path.join(B.opts.downloadDir, 'file_transfer', 'Ubah');
  assert.deepStrictEqual(fs.readdirSync(d12).sort(), ['a.txt', 'c.txt']);
  ok('berkas diubah setelah ditawarkan: ditolak per berkas, sisanya selesai, hitungan gagal benar');

  // ---- 9. sisi serangan: server ----
  const s13 = await A.directSend(B.id, [f('src', 'Proyek', 'halo.txt')]);
  await until(() => inboxOf(B, s13));
  const hiB = B.hello(), hiC = Object.assign({}, B.hello(), { id: 'f'.repeat(16) });
  const get = (extra) => raw(A.port, Object.assign({ t: 'dx_get', id: s13.id, i: 0, off: 0, hi: hiB }, extra)).then((l) => { try { return JSON.parse(l); } catch { return null; } });
  assert.strictEqual((await get({})).ok, true, 'peminta sah dilayani');
  assert.strictEqual((await get({ hi: hiC })).err, 'denied', 'penyamar/orang lain ditolak');
  assert.strictEqual((await get({ hi: undefined })).err, 'denied', 'tanpa identitas ditolak');
  assert.strictEqual((await get({ id: 'a'.repeat(32) })).err, 'gone');
  assert.strictEqual((await get({ id: '../etc' })).err, 'bad');
  assert.strictEqual((await get({ i: 99 })).err, 'bad');
  assert.strictEqual((await get({ i: -1 })).err, 'bad');
  assert.strictEqual((await get({ off: 10 ** 9 })).err, 'range');
  assert.strictEqual((await get({ off: 1.5 })).err, 'bad');
  A.opts.directAllow = () => false;
  assert.strictEqual((await get({})).err, 'lan', 'sumber non-LAN ditolak walau identitas benar');
  assert.strictEqual(JSON.parse(await raw(A.port, { t: 'dx_list', id: s13.id, from: 0, hi: hiB })).err, 'lan');
  delete A.opts.directAllow;
  assert.strictEqual(JSON.parse(await raw(A.port, { t: 'dx_list', id: s13.id, from: 0, hi: hiC })).err, 'denied');
  A.store.blocked[B.id] = { ts: Date.now() };
  assert.strictEqual((await get({})).err, 'denied', 'yang diblokir tidak dilayani');
  delete A.store.blocked[B.id];
  // batas koneksi serentak per IP: 16
  const hold = [];
  for (let i = 0; i < 20; i++) hold.push(new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port: A.port }); s.on('connect', () => s.write(JSON.stringify({ t: 'dx_get', id: s13.id, i: 0, off: 0, hi: hiB }) + '\n')); s.on('data', () => {}); s.on('error', () => {}); s.on('close', res); setTimeout(() => s.destroy(), 400); }));
  await Promise.all(hold);
  ok('server: penyamar, tanpa identitas, id/indeks/offset ngawur, sumber non-LAN, diblokir semuanya ditolak');

  // ---- 10. sisi serangan: pengirim jahat (path berbahaya) ----
  const bad = [['../../luar.txt'], ['/etc/passwd'], ['a/../../x'], ['C:\\Windows\\x'], ['a\\b'], ['a//b'], ['']];
  for (const [p] of bad) {
    const sx = await A.directSend(B.id, [f('src', 'Proyek', 'halo.txt')]);
    A._dxOut.get(sx.id).files[0].p = p;
    await until(() => inboxOf(B, sx));
    await assert.rejects(B.directAccept(sx.id), code('unsafe'), 'ditolak: ' + JSON.stringify(p));
    assert.strictEqual(st(B, sx.id), 'error');
  }
  assert(!fs.existsSync(f('luar.txt')) && !fs.existsSync(path.join(B.opts.downloadDir, 'luar.txt')));
  // nama berbahaya tapi "legal": dibersihkan, tidak keluar root
  const sw = await A.directSend(B.id, [f('src', 'Proyek', 'halo.txt')]);
  Object.assign(A._dxOut.get(sw.id).files[0], { p: 'CON' }); // nama cadangan Windows
  await until(() => inboxOf(B, sw)); await B.directAccept(sw.id);
  await until(() => st(B, sw.id) === 'done');
  assert(fs.existsSync(path.join(B.opts.downloadDir, 'file_transfer', '_CON')));
  assert.deepStrictEqual(Direct.planRel([{ p: 'x/A.txt' }, { p: 'x/a.TXT' }, { p: 'x/b?.txt' }]), ['x/A.txt', 'x/a (2).TXT', 'x/b_.txt'], 'tabrakan setelah dibersihkan -> akhiran');
  assert.strictEqual(Direct.under('/tmp/root', '../x'), null);
  ok('pengirim jahat: "..", mutlak, drive, "\\", "//", kosong ditolak; nama cadangan/tabrakan dibersihkan; tidak ada yang keluar dari folder tujuan');

  // ---- 11. tawaran ngawur / spam ----
  const hiA = A.hello();
  const off = (extra) => raw(B.port, Object.assign({ t: 'dx_offer', id: crypto.randomBytes(16).toString('hex'), name: 'x', kind: 'file', count: 1, size: 1, hi: hiA }, extra)).then((l) => JSON.parse(l));
  assert.strictEqual((await off({})).ok, true);
  for (const x of [{ id: 'zz' }, { name: 5 }, { kind: 'lain' }, { count: 0 }, { count: 1e9 }, { size: -1 }, { size: 1.5 }]) assert.strictEqual((await off(x)).ok, false, JSON.stringify(x));
  assert.strictEqual((await off({ hi: hiC })).ok, false, 'pengirim tak dikenal');
  let busy = 0; for (let i = 0; i < 30; i++) if (!(await off({})).ok) busy++;
  assert(busy >= 9, 'tawaran menumpuk dari satu peer dibatasi (20)');
  ok('tawaran ngawur ditolak; tawaran menumpuk dari satu peer dibatasi');

  await A.stop(); await B.stop();
  console.log('\n' + pass + ' kelompok tes lulus');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

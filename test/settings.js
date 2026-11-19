'use strict';
// Tes backend pengaturan kuota (v0.22.1, Step 2e): bawaan/minimum, validasi (semua atau tidak sama sekali), penerapan ke batas Core, 'unlimited' aman-JSON,
// settings.json bertahan lewat restart (+ .bak, berkas rusak/diedit tangan), nilai asal opts dipulihkan, penegakan SEKARANG saat kuota diturunkan
// (titipan, pesan publik, kolam berkas publik/grup, seed; kolam DM tidak digusur), IPC + preload + api-http.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const K = require('../src/core/archne-constants');
const { register } = require('../src/archne-ipc');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-settings-'));
let pass = 0, seq = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const MB = 1048576;
const hex = (n, len) => n.toString(16).padStart(len, '0');
const mk = (n, o) => { const c = new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false }, o || {})); c._kick = () => {}; c._save = () => {}; return c; };
const fakeDm = (from, text, to) => ({ id: hex(++seq, 32), from, to: to || 'a'.repeat(16), kind: 'e1', ts: Date.now(), text, pub: 'p', sig: 's' });
const sender = (i) => hex(i + 1, 16);

(async () => {
  // 1. bawaan dan minimum; usage aman-JSON
  const A = mk('A');
  const g = A.getSettings();
  assert.strictEqual(g.ok, true);
  assert.deepStrictEqual(Object.keys(g.items).sort(), ['cust', 'escMax', 'files', 'pubMsgs']);
  assert.deepStrictEqual([g.items.cust.min, g.items.files.min, g.items.pubMsgs.min], [10 * MB, 100 * MB, 5 * MB]);
  assert.deepStrictEqual([g.items.cust.def, g.items.files.def, g.items.pubMsgs.def], [K.CUST_DM_QUOTA, K.ESC_QUOTA, K.PUBMSG_QUOTA]);
  for (const it of Object.values(g.items)) assert.strictEqual(it.custom, false), assert.strictEqual(it.value, it.def);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.usage)), g.usage, 'usage lolos JSON tanpa berubah');
  assert(!fs.existsSync(path.join(tmp, 'A', 'settings.json')), 'belum ada berkas sebelum ada perubahan');
  ok('bawaan (500/500/20 MB) dan minimum (10/100/5 MB); usage aman-JSON; belum ada settings.json');

  // 2. validasi: semua atau tidak sama sekali
  const bad = (p, code, key) => { const r = A.setSettings(p); assert.strictEqual(r.ok, false, JSON.stringify(p)); assert.strictEqual(r.code, code, JSON.stringify(p)); if (key) assert.strictEqual(r.key, key); return r; };
  for (const p of [null, undefined, 5, 'x', [1]]) bad(p, 'bad');
  bad({ nope: 20 * MB }, 'bad', 'nope'); bad({ __proto__x: 1, toString: 1 }, 'bad');
  for (const v of [0, -1, 1.5, NaN, Infinity, '20971520', true, {}, [], 2 ** 60]) bad({ cust: v }, 'bad', 'cust');
  assert.strictEqual(bad({ cust: 10 * MB - 1 }, 'min', 'cust').min, 10 * MB);
  assert.strictEqual(bad({ files: 99 * MB }, 'min', 'files').min, 100 * MB);
  assert.strictEqual(bad({ pubMsgs: 4 * MB }, 'min', 'pubMsgs').min, 5 * MB);
  bad({ cust: 20 * MB, files: 1 }, 'min', 'files');
  assert.strictEqual(A.getSettings().items.cust.custom, false, 'cust tidak ikut berubah saat files ditolak');
  assert(!fs.existsSync(path.join(tmp, 'A', 'settings.json')), 'penolakan tidak menulis berkas');
  assert.strictEqual(A.setSettings({}).ok, true, 'patch kosong sah');
  ok('patch tidak sah ditolak (bad/min dengan key dan min), atomik: tidak ada yang berubah dan tidak ada yang tertulis');

  // 3. penerapan ke batas Core
  const B = mk('B');
  let r = B.setSettings({ cust: 10 * MB, files: 100 * MB, pubMsgs: 5 * MB });
  assert.strictEqual(r.ok, true);
  const L = B._custLimits();
  assert.deepStrictEqual([L.dm.quota, L.gmsg.quota, L.pub.quota], [10 * MB, 10 * MB, 5 * MB]);
  assert.deepStrictEqual([B._escLimits().quota, B._pubLimits().quota, B._grpLimits().quota, B.opts.seedQuota], [100 * MB, 100 * MB, 100 * MB, 100 * MB]);
  assert.strictEqual(L.dm.perSender, Math.floor(10 * MB * K.DM_SENDER_FRAC), 'batas per pengirim ikut kuota');
  assert.deepStrictEqual(B.getSettings().items.cust, { value: 10 * MB, def: K.CUST_DM_QUOTA, min: 10 * MB, custom: true });
  const used = B.getSettings().usage;
  assert.deepStrictEqual([used.cust.dm.quota, used.files.pub.quota, used.files.seed.quota, used.pubMsgs.quota], [10 * MB, 100 * MB, 100 * MB, 5 * MB]);
  ok('cust -> DM+pesan grup, files -> kolam DM/publik/grup + seed, pubMsgs -> pesan publik; per pengirim mengikuti');

  // 4. unlimited
  r = B.setSettings({ cust: 'unlimited', files: 'unlimited', pubMsgs: 'unlimited' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(B._custLimits().dm.quota, Infinity); assert.strictEqual(B._escLimits().quota, Infinity); assert.strictEqual(B._custLimits().pub.quota, Infinity);
  assert.strictEqual(B._custLimits().dm.perSender, K.UNLIM_SENDER, 'tanpa batas tetap menahan satu pengirim');
  assert.strictEqual(r.items.files.value, 'unlimited');
  assert.strictEqual(r.usage.cust.dm.quota, 'unlimited'); assert.strictEqual(r.usage.files.seed.quota, 'unlimited');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), r, 'hasil unlimited lolos JSON tanpa berubah (bukan null)');
  assert.strictEqual(B._carry(fakeDm(sender(0), 'x'.repeat(20000))), 'carried');
  ok("'unlimited' = Infinity di batas Core, 'unlimited' di JSON, per pengirim tetap dibatasi");

  // 5. kembali ke bawaan; nilai asal opts dari konstruktor dipulihkan
  const C = mk('C', { custDmQuota: 777777, escQuota: 123 * MB });
  assert.strictEqual(C._custLimits().dm.quota, 777777);
  C.setSettings({ cust: 50 * MB, files: 200 * MB });
  assert.strictEqual(C._custLimits().dm.quota, 50 * MB); assert.strictEqual(C._escLimits().quota, 200 * MB);
  r = C.setSettings({ cust: null, files: 'default' });
  assert.strictEqual(r.items.cust.custom, false);
  assert.strictEqual(C._custLimits().dm.quota, 777777, 'opts konstruktor dipulihkan');
  assert.strictEqual(C._escLimits().quota, 123 * MB);
  assert.strictEqual(C._custLimits().gmsg.quota, K.CUST_GMSG_QUOTA, 'yang tidak pernah diatur kembali ke konstanta');
  assert(!('custGmsgQuota' in C.opts) && !('pubQuota' in C.opts), 'opts yang tidak ada di awal dihapus lagi');
  ok('null/default mengembalikan batas ke nilai asal (opts konstruktor atau konstanta)');

  // 6. persistensi: bertahan lewat restart, .bak, berkas rusak / diedit tangan
  const dirP = path.join(tmp, 'P'), fP = path.join(dirP, 'settings.json');
  const P = mk('P'); P.setSettings({ cust: 64 * MB });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(fP, 'utf8')), { v: 1, cust: 64 * MB });
  P.setSettings({ files: 'unlimited' });
  assert(fs.existsSync(fP + '.bak') && JSON.parse(fs.readFileSync(fP + '.bak', 'utf8')).files === undefined, '.bak = versi sebelumnya');
  assert(!fs.existsSync(fP + '.tmp'));
  const P2 = mk('P'); P2._loadSettings();
  assert.strictEqual(P2._custLimits().dm.quota, 64 * MB); assert.strictEqual(P2._escLimits().quota, Infinity);
  assert.deepStrictEqual(P2.getSettings().items.files, { value: 'unlimited', def: K.ESC_QUOTA, min: 100 * MB, custom: true });
  fs.writeFileSync(fP, '{rusak');
  const P3 = mk('P'); P3._loadSettings();
  assert.strictEqual(P3._custLimits().dm.quota, 64 * MB, 'berkas rusak -> baca .bak');
  fs.writeFileSync(fP, JSON.stringify({ v: 1, cust: 1 * MB, files: 'abc', pubMsgs: -5, extra: 9, __proto__: { cust: 1 } }));
  fs.unlinkSync(fP + '.bak');
  const P4 = mk('P'); P4._loadSettings();
  assert.strictEqual(P4._custLimits().dm.quota, 10 * MB, 'di bawah minimum dinaikkan ke minimum');
  assert.strictEqual(P4.getSettings().items.files.custom, false); assert.strictEqual(P4.getSettings().items.pubMsgs.custom, false);
  fs.unlinkSync(fP);
  const P5 = mk('P'); P5._loadSettings(); assert.strictEqual(P5._custLimits().dm.quota, K.CUST_DM_QUOTA, 'tanpa berkas = bawaan');
  ok('settings.json bertahan lewat restart; .bak; rusak -> .bak; nilai tidak sah dibuang, di bawah minimum dinaikkan; tanpa berkas = bawaan');

  // 7. penegakan: titipan DM dan pesan grup, yang terlama dulu
  const E = mk('E');
  const BIG = 'x'.repeat(40000), costBig = K.custCost({ text: BIG });
  const ids = [];
  for (let i = 0; i < 300; i++) { const m = fakeDm(sender(i % 10), BIG); assert.strictEqual(E._carry(m), 'carried'); E.store.custody[m.id].at = 1000 + i; ids.push(m.id); }
  for (let i = 0; i < 300; i++) { const m = Object.assign(fakeDm(sender(i % 25), BIG, 'g:' + hex(1 + (i % 5), 16)), { kind: 'g1' }); assert.strictEqual(E._carry(m), 'carried'); E.store.custody[m.id].at = 5000 + i; }
  assert(E.custUsage().dm.used > 10 * MB && E.custUsage().gmsg.used > 10 * MB);
  E.setSettings({ cust: 10 * MB });
  const cu = E.custUsage();
  assert(cu.dm.used <= 10 * MB && cu.gmsg.used <= 10 * MB, 'kedua kelas turun ke kuota baru');
  assert(cu.dm.used > 10 * MB - costBig && cu.gmsg.used > 10 * MB - costBig, 'tidak membuang berlebihan');
  const left = ids.filter((id) => E.store.custody[id]);
  assert.deepStrictEqual(left, ids.slice(ids.length - left.length), 'DM: yang terlama dibuang, yang terbaru tetap');
  assert.strictEqual(cu.dm.count, left.length);
  assert.strictEqual(E.custUsage().state.count, 0);
  ok('kuota titipan diturunkan: DM dan pesan grup langsung turun ke batas baru (DM terlama dulu), penghitung konsisten');

  // 8. penegakan: pesan publik orang lain (adil per pengirim, yang terbaru tetap)
  const F = mk('F');
  const pubm = (s, ts) => ({ id: hex(++seq, 32), from: sender(s), to: 'public', ts, text: 'y'.repeat(10000), pub: 'p', sig: 's' });
  const per = {};
  for (let i = 0; i < 1500; i++) { const s = i < 1000 ? 0 : 1 + (i % 10), m = pubm(s, 1e12 + i); F.store.msgs[m.id] = m; F._pqAdd(m); (per[s] = per[s] || []).push(m.id); }
  assert(F._pq.bytes > 15 * MB);
  F.setSettings({ pubMsgs: 5 * MB });
  const lim = F._custLimits().pub;
  assert(F._pq.bytes <= 5 * MB, 'total turun ke kuota baru');
  for (const v of F._pq.from.values()) assert(v <= lim.perSender, 'tiap pengirim di bawah bagiannya');
  const recount = new Map(); let rb = 0;
  for (const m of Object.values(F.store.msgs)) if (F._isPubOther(m)) { rb += K.custCost(m); recount.set(m.from, (recount.get(m.from) || 0) + K.custCost(m)); }
  assert.strictEqual(F._pq.bytes, rb); assert.deepStrictEqual([...F._pq.from.entries()].sort(), [...recount.entries()].sort());
  const keep0 = per[0].filter((id) => F.store.msgs[id]);
  assert(keep0.length > 0 && keep0.length < per[0].length, 'pengirim banjir kehilangan pesannya sendiri');
  assert.deepStrictEqual(keep0, per[0].slice(per[0].length - keep0.length), 'yang tersisa adalah yang terbaru');
  assert(per[1].some((id) => F.store.msgs[id]), 'pengirim kecil masih punya pesan');
  const keep = new Set(Object.keys(F.store.msgs));
  assert.strictEqual(F.setSettings({ pubMsgs: 5 * MB }).ok, true);
  assert.deepStrictEqual(new Set(Object.keys(F.store.msgs)), keep, 'menetapkan nilai yang sama tidak membuang apa pun');
  ok('kuota pesan publik diturunkan: total dan per pengirim turun, yang terbaru tetap, penghitung konsisten, idempoten');

  // 9. penegakan: kolam berkas publik/grup dan seed; kolam DM tidak digusur
  const G = mk('G');
  let t = 1000;
  const esc = (to, psize) => { const id = hex(++seq, 32); G.store.esc[id] = { psize, wl: psize, have: psize, done: true, at: ++t, from: sender(seq % 7), to }; return id; };
  const pubIds = [1, 2, 3, 4].map(() => esc('public', 50 * MB)), grpIds = [1, 2, 3, 4].map(() => esc('g:' + hex(1, 16), 50 * MB)), dmIds = [1, 2, 3].map(() => esc(hex(7, 16), 50 * MB));
  const seedIds = [1, 2, 3].map((i) => { const id = hex(++seq, 32); G.store.seeds[id] = { psize: 60 * MB, at: 1000 + i, used: 1000 + i }; return id; });
  G.setSettings({ files: 100 * MB });
  const alive = (a) => a.filter((id) => G.store.esc[id]);
  assert.deepStrictEqual(alive(pubIds), pubIds.slice(2), 'kolam publik: dua yang paling lama tidak dipakai dibuang');
  assert.deepStrictEqual(alive(grpIds), grpIds.slice(2), 'kolam grup: sama');
  assert.deepStrictEqual(alive(dmIds), dmIds, 'kolam DM tidak digusur (menolak yang baru, kelebihan hilang lewat tanda terima/TTL)');
  assert.deepStrictEqual(seedIds.filter((id) => G.store.seeds[id]), seedIds.slice(2), 'seed: yang terlama dipakai dibuang sampai muat');
  const gu = G.getSettings().usage.files;
  assert.deepStrictEqual([gu.pub.used, gu.grp.used, gu.seed.used], [100 * MB, 100 * MB, 60 * MB]);
  assert(gu.dm.used > gu.dm.quota, 'kolam DM memang melebihi kuota baru, dilaporkan apa adanya');
  ok('kuota berkas diturunkan: kolam publik/grup dan seed turun (LRU); kolam DM dibiarkan; usage jujur');

  // 10. start() sungguhan: settings.json yang lebih kecil dari isi simpanan (mis. diedit tangan) ditegakkan saat startup
  const dirH = path.join(tmp, 'H');
  const H = new Core({ dataDir: dirH, name: 'H', discovery: false, tickMs: 60000 });
  fs.mkdirSync(dirH, { recursive: true }); H._loadIdentity(); H._loadStore(); H._kick = () => {};
  for (let i = 0; i < 300; i++) { const m = fakeDm(sender(i % 10), BIG); assert.strictEqual(H._carry(m), 'carried'); }
  H._saveNow();
  assert(H.custUsage().dm.used > 10 * MB);
  fs.writeFileSync(path.join(dirH, 'settings.json'), JSON.stringify({ v: 1, cust: 10 * MB }));
  const H2 = new Core({ dataDir: dirH, name: 'H', discovery: false, tickMs: 60000 });
  await H2.start();
  try {
    assert(H2.custUsage().dm.used <= 10 * MB && H2.custUsage().dm.used > 10 * MB - costBig, 'startup menegakkan kuota dari settings.json');
    assert.strictEqual(H2._enforceQuotas(), 0, 'sudah muat: tidak membuang apa pun');
  } finally { await H2.stop(); }
  const H3 = new Core({ dataDir: dirH, name: 'H', discovery: false, tickMs: 60000 });
  await H3.start();
  try { assert(H3.custUsage().dm.used <= 10 * MB, 'hasil penegakan bertahan di disk'); assert.strictEqual(H3.custUsage().dm.quota, 10 * MB); } finally { await H3.stop(); }
  ok('start(): pengaturan dimuat sebelum simpanan, ditegakkan setelahnya, dan hasilnya bertahan di disk');

  // 11. IPC + preload + api-http
  const handlers = {}, ipcMain = { handle: (n, fn) => { handlers[n] = fn; } };
  const I = mk('I');
  const api = register({ ipcMain, core: I, shell: {}, send: () => {}, log: () => {}, pickFiles: async () => [] });
  const call = (n, ...a) => handlers[n]({}, ...a);
  const g1 = await call('getSettings');
  assert.strictEqual(g1.ok, true); assert.strictEqual(g1.items.cust.value, K.CUST_DM_QUOTA);
  const s1 = await call('setSettings', { cust: 20 * MB, pubMsgs: 'unlimited' });
  assert.strictEqual(s1.ok, true); assert.strictEqual(s1.items.cust.value, 20 * MB); assert.strictEqual(s1.items.pubMsgs.value, 'unlimited');
  assert.strictEqual(I._custLimits().dm.quota, 20 * MB);
  const s2 = await call('setSettings', { cust: 1 });
  assert.deepStrictEqual([s2.ok, s2.code, s2.key, s2.min], [false, 'min', 'cust', 10 * MB]);
  assert.deepStrictEqual((await call('setSettings', 'rusak')).code, 'bad');
  assert.strictEqual((await call('setSettings')).ok, false);
  assert.strictEqual(I._custLimits().dm.quota, 20 * MB, 'penolakan tidak mengubah apa pun');
  const emitted = []; I.on('update', () => emitted.push(1)); await call('setSettings', { cust: 30 * MB }); assert(emitted.length >= 1, "emit 'update'");
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), http = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archne-api-http.js'), 'utf8');
  for (const n of ['getSettings', 'setSettings']) { assert(new RegExp('^\\s{2}' + n + ':', 'm').test(preload), 'preload ' + n); assert(new RegExp("'" + n + "'").test(http), 'api-http ' + n); }
  api.dispose();
  ok('IPC getSettings/setSettings (nilai, penolakan bad/min, update), nama ada di preload.js dan archne-api-http.js');

  // 12. (2d) folder tujuan Kirim Langsung: bawaan, set/validasi, persistensi, reset, prioritas terhadap opts
  const D = mk('D'); D._loadSettings();
  const defDir = path.join(D._downloadDir(), 'file_transfer');
  assert.strictEqual(D._directDir(), defDir);
  assert.deepStrictEqual(D.getSettings().direct, { dir: defDir, def: defDir, custom: false });
  const want = path.join(tmp, 'terima', 'kirim-langsung');
  const d1 = D.setSettings({ directDir: want, theme: 'dark' });
  assert.strictEqual(d1.ok, true); assert.deepStrictEqual(d1.direct, { dir: want, def: defDir, custom: true });
  assert(fs.statSync(want).isDirectory(), 'folder dibuat saat disimpan');
  assert.strictEqual(D._directDir(), want); assert.strictEqual(d1.theme, 'dark', 'kunci lain ikut tersimpan');
  assert.strictEqual(D.setSettings({ cust: 30 * MB }).direct.dir, want, 'mengubah kuota tidak menyentuh folder');
  const D2 = mk('D'); D2._loadSettings();
  assert.strictEqual(D2._directDir(), want, 'bertahan lewat restart'); assert.strictEqual(D2.getSettings().direct.custom, true);
  const filePath = path.join(tmp, 'bukan-folder'); fs.writeFileSync(filePath, 'x');
  for (const [v, code] of [['relatif/x', 'bad'], ['', 'bad'], [123, 'bad'], [{}, 'bad'], ['/a\0b', 'bad'], ['/' + 'x'.repeat(1100), 'bad'], [path.join(filePath, 'sub'), 'dir']]) {
    const r = D.setSettings({ directDir: v });
    assert.deepStrictEqual([r.ok, r.code, r.key], [false, code, 'directDir'], String(v).slice(0, 20));
  }
  assert.strictEqual(D._directDir(), want, 'penolakan tidak mengubah apa pun');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'D', 'settings.json'), 'utf8')).directDir, want);
  assert.strictEqual(D.setSettings({ directDir: 'default' }).direct.custom, false); assert.strictEqual(D._directDir(), defDir);
  D.setSettings({ directDir: want }); assert.strictEqual(D.setSettings({ directDir: null }).direct.dir, defDir);
  assert(!('directDir' in JSON.parse(fs.readFileSync(path.join(tmp, 'D', 'settings.json'), 'utf8'))), 'kunci dibuang saat kembali ke bawaan');
  // berkas diedit tangan: path relatif dibuang; folder yang belum ada tetap dipakai (dibuat saat menerima)
  fs.writeFileSync(path.join(tmp, 'D', 'settings.json'), JSON.stringify({ v: 1, directDir: 'relatif' }));
  const D3 = mk('D'); D3._loadSettings(); assert.strictEqual(D3._directDir(), defDir);
  const later = path.join(tmp, 'belum', 'ada');
  fs.writeFileSync(path.join(tmp, 'D', 'settings.json'), JSON.stringify({ v: 1, directDir: later }));
  const D4 = mk('D'); D4._loadSettings(); assert.strictEqual(D4._directDir(), later); assert(!fs.existsSync(later), 'memuat tidak membuat folder');
  // prioritas: Pengaturan > opts.directDir (konstruktor) > bawaan
  const viaOpts = path.join(tmp, 'lewat-opts'), EO = mk('E', { directDir: viaOpts }); EO._loadSettings();
  assert.strictEqual(EO._directDir(), viaOpts); assert.strictEqual(EO.getSettings().direct.custom, false, 'opts bukan Pengaturan pengguna');
  EO.setSettings({ directDir: want }); assert.strictEqual(EO._directDir(), want);
  EO.setSettings({ directDir: null }); assert.strictEqual(EO._directDir(), viaOpts, 'reset kembali ke nilai opts, bukan dibuang');
  ok('directDir: bawaan, set (dibuat, tervalidasi: relatif/NUL/terlalu panjang/tak bisa ditulis), bertahan restart, reset, berkas diedit tangan, prioritas atas opts');

  // 13. (i18n A2) bahasa UI: bawaan en, set id, reset, penolakan, bertahan restart, berkas diedit tangan, kunci lain tak tersentuh
  const LG = mk('G'); LG._loadSettings();
  assert.strictEqual(LG.getSettings().lang, 'en', 'bawaan en');
  const lg1 = LG.setSettings({ lang: 'id', theme: 'dark' });
  assert.strictEqual(lg1.ok, true); assert.strictEqual(lg1.lang, 'id'); assert.strictEqual(lg1.theme, 'dark', 'kunci lain ikut tersimpan');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'G', 'settings.json'), 'utf8')).lang, 'id');
  const LG2 = mk('G'); LG2._loadSettings(); assert.strictEqual(LG2.getSettings().lang, 'id', 'bertahan lewat restart');
  for (const v of ['fr', '', 'ID', 1, true, {}, []]) { const r = LG2.setSettings({ lang: v }); assert.deepStrictEqual([r.ok, r.code, r.key], [false, 'bad', 'lang'], 'tolak ' + JSON.stringify(v)); }
  assert.strictEqual(LG2.getSettings().lang, 'id', 'penolakan tidak mengubah apa pun');
  assert.strictEqual(LG2.setSettings({ cust: 30 * MB }).lang, 'id', 'mengubah kuota tidak menyentuh bahasa');
  for (const v of [null, 'default', 'en']) {
    LG2.setSettings({ lang: 'id' });
    const r = LG2.setSettings({ lang: v }); assert.strictEqual(r.ok, true); assert.strictEqual(r.lang, 'en');
    assert(!('lang' in JSON.parse(fs.readFileSync(path.join(tmp, 'G', 'settings.json'), 'utf8'))), 'en = kunci dibuang (' + v + ')');
  }
  fs.writeFileSync(path.join(tmp, 'G', 'settings.json'), JSON.stringify({ v: 1, lang: 'xx' }));
  const LG3 = mk('G'); LG3._loadSettings(); assert.strictEqual(LG3.getSettings().lang, 'en', 'bahasa tak dikenal di berkas dibuang');
  fs.writeFileSync(path.join(tmp, 'G', 'settings.json'), JSON.stringify({ v: 1, lang: 'id' }));
  const LG4 = mk('G'); LG4._loadSettings(); assert.strictEqual(LG4.getSettings().lang, 'id', 'berkas diedit tangan dibaca');
  ok('lang: bawaan en, set id, reset (null/default/en membuang kunci), tolak nilai tak sah, bertahan restart, berkas diedit tangan');

  console.log('\n' + pass + ' kelompok lulus');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

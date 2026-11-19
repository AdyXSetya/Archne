'use strict';
// Tes hemat kuota relay (v0.23.1, batas antar jaringan v0.23.2): batas ukuran titipan berkas (Pengaturan, bawaan 10 MB, maks 100 MB, tanpa unlimited),
// berkas tidak dititipkan lewat jalur relay, salinan seed tidak dilayankan lewat relay, tema tersimpan di settings.json.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const K = require('../src/core/archne-constants');
const Pack = require('../src/archne-pack');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-relay-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const MB = 1048576;
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100 }, o));
const hex = (i) => String(i).padStart(16, '0').replace(/[^0-9]/g, '0').slice(-16);

(async () => {
  // ---- 1. pengaturan: escMax ----
  const S = mk('S'); S._kick = () => {};
  S._loadSettings();
  let g = S.getSettings();
  assert.deepStrictEqual(g.items.escMax, { value: 10 * MB, def: 10 * MB, min: 0, custom: false, max: 100 * MB });
  assert.strictEqual(g.theme, 'system');
  assert.strictEqual(S._escMaxBytes(), 10 * MB, 'bawaan 10 MB');
  assert.strictEqual(K.ESC_MAX_DEF, 10 * MB); assert.strictEqual(K.ESC_MAX_CEIL, 100 * MB);
  for (const v of [5 * MB, 1 * MB, 100 * MB, 0]) { const r = S.setSettings({ escMax: v }); assert.strictEqual(r.ok, true, 'escMax ' + v); assert.strictEqual(S._escMaxBytes(), v); assert.strictEqual(r.items.escMax.custom, true); }
  const bad = (p, code) => { const r = S.setSettings(p); assert.strictEqual(r.ok, false, JSON.stringify(p)); assert.strictEqual(r.code, code, JSON.stringify(p)); return r; };
  bad({ escMax: 'unlimited' }, 'bad'); // tidak ada opsi tanpa batas
  assert.strictEqual(bad({ escMax: 100 * MB + 1 }, 'max').max, 100 * MB);
  bad({ escMax: 2 ** 40 }, 'max'); bad({ escMax: -1 }, 'bad'); bad({ escMax: 1.5 }, 'bad'); bad({ escMax: NaN }, 'bad'); bad({ escMax: Infinity }, 'bad'); bad({ escMax: '10485760' }, 'bad');
  assert.strictEqual(S._escMaxBytes(), 0, 'penolakan tidak mengubah nilai terakhir');
  assert.strictEqual(S.setSettings({ escMax: null }).items.escMax.custom, false);
  assert.strictEqual(S._escMaxBytes(), 10 * MB, 'null = kembali ke bawaan');
  ok('escMax: bawaan 10 MB, 0..100 MB sah, "unlimited" dan > 100 MB ditolak, null = bawaan');

  // settings.json: nilai rusak/berlebih dijepit atau dibuang (berkas bisa diedit tangan)
  const dir = path.join(tmp, 'S2'); fs.mkdirSync(dir, { recursive: true });
  const load = (obj) => { fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(obj)); fs.rmSync(path.join(dir, 'settings.json.bak'), { force: true }); const c = mk('S2'); c._loadSettings(); return c; };
  assert.strictEqual(load({ v: 1, escMax: 500 * MB })._escMaxBytes(), 100 * MB, 'di atas batas atas dijepit ke 100 MB');
  assert.strictEqual(load({ v: 1, escMax: 'unlimited' })._escMaxBytes(), 10 * MB, 'unlimited di berkas dibuang -> bawaan');
  assert.strictEqual(load({ v: 1, escMax: 0 })._escMaxBytes(), 0);
  assert.strictEqual(load({ v: 1, escMax: -5 })._escMaxBytes(), 10 * MB);
  assert.strictEqual(load({ v: 1, escMax: 3 * MB })._escMaxBytes(), 3 * MB);
  ok('settings.json: nilai di atas 100 MB dijepit, unlimited/negatif dibuang, 0 dan nilai sah dipakai');

  // ---- 2. pengaturan: tema ----
  const T = mk('T'); T._kick = () => {}; T._loadSettings();
  for (const t of ['dark', 'light', 'system']) { const r = T.setSettings({ theme: t }); assert.strictEqual(r.ok, true); assert.strictEqual(r.theme, t); }
  T.setSettings({ theme: 'dark' });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'T', 'settings.json'), 'utf8')).theme, 'dark');
  const T2 = mk('T'); T2._loadSettings();
  assert.strictEqual(T2.getSettings().theme, 'dark', 'tema bertahan setelah dibuka ulang');
  assert.strictEqual(T2.setSettings({ theme: null }).theme, 'system');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'T', 'settings.json'), 'utf8')).theme, undefined, 'system = kunci dibuang');
  for (const v of ['blue', '', 5, {}, 'DARK']) assert.strictEqual(T2.setSettings({ theme: v }).code, 'bad', String(v));
  assert.strictEqual(T2.setSettings({ theme: 'light', escMax: 200 * MB }).ok, false);
  assert.strictEqual(T2.getSettings().theme, 'system', 'atomik: tema tidak berubah saat bagian lain ditolak');
  fs.writeFileSync(path.join(tmp, 'T', 'settings.json'), JSON.stringify({ v: 1, theme: 'neon' })); fs.rmSync(path.join(tmp, 'T', 'settings.json.bak'), { force: true });
  const T3 = mk('T'); T3._loadSettings(); assert.strictEqual(T3.getSettings().theme, 'system', 'tema tidak sah di berkas diabaikan');
  ok('tema: system/dark/light tersimpan di settings.json dan bertahan; system menghapus kunci; nilai lain ditolak; atomik');

  // ---- 3. jalur relay ----
  const R = mk('R'); R._kick = () => {};
  const X = 'a'.repeat(16), addr = 'rtc:' + X;
  assert.strictEqual(R._viaRelay('192.168.1.7'), false, 'LAN/TCP selalu langsung');
  assert.strictEqual(R._viaRelay({ ip: '10.0.0.2', port: 1 }), false);
  assert.strictEqual(R._viaRelay(addr), true, 'rtc tanpa catatan = belum pasti = relay');
  R.rtcLinkPath(X, 'unknown'); assert.strictEqual(R._viaRelay(addr), true, 'unknown dihitung relay');
  R.rtcLinkPath(X, 'relay'); assert.strictEqual(R._viaRelay({ ip: addr }), true);
  R.rtcLinkPath(X, 'direct'); assert.strictEqual(R._viaRelay(addr), false);
  R.rtcLinkPath(X, 'aneh'); assert.strictEqual(R._viaRelay(addr), true, 'nilai tak dikenal = unknown');
  R.rtcLinkPath(X, 'direct'); R.rtcLinkDown(X); assert.strictEqual(R._viaRelay(addr), true, 'link putus: catatan dibuang');
  assert.strictEqual(R._viaRelay(null), false); assert.strictEqual(R._viaRelay(undefined), false);
  ok('_viaRelay: LAN langsung; rtc langsung hanya bila tercatat direct; unknown/relay/putus dihitung relay');

  // _escSizeOk mengikuti pengaturan
  R._loadSettings();
  assert.strictEqual(R._escSizeOk(10 * MB), true); assert.strictEqual(R._escSizeOk(10 * MB + 1), false);
  R.setSettings({ escMax: 0 }); assert.strictEqual(R._escSizeOk(1), false, '0 = tanpa titipan berkas');
  R.setSettings({ escMax: 100 * MB }); assert.strictEqual(R._escSizeOk(100 * MB), true); assert.strictEqual(R._escSizeOk(100 * MB + 1), false);
  assert.strictEqual(R._escSizeOk(NaN), false);
  R.opts.escMaxBytes = 5 * 1e9; assert.strictEqual(R._escMaxBytes(), 100 * MB, 'opts di atas batas atas tetap dijepit');
  ok('_escSizeOk: <= batas boleh, di atasnya tidak; 0 mematikan; selalu dijepit 100 MB');

  // batas atas sisi kurir cukup untuk 100 MB
  assert.strictEqual(Pack.LIMITS.courier, 100 * MB);
  for (const L of [R._escLimits(), R._grpLimits()]) assert(L.maxFile >= 100 * MB);
  assert(R._grpLimits().perSender >= 100 * MB && R._escLimits().perSender >= 100 * MB);
  ok('sisi kurir menerima berkas selebar batas atas 100 MB (DM dan grup)');

  // ---- 4. _pushTick: relay dan ukuran ----
  fs.writeFileSync(path.join(tmp, 'rand.bin'), crypto.randomBytes(1500000));
  const A = mk('A'), C = mk('C');
  await A.start(); await C.start();
  await A.addPeer('127.0.0.1', C.port);
  await until(() => A.peers.get(C.id) && A.peers.get(C.id).xpub, 6000, 'A kenal C');
  await C.stop();
  const calls = []; A._autoPush = (id, p) => { calls.push(p.id); };
  const fake = (id, ip) => ({ id, ip, port: 1, name: 'K' });
  const m = await A.sendFile(path.join(tmp, 'rand.bin'), C.id);
  const psize = A.store.files[m.id].meta.psize;
  assert(psize > 1.4 * MB && psize < 2 * MB, 'tak terkompres: ' + psize);
  const tick = (p) => { calls.length = 0; A._pushBack.clear(); A._pushTick(p); return calls.slice(); };
  const KID = 'b'.repeat(16);
  assert.deepStrictEqual(tick(fake(KID, '10.0.0.5')), [KID], 'kurir LAN: didorong');
  assert.deepStrictEqual(tick(fake(KID, 'rtc:' + KID)), [], 'rtc tanpa catatan jalur: dilewati');
  A.rtcLinkPath(KID, 'unknown'); assert.deepStrictEqual(tick(fake(KID, 'rtc:' + KID)), [], 'unknown: dilewati');
  A.rtcLinkPath(KID, 'relay'); assert.deepStrictEqual(tick(fake(KID, 'rtc:' + KID)), [], 'relay: dilewati');
  A.rtcLinkPath(KID, 'direct'); assert.deepStrictEqual(tick(fake(KID, 'rtc:' + KID)), [KID], 'rtc langsung: didorong');
  A.rtcLinkPath(KID, 'relay'); assert.deepStrictEqual(tick(fake(KID, 'rtc:' + KID)), [], 'jalur berubah ke relay: berhenti');
  ok('_pushTick: kurir LAN/direct didorong; relay, unknown, atau tanpa catatan dilewati; mengikuti perubahan jalur');
  const wan = fake(KID, 'rtc:' + KID); A.rtcLinkPath(KID, 'direct');
  A.setSettings({ escMax: 1 * MB });
  assert.deepStrictEqual(tick(wan), [], 'antar jaringan: berkas 1,5 MB > batas 1 MB tidak dititipkan');
  assert.deepStrictEqual(tick(fake(KID, '10.0.0.5')), [KID], 'LAN: tanpa batas ukuran, tetap dititipkan');
  A.setSettings({ escMax: 0 });
  assert.deepStrictEqual(tick(wan), [], '0: titipan antar jaringan mati');
  assert.deepStrictEqual(tick(fake(KID, '10.0.0.5')), [KID], '0: LAN tetap dititipkan');
  A.setSettings({ escMax: 2 * MB }); assert.deepStrictEqual(tick(wan), [KID], 'batas 2 MB >= berkas: didorong');
  A.setSettings({ escMax: null }); assert.deepStrictEqual(tick(wan), [KID], 'bawaan 10 MB: didorong');
  ok('_pushTick: antar jaringan ikut batas Pengaturan (0 = mati); LAN tanpa batas ukuran');
  // _escSizeOk / _relayServeOk per jenis alamat
  A.setSettings({ escMax: 1 * MB });
  assert.strictEqual(A._escSizeOk(50 * MB, '10.0.0.5'), true, 'LAN 50 MB ok'); assert.strictEqual(A._escSizeOk(50 * MB, { ip: '10.0.0.5' }), true);
  assert.strictEqual(A._escSizeOk(50 * MB, 'rtc:' + KID), false, 'rtc 50 MB > 1 MB'); assert.strictEqual(A._escSizeOk(50 * MB), false, 'tanpa alamat = konservatif (batas)');
  A.rtcLinkPath(KID, 'relay');
  assert.strictEqual(A._relayServeOk('rtc:' + KID, 5 * MB), false, 'relay: 5 MB > 1 MB ditolak'); assert.strictEqual(A._relayServeOk('rtc:' + KID, MB), true);
  A.rtcLinkPath(KID, 'direct'); assert.strictEqual(A._relayServeOk('rtc:' + KID, 90 * MB), true, 'rtc langsung: tanpa batas pengambilan');
  A.rtcLinkPath(KID, 'unknown'); assert.strictEqual(A._relayServeOk('rtc:' + KID, 90 * MB), true, 'unknown: tidak memblokir pengambilan');
  assert.strictEqual(A._relayServeOk('10.0.0.5', 90 * MB), true, 'LAN: tanpa batas');
  A.rtcLinkPath(KID, 'relay'); A.setSettings({ escMax: 0 }); assert.strictEqual(A._relayServeOk('rtc:' + KID, 1), false, '0 + relay: tidak ada berkas lewat relay');
  A.setSettings({ escMax: null });
  ok('_escSizeOk/_relayServeOk: LAN tanpa batas; antar jaringan dan jalur relay ikut batas; direct/unknown tidak memblokir pengambilan');
  // pushToCourier manual menolak berkas besar sebelum menyentuh jaringan
  A.setSettings({ escMax: 1 * MB });
  await assert.rejects(() => A.pushToCourier(m.id, KID), (e) => e && e.code === 'big');
  // state: kartu pengirim diberi tahu bahwa berkas tidak dititipkan
  const st = A.getState().messages.find((x) => x.id === m.id);
  assert.strictEqual(st.file.cap, 1 * MB, 'state memberi batas titipan saat berkas di atasnya');
  A.setSettings({ escMax: null });
  assert.strictEqual(A.getState().messages.find((x) => x.id === m.id).file.cap, undefined, 'dalam batas: tanpa tanda');
  A.setSettings({ escMax: 0 }); assert.strictEqual(A.getState().messages.find((x) => x.id === m.id).file.cap, 0);
  ok('pushToCourier menolak (big) di atas batas; state.file.cap menandai berkas yang tidak dititipkan');

  // _serveFile: pengambilan langsung lewat jalur relay ditolak bila di atas batas; LAN tidak
  {
    const ends = []; const sk = () => ({ once() {}, resume() {}, destroy() {}, end(x) { ends.push(String(x)); } });
    const get = (ip) => { ends.length = 0; A._serveFile(sk(), { id: m.id, off: 0, hi: { id: C.id } }, ip); return ends.slice(); };
    A.setSettings({ escMax: 1 * MB }); A.rtcLinkPath(KID, 'relay');
    const r1 = get('rtc:' + KID); assert(r1.length === 1 && JSON.parse(r1[0]).err === 'relaycap', 'relay + berkas > batas: relaycap ' + r1);
    const r2 = get('10.0.0.5'); assert(!r2.some((x) => x.includes('relaycap')), 'LAN tidak kena relaycap');
    A.rtcLinkPath(KID, 'direct'); const r3 = get('rtc:' + KID); assert(!r3.some((x) => x.includes('relaycap')), 'jalur langsung tidak kena relaycap');
    A.setSettings({ escMax: null });
    ok('_serveFile: relay + di atas batas = relaycap; LAN dan jalur langsung lolos');
  }

  // ---- 5. seed tidak dilayankan lewat relay ----
  const pubId = crypto.randomBytes(16).toString('hex');
  const pm = { id: pubId, from: 'c'.repeat(16), to: 'public', ts: Date.now(), text: 'x' };
  A.store.seeds[pubId] = { psize: 1000, at: Date.now(), used: Date.now() };
  const mkSock = () => ({ once() {}, resume() {}, end() {}, destroy() {} });
  const nos = [];
  const serve = (ip) => { nos.length = 0; return [A._serveSeed(mkSock(), { id: pubId, off: 0 }, ip, 'd'.repeat(16), (e) => nos.push(e), pm), nos.slice()]; };
  A.rtcLinkPath(KID, 'relay');
  assert.deepStrictEqual(serve('rtc:' + KID), [true, ['denied']], 'seed ke peer relay ditolak');
  A.rtcLinkPath(KID, null);
  assert.deepStrictEqual(serve('rtc:' + KID), [true, ['denied']], 'tanpa catatan jalur: ditolak');
  A.rtcLinkPath(KID, 'direct');
  const d = serve('rtc:' + KID); assert.strictEqual(d[0], true); assert.deepStrictEqual(d[1], [], 'jalur langsung: dilayani (tidak ditolak serentak)');
  const l = serve('10.0.0.9'); assert.strictEqual(l[0], true); assert.deepStrictEqual(l[1], [], 'LAN: dilayani');
  await sleep(100); // stat berkas seed yang tidak ada -> gone (diharapkan, bukan relay)
  ok('seed: ditolak (denied) untuk peer lewat relay/unknown; dilayani untuk LAN dan DataChannel langsung');

  await A.stop();
  console.log('\n' + pass + ' kelompok lulus');
})().catch((e) => { console.error(e); process.exit(1); });

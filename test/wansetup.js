'use strict';
// Tes langkah 6: undangan (src/archne-invite.js), pengaturan lintas jaringan di Core, penyatu tumpukan UI (renderer/archne-wansetup.js), kontrak archne-index.html (CSP, skrip, id).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const Invite = require('../src/archne-invite');
const WanCrypto = require('../src/archne-wancrypto');
const { Core } = require('../src/archne-core');
const { createWanApp } = require('../renderer/archne-wansetup');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-wset-'));
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const flush = () => new Promise((r) => setImmediate(r));
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const link = (o, v = '1') => 'archne://join?v=' + v + '&d=' + b64u(o);

(async () => {
  // ---------- 1. undangan ----------
  const code = WanCrypto.newCode(), netId = WanCrypto.derive(code).netId;
  const cf = { provider: 'cloudflare', keyId: 'k1', token: 'T1' };
  let p = Invite.parse(Invite.make({ code, broker: 'wss://b.example/mqtt', turn: cf }));
  assert.deepStrictEqual([p.code, p.netId, p.broker, p.turn], [WanCrypto.derive(code).code, netId, 'wss://b.example/mqtt', cf]);
  p = Invite.parse('Halo, gabung ya:\n' + Invite.make({ code, broker: Invite.DEFAULT_BROKER }) + '\nterima kasih');
  assert.strictEqual(p.turn, undefined); assert.strictEqual(p.broker, Invite.DEFAULT_BROKER);
  assert.strictEqual(Invite.parse(link({ code })).broker, Invite.DEFAULT_BROKER, 'tanpa broker: bawaan');
  assert.strictEqual(Invite.parse(link({ code, turn: { provider: 'none' } })).turn, undefined);
  const badCases = [[link({ code }, '2'), /Versi undangan tidak dikenal/], ['archne://join?d=' + b64u({ code }), /Versi undangan tidak dikenal/], ['archne://join?v=1', /rusak/], ['archne://join?v=1&d=%%%', /rusak/], ['archne://join?v=1&d=' + b64u('bukan json'), /rusak/], ['archne://join?v=1&d=' + b64u('[1]'), /rusak/],
    [link({ code: 'abc' }), /Kode jaringan/], [link({}), /Kode jaringan/], [link({ code, broker: 'http://x' }), /broker/], [link({ code, broker: 'ws://evil.example/mqtt' }), /broker/], [link({ code, turn: { provider: 'zzz' } }), /Penyedia/],
    [link({ code, turn: { provider: 'metered', app: '', apiKey: 'k' } }), /Metered/], ['archne://join?v=1&d=' + 'A'.repeat(5000), /terlalu besar/], ['halo tanpa tautan', /Tidak ada tautan/], [42, /tidak valid/], ['x'.repeat(9000), /tidak valid/]];
  for (const [t, re] of badCases) assert.throws(() => Invite.parse(t), re, String(t).slice(0, 60));
  assert(Invite.validBroker('ws://localhost:9001/mqtt') && Invite.validBroker('wss://a.b:8084/mqtt') && !Invite.validBroker('ws://a.b/') && !Invite.validBroker('wss://') && !Invite.validBroker('wss://a b'));
  ok('undangan: bolak-balik (dengan/tanpa TURN, di tengah teks); 16 undangan rusak/versi asing/kode-broker-TURN tak sah ditolak dengan pesan jelas');

  // ---------- 2. Core ----------
  const mk = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 });
  const A = mk('A'); await A.start(); const B = mk('B'); await B.start();
  let s = A.wanSettings();
  assert.deepStrictEqual([s.enabled, s.hasCode, s.netId, s.broker], [false, false, null, Invite.DEFAULT_BROKER]);
  assert.throws(() => A.inviteMake(false), /belum diatur/);
  s = A.wanEnable(true); assert(s.enabled && s.hasCode && /^[0-9a-f]{16}$/.test(s.netId), 'menyalakan tanpa kode membuat kode baru');
  const id1 = s.netId; s = A.wanEnable(false); assert(!s.enabled && s.hasCode && s.netId === id1, 'mematikan tidak membuang kode'); A.wanEnable(true);
  assert.throws(() => A.wanSetBroker('http://x'), /wss:\/\//); assert.strictEqual(A.wanSettings().broker, Invite.DEFAULT_BROKER);
  assert.strictEqual(A.wanSetBroker('wss://b.example/mqtt').broker, 'wss://b.example/mqtt'); assert.strictEqual(A.wanSetBroker('').broker, Invite.DEFAULT_BROKER, 'kosong = kembali ke bawaan');
  A.wanSetBroker('wss://b.example/mqtt'); A.turnSet(cf);
  const noT = A.inviteMake(false), withT = A.inviteMake(true);
  assert(!noT.withTurn && !/T1/.test(JSON.stringify(Invite.parse(noT.text))) && Invite.parse(noT.text).turn === undefined, 'tanpa kotak centang: TURN tidak ikut');
  assert(withT.withTurn && Invite.parse(withT.text).turn.token === 'T1' && Invite.parse(withT.text).broker === 'wss://b.example/mqtt');
  assert(!JSON.stringify(A.wanSettings()).includes(A.store.wan.code), 'wanSettings tidak membocorkan kode'); assert(!JSON.stringify(A.wanSettings()).includes('T1'));
  A.turnClear(); assert.strictEqual(A.inviteMake(true).withTurn, false, 'minta TURN tapi belum diisi: tidak ikut');
  // B menerima undangan A
  B.wanSetBroker(''); const before = JSON.stringify(B.wanSettings());
  for (const bad of ['sampah', link({ code, broker: 'http://x' }), link({ code }, '9')]) { assert.throws(() => B.inviteApply(bad)); assert.strictEqual(JSON.stringify(B.wanSettings()), before, 'undangan rusak tidak mengubah apa pun'); }
  const sb = B.inviteApply(withT.text);
  assert(sb.enabled && sb.netId === A.wanSettings().netId && sb.broker === 'wss://b.example/mqtt' && sb.turn.provider === 'cloudflare');
  assert.deepStrictEqual(B.turnInfo(), { provider: 'cloudflare', keyId: 'k1', hasSecret: true });
  const sealed = A.wanSeal('presence', null, { state: 'online', sid: 'ab'.repeat(8), name: 'A' }); const opened = B.wanOpen(sealed.topic, sealed.payload);
  assert(opened && opened.from === A.id, 'B sekarang bisa membuka presence A');
  const sb2 = B.inviteApply(noT.text); assert.strictEqual(sb2.turn.provider, 'cloudflare', 'undangan tanpa TURN tidak menghapus TURN milik penerima');
  // ganti kode: pintu lama tertutup
  const sr = A.wanRotate(); assert(sr.netId !== id1 && sr.enabled && sr.broker === 'wss://b.example/mqtt');
  const sealed2 = A.wanSeal('presence', null, { state: 'online', sid: 'cd'.repeat(8), name: 'A' });
  assert.strictEqual(B.wanOpen(sealed2.topic, sealed2.payload), null, 'peserta lama tidak bisa membaca presence setelah kode diganti');
  // simpan
  await A.stop(); const A2 = mk('A'); await A2.start(); const s2 = A2.wanSettings();
  assert(s2.enabled && s2.netId === sr.netId && s2.broker === 'wss://b.example/mqtt', 'pengaturan bertahan setelah restart');
  A2.wanClear(); assert.strictEqual(A2.wanSettings().enabled, false); assert.strictEqual(A2.wanSettings().hasCode, false, 'wanClear mematikan mode');
  await A2.stop(); await B.stop();
  ok('Core: saklar (buat kode otomatis), broker (validasi, bawaan), undangan dengan/tanpa TURN, terima undangan (atomik, TURN lama dipertahankan), ganti kode menutup pintu lama, bertahan setelah restart, kode tidak bocor');

  // ---------- 3. penyatu UI ----------
  const mkApp = (opts) => {
    opts = opts || {};
    const log = []; let settings = Object.assign({ enabled: true, hasCode: true, netId: 'n1', broker: 'wss://b/x' }, opts.settings); let rtcbCb = null; let nth = 0;
    const api = { wanSettings: async () => ({ ok: true, settings }), onRtcb: (cb) => { rtcbCb = cb; }, rtcIn: async () => ({ ok: true }), turnIce: opts.turnIce || (async () => ({ ok: true, iceServers: [{ urls: 'stun:x' }], wan: true })) };
    const stacks = [];
    const createWan = () => { const h = { status: [], peers: [] }, id = ++nth; const w = { id, peersNow: [], on: (k, cb) => h[k].push(cb), peers: () => w.peersNow, h, async start(o) { log.push(['wan.start', id, o.broker, o.name]); if (opts.startFails) throw new Error('broker mati'); if (opts.startDelay) await opts.startDelay; }, async stop() { log.push(['wan.stop', id]); } }; stacks.push(w); return w; };
    const createRtcMux = (o) => { const h = { link: [] }; const w = stacks[stacks.length - 1]; const rm = { linksNow: [], on: (k, cb) => h[k].push(cb), links: () => rm.linksNow, h, opts: o, async stop() { log.push(['rm.stop', w.id]); } }; w.rm = rm; return rm; };
    const createRtcGlue = (o) => { const w = stacks[stacks.length - 1]; const g = { fed: [], base64: o.base64, async start() { log.push(['glue.start', w.id]); }, stop() { log.push(['glue.stop', w.id]); }, feed(m) { g.fed.push(m); }, call: o.call }; w.glue = g; return g; };
    const app = createWanApp({ api, mqtt: opts.noMqtt ? null : {}, createWan, createRtcMux, createRtcGlue, MUX_WINDOW: 1, base64: !!opts.base64, getName: () => 'Aku' });
    return { app, log, stacks, api, set: (p) => { settings = Object.assign({}, settings, p); }, rtcb: (m) => rtcbCb(m) };
  };
  {
    const m = mkApp({ settings: { enabled: false } }); await m.app.sync(); assert.deepStrictEqual(m.log, []); assert.strictEqual(m.app.view().state, 'off');
    m.set({ enabled: true }); await m.app.sync(); assert.deepStrictEqual(m.log.map((x) => x.join(':')), ['glue.start:1', 'wan.start:1:wss://b/x:Aku'], 'glue dulu (siap menerima), baru sambung broker');
    await m.app.sync(); await m.app.sync(); assert.strictEqual(m.log.length, 2, 'sync berulang tanpa perubahan: tidak memulai ulang');
    m.set({ netId: 'n2' }); await m.app.sync(); assert.deepStrictEqual(m.log.slice(2).map((x) => x.join(':')), ['rm.stop:1', 'wan.stop:1', 'glue.stop:1', 'glue.start:2', 'wan.start:2:wss://b/x:Aku'], 'kode diganti: tumpukan lama berhenti dulu, baru yang baru');
    m.set({ broker: 'wss://c/y' }); await m.app.sync(); assert.strictEqual(m.log[m.log.length - 1].join(':'), 'wan.start:3:wss://c/y:Aku');
    m.rtcb({ op: 'x' }); assert.deepStrictEqual(m.stacks[2].glue.fed, [{ op: 'x' }]); assert.deepStrictEqual(m.stacks[0].glue.fed, [], 'pesan jembatan hanya ke tumpukan yang sedang aktif');
    m.set({ enabled: false }); await m.app.sync(); assert.strictEqual(m.app.view().state, 'off'); assert.deepStrictEqual(m.log.slice(-3).map((x) => x.join(':')), ['rm.stop:3', 'wan.stop:3', 'glue.stop:3']);
    m.rtcb({ op: 'y' }); assert.strictEqual(m.stacks[2].glue.fed.length, 1, 'mati: pesan jembatan dibuang');
    ok('penyatu: nyala/mati/ganti kode/ganti broker memulai-ulang tumpukan dengan urutan benar; tanpa perubahan tidak mengusik; pesan jembatan hanya ke yang aktif');
  }
  {
    const m = mkApp({ startFails: true }); await m.app.sync(); const v = m.app.view();
    assert(v.state === 'error' && /broker mati/.test(v.err) && v.peers.length === 0); assert(m.log.some((x) => x[0] === 'glue.stop'), 'gagal sambung: tumpukan dibersihkan');
    await m.app.sync(); assert.strictEqual(m.stacks.length, 2, 'sync berikutnya mencoba lagi (pengguna menekan ulang)');
    const n = mkApp({ noMqtt: true }); await n.app.sync(); assert(/MQTT/.test(n.app.view().err)); assert.strictEqual(n.stacks.length, 0);
    let rel; const gate = new Promise((r) => { rel = r; }); const c = mkApp({ startDelay: gate }); const a = c.app.sync(), b = c.app.sync(), d = c.app.sync(); await flush(); rel(); await Promise.all([a, b, d]); assert.strictEqual(c.stacks.length, 1, 'sync serentak diserialkan: satu tumpukan');
    ok('penyatu: broker gagal -> status galat + pembersihan + bisa dicoba lagi; pustaka MQTT hilang -> galat jelas; sync serentak -> satu tumpukan');
  }
  {
    const m = mkApp({ base64: true }); await m.app.sync(); const w = m.stacks[0];
    assert.strictEqual(w.glue.base64, true); assert.deepStrictEqual(await w.rm.opts.iceServers(), [{ urls: 'stun:x' }]);
    const bad = mkApp({ turnIce: async () => { throw new Error('x'); } }); await bad.app.sync(); assert.strictEqual(await bad.stacks[0].rm.opts.iceServers(), undefined, 'Core gagal menjawab: rtcmux memakai STUN bawaan');
    w.wanSettled = 1; w.peersNow = [];
    w.peersNow.push({ id: 'a'.repeat(16), name: 'Ani' }, { id: 'b'.repeat(16), name: 'Budi' }, { id: 'c'.repeat(16), name: 'Cici' }, { id: 'd'.repeat(16), name: 'Dedi' });
    w.rm.linksNow.push({ peerId: 'a'.repeat(16), state: 'open', path: 'direct' }, { peerId: 'b'.repeat(16), state: 'open', path: 'relay' }, { peerId: 'c'.repeat(16), state: 'connecting' }, { peerId: 'e'.repeat(16), state: 'open', path: 'direct' });
    w.rm.h.link.forEach((cb) => cb({ peerId: 'd'.repeat(16), state: 'failed', explain: 'butuh TURN' }));
    const st = Object.fromEntries(m.app.view().peers.map((p) => [p.name, p.state + (p.note ? ':' + p.note : '')]));
    assert.deepStrictEqual(st, { Ani: 'direct', Budi: 'relay', Cici: 'connecting', Dedi: 'failed:butuh TURN', '?': 'direct' }, 'langsung / relay / menyambung / gagal + alasan; link terbuka tetap tampil walau presence broker hilang');
    w.rm.h.link.forEach((cb) => cb({ peerId: 'd'.repeat(16), state: 'connecting' })); assert.strictEqual(m.app.view().peers.find((p) => p.name === 'Dedi').state, 'waiting', 'percobaan ulang menghapus status gagal');
    let n = 0; m.app.on('change', () => n++); w.h.peers.forEach((cb) => cb([])); w.h.status.forEach((cb) => cb({ state: 'online' })); assert(n >= 2 && m.app.view().state === 'online');
    ok('penyatu: byte jembatan base64 sesuai adaptor; ICE dari Core (gagal -> bawaan rtcmux); status peer langsung/relay/menyambung/gagal+alasan; pendengar perubahan dipanggil');
  }

  {
    const m = mkApp(); await m.app.sync(); const w = m.stacks[0];
    w.h.status.forEach((cb) => cb({ state: 'error', err: 'WebSocket tidak bisa dibuka' })); w.h.status.forEach((cb) => cb({ state: 'connecting' }));
    const v = m.app.view(); assert(v.state === 'connecting' && v.err === '' && /WebSocket/.test(v.lastErr), 'alasan gagal bertahan selama menyambung ulang');
    w.h.status.forEach((cb) => cb({ state: 'online' })); assert.strictEqual(m.app.view().lastErr, '', 'tersambung: alasan lama dibersihkan');
    ok('penyambung ulang tidak menimpa alasan gagal terakhir (terlihat di Pengaturan)');
  }

  {
    let rel; const hang = new Promise((r) => { rel = r; }); const m = mkApp({ startDelay: hang }); // wan.start menggantung
    const app2 = createWanApp({ api: m.api, mqtt: {}, createWan: () => ({ on() {}, peers: () => [], start: () => hang, stop: async () => {} }), createRtcMux: () => ({ on() {}, links: () => [], stop: async () => {} }), createRtcGlue: () => ({ start: async () => {}, stop() {}, feed() {} }), MUX_WINDOW: 1, stageMs: 30 });
    await app2.sync(); const v = app2.view(); rel();
    assert.strictEqual(v.state, 'error'); assert(/Macet di tahap: wan\.start/.test(v.err), v.err); assert(v.log.some((x) => /GAGAL/.test(x[1])) && v.log.some((x) => /jembatan siap/.test(x[1])), 'jejak tahap tersedia');
    ok('tahap yang menggantung dilaporkan bernama (batas waktu) dengan jejak tahap, tidak diam-diam "menyambung"');
  }

  // ---------- 4. kontrak archne-index.html ----------
  const root = path.join(__dirname, '..'), html = fs.readFileSync(path.join(root, 'renderer', 'archne-index.html'), 'utf8');
  const csp = html.match(/Content-Security-Policy" content="([^"]*)"/)[1];
  assert(/default-src 'self'(;|$)/.test(csp) && /connect-src 'self' wss:/.test(csp), 'CSP: connect-src memuat self dan wss:'); assert(!/connect-src[^;]*\*(;|\s|$)/.test(csp.replace(/ws:\/\/[^\s;]+/g, '')), 'tanpa wildcard terbuka');
  const order = ['archne-api-http.js', 'archne-call.js', 'vendor/mqtt.min.js', 'archne-wan.js', 'archne-rtcmux.js', 'archne-rtcglue.js', 'archne-wansetup.js'].map((f) => html.indexOf('<script src="' + f + '"></script>'));
  assert(order.every((i) => i > 0) && order.every((v, i) => !i || v > order[i - 1]), 'urutan skrip: mqtt sebelum wan, rtcmux/rtcglue sebelum wansetup');
  for (const f of ['vendor/mqtt.min.js', 'archne-wan.js', 'archne-rtcmux.js', 'archne-rtcglue.js', 'archne-wansetup.js']) assert(fs.existsSync(path.join(root, 'renderer', f)), f);
  const wanJs = fs.readFileSync(path.join(root, 'renderer', 'js', 'archne-wan.js'), 'utf8'); // v0.23.0: blok UI dipindah dari skrip inline ke js/archne-wan.js
  const blk = wanJs.slice(wanJs.indexOf('// ---- lintas jaringan (langkah 6)'));
  assert(html.indexOf('<script src="archne-wansetup.js"></script>') < html.indexOf('<script src="js/archne-wan.js"></script>') && html.indexOf('<script src="js/archne-settings.js"></script>') < html.indexOf('<script src="js/archne-wan.js"></script>'), 'js/archne-wan.js dimuat sesudah pustaka WAN dan js/10..80');
  assert(/href="css\/archne-wan\.css"/.test(html) && fs.existsSync(path.join(root, 'renderer', 'css', 'archne-wan.css')), 'css/archne-wan.css dimuat');
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])); const used = [...new Set([...blk.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.deepStrictEqual(used.filter((i) => !ids.has(i)), [], 'id yang dipakai skrip tetapi tidak ada di HTML');
  const andr = fs.readFileSync(path.join(root, 'android', 'www', 'index.html'), 'utf8'); assert(!/connect-src/.test(andr), 'CSP cangkang Android tidak disentuh');
  const pre = fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), ah = fs.readFileSync(path.join(root, 'renderer', 'archne-api-http.js'), 'utf8');
  for (const n of ['wanSettings', 'wanEnable', 'wanBroker', 'wanRotate', 'inviteMake', 'inviteApply']) { assert(new RegExp('^\\s{2}' + n + ':', 'm').test(pre), n); assert(ah.includes("'" + n + "'"), n); }
  assert(wanJs.includes("base64: location.protocol !== 'file:'"), 'Electron (file:) biner, adaptor HTTP base64');
  ok('index.html: CSP connect-src, urutan skrip, berkas ada, semua id terpakai ada, CSP Android utuh; preload dan api-http memuat kontrak baru');

  console.log(`\n${pass} lulus`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

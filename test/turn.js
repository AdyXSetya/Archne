'use strict';
// Tes ICE/TURN lintas jaringan (langkah 5): modul src/archne-turn.js (penyedia, cache, pembaruan, gagal), Core (per peer, rahasia, simpan), kontrak IPC,
// dan UI panggilan (LAN tetap iceServers: []). Pengambilan kredensial sungguhan ke penyedia tidak bisa dites di sini: uji manual (bagian 10 rencana).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const T = require('../src/archne-turn');
const { Core } = require('../src/archne-core');
const LC = require('../renderer/archne-call');
const { createIpc } = (() => { try { return require('../src/archne-ipc'); } catch { return {}; } })();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-turn-'));
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const flush = () => new Promise((r) => setImmediate(r));
const CF = { provider: 'cloudflare', keyId: 'key123', token: 'SECRET-TOKEN' };
const CFRES = (n) => JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u' + n, credential: 'c' + n }] });
const turnUrls = (r) => r.iceServers.filter((s) => s.username).map((s) => s.urls);

function fakeHttp(handler) { const reqs = []; const fn = async (opts, body) => { reqs.push({ opts, body }); return handler(opts, body, reqs.length); }; fn.reqs = reqs; return fn; }
const clock = () => { let t = 1e6; return { now: () => t, adv: (ms) => { t += ms; } }; };

(async () => {
  // ---------- 1. validasi ----------
  assert.deepStrictEqual(T.normalize({ provider: 'none' }), { provider: 'none' });
  assert.deepStrictEqual(T.normalize({}), { provider: 'none' });
  assert.deepStrictEqual(T.normalize({ provider: 'metered', app: 'MyApp.metered.live', apiKey: 'k1' }), { provider: 'metered', app: 'myapp', apiKey: 'k1' });
  assert.deepStrictEqual(T.normalize({ provider: 'manual', urls: 'turn:a.example:3478, turns:a.example:5349', username: 'u', credential: 'p' }), { provider: 'manual', urls: ['turn:a.example:3478', 'turns:a.example:5349'], username: 'u', credential: 'p' });
  assert.strictEqual(T.normalize({ provider: 'manual', urls: ['stun:s.example:3478'] }).username, undefined, 'STUN murni tanpa kredensial boleh');
  const bad = [null, 5, 'x', { provider: 'zzz' }, { provider: 'metered', app: '', apiKey: 'k' }, { provider: 'metered', app: 'a/b', apiKey: 'k' }, { provider: 'metered', app: 'a', apiKey: 'k&x=1' }, { provider: 'metered', app: 'a', apiKey: '' },
    { provider: 'cloudflare', keyId: '../x', token: 't' }, { provider: 'cloudflare', keyId: 'k', token: '' }, { provider: 'cloudflare', keyId: 'k', token: 'a b' },
    { provider: 'manual', urls: '' }, { provider: 'manual', urls: 'http://x' }, { provider: 'manual', urls: 'turn:a:1' }, { provider: 'manual', urls: 'turn:a:1', username: 'u' }, { provider: 'manual', urls: Array(9).fill('stun:a:1') }];
  for (const b of bad) assert.throws(() => T.normalize(b), /./, JSON.stringify(b));
  ok('normalize: bentuk baku per penyedia; 16 masukan rusak ditolak (nama app, API key, key ID, URL, TURN tanpa kredensial)');

  // ---------- 2. ringkasan tanpa rahasia ----------
  for (const c of [CF, { provider: 'metered', app: 'a', apiKey: 'KEY-X' }, { provider: 'manual', urls: 'turn:a:1', username: 'u', credential: 'CRED-Y' }]) {
    const j = JSON.stringify(T.publicInfo(T.normalize(c)));
    assert(!/SECRET-TOKEN|KEY-X|CRED-Y/.test(j), j); assert(/"hasSecret":true/.test(j));
  }
  assert.deepStrictEqual(T.publicInfo({ provider: 'none' }), { provider: 'none' });
  ok('publicInfo tidak memuat token, API key, atau credential');

  // ---------- 3. none & manual ----------
  {
    const t = T.createTurn({ https: fakeHttp(() => { throw new Error('tidak boleh'); }) });
    assert.deepStrictEqual((await t.ice()).iceServers, T.DEFAULT_STUN, 'tanpa penyedia: STUN bawaan, mode lintas jaringan tidak pernah kosong');
    t.set({ provider: 'manual', urls: ['turn:a:1'], username: 'u', credential: 'p' });
    const r = await t.ice();
    assert.deepStrictEqual(r.iceServers, T.DEFAULT_STUN.concat([{ urls: 'turn:a:1', username: 'u', credential: 'p' }]));
    assert.strictEqual(r.provider, 'manual');
    ok('none -> STUN bawaan; manual -> STUN bawaan + server pengguna, tanpa jaringan');
  }

  // ---------- 4. Metered ----------
  {
    const c = clock();
    const h = fakeHttp(() => ({ status: 200, body: JSON.stringify([{ urls: 'stun:stun.relay.metered.ca:80' }, { urls: 'turn:standard.relay.metered.ca:80', username: 'm', credential: 'n' }, { urls: 'http://jahat' }, 7]) }));
    const t = T.createTurn({ https: h, now: c.now }); t.set({ provider: 'metered', app: 'myapp', apiKey: 'k 1'.replace(' ', '') });
    const r = await t.ice();
    assert.strictEqual(h.reqs[0].opts.hostname, 'myapp.metered.live'); assert.strictEqual(h.reqs[0].opts.path, '/api/v1/turn/credentials?apiKey=k1'); assert.strictEqual(h.reqs[0].opts.method, 'GET');
    assert.deepStrictEqual(turnUrls(r), ['turn:standard.relay.metered.ca:80']); assert(!JSON.stringify(r).includes('jahat'), 'entri tidak sah dibuang');
    await t.ice(); assert.strictEqual(h.reqs.length, 1, 'dalam 1 jam: dari cache');
    c.adv(T.METERED_TTL + 1); await t.ice(); assert.strictEqual(h.reqs.length, 2, 'lewat 1 jam: ambil lagi');
    ok('Metered: URL permintaan benar, entri asing dibuang, cache 1 jam');
  }

  // ---------- 5. Cloudflare: permintaan, bentuk balasan, pembaruan sebelum kedaluwarsa ----------
  {
    const c = clock(); let n = 0;
    const h = fakeHttp(() => ({ status: 200, body: CFRES(++n) }));
    const t = T.createTurn({ https: h, now: c.now }); t.set(CF);
    const r = await t.ice();
    const q = h.reqs[0];
    assert.strictEqual(q.opts.method, 'POST'); assert.strictEqual(q.opts.hostname, 'rtc.live.cloudflare.com'); assert.strictEqual(q.opts.path, '/v1/turn/keys/key123/credentials/generate-ice-servers');
    assert.strictEqual(q.opts.headers.Authorization, 'Bearer SECRET-TOKEN'); assert.deepStrictEqual(JSON.parse(q.body), { ttl: 86400 }); assert.strictEqual(q.opts.headers['Content-Length'], Buffer.byteLength(q.body));
    const flat = JSON.stringify(r); assert(!/:53[?",]/.test(flat), 'port 53 dibuang'); assert(/turns:turn.cloudflare.com:5349/.test(flat));
    assert.deepStrictEqual(r.iceServers[r.iceServers.length - 1].username, 'u1');
    c.adv(T.CF_TTL * 1000 - T.CF_MIN_LEFT - 1000); await t.ice(); assert.strictEqual(h.reqs.length, 1, 'sisa umur masih > 6 jam: tidak diperbarui');
    c.adv(2000); const r2 = await t.ice(); assert.strictEqual(h.reqs.length, 2, 'sisa umur < 6 jam: diperbarui SEBELUM kedaluwarsa');
    assert.strictEqual(r2.iceServers[r2.iceServers.length - 1].username, 'u2');
    ok('Cloudflare: permintaan benar (URL, bearer, ttl), port 53 dibuang, diperbarui saat sisa umur < 6 jam (bukan setelah kedaluwarsa)');
    // bentuk lama: objek tunggal
    const h2 = fakeHttp(() => ({ status: 200, body: JSON.stringify({ iceServers: { urls: ['turn:t.cf:3478'], username: 'a', credential: 'b' } }) }));
    const t2 = T.createTurn({ https: h2 }); t2.set(CF); assert.deepStrictEqual(turnUrls(await t2.ice()), [['turn:t.cf:3478']].map((x) => x[0]));
    ok('Cloudflare: balasan berbentuk objek tunggal (format lama) juga diterima');
  }

  // ---------- 6. gagal: cadangan, backoff, single-flight, set() menyetel ulang ----------
  {
    const c = clock(); let mode = 'ok', n = 0;
    const h = fakeHttp(async () => { await flush(); if (mode === 'net') throw new Error('ECONNRESET'); if (mode === '401') return { status: 401, body: '{}' }; if (mode === 'junk') return { status: 200, body: '<html>' }; if (mode === 'noturn') return { status: 200, body: JSON.stringify({ iceServers: [{ urls: 'stun:x:1' }] }) }; return { status: 200, body: CFRES(++n) }; });
    const t = T.createTurn({ https: h, now: c.now }); t.set(CF);
    const all = await Promise.all([t.ice(), t.ice(), t.ice()]);
    assert.strictEqual(h.reqs.length, 1, 'tiga pemanggil serentak = satu permintaan'); assert(all.every((r) => turnUrls(r).length === 1));
    c.adv(T.CF_TTL * 1000 - T.CF_MIN_LEFT + 1000); mode = 'net';
    const r = await t.ice();
    assert.strictEqual(r.err, 'ECONNRESET'); assert.strictEqual(turnUrls(r).length, 1, 'gagal memperbarui tetapi kredensial lama masih berlaku: tetap dipakai');
    const before = h.reqs.length; await t.ice(); await t.ice(); assert.strictEqual(h.reqs.length, before, 'setelah gagal: jeda 30 dtk, tidak menghujani penyedia');
    c.adv(T.FAIL_BACKOFF + 1); mode = 'ok'; const r3 = await t.ice(); assert(!r3.err && turnUrls(r3).length === 1 && h.reqs.length === before + 1, 'pulih sendiri setelah jeda');
    // tanpa cache sama sekali
    for (const [m, re] of [['net', /ECONNRESET/], ['401', /Cloudflare token was rejected/], ['junk', /could not be read/], ['noturn', /no TURN server/]]) {
      const t2 = T.createTurn({ https: h, now: c.now }); t2.set(CF); mode = m;
      const f = await t2.ice();
      assert.deepStrictEqual(f.iceServers, T.DEFAULT_STUN, m + ': cadangan STUN bawaan, bukan daftar kosong'); assert(re.test(f.err), m + ' -> ' + f.err);
    }
    // set() baru menyetel ulang cache dan jeda
    mode = 'ok'; const t3 = T.createTurn({ https: h, now: c.now }); t3.set(CF); mode = 'net'; await t3.ice(); mode = 'ok';
    t3.set({ provider: 'cloudflare', keyId: 'lain', token: 'T2' }); const r4 = await t3.ice(); assert(!r4.err, 'konfigurasi baru tidak terkena jeda gagal milik konfigurasi lama');
    assert(/lain/.test(h.reqs[h.reqs.length - 1].opts.path));
    ok('gagal (jaringan/401/sampah/tanpa TURN): kredensial lama bila masih berlaku, kalau tidak STUN bawaan + alasan; jeda 30 dtk; satu permintaan untuk pemanggil serentak; set() baru menyetel ulang');
  }

  // ---------- 7. Core: per peer, rahasia, simpan ----------
  const mkCore = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 }, o));
  const h7 = fakeHttp(() => ({ status: 200, body: CFRES(1) }));
  const A = mkCore('A', { turn: { https: h7 } }); await A.start();
  const RID = 'ab12cd34ef56ab12', LID = 'cd34ef56ab12ab12';
  A.peers.set(RID, { id: RID, name: 'Jauh', ip: 'rtc:' + RID, port: 1, lastSeen: Date.now() });
  A.peers.set(LID, { id: LID, name: 'Dekat', ip: '192.168.1.9', port: 41235, lastSeen: Date.now() });
  assert.deepStrictEqual(await A.turnIce(LID), { iceServers: [], wan: false }, 'peer LAN: iceServers kosong seperti sebelumnya');
  assert.deepStrictEqual(await A.turnIce('0000000000000000'), { iceServers: [], wan: false }, 'peer tak dikenal: kosong (jalur LAN)');
  const w0 = await A.turnIce(RID); assert.deepStrictEqual(w0.iceServers, T.DEFAULT_STUN); assert.strictEqual(w0.wan, true);
  assert.deepStrictEqual((await A.turnIce()).iceServers, T.DEFAULT_STUN, 'tanpa peerId (DataChannel): selalu konfigurasi lintas jaringan');
  assert.strictEqual(h7.reqs.length, 0);
  A.turnSet(CF);
  const w1 = await A.turnIce(RID); assert.strictEqual(w1.provider, 'cloudflare'); assert.strictEqual(turnUrls(w1).length, 1);
  assert.deepStrictEqual((await A.turnIce(LID)).iceServers, [], 'peer LAN tetap kosong walau TURN terisi'); assert.strictEqual(h7.reqs.length, 1);
  assert(!JSON.stringify(A.turnInfo()).includes('SECRET-TOKEN') && !JSON.stringify(A.state ? A.state() : {}).includes('SECRET-TOKEN'), 'rahasia tidak keluar lewat turnInfo/state');
  assert.throws(() => A.turnSet({ provider: 'metered', app: '', apiKey: 'x' }), /Metered/); assert.strictEqual(A.turnInfo().provider, 'cloudflare', 'masukan rusak tidak merusak konfigurasi yang ada');
  await A.stop();
  const A2 = mkCore('A', { turn: { https: h7 } }); await A2.start();
  assert.deepStrictEqual(A2.turnInfo(), { provider: 'cloudflare', keyId: 'key123', hasSecret: true }, 'konfigurasi bertahan setelah restart');
  A2.turnClear(); assert.strictEqual(A2.turnInfo().provider, 'none'); assert(!A2.store.turn); await A2.stop();
  fs.writeFileSync(path.join(tmp, 'A', fs.readdirSync(path.join(tmp, 'A')).find((f) => /store/.test(f)) || 'store.json'), JSON.stringify({ turn: { provider: 'metered', app: '../x', apiKey: 'k' } }));
  const A3 = mkCore('A', { turn: { https: h7 } }); await A3.start(); assert.strictEqual(A3.turnInfo().provider, 'none', 'konfigurasi tersimpan yang rusak dibuang, Core tetap jalan'); await A3.stop();
  ok('Core: peer LAN -> [], peer rtc: -> STUN+TURN, DataChannel selalu lintas jaringan; rahasia tidak bocor; bertahan setelah restart; simpanan rusak dibuang');

  // ---------- 8. UI panggilan ----------
  class FakePC { constructor(cfg) { this.cfg = cfg; FakePC.all.push(this); } addTrack() {} async createOffer() { return { type: 'offer', sdp: 'O' }; } async createAnswer() { return { type: 'answer', sdp: 'A' }; } async setLocalDescription(d) { this.localDescription = d; } async setRemoteDescription() {} async addIceCandidate() {} close() {} }
  FakePC.all = [];
  const mkUi = (turnIce, extra) => {
    FakePC.all = []; const calls = [], ended = [];
    const api = new Proxy({}, { get: (_t, n) => (n === 'turnIce' ? turnIce : async (...a) => { calls.push([n, ...a]); return { ok: true, cid: 'a1'.repeat(8) }; }) });
    const st = { getTracks: () => [{ kind: 'audio', enabled: true, stop() {} }], getAudioTracks: () => [{ enabled: true }] };
    const ctl = new LC.Controller(Object.assign({ api, rtc: { PeerConnection: FakePC, getUserMedia: async () => st, makeStream: () => ({}), playRemote: () => () => {} }, ui: { render() {}, ring() {}, ended: (i) => ended.push(i) } }, extra));
    return { ctl, calls, ended };
  };
  const SRV = [{ urls: 'stun:s:1' }, { urls: 'turn:t:1', username: 'u', credential: 'c' }];
  { const m = mkUi(undefined); await m.ctl.start('p1', 'B'); await flush(); assert.deepStrictEqual(FakePC.all[0].cfg, { iceServers: [] }, 'API tanpa turnIce (versi lama): LAN seperti biasa'); }
  { const q = []; const m = mkUi(async (p) => { q.push(p); return { ok: true, iceServers: [], wan: false }; }); await m.ctl.start('p1', 'B'); await flush(); assert.deepStrictEqual(q, ['p1']); assert.deepStrictEqual(FakePC.all[0].cfg, { iceServers: [] }, 'peer LAN: iceServers kosong'); }
  { const m = mkUi(async () => ({ ok: true, iceServers: SRV, wan: true })); await m.ctl.start('p1', 'B'); await flush(); assert.deepStrictEqual(FakePC.all[0].cfg, { iceServers: SRV }, 'peer lintas jaringan: STUN+TURN dari Core'); }
  { const m = mkUi(async () => { throw new Error('putus'); }); const r = await m.ctl.start('p1', 'B'); await flush(); assert.strictEqual(r.ok, true); assert.deepStrictEqual(FakePC.all[0].cfg, { iceServers: [] }, 'Core tak menjawab: tetap menelepon (tanpa server)'); }
  { // dibatalkan selagi menunggu ICE: tidak ada PeerConnection yatim
    let rel; const gate = new Promise((r) => { rel = r; });
    const m = mkUi(async () => { await gate; return { ok: true, iceServers: SRV, wan: true }; });
    const p = m.ctl.start('p1', 'B'); await flush(); await flush(); m.ctl.hangup(); rel(); const r = await p; await flush();
    assert.strictEqual(r.ok, false); assert.strictEqual(FakePC.all.length, 0, 'tidak ada RTCPeerConnection setelah dibatalkan'); assert(!m.calls.some((c) => c[0] === 'callStart'), 'tidak mengirim tawaran untuk panggilan yang sudah batal');
  }
  { // panggilan masuk dari peer lintas jaringan
    const m = mkUi(async () => ({ ok: true, iceServers: SRV, wan: true }));
    await m.ctl.onEvent({ ev: 'incoming', cid: 'b2'.repeat(8), peer: 'p9', name: 'Jauh', sdp: 'OFFER' }); await flush();
    await m.ctl.accept(); await flush(); assert.deepStrictEqual(FakePC.all[0].cfg, { iceServers: SRV }, 'jawaban panggilan masuk memakai ICE lintas jaringan juga');
  }
  { // teks galat: lintas jaringan -> sebut TURN; LAN tetap teks lama
    assert(/TURN/.test(LC.endText({ reason: 'failed', wan: true })));
    assert.strictEqual(LC.endText({ reason: 'failed' }), 'Gagal tersambung. Pastikan kedua perangkat bisa saling terhubung.');
    const m = mkUi(async () => ({ ok: true, iceServers: SRV, wan: true })); await m.ctl.start('p1', 'B'); await flush();
    FakePC.all[0].connectionState = 'failed'; FakePC.all[0].onconnectionstatechange(); await flush();
    assert.strictEqual(m.ended.length, 1); assert.strictEqual(m.ended[0].reason, 'failed'); assert.strictEqual(m.ended[0].wan, true);
  }
  ok('UI panggilan: peer LAN/API lama -> iceServers [], peer lintas jaringan -> daftar dari Core (keluar dan masuk); Core diam -> tetap jalan; batal saat menunggu -> tanpa PC yatim; gagal lintas jaringan menyebut TURN');

  // ---------- 9. kontrak IPC ----------
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), api = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archne-api-http.js'), 'utf8');
  for (const n of ['turnInfo', 'turnSet', 'turnClear', 'turnIce']) { assert(new RegExp('^\\s{2}' + n + ':', 'm').test(pre), 'preload ' + n); assert(api.includes("'" + n + "'"), 'api-http ' + n); }
  ok('preload.js dan archne-api-http.js memuat turnInfo/turnSet/turnClear/turnIce');

  console.log(`\n${pass} lulus`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

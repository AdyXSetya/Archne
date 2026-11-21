'use strict';
// Tes peredam kebisingan (v0.16.0): constraint, pilihan Mati/Standar/Kuat saat panggilan, jalur WebAudio (noise gate), tampilan, kontrak archne-index.html.
// Kualitas suara sungguhan tidak bisa dites di sini: lihat README.md bagian 6 (Manual tes).
const fs = require('fs'), path = require('path'), assert = require('assert');
const LC = require('../renderer/archne-call');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const flush = () => new Promise((r) => setImmediate(r));
const CID = 'b2'.repeat(8);

class FakePC {
  constructor() { this.tracks = []; this.senders = []; this.remoteDescription = null; this.localDescription = null; FakePC.all.push(this); }
  addTrack(t) { this.tracks.push(t); const s = { track: t, replaced: [], failReplace: false, async replaceTrack(n) { if (this.failReplace) throw new Error('replaceTrack gagal'); this.track = n; this.replaced.push(n); } }; this.senders.push(s); return s; }
  async createOffer() { return { type: 'offer', sdp: 'OFFER' }; }
  async createAnswer() { return { type: 'answer', sdp: 'ANSWER' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate() {}
  close() {}
  state(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
}
FakePC.all = [];
const mkTrack = (name) => ({ name, enabled: true, stopped: false, constraints: [], stop() { this.stopped = true; }, async applyConstraints(c) { this.constraints.push(c); } });
const mkStream = (name) => { const t = mkTrack(name); return { t, getTracks: () => [t], getAudioTracks: () => [t] }; };

function mk(o) {
  o = o || {};
  FakePC.all = [];
  const gums = [], procs = [], notices = [], renders = [];
  const rtc = {
    PeerConnection: FakePC,
    getUserMedia: async (c) => { gums.push(c); return mkStream('mic'); },
    makeStream: (tr) => ({ tr }), playRemote: () => () => {},
  };
  if (o.strengthen !== false) rtc.strengthen = (st) => { if (o.strengthen === 'null') return null; const p = { src: st, stream: mkStream('proc'), stopped: 0, stop() { this.stopped++; } }; procs.push(p); return p; };
  const api = new Proxy({}, { get: (_t, n) => async () => (n === 'callStart' ? { ok: true, cid: CID } : { ok: true }) });
  const ctl = new LC.Controller({ api, rtc, ui: { render: (v) => renders.push(v), ring() {}, ended() {}, notice: (t) => notices.push(t) } });
  return { ctl, gums, procs, notices, renders, pc: () => FakePC.all[FakePC.all.length - 1] };
}
// panggilan keluar yang sudah tersambung
async function active(o) {
  const m = mk(o);
  await m.ctl.start('peer1', 'Budi'); await flush();
  m.pc().state('connected'); await flush();
  assert.strictEqual(m.ctl.cur.phase, 'active');
  return m;
}

(async () => {
  // ---------- 1. constraint ----------
  assert.deepStrictEqual(LC.NOISE_MODES, ['off', 'standard', 'strong']);
  assert.strictEqual(LC.NOISE_DEFAULT, 'standard');
  assert.deepStrictEqual(LC.audioConstraints('off'), { echoCancellation: true, noiseSuppression: false, autoGainControl: true });
  assert.deepStrictEqual(LC.audioConstraints('standard'), { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  assert.deepStrictEqual(LC.audioConstraints('strong'), { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, 'Kuat memakai Standar sebagai dasar');
  ok('constraint: Mati hanya mematikan noiseSuppression (gema dan AGC tetap); Standar dan Kuat menyalakannya');

  // ---------- 2. default Standar, panggilan keluar dan masuk ----------
  {
    const m = await active();
    assert.deepStrictEqual(m.gums[0], { audio: LC.audioConstraints('standard') });
    assert.strictEqual(m.ctl.view().noise, 'standard');
    assert.strictEqual(m.procs.length, 0, 'Standar tidak membuat jalur WebAudio');
    const a = mk();
    a.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'peer1', name: 'Budi', sdp: 'S' }); await flush();
    assert.strictEqual(a.ctl.view().noise, 'standard'); assert.strictEqual(a.gums.length, 0, 'berdering: mikrofon belum disentuh');
    await a.ctl.accept(); assert.deepStrictEqual(a.gums[0], { audio: LC.audioConstraints('standard') });
    ok('default Standar di panggilan keluar dan masuk; tanpa jalur WebAudio');
  }

  // ---------- 3. Mati / Standar lewat applyConstraints ----------
  {
    const m = await active(), raw = m.ctl.cur.stream.t;
    assert.strictEqual(await m.ctl.setNoise('off'), true);
    assert.strictEqual(m.ctl.view().noise, 'off');
    assert.deepStrictEqual(raw.constraints[raw.constraints.length - 1], LC.audioConstraints('off'));
    assert.strictEqual(m.ctl.setNoise('off') instanceof Promise, true); assert.strictEqual(await m.ctl.setNoise('off'), false, 'pilihan sama: tidak berbuat apa-apa');
    await m.ctl.setNoise('standard');
    assert.deepStrictEqual(raw.constraints[raw.constraints.length - 1], LC.audioConstraints('standard'));
    assert.strictEqual(m.pc().senders[0].replaced.length, 0, 'Mati/Standar tidak mengganti trek yang dikirim');
    assert.strictEqual(await m.ctl.setNoise('ngawur'), false); assert.strictEqual(await m.ctl.setNoise(undefined), false); assert.strictEqual(m.ctl.view().noise, 'standard', 'nilai tak dikenal diabaikan');
    ok('Mati/Standar: constraint diterapkan pada trek mikrofon yang sama, tanpa mengganti trek; nilai tak dikenal diabaikan');
  }

  // ---------- 4. Kuat: jalur WebAudio, replaceTrack, kembali, mute, tutup ----------
  {
    const m = await active(), raw = m.ctl.cur.stream.t, snd = m.pc().senders[0];
    await m.ctl.setNoise('strong');
    assert.strictEqual(m.procs.length, 1); assert.strictEqual(m.procs[0].src, m.ctl.cur.stream, 'jalur dibangun dari mikrofon asli');
    assert.strictEqual(snd.track, m.procs[0].stream.t, 'yang dikirim ke lawan kini trek hasil olahan');
    assert.strictEqual(m.ctl.view().noise, 'strong');
    m.ctl.mute(true); assert.strictEqual(raw.enabled, false, 'bisu mematikan trek mikrofon asli (sumber jalur olahan), jadi hasilnya senyap');
    m.ctl.mute(false); assert.strictEqual(raw.enabled, true);
    await m.ctl.setNoise('off');
    assert.strictEqual(snd.track, raw, 'kembali ke trek asli'); assert.strictEqual(m.procs[0].stopped, 1, 'jalur olahan dilepas'); assert.strictEqual(m.ctl.cur.proc, null);
    await m.ctl.setNoise('strong'); assert.strictEqual(m.procs.length, 2, 'Kuat lagi: jalur baru');
    m.ctl.hangup();
    assert.strictEqual(m.procs[1].stopped, 1, 'menutup panggilan melepas jalur olahan'); assert.strictEqual(raw.stopped, true);
    ok('Kuat: jalur olahan dipasang lewat replaceTrack; bisu tetap membisukan; kembali ke Mati/Standar melepasnya; menutup panggilan melepas semuanya');
  }

  // ---------- 5. gagal: tanpa WebAudio / replaceTrack gagal ----------
  {
    for (const how of ['null', 'nofn']) {
      const m = await active(how === 'null' ? { strengthen: 'null' } : { strengthen: false });
      await m.ctl.setNoise('strong');
      assert.strictEqual(m.ctl.view().noise, 'standard', how + ': kembali ke Standar'); assert.strictEqual(m.notices.length, 1); assert(/Kuat/.test(m.notices[0]));
    }
    const m = await active(); m.pc().senders[0].failReplace = true;
    await m.ctl.setNoise('strong');
    assert.strictEqual(m.ctl.view().noise, 'standard'); assert.strictEqual(m.procs[0].stopped, 1, 'jalur yang gagal dipasang dilepas'); assert.strictEqual(m.ctl.cur.proc, null); assert.strictEqual(m.notices.length, 1);
    ok('Kuat gagal (tanpa WebAudio atau replaceTrack menolak): kembali ke Standar, jalur dilepas, pengguna diberi tahu');
  }

  // ---------- 6. ketukan beruntun, fase, tanpa panggilan ----------
  {
    const m = await active(), snd = m.pc().senders[0];
    const ps = [m.ctl.setNoise('strong'), m.ctl.setNoise('off'), m.ctl.setNoise('strong'), m.ctl.setNoise('standard')];
    await Promise.all(ps); await flush(); await flush();
    assert.strictEqual(m.ctl.view().noise, 'standard');
    assert.strictEqual(m.ctl.cur.proc, null, 'keadaan akhir = Standar: tidak ada jalur tersisa');
    assert.strictEqual(snd.track, m.ctl.cur.stream.t, 'trek yang dikirim sesuai pilihan terakhir');
    assert(m.procs.every((p) => p.stopped === 1), 'setiap jalur yang pernah dibuat sudah dilepas: ' + m.procs.map((p) => p.stopped));
    const r = mk(); assert.strictEqual(await r.ctl.setNoise('off'), false, 'tanpa panggilan');
    r.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'p', name: 'N', sdp: 'S' }); await flush();
    assert.strictEqual(await r.ctl.setNoise('off'), false, 'berdering: belum bisa'); assert.strictEqual(r.ctl.view().noise, 'standard');
    ok('ketukan beruntun berujung pada pilihan terakhir tanpa jalur bocor; tanpa panggilan atau saat berdering diabaikan');
  }

  // ---------- 7. dipilih sebelum mikrofon siap: diterapkan begitu mikrofon dan sender ada ----------
  for (const mode of ['off', 'strong']) {
    const m = mk(); let release; const gate = new Promise((r) => { release = r; });
    const orig = m.ctl.rtc.getUserMedia; m.ctl.rtc.getUserMedia = async (c) => { await gate; return orig(c); };
    const p = m.ctl.accept; // panggilan masuk: fase 'connecting' sambil dialog izin terbuka
    m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'peer1', name: 'Budi', sdp: 'S' }); await flush();
    const acc = m.ctl.accept(); await flush();
    assert.strictEqual(m.ctl.view().phase, 'connecting');
    assert.strictEqual(await m.ctl.setNoise(mode), true); assert.strictEqual(m.ctl.view().noise, mode);
    assert.strictEqual(m.ctl.cur.stream, null, 'mikrofon belum ada');
    release(); await acc; await flush(); await flush();
    const raw = m.ctl.cur.stream.t, snd = m.pc().senders[0];
    assert.strictEqual(m.ctl.view().noise, mode);
    if (mode === 'off') assert.deepStrictEqual(raw.constraints[raw.constraints.length - 1], LC.audioConstraints('off'), 'Mati dipilih saat menunggu izin: tetap diterapkan');
    else { assert.strictEqual(m.procs.length, 1); assert.strictEqual(snd.track, m.procs[0].stream.t, 'Kuat dipilih saat menunggu izin: jalur terpasang'); }
  }
  ok('dipilih saat dialog izin mikrofon masih terbuka: pilihan tetap diterapkan setelah mikrofon dan sender siap');

  // ---------- 8. NoiseGate ----------
  {
    const SR = 48000, N = 2048;
    const blk = (amp, f, ph) => { const b = new Float32Array(N); for (let i = 0; i < N; i++) b[i] = amp * Math.sin(2 * Math.PI * f * (ph + i) / SR); return b; };
    const rms = (b) => Math.sqrt(b.reduce((s, v) => s + v * v, 0) / b.length);
    const run = (g, amp, n, f) => { let last; for (let k = 0; k < n; k++) { const o = new Float32Array(N); g.process(blk(amp, f || 300, k * N), o); last = o; } return last; };
    // bising stabil rendah, lalu suara keras: bising teredam, suara lolos
    let g = new LC.NoiseGate(SR);
    const noiseOut = run(g, 0.004, 60);
    assert(rms(noiseOut) < 0.004 * 0.3, 'bising stabil teredam >10 dB: ' + rms(noiseOut));
    const o1 = new Float32Array(N); const open = g.process(blk(0.2, 300, 0), o1);
    assert.strictEqual(open, true, 'suara keras membuka gerbang di blok pertamanya');
    const o2 = run(g, 0.2, 5); assert(rms(o2) > 0.2 * 0.7 * 0.95, 'suara lolos hampir utuh: ' + rms(o2) / (0.2 * 0.7071));
    // tahan: akhir kata tidak langsung terpotong
    const t1 = new Float32Array(N); assert.strictEqual(g.process(blk(0.004, 300, 0), t1), true, 'masih terbuka tepat setelah suara berhenti (hold)');
    run(g, 0.004, 20); assert.strictEqual(g.open, false, 'akhirnya menutup');
    // bising naik pelan: lantai ikut naik, gerbang tidak terkunci terbuka selamanya
    g = new LC.NoiseGate(SR); run(g, 0.004, 40);
    run(g, 0.03, 100); assert.strictEqual(g.open, false, 'bising stabil yang lebih keras akhirnya dianggap bising juga (lantai mengikuti)');
    // keselamatan numerik
    g = new LC.NoiseGate(0); const z = new Float32Array(N), oz = new Float32Array(N); g.process(z, oz); assert(oz.every((v) => v === 0 && !Number.isNaN(v)), 'hening: keluaran nol, tanpa NaN');
    const e = new Float32Array(0); assert.doesNotThrow(() => g.process(e, new Float32Array(0)));
    const big = blk(1, 100, 0); const ob = new Float32Array(N); g.process(big, ob); assert(ob.every((v) => Math.abs(v) <= 1.0000001), 'tidak pernah menguatkan (gain <= 1)');
    ok('NoiseGate: bising stabil teredam, suara lolos, hold di akhir kata, lantai mengikuti bising yang naik, aman di hening/kosong, tidak pernah menguatkan');
  }

  // ---------- 9. browserRtc.strengthen ----------
  {
    const log = [];
    const node = (n, x) => Object.assign({ connect(d) { log.push(n + '->' + d.n); }, disconnect() { log.push('x' + n); }, n }, x);
    class AC {
      constructor() { this.sampleRate = 44100; this.state = 'suspended'; AC.made = this; }
      resume() { log.push('resume'); }
      createMediaStreamSource() { return node('src'); }
      createBiquadFilter() { return node('hp', { frequency: {} }); }
      createScriptProcessor(n, i, o) { log.push('sp' + n + ',' + i + ',' + o); return node('sp'); }
      createMediaStreamDestination() { return node('dst', { stream: { dst: 1 } }); }
      close() { log.push('close'); }
    }
    const w = { RTCPeerConnection: function () {}, MediaStream: function () {}, AudioContext: AC, navigator: {} };
    const r = await LC.browserRtc(w, null).strengthen({ s: 1 });
    assert(r && r.stream.dst === 1 && r.engine === 'gate', 'tanpa AudioWorklet: noise gate');
    assert.deepStrictEqual(log.filter((x) => /->/.test(x)), ['src->hp', 'hp->sp', 'sp->dst'], 'mikrofon -> pelewat-tinggi -> gate -> keluaran');
    assert(log.includes('sp2048,1,1') && log.includes('resume'));
    const hpNode = null; // frekuensi pelewat-tinggi diperiksa lewat sumber di bawah
    r.stop(); assert(log.includes('close') && log.includes('xsp'), 'stop memutus dan menutup AudioContext');
    assert.strictEqual(await LC.browserRtc({ RTCPeerConnection: function () {} }, null).strengthen({}), null, 'tanpa AudioContext: null');
    assert.strictEqual(await LC.browserRtc(Object.assign({}, w, { AudioContext: function () { throw new Error('x'); } }), null).strengthen({}), null, 'AudioContext melempar: null, tidak menjatuhkan panggilan');
    assert(/hp\.frequency\.value = 90/.test(require('./_src').callSrc()) && /new NoiseGate\(ctx\.sampleRate\)/.test(require('./_src').callSrc()));
    ok('strengthen: graf mic->pelewat-tinggi->gate->keluaran, stop menutup konteks, null bila WebAudio tidak ada atau gagal');
  }

  // ---------- 9b. RNNoise (AudioWorklet + WASM) ----------
  {
    const mkEnv = (o) => {
      o = o || {};
      const log = [], made = [];
      const node = (n, x) => Object.assign({ connect(d) { log.push(n + '->' + d.n); }, disconnect() { log.push('x' + n); }, n }, x);
      class AC {
        constructor(opt) { this.opt = opt; this.sampleRate = (opt && opt.sampleRate) || 44100; this.state = 'running'; this.closed = 0; made.push(this);
          if (o.noWorklet) this.audioWorklet = undefined; else this.audioWorklet = { addModule: async (u) => { log.push('module:' + u); if (o.moduleFails) throw new Error('addModule'); if (o.hang) await new Promise(() => {}); } }; }
        createMediaStreamSource() { return node('src'); }
        createBiquadFilter() { return node('hp', { frequency: {} }); }
        createScriptProcessor() { return node('sp'); }
        createMediaStreamDestination() { return node('dst', { stream: { dst: 1 } }); }
        close() { this.closed++; log.push('close'); }
      }
      class AWN { constructor(ctx, id, opt) { this.ctx = ctx; this.id = id; this.opt = opt; this.n = 'nn'; this.sent = []; this.port = { postMessage: (m) => this.sent.push(m) }; made.push(this); }
        connect(d) { log.push('nn->' + d.n); } disconnect() { log.push('xnn'); } }
      const fetched = [];
      const w = { RTCPeerConnection: function () {}, MediaStream: function () {}, AudioContext: AC, AudioWorkletNode: o.noAWN ? undefined : AWN, navigator: {}, WebAssembly: { validate: () => o.simd !== false },
        fetch: o.fetchFails ? async (u) => { fetched.push(u); throw new Error('file:// tidak didukung'); } : async (u) => { fetched.push(u); return { ok: true, arrayBuffer: async () => new Uint8Array([0, 97, 115, 109]).buffer }; },
        XMLHttpRequest: function () { this.open = function (m, u) { fetched.push('xhr:' + u); }; this.send = function () { this.response = new Uint8Array([0, 97, 115, 109]).buffer; this.status = o.xhrStatus === undefined ? 0 : o.xhrStatus; setImmediate(() => this.onload()); }; } };
      return { w, log, made, fetched };
    };
    // jalur utama
    let e = mkEnv();
    let r = await LC.browserRtc(e.w, null).strengthen({ s: 1 });
    assert(r && r.engine === 'rnnoise' && r.stream.dst === 1);
    const ac = e.made.find((x) => x.opt), nn = e.made.find((x) => x.id);
    assert.deepStrictEqual(ac.opt, { sampleRate: 48000 }, 'RNNoise butuh 48 kHz');
    assert(nn.id === '@sapphi-red/web-noise-suppressor/rnnoise' && nn.opt.processorOptions.maxChannels === 1 && nn.opt.processorOptions.wasmBinary.byteLength === 4 && nn.opt.channelCount === 1);
    assert.deepStrictEqual(e.log.filter((x) => /->/.test(x)), ['src->hp', 'hp->nn', 'nn->dst'], 'mikrofon -> pelewat-tinggi -> RNNoise -> keluaran');
    assert(e.log.includes('module:vendor/rnnoise-worklet.js') && e.fetched[0] === 'vendor/rnnoise_simd.wasm', 'SIMD dipakai bila ada');
    r.stop(); assert(nn.sent.includes('destroy') && ac.closed === 1 && e.log.includes('xnn'), 'stop: destroy worklet, putus, tutup konteks');
    // tanpa SIMD
    e = mkEnv({ simd: false }); r = await LC.browserRtc(e.w, null).strengthen({}); assert(r.engine === 'rnnoise' && e.fetched[0] === 'vendor/rnnoise.wasm', 'tanpa SIMD: biner biasa');
    // fetch gagal -> XHR (file://)
    e = mkEnv({ fetchFails: true }); r = await LC.browserRtc(e.w, null).strengthen({}); assert(r.engine === 'rnnoise' && e.fetched.some((x) => /^xhr:/.test(x)), 'fetch gagal: XHR');
    // cadangan: tiap kegagalan jatuh ke noise gate, konteks RNNoise ditutup
    for (const [nm, o] of [['tanpa AudioWorkletNode', { noAWN: true }], ['tanpa audioWorklet', { noWorklet: true }], ['addModule gagal', { moduleFails: true }], ['XHR 404', { fetchFails: true, xhrStatus: 404 }]]) {
      e = mkEnv(o); r = await LC.browserRtc(e.w, null).strengthen({ s: 1 });
      assert(r && r.engine === 'gate', nm + ': jatuh ke noise gate');
      assert(e.made.filter((x) => x.opt).every((x, i, a) => i === a.length - 1 || x.closed === 1), nm + ': konteks RNNoise ditutup');
    }
    // timeout: gate dipakai, hasil RNNoise yang terlambat dibersihkan
    e = mkEnv({ hang: true });
    const realST = global.setTimeout; global.setTimeout = (f, ms) => realST(f, ms > 1000 ? 5 : ms);
    try { r = await LC.browserRtc(e.w, null).strengthen({}); } finally { global.setTimeout = realST; }
    assert(r && r.engine === 'gate', 'waktu habis: noise gate');
    ok('RNNoise: rantai simpul, 48 kHz, SIMD/non-SIMD, XHR cadangan, stop membersihkan; semua kegagalan jatuh ke noise gate');
  }
  // ---------- 9c. berkas, MIME, CSP ----------
  {
    for (const f of ['rnnoise-worklet.js', 'rnnoise.wasm', 'rnnoise_simd.wasm', 'LICENSE-web-noise-suppressor.txt']) assert(fs.statSync(path.join(root, 'renderer/vendor', f)).size > 500, f + ' ada');
    for (const f of ['rnnoise.wasm', 'rnnoise_simd.wasm']) assert.deepStrictEqual([...fs.readFileSync(path.join(root, 'renderer/vendor', f)).subarray(0, 4)], [0, 97, 115, 109], f + ' berkas WASM sah');
    assert(/'\.wasm': 'application\/wasm'/.test(read('src/archne-rpc.js')), 'server melayani .wasm sebagai application/wasm');
    assert(/script-src[^"]*'wasm-unsafe-eval'/.test(require('./_src').htmlSrc()), 'CSP mengizinkan kompilasi WASM');
    assert(/renderer\/\*\*/.test(read('package.json')), 'renderer/** (termasuk vendor/) ikut paket Electron');
    ok('berkas RNNoise di renderer/vendor, MIME wasm, CSP wasm-unsafe-eval');
  }

  // ---------- 10. tampilan ----------
  {
    const h = { esc: (s) => s, avatar: () => '', icons: { phone: 'P', mic: 'M', micOff: 'X' } };
    const v = (o) => LC.overlayHtml(Object.assign({ peer: 'p', name: 'N', since: 1, muted: false }, o), h);
    const modes = (html) => [...html.matchAll(/data-cnoise="(\w+)"/g)].map((x) => x[1]);
    const cur = (html) => [...html.matchAll(/data-nz="(\w+)"/g)].map((x) => x[1]);
    // satu tombol di barisan tombol; data-cnoise = mode berikutnya (Mati -> Standar -> Kuat -> Mati), data-nz = sekarang
    assert.deepStrictEqual(modes(v({ phase: 'active' })), ['strong'], 'Standar -> Kuat');
    assert.deepStrictEqual(cur(v({ phase: 'active' })), ['standard'], 'tanpa nilai: Standar');
    assert(/Bising: Standar/.test(v({ phase: 'active' })) && !/cseg/.test(v({ phase: 'active' })), 'tombol, bukan pilihan tiga segmen');
    assert.deepStrictEqual(modes(v({ phase: 'active', noise: 'strong' })), ['off'], 'Kuat -> Mati');
    assert.deepStrictEqual(modes(v({ phase: 'active', noise: 'off' })), ['standard'], 'Mati -> Standar');
    assert.deepStrictEqual(modes(v({ phase: 'connecting' })), ['strong']);
    for (const ph of ['ringing', 'dialing']) assert.deepStrictEqual(modes(v({ phase: ph, canAccept: ph === 'ringing' })), [], ph + ': belum ada tombol');
    for (const m of LC.NOISE_MODES) assert.deepStrictEqual(cur(v({ phase: 'active', noise: m })), [m]);
    assert.deepStrictEqual(cur(v({ phase: 'active', noise: '<x>' })), ['standard'], 'nilai aneh jatuh ke Standar');
    assert(/class="cbtn tog nz-strong on"/.test(v({ phase: 'active', noise: 'strong' })), 'Kuat ditandai menyala');
    assert(/class="cbtn tog nz-off"/.test(v({ phase: 'active', noise: 'off' })), 'Mati meredup');
    assert(!/data-cact="noise/.test(v({ phase: 'active' })), 'bukan tombol aksi biasa');
    ok('layar panggilan: satu tombol bising yang berputar Mati/Standar/Kuat, hanya saat menyambungkan/tersambung, default Standar, nilai aneh aman');
  }

  // ---------- 11. kontrak archne-index.html ----------
  {
    const html = require('./_src').htmlSrc();
    assert(/closest\('\[data-cnoise\]'\)[^\n]*callCtl\.setNoise\(nb\.dataset\.cnoise\)/.test(html), 'ketukan pilihan diteruskan ke Controller');
    assert(/notice\(t\) \{ toast\(t\); \}/.test(html), 'pemberitahuan gagal Kuat tampil sebagai toast');
    assert(/#callov \.cbtn\.nz-off/.test(html), 'gaya tombol bising Mati');
    assert(/@media \(min-width:760px\)[^\n]*\.cvg\[data-n="2"\]\{--c:2;--r:1\}/.test(html), 'video 1-1 berdampingan di layar lebar');
    assert(!/getUserMedia/.test(read('mobile/shell/index.html')), 'pembungkus Android tidak menyentuh audio UI');
    assert(!/noiseSuppression|AudioWorklet/.test(html), 'logika peredam tinggal di archne-call.js');
    ok('archne-index.html: ketukan pilihan, toast, dan gaya terpasang; logika hanya di archne-call.js');
  }

  console.log('\n' + pass + ' tes peredam kebisingan OK');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

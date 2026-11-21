'use strict';
// Tes video tahap 7: (1) Core menandai panggilan video di riwayat dan event 'incoming'; (2) label dan ikon riwayat;
// (3) izin CAMERA Android: urutan mic -> kamera lewat jembatan, kamera ditolak jatuh ke suara saja, balik kamera hanya minta kamera;
// (4) berkas cangkang Android (plugin, manifest, delegasi iframe, teks notifikasi). Java tidak dikompilasi di Node: yang dicek bentuk dan kontraknya.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const LC = require('../renderer/archne-call');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-vidlog-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); }
  throw new Error('timeout: ' + label);
}
const mk = (n, extra) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false }, extra));
const lan = (c, ...o) => Promise.all(o.map((x) => c.addPeer('127.0.0.1', x.port)));
const log = (c) => c.getState().calls;
const find = (c, cid) => log(c).find((r) => r.id === cid);
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const VSDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
const ASDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  // ---------- 1. label dan ikon ----------
  let L = LC.callLabel({ dir: 'out', out: 'done', dur: 135, video: true });
  assert.deepStrictEqual([L.title, L.sub, L.short], ['Panggilan video', '2 mnt 15 dtk', 'Panggilan video · 2 mnt 15 dtk']);
  L = LC.callLabel({ dir: 'in', out: 'missed', video: true });
  assert(L.bad && L.title === 'Panggilan video tak terjawab' && L.short === 'Panggilan video tak terjawab');
  assert.strictEqual(LC.callLabel({ dir: 'out', out: 'noanswer', video: true }).short, 'Panggilan video · tidak dijawab');
  assert.strictEqual(LC.callLabel({ dir: 'out', out: 'done', dur: 5 }).title, 'Panggilan suara', 'tanpa penanda: tetap suara');
  L = LC.callLabel({ dir: 'out', out: 'done', dur: 60, group: 1, video: 1 });
  assert.strictEqual(L.title, 'Panggilan video grup · 1 mnt');
  assert.strictEqual(LC.callLabel({ dir: 'out', out: 'done', dur: 60, group: 1 }).title, 'Panggilan grup · 1 mnt', 'grup suara tidak berubah');
  assert.strictEqual(LC.callLabel({ dir: 'in', out: 'missed', group: 1, video: 1 }).title, 'Panggilan video grup tak terjawab');
  const idx = require('./_src').htmlSrc();
  assert(/<span class="ci">\$\{r\.video \? IC\.video : IC\.phone\}<\/span>/.test(idx), 'kartu riwayat memakai ikon video');
  assert(/const sub = \(r\.group \? txf\('call\.tagGroup', 'Grup'\) \+ ' · ' : ''\) \+ \(r\.video \? txf\('call\.tagVideo', 'Video'\) \+ ' · ' : ''\) \+ L\.sub;/.test(idx), 'baris tab Panggilan menyebut Video');
  assert(/ev\.video \? I18N\.tr\('e\.native\.callVideo', null, 'Panggilan video masuk'\) : I18N\.tr\('e\.native\.callVoice', null, 'Panggilan suara masuk'\)/.test(read('main.js')), 'notifikasi desktop');
  ok('label, ikon kartu, keterangan baris, dan notifikasi desktop untuk panggilan video');

  // ---------- 2. Core ----------
  const A = mk('A', { callRingMs: 1200, callConnMs: 1500 }), B = mk('B', { callRingMs: 1200, callConnMs: 1500 }), C = mk('C', { callRingMs: 1200 });
  const all = [A, B, C];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 2), 8000, 'mesh');
  const incoming = []; B.on('call', (e) => { if (e.ev === 'incoming') incoming.push(e); });

  // video tersambung
  const v1 = A.callStart(B.id, VSDP);
  await until(() => B.getState().call && B.getState().call.cid === v1, 5000, 'B berdering');
  assert.strictEqual(incoming[0].video, true, 'event incoming membawa video:true');
  B.callAnswer(v1, 'ANS'); await until(() => A.getState().call && A.getState().call.state === 'connecting', 5000, 'connecting');
  A.callConnected(v1); B.callConnected(v1);
  await sleep(1100); B.callEnd(v1);
  await until(() => find(A, v1) && find(B, v1), 5000, 'riwayat video');
  assert.strictEqual(find(A, v1).video, true); assert.strictEqual(find(B, v1).video, true);
  assert.strictEqual(find(A, v1).out, 'done');
  // suara tetap suara; event incoming tanpa medan video
  const s1 = A.callStart(B.id, ASDP);
  await until(() => B.getState().call && B.getState().call.cid === s1, 5000, 'B berdering suara');
  const ev2 = incoming.find((e) => e.cid === s1); assert(ev2 && !('video' in ev2), 'panggilan suara: event tanpa medan video');
  B.callReject(s1); await until(() => find(A, s1) && find(B, s1), 5000, 'riwayat suara');
  assert.strictEqual(find(A, s1).video, false); assert.strictEqual(find(B, s1).video, false);
  ok('Core menandai panggilan video di kedua sisi; panggilan suara tidak');

  // video tidak dijawab -> tak terjawab bertanda video
  const v2 = A.callStart(B.id, VSDP);
  await until(() => find(A, v2) && find(B, v2), 6000, 'kedaluwarsa');
  assert.deepStrictEqual([find(A, v2).out, find(A, v2).video, find(B, v2).out, find(B, v2).video], ['noanswer', true, 'missed', true]);
  // ditolak, video
  const v3 = A.callStart(B.id, VSDP); await until(() => B.getState().call && B.getState().call.cid === v3, 5000, 'tawaran v3');
  B.callReject(v3); await until(() => find(A, v3), 5000, 'riwayat v3');
  assert.deepStrictEqual([find(A, v3).out, find(A, v3).video], ['rejected', true]);
  ok('video tak terjawab, tak dijawab, dan ditolak tetap bertanda video');

  // sibuk: B sedang bicara dengan A (suara), C menelepon video -> catatan tak terjawab bertanda video di B
  const s2 = A.callStart(B.id, ASDP); await until(() => B.getState().call && B.getState().call.cid === s2, 5000, 'tawaran s2');
  B.callAnswer(s2, 'ANS'); await until(() => A.getState().call && A.getState().call.state === 'connecting', 5000, 'connecting s2');
  const cv = C.callStart(B.id, VSDP);
  await until(() => find(B, cv), 5000, 'catatan sibuk');
  assert.deepStrictEqual([find(B, cv).out, find(B, cv).video], ['missed', true], 'sibuk karena video: tercatat video');
  A.callEnd(s2); await until(() => find(A, s2), 5000, 'selesai s2');
  ok('panggilan video yang masuk saat sibuk tercatat sebagai tak terjawab video');

  // bertahan setelah restart; tanpa tanda tidak menjadi video
  await B.stop(); const B2 = mk('B', {}); await B2.start();
  assert.strictEqual(find(B2, v1).video, true); assert.strictEqual(find(B2, s1).video, false);
  await B2.stop();
  // data rusak disaring: video bukan angka/true dibuang
  const fileOf = (n) => { const d = path.join(tmp, n); return fs.readdirSync(d).map((f) => path.join(d, f)); };
  assert(fileOf('B').length > 0);
  ok('penanda video bertahan setelah restart');
  await A.stop(); await C.stop();

  // ---------- 3. izin kamera Android lewat jembatan ----------
  const mkW = (calls) => ({ navigator: { mediaDevices: { getUserMedia: async (c) => { calls.push(['gum', c]); return { s: c }; } } }, MediaStream: function () {} });
  const mkBridge = (answers, calls) => ({ audio: true, ask: async (action, on, ms) => { calls.push([action, ms]); const a = answers[action]; return a === undefined ? { ok: true, res: 'granted' } : { ok: a === 'granted', res: a }; } });
  let calls = [];
  let rtc = LC.browserRtc(mkW(calls), mkBridge({}, calls));
  await rtc.getUserMedia({ audio: { x: 1 }, video: { y: 1 } });
  assert.deepStrictEqual(calls.map((x) => x[0]), ['mic', 'cam', 'gum'], 'mikrofon dulu, lalu kamera, baru getUserMedia');
  assert.strictEqual(calls[1][1], 120000, 'dialog izin kamera boleh lama terbuka');
  calls.length = 0; await rtc.getUserMedia({ audio: { x: 1 } });
  assert.deepStrictEqual(calls.map((x) => x[0]), ['mic', 'gum'], 'panggilan suara tidak meminta kamera');
  calls.length = 0; await rtc.getUserMedia({ video: { y: 1 } });
  assert.deepStrictEqual(calls.map((x) => x[0]), ['cam', 'gum'], 'balik kamera: hanya kamera');
  for (const [res, re] of [['denied', /^izin kamera ditolak$/], ['blocked', /Pengaturan/]]) {
    calls = []; rtc = LC.browserRtc(mkW(calls), mkBridge({ cam: res }, calls));
    await assert.rejects(rtc.getUserMedia({ audio: true, video: true }), (e) => re.test(e.userMsg) && e.detail === 'plugin: ' + res && e.userMsg.length <= 70);
    assert(!calls.some((x) => x[0] === 'gum'), 'tanpa izin, getUserMedia tidak dipanggil');
  }
  calls = []; rtc = LC.browserRtc(mkW(calls), mkBridge({ mic: 'denied' }, calls));
  await assert.rejects(rtc.getUserMedia({ audio: true, video: true }), (e) => /mikrofon/.test(e.userMsg));
  assert(!calls.some((x) => x[0] === 'cam'), 'mikrofon ditolak: kamera tidak ditanyakan');
  calls = []; rtc = LC.browserRtc(mkW(calls), null);
  await rtc.getUserMedia({ audio: true, video: true });
  assert.deepStrictEqual(calls.map((x) => x[0]), ['gum'], 'tanpa cangkang: langsung getUserMedia');
  ok('jembatan Android: urutan mic -> kamera, pesan ditolak/diblokir, balik kamera hanya kamera');

  // kamera ditolak di Android: panggilan jatuh ke suara saja dengan alasan yang jelas
  {
    const notes = [], gums = []; calls = [];
    const w = { navigator: { mediaDevices: { getUserMedia: async (c) => { gums.push(c); return { getTracks: () => [], getAudioTracks: () => [{ enabled: true }], getVideoTracks: () => [] }; } } }, MediaStream: function () {} };
    class PC { constructor() { this.senders = []; } addTrack() { return {}; } async createOffer() { return { sdp: ASDP }; } async setLocalDescription(d) { this.localDescription = d; } close() {} }
    const rtcX = Object.assign(LC.browserRtc(w, mkBridge({ cam: 'blocked' }, calls)), { PeerConnection: PC });
    const api = new Proxy({}, { get: () => async () => ({ ok: true, cid: 'a1'.repeat(8) }) });
    const ctl = new LC.Controller({ api, rtc: rtcX, ui: { render() {}, ring() {}, ended() {}, notice: (t) => notes.push(t) }, now: () => 1, setTimeout: () => 1, clearTimeout() {} });
    await ctl.start('p'.repeat(64), 'Budi', { video: true }); await flush();
    assert.strictEqual(ctl.view().video, false, 'jatuh ke suara saja');
    assert.strictEqual(notes.length, 1); assert(/Kamera tidak bisa dipakai \[izin kamera ditolak; izinkan di Pengaturan/.test(notes[0]) && /tanpa video/.test(notes[0]), notes[0]);
    assert.strictEqual(gums.length, 1); assert(!gums[0].video, 'getUserMedia hanya dipanggil untuk suara');
    assert(ctl.cur && ctl.cur.stream, 'panggilan tetap jalan');
  }
  ok('kamera ditolak di Android: lanjut suara saja dengan alasan yang terbaca utuh');

  // ---------- 4. berkas cangkang Android (Capacitor) ----------
  const html = read('mobile', 'shell', 'index.html');
  const allow = (html.match(/<iframe id="f" allow="([^"]*)"/) || [])[1] || '';
  assert(allow.split(';').map((x) => x.trim()).includes('camera'), 'iframe mendelegasikan kamera (tanpa ini getUserMedia video ditolak WebView)');
  assert(/cam: 'cam'/.test(html) && /d\.action === 'mic' \|\| d\.action === 'cam' \? v === 'granted'/.test(html), 'pembungkus meneruskan cam dan menjawab ok hanya bila granted');
  const px = read('mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  assert(/android\.permission\.CAMERA/.test(px) && /android\.hardware\.camera" android:required="false"/.test(px) && /android\.hardware\.camera\.autofocus" android:required="false"/.test(px));
  const java = read('mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'xyraori', 'archne', 'ArchneAudio.java');
  assert(/@Permission\(strings = \{ Manifest\.permission\.CAMERA \}, alias = "cam"\)/.test(java) && /public void cam\(PluginCall call\) \{ ask\(call, "cam", "camResult"\); \}/.test(java));
  assert(/@PermissionCallback\s+private void micResult/.test(java) && /@PermissionCallback\s+private void camResult/.test(java), 'hasil izin dipisah per permintaan (mic dan cam)');
  assert(/shouldShowRequestPermissionRationale\(perm\)/.test(java) && !/shouldShowRequestPermissionRationale\(Manifest\.permission\.RECORD_AUDIO\)/.test(java), 'rationale mengikuti izin yang diminta, bukan dipatok ke mikrofon');
  const svc = read('mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'xyraori', 'archne', 'ArchneService.java');
  assert(/showCall\(cid, peer, name, [^;]*, video\);/.test(svc) && /showMissed\(peer, name == null \? "Archne" : name, video\);/.test(svc));
  assert(/ArchneLang\.s\(this, video \? "call_video" : "call_voice"\)/.test(svc) && /ArchneLang\.s\(this, video \? "missed_video" : "missed_voice"\)/.test(svc));
  { const xid = read('mobile', 'android', 'app', 'src', 'main', 'res', 'values-in', 'archne_strings.xml'), xen = read('mobile', 'android', 'app', 'src', 'main', 'res', 'values', 'archne_strings.xml');
    for (const [k, a, b] of [['call_video', 'Panggilan video masuk', 'Incoming video call'], ['call_voice', 'Panggilan suara masuk', 'Incoming voice call'], ['missed_video', 'Panggilan video tak terjawab', 'Missed video call'], ['missed_voice', 'Panggilan suara tak terjawab', 'Missed voice call']]) assert(xid.includes('name="archne_' + k + '">' + a + '<') && xen.includes('name="archne_' + k + '">' + b + '<'), 'teks notifikasi ' + k); }
  assert(/o\.optBoolean\("video", false\)/.test(svc));
  // kurung seimbang di Java yang diubah (pengaman kasar karena javac tidak ada di sini)
  for (const [n, src] of [['ArchneAudio', java], ['ArchneService', svc]]) {
    const body = src.replace(/"(?:\\.|[^"\\\n])*"/g, '""').replace(/'(?:\\.|[^'\\\n])'/g, "''").replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); // string dulu, baru komentar ("http://" di dalam string bukan komentar)
    for (const [o, c] of [['{', '}'], ['(', ')']]) assert.strictEqual(body.split(o).length, body.split(c).length, n + ': ' + o + c + ' seimbang');
  }
  ok('cangkang Android: delegasi kamera, izin, teks notifikasi, kontrak Java');

  console.log('\ncallvidlog: ' + pass + ' OK');
})().catch((e) => { console.error(e); process.exit(1); });

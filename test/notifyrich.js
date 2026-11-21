'use strict';
// Notifikasi kaya di Android (v0.15.0): foto profil pengirim/penelepon ikut di event SSE, tombol Balas / Tolak / Jawab terhubung ke fungsi yang ada,
// halaman induk meneruskan "Jawab" ke UI, dan UI hanya menjawab panggilan yang benar-benar sedang berdering.
// Yang TIDAK bisa dites di sini: Java (tidak ada Android SDK/JDK Android), tampilan notifikasi sungguhan. Lihat README.md bagian 6 (Manual tes).
const os = require('os'), path = require('path'), fs = require('fs'), http = require('http'), vm = require('vm'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { startHeadless } = require('../src/archne-headless');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-rich-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
// JPEG minimal yang sah secara struktur (sama dengan test/profile.js)
const jpeg = (w, h, pad = 300) => {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), sof, Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), crypto.randomBytes(pad), Buffer.from([0xff, 0xd9])]).toString('base64');
};
const sseEvents = (buf, name) => [...buf.matchAll(new RegExp('event: ' + name + '\\ndata: (.*)\\n\\n', 'g'))].map((m) => JSON.parse(m[1]));

(async () => {
  // ================= 1. event SSE: foto, pengirim, nama grup =================
  const app = await startHeadless({ dataDir: path.join(tmp, 'A'), downloadDir: path.join(tmp, 'dl'), name: 'A', host: '127.0.0.1', canOpenFolder: false, canNotify: true, discovery: false });
  const B = new Core({ dataDir: path.join(tmp, 'B'), name: 'B', discovery: false, callRingMs: 3000, tickMs: 100, syncMs: 150 }); await B.start();
  const C = new Core({ dataDir: path.join(tmp, 'C'), name: 'C', discovery: false, tickMs: 100, syncMs: 150 }); await C.start(); // tanpa foto
  await B.addPeer('127.0.0.1', app.core.port); await app.core.addPeer('127.0.0.1', B.port);
  await C.addPeer('127.0.0.1', app.core.port); await app.core.addPeer('127.0.0.1', C.port);
  const up = () => [B, C].every((x) => x.getState().peers.some((p) => p.online)) && app.core.getState().peers.filter((p) => p.online).length >= 2;
  await until(up, 10000, 'mesh');
  app.core.opts.syncMs = 150; // A menarik profil dari B tiap sinkronisasi berkala (bawaan 8 dtk); dipercepat khusus tes
  const photo = jpeg(128, 128);
  B.setAvatar(photo);
  await until(() => app.core.avatarOf(B.id) === photo, 20000, 'foto B tiba di A');

  let buf = '';
  const req = http.get({ host: '127.0.0.1', port: app.rpc.port, path: `/s/${app.rpc.token}/events` }, (res) => { res.setEncoding('utf8'); res.on('data', (d) => { buf += d; }); });
  await sleep(300);

  B.sendText('halo, ada foto?', app.core.id);
  await until(() => sseEvents(buf, 'notify').length >= 1, 8000, 'notify DM dari B');
  const n1 = sseEvents(buf, 'notify')[0];
  assert.strictEqual(n1.av, photo, 'foto pengirim ikut di event (base64 JPEG, tanpa awalan data URL)');
  assert.strictEqual(n1.from, B.id); assert.strictEqual(n1.who, 'B'); assert.strictEqual(n1.chat, ''); assert.strictEqual(n1.key, B.id);
  assert.strictEqual(n1.title, 'B'); assert.strictEqual(n1.text, 'halo, ada foto?', 'title/text lama tetap ada');
  ok('DM: event notify membawa foto, id dan nama pengirim (kunci chat = id pengirim, dipakai tombol Balas)');

  C.sendText('dari yang tanpa foto', app.core.id);
  await until(() => sseEvents(buf, 'notify').length >= 2, 8000, 'notify DM dari C');
  const n2 = sseEvents(buf, 'notify')[1];
  assert.strictEqual(n2.av, '', 'tanpa foto: string kosong (layanan Java membuat lingkaran berhuruf)'); assert.strictEqual(n2.who, 'C');
  ok('pengirim tanpa foto: av kosong');

  const gid = B.createGroup('Tim Rumah', [app.core.id]).id, G = 'g:' + gid;
  await until(() => app.core.getState().groups.some((g) => g.id === gid), 8000, 'grup tiba');
  B.sendText('rapat jam 3', G);
  await until(() => sseEvents(buf, 'notify').length >= 3, 8000, 'notify grup');
  const n3 = sseEvents(buf, 'notify')[2];
  assert.strictEqual(n3.key, G); assert.strictEqual(n3.chat, 'Tim Rumah'); assert.strictEqual(n3.who, 'B'); assert.strictEqual(n3.from, B.id); assert.strictEqual(n3.av, photo);
  assert.strictEqual(n3.title, 'Tim Rumah · B', 'title lama tidak berubah');
  ok('grup: nama grup di chat, pengirim di who/from/av, kunci = g:<id> (sasaran Balas)');

  // ================= 2. panggilan masuk membawa foto penelepon =================
  const cid = B.callStart(app.core.id, 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n');
  await until(() => sseEvents(buf, 'call').some((e) => e.ev === 'incoming'), 8000, 'panggilan masuk');
  const inc = sseEvents(buf, 'call').find((e) => e.ev === 'incoming');
  assert.strictEqual(inc.cid, cid); assert.strictEqual(inc.peer, B.id); assert.strictEqual(inc.name, 'B'); assert.strictEqual(inc.av, photo, 'foto penelepon ikut di event incoming');
  assert(typeof inc.sdp === 'string' && inc.sdp.length > 0, 'sdp tetap ada (UI memakainya)');
  // Tolak dari notifikasi = POST /rpc/callReject [cid] (persis yang dikirim ArchneService.decline)
  const rpc = (name, args) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port: app.rpc.port, path: `/s/${app.rpc.token}/rpc/${name}`, method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res({ code: r.statusCode, body: d })); }); q.on('error', rej); q.end(JSON.stringify(args)); });
  const rj = await rpc('callReject', [cid]);
  assert.strictEqual(rj.code, 200); assert(rj.body.startsWith('{"ok":true'), 'balasan callReject: ' + rj.body);
  await until(() => sseEvents(buf, 'call').some((e) => e.ev === 'end' && e.cid === cid && e.reason === 'rejected'), 8000, 'panggilan berakhir ditolak');
  assert(app.core.getState().calls.some((r) => r.id === cid && r.out === 'rejected'), 'riwayat panggilan mencatat penolakan');
  ok('panggilan masuk: event incoming membawa foto; Tolak lewat /rpc/callReject mengakhiri panggilan dan tercatat');

  // Balas dari notifikasi = POST /rpc/send [teks, kunciChat] (persis yang dikirim ArchneService.reply); true = berhasil
  const hasMsg = (text) => B.getState().messages.some((m) => m.text === text && m.from === app.core.id); // DM terenkripsi: teks terbaca lewat getState
  const r1 = await rpc('send', ['balasan dari notifikasi', B.id]);
  assert.strictEqual(r1.code, 200); assert.strictEqual(r1.body, 'true', 'send mengembalikan true (Java membaca ini sebagai berhasil)');
  await until(() => hasMsg('balasan dari notifikasi'), 8000, 'B menerima balasan');
  const r2 = await rpc('send', ['ke grup dari notifikasi', G]);
  assert.strictEqual(r2.body, 'true');
  await until(() => hasMsg('ke grup dari notifikasi'), 8000, 'B menerima balasan grup');
  const r3 = await rpc('send', ['x'.repeat(100000), B.id]);
  assert(r3.code === 200 && r3.body !== 'true' && /^"/.test(r3.body), 'teks terlalu panjang: balasan berupa string galat (Java menampilkannya sebagai "Tidak terkirim")');
  ok('Balas lewat /rpc/send: DM dan grup sampai; galat dikembalikan sebagai string');

  req.destroy(); await app.stop(); await B.stop(); await C.stop();

  // ================= 3. kontrak berkas Java / plugin / build =================
  const svc = read('mobile/android/app/src/main/java/com/xyraori/archne/ArchneService.java');
  const rcv = read('mobile/android/app/src/main/java/com/xyraori/archne/ArchneReceiver.java');
  const bg = read('mobile/android/app/src/main/java/com/xyraori/archne/ArchneBackground.java');
  const px = read('mobile/android/app/src/main/AndroidManifest.xml');
  const ipc = read('src/archne-ipc.js');
  assert(/MessagingStyle/.test(svc) && /setLargeIcon\(/.test(svc) && /Icon\.createWithBitmap/.test(svc) && /BitmapShader/.test(svc), 'gaya percakapan dengan foto bulat');
  assert(/RemoteInput\.Builder\(KEY_REPLY\)/.test(svc) && /ArchneLang\.s\(c, "reply"\)/.test(svc) && /ArchneLang\.s\(c, "mark_read"\)/.test(svc) && /ArchneLang\.s\(this, "decline"\)/.test(svc) && /ArchneLang\.s\(this, "answer"\)/.test(svc), 'tombol Balas, Tandai dibaca, Tolak, Jawab (lewat ArchneLang, bukan teks tetap)');
  { const xid = read('mobile/android/app/src/main/res/values-in/archne_strings.xml'), xen = read('mobile/android/app/src/main/res/values/archne_strings.xml');
    for (const [k, a, b] of [['reply', 'Balas', 'Reply'], ['mark_read', 'Tandai dibaca', 'Mark as read'], ['decline', 'Tolak', 'Decline'], ['answer', 'Jawab', 'Answer']]) assert(xid.includes('name="archne_' + k + '">' + a + '<') && xen.includes('name="archne_' + k + '">' + b + '<'), 'teks tombol ' + k + ' (id + en)'); }
  assert(/FLAG_MUTABLE/.test(svc), 'PendingIntent balasan langsung harus mutable (Android 12+)');
  assert(/new Intent\(c, ArchneReceiver\.class\)/.test(svc), 'PendingIntent ke receiver eksplisit (wajib untuk mutable di Android 14)');
  for (const name of [...svc.matchAll(/rpc\(ctx, "(\w+)"/g)].map((m) => m[1])) assert(new RegExp("h\\('" + name + "'").test(ipc), 'rpc("' + name + '") ada di archne-ipc.js');
  assert.deepStrictEqual([...svc.matchAll(/rpc\(ctx, "(\w+)"/g)].map((m) => m[1]).sort(), ['callReject', 'send'], 'layanan hanya memanggil send dan callReject');
  assert(/rpc\(ctx, "send", new JSONArray\(\)\.put\(text\)\.put\(key\)/.test(svc) && /rpc\(ctx, "callReject", new JSONArray\(\)\.put\(cid\)/.test(svc), 'urutan argumen sesuai (teks, ke) dan (cid)');
  assert(/EXTRA_ANSWER/.test(svc) && /openApp\(this, peer, cid, ID_CALL \+ 2\)/.test(svc), 'Jawab membuka aplikasi dengan id panggilan');
  assert(/o\.optString\("who"/.test(svc) && /o\.optString\("chat"/.test(svc) && /o\.optString\("from"/.test(svc) && /o\.optLong\("ts"/.test(svc) && /o\.has\("av"\)/.test(svc), 'membaca bidang baru dari event');
  assert(/@PluginMethod\s+public void takeAnswer\(PluginCall/.test(bg) && /EXTRA_ANSWER/.test(bg), 'plugin: takeAnswer');
  assert(/<receiver android:name="com\.xyraori\.archne\.ArchneReceiver" android:exported="false" \/>/.test(px), 'receiver terdaftar dan tidak diekspor');
  assert(fs.existsSync(path.join(root, 'mobile/android/app/src/main/res/drawable/ic_stat_archne.xml')), 'ikon kecil notifikasi ada di res/drawable');
  assert(/ACTION_READ/.test(rcv) && /ACTION_REPLY/.test(rcv) && /ACTION_DECLINE/.test(rcv) && /goAsync\(\)/.test(rcv) && /RemoteInput\.getResultsFromIntent/.test(rcv), 'receiver: tiga aksi, kerja jaringan di luar utas utama');
  for (const [name, code] of [['ArchneService', svc], ['ArchneReceiver', rcv], ['ArchneBackground', bg]]) {
    const bare = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])+'/g, '');
    for (const [o, c] of [['{', '}'], ['(', ')'], ['[', ']']]) assert.strictEqual(bare.split(o).length, bare.split(c).length, name + ': ' + o + c + ' tidak seimbang');
  }
  const known = new Set(['USAGE_NOTIFICATION_RINGTONE', 'CONTENT_TYPE_SONIFICATION']);
  for (const m of svc.matchAll(/AudioAttributes\.((?:USAGE|CONTENT_TYPE)_\w+)/g)) assert(known.has(m[1]), 'konstanta AudioAttributes tidak dikenal: ' + m[1]);
  // v0.15.1: notifikasi layanan minimal
  const og = /private Notification ongoing\(\) \{[\s\S]*?\n  \}\n/.exec(svc);
  assert(og, 'ongoing() ditemukan');
  assert(!/addAction/.test(og[0]) && !/Berhenti/.test(svc) && !/ACTION_STOP|com\.xyraori\.archne\.STOP/.test(svc), 'notifikasi layanan tanpa tombol dan tanpa jalur STOP');
  assert(/smallIcon\(this\)/.test(og[0]) && !/stat_notify_chat\)\s*\n/.test(og[0]), 'notifikasi layanan memakai ikon Archne');
  assert(/VISIBILITY_SECRET/.test(og[0]) && /CATEGORY_SERVICE/.test(og[0]) && /setOngoing\(true\)/.test(og[0]) && /setOnlyAlertOnce\(true\)/.test(og[0]), 'ongoing, kategori layanan, tersembunyi di layar kunci, tanpa bunyi berulang');
  const ch = /NotificationChannel a = new NotificationChannel\(CH_SVC[\s\S]*?createNotificationChannel\(a\);/.exec(svc);
  assert(ch && /IMPORTANCE_MIN/.test(ch[0]) && /setSound\(null, null\)/.test(ch[0]) && /enableVibration\(false\)/.test(ch[0]) && /enableLights\(false\)/.test(ch[0]) && /setShowBadge\(false\)/.test(ch[0]) && /setLockscreenVisibility\(Notification\.VISIBILITY_SECRET\)/.test(ch[0]), 'channel layanan: prioritas minimum, senyap, tanpa badge, tersembunyi di layar kunci');
  ok('notifikasi layanan minimal: tanpa tombol Berhenti, channel MIN senyap dan tersembunyi, ikon Archne');
  ok('kontrak Java/plugin: gaya percakapan + foto, Balas/Tandai dibaca/Tolak/Jawab, PendingIntent mutable+eksplisit, rpc ke fungsi yang ada, receiver terdaftar, kurung seimbang');

  // ================= 4. versi =================
  const ver = JSON.parse(read('package.json')).version, avr = JSON.parse(read('mobile/package.json')).version;
  const gr = read('mobile/android/app/build.gradle');
  const cv = /versionCode (\d+)\s+versionName "([^"]+)"/.exec(gr);
  assert(cv, 'versionCode/versionName di build.gradle');
  assert.strictEqual(avr, ver); assert.strictEqual(cv[2], ver);
  const [a, b, c] = ver.split('.').map(Number);
  assert.strictEqual(Number(cv[1]), a * 10000 + b * 100 + c, 'versionCode = mayor*10000 + minor*100 + patch (0.12.1 -> 1201)');
  assert(a > 0 || b >= 15, 'rilis ini minimal 0.15.0');
  ok('versi sama di package.json, mobile/package.json, build.gradle (' + ver + ', versionCode ' + cv[1] + ')');

  // ================= 5. halaman pembungkus meneruskan "Jawab" ke UI =================
  {
    const { env } = require('./_mobilewrap');
    const ORIGIN = 'http://127.0.0.1:4321';
    const run = async (taken) => {
      const e = await env((p, act) => (act === 'takeChat' ? { key: taken.takeChat || '' } : act === 'takeAnswer' ? { cid: taken.takeAnswer || '' } : { value: 'ok' }));
      e.frame.onload(); for (const t of e.timers) if (t.ms === 900) t.f(); await e.flush();
      return e;
    };
    const e1 = await run({ takeChat: 'abcdef0123456789', takeAnswer: 'cid1234567890' });
    assert(e1.calls.some((c) => c.act === 'takeChat') && e1.calls.some((c) => c.act === 'takeAnswer'));
    assert.deepStrictEqual(e1.sent().filter((x) => x[0].archne === 'open-chat'), [[{ archne: 'open-chat', key: 'abcdef0123456789' }, ORIGIN]]);
    assert.deepStrictEqual(e1.sent().filter((x) => x[0].archne === 'answer-call'), [[{ archne: 'answer-call', cid: 'cid1234567890' }, ORIGIN]], 'Jawab diteruskan ke iframe, hanya ke origin-nya');
    // Dikirim ulang tiap 700 ms sampai UI mengaku sudah menjawab (UI bisa sedang dimuat ulang saat Jawab ditekan)
    const iv = e1.intervals.filter((x) => x.ms === 700 && !x.dead);
    assert.strictEqual(iv.length, 1, 'satu interval kirim ulang answer-call');
    iv[0].f(); iv[0].f();
    assert.strictEqual(e1.sent().filter((x) => x[0].archne === 'answer-call').length, 3, 'dikirim ulang selama belum ada konfirmasi');
    await e1.post({ archne: 'answer-done' });
    assert(e1.intervals.filter((x) => x.ms === 700)[0].dead === true, 'answer-done menghentikan kirim ulang');
    const n3 = e1.sent().filter((x) => x[0].archne === 'answer-call').length;
    iv[0].f(); assert.strictEqual(e1.sent().filter((x) => x[0].archne === 'answer-call').length, n3, 'tidak ada kiriman setelah dihentikan');
    const e2 = await run({});
    assert.strictEqual(e2.sent().filter((x) => x[0].archne === 'answer-call' || x[0].archne === 'open-chat').length, 0, 'tanpa ketukan notifikasi: tidak ada pesan');
    ok('halaman pembungkus: takeAnswer diteruskan sebagai answer-call ke iframe; tanpa ketukan tidak ada yang dikirim');
  }

  // ================= 6. UI hanya menjawab panggilan yang sedang berdering =================
  {
    const ui = require('./_src').htmlSrc();
    assert(/d\.archne === 'answer-call' && typeof d\.cid === 'string'/.test(ui) && /e\.source !== window\.parent/.test(ui), 'pesan answer-call hanya dari induk dan bertipe string');
    assert(/callCtl\.sync\(S\.call(, S\.vc(, [^;]*)?)?\); tryAnswer\(\)/.test(ui), 'dicoba lagi tiap sinkronisasi (halaman baru dimuat)');
    const fn = /let wantAnswer = null, answeredCid = null;\nfunction tellAnswerDone\(\)[^\n]*\nfunction tryAnswer\(\) \{[\s\S]*?\n\}\n/.exec(ui)[0];
    const mk = (cur) => { const ctx = { Date, accepted: 0, callCtl: { cur, accept() { ctx.accepted++; } } }; vm.createContext(ctx); vm.runInContext(fn, ctx); return ctx; };
    const ring = () => ({ cid: 'c1', dir: 'in', phase: 'ringing' });
    let x = mk(ring()); vm.runInContext('tryAnswer()', x); assert.strictEqual(x.accepted, 0, 'tanpa permintaan: tidak menjawab');
    x = mk(ring()); vm.runInContext("wantAnswer = { cid: 'c1', until: Date.now() + 5000 }; tryAnswer(); tryAnswer();", x); assert.strictEqual(x.accepted, 1, 'berdering dan cocok: menjawab tepat sekali');
    x = mk(ring()); vm.runInContext("wantAnswer = { cid: 'lain', until: Date.now() + 5000 }; tryAnswer();", x); assert.strictEqual(x.accepted, 0, 'id lain: tidak menjawab');
    x = mk({ cid: 'c1', dir: 'in', phase: 'active' }); vm.runInContext("wantAnswer = { cid: 'c1', until: Date.now() + 5000 }; tryAnswer();", x); assert.strictEqual(x.accepted, 0, 'sudah aktif: tidak menjawab lagi');
    x = mk({ cid: 'c1', dir: 'out', phase: 'dialing' }); vm.runInContext("wantAnswer = { cid: 'c1', until: Date.now() + 5000 }; tryAnswer();", x); assert.strictEqual(x.accepted, 0, 'panggilan keluar: tidak menjawab');
    x = mk(ring()); vm.runInContext("wantAnswer = { cid: 'c1', until: Date.now() - 1 }; tryAnswer();", x); assert.strictEqual(x.accepted, 0, 'kedaluwarsa (15 dtk): tidak menjawab'); assert.strictEqual(vm.runInContext('wantAnswer', x), null);
    x = mk(null); vm.runInContext("wantAnswer = { cid: 'c1', until: Date.now() + 5000 }; tryAnswer();", x); assert.strictEqual(x.accepted, 0); assert.notStrictEqual(vm.runInContext('wantAnswer', x), null, 'belum ada panggilan: tetap menunggu sinkronisasi berikutnya');
    ok('UI: menjawab hanya panggilan masuk yang cocok dan sedang berdering, sekali saja, dan kedaluwarsa setelah 15 dtk');
  }

  console.log('\n' + pass + ' tes notifikasi kaya OK');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

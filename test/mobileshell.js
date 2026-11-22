'use strict';
// Tes cangkang Android baru (Fase 2C): mobile/shell/main.js (Node, dengan 'bridge' palsu + Core sungguhan) dan
// mobile/shell/index.html (halaman pembungkus, dijalankan di vm dengan Capacitor palsu). Java/WebView tidak bisa dites di sini.
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), assert = require('assert'), Module = require('module');
const root = path.join(__dirname, '..');
const shell = (f) => path.join(root, 'mobile', 'shell', f);
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const same = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m); // objek dari vm beda realm: bandingkan lewat JSON
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- bagian 1: halaman pembungkus ----------
function loadWrapper(infoRet0) {
  const infoRet = { v: infoRet0 };
  const html = fs.readFileSync(shell('index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const src = scripts[scripts.length - 1];
  assert(!/cordova/i.test(html), 'pembungkus tidak menyebut cordova');
  const calls = [], listeners = {}, sent = [], timers = [], intervals = [], pipOn = { v: false };
  const frameWin = { posted: [], postMessage(m, o) { frameWin.posted.push([m, o]); } };
  const frame = { style: {}, contentWindow: frameWin, src: '' };
  const msg = { style: {}, textContent: '' };
  const plugins = {
    // Capacitor 8 sungguhan: addListener/send/start di plugin Node TIDAK mengembalikan Promise (galat nyata di HP: "addListener(...).catch is not a function")
    Nodejs: { addListener: (n, f) => { listeners[n] = f; return { remove() {} }; }, send: (o) => { sent.push(o); }, start: (o) => { calls.push(['Nodejs.start', o]); } },
    App: { addListener: (n, f) => { listeners['app:' + n] = f; return { remove() {} }; }, minimizeApp: () => { calls.push(['App.minimizeApp']); }, exitApp: () => { calls.push(['App.exitApp']); } },
    Browser: { open: async (o) => { calls.push(['Browser.open', o]); } },
    ArchneBackground: new Proxy({}, { get: (_, m) => async (a, f) => { calls.push(['ArchneBackground.' + m, a]); if (m === 'addListener') { listeners['bg:' + a] = f; return {}; } return m === 'info' ? (infoRet.v || { port: 0 }) : m === 'takeChat' ? { key: 'k1' } : m === 'batteryAsk' ? { value: 'ok' } : m === 'pipState' ? { on: pipOn.v } : {}; } }),
    ArchneDownloads: new Proxy({}, { get: (_, m) => async (a) => { calls.push(['ArchneDownloads.' + m, a]); if (m === 'save') return { name: 'x (1).png' }; if (m === 'access') return { value: 'ok' }; if (m === 'pick') return { paths: ['/data/a', 7] }; return {}; } }),
  };
  const winListeners = [];
  const ls = {};
  const ctx = {
    console, Promise, JSON, Array, String, Number, isFinite, RegExp, Object, setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout() {},
    setInterval: (f, ms) => { intervals.push({ f, ms }); return intervals.length; }, clearInterval(i) { if (intervals[i - 1]) intervals[i - 1].dead = true; },
    document: { getElementById: (id) => (id === 'f' ? frame : msg), documentElement: {}, write() {} },
    localStorage: { getItem: (k) => ls[k] || null, setItem: (k, v) => { ls[k] = v; }, removeItem: (k) => { delete ls[k]; } },
    window: null,
  };
  ctx.window = ctx;
  ctx.Capacitor = { Plugins: plugins, registerPlugin: () => null };
  const winEvents = {};
  ctx.addEventListener = (t, f) => { if (t === 'message') winListeners.push(f); else (winEvents[t] = winEvents[t] || []).push(f); };
  ctx.open = (u, t) => calls.push(['window.open', u, t]);
  vm.createContext(ctx); vm.runInContext(src, ctx);
  const fromFrame = (d, origin = 'http://127.0.0.1:5555', source = frameWin) => { for (const f of winListeners) f({ data: d, origin, source }); };
  return { frame, frameWin, msg, calls, listeners, sent, timers, intervals, fromFrame, ls, html, pipOn, winEvents };
}
const flush = () => new Promise((r) => setImmediate(r));
const runTimersOnce = async (w) => { const t = w.timers.splice(0); for (const x of t) x.f(); await flush(); await flush(); };

(async () => {
  {
    // buka ulang selagi layanan latar depan dan inti Node masih hidup: plugin Node baru tidak pernah 'ready' (send ditolak),
    // jadi port/token diambil dari ArchneBackground.info; Node tidak dimulai lagi dan iframe langsung dimuat
    const w = loadWrapper({ port: 6001, token: 'live', lang: 'id', dxout: '/data/dx2' });
    await flush(); await flush();
    assert.strictEqual(w.frame.src, 'http://127.0.0.1:6001/s/live/'); ok('buka ulang: iframe dimuat dari info layanan, tanpa menunggu hello');
    assert.strictEqual(w.calls.filter((c) => c[0] === 'Nodejs.start').length, 0); ok('buka ulang: Node tidak dimulai kedua kali');
    same(w.calls.find((c) => c[0] === 'ArchneBackground.start')[1], { port: 6001, token: 'live', lang: 'id', dxout: '/data/dx2' }); ok('buka ulang: layanan latar diperbarui dengan data yang sama');
    w.intervals[0].f(); await flush(); assert.strictEqual(w.sent.length, 0); ok('buka ulang: tidak ada hello yang menggantung');
    const w2 = loadWrapper({ port: 0 }); await flush(); await flush();
    assert.strictEqual(w2.calls.filter((c) => c[0] === 'Nodejs.start').length, 1); assert.strictEqual(w2.frame.src, ''); ok('info port 0 -> mulai Node, tunggu ready');
  }
  {
    const w = loadWrapper();
    // kamus bahasa: kunci en == id
    const W = /var W = (\{[\s\S]*?\n  \});\n  var lang/.exec(w.html);
    assert(W, 'kamus W ditemukan');
    const dict = vm.runInNewContext('(' + W[1] + ')');
    assert.deepStrictEqual(Object.keys(dict.en).sort(), Object.keys(dict.id).sort(), 'kunci en == id'); ok('kamus W: kunci en == id');
    assert(/frame-src http:\/\/127\.0\.0\.1:\*/.test(w.html) && /connect-src 'self' http:\/\/127\.0\.0\.1:\*/.test(w.html), 'CSP'); ok('CSP: frame-src dan connect-src 127.0.0.1');
    // handshake: tanya hello tiap detik, sampai ready
    assert.strictEqual(w.intervals.length, 1, 'satu interval hello'); assert.strictEqual(w.intervals[0].ms, 1000);
    w.intervals[0].f(); await flush();
    same(w.sent[0], { eventName: 'archne:hello', args: ['hi'] }); ok('hello dikirim sebagai archne:hello');
    // ready dari Node
    w.listeners.message({ eventName: 'archne:ready', args: [{ port: 5555, token: 'tok', dxout: '/data/dx', lang: 'id' }] }); await flush();
    assert.strictEqual(w.frame.src, 'http://127.0.0.1:5555/s/tok/'); ok('archne:ready memuat iframe /s/<token>/');
    const bg = w.calls.find((c) => c[0] === 'ArchneBackground.start');
    same(bg[1], { port: 5555, token: 'tok', lang: 'id', dxout: '/data/dx' }); ok('ArchneBackground.start dipanggil dengan port, token, bahasa, dxout');
    assert.strictEqual(w.ls['lc.lang'], 'id'); ok('bahasa disimpan di localStorage');
    w.intervals[0].f(); assert.strictEqual(w.sent.length, 1, 'tidak ada hello lagi setelah ready'); ok('hello berhenti setelah ready');
    // Node dimulai manual, sekali, hanya bila layanan latar depan belum punya port/token
    assert(w.calls.some((c) => c[0] === 'ArchneBackground.info'), 'info ditanyakan'); assert.strictEqual(w.calls.filter((c) => c[0] === 'Nodejs.start').length, 1); ok('boot dingin: info kosong -> Node.start sekali');
    // pesan dari iframe: sumber/origin salah ditolak
    const n0 = w.calls.length;
    w.fromFrame({ archne: 'native', action: 'weburl', url: 'https://example.com/' }, 'http://evil', w.frameWin);
    w.fromFrame({ archne: 'native', action: 'weburl', url: 'https://example.com/' }, 'http://127.0.0.1:5555', {});
    await flush(); assert.strictEqual(w.calls.length, n0); ok('origin/sumber salah ditolak');
    // weburl: hanya http(s) <= 2048
    w.fromFrame({ archne: 'native', action: 'weburl', url: 'javascript:alert(1)' });
    w.fromFrame({ archne: 'native', action: 'weburl', url: 'https://example.com/' + 'a'.repeat(2100) });
    w.fromFrame({ archne: 'native', action: 'weburl', url: 'https://example.com/ok' }); await flush();
    const br = w.calls.filter((c) => c[0] === 'Browser.open'); assert.strictEqual(br.length, 1); same(br[0][1], { url: 'https://example.com/ok' }); ok('weburl: validasi skema/panjang, Browser.open');
    // bahasa dari UI
    w.fromFrame({ archne: 'native', action: 'lang', lang: 'en' }); await flush();
    assert(w.calls.some((c) => c[0] === 'ArchneBackground.setLang' && c[1].lang === 'en')); ok('ganti bahasa -> ArchneBackground.setLang');
    // dxpick
    w.fromFrame({ archne: 'native', action: 'dxpick', id: 3, job: 'j-1' }); await flush(); await flush();
    const pick = w.frameWin.posted.map((p) => p[0]).find((m) => m.archne === 'native-pick');
    assert(pick && pick.ok && pick.id === 3 && pick.paths.length === 1 && pick.paths[0] === '/data/a'); ok('dxpick: access -> pick, hanya path string');
    // berkas tersimpan
    w.listeners.message({ eventName: 'archne:saved', args: [{ path: '/data/user/0/x/a.png', name: 'a.png' }] }); await flush(); await flush();
    const sv = w.calls.find((c) => c[0] === 'ArchneDownloads.save'); assert.strictEqual(sv[1].mime, 'image/png');
    assert(w.frameWin.posted.some((p) => p[0].archne === 'native-saved' && p[0].name === 'x (1).png')); ok('archne:saved -> ArchneDownloads.save -> native-saved');
    w.listeners.message({ eventName: 'archne:saved', args: [{ path: '/etc/passwd', name: 'p' }] }); await flush();
    assert.strictEqual(w.calls.filter((c) => c[0] === 'ArchneDownloads.save').length, 1); ok('path di luar /data/ dan /storage/ ditolak');
    // impor arsip Halaman: Node minta pemilih berkas satu berkas, jalurnya dikirim balik
    const sn = w.sent.length;
    w.listeners.message({ eventName: 'archne:arcpick', args: [{ job: 'arcimp' }] }); await flush(); await flush();
    const ap = w.calls.filter((c) => c[0] === 'ArchneDownloads.pick').pop(); assert(ap && ap[1].job === 'arcimp' && ap[1].multiple === false && ap[1].root === '/data/dx');
    same(w.sent[sn], { eventName: 'archne:arcpicked', args: [{ path: '/data/a' }] }); ok('archne:arcpick -> pemilih satu berkas -> archne:arcpicked');
    // tombol Kembali: UI dulu, lalu riwayat, terakhir aplikasi disembunyikan (bukan ditutup)
    assert.strictEqual(typeof w.listeners['app:backButton'], 'function');
    const backMsgs = () => w.frameWin.posted.map((p) => p[0]).filter((m) => m.archne === 'native-app' && m.state === 'back');
    const mini = () => w.calls.filter((c) => c[0] === 'App.minimizeApp').length;
    w.listeners['app:backButton']({ canGoBack: false }); await flush();
    assert.strictEqual(backMsgs().length, 1); const bid = backMsgs()[0].id;
    w.fromFrame({ archne: 'native', action: 'back-result', id: bid, on: true }); await flush();
    assert.strictEqual(mini(), 0); ok('Kembali: UI menangani (dialog / panggilan) -> aplikasi tetap');
    w.listeners['app:backButton']({ canGoBack: false }); await flush();
    w.fromFrame({ archne: 'native', action: 'back-result', id: backMsgs()[1].id, on: false }); await flush();
    assert.strictEqual(mini(), 1); ok('Kembali di dasar: aplikasi disembunyikan (minimizeApp), layanan latar tetap hidup');
    w.listeners['app:backButton']({ canGoBack: false }); await flush(); await runTimersOnce(w);
    assert.strictEqual(mini(), 2); ok('Kembali: UI tidak menjawab -> jatuh ke minimizeApp');
    w.fromFrame({ archne: 'native', action: 'back-result', id: 999, on: true }, 'http://evil', w.frameWin); // asal lain diabaikan
    w.listeners['app:backButton']({ canGoBack: true }); await flush();
    w.fromFrame({ archne: 'native', action: 'back-result', id: 999, on: true }); await flush(); // id salah diabaikan
    ok('jawaban Kembali dengan id salah / asal lain diabaikan');
    await runTimersOnce(w); // tanpa jawaban sah: canGoBack true -> history.back (tidak melempar)
    // pause/resume
    const bgPosts = () => w.frameWin.posted.filter((p) => p[0].archne === 'native-app' && p[0].state === 'background').length;
    const runTimers = async () => { const t = w.timers.splice(0); for (const x of t) x.f(); await flush(); await flush(); };
    await runTimers(); // timer lain yang menunggu (mis. ketukan notifikasi) dibersihkan
    w.listeners['app:pause'](); await runTimers(); assert.strictEqual(bgPosts(), 1); ok('pause -> (jeda singkat, PiP tidak aktif) native-app background');
    // masuk PiP: pause datang tetapi aplikasi masih tampil, jadi background tidak dilaporkan
    w.pipOn.v = true; w.listeners['app:pause'](); await runTimers(); assert.strictEqual(bgPosts(), 1, 'tidak bertambah'); ok('pause saat PiP aktif -> tidak dilaporkan ke latar belakang');
    // kembali sebelum jeda habis: tidak ada laporan
    w.pipOn.v = false; w.listeners['app:pause'](); w.listeners['app:resume'](); await runTimers(); assert.strictEqual(bgPosts(), 1); ok('pause lalu resume cepat -> tidak ada laporan latar belakang');
    // kejadian pip dari plugin diteruskan ke UI; PiP ditutup (X) TIDAK dianggap latar belakang (kamera dibiarkan)
    assert.strictEqual(typeof w.listeners['bg:pip'], 'function'); w.listeners['bg:pip']({ on: true });
    assert(w.frameWin.posted.some((p) => p[0].archne === 'native-app' && p[0].state === 'pip' && p[0].on === true)); ok('kejadian pip (on) -> native-app pip');
    w.listeners['app:pause'](); w.pipOn.v = true; await runTimers(); w.pipOn.v = false; w.listeners['bg:pip']({ on: false }); await runTimers();
    assert(w.frameWin.posted.some((p) => p[0].archne === 'native-app' && p[0].state === 'pip' && p[0].on === false)); assert.strictEqual(bgPosts(), 1, 'tidak bertambah'); ok('PiP ditutup (X) -> hanya native-app pip off, TIDAK dilaporkan ke latar belakang');
    // jalur kedua (kejadian window 'archnepip' dari MainActivity): sama hasilnya, kabar ganda dibuang
    assert.strictEqual(w.winEvents.archnepip.length, 1);
    const pipPosts = (on) => w.frameWin.posted.filter((p) => p[0].archne === 'native-app' && p[0].state === 'pip' && p[0].on === on).length;
    const n1 = pipPosts(true);
    w.winEvents.archnepip[0]({ on: true }); assert.strictEqual(pipPosts(true), n1 + 1, 'kejadian window -> native-app pip on');
    w.listeners['bg:pip']({ on: true }); w.winEvents.archnepip[0]({ on: true }); assert.strictEqual(pipPosts(true), n1 + 1, 'kabar ganda (dua jalur) dibuang');
    w.winEvents.archnepip[0]({ on: false }); w.listeners['bg:pip']({ on: false }); assert.strictEqual(pipPosts(false), 2, 'off sekali per perubahan'); ok('PiP lewat dua jalur (plugin + kejadian window): satu kabar per perubahan');
    // siaga PiP dari UI -> plugin; hanya dari iframe kita
    w.fromFrame({ archne: 'native', action: 'pip', id: 0, on: true }); await flush();
    same(w.calls.filter((c) => c[0] === 'ArchneBackground.pip').pop()[1], { on: true }); ok('aksi pip dari UI -> ArchneBackground.pip');
    const nPip = w.calls.filter((c) => c[0] === 'ArchneBackground.pip').length;
    w.fromFrame({ archne: 'native', action: 'pip', id: 0, on: true }, 'http://evil.example', {}); await flush();
    assert.strictEqual(w.calls.filter((c) => c[0] === 'ArchneBackground.pip').length, nPip); ok('aksi pip dari sumber lain diabaikan')
  }
  {
    // plugin lokal belum ada (2C.7): UI tetap tampil, audio dijawab gagal 'noplugin'
    const w = loadWrapper();
    w.listeners.message({ eventName: 'archne:ready', args: [{ port: 5555, token: 't', lang: 'en' }] }); await flush();
    assert.strictEqual(w.frame.src, 'http://127.0.0.1:5555/s/t/'); ok('ready tanpa dxout tetap memuat UI');
    w.listeners.message({ eventName: 'archne:fatal', args: ['boom'] }); assert(/boom/.test(w.msg.textContent) && w.msg.style.display === 'block'); ok('archne:fatal menampilkan galat');
  }

  // ---------- bagian 2: main.js Node dengan bridge palsu ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-mshell-'));
  fs.cpSync(shell('main.js'), path.join(tmp, 'main.js'));
  fs.symlinkSync(path.join(root, 'src'), path.join(tmp, 'src'), 'junction');
  fs.symlinkSync(path.join(root, 'renderer'), path.join(tmp, 'renderer'), 'junction');
  const posts = [], handlers = {};
  const bridge = { app: { datadir: () => path.join(tmp, 'data'), on() {} }, channel: { post: (ev, d) => posts.push([ev, d]), on: (ev, f) => { handlers[ev] = f; } } };
  const origResolve = Module._resolveFilename, origLoad = Module._load;
  Module._load = function (req, ...rest) { return req === 'bridge' ? bridge : origLoad.call(this, req, ...rest); };
  require(path.join(tmp, 'main.js'));
  for (let i = 0; i < 100 && !posts.some((p) => p[0] === 'archne:ready'); i++) await wait(100);
  const ready = posts.find((p) => p[0] === 'archne:ready');
  assert(ready, 'archne:ready diterima: ' + JSON.stringify(posts));
  assert(Number.isInteger(ready[1].port) && typeof ready[1].token === 'string' && ready[1].token.length > 8 && /^(en|id)$/.test(ready[1].lang) && typeof ready[1].dxout === 'string'); ok('main.js: archne:ready membawa port, token, dxout, lang');
  assert(!posts.some((p) => p[0] === 'archne:fatal')); ok('main.js: tanpa archne:fatal');
  assert(typeof handlers['archne:hello'] === 'function'); ok('main.js: mendengarkan archne:hello');
  const n = posts.length; handlers['archne:hello']('hi');
  assert.strictEqual(posts.length, n + 1); assert.strictEqual(posts[n][0], 'archne:ready'); same(posts[n][1], ready[1]); ok('archne:hello dijawab ulang dengan port/token yang sama');
  assert(fs.existsSync(path.join(tmp, 'data', 'archne', 'logs', 'app.log')) || fs.existsSync(path.join(tmp, 'data', 'archne'))); ok('data ditulis di <datadir>/archne');
  // buka ulang HTTP: UI harus bisa diambil lewat /s/<token>/
  const http = require('http');
  const code = await new Promise((r) => http.get({ host: '127.0.0.1', port: ready[1].port, path: '/s/' + ready[1].token + '/' }, (res) => { res.resume(); r(res.statusCode); }).on('error', () => r(0)));
  assert(code === 200 || code === 302, 'HTTP /s/<token>/ = ' + code); ok('RPC HTTP melayani /s/<token>/ (' + code + ')');
  // cadangan Halaman di Android: tombol Ekspor / Impor tersedia, ekspor disalin ke Download, impor memakai pemilih berkas cangkang
  const rpcCall = (name, args) => new Promise((res, rej) => {
    const body = JSON.stringify(args || []);
    const rq = http.request({ host: '127.0.0.1', port: ready[1].port, method: 'POST', path: '/s/' + ready[1].token + '/rpc/' + name, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error('balasan bukan JSON: ' + d)); } }); });
    rq.on('error', rej); rq.end(body);
  });
  const gs = await rpcCall('getSettings'); assert.strictEqual(gs.canArchive, true, 'canArchive: ' + JSON.stringify(gs)); ok('Android: canArchive = true (tombol Ekspor / Impor muncul)');
  const ex = await rpcCall('pgArcExport', [{ comments: false }]); assert(ex.ok && ex.job && /^halaman-archne-\d{4}-\d\d-\d\d\.archpg$/.test(ex.name), 'ekspor: ' + JSON.stringify(ex));
  for (let i = 0; i < 100 && !posts.some((p) => p[0] === 'archne:saved'); i++) await wait(100);
  const sv = posts.find((p) => p[0] === 'archne:saved'); assert(sv, 'archne:saved setelah ekspor selesai');
  assert(sv[1].path.startsWith(path.join(tmp, 'data', 'archne', 'exports')) && sv[1].name === ex.name && fs.existsSync(sv[1].path), 'arsip ada di folder privat dan disalin ke Download'); ok('ekspor Halaman: arsip dibuat lalu diminta disalin ke Download');
  const opening = rpcCall('pgArcOpen');
  for (let i = 0; i < 50 && !posts.some((p) => p[0] === 'archne:arcpick'); i++) await wait(50);
  assert(posts.some((p) => p[0] === 'archne:arcpick'), 'Node meminta pemilih berkas'); assert(typeof handlers['archne:arcpicked'] === 'function');
  handlers['archne:arcpicked']({ path: sv[1].path });
  const op = await opening; assert(op.ok && op.token && op.name === ex.name, 'impor: ' + JSON.stringify(op)); ok('impor Halaman: pemilih berkas cangkang -> arsip terbaca');
  const opening2 = rpcCall('pgArcOpen');
  for (let i = 0; i < 50 && posts.filter((p) => p[0] === 'archne:arcpick').length < 2; i++) await wait(50);
  handlers['archne:arcpicked']({ path: '' });
  const op2 = await opening2; assert(op2.ok && op2.token === null, 'batal: ' + JSON.stringify(op2)); ok('impor Halaman: pemilih dibatalkan = tidak ada yang terjadi');
  Module._load = origLoad; Module._resolveFilename = origResolve;
  console.log('mobileshell: ' + pass + ' lulus');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

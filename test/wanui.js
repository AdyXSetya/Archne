'use strict';
// Tes UI lintas jaringan (v0.23.0): tombol ikon di sebelah gear, kartu undangan archne://join di chat ("Tambah"),
// daftar undangan di dialog, pindah jaringan dua ketukan. Skrip asli di vm dengan DOM tiruan (seperti test/setui.js).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const ME = '1'.repeat(16);
const L1 = 'archne://join?v=1&d=AAAA', L2 = 'archne://join?v=1&d=BBBB', LBAD = 'archne://join?v=1&d=ZZZZ';
const INFO = { [L1]: { netId: 'aaaaaa111111', broker: 'wss://broker.emqx.io:8084/mqtt', hasTurn: false, current: false, enabled: false }, [L2]: { netId: 'bbbbbb222222', broker: 'wss://b.example.org/mqtt', hasTurn: true, current: false, enabled: false } };

(async () => {
  // ---- A. struktur statis ----
  const idx = fs.readFileSync(path.join(root, 'renderer', 'archne-index.html'), 'utf8');
  assert(/<div id="me">.*?id="wanbtn"[^>]*class="ibtn"[^>]*aria-label="Lintas jaringan".*?id="setbtn".*?<\/div>\s*<div id="tabs"/s.test(idx), 'ikon lintas jaringan ada di baris profil, tepat sebelum gear');
  assert(!/<button id="wanbtn"[^>]*>Lintas jaringan<\/button>/.test(idx) && !/id="wanbtn"[^>]*>\s*Lintas/.test(idx), 'tombol teks lama di sidebar sudah tidak ada');
  for (const id of ['wanmodal', 'wanon', 'wanst', 'wanshared', 'wanpeers', 'wanpaste', 'wanjoin', 'wanmk', 'wanout', 'wancp', 'wanbroker', 'turnp', 'wanrot', 'wanlog', 'wanclose']) assert(new RegExp('id="' + id + '"').test(idx), id);
  assert(/<details class="wadv">[\s\S]*id="wanbroker"[\s\S]*id="turnp"[\s\S]*id="wanrot"[\s\S]*id="wanlog"[\s\S]*<\/details>/.test(idx), 'broker, TURN, ganti kode, jejak ada di Pengaturan lanjutan');
  ok('ikon di #me sebelum gear, tombol teks hilang, dialog bersusun (lanjutan dilipat)');

  const inline = require('./_src').inlineJs();
  const els = {}, docH = {};
  const mkEl = (id) => ({ id, innerHTML: '', className: '', textContent: '', value: '', checked: false, style: {}, dataset: {}, disabled: false, scrollTop: 0, handlers: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); }, focus() {}, select() {}, requestSubmit() {}, querySelectorAll: () => [] });
  const calls = []; let setRet, updCb;
  const state = { me: { id: ME, name: 'Saya', port: 1 }, peers: [], limits: { maxText: 10000 }, sending: [], messages: [], vc: null, groups: [], pv: { me: null, channels: [] } };
  const api = new Proxy({}, { get: (_t, n) => {
    if (n === 'state') return async () => state;
    if (n === 'onUpdate') return (cb) => { updCb = cb; };
    if (n === 'pickFiles') return async () => [];
    if (n === 'pathOf') return () => '';
    if (n === 'wanSettings') return async () => ({ ok: true, settings: setRet() });
    if (n === 'invitePeek') return async (l) => { calls.push(['invitePeek', l]); return INFO[l] ? { ok: true, info: INFO[l] } : { ok: false, err: 'Undangan rusak' }; };
    if (n === 'inviteApply') return async (t) => { calls.push(['inviteApply', t]); return { ok: true, settings: setRet() }; };
    return async (...a) => { calls.push([n, ...a]); return { ok: true }; };
  } });
  const doc = { getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null, querySelector: () => null, addEventListener: (t, fn) => { (docH[t] = docH[t] || []).push(fn); } };
  const ctx = { window: { api }, document: doc, CSS: { escape: (s) => s }, FileCard: require('../renderer/archne-filecard'), Avatar: require('../renderer/archne-avatar'), confirm: () => true, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, clearInterval: () => {}, navigator: {}, location: { protocol: 'http:' },
    localStorage: { getItem: () => null, setItem: () => {} } };
  setRet = () => ({ enabled: false, hasCode: false, netId: null, broker: 'wss://broker.emqx.io:8084/mqtt', turn: { provider: 'none' } });
  state.messages = [
    { id: 'm1', from: 'f'.repeat(16), name: 'Budi#ffff', to: 'public', ts: Date.now() - 60000, text: 'Gabung ke jaringan Archne-ku (ketuk Tambah, atau tempel di menu Lintas jaringan):\n' + L1 },
    { id: 'm2', from: ME, name: 'Saya', to: 'public', ts: Date.now() - 30000, text: 'coba ' + L2 + ' ya' },
    { id: 'm3', from: 'f'.repeat(16), name: 'Budi#ffff', to: 'public', ts: Date.now() - 10000, text: 'ulang ' + L1 },
  ];
  vm.createContext(ctx);
  vm.runInContext(inline, ctx);
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert(els.msgs.innerHTML.includes('class="inv"') && !els.msgs.innerHTML.includes('archne://'), 'render awal sudah memuat kartu (bukan tautan mentah): archne-wan.js merender ulang setelah termuat');
  ok('render pertama: tautan undangan sudah jadi kartu, tanpa menunggu update berikutnya');
  const ev = (code) => vm.runInContext(code, ctx);
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

  // ---- B. bodyHtml: tautan jadi kartu ----
  const body = (m) => ev('bodyHtml(' + JSON.stringify(m) + ')');
  const h1 = body(state.messages[0]);
  assert(!h1.includes('archne://') && !h1.includes('d=AAAA'), 'tautan mentah tidak tampil di gelembung');
  assert(h1.includes('class="inv"') && h1.includes('Undangan jaringan</div>') && h1.includes('>Tambah</button>') && /data-wl="\d+"/.test(h1), 'kartu dengan tombol Tambah');
  assert(h1.includes('#aaaaaa') && h1.includes('broker.emqx.io') && !h1.includes('termasuk TURN'), 'info jaringan dan broker tampil, tanpa TURN');
  assert(h1.includes('Gabung ke jaringan Archne-ku') && !/:\s*<div class="inv"/.test(h1), 'teks pengantar tetap, titik dua ujung dibuang');
  assert(body(state.messages[1]).includes('termasuk TURN') && body(state.messages[1]).includes('coba') && body(state.messages[1]).includes(' ya'), 'teks sebelum dan sesudah tautan tetap; TURN ditandai');
  assert.strictEqual(body({ id: 'x', text: 'halo <b>dunia</b>' }), 'halo &lt;b&gt;dunia&lt;/b&gt;', 'pesan biasa tidak berubah (tetap di-escape)');
  const hb = body({ id: 'y', text: LBAD }); await flush();
  assert(body({ id: 'y', text: LBAD }).includes('Undangan rusak') && !body({ id: 'y', text: LBAD }).includes('<button'), 'undangan rusak: pesan galat, tanpa tombol');
  ok('tautan archne://join jadi kartu Tambah, pesan biasa utuh, undangan rusak ditolak rapi');

  // ---- C. tombol Tambah (belum di jaringan mana pun) ----
  const clickWl = async (html) => { const i = /data-wl="(\d+)"/.exec(html)[1]; calls.length = 0; for (const f of docH.click || []) f({ target: { closest: (s) => (s === '[data-wl]' ? { dataset: { wl: i } } : null) }, preventDefault() {} }); await flush(); };
  await clickWl(h1);
  assert(calls.some((c) => c[0] === 'inviteApply' && c[1] === L1), 'Tambah langsung memanggil inviteApply dengan tautan itu');
  ok('Tambah: sekali ketuk langsung bergabung bila belum ada jaringan aktif');

  // ---- D. sudah di jaringan lain: Pindah dua ketukan ----
  setRet = () => ({ enabled: true, hasCode: true, netId: 'cccccc333333', broker: 'wss://broker.emqx.io:8084/mqtt', turn: { provider: 'none' } });
  await ev('wanLoad()'); await flush();
  const hp = body(state.messages[0]);
  assert(hp.includes('>Pindah</button>'), 'jaringan lain aktif: tombol Pindah');
  await clickWl(hp);
  assert(!calls.some((c) => c[0] === 'inviteApply'), 'ketukan pertama tidak memindahkan');
  assert(body(state.messages[0]).includes('Yakin? Ketuk lagi'), 'ketukan pertama meminta konfirmasi');
  await clickWl(body(state.messages[0]));
  assert(calls.some((c) => c[0] === 'inviteApply' && c[1] === L1), 'ketukan kedua memindahkan');
  ok('Pindah: dua ketukan sebelum meninggalkan jaringan yang sedang dipakai');

  // ---- E. jaringan yang sama ----
  const cur = Object.assign({}, INFO[L1], { current: true, enabled: true });
  INFO[L1] = cur; ev('wanPeekC.clear()');
  body(state.messages[0]); await flush();
  const hc = body(state.messages[0]);
  assert(hc.includes('Tersambung') && !hc.includes('data-wl='), 'jaringan yang sedang dipakai: lencana Tersambung, tanpa tombol aksi (tombol salin tautan tetap ada)');
  ok('jaringan yang sama: lencana Tersambung');

  // ---- F. dialog: daftar undangan dari chat ----
  INFO[L1] = Object.assign({}, cur, { current: false, enabled: false }); ev('wanPeekC.clear()');
  setRet = () => ({ enabled: false, hasCode: false, netId: null, broker: 'wss://broker.emqx.io:8084/mqtt', turn: { provider: 'none' } });
  await ev('wanLoad()'); await flush();
  await els.wanbtn.onclick(); await flush(); await flush();
  assert.strictEqual(els.wanmodal.style.display, 'flex', 'dialog terbuka');
  const sh = els.wanshared.innerHTML;
  assert((sh.match(/class="wit/g) || []).length === 2, 'dua jaringan unik (tautan ganda digabung): ' + sh);
  assert(sh.includes('Dibagikan Budi') && sh.includes('Dibagikan kamu') && sh.includes('#aaaaaa') && sh.includes('#bbbbbb'), 'pengirim dan id jaringan tampil');
  assert((sh.match(/>Tambah<\/button>/g) || []).length === 2, 'tiap baris punya tombol Tambah');
  assert(els.wanst.textContent.startsWith('Nonaktif'), 'status awam: Nonaktif');
  state.messages = []; await flush();
  await els.wanbtn.onclick(); await flush();
  assert(els.wanshared.innerHTML.includes('Belum ada'), 'daftar kosong menjelaskan caranya');
  await els.wanclose.onclick();
  assert.strictEqual(els.wanmodal.style.display, 'none', 'tombol tutup bekerja');
  ok('dialog: daftar undangan dari chat (unik per jaringan, pengirim), keadaan kosong, status, tutup');

  // ---- G. ikon: kelas dasar tetap ibtn ----
  assert(/^ibtn\b/.test(els.wanbtn.className) && /Lintas jaringan/.test(els.wanbtn.title), 'ikon berkelas ibtn dan berjudul');
  ok('ikon: kelas ibtn, judul Lintas jaringan');
  console.log('\n' + pass + ' tes UI lintas jaringan OK');
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

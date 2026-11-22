'use strict';
// Tes riwayat panggilan (v0.14.0): (1) Core mencatat tiap panggilan di kedua sisi dengan hasil dan durasi yang benar, tahan restart,
// bisa dihapus; (2) label teks; (3) archne-index.html menampilkan gelembung panggilan di chat dan tab Panggilan (skrip asli di vm, DOM tiruan).
const os = require('os'), path = require('path'), fs = require('fs'), vm = require('vm'), assert = require('assert');
const { Core } = require('../src/archne-core');
const LC = require('../renderer/archne-call');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-calllog-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); }
  throw new Error('timeout: ' + label);
}
const mk = (n, extra) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false }, extra));
const lan = (c, ...o) => Promise.all(o.map((x) => c.addPeer('127.0.0.1', x.port)));
const log = (c) => c.getState().calls; // terbaru di atas
const find = (c, cid) => log(c).find((r) => r.id === cid);
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  console.log('Archne call-history test, dir: ' + tmp);

  // ---------- 1. label teks ----------
  assert.deepStrictEqual([0, 1, 59, 60, 135, 3600, 3900, 7200].map(LC.durHuman), ['0 dtk', '1 dtk', '59 dtk', '1 mnt', '2 mnt 15 dtk', '1 jam', '1 jam 5 mnt', '2 jam']);
  let L = LC.callLabel({ dir: 'out', out: 'done', dur: 135 });
  assert.deepStrictEqual([L.title, L.sub, L.short, L.bad], ['Panggilan suara', '2 mnt 15 dtk', 'Panggilan suara · 2 mnt 15 dtk', false]);
  L = LC.callLabel({ dir: 'in', out: 'missed' }); assert(L.bad && /tak terjawab/.test(L.title));
  assert.strictEqual(LC.callLabel({ dir: 'in', out: 'rejected' }).sub, 'Kamu menolak');
  assert.strictEqual(LC.callLabel({ dir: 'out', out: 'rejected' }).sub, 'Ditolak');
  assert.strictEqual(LC.callLabel({ dir: 'out', out: 'noanswer' }).sub, 'Tidak dijawab');
  assert.strictEqual(LC.callLabel({ dir: 'out', out: 'busy' }).sub, 'Sedang sibuk');
  assert.strictEqual(LC.callLabel({ dir: 'out', out: 'cancelled' }).sub, 'Dibatalkan');
  assert(LC.callLabel({ dir: 'out', out: 'failed' }).bad && LC.callLabel({ dir: 'out', out: 'apa-ini' }).sub === 'Gagal tersambung', 'hasil tak dikenal dianggap gagal');
  ok('label: durasi manusiawi, tiap hasil punya teks, tak terjawab/gagal merah');

  // ---------- 2. Core mencatat di kedua sisi ----------
  const A = mk('A', { callRingMs: 1200, callConnMs: 1500 }), B = mk('B', { callRingMs: 1200, callConnMs: 1500 }), C = mk('C', { callRingMs: 1200 });
  const all = [A, B, C];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 2), 8000, 'mesh');
  assert.deepStrictEqual(log(A), []); assert.deepStrictEqual(log(B), []);

  // tersambung ~1,2 detik lalu ditutup oleh penerima
  const c1 = A.callStart(B.id, 'S1');
  await until(() => B.getState().call && B.getState().call.cid === c1, 5000, 'B berdering');
  assert.strictEqual(log(A).length, 0, 'panggilan yang sedang berjalan belum masuk riwayat');
  B.callAnswer(c1, 'ANS'); await until(() => A.getState().call && A.getState().call.state === 'connecting', 5000, 'A connecting');
  assert(A.callConnected(c1) && B.callConnected(c1));
  await sleep(1250);
  const t0 = Date.now(); B.callEnd(c1);
  await until(() => find(A, c1) && find(B, c1), 5000, 'riwayat tercatat di kedua sisi');
  let ra = find(A, c1), rb = find(B, c1);
  assert.deepStrictEqual([ra.dir, ra.out, ra.peer, ra.name], ['out', 'done', B.id, 'B']);
  assert.deepStrictEqual([rb.dir, rb.out, rb.peer, rb.name], ['in', 'done', A.id, 'A']);
  assert(ra.dur >= 1 && ra.dur <= 3 && rb.dur >= 1 && rb.dur <= 3, 'durasi dihitung dari tersambung sampai berakhir: ' + ra.dur + '/' + rb.dur);
  assert(ra.at > 0 && Math.abs(ra.at - (t0 - 1300)) < 3000);
  ok('tersambung: dua sisi mencatat arah, lawan bicara, hasil done, durasi detik');

  // tolak
  const c2 = A.callStart(B.id, 'S2'); await until(() => B.getState().call && B.getState().call.cid === c2, 5000, 'tawaran 2');
  B.callReject(c2); await until(() => find(A, c2) && find(B, c2), 5000, 'riwayat tolak');
  assert.deepStrictEqual([find(A, c2).dir, find(A, c2).out, find(A, c2).dur], ['out', 'rejected', 0]);
  assert.deepStrictEqual([find(B, c2).dir, find(B, c2).out], ['in', 'rejected']);
  // batal sebelum diangkat
  const c3 = A.callStart(B.id, 'S3'); await until(() => B.getState().call && B.getState().call.cid === c3, 5000, 'tawaran 3');
  A.callEnd(c3); await until(() => find(A, c3) && find(B, c3), 5000, 'riwayat batal');
  assert.strictEqual(find(A, c3).out, 'cancelled'); assert.deepStrictEqual([find(B, c3).dir, find(B, c3).out], ['in', 'missed']);
  // tidak dijawab sampai kedaluwarsa
  const c4 = A.callStart(B.id, 'S4'); await until(() => find(A, c4) && find(B, c4), 5000, 'riwayat kedaluwarsa');
  assert.strictEqual(find(A, c4).out, 'noanswer'); assert.strictEqual(find(B, c4).out, 'missed');
  // sibuk: B sedang dalam panggilan dengan A, C menelepon B
  const c5 = A.callStart(B.id, 'S5'); await until(() => B.getState().call && B.getState().call.cid === c5, 5000, 'tawaran 5');
  B.callAnswer(c5, 'ANS'); await until(() => A.getState().call && A.getState().call.state === 'connecting', 5000, 'c5 connecting'); A.callConnected(c5); B.callConnected(c5);
  const c6 = C.callStart(B.id, 'S6'); await until(() => find(C, c6) && find(B, c6), 5000, 'riwayat sibuk');
  assert.strictEqual(find(C, c6).out, 'busy'); assert.deepStrictEqual([find(B, c6).dir, find(B, c6).out, find(B, c6).peer], ['in', 'missed', C.id]);
  A.callEnd(c5); await until(() => find(A, c5) && find(B, c5), 5000, 'c5 selesai');
  ok('tolak, batal, tak dijawab, tak terjawab (juga karena sibuk): tiap hasil tercatat benar di kedua sisi');

  // urutan: terbaru di atas; satu id hanya sekali
  assert.deepStrictEqual(log(A).map((r) => r.id).slice(0, 5), [c5, c4, c3, c2, c1]);
  A._callLogAdd({ id: c1, peer: B.id, name: 'B', dir: 'out', out: 'done', at: 1, dur: 9 });
  assert.strictEqual(log(A).length, 5, 'id yang sama tidak dicatat dua kali');
  ok('terbaru di atas, tanpa duplikat');

  // diblokir: panggilan dibuang diam-diam dan tidak masuk riwayat; riwayat orang itu disembunyikan
  assert(log(B).some((r) => r.peer === C.id));
  B.blockUser(C.id); assert(!log(B).some((r) => r.peer === C.id), 'orang yang diblokir hilang dari riwayat');
  B.unblockUser(C.id); assert(log(B).some((r) => r.peer === C.id), 'buka blokir: riwayat kembali');
  ok('blokir menyembunyikan riwayat orang itu');

  // bersihkan chat: hilang dari chat (hc), tetap di tab Panggilan
  assert(log(A).every((r) => !r.hc));
  A.clearChat(B.id);
  assert(log(A).length === 5 && log(A).every((r) => r.hc === true), 'clearChat: tersembunyi dari chat, tetap ada di riwayat');
  const c7 = A.callStart(B.id, 'S7'); await until(() => B.getState().call && B.getState().call.cid === c7, 5000, 'tawaran 7'); A.callEnd(c7);
  await until(() => find(A, c7), 5000, 'c7'); assert.strictEqual(find(A, c7).hc, false, 'panggilan baru setelah dibersihkan tampil lagi di chat');
  ok('Bersihkan chat menyembunyikan panggilan lama dari chat saja');

  // restart: riwayat bertahan
  await B.stop(); const B2 = mk('B', {}); await B2.start();
  assert(find(B2, c1) && find(B2, c1).out === 'done' && find(B2, c1).dir === 'in' && find(B2, c1).dur >= 1, 'riwayat bertahan setelah restart');
  ok('riwayat bertahan setelah restart');

  // hapus
  assert.throws(() => A.clearCalls('bukan-id'), /ID tidak valid/);
  A.clearCalls(B.id); assert.strictEqual(log(A).length, 0);
  B2.clearCalls(); assert.deepStrictEqual(log(B2), []);
  ok('clearCalls: satu orang atau semua; ID tidak valid ditolak');

  // data rusak di berkas diabaikan saat memuat
  await B2.stop();
  const sf = path.join(tmp, 'B', 'store.json');
  const raw = JSON.parse(fs.readFileSync(sf, 'utf8'));
  raw.calls = [{ id: 'x' }, null, 5, { id: 'a'.repeat(16), peer: 'b'.repeat(16), dir: 'in', out: 'done', at: 5, dur: 3 }, { id: 'c'.repeat(16), peer: 'b'.repeat(16), dir: 'sideways', out: 'done', at: 5 }];
  fs.writeFileSync(sf, JSON.stringify(raw));
  const B3 = mk('B', {}); await B3.start();
  assert.deepStrictEqual(B3.store.calls.map((r) => r.id), ['a'.repeat(16)], 'catatan rusak dibuang saat memuat');
  await B3.stop();
  ok('catatan rusak di berkas dibuang saat memuat');

  // batas jumlah
  const cap = mk('cap', {}); await cap.start();
  for (let i = 0; i < 320; i++) cap._callLogAdd({ id: i.toString(16).padStart(16, '0'), peer: 'd'.repeat(16), name: 'D', dir: 'out', out: 'noanswer', at: i + 1, dur: 0 });
  assert.strictEqual(cap.store.calls.length, 300); assert.strictEqual(cap.getState().calls[0].at, 320);
  await cap.stop();
  ok('riwayat dibatasi 300 catatan, yang terlama dibuang');

  for (const n of [A, C]) await n.stop();

  // ---------- 3. UI ----------
  {
    const html = require('./_src').htmlSrc();
    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    assert(/^\s{2}clearCalls:/m.test(preload) && /'clearCalls'/.test(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archne-api-http.js'), 'utf8')), 'clearCalls ada di preload dan adaptor HTTP');
    assert(/id="clrcalls"/.test(html));
    const inline = require('./_src').inlineJs();
    const els = {}, bodyCls = new Set();
    const mkEl = (id) => ({ id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, disabled: false, scrollTop: 0, clientHeight: 0, scrollHeight: 0,
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      addEventListener() {}, focus() {}, requestSubmit() {} });
    const doc = { getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null, querySelector: () => null,
      body: { classList: { add: (c) => bodyCls.add(c), remove: (c) => bodyCls.delete(c), contains: (c) => bodyCls.has(c) } } };
    const apiCalls = []; let state;
    const api = new Proxy({}, { get: (_t, n) => {
      if (n === 'state') return async () => state;
      if (['onProgress', 'onUpdate', 'onRemoved', 'onCall'].includes(n)) return () => {};
      return async (...a) => { apiCalls.push([n, ...a]); return { ok: true }; };
    } });
    const win = { api, addEventListener: () => {}, LanCall: LC, RTCPeerConnection: function () {}, MediaStream: function () {}, Audio: function () { this.play = () => Promise.resolve(); this.pause = () => {}; }, navigator: { mediaDevices: { getUserMedia: async () => ({}) } } };
    const ctx = { window: win, document: doc, CSS: { escape: (s) => s }, FileCard: require('../renderer/archne-filecard'), Avatar: require('../renderer/archne-avatar'), confirm: () => true, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, Date, parseInt, Set, Math, JSON };
    vm.createContext(ctx);
    const now = Date.now();
    const P = 'p1'.repeat(8);
    state = { me: { id: 'me', name: 'Saya', port: 1 }, peers: [{ id: P, name: 'Budi', online: false, secure: true, friend: true, fst: 'ok' }], groups: [], messages: [{ id: 'm1', from: P, to: 'me', ts: now - 5000, name: 'Budi', text: 'halo' }], sending: [], limits: { maxText: 10000 }, call: null,
      calls: [
        { id: 'a1'.repeat(8), peer: P, name: 'Budi', dir: 'in', out: 'missed', at: now - 1000, dur: 0, hc: false },
        { id: 'a2'.repeat(8), peer: P, name: 'Budi', dir: 'out', out: 'done', at: now - 60000, dur: 135, hc: false },
        { id: 'a3'.repeat(8), peer: P, name: 'Budi', dir: 'out', out: 'noanswer', at: now - 120000, dur: 0, hc: true },
        { id: 'a4'.repeat(8), peer: 'zz'.repeat(8), name: 'Orang Lain', dir: 'in', out: 'rejected', at: now - 3 * 864e5, dur: 0, hc: false },
      ] };
    vm.runInContext(inline, ctx); await flush(); await flush();

    // daftar chat: pratinjau terakhir = panggilan terbaru; badge tak terjawab di tab Panggilan
    vm.runInContext("tab = 'teman'; emptyTab = true; render()", ctx);
    assert(/<svg class="ic"[^>]*>.*?<\/svg>Panggilan suara tak terjawab/.test(els.list.innerHTML) && !els.list.innerHTML.includes('📞'), 'pratinjau chat menampilkan panggilan terakhir');
    assert(/data-tab="calls"[^>]*>[\s\S]*?Panggilan<\/span><span class="badge">1<\/span>/.test(els.tabs.innerHTML), 'lencana 1 panggilan tak terjawab');

    // chat DM: gelembung panggilan di antara pesan, urut waktu; yang disembunyikan (hc) tidak tampil
    vm.runInContext(`pickChat('${P}')`, ctx); await flush();
    const msgs = els.msgs.innerHTML;
    assert((msgs.match(/class="m call/g) || []).length === 2, 'dua panggilan tampil (yang hc disembunyikan)');
    assert(/class="m call me"[^>]*>[\s\S]*?Panggilan suara<\/div><div class="c2">↗ 2 mnt 15 dtk/.test(msgs), 'keluar: sisi kanan, ikon, durasi');
    assert(/class="m call  bad"|class="m call bad"/.test(msgs.replace(/\s+/g, ' ')) && /Panggilan suara tak terjawab/.test(msgs) && /↙ Tak terjawab/.test(msgs), 'masuk tak terjawab: sisi kiri, merah');
    assert(msgs.indexOf('2 mnt 15 dtk') < msgs.indexOf('halo') && msgs.indexOf('halo') < msgs.indexOf('Tak terjawab'), 'urutan menurut waktu: panggilan 60 dtk lalu, pesan 5 dtk lalu, panggilan 1 dtk lalu');
    assert(!/noanswer|Tidak dijawab/.test(msgs));
    // publik tidak menampilkan panggilan
    vm.runInContext("pickChat('public')", ctx); assert(!/class="m call/.test(els.msgs.innerHTML));
    ok('chat: gelembung panggilan (arah, durasi, merah bila tak terjawab) menyelip di antara pesan; publik tidak');

    // tab Panggilan
    els.tabs.onclick({ target: { closest: () => ({ dataset: { tab: 'calls' } }) } });
    const lst = els.list.innerHTML;
    assert((lst.match(/class="item crow"/g) || []).length === 4, 'semua panggilan (juga yang hc) ada di riwayat');
    assert(lst.indexOf('Tak terjawab') < lst.indexOf('2 mnt 15 dtk') && lst.indexOf('2 mnt 15 dtk') < lst.indexOf('Tidak dijawab'), 'terbaru di atas');
    assert(lst.includes('Orang Lain') && lst.includes('Kamu menolak'), 'orang yang tidak ada di daftar peer tetap tampil dengan namanya');
    assert(lst.includes(`data-callback="${P}"`) && lst.includes(`data-cpeer="${P}"`));
    assert.strictEqual(els.clrcalls.style.display, 'block');
    assert(!/class="badge">1</.test(els.tabs.innerHTML.split('data-tab="calls"')[1] || ''), 'lencana hilang setelah tab dibuka');
    // ketuk baris: buka chat, tab tetap Panggilan
    els.list.onclick({ target: { closest: (s) => (s === '[data-callback]' ? null : { dataset: { cpeer: P } }) } });
    assert(/data-tab="calls"/.test(els.tabs.innerHTML) && /tab sel" data-tab="calls"/.test(els.tabs.innerHTML), 'tab Panggilan tetap terpilih');
    assert(els.head.innerHTML.includes('Budi'), 'chat dengan orang itu terbuka');
    // telepon balik: offline ditolak dengan toast, tidak memanggil inti
    els.list.onclick({ target: { closest: (s) => (s === '[data-callback]' ? { dataset: { callback: P } } : null) } }); await flush();
    assert(/offline/.test(els.toast.textContent) && !apiCalls.some((c) => c[0] === 'callStart'));
    els.list.onclick({ target: { closest: (s) => (s === '[data-callback]' ? { dataset: { callback: 'zz'.repeat(8) } } : null) } });
    assert(/belum terlihat/.test(els.toast.textContent), 'orang yang tidak terlihat di jaringan: toast, tidak error');
    // hapus riwayat
    await els.clrcalls.onclick(); await flush();
    assert.deepStrictEqual(apiCalls.find((c) => c[0] === 'clearCalls'), ['clearCalls']);
    state.calls = []; vm.runInContext('refresh()', ctx); await flush(); await flush();
    assert(/Belum ada panggilan/.test(els.list.innerHTML) && els.clrcalls.style.display === 'none');
    // peramban tanpa WebRTC: riwayat tetap tampil, tombol telepon balik tidak
    {
      const els2 = {}; const doc2 = Object.assign({}, doc, { getElementById: (id) => els2[id] || (els2[id] = mkEl(id)) });
      state.calls = [{ id: 'a1'.repeat(8), peer: P, name: 'Budi', dir: 'in', out: 'missed', at: Date.now(), dur: 0, hc: false }];
      const ctx2 = Object.assign({}, ctx, { document: doc2, window: { api, addEventListener: () => {}, LanCall: LC, navigator: {} } });
      vm.createContext(ctx2); vm.runInContext(inline, ctx2); await flush(); await flush();
      vm.runInContext("tab = 'calls'; emptyTab = true; render()", ctx2);
      assert(/class="item crow"/.test(els2.list.innerHTML) && !/data-callback/.test(els2.list.innerHTML), 'tanpa WebRTC: tanpa tombol telepon balik');
    }
    ok('tab Panggilan: terbaru di atas, lencana tak terjawab, ketuk baris membuka chat, telepon balik, hapus riwayat, keadaan kosong');
  }

  console.log('\n' + pass + ' tes riwayat panggilan OK');
  process.exit(0);
})().catch((e) => { console.error('GAGAL', e); process.exit(1); });

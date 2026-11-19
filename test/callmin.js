'use strict';
// Tes layar panggilan yang bisa dikecilkan (seperti WhatsApp) dan larangan telepon ganda (v0.19.1).
//   1. overlayHtml: tombol "min" hanya saat bukan berdering; mode kecil = bar (nama, durasi, mik, akhiri)
//   2. archne-index.html (skrip asli di vm, Controller asli, WebRTC palsu): kecilkan / buka lagi, kelas body, tombol terkunci, channel terkunci
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const GID = 'a'.repeat(16), CH = 'c1'.repeat(8), ME = '1'.repeat(16), P1 = '2'.repeat(16), P2 = '3'.repeat(16);
const flush = () => new Promise((r) => setImmediate(r));

const h = { esc: (s) => String(s).replace(/</g, '&lt;'), avatar: (id) => `<av ${id}>`, icons: { phone: '<P/>', mic: '<M/>', micOff: '<X/>', chev: '<V/>', speaker: '<S/>' } };
const acts = (v, o) => [...LC.overlayHtml(v, Object.assign({}, h, o)).matchAll(/data-cact="(\w+)"/g)].map((x) => x[1]);
const leg = (peer, name, state) => ({ cid: 'x' + peer, peer, name, state: state || 'active' });

(async () => {
  // ---------- 1. unit: overlayHtml ----------
  {
    assert.strictEqual(LC.canMinimize(null), false);
    assert.strictEqual(LC.canMinimize({ phase: 'ringing', canAccept: true }), false, 'dering masuk tidak boleh dikecilkan');
    assert.strictEqual(LC.canMinimize({ phase: 'ringing', invite: true }), false, 'undangan masuk tidak boleh dikecilkan');
    for (const ph of ['dialing', 'connecting', 'active']) assert.strictEqual(LC.canMinimize({ phase: ph }), true, ph);
    assert.strictEqual(LC.canMinimize({ phase: 'connecting', invite: true }), false, 'layar undangan tidak punya tombol kecilkan');
    ok('canMinimize: boleh saat memanggil / menyambung / tersambung, tidak saat dering atau layar undangan');

    // layar penuh: tombol kecilkan muncul pertama, hanya saat boleh
    assert.deepStrictEqual(acts({ phase: 'dialing', peer: 'p', name: 'N' }), ['min', 'mute', 'deafen', 'hang']);
    assert.deepStrictEqual(acts({ phase: 'active', peer: 'p', name: 'N', since: 1 }), ['min', 'mute', 'cam', 'deafen', 'add', 'hang']);
    assert.deepStrictEqual(acts({ phase: 'ringing', canAccept: true, peer: 'p', name: 'N' }), ['reject', 'accept'], 'dering: tanpa tombol kecilkan');
    assert(!/data-cact="min"/.test(LC.overlayHtml({ phase: 'ringing', canAccept: true, peer: 'p', name: 'N' }, Object.assign({}, h, { minimized: true }))), 'dering tetap layar penuh walau minimized=true');
    assert.deepStrictEqual(acts({ phase: 'ringing', canAccept: true, peer: 'p', name: 'N' }, { minimized: true }), ['reject', 'accept']);
    assert.deepStrictEqual(acts({ phase: 'ringing', invite: true, canAccept: true, peer: 'p', name: 'N', members: [] }, { minimized: true }), ['reject', 'accept'], 'undangan masuk juga tetap penuh');
    assert(/<button[^>]*class="cmin"[^>]*>&lt;V\/>|<button[^>]*class="cmin"[^>]*><V\/>/.test(LC.overlayHtml({ phase: 'active', peer: 'p', name: 'N', since: 1 }, h)), 'tombol kecilkan memakai ikon chevron');
    ok('layar penuh: tombol Kecilkan pertama; dering dan undangan masuk tidak punya tombolnya dan tidak bisa dikecilkan');

    // mode kecil: bar saja
    const v1 = { phase: 'active', peer: 'p', name: 'Bu<di', since: 1, muted: false, legs: [leg('p', 'Bu<di')] };
    const mini = LC.overlayHtml(v1, Object.assign({}, h, { minimized: true }));
    assert.deepStrictEqual(acts(v1, { minimized: true }), ['max', 'mute', 'hang'], 'bar: buka lagi, mik, akhiri');
    assert(/class="cmb"/.test(mini) && /Bu&lt;di/.test(mini) && !/Bu<di/.test(mini), 'nama di-escape');
    assert(/id="calltime"/.test(mini) && /data-phase="active"/.test(mini) && /\d\d:\d\d/.test(mini), 'durasi memakai id calltime supaya ikut diperbarui timer');
    assert(!/cnm|cbtns|cseg|cpk|cin|cav/.test(mini), 'tanpa avatar, tombol besar, peredam bising, atau lembar pilihan');
    assert(/role="button"/.test(mini) && /tabindex="0"/.test(mini), 'bar bisa difokus keyboard');
    assert(/aria-label="Akhiri"/.test(mini) && /aria-label="Bisukan"/.test(mini));
    // mik mati
    const mm = LC.overlayHtml(Object.assign({}, v1, { muted: true }), Object.assign({}, h, { minimized: true }));
    assert(/cmx tog on/.test(mm) && /<X\/>/.test(mm), 'mik mati tampak di bar');
    // fase: memanggil = Batal, menyambung
    assert(/Memanggil/.test(LC.overlayHtml({ phase: 'dialing', peer: 'p', name: 'N' }, Object.assign({}, h, { minimized: true }))) && /aria-label="Batal"/.test(LC.overlayHtml({ phase: 'dialing', peer: 'p', name: 'N' }, Object.assign({}, h, { minimized: true }))));
    assert(/Menyambungkan/.test(LC.overlayHtml({ phase: 'connecting', peer: 'p', name: 'N' }, Object.assign({}, h, { minimized: true }))));
    // picker tidak ikut muncul di mode kecil
    assert(!/cpk/.test(LC.overlayHtml(v1, Object.assign({}, h, { minimized: true, picker: [{ id: 'z', name: 'Z', friend: true }] }))), 'lembar Tambah orang tidak ada di bar');
    ok('mode kecil: bar berisi nama (di-escape), durasi (calltime), mik, akhiri; tanpa elemen layar penuh');

    // grup dan channel
    const g = { phase: 'active', peer: 'p', name: 'N', since: 1, legs: [leg('p', 'N'), leg('q', 'Q')], invites: [] };
    assert(/Panggilan grup/.test(LC.overlayHtml(g, Object.assign({}, h, { minimized: true }))), 'grup: judul bar');
    const vc = { phase: 'active', vc: { gid: GID, cid: CH, name: 'Ngobrol <x>' }, since: 1, legs: [], invites: [] };
    const vm1 = LC.overlayHtml(vc, Object.assign({}, h, { minimized: true }));
    assert(/Ngobrol &lt;x>/.test(vm1) && /<S\/>/.test(vm1) && /aria-label="Keluar"/.test(vm1), 'channel: nama channel, ikon speaker, tombol Keluar');
    assert.deepStrictEqual(acts(vc), ['min', 'mute', 'cam', 'deafen', 'hang'], 'channel layar penuh juga bisa dikecilkan (kini dengan tombol kamera, langkah 2)');
    ok('panggilan grup dan channel suara juga bisa dikecilkan (judul bar sesuai)');
  }

  // ---------- 2. archne-index.html ----------
  {
    const html = require('./_src').htmlSrc();
    for (const css of ['#callov.mini', 'body.callmin', '#callov .cmin', '#callov .cmb', '.cbk.off']) assert(html.includes(css), 'gaya ' + css);
    const inline = require('./_src').inlineJs();
    const els = {}, bodyCls = new Set();
    const mkEl = (id) => ({ id, innerHTML: '', className: '', textContent: '', title: '', value: '', checked: false, style: {}, dataset: {}, disabled: false, scrollTop: 0, clientHeight: 0, scrollHeight: 0,
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } }, addEventListener() {}, focus() {}, requestSubmit() {} });
    const calls = []; let state, updCb, callCb, nextCid = 0;
    const api = new Proxy({}, { get: (_t, n) => {
      if (n === 'state') return async () => state;
      if (n === 'onUpdate') return (cb) => { updCb = cb; };
      if (n === 'onCall') return (cb) => { callCb = cb; };
      if (n === 'pickFiles') return async () => [];
      if (n === 'pathOf') return () => '';
      return async (...a) => { calls.push([n, ...a]); if (n === 'callStart') return { ok: true, cid: 'd' + (++nextCid) + 'd'.repeat(14) }; return { ok: true }; };
    } });
    class PC { constructor() { this.localDescription = null; this.remoteDescription = null; } addTrack() { return { replaceTrack: async () => {} }; } async createOffer() { return { type: 'offer', sdp: 'O' }; } async createAnswer() { return { type: 'answer', sdp: 'A' }; } async setLocalDescription(d) { this.localDescription = d; } async setRemoteDescription(d) { this.remoteDescription = d; } async addIceCandidate() {} close() {} }
    const cbkBtn = mkEl('cbk'); // satu tombol "Telepon lagi" tiruan di daftar panggilan
    const doc = { getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: (sel) => (sel === '#list .cbk' ? [cbkBtn] : []), activeElement: null, querySelector: () => null,
      body: { classList: { add: (c) => bodyCls.add(c), remove: (c) => bodyCls.delete(c), contains: (c) => bodyCls.has(c) } } };
    const track = { enabled: true, stop() {} };
    const win = { api, RTCPeerConnection: PC, LanCall: LC, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } } };
    const ctx = { window: win, document: doc, CSS: { escape: (s) => s }, FileCard: require('../renderer/archne-filecard'), Avatar: require('../renderer/archne-avatar'), confirm: () => true, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, Date, parseInt, Set, Math, JSON,
      localStorage: { getItem: () => null, setItem() {} } };
    vm.createContext(ctx);
    const ch = (id, name, o) => Object.assign({ id, name, by: P1, locked: false, allow: [], ts: 1, canJoin: true, canManage: false, here: [] }, o);
    state = { me: { id: ME, name: 'Saya', port: 1 }, peers: [{ id: P1, name: 'Budi', online: true, secure: true }, { id: P2, name: 'Cici', online: true, secure: true }], limits: { maxText: 10000 }, sending: [], messages: [], vc: null, call: null,
      groups: [{ id: GID, name: 'Tim', creator: P1, admins: [], members: [{ id: ME, name: 'Saya' }, { id: P1, name: 'Budi' }], epoch: 1, removed: false, leaving: [], channels: [ch(CH, 'Ngobrol')] }] };
    vm.runInContext(inline, ctx);
    await flush(); await flush();
    const ov = () => els.callov;
    const click = (act) => ov().onclick({ target: { classList: { contains: () => false }, closest: (sel) => (sel === '[data-cact]' ? { dataset: { cact: act } } : null) } });
    const run = (code) => vm.runInContext(code, ctx);

    // DM Budi: tombol telepon ada dan aktif
    run("cur = '" + P1 + "'; emptyTab = false; render();");
    assert(els.head.innerHTML.includes('id="callbtn"') && !/class="ibtn off"/.test(els.head.innerHTML), 'tombol telepon di header DM, belum terkunci');
    // telepon
    calls.length = 0;
    els.callbtn.onclick(); await flush(); await flush(); await flush();
    assert.strictEqual(calls.filter((c) => c[0] === 'callStart').length, 1, 'panggilan dimulai');
    assert.strictEqual(ov().style.display, 'flex'); assert(bodyCls.has('incall') && !bodyCls.has('callmin'), 'layar penuh: aplikasi di belakang disembunyikan');
    assert(/data-cact="min"/.test(ov().innerHTML), 'tombol kecilkan tampil saat memanggil');
    assert.strictEqual(ov().className, '');
    ok('archne-index.html: menelepon membuka layar penuh dengan tombol Kecilkan');

    // kecilkan
    await click('min');
    assert.strictEqual(ov().className, 'mini'); assert.strictEqual(ov().style.display, 'flex', 'panggilan tetap ada');
    assert(!bodyCls.has('incall') && bodyCls.has('callmin'), 'aplikasi muncul kembali; ruang untuk bar kecil disediakan');
    assert(/class="cmb"/.test(ov().innerHTML) && /Budi/.test(ov().innerHTML) && !/cbtns/.test(ov().innerHTML), 'isi bar kecil');
    assert.strictEqual(calls.filter((c) => c[0] === 'callEnd').length, 0, 'mengecilkan tidak mengakhiri panggilan');
    // bar kecil tidak mematikan mik tanpa diminta, tetapi tombol mik di bar bekerja
    await click('mute'); assert(/cmx tog on/.test(ov().innerHTML), 'mik di bar kecil bekerja, tetap mode kecil'); assert.strictEqual(ov().className, 'mini');
    await click('mute'); assert(!/cmx tog on/.test(ov().innerHTML));
    ok('archne-index.html: Kecilkan -> bar di atas, aplikasi bisa dipakai, panggilan tidak putus, mik di bar bekerja');

    // chat tetap bisa dipakai saat bar aktif: render ulang (state update) tidak membuka layar penuh lagi
    await updCb(); await flush();
    assert.strictEqual(ov().className, 'mini', 'update state tidak mengembalikan layar penuh');
    run("cur = 'public'; render();");
    assert.strictEqual(ov().className, 'mini', 'pindah chat tidak mengembalikan layar penuh');
    ok('archne-index.html: pindah chat / update state tidak membuka layar penuh lagi');

    // larangan telepon ganda: tombol terkunci + toast, tidak ada callStart kedua
    assert(cbkBtn.classList.contains('off'), 'tombol "Telepon lagi" di tab Panggilan ikut redup begitu panggilan mulai');
    run("cur = '" + P2 + "'; emptyTab = false; render();");
    assert(/class="ibtn off"/.test(els.head.innerHTML) && /Sedang dalam panggilan/.test(els.head.innerHTML), 'tombol telepon di DM lain redup');
    calls.length = 0; doc.getElementById('toast').textContent = '';
    els.callbtn.onclick(); await flush(); await flush();
    assert.strictEqual(calls.filter((c) => c[0] === 'callStart').length, 0, 'tidak ada panggilan kedua');
    assert(/sedang dalam panggilan/i.test(doc.getElementById('toast').textContent), 'toast menjelaskan: ' + doc.getElementById('toast').textContent);
    // telepon balik dari tab Panggilan juga diblokir
    doc.getElementById('toast').textContent = '';
    await els.list.onclick({ target: { closest: (sel) => (sel === '[data-callback]' ? { dataset: { callback: P2 } } : null) } }); await flush();
    assert.strictEqual(calls.filter((c) => c[0] === 'callStart').length, 0); assert(/sedang dalam panggilan/i.test(doc.getElementById('toast').textContent), 'telepon lagi: toast');
    ok('archne-index.html: sedang menelepon -> tombol telepon (header, Telepon lagi) redup dan ditolak dengan penjelasan');

    // channel: Masuk terkunci selama dalam panggilan
    run("cur = 'g:" + GID + "'; render();");
    assert(/class="off"[^>]*data-vact="enter"/.test(els.vcbar.innerHTML), 'tombol Masuk redup');
    calls.length = 0; doc.getElementById('toast').textContent = '';
    await els.vcbar.onclick({ target: { closest: (sel) => (sel === '[data-vact]' ? { dataset: { vact: 'enter', cid: CH } } : null) }, stopPropagation() {} }); await flush();
    assert.strictEqual(calls.filter((c) => c[0] === 'vcEnter').length, 0, 'tidak masuk channel saat sedang menelepon');
    assert(/sedang dalam panggilan/i.test(doc.getElementById('toast').textContent));
    ok('archne-index.html: sedang menelepon -> Masuk channel suara ditolak dengan penjelasan');

    // buka lagi dari bar
    await click('max');
    assert.strictEqual(ov().className, ''); assert(bodyCls.has('incall') && !bodyCls.has('callmin'));
    assert(/data-cact="min"/.test(ov().innerHTML));
    ok('archne-index.html: ketuk bar -> layar penuh lagi');

    // akhiri: semuanya kembali normal
    await click('hang'); await flush();
    assert.strictEqual(ov().style.display, 'none'); assert(!bodyCls.has('incall') && !bodyCls.has('callmin'));
    assert(!cbkBtn.classList.contains('off'), 'tombol Telepon lagi aktif lagi');
    run("cur = '" + P2 + "'; emptyTab = false; render();");
    assert(!/class="ibtn off"/.test(els.head.innerHTML), 'tombol telepon DM aktif lagi');
    run("cur = 'g:" + GID + "'; render();");
    assert(!/class="off"[^>]*data-vact="enter"/.test(els.vcbar.innerHTML), 'Masuk aktif lagi');
    calls.length = 0; run("cur = '" + P2 + "'; emptyTab = false; render();");
    els.callbtn.onclick(); await flush(); await flush(); await flush();
    assert.strictEqual(calls.filter((c) => c[0] === 'callStart').length, 1, 'setelah panggilan berakhir bisa menelepon lagi');
    await click('hang'); await flush();
    ok('archne-index.html: panggilan berakhir -> bar hilang, tombol aktif lagi, bisa menelepon lagi');

    // dering masuk: tetap layar penuh, tidak bisa dikecilkan walau "min" terkirim
    callCb({ ev: 'incoming', cid: 'e1'.repeat(8), peer: P1, name: 'Budi', sdp: 'OFFER', ice: [] }); await flush();
    assert.strictEqual(ov().style.display, 'flex'); assert(bodyCls.has('incall'));
    assert(!/data-cact="min"/.test(ov().innerHTML) && /data-cact="accept"/.test(ov().innerHTML), 'dering: Terima/Tolak, tanpa Kecilkan');
    await click('min'); assert.strictEqual(ov().className, '', 'aksi min diabaikan saat berdering'); assert(bodyCls.has('incall') && !bodyCls.has('callmin'));
    // panggilan masuk kedua saat sudah berdering: tetap ditolak (sibuk) seperti sebelumnya
    calls.length = 0;
    callCb({ ev: 'incoming', cid: 'e2'.repeat(8), peer: P2, name: 'Cici', sdp: 'OFFER2', ice: [] }); await flush();
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'callReject'), [['callReject', 'e2'.repeat(8)]], 'panggilan kedua ditolak sibuk');
    await click('reject'); await flush();
    assert.strictEqual(ov().style.display, 'none');
    // jawab dering -> setelah tersambung barulah bisa dikecilkan
    callCb({ ev: 'incoming', cid: 'e3'.repeat(8), peer: P1, name: 'Budi', sdp: 'OFFER3', ice: [] }); await flush();
    await click('accept'); await flush(); await flush();
    assert(/data-cact="min"/.test(ov().innerHTML), 'setelah diterima, tombol Kecilkan muncul');
    await click('min'); assert.strictEqual(ov().className, 'mini');
    await click('hang'); await flush();
    assert.strictEqual(ov().className, '', 'selesai: kelas mini dilepas'); assert.strictEqual(ov().style.display, 'none');
    assert(!bodyCls.has('incall') && !bodyCls.has('callmin'));
    ok('archne-index.html: dering masuk selalu layar penuh; panggilan kedua ditolak sibuk; setelah diterima baru bisa dikecilkan');

    // panggilan baru setelah ditutup dalam keadaan kecil: mulai dari layar penuh
    calls.length = 0; run("cur = '" + P1 + "'; emptyTab = false; render();");
    els.callbtn.onclick(); await flush(); await flush(); await flush();
    assert.strictEqual(ov().className, '', 'panggilan baru selalu mulai dari layar penuh');
    assert(bodyCls.has('incall') && !bodyCls.has('callmin'));
    await click('hang'); await flush();
    ok('archne-index.html: panggilan berikutnya mulai dari layar penuh walau yang sebelumnya ditutup dalam keadaan kecil');
  }

  console.log('\n' + pass + ' tes kecilkan panggilan OK');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

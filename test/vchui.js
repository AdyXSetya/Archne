'use strict';
// Tes UI daftar channel voice (v0.19.0, langkah 6): skrip asli archne-index.html di vm dengan DOM tiruan (seperti test/ui.js).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const html = require('./_src').htmlSrc();
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const ME = '1'.repeat(16), BU = '2'.repeat(16), AN = '3'.repeat(16), GID = 'a'.repeat(16), C1 = 'c1'.repeat(8), C2 = 'c2'.repeat(8), C3 = 'c3'.repeat(8);

(async () => {
  // struktur statis
  for (const id of ['vcbar', 'vmodal', 'vname', 'vlock', 'vok', 'vcancel', 'vtitle', 'vallow', 'vallowbox']) assert(new RegExp('id="' + id + '"').test(html), 'elemen ' + id);
  assert(/<div id="head"><\/div>\s*<div id="vcbar"><\/div>\s*(?:<div id="pvbar"><\/div>\s*)?(?:<div id="sembar"><\/div>\s*)?<div id="msgs">/.test(html), 'vcbar di antara header dan pesan');
  ok('elemen vcbar dan modal channel ada, ditaruh di antara header dan daftar pesan');

  const inline = require('./_src').inlineJs();
  const els = {};
  const mkEl = (id) => ({ id, innerHTML: '', className: '', textContent: '', value: '', checked: false, style: {}, dataset: {}, disabled: false, scrollTop: 0, clientHeight: 0, scrollHeight: 0, handlers: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); }, focus() {}, requestSubmit() {} });
  const calls = []; let state, updCb, failErr = null, confirmAns = true, storage = {};
  const api = new Proxy({}, { get: (_t, n) => {
    if (n === 'state') return async () => state;
    if (n === 'onUpdate') return (cb) => { updCb = cb; };
    if (n === 'pickFiles') return async () => [];
    if (n === 'pathOf') return () => '';
    return async (...a) => { calls.push([n, ...a]); return failErr ? { ok: false, err: failErr } : { ok: true }; };
  } });
  const doc = { getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null, querySelector: () => null };
  const ctx = { window: { api }, document: doc, CSS: { escape: (s) => s }, FileCard: require('../renderer/archne-filecard'), Avatar: require('../renderer/archne-avatar'), confirm: () => confirmAns, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, Date, parseInt, Set, Math, JSON,
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = v; } } };
  vm.createContext(ctx);
  const ch = (id, name, o) => Object.assign({ id, name, by: BU, locked: false, allow: [], ts: 1, canJoin: true, canManage: false, here: [] }, o);
  state = { me: { id: ME, name: 'Saya', port: 1 }, peers: [{ id: BU, name: 'Budi', online: true, secure: true }, { id: AN, name: 'Ani', online: true, secure: true }], limits: { maxText: 10000 }, sending: [], messages: [], vc: null,
    groups: [{ id: GID, name: 'Tim', creator: BU, admins: [], members: [{ id: ME, name: 'Saya' }, { id: BU, name: 'Budi' }, { id: AN, name: 'Ani' }], epoch: 1, removed: false, leaving: [], channels: [
      ch(C1, 'Santai <b>', { here: [{ id: BU, name: 'Budi' }, { id: AN, name: 'Ani' }] }),
      ch(C2, 'Rapat', { locked: true, canJoin: false }),
      ch(C3, 'Punyaku', { by: ME, canManage: true, locked: true })] }] };
  vm.runInContext(inline, ctx);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  const bar = els.vcbar;
  assert.strictEqual(bar.style.display, 'none', 'chat publik: strip tersembunyi');
  vm.runInContext("cur = 'g:" + GID + "'; render();", ctx);
  let out = bar.innerHTML;
  assert.strictEqual(bar.style.display, 'block');
  assert(out.includes('Channel suara · 3'), 'jumlah channel');
  assert(out.includes('Santai &lt;b&gt;') && !out.includes('<b>'), 'nama channel di-escape');
  assert(out.includes('Budi, Ani'), 'siapa yang ada di channel');
  assert(out.includes('Kosong'), 'channel kosong');
  assert(/aria-label="Terenkripsi">(?:🔒|<svg class="ic"[^>]*>[\s\S]*?<\/svg>)<\/span>/.test(els.head.innerHTML) && !/· terenkripsi/.test(els.head.innerHTML), 'header grup: ikon gembok, bukan teks "terenkripsi"');
  ok('di chat grup, strip menampilkan semua channel, nama di-escape, penghuni dan "Kosong"');

  const row = (cid) => { const i = out.indexOf('data-cid="' + cid + '"'); const j = out.indexOf('class="vch', i + 1); return out.slice(out.lastIndexOf('<div class="vch', i), j > 0 ? j : undefined); };
  assert(/data-vact="enter" data-cid="c1c1c1c1c1c1c1c1"/.test(row(C1)) && !/vact="del"|vact="edit"/.test(row(C1)), 'channel orang lain: Masuk saja, tanpa kelola');
  assert(/terkunci/.test(row(C2)) && !/vact="enter"/.test(row(C2)), 'terkunci dan tidak berhak: tanpa tombol Masuk');
  assert(/vact="enter"/.test(row(C3)) && /vact="del"/.test(row(C3)) && />Kelola</.test(row(C3)), 'milik sendiri: Masuk, Kelola, Hapus');
  assert(row(C2).includes('vch-lock') || row(C2).includes('<rect') , 'ikon gembok untuk channel terkunci');
  assert(!row(C1).includes('<rect'), 'channel terbuka: ikon speaker, bukan gembok');
  ok('tombol sesuai hak: Masuk / terkunci tanpa tombol / kelola (Kelola, Hapus) hanya untuk yang berhak; gembok hanya di channel terkunci');

  // klik
  const click = async (act, cid) => { calls.length = 0; await bar.onclick({ target: { closest: (sel) => (sel === '[data-vact]' ? { dataset: { vact: act, cid } } : null) }, stopPropagation() {} }); return calls.slice(); };
  assert.deepStrictEqual(await click('enter', C1), [], 'tanpa WebRTC: Masuk tidak memanggil Core (hadir tanpa suara itu menyesatkan)');
  assert(/mendukung suara/.test(els.toast.textContent), 'perangkat tanpa WebRTC diberi tahu');
  assert.deepStrictEqual((await click('edit', C1)).length, 0, 'bukan pengelola: tidak ada panggilan'); assert.notStrictEqual((els.vmodal || { style: {} }).style.display, 'flex', 'bukan pengelola: modal kelola tidak terbuka');
  confirmAns = false; assert.deepStrictEqual(await click('del', C3), [], 'hapus dibatalkan');
  confirmAns = true; assert.deepStrictEqual((await click('del', C3))[0], ['vcDelete', GID, C3]);
  assert.deepStrictEqual((await click('del', 'f'.repeat(16))).length, 0, 'channel tidak dikenal diabaikan');
  assert.deepStrictEqual((await click('leave'))[0], ['vcLeave']);
  failErr = 'Hanya pembuat, admin, atau pemilik'; await click('del', C3); failErr = null;
  assert.strictEqual(els.toast.textContent, 'Hanya pembuat, admin, atau pemilik', 'galat Core tampil sebagai toast');
  ok('Masuk (butuh WebRTC)/Keluar/Hapus memanggil api yang benar; hapus minta konfirmasi; yang bukan pengelola tidak bisa memicu; galat tampil sebagai toast');

  // sedang di channel
  state.vc = { gid: GID, cid: C1 }; state.groups[0].channels[0].here = [{ id: ME, name: 'Saya', me: true }, { id: BU, name: 'Budi' }];
  vm.runInContext('render()', ctx); out = bar.innerHTML;
  assert(/vch in" data-cid="c1c1c1c1c1c1c1c1"/.test(out) && /vact="leave"/.test(row(C1)) && !/vact="enter" data-cid="c1c1c1c1c1c1c1c1"/.test(out), 'channel yang kumasuki: ditandai dan tombol Keluar');
  assert(out.includes('Kamu, Budi'), 'aku tampil sebagai "Kamu"');
  state.vc = { gid: 'e'.repeat(16), cid: C1 }; vm.runInContext('render()', ctx);
  assert(!/vch in"/.test(bar.innerHTML), 'channel dengan id sama tapi di grup lain tidak ditandai');
  ok('channel yang sedang kumasuki ditandai dengan tombol Keluar dan namaku tampil "Kamu"');

  // buat channel
  state.vc = null; vm.runInContext('render()', ctx);
  await click('new');
  assert.strictEqual(els.vmodal.style.display, 'flex');
  els.vname.value = '   '; calls.length = 0; await els.vok.onclick();
  assert.strictEqual(calls.length, 0, 'nama kosong tidak dikirim'); assert.strictEqual(els.toast.textContent, 'Isi nama channel');
  els.vname.value = '  Ngobrol  '; els.vlock.checked = true; calls.length = 0; await els.vok.onclick();
  assert.strictEqual(JSON.stringify(calls[0]), JSON.stringify(['vcCreate', GID, 'Ngobrol', true, []]));
  assert.strictEqual(els.vmodal.style.display, 'none');
  failErr = 'Channel sudah penuh (maksimal 20 per grup)'; els.vmodal.style.display = 'flex'; els.vname.value = 'x'; await els.vok.onclick(); failErr = null;
  assert.strictEqual(els.vmodal.style.display, 'flex', 'gagal: modal tetap terbuka'); assert(/penuh/.test(els.toast.textContent));
  els.vcancel.onclick(); assert.strictEqual(els.vmodal.style.display, 'none');
  ok('buat channel: nama dipangkas, kosong ditolak, kunci diteruskan, galat Core ditampilkan dan modal tetap terbuka');

  // kelola channel: nama, kunci, daftar izin
  const OMAR = '4'.repeat(16), ADM = '5'.repeat(16);
  const G = state.groups[0];
  G.members = [{ id: ME, name: 'Saya' }, { id: BU, name: 'Budi' }, { id: AN, name: 'Ani' }, { id: OMAR, name: 'Omar <i>' }, { id: ADM, name: 'Admin' }]; G.admins = [ADM];
  G.channels = [ch(C3, 'Punyaku', { by: ME, canManage: true, locked: true, allow: [AN] }), ch(C1, 'Orang lain', { canManage: false })];
  vm.runInContext('render()', ctx);
  const allowRow = (id) => { const html = els.vallow.innerHTML, i = html.indexOf('data-id="' + id + '"'); return i < 0 ? null : html.slice(html.lastIndexOf('<label', i), html.indexOf('</label>', i)); };
  await click('edit', C3);
  assert.strictEqual(els.vmodal.style.display, 'flex'); assert.strictEqual(els.vtitle.textContent, 'Kelola channel'); assert.strictEqual(els.vok.textContent, 'Simpan');
  assert.strictEqual(els.vname.value, 'Punyaku'); assert.strictEqual(els.vlock.checked, true); assert.strictEqual(els.vallowbox.style.display, 'block', 'terkunci: daftar izin tampil');
  assert(!allowRow(ME), 'pembuat channel tidak ada di daftar (selalu boleh)');
  assert(/checked/.test(allowRow(AN)) && !/disabled/.test(allowRow(AN)), 'yang sudah diizinkan tercentang');
  assert(!/checked/.test(allowRow(OMAR)), 'yang belum diizinkan tidak tercentang');
  assert(/checked disabled/.test(allowRow(ADM)) && /admin: selalu bisa/.test(allowRow(ADM)), 'admin: tercentang, terkunci, diberi keterangan');
  assert(/checked disabled/.test(allowRow(BU)) && /pemilik: selalu bisa/.test(allowRow(BU)), 'pemilik grup (Budi): tercentang, terkunci, diberi keterangan');
  ok('Kelola membuka modal berisi nama, kunci, dan daftar anggota (pembuat tidak ditampilkan; yang sudah diizinkan tercentang; admin terkunci)');
  assert(els.vallow.innerHTML.includes('Omar &lt;i&gt;') && !els.vallow.innerHTML.includes('<i>'), 'nama anggota di-escape');
  ok('nama anggota di-escape; pemilik grup dan admin ditandai \"selalu bisa\"');

  // ubah: centang Omar, cabut Ani, ganti nama
  await els.vallow.onchange({ target: { dataset: { id: OMAR }, checked: true } });
  await els.vallow.onchange({ target: { dataset: { id: AN }, checked: false } });
  await els.vallow.onchange({ target: { dataset: {}, checked: true } }); // bukan kotak centang anggota: diabaikan
  els.vname.value = '  Rapat besar '; calls.length = 0; await els.vok.onclick();
  assert.strictEqual(JSON.stringify(calls), JSON.stringify([['vcUpdate', GID, C3, { name: 'Rapat besar', locked: true, allow: [OMAR] }]]), 'nama, kunci, dan izin terkirim; Ani dicabut, Omar ditambah');
  assert.strictEqual(els.vmodal.style.display, 'none');
  ok('simpan: ganti nama + tambah Omar + cabut Ani dikirim sebagai satu vcUpdate; modal menutup');

  // tanpa perubahan: tidak ada panggilan (versi tidak naik)
  await click('edit', C3); calls.length = 0; await els.vok.onclick();
  assert.strictEqual(calls.length, 0, 'tidak berubah: tidak ada vcUpdate'); assert.strictEqual(els.vmodal.style.display, 'none');
  // id lama yang sudah bukan anggota tidak dihitung sebagai perubahan dan tidak dikirim
  G.channels[0].allow = [AN, 'e'.repeat(16)]; vm.runInContext('render()', ctx);
  await click('edit', C3); calls.length = 0; await els.vok.onclick();
  assert.strictEqual(calls.length, 0, 'id non-anggota di allow lama diabaikan, tetap tidak ada perubahan');
  await click('edit', C3); await els.vallow.onchange({ target: { dataset: { id: OMAR }, checked: true } }); calls.length = 0; await els.vok.onclick();
  assert.deepStrictEqual(calls[0][3].allow.includes('e'.repeat(16)), false, 'id non-anggota tidak ikut terkirim (Core menolak daftar yang berisi non-anggota)');
  ok('tanpa perubahan tidak mengirim apa pun; id non-anggota di daftar lama disaring');

  // orang yang kemudian dijadikan admin masih ada di allow lama: membuka lalu menyimpan tanpa mengubah apa pun tidak mengirim pembaruan
  G.channels[0].allow = [AN, ADM]; vm.runInContext('render()', ctx);
  await click('edit', C3); calls.length = 0; await els.vok.onclick();
  assert.strictEqual(calls.length, 0, 'admin di allow lama: bukan perubahan');
  await click('edit', C3); await els.vallow.onchange({ target: { dataset: { id: ADM }, checked: true } }); await els.vallow.onchange({ target: { dataset: { id: AN }, checked: false } }); calls.length = 0; await els.vok.onclick();
  assert.deepStrictEqual(calls[0][3].allow, [], 'admin dan pemilik tidak pernah ikut dikirim di daftar izin');
  G.channels[0].allow = [AN]; vm.runInContext('render()', ctx);
  ok('admin yang sudah ada di allow lama tidak dihitung sebagai perubahan dan tidak dikirim');

  // buka kunci: daftar disembunyikan tetapi pilihan tetap diingat
  await click('edit', C3); els.vlock.checked = false; els.vlock.onchange(); assert.strictEqual(els.vallowbox.style.display, 'none');
  calls.length = 0; await els.vok.onclick();
  assert.strictEqual(calls[0][3].locked, false); assert.strictEqual(calls[0][0], 'vcUpdate');
  ok('mencabut centang Terkunci menyembunyikan daftar izin dan membuka kunci');

  // gagal: modal tetap terbuka; channel hilang/hak dicabut saat modal terbuka
  await click('edit', C3); els.vname.value = 'Baru'; failErr = 'Hanya pembuat channel atau admin yang boleh mengubahnya'; await els.vok.onclick(); failErr = null;
  assert.strictEqual(els.vmodal.style.display, 'flex', 'gagal: modal tetap terbuka'); assert(/Hanya pembuat/.test(els.toast.textContent));
  G.channels[0].canManage = false; vm.runInContext('render()', ctx); calls.length = 0; await els.vok.onclick();
  assert.strictEqual(calls.length, 0, 'hak dicabut saat modal terbuka: tidak mengirim'); assert.strictEqual(els.vmodal.style.display, 'none'); assert(/tak lagi boleh mengelola/.test(els.toast.textContent));
  G.channels = [ch(C3, 'Punyaku', { by: ME, canManage: true, locked: true })]; vm.runInContext('render()', ctx);
  await click('edit', C3); G.channels = []; vm.runInContext('render()', ctx); calls.length = 0; await els.vok.onclick();
  assert.strictEqual(calls.length, 0, 'channel dihapus saat modal terbuka: tidak mengirim');
  ok('gagal menyimpan: modal tetap terbuka dengan toast; channel dihapus atau hak dicabut saat modal terbuka: ditutup tanpa mengirim');

  // buat channel terkunci dengan daftar izin awal; admin dan aku tidak ikut daftar
  G.channels = [ch(C3, 'Punyaku', { by: ME, canManage: true })]; G.creator = BU; vm.runInContext('render()', ctx);
  await click('new'); assert.strictEqual(els.vtitle.textContent, 'Channel suara baru'); assert.strictEqual(els.vok.textContent, 'Buat'); assert.strictEqual(els.vallowbox.style.display, 'none', 'channel baru terbuka: daftar izin tersembunyi');
  assert(!allowRow(ME), 'pembuat baru (aku) tidak ada di daftar');
  els.vname.value = 'Rahasia'; els.vlock.checked = true; els.vlock.onchange();
  await els.vallow.onchange({ target: { dataset: { id: AN }, checked: true } }); await els.vallow.onchange({ target: { dataset: { id: 'f'.repeat(16) }, checked: true } });
  calls.length = 0; await els.vok.onclick();
  assert.strictEqual(JSON.stringify(calls[0]), JSON.stringify(['vcCreate', GID, 'Rahasia', true, [AN]]), 'daftar izin awal terkirim; id asing tidak');
  await click('edit', C3); await click('new'); assert.strictEqual(els.vname.value, '', 'modal buat tidak mewarisi isi modal kelola'); assert.strictEqual(els.vlock.checked, false);
  await els.vallow.onchange({ target: { dataset: { id: OMAR }, checked: true } }); els.vcancel.onclick(); await click('new'); assert(!/checked/.test(allowRow(OMAR)), 'pilihan lama tidak bocor ke modal berikutnya');
  els.vcancel.onclick();
  ok('buat channel terkunci langsung dengan daftar izin; modal tidak mewarisi isi sebelumnya');

  // lipat + daftar kosong
  await click('fold'); assert.strictEqual(bar.className, 'vcfold'); assert.strictEqual(storage['lc.vcfold'], '1');
  await click('fold'); assert.strictEqual(bar.className, ''); assert.strictEqual(storage['lc.vcfold'], '0');
  state.groups[0].channels = []; vm.runInContext('render()', ctx);
  assert(bar.innerHTML.includes('Belum ada channel') && bar.innerHTML.includes('Channel suara · 0') && bar.innerHTML.includes('+ Channel'));
  // grup dihapus / pindah ke publik: strip tersembunyi lagi
  vm.runInContext("cur = 'public'; render();", ctx);
  assert.strictEqual(bar.style.display, 'none'); assert.strictEqual(bar.innerHTML, '');
  ok('lipat/buka (diingat), daftar kosong tetap menawarkan "+ Channel", chat publik menyembunyikan strip');

  console.log('\n' + pass + ' skenario lolos');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

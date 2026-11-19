'use strict';
// Tes UI sematan pesan (v0.20.0, pin5): skrip asli archne-index.html di vm dengan DOM tiruan (seperti test/pvui.js).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const html = require('./_src').htmlSrc();
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const ME = '1'.repeat(16), BU = '2'.repeat(16), AN = '3'.repeat(16), GID = 'a'.repeat(16), G = 'g:' + GID;
const M1 = 'e1'.repeat(16), M2 = 'e2'.repeat(16), M3 = 'e3'.repeat(16), PA = '1'.repeat(10) + 'aaaaaa', PB = '1'.repeat(10) + 'bbbbbb', PC = '2'.repeat(10) + 'cccccc', PD = '1'.repeat(10) + 'dddddd';

(async () => {
  // ---- A. struktur statis ----
  assert(/id="semtext" maxlength="10000"/.test(html), 'kolom pengumuman menerima sampai 10.000 karakter (sama dengan batas salinan)');
  for (const id of ['sembar', 'semmodal', 'semtitle', 'semprev', 'semtext', 'semscope', 'semsh', 'semshl', 'semme', 'semhint', 'semerr', 'semok', 'semcancel', 'sembtn']) assert(new RegExp('id="' + id + '"').test(html), 'elemen ' + id);
  assert(/<div id="pvbar"><\/div>\s*<div id="sembar"><\/div>\s*<div id="msgs">/.test(html), 'sembar tepat di atas pesan');
  assert(/#sembar\{[^}]*max-height:28vh;[^}]*overflow:auto/.test(html), 'strip punya tinggi maksimum dan scroll sendiri');
  assert(/#sembar \.vch-h\{[^}]*position:sticky/.test(html), 'header menempel saat di-scroll');
  assert(/#sembar\.vcfold \.sem\{display:none\}/.test(html), 'dilipat: baris sematan disembunyikan (CSS)');
  for (const id of ['semview', 'semvt', 'semvb', 'semvn', 'semvgo', 'semvx', 'semvx2']) assert(new RegExp('id="' + id + '"').test(html), 'elemen ' + id);
  assert(/#semview\{[^}]*position:fixed;inset:0;[^}]*z-index:40/.test(html), 'tampilan penuh menutupi layar');
  assert(/#semvb\{[^}]*flex:1;overflow:auto/.test(html), 'isi bisa di-scroll sendiri');
  const sec = html.slice(html.indexOf('// ---- Sematan pesan (v0.20.0, pin5)'), html.indexOf('// ---- Channel suara publik (v0.20.0, pvch6)'));
  const semHtml = html.slice(html.indexOf('<div id="semmodal"'), html.indexOf('<div id="vmodal"'));
  const visible = (sec.match(/'[^']*'|`[^`]*`/g) || []).join(' ').replace(/\$\{[^}]*\}/g, '') + semHtml.replace(/<[^>]+>/g, ' ');
  assert(!/\bpin\b/i.test(visible.replace(/\bsemmodal|data-sact|lc\.semfold|IC\.pin/g, '')), 'teks UI sematan tidak memakai kata "Pin"');
  assert(/Sematkan/.test(visible) && /Sematan/.test(visible), 'memakai kata Sematan/Sematkan');
  ok('elemen ada, strip punya tinggi maksimum + scroll + header menempel, UI memakai "Sematan" bukan "Pin"');

  const inline = require('./_src').inlineJs();
  const els = {};
  const mkEl = (id) => ({ id, innerHTML: '', className: '', textContent: '', value: '', checked: false, style: {}, dataset: {}, disabled: false, scrollTop: 0, clientHeight: 0, scrollHeight: 0, handlers: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); }, focus() {}, requestSubmit() {} });
  const calls = []; let state, failErr = null, confirmAns = true, storage = {}, confirms = [];
  const api = new Proxy({}, { get: (_t, n) => {
    if (n === 'state') return async () => state;
    if (n === 'pickFiles') return async () => [];
    if (n === 'pathOf') return () => '';
    if (n === 'onUpdate' || n === 'onPvKick' || n === 'onPvPres') return () => {};
    return async (...a) => { calls.push([n, ...a]); return failErr ? { ok: false, err: failErr } : { ok: true }; };
  } });
  const keys = [];
  const doc = { addEventListener: (t, fn) => { if (t === 'keydown') keys.push(fn); }, getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null, querySelector: () => null };
  const ctx = { window: { api }, document: doc, CSS: { escape: (s) => s }, FileCard: require('../renderer/archne-filecard'), MsgMenu: require('../renderer/archne-msgmenu'), Avatar: require('../renderer/archne-avatar'), confirm: (t) => { confirms.push(t); return confirmAns; }, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, Date, parseInt, Set, Math, JSON,
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = v; } } };
  vm.createContext(ctx);
  for (const id of ['semmodal', 'semtitle', 'semprev', 'semtext', 'semscope', 'semsh', 'semshl', 'semme', 'semhint', 'semerr', 'semok', 'semcancel', 'sembtn', 'msgs', 'head', 'toast', 'semview', 'semvt', 'semvb', 'semvn', 'semvgo', 'semvx', 'semvx2']) doc.getElementById(id);
  const now = Date.now();
  const msgs = [
    { id: M1, from: BU, to: G, ts: now - 3000, name: 'Budi', text: 'rapat jam 9', status: null },
    { id: M2, from: ME, to: G, ts: now - 2000, name: 'Saya', text: 'siap', status: 'delivered' },
    { id: M3, from: AN, to: G, ts: now - 1000, name: 'Ani', text: 'ini <b>tebal</b>', status: null }];
  const rec = (id, o) => Object.assign({ id, kind: 'msg', text: 't', from: BU, name: 'Budi', at: now - 3000, mid: M1, ts: now, by: ME, shared: true, canRemove: true, canEdit: false }, o);
  const group = (admin) => ({ id: GID, name: 'Tim', creator: admin ? ME : BU, admins: [], members: [{ id: ME, name: 'Saya' }, { id: BU, name: 'Budi' }, { id: AN, name: 'Ani' }], epoch: 1, removed: false, channels: [], leaving: [] });
  const base = (admin, pins) => ({ me: { id: ME, name: 'Saya', port: 1 }, peers: [{ id: BU, name: 'Budi', online: true, secure: true }, { id: AN, name: 'Ani', online: true, secure: true }], limits: { maxText: 10000, pin: { max: 100, text: 500 } }, sending: [], messages: msgs, vc: null, groups: [group(admin)], pv: { me: null, channels: [] }, pins: pins || {} });
  const pinsA = { [G]: { canShare: true,
    shared: [rec(PA, { text: 'rapat jam 9', ts: now - 10 }), rec(PB, { kind: 'note', text: 'Aturan: <b>jangan</b> spam', from: ME, name: 'Saya', mid: '', ts: now - 5, canEdit: true }), rec(PC, { by: BU, text: 'dari admin lain', from: AN, name: 'Ani', mid: M3, ts: now - 20 })],
    mine: [rec(PD, { text: 'catatan pribadi', shared: false, kind: 'note', mid: '', from: ME, ts: now - 1, canEdit: true })] } };
  state = base(true, pinsA);
  vm.runInContext(inline, ctx);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  const refresh = async () => { await vm.runInContext('refresh()', ctx); };
  const go = async (chat) => { vm.runInContext("cur = '" + chat + "'; emptyTab = false; render();", ctx); };
  const bar = els.sembar, out = () => bar.innerHTML;
  const sclick = async (act, sid) => { calls.length = 0; await bar.onclick({ target: { closest: (sel) => (sel === '[data-sact]' ? { dataset: { sact: act } } : sel === '[data-sid]' ? (sid ? { dataset: { sid } } : null) : null) }, stopPropagation() {} }); return JSON.parse(JSON.stringify(calls)); };
  const mclick = async (mid) => { calls.length = 0; await vm.runInContext('semPinMsg(' + JSON.stringify(mid) + ')', ctx); return JSON.parse(JSON.stringify(calls)); }; // sama dengan butir "Sematkan" di menu aksi pesan (js/archne-msgmenu.js)
  const row = (pid) => { const o = out(), i = o.indexOf('data-sid="' + pid + '"'), j = o.indexOf('class="sem"', i + 1); return o.slice(i, j > 0 ? j : undefined); };

  // ---- B. strip di grup (admin): dilipat bawaan = satu baris jumlah + terbaru; buka = daftar; diingat ----
  await go(G);
  assert.strictEqual(bar.style.display, 'block');
  assert(out().includes('Sematan · 4'), 'jumlah gabungan bersama + pribadi');
  assert.strictEqual(bar.className, 'vcfold', 'bawaan dilipat');
  assert(/semlast"> · catatan pribadi</.test(out()), 'dilipat: sematan terbaru');
  assert(/aria-expanded="false"/.test(out()));
  await sclick('fold');
  assert.strictEqual(bar.className, ''); assert(/aria-expanded="true"/.test(out())); assert.strictEqual(storage['lc.semfold'], '0', 'pilihan buka diingat');
  const order = [PD, PB, PA, PC].map((p) => out().indexOf('data-sid="' + p + '"'));
  assert(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), 'terbaru di atas, bersama dan pribadi tercampur menurut waktu');
  assert(out().includes('Aturan: &lt;b&gt;jangan&lt;/b&gt; spam') && !out().includes('<b>jangan'), 'teks di-escape');
  assert(/semua anggota/.test(row(PA)) && /pribadi/.test(row(PD)), 'penanda bersama / pribadi');
  assert(/disematkan Budi/.test(row(PC)), 'bila dipasang orang lain: namanya tampil');
  assert(/data-sact="go"/.test(row(PA)) && !/data-sact="go"/.test(row(PB)), 'Lompat hanya untuk sematan pesan, bukan pengumuman');
  assert(/data-sact="edit"/.test(row(PB)) && !/data-sact="edit"/.test(row(PA)), 'Ubah hanya untuk pengumuman');
  assert(/data-sact="del"/.test(row(PA)));
  await sclick('fold'); assert.strictEqual(storage['lc.semfold'], '1');
  await sclick('fold');
  state = base(false, { [G]: { canShare: false, shared: pinsA[G].shared.map((r) => Object.assign({}, r, { canRemove: false, canEdit: false })), mine: pinsA[G].mine } });
  await refresh();
  assert(!/data-sact="del"/.test(row(PA)) && !/data-sact="edit"/.test(row(PB)), 'member: sematan bersama tanpa Lepas/Ubah');
  assert(/data-sact="del"/.test(row(PD)) && /data-sact="edit"/.test(row(PD)), 'member: sematan pribadinya bisa dilepas dan diubah');
  state = base(true, pinsA); await refresh();
  ok('strip: dilipat = jumlah + terbaru, buka/lipat diingat, urutan terbaru, escape, penanda, tombol sesuai hak (admin vs member)');

  // ---- C. tombol di pesan ----
  const msgHtml = els.msgs.innerHTML;
  assert((msgHtml.match(/class=\"mmore\" data-menu="/g) || []).length === 3, 'tiap pesan punya tombol ⋯ (menu aksi)');
  assert(!/macts|data-sem=|data-reply=|data-del=/.test(msgHtml), 'tidak ada lagi bar tombol melayang di gelembung');
  ok('tiap pesan punya tombol ⋯; bar tombol melayang sudah tidak ada (butir menu dites di archne-msgmenu.js)');

  // ---- D. menyematkan pesan: pilihan Untuk semua / Untuk saya saja ----
  assert.deepStrictEqual(await mclick(M1), [], 'sudah disematkan: tidak membuka dialog / memanggil API');
  assert(/sudah disematkan/.test(els.toast.textContent));
  assert.notStrictEqual(els.semmodal.style.display, 'flex');
  await mclick(M2);
  assert.strictEqual(els.semmodal.style.display, 'flex'); assert.strictEqual(els.semprev.textContent, 'siap'); assert.strictEqual(els.semtext.style.display, 'none');
  assert.strictEqual(els.semscope.style.display, 'block'); assert.strictEqual(els.semshl.textContent, 'Untuk semua anggota');
  assert(els.semme.checked && !els.semsh.checked, 'pesan: bawaannya pribadi');
  calls.length = 0; await els.semok.onclick();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [['pinAdd', G, M2, false]]); assert.strictEqual(els.semmodal.style.display, 'none');
  await mclick(M2); els.semsh.checked = true; els.semme.checked = false; calls.length = 0; await els.semok.onclick();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [['pinAdd', G, M2, true]], 'dipilih untuk semua');
  failErr = 'Sudah ada 100 sematan. Lepas salah satu dulu.';
  await mclick(M2); await els.semok.onclick();
  assert.strictEqual(els.semmodal.style.display, 'flex', 'galat: dialog tetap terbuka'); assert(els.semerr.textContent.includes('100 sematan'));
  failErr = null; await els.semcancel.onclick();
  assert.strictEqual(els.semmodal.style.display, 'none');
  ok('menyematkan pesan: dialog pratinjau, pilihan semua / pribadi (bawaan pribadi), galat tampil di dialog');

  // ---- E. pengumuman bebas, ubah, lepas, lompat ----
  await els.sembtn.onclick(); assert.strictEqual(els.semtitle.textContent, 'Tulis sematan', 'menu Tulis sematan membuka dialog pengumuman'); assert.strictEqual(els.semmodal.style.display, 'flex');
  assert(els.semsh.checked && !els.semme.checked, 'pengumuman: bawaannya untuk semua'); assert.strictEqual(els.semtext.style.display, 'block'); assert.strictEqual(els.semprev.style.display, 'none');
  els.semtext.value = '   '; calls.length = 0; await els.semok.onclick();
  assert.strictEqual(calls.length, 0); assert(/Isi teks/.test(els.semerr.textContent), 'teks kosong ditolak di UI');
  els.semtext.value = '  Rapat dipindah ke jam 10  '; await els.semok.onclick();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [['pinNote', G, 'Rapat dipindah ke jam 10', true]]);
  let c = await sclick('edit', PB); assert.deepStrictEqual(c, []);
  assert.strictEqual(els.semtitle.textContent, 'Ubah sematan'); assert.strictEqual(els.semtext.value, 'Aturan: <b>jangan</b> spam'); assert.strictEqual(els.semscope.style.display, 'none', 'ubah: lingkup tidak bisa diganti');
  els.semtext.value = 'Aturan baru'; calls.length = 0; await els.semok.onclick();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [['pinEdit', G, PB, 'Aturan baru']]);
  confirmAns = false; confirms.length = 0;
  c = await sclick('del', PA); assert(!c.some((x) => x[0] === 'pinRemove') && confirms.length === 1 && /semua orang/.test(confirms[0]), 'melepas sematan bersama minta konfirmasi');
  confirmAns = true; c = await sclick('del', PA); assert.deepStrictEqual(c.filter((x) => x[0] === 'pinRemove'), [['pinRemove', G, PA]]);
  confirms.length = 0; c = await sclick('del', PD); assert.deepStrictEqual(c.filter((x) => x[0] === 'pinRemove'), [['pinRemove', G, PD]]); assert.strictEqual(confirms.length, 0, 'sematan pribadi tanpa konfirmasi');
  await sclick('go', PA); assert(/tidak ada di tampilan/.test(els.toast.textContent), 'lompat ke pesan yang tidak ada: pemberitahuan, bukan galat');
  ok('pengumuman bebas (bawaan untuk semua, kosong ditolak), ubah, lepas (konfirmasi hanya untuk bersama), lompat');

  // ---- F. member, DM, Publik ----
  state = base(false, {}); await refresh();
  assert.strictEqual(bar.style.display, 'none', 'tanpa sematan: strip tersembunyi');
  assert(els.head.innerHTML.includes('id="sembtn"'), 'menu Tulis sematan tetap ada');
  await mclick(M1);
  assert.strictEqual(els.semscope.style.display, 'none', 'member: tanpa pilihan semua'); assert(/Hanya admin dan pemilik/.test(els.semhint.textContent));
  els.semsh.checked = true; // radio tersembunyi dipaksa tercentang: tetap harus pribadi
  calls.length = 0; await els.semok.onclick(); assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [['pinAdd', G, M1, false]], 'member selalu pribadi');
  state.messages = msgs.concat([{ id: 'd1'.repeat(16), from: BU, to: ME, ts: now, name: 'Budi', text: 'no rek 123', status: null }]); await refresh();
  await go(BU);
  await mclick('d1'.repeat(16));
  assert.strictEqual(els.semscope.style.display, 'block'); assert.strictEqual(els.semshl.textContent, 'Untuk berdua', 'DM: Untuk berdua');
  await els.semcancel.onclick();
  await go('public');
  state.messages = msgs.concat([{ id: 'f1'.repeat(16), from: BU, to: 'public', ts: now, name: 'Budi', text: 'halo semua', status: null }]); await refresh();
  await mclick('f1'.repeat(16));
  assert.strictEqual(els.semscope.style.display, 'none'); assert(/tab Publik sematan hanya untuk dirimu/.test(els.semhint.textContent));
  calls.length = 0; await els.semok.onclick(); assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [['pinAdd', 'public', 'f1'.repeat(16), false]]);
  ok('member: selalu pribadi; DM: "Untuk berdua"; Publik: hanya pribadi; tanpa sematan strip tersembunyi tapi menu Tulis sematan ada');

  // ---- F2. teks panjang: Baca selengkapnya -> tampilan penuh (layar penuh, scroll, Tutup), tidak bergantung pada pesan asli ----
  const LONG = 'Paragraf pertama pengumuman yang cukup panjang. '.repeat(8) + '\nBaris dua <b>tanpa HTML</b>\n\nBaris empat\nBaris lima';
  const PL = '1'.repeat(10) + 'eeeeee', PS = '1'.repeat(10) + 'ffffff', PG = '1'.repeat(10) + 'gggggg';
  state = base(true, { [G]: { canShare: true, mine: [], shared: [
    rec(PL, { kind: 'note', text: LONG, from: ME, name: 'Saya', mid: '', ts: now, canEdit: true }),
    rec(PS, { kind: 'note', text: 'pendek saja', from: ME, mid: '', ts: now - 5 }),
    rec('1'.repeat(10) + 'hhhhhh', { kind: 'note', text: 'x'.repeat(200), from: ME, mid: '', ts: now - 6 }),
    rec('1'.repeat(10) + 'iiiiii', { kind: 'note', text: 'y'.repeat(160), from: ME, mid: '', ts: now - 7 }),
    rec(PG, { text: 'salinan pesan yang sudah dihapus', mid: 'ab'.repeat(16), ts: now - 9 })] } });
  await go(G); await refresh();
  assert(/data-sact="more">Baca selengkapnya/.test(row(PL)), 'teks panjang: ada Baca selengkapnya');
  assert(!/Baca selengkapnya/.test(row(PS)), 'teks pendek: tanpa tautan');
  assert(/Baca selengkapnya/.test(row('1'.repeat(10) + 'hhhhhh')), 'satu baris 200 karakter: panjang karena melebihi batas');
  assert(!/Baca selengkapnya/.test(row('1'.repeat(10) + 'iiiiii')), 'tepat 160 karakter satu baris: belum panjang');
  assert.strictEqual(els.semview.style.display, undefined, 'tertutup bawaan');
  await sclick('more', PL);
  assert.strictEqual(els.semview.style.display, 'flex', 'layar penuh terbuka'); assert.strictEqual(els.semvb.textContent, LONG, 'isi utuh, tidak terpotong, apa adanya (tanpa HTML)');
  assert.strictEqual(els.semvn.style.display, 'none'); assert.strictEqual(els.semvgo.style.display, 'none', 'pengumuman: tanpa Lompat');
  assert.strictEqual(els.semvt.textContent, 'Pengumuman');
  await els.semvx.onclick(); assert.strictEqual(els.semview.style.display, 'none', 'tombol Tutup');
  await sclick('more', PL); await els.semvx2.onclick(); assert.strictEqual(els.semview.style.display, 'none', 'tombol Tutup di bawah');
  await sclick('more', PL); keys.forEach((f) => f({ key: 'a' })); assert.strictEqual(els.semview.style.display, 'flex', 'tombol lain tidak menutup');
  keys.forEach((f) => f({ key: 'Escape' })); assert.strictEqual(els.semview.style.display, 'none', 'Escape menutup');
  await sclick('more', PS); assert.strictEqual(els.semvb.textContent, 'pendek saja', 'ketuk teks pendek pun membuka tampilan penuh'); await els.semvx.onclick();
  // pesan asli sudah tidak ada (dibatalkan / dibersihkan): Lompat membuka tampilan penuh dengan keterangan, bukan galat
  assert(!state.messages.some((m) => m.id === 'ab'.repeat(16)));
  els.toast.textContent = '';
  await sclick('go', PG);
  assert.strictEqual(els.semview.style.display, 'flex', 'pesan asli hilang: Lompat membuka tampilan penuh'); assert.strictEqual(els.semvb.textContent, 'salinan pesan yang sudah dihapus');
  assert.strictEqual(els.semvn.style.display, 'block'); assert(/sudah tidak ada/.test(els.semvn.textContent)); assert.strictEqual(els.semvgo.style.display, 'none'); assert.strictEqual(els.toast.textContent, '', 'bukan galat/toast');
  await els.semvx.onclick();
  // pesan asli masih ada: dari tampilan penuh ada Lompat
  state = base(true, pinsA); await refresh();
  await sclick('more', PA); assert.strictEqual(els.semvgo.style.display, 'inline-block'); assert.strictEqual(els.semvn.style.display, 'none');
  assert(/Budi/.test(els.semvt.textContent));
  await els.semvgo.onclick(); assert.strictEqual(els.semview.style.display, 'none', 'Lompat menutup tampilan penuh');
  assert(/tidak ada di tampilan/.test(els.toast.textContent), 'lalu menuju pesan (di DOM tiruan tidak ada elemennya)');
  ok('teks panjang: Baca selengkapnya -> layar penuh (isi utuh, scroll, Tutup/Esc); Lompat ke pesan yang sudah hilang membuka tampilan penuh dengan keterangan');

  // ---- G. pindah chat saat dialog terbuka membatalkan ----
  await go(G); await mclick(M2); await go('public'); calls.length = 0; await els.semok.onclick();
  assert.strictEqual(calls.length, 0, 'tidak menyematkan ke chat yang salah'); assert.strictEqual(els.semmodal.style.display, 'none');
  ok('pindah chat saat dialog terbuka: dibatalkan, tidak menyematkan di chat yang salah');

  console.log('\n' + pass + ' tes UI sematan lulus');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

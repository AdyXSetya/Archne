'use strict';
// Tes menu aksi pesan (v0.24.0): renderer/archne-msgmenu.js (butir + penempatan, murni), glue js/archne-msgmenu.js (vm), dan kontrak markup/CSS.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const MM = require('../renderer/archne-msgmenu');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const acts = (its) => its.map((i) => i.act);

(async () => {

// ---- 1. butir menu ----
assert.deepStrictEqual(acts(MM.items({ text: 'hai' }, { mine: false, pinned: false })), ['reply', 'pin', 'copy']);
assert.deepStrictEqual(acts(MM.items({ text: 'hai' }, { mine: true, pinned: false })), ['reply', 'pin', 'copy', 'del'], 'Batalkan hanya untuk pesanku dan selalu terakhir');
assert.strictEqual(MM.items({ text: 'hai' }, { pinned: true }).find((i) => i.act === 'pin').disabled, true, 'sudah disematkan: butir nonaktif');
assert(!acts(MM.items({ text: 'x', file: { name: 'a.zip' } }, {})).includes('copy'), 'pesan berkas: tanpa Salin teks');
assert(!acts(MM.items({ text: '' }, {})).includes('copy'));
assert(MM.items({ text: 'a' }, { mine: true }).find((i) => i.act === 'del').danger === true);
const h = MM.html(MM.items({ text: '<b>' }, { mine: true, pinned: true }));
assert(/data-mm="reply"/.test(h) && /data-mm="del"/.test(h) && /class="mmi dng"/.test(h) && /data-mm="pin" disabled/.test(h));
{ const pv = MM.preview({ text: '<u>x</u>' }, '<i>Budi</i>'); assert(!/<u>|<i>/.test(pv) && pv.includes('&lt;u&gt;x&lt;/u&gt;') && pv.includes('&lt;i&gt;Budi'), 'cuplikan di-escape'); }
assert(MM.preview({ text: 'a'.repeat(500) }, 'X').length < 400, 'cuplikan dipotong');
assert(MM.preview({ file: { name: 'a.zip' } }, 'X').includes('a.zip'));
ok('butir menu: urutan, hak (Batalkan hanya milikku), nonaktif bila sudah disematkan, tanpa Salin untuk berkas, escape');

// ---- 2. penempatan: selalu di dalam layar, tidak menutupi jangkar bila ada ruang ----
const vp = { w: 1000, h: 700 }, sz = { w: 220, h: 180 };
const inside = (p) => p.left >= 8 && p.top >= 8 && p.left + sz.w <= vp.w - 8 && p.top + sz.h <= vp.h - 8;
let p = MM.place({ left: 500, right: 520, top: 100, bottom: 120 }, sz, vp);
assert(inside(p) && p.side === 'below' && p.top >= 120, 'ada ruang di bawah: di bawah jangkar');
assert.strictEqual(p.left, 520 - 220, 'rata kanan dengan jangkar');
p = MM.place({ left: 500, right: 520, top: 600, bottom: 620 }, sz, vp);
assert(inside(p) && p.side === 'above' && p.top + sz.h <= 600, 'tidak muat di bawah: membalik ke atas');
p = MM.place({ left: 990, right: 1000, top: 100, bottom: 120 }, sz, vp);
assert(inside(p), 'jangkar di tepi kanan: dijepit');
p = MM.place({ left: 2, right: 12, top: 100, bottom: 120 }, sz, vp);
assert(inside(p) && p.left === 8, 'jangkar di tepi kiri: dijepit');
p = MM.place({ left: 300, right: 300, top: 350, bottom: 350 }, sz, vp, 'start');
assert(inside(p) && p.left === 300, 'klik kanan: mulai dari titik klik');
const tiny = { w: 300, h: 150 };
p = MM.place({ left: 100, right: 120, top: 60, bottom: 80 }, { w: 220, h: 180 }, tiny);
assert(p.top >= 8 && p.top + Math.min(180, tiny.h - 16) <= tiny.h - 8 + 1e-9 && p.side === 'clamped', 'layar sangat pendek: dijepit, tidak keluar layar');
p = MM.place({ left: 756, right: 794, top: 698, bottom: 710 }, sz, vp);
assert(inside(p), 'jangkar sebagian di luar layar (tergulung): tetap di dalam layar');
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; // acak berbenih: hasil sama tiap dijalankan
for (let i = 0; i < 2000; i++) { // acak: tidak pernah keluar layar, termasuk jangkar yang sebagian di luar layar
  const x = rnd() * 1000, y = rnd() * 760 - 30, a = { left: x, right: x + rnd() * 40, top: y, bottom: y + rnd() * 40 };
  assert(inside(MM.place(a, sz, vp, i % 2 ? 'start' : 'end')), 'acak ' + JSON.stringify(a));
}
ok('penempatan: di bawah, membalik ke atas, dijepit di tepi kiri/kanan/atas/bawah, 2000 kasus acak berbenih (termasuk jangkar tergulung) tetap di dalam layar');

// ---- 3. glue (vm): buka, aksi, tutup ----
const mk = (id) => {
  const el = { id, innerHTML: '', className: '', style: {}, dataset: {}, handlers: {}, addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
    getBoundingClientRect: () => ({ width: 220, height: 180 }), querySelector: () => null, querySelectorAll: () => [] };
  el.classList = { add() {}, remove() {}, contains: (c) => el.className.split(' ').includes(c) }; // className e classList seperti di DOM sungguhan
  return el;
};
const els = {}, $ = (id) => els[id] || (els[id] = mk(id));
const log = []; let mmatch = false;
const docH = {}, winH = {}, marked = new Set();
const ctx = { $, S: { me: { id: 'ME' }, messages: [] }, cur: 'g:1', semRows: () => [{ mid: 'PIN' }], semPinMsg: (id) => log.push(['pin', id]), setReply: (m) => log.push(['reply', m.id]), delMsg: async (id) => { log.push(['del', id]); },
  toast: (t) => log.push(['toast', t]), tag: (n) => n, MsgMenu: MM, CSS: { escape: (s) => s }, navigator: { clipboard: { writeText: async (t) => { log.push(['copy', t]); } } },
  document: { addEventListener: (t, fn) => { docH[t] = fn; }, querySelectorAll: () => [], querySelector: () => null, activeElement: null },
  window: { innerWidth: 1000, innerHeight: 700, matchMedia: (q) => ({ matches: mmatch }), addEventListener: (t, fn) => { winH[t] = fn; } }, console };
vm.createContext(ctx);
vm.runInContext(require('./_src').txfJs() + '\n' + rd('renderer', 'js', 'archne-msgmenu.js'), ctx);
ctx.S.messages = [{ id: 'M1', from: 'BU', name: 'Budi', text: 'halo' }, { id: 'M2', from: 'ME', name: 'Saya', text: 'siap' }, { id: 'PIN', from: 'BU', name: 'Budi', text: 'x' }, { id: 'F1', from: 'BU', name: 'Budi', text: '', file: { name: 'a.zip' } }];
const open = (id, a, al) => vm.runInContext(`mmOpen(${JSON.stringify(id)}, ${JSON.stringify(a)}, ${JSON.stringify(al)})`, ctx);
const state = () => vm.runInContext('mmId', ctx);
const click = async (act) => { await $('mmenu').onclick({ target: { closest: () => ({ dataset: { mm: act }, disabled: false }) } }); await new Promise((r) => setImmediate(r)); };
const A = { left: 400, right: 420, top: 100, bottom: 120 };

open('M1', A, 'end');
assert.strictEqual(state(), 'M1'); assert.strictEqual($('mmenu').style.display, 'block'); assert.strictEqual($('mmenu').style.visibility, 'visible');
assert(/data-mm="reply"/.test($('mmenu').innerHTML) && !/data-mm="del"/.test($('mmenu').innerHTML), 'pesan orang lain: tanpa Batalkan');
assert(!$('mmenu').classList.contains('sheet') && $('mmscrim').style.display === 'none' && /px$/.test($('mmenu').style.left));
await click('reply'); assert.deepStrictEqual(log.pop(), ['reply', 'M1']); assert.strictEqual(state(), null, 'memilih butir menutup menu'); assert.strictEqual($('mmenu').style.display, 'none');
open('M2', A, 'end'); await click('del'); assert.deepStrictEqual(log.pop(), ['del', 'M2']);
open('M1', A, 'end'); await click('pin'); assert.deepStrictEqual(log.pop(), ['pin', 'M1']);
open('M1', A, 'end'); await click('copy'); assert.deepStrictEqual(log.splice(0), [['copy', 'halo'], ['toast', 'Teks disalin']]);
open('PIN', A, 'end'); assert(/data-mm="pin" disabled/.test($('mmenu').innerHTML), 'sudah disematkan: nonaktif');
open('F1', A, 'end'); assert(!/data-mm="copy"/.test($('mmenu').innerHTML), 'berkas: tanpa Salin');
ok('glue: popover terbuka di dalam layar, Balas/Sematkan/Salin/Batalkan memanggil fungsi yang tepat dan menutup menu');

mmatch = true;
open('M1', null); assert($('mmenu').classList.contains('sheet') && $('mmscrim').style.display === 'block', 'tanpa jangkar (sentuh): bottom sheet + scrim');
assert(/class="mmh"/.test($('mmenu').innerHTML) && /halo/.test($('mmenu').innerHTML), 'sheet memuat cuplikan pesan');
await $('mmscrim').onclick(); assert.strictEqual(state(), null); assert.strictEqual($('mmscrim').style.display, 'none');
open('M1', null);
docH.keydown({ key: 'Escape', stopPropagation() {} }); assert.strictEqual(state(), null, 'Esc menutup');
docH.mousedown && (open('M1', A, 'end'), docH.mousedown({ target: { closest: () => null } }), assert.strictEqual(state(), null, 'klik di luar menutup popover'));
open('M1', null); docH.mousedown({ target: { closest: () => null } }); assert.strictEqual(state(), 'M1', 'sheet tidak ditutup di mousedown (ketukan tidak boleh tembus)');
vm.runInContext('mmClose()', ctx);
open('M1', A, 'end'); ctx.S.messages = ctx.S.messages.filter((m) => m.id !== 'M1'); vm.runInContext('mmSync()', ctx); assert.strictEqual(state(), null, 'pesan hilang -> menu menutup');
ctx.S.messages.push({ id: 'M1', from: 'BU', name: 'Budi', text: 'halo' }); open('M1', A, 'end'); ctx.cur = 'g:2'; vm.runInContext('cur = "g:2"; mmSync()', ctx); assert.strictEqual(state(), null, 'pindah chat -> menu menutup');
ok('glue: sheet + scrim di layar sentuh, Esc/klik luar/scrim menutup, ketukan tidak tembus, hilang/pindah chat menutup');

// resize: papan ketik Android hanya mengubah TINGGI jendela. Dulu setiap resize menutup menu, jadi picker ➕ menutup dirinya (dan papan ketiknya) begitu kolom emoji fokus.
const inMenu = { closest: (sel) => (/#mmenu/.test(sel) ? {} : null) }, resize = (w, h) => { ctx.window.innerWidth = w; ctx.window.innerHeight = h; winH.resize(); };
mmatch = true; open('M1', null); ctx.document.activeElement = inMenu; resize(1000, 380);
assert.strictEqual(state(), 'M1', 'sheet + kolom emoji fokus + papan ketik muncul: tetap terbuka'); ctx.document.activeElement = null; resize(1000, 700);
assert.strictEqual(state(), 'M1', 'sheet: papan ketik turun/naik (tinggi saja) tidak menutup'); resize(700, 1000);
assert.strictEqual(state(), null, 'sheet: lebar berubah (putar layar) menutup');
ctx.document.activeElement = null; resize(1000, 700); // kembali ke tegak (menu sudah tertutup)
mmatch = false; open('M1', A, 'end'); ctx.document.activeElement = inMenu; resize(700, 380);
assert.strictEqual(state(), null, 'popover: lebar berubah menutup walau sedang mengetik'); resize(1000, 700);
open('M1', A, 'end'); ctx.document.activeElement = inMenu; resize(1000, 400);
assert.strictEqual(state(), 'M1', 'popover: sedang mengetik di kolom emoji, hanya tinggi berubah: tetap terbuka');
ctx.document.activeElement = null; resize(1000, 700); assert.strictEqual(state(), null, 'popover: jendela desktop diubah ukurannya tanpa mengetik menutup (penempatan tidak lagi valid)');
ok('glue: resize karena papan ketik tidak menutup picker/sheet; putar layar atau ubah ukuran jendela tetap menutup');

// Publik (setelah rilis 0.25.0): baris emoji cepat tidak lagi dikecualikan di tab Publik
vm.runInContext('cur = "public"', ctx); mmatch = false; open('M1', A, 'end');
assert(/class="mmq"/.test($('mmenu').innerHTML) && /data-rxq=/.test($('mmenu').innerHTML), 'Publik: menu pesan memuat baris emoji cepat');
vm.runInContext('mmClose(); cur = "g:1"', ctx);
ok('glue: tab Publik juga memuat baris emoji cepat');

// ---- 4. kontrak markup & CSS ----
const html = rd('renderer', 'archne-index.html'), app = rd('renderer', 'css', 'archne-app.css'), mcss = rd('renderer', 'css', 'archne-msgmenu.css'), render = rd('renderer', 'js', 'archne-render.js'), comp = rd('renderer', 'js', 'archne-profile-compose.js');
assert(/id="mmenu"/.test(html) && /id="mmscrim"/.test(html) && /css\/archne-msgmenu\.css/.test(html) && /src="archne-msgmenu\.js"/.test(html) && /js\/archne-msgmenu\.js/.test(html), 'archne-index.html memuat elemen, gaya, dan skrip');
assert(html.indexOf('src="archne-msgmenu.js"') < html.indexOf('js/archne-msgmenu.js'), 'archne-msgmenu.js dimuat sebelum glue');
assert(!/macts|unsend/.test(app + mcss + render + comp), 'bar melayang .macts sudah dibuang dari CSS dan JS');
assert(/class="mmore" data-menu=/.test(render) && /mmSync/.test(render), 'gelembung: tombol ⋯ di baris waktu; render memanggil mmSync');
assert(!/openMsg/.test(rd('renderer', 'js', 'archne-state-util.js') + render), 'penanda openMsg lama dibuang');
assert(!/position:\s*absolute[^}]*\.mmore|\.mmore\{[^}]*position:\s*absolute/.test(mcss), 'tombol ⋯ ada di aliran (tidak melayang)');
assert(/@media \(hover:none\)\{\.mmore\{display:none\}\}/.test(mcss), 'layar sentuh: ⋯ disembunyikan, ketuk gelembung');
assert(/#mmenu\.sheet\{[^}]*bottom:0/.test(mcss) && /env\(safe-area-inset-bottom/.test(mcss), 'bottom sheet menghormati safe area');
ok('kontrak: elemen + skrip + gaya terdaftar, .macts/openMsg hilang, ⋯ tidak melayang, sheet memakai safe-area');

console.log('\n' + pass + ' tes menu aksi pesan lulus');
})().catch((e) => { console.error('GAGAL: ' + (e && e.stack || e)); process.exit(1); });

// reaksi (langkah 4): baris emoji cepat, chip, daftar pelaku (murni)
{
  const q = MM.quick(['🔥', '👍'], '🔥'), c = MM.chips([{ e: '👍', n: 2, mine: true }, { e: '<b>', n: 1, mine: false }]), w = MM.whoHtml('👍', [{ id: 'a', name: '<x>' }]);
  assert.strictEqual((q.match(/data-rxq=/g) || []).length, 6, 'tepat 6 emoji, tanpa duplikat');
  assert.ok(q.indexOf('🔥') < q.indexOf('\u2764') && /mmqb on[^>]*data-rxq="🔥"/.test(q), 'terakhir dipakai di depan, reaksiku disorot');
  assert.ok(/rxc mine/.test(c) && /<b>2<\/b>/.test(c) && !/<b><\/b>/.test(c) && c.indexOf('<b>&') > 0 === false, 'chip: milikku, jumlah >1, escape');
  assert.ok(MM.chips([]) === '' && MM.chips(null) === '' && w.indexOf('<x>') < 0, 'kosong -> kosong, nama di-escape');
  console.log('  OK  reaksi: emoji cepat, chip, daftar pelaku');
}
// emoji bawaan: berwarna dan seragam di semua perangkat (tanpa ☺ gaya-teks, tanpa emoji baru yang butuh gambar cadangan Twemoji)
{
  const vals = (h) => [...h.matchAll(/data-rxq="([^"]+)"/g)].map((x) => x[1]);
  const def = vals(MM.quick([], '')), grid = vals(MM.picker());
  assert.strictEqual(def.length, 6); assert.strictEqual(new Set(grid).size, grid.length, 'grid tanpa duplikat');
  for (const e of def.concat(grid)) {
    assert.ok(MM.img(e) === null, 'emoji bawaan tidak butuh gambar cadangan: ' + e);
    assert.ok(!/^[\u263A\u2639]\uFE0F?$/.test(e), 'bukan ☺ gaya-teks: ' + e);
    assert.ok([...e][0].codePointAt(0) < 0x1F900 || e === '🤣' || e === '🥳' || e === '🥰' || e === '🤔' || e === '🤝' || e === '🤯', 'Unicode lama saja: ' + e);
  }
  assert.ok(MM.quick([], '').indexOf('mmplus') > 0 && MM.quick([], '').indexOf('\u2795') < 0, 'tombol lainnya = plus bergaya, bukan emoji ➕ ungu');
  console.log('  OK  emoji bawaan: lama, seragam, tanpa gambar cadangan; tombol + bergaya');
}

'use strict';
// Rapikan UI Step 3 (v0.25.0): tombol ikon (tanpa teks) di perekam, kamera, penampil foto, pemutar, Kirim Langsung;
// ikon status di gelembung; pemutar tinjauan di lembar perekam (putar/jeda/lompat) dengan DOM tiruan.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let pass = 0;
const ok = (m) => { pass++; console.log('  OK  ' + m); };

// ---- 1. markup: tombol ikon punya title + aria-label + svg, tanpa teks tampak ----
const html = rd('renderer/archne-index.html');
const btnOf = (id) => { const m = new RegExp('<button id="' + id + '"[^>]*>([\\s\\S]*?)</button>').exec(html); assert(m, 'tombol ' + id); return { open: m[0].slice(0, m[0].indexOf('>') + 1), inner: m[1] }; };
const ICONS = ['ivopen', 'ivx', 'ivzo', 'ivzi', 'ivfit', 'mpopen', 'mpx', 'cmx', 'cmmp', 'cmmv', 'cmflip', 'cmredo', 'cmsend', 'vrx', 'vrstop', 'vrplay', 'vrredo', 'vrsend', 'dxscancancel', 'dxfolder', 'dxclose'];
for (const id of ICONS) {
  const b = btnOf(id);
  assert(/title="[^"]+"/.test(b.open) && /aria-label="[^"]+"/.test(b.open), id + ': title dan aria-label');
  assert(b.inner.startsWith('<svg') && !/>[^<\s][^<]*</.test(b.inner.replace(/<svg[\s\S]*<\/svg>/, '')) && b.inner.replace(/<svg[\s\S]*?<\/svg>/g, '').trim() === '', id + ': hanya ikon, tanpa teks');
}
assert(/href="css\/archne-chatui\.css"/.test(html) && html.indexOf('css/archne-chatui.css') > html.indexOf('css/archne-filecard.css'), 'archne-chatui.css dimuat setelah archne-filecard.css');
assert(!/<audio id="vra"[^>]*controls/.test(html), 'tinjauan tidak memakai bilah audio bawaan');
for (const id of ['vrtr', 'vrbar', 'vrplay', 'vra', 'vrd']) assert(html.includes('id="' + id + '"'), id);
ok('markup: 21 tombol ikon (title + aria-label + svg, tanpa teks), archne-chatui.css dimuat, tinjauan tanpa bilah bawaan');

// ---- 2. kartu Kirim Langsung: semua tombol ikon bundar dengan label di title ----
const D = require('../renderer/archne-dxcard.js');
const id32 = (c) => c.repeat(32);
let n = 0;
for (const [dir, states] of [['in', ['offered', 'running', 'waiting', 'paused', 'done', 'error', 'cancelled']], ['out', ['offered', 'active', 'done', 'declined', 'cancelled']]]) {
  for (const st of states) {
    const h = D.rowHtml({ id: id32('a'), fromName: 'Budi', toName: 'Sari', name: 'f.zip', kind: 'file', count: 1, state: st, total: 1000, done: 400, sent: 400, speed: 100, ts: 1, code: 'net' }, dir);
    for (const m of h.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
      n++;
      assert(/class="dxb ic-btn/.test(m[0]) && /title="[^"]+"/.test(m[0]) && /aria-label="[^"]+"/.test(m[0]) && m[1].startsWith('<svg') && m[1].replace(/<svg[\s\S]*?<\/svg>/, '') === '', dir + '/' + st + ': ' + m[0]);
    }
  }
}
assert(n >= 15, 'cukup tombol diperiksa: ' + n);
const off = D.rowHtml({ id: id32('b'), fromName: 'Budi<script>', name: 'x', kind: 'file', count: 1, state: 'offered', total: 1, done: 0, ts: 1 }, 'in');
assert(/title="Terima"/.test(off) && /title="Pilih folder…"/.test(off) && /title="Tolak"/.test(off) && !off.includes('<script>'), 'label tetap tersedia lewat title; teks jaringan tetap di-escape');
ok('Kirim Langsung: ' + n + ' tombol di semua status = ikon bundar dengan title/aria-label; teks jaringan tetap di-escape');

// ---- 3. render gelembung: tanpa huruf-glyph sebagai ikon ----
const rend = rd('renderer/js/archne-render.js') + rd('renderer/js/archne-profile-compose.js');
assert(!/['">]\s*(☺|⋯|✕|⟲)\s*</.test(rend) && !/>⏱|'✓'|'⏱'/.test(rend), 'status, ☺, ⋯, ✕ memakai ikon svg');
assert(/icn\('check'\)/.test(rend) && /icn\('clock'\)/.test(rend) && /IC\.smile/.test(rend) && /IC\.more/.test(rend) && /icn\('lock'\)/.test(rend), 'ikon dipasang di gelembung dan header');
const css = rd('renderer/css/archne-chatui.css');
for (const sel of ['.ivi', '#vrec .vtr', '.dxb.ic-btn', '.st svg', '.t .mmore svg', '#cam .cmmode']) assert(css.includes(sel), 'gaya ' + sel);
ok('gelembung: status/reaksi/aksi/bilah balasan/kunci memakai ikon svg; gaya ada di archne-chatui.css');

// ---- 4. pemutar tinjauan di lembar perekam (DOM tiruan) ----
const mk = (id) => ({ id, innerHTML: '', textContent: '', style: {}, title: '', attrs: {}, handlers: {}, paused: true, ended: false, currentTime: 0, played: 0,
  setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { this.handlers[t] = f; }, removeAttribute() {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  getBoundingClientRect() { return { left: 100, width: 200, top: 0, height: 6 }; },
  play() { this.paused = false; this.played++; return Promise.resolve(); }, pause() { this.paused = true; } });
const els = {};
const $ = (id) => (els[id] || (els[id] = mk(id)));
const VN = require('../renderer/archne-voicenote.js');
const ctx = vm.createContext({ $, VoiceNote: VN, S: { call: null }, cur: 'dm', console, setTimeout, clearTimeout, setInterval, clearInterval, document: { addEventListener() {}, hidden: false }, window: { history: null }, navigator: {}, toast() {}, refresh() {}, URL, Blob, Uint8Array, nbridge: undefined });
vm.runInContext(require('./_src').txfJs() + '\n' + rd('renderer/js/archne-voicenote.js'), ctx);
const run = (c) => vm.runInContext(c, ctx);
run('vnBlob = {}; vnDur = 4000;');
run('vnPlayUi()');
assert(els.vrplay.title === 'Putar' && els.vrplay.attrs['aria-label'] === 'Putar' && els.vrplay.innerHTML.includes('<svg'), 'awal: ikon putar');
run('vnToggle()');
assert(els.vra.played === 1 && els.vrplay.title === 'Jeda' && /pause|M9 5\.5v13/.test(els.vrplay.innerHTML), 'ketuk: memutar, ikon jeda');
els.vra.currentTime = 1; run('vnPlayUi()');
assert(els.vrbar.style.width === '25%' && els.vrd.textContent === '0:01' && els.vrtr.attrs['aria-valuenow'] === '25', 'jalur + waktu berjalan mengikuti posisi (durasi dari hitungan sendiri, bukan audio.duration)');
run('vnSeek(200)'); // tengah jalur (left 100, lebar 200) -> 50% dari 4 dtk
assert(Math.abs(els.vra.currentTime - 2) < 1e-9, 'ketuk jalur: lompat ke 2 dtk');
run('vnSeek(9999)'); assert(Math.abs(els.vra.currentTime - 4) < 1e-9, 'di luar ujung: dijepit ke akhir');
run('vnSeek(-50)'); assert(els.vra.currentTime === 0, 'sebelum awal: dijepit ke 0');
run('vnToggle()'); assert(els.vra.paused && els.vrplay.title === 'Putar', 'ketuk lagi: jeda');
els.vra.ended = true; els.vra.currentTime = 4; run('vnToggle()'); assert(els.vra.played === 2 && els.vra.currentTime === 0, 'sudah selesai: mulai dari awal');
els.vra.paused = true; els.vra.ended = false; els.vra.currentTime = 0; run('vnPlayUi()'); assert(els.vrd.textContent === '0:04', 'berhenti: waktu kembali menampilkan durasi total');
run('vnBlob = null'); const before = els.vra.played; run('vnToggle()'); assert(els.vra.played === before, 'tanpa rekaman: tidak memutar');
assert(typeof els.vrplay.onclick === 'function' && typeof els.vrtr.handlers.click === 'function' && typeof els.vra.onended === 'function', 'kabel: tombol, jalur, dan peristiwa audio terpasang');
ok('tinjauan suara: putar/jeda, jalur bergerak, ketuk untuk lompat (dijepit), selesai mulai ulang, tanpa rekaman tidak memutar');

// ---- 5. pratinjau daftar chat + menu profil: ikon svg, bukan emoji (Step 3b) ----
{
  const ui = rd('renderer/js/archne-state-util.js');
  for (const n of ['clip', 'camera', 'block', 'star', 'hand']) assert(new RegExp('\\b' + n + ': svg\\(').test(ui), 'ikon ' + n + ' terdefinisi');
  const rdr = rd('renderer/js/archne-render.js'), pf = rd('renderer/js/archne-profile-compose.js');
  const pv = rdr.slice(rdr.indexOf('const prevOf'), rdr.indexOf('const whenOf'));
  assert(!/[📎🎤📞]/u.test(pv) && pv.includes("icn('clip')") && pv.includes("icn('mic')") && pv.includes('esc('), 'pratinjau: ikon svg, nama berkas/teks tetap di-escape');
  assert(!/📞/u.test(rdr), 'baris panggilan tanpa emoji telepon');
  const prof = pf.slice(pf.indexOf('function renderProfile'), pf.indexOf("$('pmodal').onclick"));
  assert(!/[📷🗑🚫✅✖↩⏳👋💬⭐🟢⚪]/u.test(prof), 'menu profil: tidak ada emoji tersisa');
  assert(['camera', 'trash', 'block', 'check', 'x', 'reply', 'clock', 'hand', 'chat', 'star', 'add'].every((n) => (prof.includes("icn('" + n) || prof.includes("ibtn('" + n))), 'menu profil memakai ikon svg');
  assert(rd('renderer/css/archne-chatui.css').includes('.psub .pdot.on'), 'gaya titik status ada');
}
ok('pratinjau daftar chat dan menu profil memakai ikon svg (tanpa emoji), isi tetap di-escape');

console.log('\nOK: ' + pass + ' kelompok');

'use strict';
// Pemutar di gelembung (v0.25.1 Step 2): suara diputar di kartunya, jeda/lanjut, kecepatan, lompat posisi, berhenti oleh panggilan/pemutar lain.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..'), FC = require('../renderer/archne-filecard.js');
const ok = (m) => console.log('  OK  ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkNode = (o) => Object.assign({ style: {}, _a: {}, innerHTML: '', textContent: '', title: '', parentNode: null,
  classList: { _s: new Set(), contains(c) { return this._s.has(c); }, toggle(c, v) { if (v === undefined ? !this._s.has(c) : v) this._s.add(c); else this._s.delete(c); }, remove(c) { this._s.delete(c); }, add(c) { this._s.add(c); } },
  setAttribute(k, v) { this._a[k] = v; }, getAttribute(k) { return this._a[k]; }, removeAttribute(k) { delete this._a[k]; if (k === 'src') delete this.src; } }, o || {});
const ID = 'ab'.repeat(16), DM = '0123456789abcdef';
const lead = mkNode(), barI = mkNode(), vdur = mkNode({ textContent: '0:23' }), fi = mkNode();
vdur._a['data-d'] = '0:23';
const card = mkNode(); card._a['data-file'] = ID; card.classList.add('fcvc');
let sp = null, lastSp = null;
fi.appendChild = (n) => { sp = lastSp = n; n.parentNode = fi; }; // tombol kecepatan
fi.removeChild = (n) => { n.parentNode = null; if (sp === n) sp = null; };
card.querySelector = (s) => ({ '[data-act="play"]': lead, '.vtr i': barI, '.vdur': vdur, '.vsp': sp, '.fi': fi, '.fthw': null }[s] || null);
sp = null;
const els = []; let clickH = null, toasts = [], streamRet = { ok: true, tok: 'tk1', total: 1000, live: false }, plays = 0, blobCalls = 0;
const mkMedia = (tag) => { const e = mkNode({ tag, paused: true, duration: 20, currentTime: 0, playbackRate: 1, pause() { this.paused = true; this.onpause && this.onpause(); }, play() { plays++; this.paused = false; this.onplay && this.onplay(); return Promise.resolve(); }, load() {} }); els.push(e); return e; };
const ctx = vm.createContext({
  document: { querySelector: () => card, createElement: (t) => (t === 'audio' || t === 'video' ? mkMedia(t) : mkNode()) }, CSS: { escape: (s) => s },
  window: { api: { mediaStream: async () => streamRet, mediaPlay: async () => { blobCalls++; return { ok: true, mime: 'audio/webm', b64: Buffer.from('xx').toString('base64') }; } }, location: { protocol: 'file:' } },
  S: { messages: [{ id: ID, to: DM, file: { name: 's.weba' } }], call: null }, FileCard: FC, toast: (m) => toasts.push(m), URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, Blob: function () {}, atob: (s) => Buffer.from(s, 'base64').toString('binary'), Uint8Array, isFinite, Math, String, Number, setTimeout,
  $: (id) => (id === 'msgs' ? { addEventListener: (ev, fn) => { if (ev === 'click') clickH = fn; } } : null),
});
const p63 = fs.readFileSync(path.join(root, 'renderer/js/archne-player.js'), 'utf8');
vm.runInContext(p63.match(/function plBytes[^\n]*\n/)[0] + p63.match(/function plUrl4\(tok\) \{[\s\S]*?\n\}\n/)[0], ctx); // hanya plBytes dan plUrl4 yang dipakai bersama
vm.runInContext(require('./_src').txfJs() + '\n' + /^function plRateTxt.*$/m.exec(fs.readFileSync(path.join(root, 'renderer/js/archne-player.js'), 'utf8'))[0] + '\n' + fs.readFileSync(path.join(root, 'renderer/js/archne-inline.js'), 'utf8') + '\nglobalThis.__t = { inlinePlay, inlineStop, inlineSync, inlineCan, st: () => ({ ilId, ilRate, n: ilN }) };', ctx);
const T = ctx.__t;
(async () => {
  assert(T.inlineCan(ID), 'kartu suara bisa diputar di tempat');
  await T.inlinePlay(ID);
  assert(els.length === 1 && els[0].tag === 'audio' && els[0].src === 'archne-media://m/tk1' && !els[0].paused && plays === 1, 'putar: elemen audio tanpa DOM, sumber stream');
  assert(lead.title === 'Jeda' && lead.innerHTML.includes('M9 5.5v13') && sp && sp.textContent === '1×', 'ikon jeda + tombol kecepatan');
  els[0].currentTime = 5; els[0].ontimeupdate(); assert(barI.style.width === '25%' && vdur.textContent === '0:05', 'jalur dan waktu berjalan');
  await T.inlinePlay(ID); assert(els[0].paused && lead.title === 'Putar', 'ketuk lagi: jeda'); await T.inlinePlay(ID); assert(!els[0].paused && els.length === 1, 'ketuk lagi: lanjut, elemen sama');
  clickH({ target: { closest: (s) => (s === '.vsp' ? sp : null) } }); assert(els[0].playbackRate === 1.5 && sp.textContent === '1,5×');
  clickH({ target: { closest: (s) => (s === '.vsp' ? sp : null) } }); clickH({ target: { closest: (s) => (s === '.vsp' ? sp : null) } }); assert(els[0].playbackRate === 1, 'kecepatan 1× → 1,5× → 2× → 1×');
  const tr = { closest: () => card, getBoundingClientRect: () => ({ left: 0, width: 200 }) };
  clickH({ clientX: 100, target: { closest: (s) => (s === '.vtr' ? tr : null) } }); assert(els[0].currentTime === 10, 'ketuk jalur: lompat ke 50%');
  els[0].onended(); assert(els[0].currentTime === 0, 'selesai: kembali ke awal');
  T.inlineStop(); assert(T.st().ilId === null && els[0].src === undefined && lead.title === 'Putar' && barI.style.width === '0%' && vdur.textContent === '0:23' && lastSp.parentNode === null, 'berhenti: kartu kembali seperti semula');
  ctx.S.call = { id: 'c' }; const n0 = els.length; await T.inlinePlay(ID); assert(els.length === n0 && toasts.length === 1 && T.st().ilId === null, 'panggilan berlangsung: ditolak'); ctx.S.call = null;
  await T.inlinePlay(ID); T.inlineSync(); assert(T.st().ilId === ID, 'render ulang: tetap jalan'); ctx.S.messages = []; T.inlineSync(); assert(T.st().ilId === null, 'pesan dihapus: berhenti'); ctx.S.messages = [{ id: ID, to: DM, file: { name: 's.weba' } }];
  await T.inlinePlay(ID); T.inlineStop(); streamRet = { ok: false, err: 'x' }; const b0 = blobCalls; await T.inlinePlay(ID); assert(blobCalls === b0 + 1 && els[els.length - 1].src === 'blob:x', 'stream tidak tersedia: jatuh ke blob');
  T.inlineStop(); streamRet = { ok: false, err: 'Isi berkas tidak cocok' }; ctx.window.api.mediaPlay = async () => ({ ok: false, err: 'Isi berkas tidak cocok' }); await T.inlinePlay(ID); assert(toasts[toasts.length - 1] === 'Isi berkas tidak cocok' && T.st().ilId === null, 'galat Core ditampilkan, pemutar bersih');
  ok('suara di gelembung: putar/jeda/lanjut, kecepatan, lompat, berhenti, panggilan, render ulang, pesan dihapus, jatuh ke blob, galat');
  // kabel
  const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  assert(rd('renderer/archne-index.html').indexOf('js/archne-inline.js') > rd('renderer/archne-index.html').indexOf('js/archne-voicenote.js'));
  assert(rd('renderer/js/archne-render.js').includes('inlineSync()') && rd('renderer/js/archne-player.js').includes('inlineStop()') && rd('renderer/js/archne-profile-compose.js').includes('inlineCan(id)') && rd('renderer/js/archne-profile-compose.js').includes("act === 'full'"));
  ok('kabel: render() memanggil inlineSync, playerStop/openPlayer menghentikan pemutar gelembung, Layar penuh lewat menu');
  console.log('\nOK: 2 kelompok');
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });

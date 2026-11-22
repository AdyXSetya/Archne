'use strict';
// Tes mode tonton layar penuh Android (v0.32.0 D.1a-D.1g), tanpa perangkat:
//  - matematika zoom/geser (D.1c): batas, cubit di titik tengah, geser, ketuk dua kali
//  - tampilan: tombol "Layar penuh" hanya di kartu layar lawan dan hanya di cangkang Android; ajakan (D.1b); kartu mode tonton + tombol keluar
//  - jembatan: viewer() hanya mengirim saat berubah
//  - kabel UI (call-ui): ajakan tidak memaksa landscape, keluar otomatis (D.1e), Kembali (D.1f), PiP, gestur, layar lawan tidak terpotong
//  - kabel cangkang/native: orientasi dipulihkan saat UI dimuat ulang, kamus dua bahasa, CSS
const assert = require('assert'), fs = require('fs'), path = require('path');
const LC = require('../renderer/archne-call');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const src = require('./_src').htmlSrc();
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const near = (a, b, m) => assert(Math.abs(a - b) < 1e-6, (m || '') + ` ${a} != ${b}`);

// 1. matematika zoom/geser
{
  const W = 800, H = 400, ID = { s: 1, x: 0, y: 0 };
  assert.deepStrictEqual(LC.vzClamp(null, W, H), ID, 'null = ukuran asli');
  assert.deepStrictEqual(LC.vzClamp({ s: 0.3, x: 50, y: 50 }, W, H), ID, 'di bawah 1 = 1, tanpa geseran');
  assert.deepStrictEqual(LC.vzClamp({ s: NaN, x: 5, y: 5 }, W, H), ID);
  assert.deepStrictEqual(LC.vzClamp({ s: 1.0005, x: 9, y: 9 }, W, H), ID, 'hampir 1 dianggap 1');
  assert.strictEqual(LC.vzClamp({ s: 99, x: 0, y: 0 }, W, H).s, LC.VZ_MAX, 'batas atas');
  const c = LC.vzClamp({ s: 2, x: 9999, y: -9999 }, W, H);
  near(c.x, W / 2, 'geser maksimal x = w*(s-1)/2'); near(c.y, -H / 2, 'geser maksimal y');
  // satu jari: tanpa zoom tidak bergeser; sudah zoom bergeser dan tetap dalam batas
  assert.deepStrictEqual(LC.vzGesture({ z: ID, pts: [{ x: 0, y: 0 }] }, [{ x: 100, y: 50 }], W, H), ID);
  const g1 = LC.vzGesture({ z: { s: 2, x: 0, y: 0 }, pts: [{ x: 0, y: 0 }] }, [{ x: 100, y: 30 }], W, H);
  near(g1.s, 2); near(g1.x, 100); near(g1.y, 30);
  const g2 = LC.vzGesture({ z: { s: 2, x: 0, y: 0 }, pts: [{ x: 0, y: 0 }] }, [{ x: 5000, y: 0 }], W, H);
  near(g2.x, W / 2, 'tidak lepas dari tepi');
  // dua jari: merenggang dua kali lipat di sekitar tengah = skala 2, tanpa geseran
  const p = LC.vzGesture({ z: ID, pts: [{ x: -50, y: 0 }, { x: 50, y: 0 }] }, [{ x: -100, y: 0 }, { x: 100, y: 0 }], W, H);
  near(p.s, 2); near(p.x, 0); near(p.y, 0);
  // titik di bawah titik tengah cubitan tetap di bawahnya: cubit di (100,0) dari tengah
  const q = LC.vzGesture({ z: ID, pts: [{ x: 50, y: 0 }, { x: 150, y: 0 }] }, [{ x: 0, y: 0 }, { x: 200, y: 0 }], W, H);
  near(q.s, 2);
  // titik layar yang tadinya di q0 (relatif tengah) sekarang di t + s*q0; harus = titik tengah baru (100,0)
  const q0 = { x: 100, y: 0 }; near(q.x + q.s * q0.x, 100, 'titik fokus tetap di bawah jari');
  // mencubit merapat kembali ke ukuran asli
  const r = LC.vzGesture({ z: { s: 2, x: 120, y: 40 }, pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }] }, [{ x: -10, y: 0 }, { x: 10, y: 0 }], W, H);
  assert.deepStrictEqual(r, ID, 'merapat penuh = 1 dan geseran 0');
  // jumlah jari berbeda / jari berimpit: tidak berubah, tidak NaN
  assert.deepStrictEqual(LC.vzGesture({ z: ID, pts: [{ x: 0, y: 0 }] }, [{ x: 1, y: 1 }, { x: 2, y: 2 }], W, H), ID);
  assert.deepStrictEqual(LC.vzGesture({ z: ID, pts: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }, [{ x: -50, y: 0 }, { x: 50, y: 0 }], W, H), ID, 'jari berimpit: tidak dibagi nol');
  assert.deepStrictEqual(LC.vzGesture(null, [{ x: 0, y: 0 }], W, H), ID);
  // ketuk dua kali
  const dt = LC.vzDoubleTap(ID, { x: 100, y: 0 }, W, H);
  near(dt.s, 2.5); near(dt.x + dt.s * 100, 100, 'titik ketukan tetap di tempatnya');
  assert.deepStrictEqual(LC.vzDoubleTap({ s: 3, x: 10, y: 10 }, { x: 0, y: 0 }, W, H), ID, 'sedang diperbesar: kembali (reset)');
  const edge = LC.vzDoubleTap(ID, { x: 400, y: 200 }, W, H); // ketukan di pojok: geseran dijaga dalam batas
  assert(Math.abs(edge.x) <= W * 1.5 / 2 + 1e-6 && Math.abs(edge.y) <= H * 1.5 / 2 + 1e-6);
  assert.strictEqual(LC.vzCss(ID), '', 'ukuran asli: tanpa transform');
  assert.strictEqual(LC.vzCss({ s: 2, x: 10.04, y: -5 }), 'translate(10px, -5px) scale(2)');
}
ok('zoom/geser: batas, cubit di titik tengah, geser dalam batas, ketuk dua kali, tanpa NaN');

// 2. tampilan kartu
{
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const icons = { shrink: '<i>S</i>', expand: '<i>E</i>' };
  const base = (o) => Object.assign({ cid: 'c1', phase: 'active', peer: 'p1', name: 'Ani', video: false, camOff: true, invite: false, legs: [{ peer: 'p1', name: 'Ani', state: 'active', cam: true, video: true, scr: true }] }, o || {});
  const h = (o) => Object.assign({ esc, avatar: () => '', icons, meId: 'me1' }, o || {});
  const html = (v, o) => LC.overlayHtml(v, h(o));
  // Android: tombol Layar penuh di kartu layar
  let t = html(base(), { viewer: true });
  assert(/class="cvf" data-cact="viewer" data-vfocus="p1"/.test(t), 'tombol Layar penuh di kartu layar');
  assert(/Layar penuh/.test(t));
  assert(!/data-cact="unview"/.test(t) && !/class="[^"]*\bviewer\b/.test(t), 'belum mode tonton');
  // desktop / tanpa cangkang: tidak ada tombol dan tidak ada ajakan
  t = html(base(), { viewer: false, viewInvite: 'p1' });
  assert(!/cvf|cvi/.test(t), 'tanpa cangkang Android tidak ada tombol / ajakan');
  t = html(base(), {});
  assert(!/cvf|cvi/.test(t));
  // kartu kamera biasa (bukan layar): tidak ada tombol
  t = html(base({ legs: [{ peer: 'p1', name: 'Ani', state: 'active', cam: true, video: true }] }), { viewer: true, viewInvite: 'p1' });
  assert(!/cvf/.test(t), 'kamera biasa tidak punya tombol layar penuh');
  assert(!/cvi/.test(t), 'dan tidak ada ajakan (kunci tidak ada di legs scr)') ;
  // ajakan (D.1b)
  t = html(base(), { viewer: true, viewInvite: 'p1' });
  assert(/class="cvi" data-cact="viewer" data-vfocus="p1">Layar dibagikan, ketuk untuk layar penuh</.test(t), 'ajakan tampil');
  t = html(base(), { viewer: true, viewInvite: 'zz' });
  assert(!/cvi/.test(t), 'kunci yang tidak ada: tidak ada ajakan');
  // mode tonton: kartu .viewer, tombol keluar menggantikan "kembali ke grid", tombol Layar penuh hilang, ajakan hilang
  t = html(base(), { viewer: true, viewKey: 'p1', focus: 'p1', viewInvite: 'p1' });
  assert(/class="cvt big viewer"/.test(t), 'kartu mode tonton');
  assert(/class="cvx" data-cact="unview"/.test(t) && !/data-cact="unfocus"/.test(t), 'tombol keluar layar penuh');
  assert(!/cvf/.test(t) && !/cvi/.test(t));
  // diperbesar biasa (bukan mode tonton): tombol kembali ke grid + tombol layar penuh
  t = html(base(), { viewer: true, focus: 'p1' });
  assert(/data-cact="unfocus"/.test(t) && /cvf/.test(t) && !/\bviewer"/.test(t.replace(/data-cact="viewer"/g, '')));
  // viewKey tanpa focus yang cocok tidak membuat kelas viewer (kartu tidak diperbesar)
  t = html(base(), { viewer: true, viewKey: 'p1' });
  assert(!/cvt[^"]* viewer"/.test(t));
  // grup: hanya kartu yang membagikan layar
  const g = base({ legs: [{ peer: 'p1', name: 'Ani', state: 'active', cam: true, video: true, scr: true }, { peer: 'p2', name: 'Budi', state: 'active', cam: true, video: true }] });
  t = html(g, { viewer: true });
  assert.strictEqual((t.match(/class="cvf"/g) || []).length, 1, 'satu tombol, di kartu pembagi layar');
  assert(/data-vfocus="p1"/.test(t.slice(t.indexOf('class="cvf"') - 5, t.indexOf('class="cvf"') + 120)));
  // channel
  const ch = { cid: 'c2', phase: 'active', peer: '', vc: { gid: 'g', cid: 'x', name: 'Ruang' }, invite: false, video: false, camOff: true, legs: [{ peer: 'p1', name: 'Ani', state: 'active', cam: true, scr: true }, { peer: 'p2', name: 'Budi', state: 'active', cam: true }] };
  t = html(ch, { viewer: true });
  assert.strictEqual((t.match(/class="cvf"/g) || []).length, 1, 'channel: tombol hanya di kartu layar');
  t = html(ch, { viewer: true, viewKey: 'p1', focus: 'p1' });
  assert(/cvt big viewer/.test(t) && /data-cact="unview"/.test(t), 'channel: mode tonton');
  // kartuku sendiri tidak punya tombol
  t = html(base({ video: true, camOff: false, scr: true }), { viewer: true });
  assert(!/data-vkey="me"[^>]*>[^]*?cvf/.test(t.split('data-vkey="p1"')[0]), 'kartuku tanpa tombol');
}
ok('tampilan: tombol dan ajakan hanya di cangkang Android dan kartu layar lawan; mode tonton menukar tombol keluar');

// 3. jembatan
{
  const handlers = [], posted = [];
  const parent = { postMessage: (m) => posted.push(m) };
  const b = LC.nativeBridge({ parent, addEventListener: (t, f) => { if (t === 'message') handlers.push(f); } });
  assert.strictEqual(b.viewerOn, false);
  b.viewer(false); assert.strictEqual(posted.length, 0, 'mati saat sudah mati: tidak mengirim');
  b.viewer(true); assert.deepStrictEqual(posted.pop(), { archne: 'native', action: 'viewer', id: 0, on: true });
  b.viewer(true); assert.strictEqual(posted.length, 0, 'berulang tidak dikirim lagi');
  b.viewer('ya'); assert.deepStrictEqual(posted.pop(), { archne: 'native', action: 'viewer', id: 0, on: false }, 'hanya true yang berarti hidup; selain itu = mati (aman)');
  b.viewer(false); assert.strictEqual(posted.length, 0, 'sudah mati: tidak dikirim lagi');
  assert.strictEqual(LC.nativeBridge({ parent: null, addEventListener() {} }), null, 'tanpa induk (desktop): tidak ada jembatan, jadi tidak ada layar penuh');
}
ok('jembatan: viewer() mengirim hanya saat berubah dan hanya di dalam cangkang');

// 4. kabel UI
{
  const ui = src.slice(src.indexOf('// <viewer>'), src.indexOf('// </viewer>'));
  assert(ui.length > 500, 'blok viewer ada');
  // D.1b: tidak ada pemaksaan landscape; ajakan saja
  const sync = ui.slice(ui.indexOf('function viewerSync'), ui.indexOf('// Cubit untuk zoom'));
  assert(/viewInvite\(k\)/.test(sync) && !/viewerEnter\(/.test(sync), 'layar baru dibagikan -> ajakan, bukan masuk layar penuh otomatis');
  assert(/nbridge && !viewKey && !mini/.test(sync), 'ajakan hanya di Android, bukan saat sudah layar penuh / dikecilkan');
  // D.1e: keluar otomatis
  assert(/if \(viewKey && \(!v \|\| mini \|\| pipShown \|\| !LC\.videoView\(v\) \|\| !keys\.includes\(viewKey\)\)\) viewerExit\(\)/.test(sync), 'keluar: panggilan berakhir, dikecilkan, PiP, tanpa video, berbagi berhenti');
  assert(/viewerSync\(v, mini\);/.test(src) && src.indexOf('viewerSync(v, mini);') < src.indexOf('LC.overlayHtml(v'), 'disinkronkan sebelum HTML dibuat');
  // masuk dan keluar
  const enter = ui.slice(ui.indexOf('function viewerEnter'), ui.indexOf('function viewerExit'));
  assert(/nbridge\.viewer\(true\)/.test(enter) && /callBar = false/.test(enter) && /vidFocus = key/.test(enter) && /viewZoomReset\(\)/.test(enter), 'masuk: native landscape, tombol panggilan disembunyikan, kartu diperbesar, zoom 1');
  const exit = ui.slice(ui.indexOf('function viewerExit'), ui.indexOf('// Dipanggil tiap render'));
  assert(/nbridge\.viewer\(false\)/.test(exit) && /callBar = true/.test(exit) && /vidFocus = null/.test(exit) && /viewZoomReset\(\)/.test(exit), 'keluar: orientasi dipulihkan, tombol kembali, zoom di-reset');
  // klik
  assert(/a === 'viewer'\) \{ viewerEnter\(b\.dataset\.vfocus/.test(src) && /a === 'unview'\) \{ viewerExit\(\)/.test(src));
  assert(/a === 'focus' && viewKey\) return;/.test(src), 'di mode tonton ketukan tidak memunculkan tombol panggilan');
  assert(/a === 'unfocus'\) \{ vidFocus = null; callBar = true; viewerExit\(\)/.test(src));
  // PiP
  assert(/if \(on && viewerExit\(\)/.test(src), 'jendela PiP menutup layar penuh');
  // layar lawan tidak terpotong
  assert(/callCtl\.remoteScreen\(key\) \? 'scr' : ''/.test(src), 'layar lawan memakai contain (kelas scr), bukan cover');
  // state dioper ke tampilan
  assert(/viewer: !!nbridge, viewKey, viewInvite: viewInv/.test(src), 'hanya cangkang yang menawarkan layar penuh');
  // gestur
  for (const e of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) assert(new RegExp(`addEventListener\\('${e}'`).test(src), 'pendengar ' + e);
  assert(/LC\.vzGesture\(vgStart/.test(src) && /LC\.vzDoubleTap\(vz/.test(src) && /closest\('button'\)/.test(src), 'cubit, ketuk dua kali, tombol tidak ikut gestur');
  assert(/addEventListener\('resize', \(\) => \{ if \(viewKey\)/.test(src), 'HP diputar: zoom di-reset');
}
ok('kabel UI: ajakan (tanpa paksa landscape), keluar otomatis, Kembali, PiP, gestur, layar lawan tidak terpotong');

// 5. kabel cangkang, kamus, CSS
{
  const shell = read('mobile/shell/index.html');
  assert(/frame\.onload = function \(\) \{[^}]*nat\('ArchneBackground', 'viewer', \{ on: false \}\)/.test(shell), 'UI dimuat ulang -> orientasi dan bilah dipulihkan');
  assert(/d\.action === 'viewer'/.test(shell), 'pembungkus meneruskan aksi viewer');
  for (const lang of ['en', 'id']) {
    const d = read(`renderer/i18n/archne-${lang}.js`);
    for (const k of ['cl.scr.full', 'cl.scr.fullInvite', 'cl.scr.fullExit']) assert(d.includes(`'${k}':`), `${lang}: ${k}`);
  }
  const css = read('renderer/css/archne-call.css');
  assert(/#callov \.cvt\.viewer\{[^}]*touch-action:none/.test(css), 'tanpa touch-action:none cubit akan memperbesar halaman, bukan video');
  assert(/#callov \.cvf\{/.test(css) && /#callov \.cvi\{/.test(css) && /body\.archne-pip #callov \.cvf/.test(css));
  assert(/expand: svg\(/.test(read('renderer/js/archne-state-util.js')), 'ikon layar penuh');
}
ok('cangkang, kamus en/id, CSS dan ikon terpasang');

// 6. perilaku: blok <viewer> dijalankan dengan stub (mesin keadaan + gestur sungguhan)
{
  const block = src.slice(src.indexOf('// <viewer>'), src.indexOf('// </viewer>'));
  const make = (withBridge) => {
    const posted = [], timers = [], vids = new Map(), video = { style: {} };
    vids.set('p1', video);
    const tile = { contains: () => true, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }) };
    const ctl = { cur: {}, renders: 0, _render() { this.renders++; } };
    const nb = withBridge ? { viewer: (on) => posted.push(on) } : null;
    const fn = new Function('LC', 'nbridge', 'vidEls', 'callCtl', '$', 'setTimeout', 'clearTimeout',
      'let callPick = true, callBar = true, vidFocus = null, pipShown = false;\n' + block
      + '\nreturn { viewerSync, viewerEnter, viewerExit, vgDown, vgMove, vgUp, setPip: (b) => { pipShown = b; }, st: () => ({ viewKey, viewInv, vz, callBar, vidFocus, callPick }) };');
    const api = fn(LC, nb, vids, ctl, () => ({ querySelector: () => tile }), (f, ms) => { timers.push({ f, ms }); return timers.length; }, () => {});
    return Object.assign(api, { posted, timers, video, ctl, tile });
  };
  const call = (scr, extra) => Object.assign({ phase: 'active', peer: 'p1', invite: false, video: false, camOff: true, legs: [{ peer: 'p1', state: 'active', cam: true, video: true, scr }] }, extra || {});
  const btn = { closest: (sel) => (sel === 'button' ? {} : null) }, plain = { closest: () => null };
  const ptr = (id, x, y, target) => ({ pointerId: id, clientX: x, clientY: y, target: target || plain, pointerType: 'touch', type: 'pointerup' });

  // D.1b: layar mulai dibagikan -> hanya ajakan, TIDAK masuk layar penuh / landscape sendiri
  let a = make(true);
  a.viewerSync(call(true), false);
  assert.strictEqual(a.st().viewInv, 'p1', 'ajakan muncul');
  assert.deepStrictEqual(a.posted, [], 'landscape tidak dipaksa');
  assert.strictEqual(a.st().viewKey, null);
  assert.strictEqual(a.timers.length, 1, 'ajakan hilang sendiri (pewaktu)');
  a.viewerSync(call(true), false); assert.strictEqual(a.timers.length, 1, 'render berikutnya tidak mengulang ajakan');
  a.timers[0].f(); assert.strictEqual(a.st().viewInv, '', 'ajakan kedaluwarsa'); assert(a.ctl.renders >= 1, 'dirender ulang agar ajakan hilang');
  // masuk
  assert.strictEqual(a.viewerEnter('p1'), true);
  let st = a.st();
  assert(st.viewKey === 'p1' && st.vidFocus === 'p1' && st.callBar === false && st.callPick === false, 'kartu diperbesar, tombol panggilan hilang, lembar tutup');
  assert.deepStrictEqual(a.posted, [true], 'native diminta landscape + layar penuh');
  assert.strictEqual(a.viewerEnter('p1'), false, 'masuk dua kali tidak berefek');
  // sinkron sambil berbagi tetap: tetap di layar penuh
  a.viewerSync(call(true), false); assert.strictEqual(a.st().viewKey, 'p1');
  // D.1e: berbagi berhenti -> keluar, orientasi dipulihkan, tombol kembali
  a.viewerSync(call(false), false);
  st = a.st(); assert(st.viewKey === null && st.callBar === true && st.vidFocus === null);
  assert.deepStrictEqual(a.posted, [true, false], 'native diminta memulihkan orientasi');
  // D.1e: panggilan berakhir (v = null), dikecilkan, PiP, video hilang
  for (const [name, v, mini, pip] of [['panggilan berakhir', null, false, false], ['dikecilkan', call(true), true, false], ['PiP tampil', call(true), false, true], ['kamera mati semua', call(true, { legs: [] }), false, false], ['bukan aktif', call(true, { phase: 'connecting' }), false, false]]) {
    const x = make(true);
    x.viewerSync(call(true), false); x.viewerEnter('p1'); x.setPip(pip);
    x.viewerSync(v, mini);
    assert.strictEqual(x.st().viewKey, null, 'keluar otomatis: ' + name);
    assert.deepStrictEqual(x.posted, [true, false], 'orientasi pulih: ' + name);
  }
  // tanpa cangkang (desktop): tidak ada ajakan dan tidak bisa masuk
  const d = make(false);
  d.viewerSync(call(true), false);
  assert.strictEqual(d.st().viewInv, '', 'desktop: tanpa ajakan');
  assert.strictEqual(d.viewerEnter('p1'), false, 'desktop: tidak bisa masuk layar penuh');
  // ajakan tidak muncul bila panggilan dikecilkan atau sudah layar penuh
  const m = make(true); m.viewerSync(call(true), true); assert.strictEqual(m.st().viewInv, '', 'dikecilkan: tanpa ajakan');
  // ajakan dicabut bila berbagi berhenti sebelum diketuk
  const r = make(true); r.viewerSync(call(true), false); r.viewerSync(call(false), false); assert.strictEqual(r.st().viewInv, '', 'berbagi berhenti: ajakan dicabut');
  r.viewerSync(call(true), false); assert.strictEqual(r.st().viewInv, 'p1', 'berbagi lagi: ajakan baru');

  // D.1c: gestur sungguhan di kartu
  const g = make(true);
  g.viewerSync(call(true), false); g.viewerEnter('p1');
  const down = (id, x, y, t) => g.vgDown(ptr(id, x, y, t)), move = (id, x, y) => g.vgMove(ptr(id, x, y)), up = (id, x, y) => g.vgUp(ptr(id, x, y));
  // cubit: dua jari merenggang dari (350,200)/(450,200) ke (300,200)/(500,200) = 2x
  down(1, 350, 200); down(2, 450, 200);
  move(1, 300, 200); move(2, 500, 200);
  assert(Math.abs(g.st().vz.s - 2) < 1e-6, 'cubit memperbesar 2x');
  assert(/scale\(2\)/.test(g.video.style.transform), 'transform dipasang di <video>: ' + g.video.style.transform);
  up(2, 500, 200); up(1, 300, 200);
  // geser satu jari saat diperbesar
  const before = g.st().vz.x;
  down(5, 400, 200); move(5, 460, 200); up(5, 460, 200);
  assert(g.st().vz.x > before + 50, 'geser menggeser gambar');
  // tombol di dalam kartu tidak memulai gestur
  const keep = JSON.stringify(g.st().vz);
  down(9, 100, 100, btn); move(9, 300, 100); up(9, 300, 100);
  assert.strictEqual(JSON.stringify(g.st().vz), keep, 'menyentuh tombol (keluar) tidak menggeser');
  // ketuk dua kali = reset
  down(7, 400, 200); up(7, 400, 200); down(8, 402, 201); up(8, 402, 201);
  assert.strictEqual(g.st().vz.s, 1, 'ketuk dua kali saat diperbesar = kembali ke 1');
  assert.strictEqual(g.video.style.transform, '', 'transform dibersihkan');
  // ketuk dua kali saat ukuran asli = perbesar
  down(10, 600, 200); up(10, 600, 200); down(11, 600, 200); up(11, 600, 200);
  assert(Math.abs(g.st().vz.s - 2.5) < 1e-6, 'ketuk dua kali saat ukuran asli = perbesar');
  // keluar membersihkan zoom
  g.viewerExit();
  assert.strictEqual(g.st().vz.s, 1); assert.strictEqual(g.video.style.transform, '', 'keluar: zoom di-reset');
  // di luar mode tonton gestur diabaikan
  down(20, 350, 200); down(21, 450, 200); move(20, 300, 200); move(21, 500, 200);
  assert.strictEqual(g.st().vz.s, 1, 'gestur diabaikan di luar mode tonton');
  // satu ketukan lalu geser jauh bukan ketuk-dua-kali
  const h2 = make(true); h2.viewerSync(call(true), false); h2.viewerEnter('p1');
  h2.vgDown(ptr(1, 100, 100)); h2.vgUp(ptr(1, 100, 100)); h2.vgDown(ptr(2, 600, 300)); h2.vgUp(ptr(2, 600, 300));
  assert.strictEqual(h2.st().vz.s, 1, 'dua ketukan berjauhan bukan ketuk dua kali');
}
ok('perilaku: ajakan tanpa paksa landscape, keluar otomatis di 5 kondisi, desktop tanpa layar penuh, cubit/geser/ketuk dua kali');

console.log(`screenviewer: ${pass} OK`);

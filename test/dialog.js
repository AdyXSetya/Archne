'use strict';
// Tes dialog dalam-aplikasi (v0.23.0): ask() pengganti confirm(), notify() pengganti alert(), toast baru.
// Dua mode: DOM sungguhan (ada document.body) -> kartu #dlg; tanpa itu (tes vm lain) -> jatuh ke confirm()/alert() asli.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };

(async () => {
  const idx = fs.readFileSync(path.join(root, 'renderer', 'archne-index.html'), 'utf8');
  assert(/<div id="dlg" class="mbg" role="alertdialog" aria-modal="true"/.test(idx) && /id="dlgt"/.test(idx) && /id="dlgm"/.test(idx) && /id="dlgok"/.test(idx) && /id="dlgno"/.test(idx), 'markup dialog');
  assert(idx.indexOf('js/archne-state-util.js') < idx.indexOf('js/archne-dialog.js') && idx.indexOf('js/archne-dialog.js') < idx.indexOf('js/archne-render.js'), 'urutan skrip');
  assert(/href="css\/archne-dialog\.css"/.test(idx) && fs.existsSync(path.join(root, 'renderer/css/archne-dialog.css')), 'archne-dialog.css dimuat');
  const js = fs.readdirSync(path.join(root, 'renderer/js')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(root, 'renderer/js', f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')).join('\n');
  assert(!/(^|[^\w.])(confirm|alert)\(/.test(js.replace(/\/\/.*$/gm, '').replace(/return Promise\.resolve\(confirm\(text\)\)/, '').replace(/return alert\(t\)/, '')), 'tidak ada confirm()/alert() bawaan tersisa di renderer/js (selain jalur cadangan tes)');
  ok('markup, urutan skrip, css; renderer/js tidak lagi memanggil confirm()/alert() langsung');

  const inline = require('./_src').inlineJs();
  const make = (real, withI18n) => {
    const els = {};
    const mkEl = (id) => ({ id, innerHTML: '', className: '', textContent: '', value: '', checked: false, style: {}, dataset: {}, handlers: {}, focused: 0,
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); }, focus() { this.focused++; }, select() {}, querySelectorAll: () => [] });
    const keys = [];
    const doc = { getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null, querySelector: () => null, addEventListener: (t, fn) => { if (t === 'keydown') keys.push(fn); } };
    if (real) doc.body = { appendChild() {}, classList: { add() {}, remove() {}, contains: () => false } };
    const native = { confirms: [], alerts: [], ans: true };
    const api = new Proxy({}, { get: (_t, n) => n === 'state' ? async () => ({ me: { id: '1'.repeat(16), name: 'S', port: 1 }, peers: [], groups: [], messages: [], sending: [], blocked: [] }) : n === 'onUpdate' ? () => {} : n === 'pickFiles' ? async () => [] : n === 'pathOf' ? () => '' : async () => ({ ok: true }) });
    const ctx = { window: { api }, document: doc, CSS: { escape: (s) => s }, FileCard: require('../renderer/archne-filecard'), Avatar: require('../renderer/archne-avatar'), confirm: (t) => { native.confirms.push(t); return native.ans; }, alert: (t) => { native.alerts.push(t); }, console, setInterval: () => 0, setTimeout, clearTimeout, clearInterval: () => {}, navigator: {}, location: { protocol: 'http:' }, localStorage: { getItem: () => null, setItem: () => {} } };
    vm.createContext(ctx); vm.runInContext((withI18n ? require('./_src').i18nJs() + '\n' : '') + inline, ctx);
    return { els, ctx, native, keys, ev: (c) => vm.runInContext(c, ctx), tick: () => new Promise((r) => setImmediate(r)) };
  };

  // ---- A. mode kartu ----
  const A = make(true); await A.tick();
  let p = A.ev("ask('Keluar dari grup \"Kel\"?\\n\\nGrup dan riwayatnya dihapus.\\nKamu hanya bisa masuk lagi kalau diundang.')");
  assert.strictEqual(A.els.dlg.style.display, 'flex', 'kartu terbuka'); assert.strictEqual(A.native.confirms.length, 0, 'confirm() bawaan tidak dipanggil');
  assert.strictEqual(A.els.dlgt.textContent, 'Keluar dari grup "Kel"?', 'baris pertama jadi judul'); assert(/Grup dan riwayatnya dihapus\.\nKamu hanya/.test(A.els.dlgm.textContent), 'sisanya jadi penjelasan (baris dipertahankan)');
  assert.strictEqual(A.els.dlgok.className, 'dng', 'yang merusak: tombol merah'); assert.strictEqual(A.els.dlgok.textContent, 'Keluar', 'label tombol dari kata kerja'); assert.strictEqual(A.els.dlgno.textContent, 'Batal');
  assert(A.els.dlgno.focused > 0 && !A.els.dlgok.focused, 'fokus awal di Batal untuk yang merusak');
  A.els.dlgok.onclick(); assert.strictEqual(await p, true, 'OK -> true'); assert.strictEqual(A.els.dlg.style.display, 'none');
  p = A.ev("ask('Hapus semua riwayat panggilan?')"); A.els.dlgno.onclick(); assert.strictEqual(await p, false, 'Batal -> false');
  p = A.ev("ask('Hapus pesan ini?')"); A.els.dlg.onclick({ target: A.els.dlg }); assert.strictEqual(await p, false, 'klik latar -> false');
  p = A.ev("ask('Hapus pesan ini?')"); A.els.dlg.onclick({ target: A.els.dlgm }); assert.strictEqual(A.els.dlg.style.display, 'flex', 'klik di dalam kartu tidak menutup'); A.keys[0]({ key: 'Escape', preventDefault() {} }); assert.strictEqual(await p, false, 'Esc -> false');
  p = A.ev("ask('Jadikan Budi admin? Admin bisa menambah anggota.')"); assert.strictEqual(A.els.dlgok.className, '', 'bukan perusakan: tombol biasa'); assert.strictEqual(A.els.dlgok.textContent, 'Jadikan'); assert.strictEqual(A.els.dlgt.textContent, 'Jadikan Budi admin?'); assert.strictEqual(A.els.dlgm.textContent, 'Admin bisa menambah anggota.'); A.els.dlgok.onclick(); await p;
  p = A.ev("ask('Apakah kamu yakin')"); assert.strictEqual(A.els.dlgok.textContent, 'Ya'); assert.strictEqual(A.els.dlgm.style.display, 'none', 'tanpa penjelasan: bagian itu disembunyikan'); A.els.dlgno.onclick(); await p;
  const p1 = A.ev("ask('Hapus A?')"), p2 = A.ev("ask('Hapus B?')"); assert.strictEqual(await p1, false, 'dialog baru menggantikan yang lama (dianggap Batal)'); A.els.dlgok.onclick(); assert.strictEqual(await p2, true);
  ok('ask(): judul/penjelasan, tombol merah untuk yang merusak, OK/Batal/latar/Esc, satu dialog pada satu waktu');

  // ---- B. notify -> toast ----
  A.ev("notify('Alamat tidak valid')"); assert.strictEqual(A.els.toast.textContent, 'Alamat tidak valid'); assert.strictEqual(A.els.toast.className, ''); assert.strictEqual(A.els.toast.style.display, 'block'); assert.strictEqual(A.native.alerts.length, 0, 'alert() bawaan tidak dipanggil');
  A.ev("notify('')"); assert.strictEqual(A.els.toast.textContent, 'Terjadi kesalahan', 'pesan kosong diberi teks umum');
  A.ev("toast('Tersimpan', true)"); assert.strictEqual(A.els.toast.className, 'ok'); A.els.toast.onclick(); assert.strictEqual(A.els.toast.style.display, 'none', 'ketuk menutup toast');
  ok('notify(): toast galat (bukan kotak OK), teks umum bila kosong; toast sukses; ketuk menutup');

  // ---- C. mode cadangan (DOM tiruan tes lain) ----
  const B = make(false); await B.tick();
  B.native.ans = false; assert.strictEqual(await B.ev("ask('Hapus?')"), false); B.native.ans = true; assert.strictEqual(await B.ev("ask('Hapus?')"), true); assert.strictEqual(B.native.confirms.length, 2, 'memakai confirm() asli');
  B.ev("notify('galat')"); assert.deepStrictEqual(B.native.alerts, ['galat']);
  ok('tanpa DOM sungguhan: ask() dan notify() memakai confirm()/alert() asli (tes lain tetap berlaku)');
  // ---- D. dua bahasa (C1): kamus dimuat; label tombol, tombol merah, cadangan bahasa ----
  const D = make(true, true); await D.tick();
  const askEv = (t) => D.ev('ask(' + JSON.stringify(t) + ')');
  D.ev("I18N.setLang('en')");
  p = askEv('Delete this post?\n\nThis cannot be undone.'); assert.strictEqual(D.els.dlgok.textContent, 'Delete'); assert.strictEqual(D.els.dlgno.textContent, 'Cancel'); assert.strictEqual(D.els.dlgok.className, 'dng', 'EN: Delete = merah'); D.els.dlgno.onclick(); await p;
  p = askEv('Unsend this message for everyone?'); assert.strictEqual(D.els.dlgok.textContent, 'Unsend message'); assert.strictEqual(D.els.dlgok.className, 'dng'); D.els.dlgno.onclick(); await p;
  p = askEv('Make Bob an admin? Admins can add members.'); assert.strictEqual(D.els.dlgok.textContent, 'Make'); assert.strictEqual(D.els.dlgok.className, ''); D.els.dlgno.onclick(); await p;
  p = askEv('Are you sure'); assert.strictEqual(D.els.dlgok.textContent, 'Yes'); D.els.dlgno.onclick(); await p;
  p = D.ev("ask('This file can be run.\\nOnly accept it from someone you know.', { ok: 'Accept', danger: true })"); assert.strictEqual(D.els.dlgok.textContent, 'Accept'); assert.strictEqual(D.els.dlgok.className, 'dng', 'opsi eksplisit menang'); D.els.dlgno.onclick(); await p;
  D.ev("notify('')"); assert.strictEqual(D.els.toast.textContent, 'Something went wrong');
  D.ev("I18N.setLang('id')");
  p = askEv('Hapus pesan ini?'); assert.strictEqual(D.els.dlgok.textContent, 'Hapus'); assert.strictEqual(D.els.dlgno.textContent, 'Batal'); D.els.dlgno.onclick(); await p;
  p = askEv('Batalkan pesan ini untuk semua orang?'); assert.strictEqual(D.els.dlgok.textContent, 'Batalkan pesan'); D.els.dlgno.onclick(); await p;
  D.ev("notify('')"); assert.strictEqual(D.els.toast.textContent, 'Terjadi kesalahan');
  assert.strictEqual(D.ev("dayLabel(Date.now())"), 'Hari ini'); D.ev("I18N.setLang('en')"); assert.strictEqual(D.ev("dayLabel(Date.now())"), 'Today');
  assert.strictEqual(D.ev("dayLabel(Date.now() - 864e5)"), 'Yesterday'); assert.strictEqual(D.ev("callBusyMsg()").slice(0, 12), 'You are in a');
  assert.strictEqual(D.ev("badgesOf('x', { creator: 'x', admins: [] })").includes('title="Owner"'), true);
  ok('dwibahasa: label/merah/Batal-Cancel/Ya-Yes, opsi eksplisit menang, notify umum, dayLabel, lencana, pesan sibuk');
  console.log('\n' + pass + ' tes dialog OK');
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });

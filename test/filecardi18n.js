'use strict';
// Tes i18n D1: renderer/archne-filecard.js dua bahasa. Tanpa I18N (Node murni) teks Indonesia cadangan + koma desimal (dijaga test/ui.js);
// dengan I18N: id = teks asli, en = Inggris dengan titik desimal. Jamak kurir/peer, galat penerimaan/pengiriman, menu.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const R = path.join(__dirname, '..', 'renderer');
const rd = (f) => fs.readFileSync(path.join(R, f), 'utf8');
const ok = (n) => console.log('  OK  ' + n);
function load(lang) {
  const c = { Intl, Object, Set, String, console, module: { exports: {} } };
  vm.createContext(c);
  for (const f of ['archne-i18n.js', 'i18n/archne-en.js', 'i18n/archne-id.js']) vm.runInContext(rd(f), c);
  c.I18N.setLang(lang);
  vm.runInContext(rd('archne-filecard.js'), c);
  return c.module.exports;
}
const id = load('id'), en = load('en');
const ID = 'a'.repeat(32);
const msg = (file, to) => ({ id: ID, from: 'p', to: to || 'public', ts: 1, name: 'X', text: 'x', file });

assert.strictEqual(id.fmtSize(1536), '1,5 KB'); assert.strictEqual(en.fmtSize(1536), '1.5 KB');
assert.strictEqual(en.fmtSize(3 * 1073741824), '3.00 GB'); assert.strictEqual(en.fmtSize(512), '512 B');
assert.strictEqual(en.progressText('download', 512, 1024), '50% · 512 B / 1.0 KB');
assert.strictEqual(id.progressText('unpack', 1, 2), 'Menyimpan 50%'); assert.strictEqual(en.progressText('unpack', 1, 2), 'Saving 50%');
assert.strictEqual(en.progressText('pack', 1, 2), 'Preparing 50%'); assert.strictEqual(en.progressText('x', 1, 2), 'Processing 50%');
ok('fmtSize (koma/titik) dan progressText per bahasa');

// jamak kurir / peer lain: 1 vs banyak (EN), id sama untuk keduanya
const held = (L, n, to) => L.cardHtml(msg({ name: 'a.pdf', size: 10, mode: 'raw', held: n }, to), {}, {});
assert(held(en, 1, 'peerid').includes('Available from 1 courier:') && held(en, 2, 'peerid').includes('Available from 2 couriers:'));
assert(held(en, 1).includes('from 1 other peer:') && held(en, 2).includes('from 2 other peers:'));
assert(held(id, 1, 'peerid').includes('Tersedia di 1 kurir:') && held(id, 2).includes('Tersedia di 2 peer lain:'));
const pushed = (L, n, to) => L.cardHtml(msg({ name: 'a.pdf', size: 10, mine: true, pushed: n }, to), {}, {});
assert(pushed(en, 1, 'peerid').includes('Left with 1 courier:') && pushed(en, 3, 'peerid').includes('Left with 3 couriers:'));
assert(pushed(en, 1).includes('Held by 1 other peer ') && pushed(en, 3).includes('Held by 3 other peers '));
ok('jamak kurir/peer (tersedia, dititipkan)');

// kartu: tombol, chip, catatan
const recv = en.cardHtml(msg({ name: 'a.pdf', size: 10, mode: 'raw' }), {}, { senderOnline: false });
assert(recv.includes('title="Accept"') && recv.includes('Sender offline') && recv.includes('aria-label="File menu"'));
const risky = en.cardHtml(msg({ name: 'a.exe', size: 10, mode: 'raw' }), {}, {});
assert(risky.includes('Accept (risky)') && risky.includes('can be executed'));
const saved = en.cardHtml(msg({ name: 'a.pdf', size: 10, saved: { name: 'a (1).pdf' } }), {}, {});
assert(saved.includes('Saved: a (1).pdf') && saved.includes('title="Open"'));
const vc = en.cardHtml(msg({ name: 'v.weba', size: 10, mode: 'raw', x: { k: 'vc', d: 4000 } }), {}, {});
assert(vc.includes('Download voice message') && vc.includes('title="Voice message"'));
const th = en.cardHtml(msg({ name: 'a.jpg', size: 10, saved: { name: 'a.jpg' }, x: { k: 'img', th: 'AAAA', w: 10, h: 10 } }), {}, {});
assert(th.includes('aria-label="View photo a.jpg"'));
assert(id.cardHtml(msg({ name: 'a.jpg', size: 10, saved: { name: 'a.jpg' }, x: { k: 'img', th: 'AAAA', w: 10, h: 10 } }), {}, {}).includes('aria-label="Lihat foto a.jpg"'));
const err = en.cardHtml(msg({ name: 'a.pdf', size: 10, rx: { phase: 'error', code: 'hash' } }), {}, {});
assert(err.includes('Failed: The downloaded file does not match the original.') && err.includes('title="Try again"') && err.includes('Discard partial download'));
const abort = en.cardHtml(msg({ name: 'a.pdf', size: 10, rx: { phase: 'error', code: 'abort' } }), {}, {});
assert(abort.includes('Cancelled.') && abort.includes('title="Continue"'));
ok('kartu berkas EN: tombol, chip, catatan, foto, suara, galat');

// galat + menu + pekerjaan kirim
assert.strictEqual(en.rxError('EACCES').text, en.rxError('EPERM').text); assert.strictEqual(en.rxError('bad').text, en.rxError('proto').text);
assert.strictEqual(en.rxError('gone').retry, false); assert.strictEqual(en.rxError('net').retry, true);
assert.strictEqual(en.rxError('xx', 'raw').text, 'raw'); assert.strictEqual(en.rxError().text, 'unknown error'); assert.strictEqual(id.rxError().text, 'galat tidak dikenal');
assert.strictEqual(en.txError('ENOENT'), 'File not found (it may have been moved or deleted).'); assert.strictEqual(en.txError('EBUSY'), 'The file is in use by another program.');
assert.strictEqual(id.txError('EBUSY'), 'Berkas sedang dipakai program lain.'); assert.strictEqual(en.txError('qq', 'e'), 'e');
const labels = (L, f) => Array.from(L.menuItems(msg(f)), (i) => i.label); // Array.from: array dari konteks vm punya prototype lain
const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
same(labels(en, { name: 'a.pdf', size: 1536, saved: { name: 'a.pdf' } }), ['a.pdf · 1.5 KB', 'Open with another app', 'Show in folder']);
same(labels(id, { name: 'a.pdf', size: 1536, saved: { name: 'a.pdf' } }), ['a.pdf · 1,5 KB', 'Buka dengan aplikasi lain', 'Tampilkan di folder']);
same(labels(en, { name: 'a.mp3', size: 10, saved: { name: 'a.mp3' } }).slice(1), ['Play', 'Open with another app', 'Show in folder']);
same(labels(en, { name: 'a.mp4', size: 10, saved: { name: 'a.mp4' } })[1], 'Full screen');
same(labels(en, { name: 'a.pdf', size: 10, rx: { phase: 'error' } })[1], 'Discard partial download');
const jb = en.jobHtml({ job: 'j1', name: 'n.txt', phase: 'error', code: 'ENOSPC' }, {});
assert(jb.includes('Failed to send: Disk full, cannot prepare the file for sending.') && jb.includes('title="Close"'));
assert(en.jobHtml({ job: 'j1', name: 'n.txt', phase: 'pack', done: 1, total: 2 }, {}).includes('Preparing 50%'));
ok('rxError/txError, menu ⋮ dan pekerjaan kirim per bahasa');
console.log('filecardi18n: semua lulus');

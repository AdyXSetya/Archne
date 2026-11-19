'use strict';
// Tes i18n D2: renderer/archne-dxcard.js, archne-msgmenu.js, archne-linkify.js dua bahasa. Tanpa I18N (Node murni) = teks Indonesia cadangan (dijaga test/dxui.js, archne-msgmenu.js, weblink.js).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const R = path.join(__dirname, '..', 'renderer'), rd = (f) => fs.readFileSync(path.join(R, f), 'utf8');
const ok = (n) => console.log('  OK  ' + n);
const J = JSON.stringify;
function load(f, lang) {
  const c = { Intl, Object, Set, String, console, URL, module: { exports: {} } };
  vm.createContext(c);
  for (const x of ['archne-i18n.js', 'i18n/archne-en.js', 'i18n/archne-id.js']) vm.runInContext(rd(x), c);
  c.I18N.setLang(lang); vm.runInContext(rd(f), c); return c.module.exports;
}
const dI = load('archne-dxcard.js', 'id'), dE = load('archne-dxcard.js', 'en');
const ID = 'a'.repeat(32);
const it = (o) => Object.assign({ id: ID, name: 'f.bin', total: 5e6, done: 2e6, sent: 1e6, kind: 'file' }, o);

// ukuran, kecepatan, sisa waktu, progres
assert.strictEqual(dI.fmtSize(1536), '1,5 KB'); assert.strictEqual(dE.fmtSize(1536), '1.5 KB'); assert.strictEqual(dE.fmtSize(3 * 1099511627776 / 2), '1.50 TB');
assert.strictEqual(dE.fmtSpeed(1048576), '1.0 MB/s'); assert.strictEqual(dI.fmtSpeed(1048576), '1,0 MB/dtk');
assert.strictEqual(dE.fmtEta(1000, 100), '10 sec'); assert.strictEqual(dE.fmtEta(6000, 100), '1 min 0 sec'); assert.strictEqual(dE.fmtEta(400000, 100), '1 h 6 min'); assert.strictEqual(dE.fmtEta(1e9, 1), '> 1 day');
assert.strictEqual(dI.fmtEta(400000, 100), '1 j 6 mnt'); assert.strictEqual(dI.fmtEta(1e9, 1), '> 1 hari');
assert.strictEqual(dE.progressText(1048576, 10485760, 1048576), '10% · 1.0 MB / 10 MB · 1.0 MB/s · 9 sec left');
assert.strictEqual(dI.progressText(1048576, 10485760, 1048576), '10% · 1,0 MB / 10 MB · 1,0 MB/dtk · sisa 9 dtk');
ok('fmtSize/fmtSpeed/fmtEta/progressText per bahasa');

// baris transfer
const row = (L, o, d) => L.rowHtml(it(o), d);
let h = row(dE, { state: 'offered', fromName: 'Ani' }, 'in');
assert(h.includes('Ani wants to send over the local network.') && h.includes('title="Accept"') && h.includes('title="Choose folder…"') && h.includes('title="Decline"') && h.includes('>Incoming<') && h.includes('4.8 MB · file'));
assert(row(dI, { state: 'offered', fromName: 'Ani' }, 'in').includes('Ani ingin mengirim lewat jaringan lokal.'));
assert(row(dE, { state: 'offered' }, 'in').includes('Someone wants') && row(dI, { state: 'offered' }, 'in').includes('Seseorang ingin'));
assert(row(dE, { kind: 'dir', count: 1, state: 'listing' }, 'in').includes('4.8 MB · 1 file<') && row(dE, { kind: 'dir', count: 3, state: 'listing' }, 'in').includes('3 files<') && row(dI, { kind: 'dir', count: 3, state: 'listing' }, 'in').includes('3 berkas<'));
assert(row(dE, { state: 'running', speed: 1e6 }, 'in').includes('title="Pause"') && row(dE, { state: 'running', speed: 1e6 }, 'in').includes('title="Cancel"'));
assert(row(dE, { state: 'waiting' }, 'in').includes('Reconnecting to the sender…') && row(dE, { state: 'listing' }, 'in').includes('Fetching the file list…'));
assert(row(dE, { state: 'paused', code: 'restart' }, 'in').includes('The app was closed for a while. Press Continue when the sender is online.') && row(dE, { state: 'paused' }, 'in').includes('Paused.') && row(dE, { state: 'paused', err: 'RAW <b>' }, 'in').includes('RAW &lt;b&gt;'));
assert(row(dE, { state: 'paused' }, 'in').includes('title="Continue"'));
assert(row(dE, { state: 'done', failed: 1 }, 'in').includes('Done, but 1 file failed') && row(dE, { state: 'done', failed: 4 }, 'in').includes('Done, but 4 files failed') && row(dE, { state: 'done' }, 'in').includes('Done.'));
assert(row(dE, { state: 'done' }, 'in').includes('title="Open folder"') && row(dE, { state: 'done' }, 'in').includes('title="Remove from list"'));
assert(row(dE, { state: 'error', code: 'net' }, 'in').includes('The connection was lost.') && row(dE, { state: 'error', code: 'net' }, 'in').includes('title="Try again"') && !row(dE, { state: 'error', code: 'gone' }, 'in').includes('Try again'));
assert(row(dE, { state: 'error' }, 'in').includes('Failed.') && row(dE, { state: 'cancelled' }, 'in').includes('Cancelled.') && row(dI, { state: 'cancelled' }, 'in').includes('Dibatalkan.'));
assert(row(dE, { state: 'offered', toName: 'Budi' }, 'out').includes('Waiting for Budi to accept…') && row(dE, { state: 'offered' }, 'out').includes('>Outgoing<'));
assert(row(dE, { state: 'active', toName: 'Budi' }, 'out').includes('Budi is fetching it. Keep the app open.') && row(dE, { state: 'done', toName: 'Budi' }, 'out').includes('Sent to Budi.') && row(dE, { state: 'declined', toName: 'Budi' }, 'out').includes('Budi declined.') && row(dE, { state: 'cancelled' }, 'out').includes('Cancelled.'));
assert(row(dE, { state: 'offered', fromName: '<i>x</i>' }, 'in').includes('&lt;i&gt;x&lt;/i&gt; wants'));
assert(dE.listHtml({}).includes('No transfers yet.') && dI.listHtml({}).includes('Belum ada transfer.'));
ok('baris transfer masuk/keluar, galat, jamak, escape nama');

// sendGate
assert.strictEqual(dE.sendGate(null).title, 'Direct Send'); assert(dE.sendGate({}).title.includes('same local network'));
assert.strictEqual(dE.sendGate({ lan: true, online: false, name: 'Sam' }).title, 'Direct Send needs both sides online. Sam is offline');
assert.strictEqual(dE.sendGate({ lan: true, online: false }).title, 'Direct Send needs both sides online. Friend is offline');
assert.strictEqual(dI.sendGate({ lan: true, online: false }).title, 'Kirim Langsung butuh kedua pihak online. Teman sedang offline');
assert(dE.sendGate({ lan: true, online: true }).ok);
ok('sendGate per bahasa');

// msgmenu + linkify
const mE = load('archne-msgmenu.js', 'en'), mI = load('archne-msgmenu.js', 'id'), lE = load('archne-linkify.js', 'en'), lI = load('archne-linkify.js', 'id');
const lab = (L, m, o) => Array.from(L.items(m, o), (i) => i.label);
assert.strictEqual(J(lab(mE, { text: 't' }, { mine: true })), J(['Reply', 'Pin', 'Copy text', 'Unsend for everyone']));
assert.strictEqual(J(lab(mI, { text: 't' }, { mine: true })), J(['Balas', 'Sematkan', 'Salin teks', 'Batalkan untuk semua']));
assert.strictEqual(lab(mE, { text: 't' }, { pinned: true })[1], 'Already pinned');
assert(mE.quick([], '').includes('aria-label="Reactions"') && mE.quick(['🔥'], '').includes('aria-label="React 🔥"') && mE.quick([], '').includes('aria-label="More emoji"'));
assert(mI.quick([], '').includes('aria-label="Reaksi"') && mI.quick([], '').includes('aria-label="Emoji lain"'));
assert(mE.chips([{ e: '👍', n: 2 }]).includes('title="Tap to react, long-press to see who"'));
assert(mE.picker().includes('placeholder="Type or paste an emoji"') && mE.picker().includes('>Send<') && mI.picker().includes('>Kirim<'));
assert(mE.preview({ file: {} }, 'A').includes('📎 File') && mI.preview({ file: {} }, 'A').includes('📎 Berkas'));
const u = { v: 'https://a.com/x', href: 'https://a.com/x' };
assert(lE.chip(u, {}).includes('title="Copy link" aria-label="Copy link"') && lI.chip(u, {}).includes('title="Salin tautan" aria-label="Salin tautan"'));
ok('msgmenu (butir, reaksi, picker, pratinjau) dan linkify (salin tautan) per bahasa');
console.log('dxmmi18n: semua lulus');

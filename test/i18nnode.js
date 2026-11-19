'use strict';
// Tes i18n E2: src/core/archne-i18n-node.js (kamus bersama di Node) + src/core/archne-ecode.js (ek, errText).
// Tes ini juga akan memeriksa (mulai E3) bahwa fail() menerjemahkan; sekarang hanya fondasinya.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const ok = (n) => console.log('  OK  ' + n);

const N = require('../src/core/archne-i18n-node');
const { ek, errText } = require('../src/core/archne-ecode');

// ---- 1. kamus termuat; bahasa dibaca saat dipanggil ----
assert.strictEqual(N.ok(), true, 'kamus termuat');
let cur = 'en';
N.bind(() => cur);
assert.strictEqual(N.lang(), 'en');
assert.strictEqual(N.tr('common.close', null, 'Tutup?'), 'Close', 'EN dari kamus, bukan cadangan');
cur = 'id';
assert.strictEqual(N.lang(), 'id');
assert.strictEqual(N.tr('common.close', null, 'x'), 'Tutup', 'ganti bahasa langsung berlaku (dibaca saat dipanggil)');
cur = 'en';
assert.strictEqual(N.tr('common.close'), 'Close');
ok('kamus bersama termuat; bahasa diikuti saat dipanggil (en <-> id)');

// ---- 2. param, jamak, fallback ----
assert.strictEqual(N.tr('call.ariaTo', { name: 'Budi' }), 'Call Budi');
cur = 'id';
assert.strictEqual(N.tr('call.ariaTo', { name: 'Budi' }), 'Telepon Budi');
assert.strictEqual(N.trn('msg.more', 1, { count: 1 }), 'Lihat selengkapnya (1 karakter)');
cur = 'en';
assert.strictEqual(N.trn('msg.more', 1, { count: 1 }), 'Show more (1 character)');
assert.strictEqual(N.trn('msg.more', 5, { count: 5 }), 'Show more (5 characters)');
assert.strictEqual(N.tr('e.tidak.ada', { a: 1 }, 'Cadangan {a}'), 'Cadangan 1', 'kunci tak ada -> teks Indonesia cadangan + param');
assert.strictEqual(N.tr('e.tidak.ada'), 'e.tidak.ada', 'tanpa cadangan -> kunci');
assert.strictEqual(N.trn('e.tidak.ada', 3, null, '{n} hal'), '3 hal');
cur = 'fr'; assert.strictEqual(N.lang(), 'en', 'bahasa tak dikenal -> en');
cur = null; assert.strictEqual(N.lang(), 'en');
N.bind(() => { throw new Error('sumber rusak'); });
assert.strictEqual(N.lang(), 'en', 'sumber melempar -> en (tidak ikut melempar)');
N.bind(null);
assert.strictEqual(N.lang(), 'en');
ok('param {x}, jamak, fallback Indonesia, bahasa tak dikenal/sumber rusak -> en');

// ---- 3. nf ----
N.bind(() => 'en'); assert.strictEqual(N.nf(1234567), '1,234,567');
N.bind(() => 'id'); assert.strictEqual(N.nf(1234567), '1.234.567');
ok('nf(n) mengikuti bahasa (en: 1,234,567; id: 1.234.567)');

// ---- 4. gagal muat -> cadangan Indonesia, tidak melempar ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18nn-'));
try {
  assert.strictEqual(N.load(tmp), false, 'folder tanpa kamus -> load() false');
  assert.strictEqual(N.ok(), false);
  N.bind(() => 'en');
  assert.strictEqual(N.tr('common.close', null, 'Tutup'), 'Tutup', 'gagal muat -> pesan Indonesia asli');
  assert.strictEqual(N.tr('call.ariaTo', { name: 'A' }, 'Telepon {name}'), 'Telepon A');
  assert.strictEqual(N.trn('msg.more', 2, { count: 2 }, '{count} karakter'), '2 karakter');
  assert.strictEqual(errText(ek('common.close', null, 'Tutup')), 'Tutup', 'errText ikut jatuh ke Indonesia');
  assert.strictEqual(N.nf(1500), (1500).toLocaleString('en-US'));
  fs.writeFileSync(path.join(tmp, 'archne-i18n.js'), 'throw new Error("rusak")');
  assert.strictEqual(N.load(tmp), false, 'kamus rusak -> false');
} finally { fs.rmSync ? fs.rmSync(tmp, { recursive: true, force: true }) : null; }
assert.strictEqual(N.load(), true, 'muat ulang dari renderer/ asli');
N.bind(() => 'en');
assert.strictEqual(N.tr('common.close'), 'Close');
ok('gagal/rusak muat -> cadangan Indonesia; muat ulang pulih');

// ---- 5. ek / errText ----
const e1 = ek('call.ariaTo', { name: 'Ani' }, 'Telepon Ani', 'bad');
assert(e1 instanceof Error);
assert.strictEqual(e1.message, 'Telepon Ani', '.message tetap Indonesia (log, tes lama)');
assert.strictEqual(e1.ek, 'call.ariaTo');
assert.deepStrictEqual(e1.ep, { name: 'Ani' });
assert.strictEqual(e1.code, 'bad');
const e2 = ek('common.close', null, 'Tutup');
assert(!('ep' in e2) && !('code' in e2), 'tanpa param/kode -> properti tidak dibuat');
N.bind(() => 'en'); assert.strictEqual(errText(e1), 'Call Ani');
N.bind(() => 'id'); assert.strictEqual(errText(e1), 'Telepon Ani');
assert.strictEqual(errText(new Error('polos')), 'polos', 'galat tanpa kunci tetap .message');
assert.strictEqual(errText('teks'), 'teks');
assert.strictEqual(errText(null), 'null');
assert.strictEqual(errText(ek('e.tidak.ada', { a: 1 }, 'Pesan {a}')), 'Pesan {a}'.replace('{a}', '1'), 'kunci tidak ada di kamus -> Indonesia cadangan (param diisi)');
ok('ek: .message Indonesia + .ek/.ep/.code; errText menerjemahkan hanya yang berkunci');

// ---- 6. kompatibilitas Node 12 (Android): tanpa ?. ?? di berkas baru ----
for (const f of ['src/core/archne-i18n-node.js', 'src/core/archne-ecode.js']) {
  const code = fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert(!/\?\.[a-zA-Z_(\[]|\?\?/.test(code), f + ' memakai sintaks yang tidak ada di Node 12');
}
ok('berkas baru tanpa ?. / ?? (Node 12)');

console.log('i18nnode: semua lulus');

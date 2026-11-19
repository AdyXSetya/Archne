'use strict';
// 5d-7: angka batas di README (bagian "Cadangan dan pemulihan halaman") harus sama dengan kode. Mengubah batas tanpa memperbarui README = gagal di sini.
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { ENTRIES_MAX, MANIFEST_MAX, FORMAT, MAGIC, FOOT_MAGIC } = require('../src/archne-pagearc');
const { CMT_ENTRY_MAX } = require('../src/archne-pageexport');
const { POSTS_MAX, POST_MAX } = require('../src/archne-pageimport');
const { CMT_STORE_MAX, CMT_RM_MAX } = require('../src/archne-pagecmt');
const { MEDIA_MAX, FILES_MAX, VIDEOS_MAX, PAGE_FILE_MAX, PAGE_MEDIA_MAX, PAGE_VIDEO_MAX } = require('../src/archne-pagestore');

const md = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const i = md.indexOf('## Cadangan dan pemulihan halaman');
assert(i >= 0, 'README: bagian cadangan hilang');
const sec = md.slice(i);
const id = (n) => n.toLocaleString('en-US').replace(/,/g, '.'); // 100000 -> 100.000
const MiB = (n) => (n / 1048576) + ' MiB';
const has = (s, why) => assert(sec.includes(s), 'README tidak memuat ' + JSON.stringify(s) + ' (' + why + ')');

assert.strictEqual(PAGE_FILE_MAX, 2 * 1024 ** 3); assert.strictEqual(PAGE_MEDIA_MAX, PAGE_FILE_MAX); assert.strictEqual(PAGE_VIDEO_MAX, PAGE_FILE_MAX);
has('2 GiB', 'ukuran satu berkas');
has(MEDIA_MAX + ' / ' + FILES_MAX + ' / ' + VIDEOS_MAX, 'gambar / lampiran / video per postingan');
has(id(POSTS_MAX), 'postingan per arsip');
has(id(ENTRIES_MAX), 'entri per arsip');
has(MiB(MANIFEST_MAX), 'ukuran manifest');
has(MiB(POST_MAX), 'JSON satu postingan');
has(id(CMT_STORE_MAX) + ' komentar + ' + id(CMT_RM_MAX) + ' nisan', 'komentar per arsip');
has(MiB(CMT_ENTRY_MAX), 'entri komentar');
has(MAGIC.toString() + '` ... `' + FOOT_MAGIC.toString(), 'magic');
has('meta `fmt: 1`', 'versi meta'); assert.strictEqual(FORMAT, 1);
console.log('pagearcdoc ok');

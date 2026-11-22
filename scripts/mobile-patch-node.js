'use strict';
// Dijalankan SETELAH `npm ci` dan sebelum Gradle (lihat scripts/mobile.ps1). Aman dijalankan berulang.
//   node scripts/mobile-patch-node.js [folder mobile]
//
// Kenapa perlu: @capawesome/capacitor-nodejs 0.3.0 menyimpan `started` dan `ready` per objek Nodejs, dan objek baru dibuat setiap
// plugin dimuat. Node hanya boleh dimulai SEKALI per proses. Bila Activity dibuat ulang selagi proses masih hidup (layanan latar
// menahannya; Android 16 lebih sering menghancurkan Activity), plugin memuat ulang, mengira Node belum jalan, lalu memanggil
// node::Start lagi -> assert -> abort() = force close. Dengan status tingkat proses (static) pemuatan kedua hanya mendapat
// NODE_ALREADY_RUNNING (tidak fatal) dan memakai Node yang sudah hidup; halaman membungkus menyapa tiap detik sampai Node menjawab.
const fs = require('fs'), path = require('path');
const mob = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'mobile');
const file = path.join(mob, 'node_modules', '@capawesome', 'capacitor-nodejs', 'android', 'src', 'main', 'java', 'io', 'capawesome', 'capacitorjs', 'plugins', 'nodejs', 'Nodejs.java');
const log = (m) => console.log('[patch-node] ' + m);
if (!fs.existsSync(file)) { console.error('[patch-node] GAGAL: tidak ada ' + file + ' (jalankan npm ci dulu)'); process.exit(1); }
let s = fs.readFileSync(file, 'utf8');
const PAIRS = [
  ['private volatile boolean ready = false;', 'private static volatile boolean ready = false; // archne: tingkat proses'],
  ['private volatile boolean started = false;', 'private static volatile boolean started = false; // archne: tingkat proses (Node hanya boleh dimulai sekali per proses)'],
];
let changed = false;
for (const [from, to] of PAIRS) {
  if (s.includes(to)) continue;
  if (!s.includes(from)) { console.error('[patch-node] GAGAL: baris tidak ditemukan (versi plugin berubah?): ' + from); process.exit(1); }
  s = s.replace(from, to); changed = true;
}
if (changed) { fs.writeFileSync(file, s); log('Nodejs.java: started dan ready dibuat static'); } else log('sudah ditambal');

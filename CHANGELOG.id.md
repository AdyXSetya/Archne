# Changelog

Perubahan penting pada Archne, dari yang terbaru.
Versi Inggris: [CHANGELOG.md](CHANGELOG.md).

## 0.32.0 (belum dirilis)

Fokus: berbagi layar beserta suara, ditambah beberapa perbaikan bug.

### Memperbarui dari 0.31.0
- **Android:** APK baru menimpa 0.31.0 hanya bila ditandatangani kunci yang sama (version code 3200). Bila tidak, hapus aplikasi lama dulu.

### Berbagi layar
- **Bagikan layar di panggilan (desktop).** Tombol "Bagikan layar" muncul di panggilan yang aktif. Kamu memilih sendiri layar atau jendelanya (jendela Archne sendiri tidak ditawarkan); tidak ada yang dibagikan otomatis. Penanda merah "Kamu sedang berbagi layar" tetap tampil, juga di layar penuh dan di bilah panggilan kecil. Layar menggantikan kamera di jalur video yang sama tanpa negosiasi ulang, jadi panggilan tidak putus. Kamera kembali saat kamu berhenti, termasuk saat menekan "Stop sharing" di bilah sistem, dan berbagi berhenti sendiri saat panggilan berakhir. Satu panggilan hanya boleh satu pembagi. Peer v0.31.0 mengabaikan medan status tambahan itu dan tidak terpengaruh. Baru dijaga tes otomatis; belum dicoba di dua Windows sungguhan.
- **Suara sistem di Windows (opsional).** Pemilih punya kotak "Bagikan audio sistem", mati bawaan, hanya untuk Windows dan berbagi layar penuh. Suara komputer dicampur dengan mikrofon; Bisukan hanya membisukan mikrofon. Pakai headphone agar tidak bergema. Belum dicoba di mesin sungguhan.
- **Menonton layar yang dibagikan di HP.** Layar yang dibagikan tampil utuh, tidak terpotong. Di Android, tombol "Layar penuh" (dan ajakan saat berbagi dimulai) membuka tontonan landscape layar penuh: cubit untuk zoom sampai 5x dan geser, ketuk dua kali untuk memperbesar atau mengembalikan. Tombol Kembali, berbagi berhenti, panggilan berakhir, panggilan dikecilkan, atau Picture-in-Picture keluar dari mode ini dan memulihkan orientasi. Logikanya sudah dites; mode layar penuh dan gestur belum dicoba di HP.
- **Bagikan layar dan suara sistem dari HP.** Plugin native baru (`ArchneScreen`) menangkap layar (MediaProjection) dan suara media sistem (AudioPlaybackCapture, Android 10+), lalu menyerahkannya ke panggilan lewat loopback WebRTC di perangkat, jadi kode panggilan yang sudah ada mengirimnya persis seperti di desktop. Penangkapan berjalan di layanan latar bertipe `mediaProjection`, sehingga tetap jalan saat Archne di latar belakang. Suara keluaran Archne sendiri dikeluarkan, jadi lawan bicara tidak mendengar dirinya sendiri. Dilaporkan jalan di HP uji; uji rinci di perangkat (diputar, Android 14/15, panas dan baterai) masih berjalan, lihat `docs/PLANNING-0.32.0.md`, fase E.5.
- **Batas kualitas.** Layar yang dibagikan dikirim ke tiap penonton hingga 3 Mbps dan 30 fps. Tangkapan HP dibatasi sisi panjang 1280 dan sisi pendek 720. Unggahan berlipat sesuai jumlah penonton (mesh), jadi peringatan muncul mulai 3 penonton. Ini nilai awal, belum disetel di jaringan nyata.

### Halaman
- **Cadangan Halaman kini membawa komentar dan reaksi.** Ekspor menyimpan reaksi pada postingan dan reaksi pada komentar (entri `reactions` di arsip, format `fmt: 1` tetap; arsip lama tetap terbaca). Kotak "Sertakan komentar saat ekspor" sekarang menyala secara bawaan. Impor memulihkan reaksi hanya di identitas yang sama dengan pembuat arsip (reaksi tidak bertanda tangan, jadi arsip dari identitas lain tidak dipercaya; postingannya tetap masuk dan layar impor menjelaskan). Reaksi digabung per orang: yang terbaru menang, reaksi yang sudah ada tidak pernah dicabut, dan impor ulang tidak mengubah apa pun. Reaksi komentar ikut hanya bila komentarnya ikut. Isi arsip diperiksa (hitungan, pemilik, id, emoji, batas 256 orang per sasaran). Tes baru: `pagerxarc`, ditambah cakupan di `pagearcipc`, `pagearcui`, `pagearcdoc`.
- **Perbaikan: umpan tidak pernah memuat lagi saat digulir (macet "memuat" di ujung) dan Esc tidak menutup Halaman.** `archne-pages.js` memasang pendengar gulir pada `#pglist` saat dimuat, padahal elemen itu baru ada setelah sebuah Halaman dibuka, sehingga skrip melempar `Cannot read properties of null` dan dua pendengar sesudahnya tidak pernah terpasang. Pendengar kini dipasang pada `#pgbody` yang selalu ada. Tes baru `pagesinit` memeriksa HTML aslinya.

### Android
- **Panggilan lebih cepat tersambung.** Kredensial TURN dipanaskan saat aplikasi mulai dan diambil bersamaan dengan izin mikrofon (dulu berurutan, bisa menambah hingga 8 detik).
- **Kandidat ICE dikirim bersamaan.** Dulu tiap kandidat menunggu ack kandidat sebelumnya (batas 3 detik), jadi satu yang lambat menunda semuanya. Sekarang menunggu tawaran/jawaban saja lalu terkirim paralel; format pesan tidak berubah, jadi peer lama tetap cocok.
- **TURN lebih andal.** Gangguan jaringan sesaat saat mengambil kredensial TURN dicoba ulang sekali (token/ID yang ditolak tidak diulang), batas waktu per permintaan 4 detik, dan jeda sesudah gagal dipersingkat dari 30 ke 5 detik. Kalau panggilan ke jaringan lain berjalan tanpa TURN (belum diatur atau gagal diambil), muncul pemberitahuan langsung, tidak menunggu 30 detik lalu gagal tanpa penjelasan.
- **Perbaikan force close di Android (kadang saat aplikasi dibuka lagi).** Plugin Node.js menyimpan status "sudah mulai" per objek, padahal Node hanya boleh dimulai sekali per proses. Saat Activity dibuat ulang selagi proses masih hidup (ditahan layanan latar), Node dimulai kedua kali dan `node::Start` memanggil `abort()`. Sekarang status itu tingkat proses lewat tambalan `scripts/mobile-patch-node.js` yang dijalankan `mobile.ps1` setelah `npm ci`; pemuatan kedua memakai Node yang sudah hidup. Belum dites di HP.
- **Perbaikan: "memuat" tanpa akhir saat aplikasi dibuka lagi selagi layanan latar hidup.** Setelah Activity dibuat ulang, objek plugin Node tidak pernah siap, sehingga pesan pertama ke Node ditolak dan halaman menunggu terus. Node kini dimulai manual: pembungkus meminta port dan token Node yang sedang berjalan ke sisi native (`ArchneBackground.info`) lalu langsung memuat UI, dan hanya memulai Node bila belum ada yang berjalan. Pemanggilan plugin di pembungkus tidak lagi mengira hasilnya Promise (di Capacitor 8 pemanggilan plugin tidak mengembalikan apa pun). Batas yang diketahui: setelah dibuka ulang, impor arsip Halaman belum sampai ke Node sampai aplikasi dimulai dingin. Belum diuji di HP.
- **Petunjuk TURN tidak lagi mengganggu.** Pemberitahuan "TURN belum diatur / tidak bisa dihubungi" dulu muncul di awal setiap panggilan lintas jaringan walau panggilan akhirnya tersambung. Sekarang hanya muncul bila sambungan belum aktif setelah 10 detik atau gagal, sekali per panggilan, dan tidak pernah muncul bila tersambung.

## 0.31.0 (22 November 2026)

Peningkatan internal besar. Cangkang Android dan runtime desktop sama-sama diganti.

### Memperbarui dari 0.30.0
- **Data lokal tidak dimigrasi.** Obrolan, profil, dan berkas dari 0.30.0 tidak dibawa.
- **Android:** APK baru hanya bisa menimpa yang lama bila keduanya ditandatangani kunci yang sama. Bila kamu membangun dengan `%USERPROFILE%\.archne\archne-release.jks` yang asli, pembaruan terpasang seperti biasa. Kalau tidak, uninstall aplikasi lama dulu.

### Android
- Dibangun ulang dengan **Capacitor 8** dan runtime **Node 24** dari `@capawesome/capacitor-nodejs`. Cordova dan `nodejs-mobile-cordova` dibuang, begitu juga skrip tambalan yang dulu diperlukan.
- **Page size 16 KB** didukung: APK lulus `zipalign -P 16` dan `libnode.so` selaras untuk semua ABI.
- ABI yang didukung: `arm64-v8a`, `armeabi-v7a`, `x86_64`. APK debug universal sekitar 134 MB. Pakai `mobile.bat -Abis arm64-v8a` untuk build lebih kecil.
- Fitur native dipindah ke plugin Capacitor: audio dan rute panggilan (earpiece / speaker), unduhan dan pemilih berkas, layanan latar belakang dan notifikasi.
- Panggilan: panggilan masuk memakai gaya panggilan sistem (Android 12+) dan tampil di layar kunci. Jawab dari notifikasi dikirim ulang sampai aplikasi mengonfirmasi.
- Halaman: **ekspor dan impor** kini berfungsi di Android. Ekspor menyimpan berkas `.archpg` ke `Download/`; impor membuka pemilih berkas sistem.
- Tampilan edge-to-edge untuk Android 15/16, splash screen dan ikon adaptive baru.
- Tombol Kembali menutup dialog dan panel dulu, lalu mundur lewat obrolan, dan terakhir menyembunyikan aplikasi alih-alih menutupnya.
- Tautan web kini dibuka lewat Chrome Custom Tabs. Bilah browser dalam aplikasi yang lama (mundur / maju / tutup) sudah tidak ada.
- Pintu build baru: `mobile.bat` (`-Install`, `-Release`, `-Aab`, `-Abis`). Skrip build Cordova lama dihapus.
- `applicationId` tetap (`com.xyraori.archne`). Version code kini 3100.

### Desktop
- **Electron 33 → 45** dan **electron-builder 25 → 26.18**, dipin ke versi persis.
- Sejak Electron 42, `npm install` tidak lagi mengunduh binary Electron. Skrip setup yang mengunduhnya, atau otomatis saat `npm start` pertama.
- Disesuaikan dengan perubahan Electron 35 sampai 45 (argumen pesan konsol, sakelar `app.commandLine` huruf kecil, preload tersandbox).

### Lintas jaringan dan panggilan
- Pustaka klien MQTT **5.10.1 → 5.16.1**, memuat beberapa perbaikan keamanan untuk paket broker yang rusak atau jahat. Archne menyetel `reconnectOnConnackError` agar perilaku sambung ulang tetap sama.
- Berkas peredam bising (RNNoise) terbukti identik dengan rilis terbaru; kualitas panggilan tidak berubah.
- Ditambah `renderer/vendor/VERSIONS.txt` (asal dan SHA-256 pustaka bawaan) serta lisensi RNNoise yang sebelumnya kurang.

### Build dan peralatan
- Mesin build butuh Node **22.12 atau lebih baru**. JDK 21 dan Android SDK 36 dipasang otomatis oleh `mobile.bat`.
- `resedit` 3.1.0. `npm audit` tidak menemukan kerentanan pada dependensi produksi.
- Lapisan kompatibilitas Node 12 (`archne-compat.js`) dihapus.
- Tes: 193 dari 200 lulus di Windows (Node 26). Tujuh yang gagal bergantung pada jaringan nyata dan berubah antar-jalan; semuanya lulus di Linux.

### Batasan yang diketahui
- Build rilis masih perlu matriks uji manual di perangkat nyata (Android 7 sampai 16, emulator 16 KB, HP ↔ HP dan HP ↔ desktop).
- Batas waktu layanan latar di Android 15+ dan deklarasi Google Play belum ditangani, karena rilis untuk sementara hanya lewat GitHub.

## 0.30.0

Rilis terakhir dengan Cordova (Android) dan Electron 33 (desktop). Obrolan, grup, panggilan, berkas, Halaman, mode lintas jaringan, bahasa Inggris dan Indonesia.

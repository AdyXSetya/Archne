# Changelog

Perubahan penting pada Archne, dari yang terbaru.
Versi Inggris: [CHANGELOG.md](CHANGELOG.md).

## 1.0.0 (28 November 2026)

Rilis stabil pertama.

### Ditambahkan
- **Web.** Buat situs sendiri dari perangkatmu. Peer yang terhubung bisa menjelajahinya.
  - HTML, CSS, JS dan **PHP** (PHP 8.3), dengan **SQLite** dan database **semi MySQL**.
  - Pengelola berkas dan editor, unduh dan ekstrak ZIP, penjelajah database dan kotak SQL.
  - **Cron** untuk situs PHP, dan **Jadikan offline** untuk menyimpan berkas CDN secara lokal.
  - Dasbor memori, Worker PHP, dan penyimpanan, plus batas sumber daya per situs.
  - Situs pribadi secara bawaan. Windows dan Android.
- **Berbagi layar di panggilan**, dari Windows dan Android, dengan suara sistem opsional.
- **Menonton layar yang dibagikan di HP** dalam layar penuh, dengan cubit untuk zoom.
- **Cadangan Halaman** kini membawa komentar dan reaksi.
- **Tab Database:** buat, hapus, dan reset database SQLite tanpa PHP; nyalakan atau matikan server semi MySQL tanpa Mesin PHP dan salin alamat koneksinya. Impor dump MySQL kini membaca nilai biner dengan benar.
- **Pengaturan > Umum > Aplikasi:** tombol **Keluar** (Android tidak perlu lagi "Paksa berhenti") dan **Reset data** (menghapus identitas, obrolan, Halaman, dan situs, dengan dua konfirmasi).
- Status **"Online di latar"** (titik kuning) untuk peer yang aplikasinya masih hidup tetapi link-nya dijeda, bukan lagi "Offline".

### Keamanan
- Berkas hanya bisa dikirim dari dialog berkas, seret-lepas, atau hasil tangkapan Archne sendiri.
- Jendela aplikasi lebih ketat, dan berkas identitas tidak pernah diganti diam-diam.
- Berkas data hanya bisa dibaca pemiliknya (macOS/Linux).
- Situs milik orang lain berjalan terisolasi tanpa akses jaringan luar, dan Archne memberi peringatan sebelum kamu membuka situs orang asing atau mengetik kata sandi di dalamnya.


### Diperbaiki
- Android: force close dan loading tanpa akhir saat aplikasi dibuka lagi.
- Android: panggilan lebih cepat tersambung dan TURN lebih andal.
- Umpan Halaman berhenti memuat lebih banyak saat digulir.
- Android: Dasbor Web dan Cron bisa terus "Memuat…" bila inti aplikasi berhenti menjawab. Kini ada batas waktu, pesan dengan tombol Coba lagi, dan pulih sendiri.
- Android: sync riwayat besar (ratusan pesan per putaran) bisa membuat inti aplikasi dan tampilan macet, sehingga Dasbor Web dan Cron tetap "Memuat…" dan peer lain melihat HP putus. Pembaruan tampilan kini digabung, tampilan menyegarkan satu permintaan pada satu waktu, dan sync memberi giliran saat memasukkan pesan.
- Membuka situs peer bisa gagal dengan "pemilik offline" dan baru berhasil setelah diulang beberapa kali, terutama di HP yang lama di latar belakang. Peer yang tampak offline kini ditanyai langsung dulu sebelum galat ditampilkan.
- Membuka situs orang asing untuk pertama kali tidak lagi menampilkan bilah yang berdesakan di layar kecil.
- Baris info perangkat tidak lagi menulis "0 inti prosesor" bila HP tidak melaporkannya.

### Memperbarui
- **Dari 0.31:** tanpa migrasi data.
- **Dari 0.30 atau lebih lama:** data lokal tidak dibawa.
- **Android:** APK baru hanya bisa menimpa yang lama bila keduanya ditandatangani kunci yang sama. Kalau tidak, uninstall dulu.

### Keterbatasan
- Database MySQL adalah emulasi di atas SQLite, jadi tidak cocok dengan semua aplikasi. WordPress dan CMS lain tidak didukung.
- Situs PHP belum berjalan di mode peramban (`server.js`).
- Kunci privat disimpan di `identity.json` tanpa enkripsi tambahan (izin hanya untuk pemilik).
- Belum diaudit keamanannya secara independen.
- Emulasi MySQL belum mendukung `ON UPDATE CURRENT_TIMESTAMP`, collation, dan komentar kolom.
- **Jadikan offline** hanya mengikuti referensi yang tertulis di CSS. URL yang dirakit saat jalan, serta layanan seperti peta, analitik, captcha, dan pembayaran, tetap butuh internet. Hanya penerapan terakhir yang bisa dibatalkan.
- Android bisa menjeda aplikasi saat layar terkunci (lihat README untuk yang tetap berfungsi).

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

### Batasan yang diketahui
- Build rilis masih perlu matriks uji manual di perangkat nyata (Android 7 sampai 16, emulator 16 KB, HP ↔ HP dan HP ↔ desktop).
- Batas waktu layanan latar di Android 15+ dan deklarasi Google Play belum ditangani, karena rilis untuk sementara hanya lewat GitHub.

## 0.30.0

Rilis terakhir dengan Cordova (Android) dan Electron 33 (desktop). Obrolan, grup, panggilan, berkas, Halaman, mode lintas jaringan, bahasa Inggris dan Indonesia.

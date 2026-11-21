# Changelog

Perubahan penting pada Archne, dari yang terbaru.
Versi Inggris: [CHANGELOG.md](CHANGELOG.md).

## 0.31.0 (belum dirilis)

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
- Tes: 193 dari 200 lulus di Windows (Node 26). Tujuh yang gagal bergantung pada jaringan nyata dan berubah antar-jalan; semuanya lulus di Linux. Lihat `docs/baseline.txt`.

### Batasan yang diketahui
- Build rilis masih perlu matriks uji manual di perangkat nyata (Android 7 sampai 16, emulator 16 KB, HP ↔ HP dan HP ↔ desktop).
- Batas waktu layanan latar di Android 15+ dan deklarasi Google Play belum ditangani, karena rilis untuk sementara hanya lewat GitHub.

## 0.30.0

Rilis terakhir dengan Cordova (Android) dan Electron 33 (desktop). Obrolan, grup, panggilan, berkas, Halaman, mode lintas jaringan, bahasa Inggris dan Indonesia.

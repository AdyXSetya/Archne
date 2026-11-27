<div align="center">

<img src="assets/icon.png" alt="Archne" width="120" />

# Archne

### Messenger peer-to-peer tanpa server, dengan hosting web pribadi bawaan.

**Ngobrol, telepon, kirim berkas, dan hosting situs langsung dari perangkatmu.**
Tanpa server. Tanpa akun. Tanpa perantara.

![Versi](https://img.shields.io/badge/versi-1.0.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20Android%20%C2%B7%20Browser-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%E2%89%A522.12-339933)
![Bahasa](https://img.shields.io/badge/bahasa-English%20%C2%B7%20Indonesia-informational)

[English](README.md) · **Bahasa Indonesia**

[Fitur](#-fitur) · [Instalasi](#-instalasi) · [Build](#-build) · [Cara kerja](#-cara-kerja) · [Keterbatasan](#-keterbatasan-dan-rencana) · [Pengembangan](#-pengembangan) · [Changelog](CHANGELOG.id.md)

</div>

<img src="assets/01.webp" alt="Archne" width="240" /> <img src="assets/04.webp" alt="Archne" width="240" />
<img src="assets/02.webp" alt="Archne" width="240" /> <img src="assets/03.webp" alt="Archne" width="240" />

---

## Kenapa Archne?

Kebanyakan aplikasi chat bergantung pada server milik perusahaan: akunmu ada di sana, pesanmu lewat sana, dan kalau server mati, aplikasinya ikut mati.

Archne dibuat dengan arah sebaliknya. Setiap perangkat adalah **peer** yang setara. Perangkat saling menemukan di jaringan yang sama (Wi-Fi atau LAN), lalu bertukar pesan, panggilan, dan berkas **langsung**. Untuk teman di jaringan lain, tersedia **mode lintas jaringan** dengan kode jaringan pribadi. Identitasmu cuma sepasang kunci di perangkatmu sendiri.

Selain itu, tiap perangkat juga bisa menjadi **server web** kecil: buat situs dengan HTML, CSS, JS, PHP, dan SQLite, lalu orang yang terhubung denganmu bisa menjelajahinya. Tanpa hosting, tanpa domain, tanpa tagihan.

**Cocok untuk**
- Kelompok di Wi-Fi atau LAN yang sama: acara, kelas, kantor, komunitas, atau tempat dengan internet lemah.
- Chat pribadi dan kirim berkas tanpa menyerahkan datamu ke perusahaan.
- Hobiis yang ingin hosting atau demo situs PHP kecil langsung dari laptop atau HP.

---

## ✨ Fitur

### 💬 Obrolan
- **Chat pribadi, grup, dan ruang publik.**
- **Pesan tetap sampai walau tujuan sedang offline.** Peer lain ikut menitipkan pesan terenkripsi dan mengantarkannya begitu penerima online lagi, lengkap dengan tanda terima.
- **Balas, reaksi emoji, hapus, dan sematkan pesan** lewat menu aksi di tiap pesan.
- **Manajemen grup** (pemilik dan admin, undang atau keluarkan anggota, avatar grup), pertemanan, blokir, dan perlindungan spam bawaan.

### 📞 Panggilan
- **Panggilan suara dan video** satu lawan satu, dan **panggilan grup** sampai 8 peserta.
- **Channel suara** untuk grup dan **channel suara publik** dengan PIN 6 angka.
- **Peredam kebisingan** (RNNoise) yang berjalan lokal di perangkatmu.
- **Berbagi layar** (Windows dan Android) dengan suara sistem opsional. Berbagi layar memperlihatkan semua isi layarmu, termasuk notifikasi, jadi pakai hanya dengan orang yang kamu percaya.

### 📎 Berkas dan media
- **Kirim berkas** langsung antar perangkat, dikompres dan dienkripsi sebelum keluar dari perangkatmu.
- **Foto dan video dari kamera**, **pesan suara**, penampil gambar, dan pemutar media bawaan.

### 📰 Halaman
Ruang postinganmu sendiri yang tersimpan di perangkatmu.
- Posting teks, gambar, video, dan lampiran, dengan privasi per postingan (hanya teman, larang unduh).
- Komentar bertingkat dan reaksi yang muncul langsung.
- **Cadangan dan pemulihan** seluruh halaman, beserta komentar dan reaksi, ke satu berkas `.archpg`.

### 🌍 Web
Situs milikmu sendiri, dihosting di perangkatmu sendiri.
- **HTML, CSS, JS, PHP 8.3, SQLite**, dan database **semi MySQL** (emulasi di atas SQLite, bukan MySQL penuh).
- Pengelola berkas dan editor, impor dan ekspor ZIP, penjelajah database dengan kotak SQL, **cron**, dan **Jadikan offline** (menyimpan berkas CDN secara lokal).
- Dasbor memori, Worker PHP, dan penyimpanan, plus batas sumber daya per situs.
- Peer yang terhubung menjelajahi situsmu lewat tab **Jelajah**. Situs bersifat pribadi sampai kamu membukanya.
- Situs milik orang lain berjalan terisolasi tanpa akses jaringan luar, dan Archne memberi peringatan sebelum kamu membuka situs orang asing atau mengetik kata sandi di dalamnya.

### 🌐 Lintas jaringan
- Hubungkan perangkat yang berbeda jaringan dengan **kode jaringan** dan tautan undangan `archne://join?...`.
- Signaling terenkripsi, koneksi WebRTC langsung, dan **TURN** (Cloudflare, Metered, atau manual) sebagai cadangan. Lihat [Lintas jaringan dan TURN](#-lintas-jaringan-dan-turn).

### 🎨 Tampilan dan kenyamanan
- Tema terang dan gelap, **English** dan **Bahasa Indonesia**, serta notifikasi di desktop dan Android.
- Berjalan sebagai **aplikasi desktop**, **APK Android**, atau **langsung di peramban**.

---

## 📦 Instalasi

### Kebutuhan
- **Windows 10 / 11** untuk aplikasi desktop. Skrip `.bat` memasang Node.js LTS lewat `winget` bila belum ada.
- **Node.js 22.12 atau lebih baru** (disarankan 24) untuk menjalankan dari sumber, mode peramban, dan build.
- **Android 7.0 (API 24) atau lebih baru** untuk aplikasi Android.
- **Untuk membangun APK:** JDK 21 dan Android SDK (platform 36, CMake). `mobile.bat` memasang keduanya bila belum ada.

### Cara termudah (Windows)

```bash
git clone https://github.com/AdyXSetya/archne.git
cd archne
```

1. Jalankan **`setup.bat`**. Node.js dan dependensi dipasang otomatis.
2. Jalankan **`run.bat`** untuk membuka Archne.
3. *(Opsional)* Jalankan **`firewall.bat`** bila perangkat lain tidak bisa menemukanmu di jaringan. Skrip ini meminta hak administrator.

### Lewat terminal (semua sistem operasi)

```bash
npm install
npm start          # buka aplikasi desktop (Electron)
```

### Mode peramban / headless (Linux, macOS, Termux)

Tanpa Electron. Cocok untuk Termux di HP atau uji cepat.

```bash
npm install
npm run serve
# atau dengan opsi:
node server.js --name "Namaku" --port 8080 --data ./data-archne
```

Buka tautan yang dicetak di terminal. Tautan itu berisi token sesi yang hanya berlaku di perangkat tersebut.

| Opsi | Fungsi |
|---|---|
| `--name` | Nama tampilan (bawaan: nama pengguna sistem) |
| `--port` | Port UI (bawaan: dipilih otomatis) |
| `--data` | Folder data (bawaan: `~/.archne`) |

### Port yang dipakai

| Port | Protokol | Fungsi |
|---|---|---|
| `41234` | UDP | Penemuan peer di jaringan lokal |
| `41235` | TCP | Komunikasi antar peer (bawaan) |

Izinkan keduanya di firewall bila perangkat saling tidak terlihat.

---

## 🔨 Build

Hasil build ada di folder `dist/`. Installer dan APK hanya bisa dibangun di Windows.

**Satu klik:** `auto.bat` memasang yang belum ada (Node.js, dependensi, JDK 21, Android SDK) lalu membangun.

| Perintah | Hasil |
|---|---|
| `auto.bat` | Installer Windows dan `.exe` portable, plus APK debug |
| `auto.bat desktop` | Hanya installer Windows dan `.exe` portable |
| `auto.bat android` | Hanya APK debug (sama dengan `mobile.bat`) |
| `auto.bat all -Release` | APK rilis bertanda tangan |

Atau selangkah demi selangkah:

```bash
build.bat                     # Windows: installer NSIS + .exe portable (npm run dist)
mobile.bat                    # Android: APK debug (semua ABI)
mobile.bat -Install           # ...lalu pasang ke HP yang tersambung lewat adb
mobile.bat -Release           # APK rilis bertanda tangan
mobile.bat -Release -Aab      # ...plus AAB untuk Google Play
mobile.bat -Abis arm64-v8a    # satu ABI saja (APK lebih kecil)
build-all.bat                 # Windows dan Android sekaligus
```

Aplikasi Android adalah cangkang **Capacitor 8** dengan runtime **Node 24** dari `@capawesome/capacitor-nodejs`, jadi inti Archne yang sama berjalan langsung di HP. Runtime Node sekitar 120 MB per arsitektur CPU, sehingga APK universal membawa semuanya (`arm64-v8a`, `armeabi-v7a`, `x86_64`); AAB Play hanya mengirim yang cocok.

Sejak Electron 42, `npm install` tidak lagi mengunduh binary Electron. `setup.bat` mengunduhnya, atau otomatis saat `npm start` pertama.

#### Tanda tangan rilis (wajib dicadangkan)

`-Release` menandatangani APK dengan `%USERPROFILE%\.archne\archne-release.jks` (alias `archne`, kata sandi di `release.pass` di sebelahnya). Berkas dibuat saat build rilis pertama.

**Salin folder itu ke tempat pribadi** seperti flash disk. Jangan di-commit atau dibagikan (`.gitignore` sudah memblokir `*.jks`). Android hanya mengizinkan APK baru menimpa aplikasi terpasang bila keduanya ditandatangani kunci yang sama. Kalau kunci hilang, semua orang harus uninstall dulu dan kehilangan data lokalnya.

### Daftar skrip

| Skrip | Fungsi |
|---|---|
| `setup.bat` / `run.bat` / `serve.bat` | Pasang, jalankan aplikasi desktop, jalankan mode peramban |
| `debug.bat` | Jalankan dengan log diagnostik |
| `firewall.bat` | Buka aturan firewall Archne (admin) |
| `build.bat` / `mobile.bat` / `build-all.bat` | Bangun Windows, Android, atau keduanya |
| `auto.sh` (Linux / macOS / Termux) | Setup dan `./auto.sh serve` |

Log skrip tersimpan di folder `logs/`.

---

## 🧭 Cara kerja

- **Tanpa server.** Tiap perangkat menjalankan inti Archne sendiri. Peer ditemukan lewat siaran UDP di jaringan lokal, lalu bicara langsung lewat TCP. Antar jaringan memakai WebRTC.
- **Identitas berbasis kunci.** Tidak ada email, nomor telepon, atau kata sandi. ID-mu diturunkan dari kunci publik yang dibuat di perangkatmu, dan pesan ditandatangani dengan kunci pribadimu.
- **Terenkripsi.** Berkas dienkripsi dengan AES-256-GCM sebelum dikirim, dan sinyal lintas jaringan dibungkus enkripsi yang kuncinya diturunkan dari kode jaringan.
- **Titip pesan (store and forward).** Bila penerima offline, pesan terenkripsi dititipkan ke peer lain dengan kuota dan masa berlaku, lalu dikirim ulang saat penerima kembali.
- **Data tetap di perangkatmu.** Pesan, halaman, situs, dan berkas disimpan lokal. Tidak ada cloud.

> Archne belum diaudit keamanannya secara independen. Jangan jadikan satu-satunya sarana untuk komunikasi berisiko tinggi.

---

## 🌐 Lintas jaringan dan TURN

Mode lintas jaringan menghubungkan perangkat lewat WebRTC. Jalur **langsung** dicoba lebih dulu. Kalau terhalang, lalu lintas lewat **relay TURN**.

- **TURN disimpan di tiap perangkat**, bukan di jaringan. Bergabung ke jaringan tidak otomatis memberi TURN, kecuali undangannya membawa TURN.
- Perangkat tanpa TURN hanya mencoba koneksi langsung, yang bisa gagal bahkan di Wi-Fi yang sama (isolasi AP/klien, tanpa hairpin NAT, dua router di balik satu modem).
- **Cukup satu sisi yang punya TURN** agar pasangan itu bisa tersambung lewat relay.

| Status | Artinya |
|---|---|
| `langsung` | Tersambung langsung ke perangkat itu. |
| `lewat relay` | Tersambung lewat TURN. Berfungsi, dengan latensi sedikit lebih tinggi dan memakai kuota TURN. |
| `menyambung` | Percobaan koneksi sedang berjalan. |
| `gagal` | Semua jalur gagal. Paling sering karena kedua perangkat belum punya TURN. |

**Kalau ada perangkat berstatus `gagal`:** di perangkat yang punya TURN, buka **Lintas jaringan**, centang **Sertakan TURN-ku di undangan**, tekan **Buat undangan**, lalu gabung lewat undangan itu di perangkat yang gagal. Atau tambahkan penyedia TURN di pengaturan Lintas jaringan perangkat itu.

**Catatan keamanan.** Siapa pun yang memegang undangan berisi TURN bisa masuk jaringanmu dan memakai kuota TURN-mu. Bagikan hanya ke orang yang kamu percaya, dan tekan **Ganti kode** kalau bocor (ini mengeluarkan semua peserta saat ini).

**Titip pesan di broker.** Centang **Titipkan pesan terenkripsi ke broker** agar pesan tetap terkirim tanpa koneksi langsung. Isi pesan tetap terenkripsi, tetapi broker bisa melihat siapa menitip ke siapa, kapan, dan ukurannya.

### Android: layar terkunci dan latar belakang

Link lintas jaringan berjalan di dalam web view aplikasi, dan Android bisa menjedanya saat layar terkunci atau aplikasi ke latar belakang.

- HP yang terkunci bisa tampil **offline** (atau **online di latar**, titik kuning, bila intinya masih hidup). HP tersambung lagi sendiri tak lama setelah dibuka kuncinya atau Archne dibuka.
- **Pesan:** minta pengirim mencentang **Titipkan pesan terenkripsi ke broker**. HP mengambilnya saat kembali.
- **Panggilan dan situs yang di-host** butuh Archne terbuka di HP yang menerima panggilan atau menjadi host.
- Saat Android bertanya, pilih **Tanpa batasan** untuk pemakaian baterai. Di Xiaomi, Oppo, Vivo, dan sejenisnya, izinkan juga mulai otomatis (autostart) dan kunci Archne di daftar aplikasi terbaru.

---

## 🩹 Pemecahan masalah

| Masalah | Coba ini |
|---|---|
| Perangkat lain tidak bisa melihatku | Jalankan `firewall.bat` (Windows) atau izinkan UDP `41234` dan TCP `41235`. Pastikan kedua perangkat di Wi-Fi/LAN yang sama dan router tidak mengisolasi klien (AP isolation). |
| Tautan mode peramban tidak terbuka | Pakai tautan lengkap yang dicetak di terminal, termasuk tokennya, di perangkat yang sama dengan yang menjalankan `npm run serve`. |
| Teman beda jaringan | Pakai mode lintas jaringan: bagikan kode jaringan atau tautan undangan `archne://join?...`. |
| Panggilan gagal antar jaringan, atau perangkat berstatus `gagal` | Kedua sisi belum punya TURN yang berfungsi. Gabung lewat undangan yang menyertakan TURN, atau tambahkan penyedia TURN. Lihat [Lintas jaringan dan TURN](#-lintas-jaringan-dan-turn). |
| HP "offline" saat layar terkunci | Keterbatasan yang diketahui. Lihat [Android: layar terkunci dan latar belakang](#android-layar-terkunci-dan-latar-belakang). |
| Ada yang aneh | Jalankan `debug.bat`, cek folder `logs/`, lalu buka *issue* beserta detailnya. |
| Aplikasi Android bermasalah | Jalankan `adb logcat -s NodejsPlugin chromium Capacitor` untuk melihat log Node dan WebView. |
| APK baru tidak bisa menimpa yang lama | Kunci tanda tangannya berbeda. Uninstall aplikasi lama dulu (data lokal hilang). |
| Gradle gagal dan menyebut `capacitor-cordova-android-plugins` | Lihat `logs\mobile-decordova.log`. |

---

## 🚧 Keterbatasan dan rencana

**Keterbatasan yang diketahui**
- **Belum diaudit keamanannya secara independen.** Kunci privat disimpan di `identity.json` tanpa enkripsi tambahan (izin hanya untuk pemilik).
- Database MySQL adalah **emulasi di atas SQLite**, jadi tidak cocok dengan semua aplikasi. WordPress dan CMS lain tidak didukung. `ON UPDATE CURRENT_TIMESTAMP`, collation, dan komentar kolom belum didukung.
- Situs PHP belum berjalan di mode peramban (`server.js`).
- **Jadikan offline** hanya mengikuti referensi yang tertulis di CSS. URL yang dirakit saat jalan, serta layanan seperti peta, analitik, captcha, dan pembayaran, tetap butuh internet. Hanya penerapan terakhir yang bisa dibatalkan.
- Android bisa menjeda aplikasi saat layar terkunci (lihat di atas).
- Platform yang diuji: Windows dan Android.
- Memperbarui dari 0.30 atau lebih lama tidak membawa data lokal. Di Android, APK baru harus ditandatangani kunci yang sama dengan yang terpasang; kalau tidak, uninstall dulu.

**Rencana setelah 1.0**
- Ekstensi PHP `intl` dan `sodium` (lalu `gmp`, `xsl`, `gettext`) sebagai opsi per situs.
- PHP di mode peramban.
- Perlindungan kunci privat lewat penyimpanan aman sistem (Electron `safeStorage`, Android Keystore).
- Audit keamanan independen.

---

## 🛠 Pengembangan

```bash
npm install
npm start           # jalankan aplikasi
npm run serve       # mode peramban
```


### Struktur proyek

```
archne/
├── main.js, preload.js     Proses utama dan jembatan Electron
├── server.js               Mode peramban / headless
├── src/                    Inti: protokol, penyimpanan, IPC, kripto, host web, PHP, emulasi MySQL
│   └── core/               Modul inti (chat, panggilan, grup, halaman, ...)
├── renderer/               Antarmuka (HTML, CSS, JS)
│   ├── js/                 Logika UI per fitur
│   ├── css/                Gaya
│   ├── i18n/               Kamus bahasa (en, id)
│   └── vendor/             Pustaka pihak ketiga (MQTT, RNNoise)
├── mobile/                 Cangkang Android (Capacitor 8 + Node 24)
└── scripts/                Skrip setup dan build
```

> **Urutan muat skrip.** Skrip UI di `renderer/js/` adalah skrip global biasa yang dimuat sesuai urutan tag `<script>` di `renderer/archne-index.html`. Saat menambah berkas baru, taruh tag-nya di posisi yang tepat pada daftar itu.

### Menambah bahasa atau teks

Kunci teks baru harus ditambahkan di `renderer/i18n/archne-en.js` dan `archne-id.js` sekaligus. Samakan nama kunci dan gaya bahasanya dengan entri yang sudah ada.

---

## Cadangan dan pemulihan halaman

Seluruh Halamanmu bisa dicadangkan ke satu berkas `.archpg` dan dipulihkan di perangkat lain. Batas berikut sama dengan kode:

- Satu berkas (gambar, lampiran, atau video) maksimal **2 GiB**.
- Per postingan: maksimal 10 / 10 / 4 (gambar / lampiran / video).
- Satu arsip memuat maksimal **100.000** postingan dan **200.000** entri.
- Manifest arsip maksimal 32 MiB; JSON satu postingan maksimal 8 MiB.
- Komentar per arsip: maksimal 10.000 komentar + 10.000 nisan (penanda komentar terhapus); satu entri komentar maksimal 64 MiB.
- Reaksi (pada postingan dan pada komentar) ikut otomatis; satu entri reaksi maksimal 8 MiB. Seperti komentar, reaksi hanya dipulihkan di identitas yang sama dengan pembuat arsip, dan digabung per orang (yang terbaru menang, tidak ada reaksi yang dicabut).
- Format berkas: penanda awal `ARCHPGA1` ... `ARCHPGZ1` di akhir, dengan meta `fmt: 1`.

## 🤝 Kontribusi

Masukan, laporan bug, dan pull request sangat diterima. Baca [CONTRIBUTING.md](CONTRIBUTING.md) dulu, dan buka *issue* sebelum perubahan besar supaya arahnya sejalan. Untuk melaporkan celah keamanan, lihat [SECURITY.md](SECURITY.md).

## 📄 Lisensi

Dirilis di bawah [Lisensi MIT](LICENSE). Pakai, ubah, dan bagikan sesukamu, cukup sertakan pemberitahuan hak cipta dan lisensinya.

---

<div align="center">

Dibuat oleh **xyraori**

</div>

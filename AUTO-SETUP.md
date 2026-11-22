# Setup & build otomatis

## Windows (satu klik)
| Perintah | Hasil |
|---|---|
| `auto.bat` | pasang Node (via winget) + dependensi, bangun installer Windows **dan** APK debug |
| `auto.bat desktop` | hanya installer (`dist\Archne Setup *.exe` + portable) |
| `auto.bat android` | hanya APK debug (`dist\Archne-mobile-debug.apk`); sama dengan `mobile.bat` |
| `auto.bat all -Release` | APK rilis bertanda tangan (`dist\Archne-<versi>-android-release.apk`; keystore dibuat di `%USERPROFILE%\.archne\` bila belum ada) |
| `auto.bat all -Test` | jalankan `npm test` dulu (kegagalan tes tidak menghentikan build) |
| `auto.bat android -Install` | pasang APK ke HP lewat adb |

Otomatis dipasang bila belum ada: Node.js LTS, dependensi npm, JDK 21, Android SDK 36 + CMake. Pertama kali butuh internet dan puluhan menit.

Android hanya lewat `mobile.bat` (opsi: `-Install`, `-Release`, `-Aab`, `-Abis arm64-v8a+x86_64`). Bawaan semua ABI (arm64-v8a, armeabi-v7a, x86_64) agar semua perangkat didukung; `-Abis arm64-v8a` untuk APK lebih kecil. `libnode.so` ~120 MB per ABI (terkompresi lebih kecil).

**Simpan keystore** `%USERPROFILE%\.archne\archne-release.jks` + `release.pass`. Tanpa itu APK tidak bisa menimpa versi lama.

## Linux / macOS / Termux
`./auto.sh` (setup + tes), `./auto.sh serve` (mode peramban), `npm run serve`.

## Catatan
- Build Android memakai **Capacitor 8 + Node 24** (tanpa Cordova).
- Desktop memakai **Electron 45** + electron-builder 26. Sejak Electron 42, `npm install` TIDAK lagi mengunduh binary Electron; setup (`setup.bat`/`auto.js`) mengunduhnya lewat `npx install-electron`, atau otomatis saat `npm start` pertama.
- `engines: node >= 22.12` hanya untuk mesin build (syarat paket `electron` 45), bukan Node di dalam Electron/HP.
- `mobile.bat` menjalankan `scripts/mobile-decordova.js` setelah `cap sync`: CLI Capacitor selalu menulis ulang modul "cordova" kosong, dan script ini membuangnya. Bila build Gradle gagal menyebut `capacitor-cordova-android-plugins`, lihat `logs\mobile-decordova.log`.
- Log Node di HP: `adb logcat -s NodejsPlugin chromium Capacitor`.

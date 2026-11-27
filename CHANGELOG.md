# Changelog

All notable changes to Archne are listed here, newest first.
Indonesian version: [CHANGELOG.id.md](CHANGELOG.id.md).


## 1.0.0 (28 November 2026)

First stable release.

### Added
- **Web.** Host your own website from your device. Connected peers can browse it.
  - HTML, CSS, JS and **PHP** (PHP 8.3), with **SQLite** and a **MySQL-compatible** database.
  - File manager and editor, ZIP download and extract, database browser and SQL box.
  - **Cron jobs** for PHP sites, and **Make offline** to save CDN files locally.
  - Dashboard with memory, PHP Workers and storage, plus per-site resource limits.
  - Sites are private by default. Windows and Android.
- **Screen sharing in calls**, from Windows and Android, with optional system sound.
- **Watch a shared screen on your phone** in full screen, with pinch-to-zoom.
- **Page backup** now includes comments and reactions.
- **Database tab:** create, delete and reset SQLite databases without PHP; start or stop the MySQL-compatible server without the PHP engine and copy its connection address. MySQL dump import now reads binary values correctly.
- **Settings > General > App:** **Quit** (Android no longer needs "Force stop") and **Reset data** (wipes identity, chats, Pages and sites, with two confirmations).
- **"Online in background"** status (yellow dot) for a peer whose app is still running but whose link is paused, instead of showing "Offline".

### Security
- Files can only be sent from a file dialog, drag-and-drop or a capture made by Archne itself.
- Stricter app window, and an identity file that is never silently replaced.
- Data files are readable by the owner only (macOS/Linux).
- Sites from other people run isolated with no outside network access, and Archne warns before you open a stranger's site or type a password into one.


### Fixed
- Android: force close and endless loading when reopening the app.
- Android: faster call setup and more reliable TURN.
- Pages feed stopped loading more posts while scrolling.
- Android: the Web Dashboard and Cron could stay on "Loading…" forever when the app core stopped responding. They now time out, show a message with a Try again button, and recover on their own.
- Android: a large history sync (hundreds of messages per round) could freeze the app core and the UI, leaving the Web Dashboard and Cron on "Loading…" and making other peers see the phone drop. UI updates are now batched, the UI refreshes one request at a time, and the sync yields while importing messages.
- Opening a peer's site could fail with "owner is offline" and only work after several retries, mostly on a phone that had been in the background. A peer that looks offline is now asked directly before the error is shown.
- Opening a stranger's site for the first time no longer shows a crowded toolbar on small screens.
- The device info line no longer says "0 CPU cores" when the phone does not report them.

### Upgrading
- **From 0.31:** no data migration.
- **From 0.30 or older:** local data is not carried over.
- **Android:** the new APK installs over the old one only if both are signed with the same key. Otherwise uninstall first.

### Known limits
- The MySQL database is an emulation on top of SQLite, so it does not work with every application. WordPress and other CMSs are not supported.
- PHP sites do not run in browser mode (`server.js`) yet.
- The private key is stored in `identity.json` without extra encryption (owner-only permissions).
- Not independently security audited.
- The MySQL emulation does not support `ON UPDATE CURRENT_TIMESTAMP`, collations or column comments.
- **Make offline** only follows references written in the CSS. URLs built at runtime, and services such as maps, analytics, captcha and payments, still need the internet. Only the most recent apply can be undone.
- Android may pause the app when the screen is locked (see the README for what still works).

## 0.31.0 (22 November 2026)

A large internal upgrade. The Android shell and the desktop runtime were both replaced.

### Upgrading from 0.30.0
- **Local data is not migrated.** Chats, profile, and files from 0.30.0 are not carried over.
- **Android:** a new APK installs over the old one only if both are signed with the same key. If you build with the original `%USERPROFILE%\.archne\archne-release.jks`, the update installs normally. Otherwise uninstall the old app first.

### Android
- Rebuilt on **Capacitor 8** with the **Node 24** runtime from `@capawesome/capacitor-nodejs`. Cordova and `nodejs-mobile-cordova` are removed, along with the patch scripts they needed.
- **16 KB page size** supported: the APK passes `zipalign -P 16` and `libnode.so` is aligned for all ABIs.
- Supported ABIs: `arm64-v8a`, `armeabi-v7a`, `x86_64`. The universal debug APK is about 134 MB. Use `mobile.bat -Abis arm64-v8a` for a smaller build.
- Native features ported to Capacitor plugins: audio and call routing (earpiece / speaker), downloads and file picker, background service and notifications.
- Calls: incoming calls use the system call style (Android 12+) and appear over the lock screen. Answering from the notification is retried until the app confirms it.
- Pages: **export and import** now work on Android. Export saves a `.archpg` file to `Download/`; import opens the system file picker.
- Edge-to-edge layout for Android 15/16, a new splash screen and adaptive launcher icon.
- Back button closes dialogs and panels first, then steps back through chats, and finally hides the app instead of quitting.
- Opening web links now uses Chrome Custom Tabs. The old in-app browser bar (back / forward / close) is gone.
- New build entry point: `mobile.bat` (`-Install`, `-Release`, `-Aab`, `-Abis`). Old Cordova build scripts were removed.
- `applicationId` unchanged (`com.xyraori.archne`). Version code is now 3100.

### Desktop
- **Electron 33 → 45** and **electron-builder 25 → 26.18**, pinned to exact versions.
- Electron no longer downloads its binary during `npm install` (since Electron 42). Setup scripts fetch it, or it is downloaded on the first `npm start`.
- Updated for Electron 35 to 45 breaking changes (console message arguments, lowercase `app.commandLine` switches, sandboxed preload).

### Cross-network and calls
- MQTT client library **5.10.1 → 5.16.1**, which includes several security fixes for malformed or malicious broker packets. Archne sets `reconnectOnConnackError` so reconnect behavior stays the same.
- Noise suppression (RNNoise) files verified as identical to the latest upstream release; no change in call quality.
- Added `renderer/vendor/VERSIONS.txt` (origin and SHA-256 of bundled libraries) and the missing RNNoise licenses.

### Build and tooling
- Node **22.12 or newer** is required on the build machine. JDK 21 and Android SDK 36 are installed automatically by `mobile.bat`.
- `resedit` 3.1.0. `npm audit` reports no vulnerabilities in production dependencies.
- Removed the Node 12 compatibility layer (`archne-compat.js`).

### Known limits
- Release build still needs a manual test matrix on real devices (Android 7 to 16, 16 KB emulator, phone to phone and phone to desktop).
- Foreground service time limits on Android 15+ and Google Play declarations are not handled yet, because releases are GitHub-only for now.

## 0.30.0

Last release on Cordova (Android) and Electron 33 (desktop). Chat, groups, calls, files, Pages, cross-network mode, English and Indonesian.

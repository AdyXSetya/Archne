# Changelog

All notable changes to Archne are listed here, newest first.
Indonesian version: [CHANGELOG.id.md](CHANGELOG.id.md).

## 0.31.0 (unreleased)

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
- Tests: 193 of 200 pass on Windows (Node 26). The 7 failures depend on a real network and change from run to run; all pass on Linux. See `docs/baseline.txt`.

### Known limits
- Release build still needs a manual test matrix on real devices (Android 7 to 16, 16 KB emulator, phone to phone and phone to desktop).
- Foreground service time limits on Android 15+ and Google Play declarations are not handled yet, because releases are GitHub-only for now.

## 0.30.0

Last release on Cordova (Android) and Electron 33 (desktop). Chat, groups, calls, files, Pages, cross-network mode, English and Indonesian.

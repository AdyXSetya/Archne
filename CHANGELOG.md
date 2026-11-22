# Changelog

All notable changes to Archne are listed here, newest first.
Indonesian version: [CHANGELOG.id.md](CHANGELOG.id.md).

## 0.32.0 (not yet released)

Focus: screen sharing with sound, plus several bug fixes.

### Upgrading from 0.31.0
- **Android:** the new APK installs over 0.31.0 only if it is signed with the same key (version code 3200). Otherwise uninstall the old app first.

### Screen sharing
- **Share your screen in a call (desktop).** A "Share screen" button appears in an active call. You choose the screen or window yourself (Archne's own window is not offered); nothing is shared automatically. A red "You're sharing your screen" indicator stays visible, also in full screen and in the small call bar. The screen takes the camera's place on the same video track without renegotiating, so the call does not drop. The camera comes back when you stop, including when you press "Stop sharing" in the system bar, and sharing ends by itself when the call ends. Only one person can share per call. v0.31.0 peers ignore the extra status field and are unaffected. Covered by automated tests only; not yet tried on two real Windows machines.
- **System sound on Windows (opt-in).** The picker has a "Share system audio" box, off by default, for Windows and whole-screen sharing only. It mixes the computer's sound with your microphone; Mute silences only the microphone. Use headphones to avoid echo. Not yet tried on real machines.
- **Watch a shared screen on the phone.** A shared screen is shown whole, never cropped. On Android a "Full screen" button (and a hint when sharing starts) opens landscape full-screen viewing: pinch to zoom up to 5x and drag, double-tap to zoom in or reset. The Back button, sharing stopping, the call ending, minimizing the call, or Picture-in-Picture leave it and restore the orientation. The logic is tested; the full-screen mode and gestures are not yet tried on a phone.
- **Share your screen and system sound from the phone.** A new native plugin (`ArchneScreen`) captures the screen (MediaProjection) and system media sound (AudioPlaybackCapture, Android 10+) and hands them to the call over an on-device WebRTC loopback, so the existing call code sends them exactly like desktop. Capture runs in a `mediaProjection` foreground service, so it keeps going when Archne is in the background. Archne's own voice output is excluded, so the other side does not hear themselves. Reported working on a test phone; the detailed device checks (rotation, Android 14/15, heat and battery) are still in progress, see `docs/PLANNING-0.32.0.md`, phase E.5.
- **Quality limits.** A shared screen is sent to each viewer at up to 3 Mbps and 30 fps. Phone capture is capped at 1280 on the long side and 720 on the short side. The upload multiplies with the number of viewers (mesh), so a warning appears from 3 viewers. These are starting values, not yet tuned on real networks.

### Pages
- **Page backup now carries comments and reactions.** Export saves post reactions and comment reactions (a `reactions` entry in the archive; the `fmt: 1` format is unchanged and older archives still read). The "Include comments on export" checkbox is now on by default. Import restores reactions only under the same identity as the archive's creator (reactions are unsigned, so an archive from another identity is not trusted; its posts still import and the import screen explains why). Reactions merge per person: the newest wins, existing reactions are never removed, and re-importing changes nothing. Comment reactions are included only when their comments are. Archive contents are validated (counts, owner, ids, emoji, 256-person cap per target). New test: `pagerxarc`, plus coverage in `pagearcipc`, `pagearcui`, `pagearcdoc`.
- **Fix: feed never loaded more on scroll (stuck "loading" at the end) and Esc did not close a Page.** `archne-pages.js` attached a scroll listener to `#pglist` at load time, but that element only exists once a Page is opened, so the script threw `Cannot read properties of null` and the two listeners after it were never registered. The listener now sits on the static `#pgbody`. New test `pagesinit` checks the real HTML.

### Android
- **Faster call setup.** TURN credentials are pre-warmed at startup and fetched in parallel with the microphone permission (previously sequential, adding up to 8 s).
- **ICE candidates sent in parallel.** Previously each waited for the prior one to be acked (3 s cap), so one slow send stalled the rest. Now they wait only for the offer/answer and go out concurrently; message format unchanged, so older peers still work.
- **More reliable TURN.** A transient failure fetching TURN credentials is retried once (rejected tokens/IDs are not), per-request timeout is 4 s, and the backoff after a failure drops from 30 s to 5 s. If a cross-network call runs without TURN (not set up, or fetch failed), a notice appears immediately instead of failing silently after 30 s.
- **Fix for occasional force close on Android (when reopening the app).** The Node.js plugin tracked "already started" per object, but Node may only be started once per process. When the Activity is recreated while the process lives on (kept by the foreground service), Node was started a second time and `node::Start` called `abort()`. That state is now process-wide via `scripts/mobile-patch-node.js`, run by `mobile.ps1` after `npm ci`; the second load reuses the running Node. Not tested on a device yet.
- **Fix: endless "loading" when reopening the app while the foreground service is alive.** After the Activity was recreated, the Node plugin object never became ready, so the first message to Node was refused and the page waited forever. Node is now started manually: the shell asks the native side (`ArchneBackground.info`) for the running Node's port and token and loads the UI at once, and starts Node only when none is running. Plugin calls in the shell no longer assume they return a Promise (Capacitor 8 plugin calls return nothing). Known limit: after a reopen, importing a Pages archive does not reach Node until a cold start. Not tested on a device yet.
- **TURN hint no longer nags.** The "TURN not set up / unreachable" notice used to appear at the start of every cross-network call even when it connected fine. It now shows only if the connection is still not active after 10 s or fails, once per call, and never when the call connects.

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
- Tests: 193 of 200 pass on Windows (Node 26). The 7 failures depend on a real network and change from run to run; all pass on Linux.

### Known limits
- Release build still needs a manual test matrix on real devices (Android 7 to 16, 16 KB emulator, phone to phone and phone to desktop).
- Foreground service time limits on Android 15+ and Google Play declarations are not handled yet, because releases are GitHub-only for now.

## 0.30.0

Last release on Cordova (Android) and Electron 33 (desktop). Chat, groups, calls, files, Pages, cross-network mode, English and Indonesian.

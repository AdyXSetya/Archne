param([switch]$Release, [switch]$Install)
. "$PSScriptRoot\_common.ps1"
. "$PSScriptRoot\_android.ps1"
try {
  Ensure-Node
  Use-AndroidEnv
  Use-Node20
  Use-Gradle
  $Version = (Get-Content "$Root\package.json" -Raw | ConvertFrom-Json).version
  $NodePlugin = if ($env:ARCHNE_NODE_PLUGIN) { $env:ARCHNE_NODE_PLUGIN } else { 'nodejs-mobile-cordova@0.4.3' }
  $App = "$Root\build-android\app"
  New-Item -ItemType Directory -Force -Path $App | Out-Null

  # 1. template + kode terbaru (src dan renderer disalin ke proyek Node di dalam aplikasi)
  Log 'Menyalin template dan kode terbaru...'
  robocopy "$Root\android" $App /E /XD node_modules platforms plugins /XF package-lock.json "$Root\android\package.json" /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy gagal (kode $LASTEXITCODE)" }
  # package.json proyek Cordova hanya disalin sekali. `cordova platform/plugin add` menyimpan cordova-android dan plugin ke dalamnya, dan
  # `plugin add` menjalankan `npm install`: kalau berkas ini ditimpa template tiap build, npm menganggap cordova-android "berlebih" dan
  # menghapusnya dari node_modules, lalu Api.js platform gagal dimuat ("Could not load API for android project").
  if (-not (Test-Path "$App\package.json")) { Copy-Item "$Root\android\package.json" "$App\package.json" }
  $np = "$App\www\nodejs-project"
  foreach ($d in 'src', 'renderer') { if (Test-Path "$np\$d") { Remove-Item "$np\$d" -Recurse -Force }; Copy-Item "$Root\$d" "$np\$d" -Recurse }

  # 2. Cordova + platform + plugin (hanya sekali)
  $env:CORDOVA_TELEMETRY = '0'; $env:NODEJS_MOBILE_BUILD_NATIVE_MODULES = '0'
  if (-not (Test-Path "$App\node_modules\.bin\cordova.cmd")) { Run-Batch @("cd /d `"$App`"", 'call npm.cmd install --no-audit --no-fund') 'android-npm.log' }
  $cdv = "call node `"$Root\scripts\cdv.js`""
  # `prepare` mencari MainActivity di folder paket sesuai id di config.xml (com.xyraori.archne -> com\xyraori\archne); tidak ada di sana = gagal.
  # Folder platform yang rusak (build sebelumnya terhenti di tengah `prepare`, antivirus menghapus berkas, dll.) tetap lolos Test-Path di bawah. Bila MainActivity hilang, platform DAN plugins dibuat ulang; loop plugin di bawah memasang semuanya lagi.
  $javaSrc = "$App\platforms\android\app\src\main\java"
  if (Test-Path "$App\platforms\android") {
    $wid = [regex]::Match((Get-Content "$App\config.xml" -Raw), '<widget[^>]*\sid="([^"]+)"').Groups[1].Value
    $actDir = if ($wid) { Join-Path $javaSrc ($wid -replace '-', '_' -replace '\.', '\') } else { $javaSrc }
    $hasActivity = $false
    if (Test-Path $actDir) { $hasActivity = [bool](Get-ChildItem $actDir -Filter *.java -ErrorAction SilentlyContinue | Where-Object { Select-String -Path $_.FullName -Pattern 'extends\s+CordovaActivity' -Quiet } | Select-Object -First 1) }
    if (-not $hasActivity) { Log 'Folder platform Android rusak (MainActivity tidak ada di folder paketnya): platform dan plugin dihapus, dibuat ulang dari awal.'; Remove-Item "$App\platforms\android" -Recurse -Force; if (Test-Path "$App\plugins") { Remove-Item "$App\plugins" -Recurse -Force } } # `platform add` TIDAK memasang ulang plugin: tanpa baris plugins ini APK jadi ±5 MB tanpa libnode.so (mesin Node) dan plugin Archne
  }
  if (-not (Test-Path "$App\platforms\android")) { Run-Batch @("cd /d `"$App`"", "$cdv platform add $AndroidPlatform") 'android-platform.log' }
  # Plugin lokal yang sudah terpasang di build-android\app\plugins adalah SALINAN: perubahan di android\localplugins tidak ikut terbawa kecuali dipasang ulang
  # (cordova prepare menyalin dari salinan itu, bukan dari sumbernya). Pembandingnya hash isi src\ dan plugin.xml, bukan nomor versi, supaya
  # perbaikan kecil di Java tidak bergantung pada ingatan menaikkan versi.
  function Get-PluginHash([string]$dir) {
    $base = (Resolve-Path $dir).Path.TrimEnd('\')
    $files = @(Get-ChildItem "$dir\src" -Recurse -File -ErrorAction SilentlyContinue) + @(Get-Item "$dir\plugin.xml")
    ($files | Sort-Object FullName | ForEach-Object { $_.FullName.Substring($base.Length) + ':' + (Get-FileHash $_.FullName -Algorithm SHA256).Hash }) -join '|'
  }
  foreach ($lp in 'archne-downloads', 'archne-background', 'archne-audio') {
    $srcDir = "$App\localplugins\$lp"; $dstDir = "$App\plugins\$lp"
    if ((Test-Path "$srcDir\plugin.xml") -and (Test-Path "$dstDir\plugin.xml")) {
      if ((Get-PluginHash $srcDir) -ne (Get-PluginHash $dstDir)) { Log "Plugin $lp berubah: dipasang ulang."; Run-Batch @("cd /d `"$App`"", "$cdv plugin rm $lp") "android-plugin-rm-$lp.log" }
    }
  }
  foreach ($p in @(@('nodejs-mobile-cordova', $NodePlugin), @('cordova-plugin-file-opener2', 'cordova-plugin-file-opener2'), @('cordova-plugin-inappbrowser', 'cordova-plugin-inappbrowser'), @('archne-downloads', "`"$App\localplugins\archne-downloads`""), @('archne-background', "`"$App\localplugins\archne-background`""), @('archne-audio', "`"$App\localplugins\archne-audio`""))) {
    if (-not (Test-Path "$App\plugins\$($p[0])")) { Run-Batch @("cd /d `"$App`"", "$cdv plugin add $($p[1])") "android-plugin-$($p[0]).log" }
  }
  # 2b. tambal semua hook nodejs-mobile-cordova 0.4.3 (android + both): ia memanggil `new platformAPI()` tanpa argumen, padahal
  #     cordova-android >= 10 mewajibkan folder platform (path.join(undefined) -> ERR_INVALID_ARG_TYPE). Aman dijalankan berulang.
  $hookDir = "$App\plugins\nodejs-mobile-cordova\install\hooks"
  $patched = 0
  foreach ($sub in 'both', 'android') {
    if (-not (Test-Path "$hookDir\$sub")) { continue }
    foreach ($f in Get-ChildItem "$hookDir\$sub" -Filter *.js) {
      $src = [IO.File]::ReadAllText($f.FullName)
      if ($src.Contains('new platformAPI()')) {
        [IO.File]::WriteAllText($f.FullName, $src.Replace('new platformAPI()', "new platformAPI('android', platformPath)"), (New-Object Text.UTF8Encoding($false)))
        $patched++
      }
    }
  }
  Log "Hook nodejs-mobile-cordova ditambal: $patched berkas (0 = sudah ditambal sebelumnya)."
  # 2c. build.gradle milik plugin memaksa ext.cdvMinSdkVersion = 22 (menimpa config.xml), padahal CordovaLib 12 butuh minSdk 24.
  #     Ditambal di sumber plugin dan di salinannya dalam platforms\android. Aman dijalankan berulang.
  $sdkPatched = 0
  foreach ($root2 in "$App\plugins\nodejs-mobile-cordova", "$App\platforms\android") {
    if (-not (Test-Path $root2)) { continue }
    foreach ($f in Get-ChildItem $root2 -Recurse -Filter *.gradle -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\(build|\.gradle|node_modules)\\' }) {
      $src = [IO.File]::ReadAllText($f.FullName)
      if ($src -match 'ext\.cdvMinSdkVersion\s*=\s*22\b') {
        [IO.File]::WriteAllText($f.FullName, ($src -replace 'ext\.cdvMinSdkVersion\s*=\s*22\b', 'ext.cdvMinSdkVersion = 24'), (New-Object Text.UTF8Encoding($false)))
        $sdkPatched++
      }
    }
  }
  Log "minSdk plugin dinaikkan ke 24: $sdkPatched berkas (0 = sudah ditambal sebelumnya)."
  Run-Batch @("cd /d `"$App`"", "$cdv prepare android") 'android-prepare.log'

  # 3. bangun
  if ($Release) {
    $ksDir = Join-Path $env:USERPROFILE '.archne'; $ks = "$ksDir\archne-release.jks"; $pf = "$ksDir\release.pass"
    New-Item -ItemType Directory -Force -Path $ksDir | Out-Null
    if (-not (Test-Path $ks)) {
      Log "Membuat kunci tanda tangan APK baru di $ks (SIMPAN berkas ini; tanpanya APK tidak bisa diperbarui di atas yang lama)"
      $pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
      Set-Content -Path $pf -Value $pw -Encoding ASCII
      Run-Batch @("`"$env:JAVA_HOME\bin\keytool.exe`" -genkeypair -v -keystore `"$ks`" -alias archne -keyalg RSA -keysize 2048 -validity 10000 -storepass $pw -keypass $pw -dname `"CN=Archne, O=Local, C=ID`"") 'android-keytool.log'
    }
    $pw = (Get-Content $pf -Raw).Trim()
    @{ android = @{ release = @{ keystore = $ks; storePassword = $pw; alias = 'archne'; password = $pw; keystoreType = ''; packageType = 'apk' } } } | ConvertTo-Json -Depth 5 | Set-Content "$App\build.json" -Encoding ASCII
    Log 'Membangun APK rilis (pertama kali Gradle mengunduh banyak komponen, harap sabar)...'
    Run-Batch @("cd /d `"$App`"", "$cdv build android --release --packageType=apk --buildConfig=build.json") 'android-build.log'
    Remove-Item "$App\build.json" -Force -ErrorAction SilentlyContinue
    $apk = Get-ChildItem "$App\platforms\android\app\build\outputs\apk\release" -Filter *.apk | Select-Object -First 1
    $tag = 'release'
  } else {
    Log 'Membangun APK debug (pertama kali Gradle mengunduh banyak komponen, harap sabar)...'
    Run-Batch @("cd /d `"$App`"", "$cdv build android --debug") 'android-build.log'
    $apk = Get-ChildItem "$App\platforms\android\app\build\outputs\apk\debug" -Filter *.apk | Select-Object -First 1
    $tag = 'debug'
  }
  if (-not $apk) { throw 'Build selesai tapi APK tidak ditemukan. Lihat logs\android-build.log' }
  # Pengaman: APK yang sehat memuat mesin Node (libnode.so, puluhan MB). Di bawah 20 MB berarti plugin nodejs-mobile tidak ikut terpasang.
  if ($apk.Length -lt 20MB) { throw ('APK hanya ' + [math]::Round($apk.Length / 1MB, 1) + ' MB: plugin nodejs-mobile tidak ikut. Hapus folder build-android\\app\\platforms dan build-android\\app\\plugins, lalu jalankan ulang.') }
  New-Item -ItemType Directory -Force -Path "$Root\dist" | Out-Null
  $out = "$Root\dist\Archne-$Version-android-$tag.apk"
  Copy-Item $apk.FullName $out -Force
  Log ("Selesai: " + $out + "  (" + [math]::Round((Get-Item $out).Length / 1MB, 1) + " MB)")

  if ($Install) {
    $n = (& adb devices | Select-String -Pattern "`tdevice$").Count
    if ($n -lt 1) { Log 'Tidak ada HP terhubung lewat adb (aktifkan USB debugging). Salin APK ke HP secara manual.' }
    else { Run-Batch @("adb install -r `"$out`"") 'android-install.log'; Log 'Terpasang di HP.' }
  }
  Start-Process explorer.exe "$Root\dist"
} catch { Log "ERROR: $($_.Exception.Message)"; exit 1 }

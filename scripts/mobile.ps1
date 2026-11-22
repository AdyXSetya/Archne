# Bangun APK Android (Capacitor 8 + Node 24) dari mobile/. Satu-satunya jalur build Android. Hanya karakter ASCII.
#   mobile.bat                          -> APK debug (semua ABI: arm64-v8a, armeabi-v7a, x86_64)
#   mobile.bat -Install                 -> lalu pasang ke HP lewat adb
#   mobile.bat -Release                 -> APK rilis bertanda tangan (keystore dibuat di %USERPROFILE%\.archne\ bila belum ada)
#   mobile.bat -Release -Aab            -> juga AAB untuk Google Play
#   mobile.bat -Abis arm64-v8a          -> hanya ABI tertentu (APK lebih kecil; tiap ABI menambah ukuran karena libnode.so)
param([switch]$Install, [switch]$Release, [switch]$Aab, [string]$Abis = 'arm64-v8a+armeabi-v7a+x86_64')
. "$PSScriptRoot\_common.ps1"
. "$PSScriptRoot\_android.ps1"

try {
  Log '=== Archne mobile (Capacitor 8 + Node 24) ==='
  if ($Abis -notmatch '^(arm64-v8a|armeabi-v7a|x86_64)([+,](arm64-v8a|armeabi-v7a|x86_64))*$') { throw "ABI tidak dikenal: $Abis (pakai arm64-v8a, armeabi-v7a, x86_64; pisahkan dengan +)" }
  $Abis = $Abis -replace ',', '+'
  Ensure-Node
  Ensure-Jdk21
  if (-not (Test-AndroidSdk)) { Log 'Android SDK belum lengkap, memasang...'; Ensure-AndroidSdk }
  $env:ANDROID_HOME = $SdkRoot; $env:ANDROID_SDK_ROOT = $SdkRoot; $env:Path = "$SdkRoot\platform-tools;$env:Path"
  $Mob = "$Root\mobile"
  $Version = (Get-Content "$Mob\package.json" -Raw | ConvertFrom-Json).version

  if ($Release) {
    $ksDir = Join-Path $env:USERPROFILE '.archne'; $ks = "$ksDir\archne-release.jks"; $pf = "$ksDir\release.pass"
    New-Item -ItemType Directory -Force -Path $ksDir | Out-Null
    if (-not (Test-Path $ks)) {
      Log "Membuat kunci tanda tangan baru di $ks (SIMPAN berkas ini; tanpanya APK tidak bisa diperbarui di atas yang lama)"
      $pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
      Set-Content -Path $pf -Value $pw -Encoding ASCII
      $env:ARCHNE_KS_PASS = $pw
      Run-Batch @("`"$env:JAVA_HOME\bin\keytool.exe`" -genkeypair -v -keystore `"$ks`" -alias archne -keyalg RSA -keysize 2048 -validity 10000 -storepass:env ARCHNE_KS_PASS -keypass:env ARCHNE_KS_PASS -dname `"CN=Archne, O=Local, C=ID`"") 'mobile-keytool.log'
    }
    # Sandi hanya lewat variabel lingkungan proses ini (dibaca build.gradle); tidak masuk log.
    $env:ARCHNE_KS = $ks; $env:ARCHNE_KS_PASS = (Get-Content $pf -Raw).Trim()
  }

  Set-Location $Mob
  Run-Logged 'npm.cmd ci --no-audit --no-fund' 'mobile-npm.log'
  # Node hanya boleh dimulai sekali per proses; tanpa tambalan ini plugin crash saat Activity dibuat ulang (lihat scripts/mobile-patch-node.js).
  Run-Logged "node `"$Root\scripts\mobile-patch-node.js`"" 'mobile-patchnode.log'
  Run-Logged "node `"$Root\scripts\mobile-sync.js`"" 'mobile-sync.log'
  Run-Logged 'npx.cmd cap sync android' 'mobile-capsync.log'
  # cap sync selalu menulis ulang kerangka "cordova" kosong; dibuang di sini (lihat scripts/mobile-decordova.js).
  Run-Logged "node `"$Root\scripts\mobile-decordova.js`"" 'mobile-decordova.log'
  Log "Membangun APK ($Abis)..."
  Set-Location "$Mob\android"
  $task = if ($Release) { 'assembleRelease' } else { 'assembleDebug' }
  if ($Release -and $Aab) { $task += ' bundleRelease' }
  Run-Logged "gradlew.bat $task -Parchne.abis=$Abis --no-daemon" 'mobile-gradle.log'
  Set-Location $Root

  $tag = if ($Release) { 'release' } else { 'debug' }
  $apk = "$Mob\android\app\build\outputs\apk\$tag\app-$tag.apk"
  if (-not (Test-Path $apk)) { throw "APK tidak ditemukan ($apk). Lihat logs\mobile-gradle.log" }
  New-Item -ItemType Directory -Force -Path "$Root\dist" | Out-Null
  $out = if ($Release) { "$Root\dist\Archne-$Version-android-release.apk" } else { "$Root\dist\Archne-mobile-debug.apk" }
  Copy-Item $apk $out -Force
  $rep = @("APK: $out  ($([math]::Round((Get-Item $out).Length / 1MB, 1)) MB)  ABI: $Abis")
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($out)
  foreach ($e in $zip.Entries) { if ($e.FullName -like 'lib/*/*.so') { $rep += ("  {0}  {1} MB (terkompresi {2} MB)" -f $e.FullName, [math]::Round($e.Length / 1MB, 1), [math]::Round($e.CompressedLength / 1MB, 1)) } }
  $zip.Dispose()
  $za = "$SdkRoot\build-tools\36.0.0\zipalign.exe"
  & $za -c -P 16 -v 4 $out *> $null
  $rep += "zipalign -c -P 16 : " + $(if ($LASTEXITCODE -eq 0) { 'LULUS' } else { "GAGAL (exit $LASTEXITCODE)" })
  if ($Release -and $Aab) {
    $bundle = "$Mob\android\app\build\outputs\bundle\release\app-release.aab"
    if (Test-Path $bundle) { $o2 = "$Root\dist\Archne-$Version-android-release.aab"; Copy-Item $bundle $o2 -Force; $rep += "AAB: $o2  ($([math]::Round((Get-Item $o2).Length / 1MB, 1)) MB)" }
    else { $rep += 'AAB tidak ditemukan (lihat logs\mobile-gradle.log)' }
  }
  $rep | Set-Content "$Root\logs\mobile-report.txt" -Encoding ASCII
  $rep | ForEach-Object { Log $_ }
  if ($Install) {
    $n = (& adb devices | Select-String -Pattern "`tdevice$").Count
    if ($n -lt 1) { Log "Tidak ada HP terhubung lewat adb. Salin $out ke HP." }
    else { & adb install -r $out; & adb shell am start -n com.xyraori.archne/.MainActivity; Log 'Terpasang. Log: adb logcat -s NodejsPlugin chromium Capacitor' }
  }
  Log 'MOBILE SELESAI.'
} catch { Log "ERROR: $($_.Exception.Message)"; Set-Location $Root; exit 1 }

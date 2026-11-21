# Fungsi khusus Android (Capacitor 8). Dipanggil lewat dot-source setelah _common.ps1. Hanya karakter ASCII.
$SdkRoot      = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$CmdToolsUrl  = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
# platform 36 + build-tools 36.0.0 (zipalign -P 16) + CMake 3.22.1 (membangun libcapacitor-nodejs). NDK dipasang Gradle sendiri bila belum ada.
$SdkPackages  = @('platform-tools', 'platforms;android-36', 'build-tools;36.0.0', 'cmake;3.22.1')

function Set-UserEnv($name, $value) {
  [Environment]::SetEnvironmentVariable($name, $value, 'User')
  Set-Item -Path "Env:$name" -Value $value
}

# Jalankan beberapa baris perintah lewat berkas .cmd sementara; keluaran ke logs\<logName>. Berhenti di perintah pertama yang gagal.
function Run-Batch($lines, $logName) {
  $log = "$Root\logs\$logName"
  $f = "$Root\logs\_run_$logName.cmd"
  $body = ($lines | ForEach-Object { "$_ || exit /b 1" }) -join "`r`n"
  Set-Content -Path $f -Encoding ASCII -Value ("@echo off`r`n(`r`n$body`r`n) > `"$log`" 2>&1")
  Log "> $($lines -join ' & ')"
  & cmd /c $f
  $code = $LASTEXITCODE
  Remove-Item $f -Force -ErrorAction SilentlyContinue
  if ($code -ne 0) {
    Log "GAGAL (exit $code). 40 baris terakhir dari logs\$logName :"
    Get-Content $log -Tail 40 | ForEach-Object { Write-Host $_ }
    throw "Perintah gagal: $($lines -join ' & ')"
  }
}

function Test-Jdk21($dir) {
  if (-not $dir -or -not (Test-Path "$dir\bin\javac.exe") -or -not (Test-Path "$dir\release")) { return $false }
  return [bool](Get-Content "$dir\release" -ErrorAction SilentlyContinue | Select-String -Pattern 'JAVA_VERSION="21\.')
}

function Find-Jdk21 {
  $c = @($env:JAVA_HOME_21, $env:JAVA_HOME)
  foreach ($r in @('C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Microsoft', 'C:\Program Files\Java', 'C:\Program Files\Android\Android Studio\jbr')) {
    if (Test-Path $r) { $c += (Get-ChildItem $r -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^jdk-?21' } | ForEach-Object { $_.FullName }) }
  }
  foreach ($d in $c) { if (Test-Jdk21 $d) { return $d } }
  return $null
}

# JDK 21 hanya untuk proses ini (JAVA_HOME pengguna tidak diubah).
function Ensure-Jdk21 {
  $jdk = Find-Jdk21
  if (-not $jdk) {
    Log 'JDK 21 belum ada. Memasang Temurin 21 via winget (bisa muncul jendela izin admin)...'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'winget tidak ada. Pasang JDK 21 (Temurin) dari https://adoptium.net lalu jalankan ulang.' }
    winget install -e --id EclipseAdoptium.Temurin.21.JDK --accept-source-agreements --accept-package-agreements --silent
    $jdk = Find-Jdk21
    if (-not $jdk) { throw 'JDK 21 terpasang tapi belum ditemukan. Tutup jendela ini, buka lagi, lalu jalankan ulang.' }
  }
  $env:JAVA_HOME = $jdk; $env:Path = "$jdk\bin;$env:Path"
  Log "JDK 21: $jdk"
}

function Test-AndroidSdk {
  return (Test-Path "$SdkRoot\platforms\android-36") -and (Test-Path "$SdkRoot\build-tools\36.0.0") -and (Test-Path "$SdkRoot\cmake\3.22.1")
}

function Ensure-AndroidSdk {
  $sdkm = "$SdkRoot\cmdline-tools\latest\bin\sdkmanager.bat"
  if (-not (Test-Path $sdkm)) {
    Log "Mengunduh Android command-line tools (sekitar 150 MB)..."
    New-Item -ItemType Directory -Force -Path $SdkRoot | Out-Null
    $zip = Join-Path $env:TEMP 'archne-cmdline-tools.zip'
    $tmp = Join-Path $env:TEMP 'archne-cmdline-tools'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $CmdToolsUrl -OutFile $zip -UseBasicParsing
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path "$SdkRoot\cmdline-tools" | Out-Null
    if (Test-Path "$SdkRoot\cmdline-tools\latest") { Remove-Item "$SdkRoot\cmdline-tools\latest" -Recurse -Force }
    Move-Item "$tmp\cmdline-tools" "$SdkRoot\cmdline-tools\latest"
    Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
  } else { Log 'Android command-line tools sudah ada.' }
  Set-UserEnv 'ANDROID_HOME' $SdkRoot
  Set-UserEnv 'ANDROID_SDK_ROOT' $SdkRoot

  $yes = "$Root\logs\yes.txt"
  Set-Content -Path $yes -Encoding ASCII -Value ((1..80 | ForEach-Object { 'y' }) -join "`r`n")
  Log 'Menerima lisensi Android SDK...'
  Run-Batch @("call `"$sdkm`" --sdk_root=`"$SdkRoot`" --licenses < `"$yes`"") 'sdk-licenses.log'
  Log "Memasang paket SDK: $($SdkPackages -join ', ')"
  $pk = ($SdkPackages | ForEach-Object { "`"$_`"" }) -join ' '
  Run-Batch @("call `"$sdkm`" --sdk_root=`"$SdkRoot`" $pk") 'sdk-install.log'
}

# Fungsi khusus Android. Dipanggil lewat dot-source setelah _common.ps1. Hanya karakter ASCII.
$SdkRoot      = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$CmdToolsUrl  = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
$NdkVersion   = '25.2.9519653'
$AndroidPlatform = 'android@12.0.1'   # cordova-android
$SdkPackages  = @('platform-tools', 'platforms;android-33', 'platforms;android-34', 'build-tools;33.0.2', 'build-tools;34.0.0', "ndk;$NdkVersion")

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

function Test-Jdk17($dir) {
  if (-not $dir -or -not (Test-Path "$dir\bin\javac.exe") -or -not (Test-Path "$dir\release")) { return $false }
  return [bool](Get-Content "$dir\release" -ErrorAction SilentlyContinue | Select-String -Pattern 'JAVA_VERSION="17\.')
}

function Find-Jdk17 {
  $cands = @($env:JAVA_HOME)
  foreach ($root in @('C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Microsoft', 'C:\Program Files\Java', 'C:\Program Files\Android\Android Studio\jbr')) {
    if (Test-Path $root) { $cands += (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^jdk-?17' } | ForEach-Object { $_.FullName }) }
  }
  foreach ($c in $cands) { if (Test-Jdk17 $c) { return $c } }
  return $null
}

function Ensure-Jdk17 {
  $jdk = Find-Jdk17
  if (-not $jdk) {
    Log 'JDK 17 belum ada. Memasang Temurin 17 via winget (mungkin muncul jendela izin admin)...'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'winget tidak ada. Pasang JDK 17 manual (Temurin) dari https://adoptium.net lalu jalankan ulang.' }
    winget install -e --id EclipseAdoptium.Temurin.17.JDK --accept-source-agreements --accept-package-agreements --silent
    $jdk = Find-Jdk17
    if (-not $jdk) { throw 'JDK 17 terpasang tapi belum ditemukan. Tutup jendela ini, buka lagi, lalu jalankan ulang.' }
  }
  Set-UserEnv 'JAVA_HOME' $jdk
  $env:Path = "$jdk\bin;$env:Path"
  Log "JDK 17: $jdk"
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
  Log "Memasang paket SDK (platform, build-tools, NDK; pertama kali agak lama): $($SdkPackages -join ', ')"
  $pk = ($SdkPackages | ForEach-Object { "`"$_`"" }) -join ' '
  Run-Batch @("call `"$sdkm`" --sdk_root=`"$SdkRoot`" $pk") 'sdk-install.log'
  Set-UserEnv 'ANDROID_NDK_HOME' "$SdkRoot\ndk\$NdkVersion"
}

# Dipakai build: pastikan semuanya ada, kalau tidak beri pesan jelas.
function Use-AndroidEnv {
  $jdk = Find-Jdk17
  if (-not $jdk) { throw 'JDK 17 tidak ditemukan. Jalankan setup-android.bat dulu.' }
  $env:JAVA_HOME = $jdk; $env:Path = "$jdk\bin;$env:Path"
  if (-not (Test-Path "$SdkRoot\platforms\android-33") -or -not (Test-Path "$SdkRoot\cmdline-tools\latest\bin\sdkmanager.bat")) { throw 'Android SDK belum lengkap. Jalankan setup-android.bat dulu.' }
  $env:ANDROID_HOME = $SdkRoot; $env:ANDROID_SDK_ROOT = $SdkRoot
  $env:ANDROID_NDK_HOME = "$SdkRoot\ndk\$NdkVersion"
  if (-not (Test-Path $env:ANDROID_NDK_HOME)) { throw "NDK $NdkVersion tidak ditemukan. Jalankan setup-android.bat dulu." }
  $env:Path = "$SdkRoot\platform-tools;$env:Path"
}

# Cordova 12 belum cocok dengan Node 22+. Untuk build Android dipakai Node 20 portabel (tidak mengubah Node bawaan sistem).
function Use-Node20 {
  $dir = "$Root\build-android\node20"
  $exe = Get-ChildItem $dir -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $exe) {
    Log 'Mengunduh Node.js 20 portabel khusus build Android (sekitar 30 MB)...'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $zip = Join-Path $env:TEMP 'archne-node20.zip'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.18.1/node-v20.18.1-win-x64.zip' -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $dir -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    $exe = Get-ChildItem $dir -Recurse -Filter node.exe | Select-Object -First 1
    if (-not $exe) { throw 'Node 20 portabel gagal diekstrak.' }
  }
  $env:Path = "$($exe.DirectoryName);$env:Path"
  Log ('Build Android memakai node ' + (& node -v))
}

# Cordova butuh perintah `gradle` (di PATH atau Android Studio) hanya untuk membuat gradlew sekali. Tanpa Android Studio,
# dipakai Gradle 7.6 portabel (versi yang diminta cordova-android 12.0.1); wrapper kemudian mengunduh distribusi resminya sendiri.
function Use-Gradle {
  $dir = "$Root\build-android\gradle"
  $bat = Get-ChildItem $dir -Recurse -Filter gradle.bat -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $bat) {
    Log 'Mengunduh Gradle 7.6 portabel untuk pembuatan wrapper (sekitar 120 MB)...'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $zip = Join-Path $env:TEMP 'archne-gradle76.zip'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri 'https://services.gradle.org/distributions/gradle-7.6-bin.zip' -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $dir -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    $bat = Get-ChildItem $dir -Recurse -Filter gradle.bat | Select-Object -First 1
    if (-not $bat) { throw 'Gradle portabel gagal diekstrak.' }
  }
  $env:Path = "$($bat.DirectoryName);$env:Path"
  Log "Gradle portabel: $($bat.DirectoryName)"
}

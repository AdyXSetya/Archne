# Fungsi bersama. Dipanggil lewat dot-source dari script lain. Hanya karakter ASCII.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
New-Item -ItemType Directory -Force -Path "$Root\logs" | Out-Null

function Log($m) {
  $l = "$(Get-Date -Format s) $m"
  Write-Host $l
  Add-Content -Path "$Root\logs\scripts.log" -Value $l
}

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Ensure-Node {
  Refresh-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Log 'Node.js belum terpasang. Memasang via winget...'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      throw 'winget tidak ditemukan. Pasang Node.js LTS manual dari https://nodejs.org lalu jalankan ulang.'
    }
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    Refresh-Path
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
      throw 'Node.js terpasang tapi belum terbaca. Tutup jendela ini, buka lagi, lalu jalankan ulang.'
    }
  }
  Log ("node " + (& node -v) + " | npm " + (& npm.cmd -v))
}

function Run-Logged($cmd, $logName) {
  Log "> $cmd"
  cmd /c "$cmd > `"$Root\logs\$logName`" 2>&1"
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    Log "GAGAL (exit $code). 30 baris terakhir dari logs\$logName :"
    Get-Content "$Root\logs\$logName" -Tail 30 | ForEach-Object { Write-Host $_ }
    throw "Perintah gagal: $cmd"
  }
}

function Ensure-Deps {
  # resedit dipakai scripts\after-pack.js untuk menanam ikon ke .exe; folder node_modules lama (sebelum ikon) belum punya.
  if (-not (Test-Path "$Root\node_modules\electron\dist") -or -not (Test-Path "$Root\node_modules\resedit")) {
    Log 'Memasang dependensi (npm install, pertama kali agak lama)...'
    Run-Logged 'npm.cmd install --no-audit --no-fund' 'npm-install.log'
  } else { Log 'Dependensi sudah ada.' }
}

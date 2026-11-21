param([switch]$Release)
. "$PSScriptRoot\_common.ps1"
try {
  Log '=== 1/2: Windows (exe) ==='
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\build.ps1"
  if ($LASTEXITCODE -ne 0) { throw 'Build Windows gagal (lihat logs\build.log).' }
  Log '=== 2/2: Android (apk) ==='
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$PSScriptRoot\mobile.ps1")
  if ($Release) { $a += '-Release' }
  & powershell @a
  if ($LASTEXITCODE -ne 0) { throw 'Build Android gagal (lihat pesan galat di atas dan berkas logs\mobile-*.log).' }
  Log 'Semua selesai. Hasil ada di folder dist\'
} catch { Log "ERROR: $($_.Exception.Message)"; exit 1 }

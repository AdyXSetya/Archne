# Setup + build otomatis (Windows). Hanya karakter ASCII.
#   auto.bat                      -> setup + build installer Windows + APK debug
#   auto.bat desktop              -> hanya installer Windows (portable + NSIS)
#   auto.bat android              -> hanya APK
#   auto.bat all -Release         -> APK rilis bertanda tangan
#   auto.bat android -Install     -> pasang APK ke HP via adb setelah build
param(
  [ValidateSet('all', 'desktop', 'android')][string]$Target = 'all',
  [switch]$Release, [switch]$Install
)
. "$PSScriptRoot\_common.ps1"
. "$PSScriptRoot\_android.ps1"
$failed = @()
try {
  Log "=== Archne auto setup + build (target: $Target) ==="
  Ensure-Node
  $nodeMajor = [int]((& node -v).TrimStart('v').Split('.')[0])
  if ($nodeMajor -lt 22) { Log "PERINGATAN: package.json meminta Node >= 22 (terpasang: $nodeMajor). Build tetap dicoba." }
  Ensure-Deps

  if ($Target -eq 'all' -or $Target -eq 'desktop') {
    Log '=== Desktop: installer Windows ==='
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\build.ps1"
    if ($LASTEXITCODE -ne 0) { $failed += 'desktop (logs\build.log)' }
  }

  if ($Target -eq 'all' -or $Target -eq 'android') {
    Log '=== Android: APK (Capacitor) ==='
    try {
      $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$PSScriptRoot\mobile.ps1")
      if ($Release) { $a += '-Release' }
      if ($Install) { $a += '-Install' }
      & powershell @a
      if ($LASTEXITCODE -ne 0) { $failed += 'android (logs\mobile-*.log)' }
    } catch { Log "ERROR Android: $($_.Exception.Message)"; $failed += 'android' }
  }

  if (Test-Path "$Root\dist") {
    Log 'Hasil di folder dist\ :'
    Get-ChildItem "$Root\dist" -File | Where-Object { $_.Extension -in '.exe', '.apk' } | ForEach-Object { Log ("  " + $_.Name + "  (" + [math]::Round($_.Length / 1MB, 1) + " MB)") }
  }
  if ($failed.Count -gt 0) { throw ('Gagal: ' + ($failed -join ', ')) }
  Log 'SEMUA SELESAI.'
} catch { Log "ERROR: $($_.Exception.Message)"; exit 1 }

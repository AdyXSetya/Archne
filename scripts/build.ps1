. "$PSScriptRoot\_common.ps1"
try {
  Ensure-Node
  Ensure-Deps
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  Log 'Membangun installer Windows (pertama kali mengunduh komponen, harap tunggu)...'
  Run-Logged 'npm.cmd run dist' 'build.log'
  Log 'Selesai. Hasil ada di folder dist\ :'
  Get-ChildItem "$Root\dist" -Filter *.exe | ForEach-Object { Log ("  " + $_.Name + "  (" + [math]::Round($_.Length/1MB,1) + " MB)") }
  Start-Process explorer.exe "$Root\dist"
} catch { Log "ERROR: $($_.Exception.Message)"; exit 1 }

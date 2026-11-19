. "$PSScriptRoot\_common.ps1"
try {
  Ensure-Node
  Ensure-Deps
  Log 'Menjalankan Archne...'
  & npm.cmd start
} catch { Log "ERROR: $($_.Exception.Message)"; exit 1 }

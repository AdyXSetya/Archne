. "$PSScriptRoot\_common.ps1"
try {
  Ensure-Node
  Ensure-Deps
  Log 'Setup selesai. Jalankan run.bat untuk membuka aplikasi.'
} catch { Log "ERROR: $($_.Exception.Message)"; exit 1 }

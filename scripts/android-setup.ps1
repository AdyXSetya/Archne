. "$PSScriptRoot\_common.ps1"
. "$PSScriptRoot\_android.ps1"
try {
  Ensure-Node
  Ensure-Jdk17
  Ensure-AndroidSdk
  Log 'Setup Android selesai. Jalankan build-android.bat untuk membuat APK.'
} catch { Log "ERROR: $($_.Exception.Message)"; exit 1 }

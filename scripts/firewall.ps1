# Opsional: buka firewall untuk Archne. Otomatis minta hak admin.
$id = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $id.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit
}
$Root = Split-Path -Parent $PSScriptRoot
Get-NetFirewallRule -DisplayName 'Archne*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Archne UDP discovery' -Direction Inbound -Protocol UDP -LocalPort 41234 -Action Allow -Profile Any | Out-Null
$progs = @("$Root\node_modules\electron\dist\electron.exe", "$env:LOCALAPPDATA\Programs\Archne\Archne.exe")
foreach ($p in $progs) {
  New-NetFirewallRule -DisplayName "Archne app ($([IO.Path]::GetFileName($p)))" -Direction Inbound -Program $p -Action Allow -Profile Any | Out-Null
}
Write-Host 'Aturan firewall Archne dibuat.'
Read-Host 'Tekan Enter untuk menutup'

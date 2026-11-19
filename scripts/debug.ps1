. "$PSScriptRoot\_common.ps1"
$report = "$Root\debug-report.txt"
try {
  Ensure-Node
  Ensure-Deps
} catch { Log "ERROR setup: $($_.Exception.Message)" }

$out = New-Object System.Collections.Generic.List[string]
$out.Add("=== Archne debug report $(Get-Date -Format s) ===")
$out.Add("OS: " + (Get-CimInstance Win32_OperatingSystem).Caption + " " + [Environment]::OSVersion.Version)
$out.Add("PowerShell: " + $PSVersionTable.PSVersion)
try { $out.Add("node: " + (& node -v) + "  npm: " + (& npm.cmd -v)) } catch { $out.Add("node: TIDAK ADA") }

$out.Add("`n--- Adapter jaringan (IPv4) ---")
try { Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.*' } | ForEach-Object { $out.Add("$($_.InterfaceAlias): $($_.IPAddress)/$($_.PrefixLength)") } } catch { $out.Add("gagal baca adapter") }

$out.Add("`n--- Profil jaringan (Public membuat discovery diblokir firewall) ---")
try { Get-NetConnectionProfile | ForEach-Object { $out.Add("$($_.Name): $($_.NetworkCategory)") } } catch {}

$out.Add("`n--- Aturan firewall Archne ---")
try { $r = Get-NetFirewallRule -DisplayName 'Archne*' -ErrorAction SilentlyContinue; if ($r) { $r | ForEach-Object { $out.Add("$($_.DisplayName) enabled=$($_.Enabled) action=$($_.Action)") } } else { $out.Add("(belum ada, jalankan firewall.bat sebagai admin atau klik Allow saat popup)") } } catch {}

$out.Add("`n--- Tes logika inti (npm test) ---")
cmd /c "node test\test.js > `"$Root\logs\test.log`" 2>&1"
$out.Add("exit code: $LASTEXITCODE")
$out.AddRange([string[]](Get-Content "$Root\logs\test.log"))

$out.Add("`n--- Tes UDP broadcast di mesin ini ---")
cmd /c "node test\udp.js > `"$Root\logs\udp.log`" 2>&1"
$out.AddRange([string[]](Get-Content "$Root\logs\udp.log"))

$appLog = Join-Path $env:APPDATA 'archne\logs\app.log'
$out.Add("`n--- app.log (80 baris terakhir): $appLog ---")
if (Test-Path $appLog) { $out.AddRange([string[]](Get-Content $appLog -Tail 80)) } else { $out.Add("(belum ada, aplikasi belum pernah dijalankan)") }

$out.Add("`n--- npm-install.log / build.log (30 baris terakhir) ---")
foreach ($f in 'npm-install.log','build.log') { if (Test-Path "$Root\logs\$f") { $out.Add("[$f]"); $out.AddRange([string[]](Get-Content "$Root\logs\$f" -Tail 30)) } }

$out | Set-Content -Path $report -Encoding UTF8
try { ($out -join "`r`n") | Set-Clipboard; Log 'Laporan disalin ke clipboard.' } catch {}
Log "Laporan tersimpan: $report  (tempel isinya ke chat kalau ada masalah)"

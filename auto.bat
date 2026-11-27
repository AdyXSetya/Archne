@echo off
rem Setup + build otomatis. Contoh: auto.bat | auto.bat desktop | auto.bat android -Release
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\auto.ps1" %*
if errorlevel 1 (echo. & echo Ada yang gagal. Lihat folder logs\ & pause & exit /b 1)
pause

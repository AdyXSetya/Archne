@echo off
rem Fase 2B: bangun APK debug dari mobile/. Contoh: mobile.bat | mobile.bat -Install
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\mobile.ps1" %*
pause

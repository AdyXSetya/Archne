@echo off
rem Build the Android APK from mobile/. Examples: mobile.bat | mobile.bat -Install | mobile.bat -Release
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\mobile.ps1" %*
pause

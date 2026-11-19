@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\android-build.ps1" -Release
if errorlevel 1 pause

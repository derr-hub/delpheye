@echo off
chcp 65001 >nul
title DelphEye
rem Runs DelphEye in development mode. Keep this window open while the app is running.
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0"
call npm.cmd run tauri dev
if errorlevel 1 (
  echo.
  echo DelphEye stopped with an error. The messages above say why.
  pause
)

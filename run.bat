@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 18 or newer is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
)

if not defined PORT set "PORT=3081"
if not defined HOST set "HOST=127.0.0.1"
echo Starting uwu-x-proxy at http://%HOST%:%PORT%
echo Press Ctrl+C to stop.
node src\index.js
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" pause
exit /b %EXITCODE%

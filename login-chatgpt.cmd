@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
node scripts\launch.js login
if errorlevel 1 (
  pause
  exit /b 1
)
echo Login finished. Use Check login status in the participant settings.
pause

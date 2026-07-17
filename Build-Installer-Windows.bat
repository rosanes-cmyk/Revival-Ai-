@echo off
title Build Twin Text Platform Installer
cd /d "%~dp0"

echo ============================================================
echo    Building the Twin Text Platform installer (.exe)
echo    This makes ONE file you can send to colleagues so they
echo    can install the app on any Windows PC (no Node, no setup).
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is not installed. Install the LTS version from
  echo     https://nodejs.org , then run this file again.
  echo.
  pause
  exit /b 1
)

REM Bundle the automation browser INTO the app so it works on a fresh PC.
set PLAYWRIGHT_BROWSERS_PATH=0

echo Step 1/3: Installing components (a few minutes the first time)...
call npm install
if errorlevel 1 goto :fail

echo.
echo Step 2/3: Bundling the automation browser (Chromium)...
call npx playwright install chromium
if errorlevel 1 goto :fail

echo.
echo Step 3/3: Building the installer (several minutes - please wait)...
call npm run dist
if errorlevel 1 goto :fail

echo.
echo ============================================================
echo    DONE! Your installer is in the "dist" folder:
echo.
dir /b dist\*.exe
echo.
echo    Send that .exe file to your colleagues. They double-click
echo    it to install "Twin Text Platform" and get a desktop icon.
echo ============================================================
echo.
pause
exit /b 0

:fail
echo.
echo [!] Something went wrong during the build. Copy the red text
echo     above and send it over so it can be fixed.
echo.
pause
exit /b 1

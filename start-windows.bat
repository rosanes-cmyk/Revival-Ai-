@echo off
title High Equity Lead Revival Dashboard
cd /d "%~dp0"

echo ============================================================
echo    High Equity Lead Revival Dashboard - Startup
echo ============================================================
echo.

REM --- Check that Node.js is installed ---
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is not installed on this computer.
  echo.
  echo     1. Go to https://nodejs.org
  echo     2. Download the "LTS" version and run the installer.
  echo     3. Click Next / Next / Install until it finishes.
  echo     4. Then double-click this start-windows.bat file again.
  echo.
  pause
  exit /b 1
)

REM --- First-time setup: install dependencies + automation browser ---
if not exist "node_modules" (
  echo First-time setup. Installing components, please wait a few minutes...
  echo.
  call npm install
  echo.
  echo Installing the automation browser - Chromium. Please wait...
  call npx playwright install chromium
  echo.
)

REM --- Create the settings file from the template if missing ---
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo A settings file named ".env" was created for you.
  echo Before running LIVE, open it in Notepad and enter your REI BlackBook
  echo email and password. See START-HERE-WINDOWS.md for details.
  echo.
)

echo Opening the dashboard in your web browser...
start "" http://localhost:3000

echo.
echo The dashboard is now running. KEEP THIS BLACK WINDOW OPEN while you use it.
echo To stop the dashboard, close this window.
echo.
call npm start
pause

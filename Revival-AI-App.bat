@echo off
title Revival AI
cd /d "%~dp0"

REM ============================================================
REM  Revival AI - desktop app launcher
REM  Double-click this file to open the dashboard in its own
REM  window (no browser, no localhost to type).
REM ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is not installed on this computer.
  echo     1. Go to https://nodejs.org
  echo     2. Download the "LTS" version and install it.
  echo     3. Then double-click this file again.
  echo.
  pause
  exit /b 1
)

REM First-time setup: install components (incl. the app framework) + browser.
if not exist "node_modules\electron" (
  echo First-time setup. Installing components, please wait a few minutes...
  echo.
  call npm install
  echo.
  echo Installing the automation browser - Chromium. Please wait...
  call npx playwright install chromium
  echo.
)

REM Create the settings file from the template if missing.
if not exist ".env" copy ".env.example" ".env" >nul

echo Opening Revival AI...
call npm run app

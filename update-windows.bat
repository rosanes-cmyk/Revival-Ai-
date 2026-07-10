@echo off
title Update Lead Revival Dashboard
cd /d "%~dp0"

echo ============================================================
echo    Updating the Lead Revival Dashboard to the latest
echo ============================================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [!] Git is not installed. Install it once from:
  echo     https://git-scm.com/download/win
  echo Then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo Pulling the latest version...
git pull
echo.
echo Installing any new components...
call npm install
echo.
echo ============================================================
echo    Done. Your login and settings are kept.
echo    Now double-click start-windows.bat (or run: npm start)
echo ============================================================
echo.
pause

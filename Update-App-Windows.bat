@echo off
title Update Revival AI App
cd /d "%~dp0"

echo ============================================================
echo    Update Revival AI App
echo    This gets the latest version AND rebuilds the app (.exe).
echo    When it finishes, install the new file from the "dist" folder.
echo ============================================================
echo.

REM --- Make sure the app is CLOSED first (so files aren't locked) ---
echo Before continuing, please CLOSE the Revival AI app if it is open.
echo (Also close any black "npm start" window.)
echo.
pause

REM --- Check Git ---
where git >nul 2>nul
if errorlevel 1 (
  echo [!] Git is not installed. Install it once from:
  echo     https://git-scm.com/download/win
  echo Then run this file again.
  echo.
  pause
  exit /b 1
)

REM --- Check Node ---
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is not installed. Install the LTS version from
  echo     https://nodejs.org , then run this file again.
  echo.
  pause
  exit /b 1
)

echo Step 1/4: Getting the latest version...
call git pull
if errorlevel 1 goto :fail

REM Bundle the automation browser INTO the app so it works on any PC.
set PLAYWRIGHT_BROWSERS_PATH=0

echo.
echo Step 2/4: Installing components...
call npm install
if errorlevel 1 goto :fail

echo.
echo Step 3/4: Bundling the automation browser (Chromium)...
call npx playwright install chromium
if errorlevel 1 goto :fail

echo.
echo Step 4/4: Rebuilding the app (several minutes - please wait)...
call npm run dist
if errorlevel 1 goto :fail

echo.
echo ============================================================
echo    DONE! The updated installer is in the "dist" folder:
echo.
dir /b dist\*.exe
echo.
echo    NOW: open the "dist" folder and double-click that .exe to
echo    install the updated app (it replaces the old one). Your REI
echo    login and data are kept.
echo ============================================================
echo.
pause
exit /b 0

:fail
echo.
echo [!] Something went wrong. Two common fixes:
echo     - Make sure the Revival AI app is fully CLOSED, then run again.
echo     - If it mentions "symbolic link" or "winCodeSign", turn on
echo       Windows Developer Mode (Settings ^> Privacy ^& security ^>
echo       For developers ^> Developer Mode = On), then run again.
echo.
echo     Copy the red text above and send it over if it keeps failing.
echo.
pause
exit /b 1

@echo off
REM ==========================================================
REM  CS:GO MAPS - local run
REM  Needs PHP 8.1+ (https://windows.php.net/downloads/releases/)
REM ==========================================================
setlocal

cd /d "%~dp0"

where php >nul 2>nul
if errorlevel 1 (
  echo.
  echo   PHP not found in PATH.
  echo   Download PHP from https://windows.php.net/downloads/releases/
  echo   Unzip it and either add its folder to PATH, or edit this script:
  echo.
  echo   set "PHP=C:\php\php.exe"
  echo.
  pause
  exit /b 1
)

echo.
echo   CS:GO MAPS: http://localhost:8000
echo   Drop .bsp files here, next to index.php.
echo   Stop: Ctrl+C
echo.

start "" "http://localhost:8000"
php -S localhost:8000 -t "%~dp0"

endlocal
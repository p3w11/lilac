@echo off
REM Быстрый запуск Lilac на компьютере
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Скачай LTS: https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Устанавливаю зависимости...
  call npm install
)

echo.
echo   Lilac: http://localhost:3000
echo   Остановить: Ctrl+C
echo.
call npm start

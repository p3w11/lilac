@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PORT=8787"
set "URL=http://localhost:%PORT%/"

where python >nul 2>nul
if %errorlevel%==0 (
  echo Запускаю Волну на %URL%
  echo Чтобы остановить сервер, закройте это окно.
  set "VOLNA_PORT=%PORT%"
  start "" "%URL%"
  python server.py
  goto :end
)

where py >nul 2>nul
if %errorlevel%==0 (
  echo Запускаю Волну на %URL%
  echo Чтобы остановить сервер, закройте это окно.
  set "VOLNA_PORT=%PORT%"
  start "" "%URL%"
  py server.py
  goto :end
)

echo Python не найден — открываю файл напрямую.
echo В этом режиме фонотека может не сохраняться между запусками.
start "" "index.html"

:end
endlocal

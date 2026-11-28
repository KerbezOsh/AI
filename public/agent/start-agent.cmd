@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js не найден. Поставь LTS с https://nodejs.org и запусти этот файл снова.
  echo.
  pause
  exit /b 1
)
echo.
echo Запускаю мост photonnAI. Окно не закрывай, пока работаешь с агентом.
echo.
node "%~dp0photonn-agent.js" --root "%~dp0photonn-workspace" %*
echo.
pause

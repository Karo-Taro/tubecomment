@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Нужен Node.js 18 или новее: https://nodejs.org & pause & exit /b 1)
rem Прокси: start-bridge.bat --proxy socks5://user:pass@host:1080
node tubecomment-bridge.mjs %*
pause

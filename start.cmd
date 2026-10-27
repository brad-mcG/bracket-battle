@echo off
rem Double-click to run Bracket Battle locally. Close this window to stop it.
title Bracket Battle - close this window to stop
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist public\bundle.js call npm run build
rem open the browser once the server has had a moment to start
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3002"
node server.js
pause

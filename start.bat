@echo off
chcp 65001 >nul 2>&1
title Character Forge
cd /d "%~dp0."
set NODE_TLS_REJECT_UNAUTHORIZED=0

echo ========================================
echo    Character Forge - Starting...
echo ========================================
echo.
echo Starting server, please wait...
echo Browser will open automatically
echo Close this window to quit
echo.

:: Kill any stale server process on port 3115
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3115" ^| findstr "LISTENING" 2^>nul') do (
    echo Killing stale process on port 3115 [PID: %%a]...
    taskkill /pid %%a /f >nul 2>&1
)

start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3115"

node\node.exe server.js

echo.
echo ========================================
echo    Server stopped.
echo    Port 3115 may already be in use.
echo ========================================
pause

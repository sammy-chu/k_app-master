@echo off
title Market Monitor Server
echo =======================================
echo Starting Market Monitor Server...
echo =======================================

REM Kill process on port 3000 to avoid EADDRINUSE error
FOR /F "tokens=5" %%a IN ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') DO (
    echo Port 3000 is already in use. Killing PID: %%a...
    taskkill /F /PID %%a >nul 2>&1
)

cd /d "%~dp0"
npm run dev

pause
@echo off
title Restart Cowork IDE Server
cd /d "%~dp0"

echo ======================================================
echo   Restarting Cowork IDE Server on Port 3300
echo ======================================================

echo Stopping previous server on port 3300...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3300 ^| findstr LISTENING') do (
    echo Terminating PID: %%a
    taskkill /F /PID %%a >nul 2>&1
)

ping 127.0.0.1 -n 2 >nul

echo Starting updated server with dynamic project support...
start "" node serve_chat.js

ping 127.0.0.1 -n 3 >nul

echo Server restarted! Opening http://localhost:3300...
start http://localhost:3300

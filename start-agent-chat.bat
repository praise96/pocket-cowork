@echo off
title Cowork IDE - Desktop App
cd /d "%~dp0"

:: Check if restart requested
if "%1"=="--restart" goto :dorestart
if "%1"=="-r" goto :dorestart

:: Check if local backend is already listening on port 3300
netstat -ano | findstr :3300 | findstr LISTENING >nul
if %errorlevel% equ 0 goto :launch

:dorestart
echo Stopping previous server on port 3300...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3300 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
ping 127.0.0.1 -n 2 >nul

:startserver
echo Starting Cowork IDE server on port 3300...
start "" node serve_chat.js
ping 127.0.0.1 -n 3 >nul

:launch
:: Launch borderless standalone Windows App window
if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app="http://localhost:3300" --window-size=1440,900
) else if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app="http://localhost:3300" --window-size=1440,900
) else (
    start http://localhost:3300
)

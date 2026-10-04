@echo off
cd /d "%~dp0"
where ffmpeg >nul 2>nul
if errorlevel 1 (
    echo FFmpeg was not found in PATH.
    echo Please install FFmpeg first, for example: choco install ffmpeg
    pause
    exit /b 1
)

if not exist node_modules\music-metadata (
    echo Installing required package...
    call npm install
    if errorlevel 1 (
        echo Failed to install dependencies.
        pause
        exit /b 1
    )
)
node server.js
pause

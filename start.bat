@echo off
REM Check if .env exists in the same directory
if not exist "%~dp0.env" (
    echo Error: .env file not found!
    echo Please create a .env file with your configuration
    pause
    exit /b 1
)

REM Run the executable
"%~dp0bilibili-dynamic-subscribe-win.exe"
pause
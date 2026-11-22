@echo off
rem Pitch Trainer without Docker: kengine (the song converter) in its own window, then the app
rem on http://localhost:8080 in this one. Close both windows to stop.
cd /d "%~dp0"

netstat -ano | findstr /r /c:":8080 .*LISTENING" >nul
if not errorlevel 1 (
  echo Port 8080 is already in use - probably the Docker app. Quit Docker Desktop, or just open
  echo http://localhost:8080 if the app is already running.
  pause
  exit /b 1
)

netstat -ano | findstr /r /c:":8002 .*LISTENING" >nul
if errorlevel 1 (
  start "kengine" cmd /c "engine\start-kengine.cmd"
) else (
  echo kengine is already running.
)

if not exist node_modules (
  echo Installing the app's packages, first run only...
  call npm install || (pause & exit /b 1)
)

call npm run dev -- --open
pause

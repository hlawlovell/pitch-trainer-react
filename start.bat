@echo off
REM Starts the backup converter in Docker (needs Docker Desktop running), then the app (start-app.cmd).
REM Without Docker, just double-click start-app.cmd: everything works except the backup converter.
cd /d "%~dp0"
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker is not installed - starting the app without the backup converter.
) else (
  echo Starting the backup converter in Docker...
  docker compose up -d --build
  if errorlevel 1 echo Couldn't start it - is Docker Desktop running? Starting the app anyway.
)
call start-app.cmd

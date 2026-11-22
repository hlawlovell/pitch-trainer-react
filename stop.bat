@echo off
REM Stops the backup converter in Docker. Close the app and kengine windows to stop those.
cd /d "%~dp0"
docker compose down
echo Backup converter stopped.
timeout /t 3 >nul

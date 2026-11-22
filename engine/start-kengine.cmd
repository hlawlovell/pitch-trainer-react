@echo off
rem kengine song converter for the app (GPU). Leave this window open while converting songs.
cd /d "%~dp0"
.venv\Scripts\python.exe -X utf8 -m kengine.service
pause

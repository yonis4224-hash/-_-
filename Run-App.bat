@echo off
cd /d "%~dp0"
echo Launching Krita Studio / Ibis Paint Desktop...

if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app="%~dp0index.html"
) else if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files\Microsoft\Edge\Application\msedge.exe" --app="%~dp0index.html"
) else (
    start "" "%~dp0index.html"
)
exit

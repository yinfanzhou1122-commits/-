@echo off
chcp 65001 >nul
echo [1/1] Building Fast Update Patch...
"C:\InnoSetup\ISCC.exe" "%~dp0update.iss"
pause

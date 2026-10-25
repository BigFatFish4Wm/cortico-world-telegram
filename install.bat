@echo off
chcp 65001 >nul
echo Installing cortico-world-telegram into Coopanion...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Install failed. See the message above.
) else (
  echo.
  echo Done.
)
pause
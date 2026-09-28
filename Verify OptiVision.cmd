@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\verify-optivision.ps1"
if errorlevel 1 (
  echo.
  echo OptiVision verification failed. Review the message above.
  pause
  exit /b 1
)
echo.
echo OptiVision verification completed successfully.
pause

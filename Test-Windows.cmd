@echo off
cd /d "%~dp0"
node ops\test-local.js
if errorlevel 1 (
  echo Local tests failed. Run Install-Windows.cmd if dependencies are missing.
) else (
  echo Local tests passed.
)
pause


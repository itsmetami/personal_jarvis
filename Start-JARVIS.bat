@echo off
setlocal
title J.A.R.V.I.S. Local Launcher
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-jarvis.ps1"
set "jarvisExitCode=%ERRORLEVEL%"
if not "%jarvisExitCode%"=="0" (
  echo.
  echo JARVIS stopped with an error. The message above explains why.
  pause
)
endlocal & exit /b %jarvisExitCode%

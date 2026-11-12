@echo off
title Hermes Free AI Manager
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found on PATH.
  echo Install Node.js from https://nodejs.org and try again.
  pause
  exit /b 1
)
node hermes-manager.mjs
pause

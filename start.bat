@echo off
cd /d "%~dp0"
echo.
echo  ================================
echo   SOURCE - AI Sourcing Platform
echo   http://localhost:3030
echo  ================================
echo.
start "" "http://localhost:3030"
npm run dev

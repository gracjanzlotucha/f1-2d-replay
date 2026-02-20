@echo off
title F1 2D Replay — Silverstone 2025
color 0C

echo.
echo  ==========================================
echo   F1 2D Replay System — Silverstone 2025
echo  ==========================================
echo.
echo  Starting server on http://localhost:5000
echo  Data will load in ~2-4 minutes (first run)
echo  Subsequent runs use local cache — very fast
echo.
echo  Press CTRL+C to stop the server
echo.

cd /d "%~dp0"
python server.py

pause

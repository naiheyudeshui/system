@echo off
chcp 65001 >nul
cd /d "%~dp0tools"
set PYTHONUTF8=1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8033.*LISTENING"') do taskkill /F /PID %%p >nul 2>&1
python serve_workbench.py --host 0.0.0.0 --port 8033 --trusted-lan-write
pause

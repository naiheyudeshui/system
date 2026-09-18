@echo off
chcp 65001 >nul
cd /d "%~dp0tools"
set PYTHONUTF8=1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8033.*LISTENING"') do taskkill /F /PID %%p >nul 2>&1
echo 正在打开学习库 3dworkbench http://127.0.0.1:8033
python serve_workbench.py --port 8033
pause

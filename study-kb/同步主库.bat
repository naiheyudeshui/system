@echo off
chcp 65001 >nul
cd /d "%~dp0.."
python .cursor\skills\study\scripts\study_server.py sync-mirror
if errorlevel 1 (
  echo 同步失败。请确认手机服务已开启且与本机在同一局域网。
  pause
  exit /b 1
)
echo.
echo 已更新 study-kb\data\study.sqlite
echo 如需提交 Git，请自行 git add / commit。
pause

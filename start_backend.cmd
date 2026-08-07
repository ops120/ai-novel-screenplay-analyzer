@echo off
echo ========================================
echo   启动小说剧本智能分析工作台后端服务
echo   Python 3.10+
echo ========================================
echo.

set "STORYMAP_DB=%~dp0storymap.db"
echo SQLite 数据库: %STORYMAP_DB%

rem --- 可选：激活 conda 环境 vevo（不存在则直接使用系统 python） ---
where conda >nul 2>nul
if not errorlevel 1 (
    call conda activate vevo >nul 2>nul
)

echo.
echo 正在启动后端服务...
echo 服务地址: http://127.0.0.1:28000
echo API 文档: http://127.0.0.1:28000/docs
echo.
echo 按 Ctrl+C 停止服务
echo.

python backend/main.py

pause

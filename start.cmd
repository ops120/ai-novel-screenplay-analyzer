@echo off
echo ========================================
echo   小说剧本智能分析工作台 - 启动脚本
echo   Python 3.10+ / Node.js 20.19+
echo ========================================
echo.

set "STORYMAP_DB=%~dp0storymap.db"
echo   SQLite: %STORYMAP_DB%

rem --- 可选：激活 conda 环境 vevo（不存在则直接使用系统 python/npm） ---
where conda >nul 2>nul
if not errorlevel 1 (
    call conda activate vevo >nul 2>nul
)

echo.
echo [1/2] 启动后端服务 (127.0.0.1:28000)...
start "Novel Analyzer Backend" cmd /k "chcp 65001 >nul && python backend/main.py"
timeout /t 3 /nobreak >nul

echo [2/2] 启动前端服务 (localhost:15173)...
cd frontend
start "Novel Analyzer Frontend" cmd /k "chcp 65001 >nul && npm run dev"

echo.
echo ========================================
echo   服务启动完成：
echo   后端: http://127.0.0.1:28000
echo   前端: http://localhost:15173
echo ========================================
echo.
echo 提示: 如需停止服务，请关闭对应的命令行窗口
echo.
pause

@echo off
chcp 65001 >nul
echo ========================================
echo   小说剧本智能分析工作台 启动脚本
echo   Conda 环境: vevo
echo ========================================
echo.

set "STORYMAP_DB=%~dp0storymap.db"
echo   SQLite: %STORYMAP_DB%

echo [1/3] 激活 Conda 环境 vevo...
call conda activate vevo
if errorlevel 1 (
    echo 错误: 无法激活 conda 环境 vevo
    echo 请确保已安装 conda 并创建了 vevo 环境
    pause
    exit /b 1
)
echo 成功: Conda 环境已激活

echo.
echo [2/3] 启动后端服务...
start "Novel Analyzer Backend" cmd /k "chcp 65001 >nul && conda activate vevo && python backend/main.py"
timeout /t 3 /nobreak >nul

echo [3/3] 启动前端服务...
cd frontend
start "Novel Analyzer Frontend" cmd /k "chcp 65001 >nul && npm run dev"

echo.
echo ========================================
echo   服务启动完成！
echo   后端: http://127.0.0.1:28000
echo   前端: http://localhost:15173
echo ========================================
echo.
echo 提示: 如需停止服务，请关闭对应的命令行窗口
echo.
pause

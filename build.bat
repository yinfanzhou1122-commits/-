@echo off
REM 角色筛选机 - Windows 打包脚本

echo 🔧 开始打包角色筛选机...
echo.

REM 检查 Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ 未找到 Node.js，请先安装 Node.js
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo ✅ Node.js 版本: %NODE_VERSION%
echo.

REM 安装依赖
echo 📦 安装依赖...
set ELECTRON_RUN_AS_NODE=
set ELECTRON_MIRROR=https://github.com/electron/electron/releases/download/
set ELECTRON_CUSTOM_DIR=v34.5.8
call npm install

if %ERRORLEVEL% NEQ 0 (
    echo ❌ 依赖安装失败
    pause
    exit /b 1
)

echo ✅ 依赖安装完成
echo.

REM 构建 exe
echo 🏗️  构建 Windows exe...
call npm run build -- --win --x64 --publish=never

if %ERRORLEVEL% NEQ 0 (
    echo ❌ 构建失败
    pause
    exit /b 1
)

echo.
echo ✅ 打包完成！
echo 📁 输出文件位置: dist\
echo.
dir dist\*.exe 2>nul || echo 未找到 exe 文件
pause

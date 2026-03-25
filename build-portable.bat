@echo off
chcp 65001 >nul 2>&1
title 打包角色锻造炉

set SRC=%~dp0
set DIST=%SRC%dist\角色筛选机

echo ========================================
echo    打包角色锻造炉（便携版）
echo ========================================
echo.

REM 清理旧输出
if exist "%DIST%" (
    echo 清理旧打包...
    rmdir /s /q "%DIST%"
)
mkdir "%DIST%"

echo [1/7] 复制 Node.js 运行时...
xcopy "%SRC%node" "%DIST%\node\" /E /I /Q /Y

echo [2/7] 复制服务器文件...
copy "%SRC%server.js" "%DIST%\" /Y >nul
copy "%SRC%clip-service.js" "%DIST%\" /Y >nul
copy "%SRC%vector-db.js" "%DIST%\" /Y >nul
copy "%SRC%camera-params.js" "%DIST%\" /Y >nul
copy "%SRC%package.json" "%DIST%\" /Y >nul
copy "%SRC%.env" "%DIST%\" /Y >nul
copy "%SRC%start.bat" "%DIST%\" /Y >nul

echo [3/7] 复制前端文件...
xcopy "%SRC%public" "%DIST%\public\" /E /I /Q /Y

echo [4/7] 复制图片素材库...
xcopy "%SRC%image" "%DIST%\image\" /E /I /Q /Y

echo [5/7] 复制 CLIP 模型缓存...
xcopy "%SRC%.cache" "%DIST%\.cache\" /E /I /Q /Y

echo [6/7] 复制场景设定...
if exist "%SRC%stitch 场景设定" (
    xcopy "%SRC%stitch 场景设定" "%DIST%\stitch 场景设定\" /E /I /Q /Y
)

echo [7/7] 复制 node_modules...
xcopy "%SRC%node_modules" "%DIST%\node_modules\" /E /I /Q /Y

echo.
echo ========================================
echo    打包完成！
echo    输出目录: %DIST%
echo    双击 start.bat 启动程序
echo ========================================
pause

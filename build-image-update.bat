@echo off
chcp 65001 >nul
title 打包素材升级包

echo ========================================
echo    打包素材升级包
echo ========================================
echo.

:: 检查 image-update 目录是否存在
if not exist "%~dp0image-update" (
    echo ❌ 错误：未找到 image-update 目录！
    echo    请先创建 image-update 文件夹并将新素材放入。
    echo.
    pause
    exit /b 1
)

:: 检查 image-update 目录是否有内容
dir /s /b "%~dp0image-update\*.png" "%~dp0image-update\*.jpg" "%~dp0image-update\*.jpeg" "%~dp0image-update\*.webp" "%~dp0image-update\*.gif" >nul 2>&1
if errorlevel 1 (
    echo ⚠️  警告：image-update 目录中没有找到任何图片文件！
    echo    请先将新素材按照 image/ 的目录结构放入 image-update/ 中。
    echo.
    echo    目录结构示例：
    echo    image-update/
    echo      真人/
    echo        男性/
    echo          脸/  半身图/  发型/  服装/  三视图/
    echo        女性/
    echo          脸/  半身图/  发型/  服装/  三视图/
    echo        场景/
    echo      2D/
    echo      3D/
    echo.
    pause
    exit /b 1
)

:: 统计图片数量
set /a count=0
for /r "%~dp0image-update" %%f in (*.png *.jpg *.jpeg *.webp *.gif) do set /a count+=1
echo 📊 找到 %count% 张图片素材
echo.

echo [1/1] 正在打包素材升级包...
"C:\InnoSetup\ISCC.exe" "%~dp0image-update.iss"

if errorlevel 1 (
    echo.
    echo ❌ 打包失败！
    pause
    exit /b 1
)

echo.
echo ========================================
echo    ✅ 素材升级包打包完成！
echo    输出位置: dist\角色锻造炉_素材升级包_v1.0.exe
echo ========================================
pause

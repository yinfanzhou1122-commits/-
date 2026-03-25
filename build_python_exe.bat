@echo off
REM ============================================================
REM Chinese CLIP 搜图系统 - Windows 打包脚本 (生成 .exe)
REM 需要在 Windows 上运行
REM ============================================================

echo ======================================
echo  Chinese CLIP 搜图系统 Windows 打包
echo ======================================

REM 1. 检测 Python
python --version >nul 2>&1
IF ERRORLEVEL 1 (
    echo [错误] 未找到 Python，请先安装 Python 3.9+
    echo 下载地址: https://www.python.org/downloads/
    pause
    exit /b 1
)

FOR /F "tokens=*" %%i IN ('python --version') DO echo [OK] 使用 %%i

REM 2. 创建虚拟环境
IF NOT EXIST ".venv_build" (
    echo [...] 创建虚拟环境...
    python -m venv .venv_build
)

REM 激活虚拟环境
call .venv_build\Scripts\activate.bat
echo [OK] 已激活虚拟环境

REM 3. 升级 pip
python -m pip install --upgrade pip --quiet

REM 4. 安装依赖
echo [...] 安装 PyTorch (CPU版本，体积较小)...
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu --quiet

echo [...] 安装其他依赖...
pip install transformers flask werkzeug pillow numpy tqdm safetensors sentencepiece tokenizers --quiet
pip install huggingface-hub filelock packaging requests --quiet

REM 5. 安装 PyInstaller
echo [...] 安装 PyInstaller...
pip install pyinstaller --quiet

REM 6. 确保目录存在
if not exist gallery mkdir gallery
if not exist uploads mkdir uploads
if not exist clip_cache mkdir clip_cache

REM 7. 打包
echo [...] 开始打包，请耐心等待 (可能需要 10-20 分钟)...
pyinstaller build_exe.spec --clean --noconfirm

echo.
echo ======================================
echo  打包完成！
echo ======================================
echo 输出目录: dist\Chinese_CLIP_搜图\
echo 可执行文件: dist\Chinese_CLIP_搜图\Chinese_CLIP_搜图.exe
echo.
echo 运行后访问: http://localhost:5001
echo.
pause

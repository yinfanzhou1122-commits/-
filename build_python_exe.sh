#!/bin/bash
# ============================================================
# Chinese CLIP 搜图系统 - 打包为独立可执行文件
# 支持 macOS（生成 .app）和 Windows（生成 .exe，需在 Windows 上运行）
# ============================================================

set -e

echo "======================================"
echo " Chinese CLIP 搜图系统 打包脚本"
echo "======================================"

# 1. 检测 Python
PYTHON=""
for cmd in python3.11 python3.10 python3.9 python3 python; do
    if command -v "$cmd" &>/dev/null; then
        PYTHON="$cmd"
        break
    fi
done

if [ -z "$PYTHON" ]; then
    echo "[错误] 未找到 Python，请先安装 Python 3.9+"
    exit 1
fi

echo "[✓] 使用 Python: $($PYTHON --version)"
echo "[✓] Python 路径: $(which $PYTHON)"

# 2. 创建虚拟环境（避免污染全局环境）
VENV_DIR=".venv_build"
if [ ! -d "$VENV_DIR" ]; then
    echo "[...] 创建虚拟环境 $VENV_DIR"
    $PYTHON -m venv "$VENV_DIR"
fi

# 激活虚拟环境
source "$VENV_DIR/bin/activate"
echo "[✓] 已激活虚拟环境"

# 3. 升级 pip
pip install --upgrade pip --quiet

# 4. 安装依赖
echo "[...] 安装运行依赖（可能需要几分钟）..."
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu --quiet
pip install transformers flask werkzeug pillow numpy tqdm safetensors sentencepiece tokenizers --quiet
pip install huggingface-hub filelock packaging requests --quiet

# 5. 安装 PyInstaller
echo "[...] 安装 PyInstaller..."
pip install pyinstaller --quiet
echo "[✓] PyInstaller 已安装: $(pyinstaller --version)"

# 6. 确保 gallery / uploads / clip_cache 目录存在
mkdir -p gallery uploads clip_cache

# 7. 运行打包
echo "[...] 开始打包 test.py -> 独立可执行文件..."
echo "注意：首次打包可能需要 5-15 分钟"
echo ""

pyinstaller build_exe.spec --clean --noconfirm

echo ""
echo "======================================"
echo " 打包完成！"
echo "======================================"
echo "输出目录: dist/Chinese_CLIP_搜图/"
echo "可执行文件: dist/Chinese_CLIP_搜图/Chinese_CLIP_搜图"
echo ""
echo "运行方法: ./dist/Chinese_CLIP_搜图/Chinese_CLIP_搜图"
echo "然后访问: http://localhost:5001"

deactivate

#!/bin/bash

# 角色筛选机 - Mac 上打包 Windows exe 脚本

echo "🔧 开始在 Mac 上打包 Windows exe..."
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 未找到 Node.js，请先安装 Node.js"
    exit 1
fi

echo "✅ Node.js 版本: $(node --version)"
echo "✅ npm 版本: $(npm --version)"
echo ""

# 清理 npm 缓存和配置
echo "🧹 清理 npm 缓存..."
npm cache clean --force
npm config delete registry
npm config delete electron_mirror
unset ELECTRON_RUN_AS_NODE

# 删除 .cache 目录（模型文件不打包，第一次启动时自动下载）
echo "🧹 删除模型缓存目录..."
rm -rf .cache

# 安装依赖
echo "📦 安装依赖..."
ELECTRON_MIRROR=https://github.com/electron/electron/releases/download/ \
ELECTRON_CUSTOM_DIR=v34.5.8 \
npm install --registry https://registry.npmjs.org/ --verbose

if [ $? -ne 0 ]; then
    echo "❌ 依赖安装失败，重试一次..."
    sleep 5
    ELECTRON_MIRROR=https://github.com/electron/electron/releases/download/ \
    ELECTRON_CUSTOM_DIR=v34.5.8 \
    npm install --registry https://registry.npmjs.org/
    
    if [ $? -ne 0 ]; then
        echo "❌ 依赖安装失败"
        exit 1
    fi
fi

echo "✅ 依赖安装完成"
echo ""

# 安装 Windows 平台的 sharp 原生模块
echo "🔧 安装 Windows 平台 sharp 模块..."
npm install --os=win32 --cpu=x64 sharp --registry https://registry.npmjs.org/ 2>&1 | tail -3
echo "✅ Windows sharp 安装完成"
echo ""

# 构建 Windows exe
echo "🏗️  构建 Windows exe..."
ELECTRON_MIRROR=https://github.com/electron/electron/releases/download/ \
ELECTRON_CUSTOM_DIR=v34.5.8 \
npm run build -- --win --x64 --publish=never

if [ $? -ne 0 ]; then
    echo "❌ 构建失败，尝试重新构建..."
    sleep 5
    ELECTRON_MIRROR=https://github.com/electron/electron/releases/download/ \
    ELECTRON_CUSTOM_DIR=v34.5.8 \
    npm run build -- --win --x64 --publish=never
    
    if [ $? -ne 0 ]; then
        echo "❌ 构建失败"
        exit 1
    fi
fi

echo ""
echo "✅ 打包完成！"
echo "📁 输出文件位置: dist/"
echo ""
echo "📋 打包信息："
echo "   - 模型文件：第一次启动时自动下载到用户数据目录"
echo "   - 图片文件：已包含在 exe 中"
echo "   - 向量索引：已包含在 exe 中"
echo ""
ls -lh dist/*.exe 2>/dev/null || ls -lh dist/ | grep -E "\.(exe|msi)$"

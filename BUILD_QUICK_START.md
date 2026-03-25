# 快速开始 - 打包 exe

## 一键打包（推荐）

在项目目录运行：

```bash
chmod +x build.sh && ./build.sh
```

## 手动步骤

```bash
# 1. 进入项目目录
cd /Users/zhang/Downloads/角色筛选机2.0

# 2. 安装依赖（首次需要）
npm install

# 3. 构建 Windows exe
npm run build -- --win
```

## 输出位置

打包完成后，exe 文件在：`dist/` 目录

- `角色筛选机 Setup 1.0.0.exe` - 安装程序版
- `角色筛选机 1.0.0.exe` - 便携版

## 包含内容

✅ 所有源代码
✅ 所有图片 (image/)
✅ 所有向量索引 (vector-index/)
✅ 所有依赖 (node_modules/)

🔄 模型文件 - 第一次启动时自动下载到用户数据目录

## 优势

- exe 文件更小（节省 200-300MB）
- 用户首次启动时自动下载最新模型
- 模型存储在用户目录，不占用 exe 空间

## 注意事项

- 首次打包会下载 electron 和其他依赖，需要 5-15 分钟
- 打包文件较大（500MB-1GB），需要足够的磁盘空间
- 确保 `.env` 中的 API_KEY 已配置

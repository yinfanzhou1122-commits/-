// =============================================
// Electron 主进程 (CJS，因为 Electron 不支持 ESM main)
// =============================================
// 在所有模块加载前禁用 TLS 证书验证（兼容自签名/中转 API 证书）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { app, BrowserWindow, shell, dialog, session, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 加载 .env 配置（打包后 __dirname 指向 asar 内部）
const dotenvPath = path.join(__dirname, '.env');
if (fs.existsSync(dotenvPath)) {
    require('dotenv').config({ path: dotenvPath });
} else {
    require('dotenv').config();
}

// ── 日志系统 ──────────────────────────────────────
let logStream = null;
let logFilePath = null;

function initLogger() {
    try {
        const logDir = path.join(app.getPath('userData'), 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        logFilePath = path.join(logDir, `app-${new Date().toISOString().slice(0,10)}.log`);
        logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
        const line = `\n${'='.repeat(60)}\n启动时间: ${new Date().toLocaleString()}\nElectron: ${process.versions.electron}\nNode: ${process.versions.node}\nPlatform: ${process.platform} ${process.arch}\n.env path: ${dotenvPath}\nTOS_BUCKET: ${process.env.TOS_BUCKET || '(未设置)'}\nTOS_OBJECT_KEY: ${process.env.TOS_OBJECT_KEY || '(未设置)'}\nTOS_REGION: ${process.env.TOS_REGION || '(未设置)'}\nTOS_ENDPOINT: ${process.env.TOS_ENDPOINT || '(未设置)'}\n${'='.repeat(60)}\n`;
        logStream.write(line);
        process.stdout.write(`📝 日志文件: ${logFilePath}\n`);
    } catch(e) {
        process.stderr.write(`日志初始化失败: ${e.message}\n`);
    }
}

function log(...args) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    process.stdout.write(line);
    if (logStream) logStream.write(line);
}

function logError(...args) {
    const msg = args.map(a => a instanceof Error ? `${a.message}\n${a.stack}` : String(a)).join(' ');
    const line = `[${new Date().toLocaleTimeString()}] ❌ ${msg}\n`;
    process.stderr.write(line);
    if (logStream) logStream.write(line);
}

const PORT = 3115;
let serverProcess = null;
let mainWindow = null;
let downloadWindow = null;

// 打包后 __dirname 在 asar 内部，所有写入操作必须使用 userData 目录
function getWritableDir(subDir) {
    const dir = path.join(app.getPath('userData'), subDir);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// ── 用户设置持久化 ──────────────────────────────────
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

function loadElectronSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
        }
    } catch (e) {
        log('⚠️ 读取 settings.json 失败:', e.message);
    }
    return {};
}

// ── 下载进度窗口 ──────────────────────────────────
function createDownloadWindow() {
    downloadWindow = new BrowserWindow({
        width: 560,
        height: 480,
        resizable: false,
        frame: false,
        center: true,
        title: '角色筛选机 - 初始化',
        backgroundColor: '#0a0504',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    downloadWindow.loadFile(path.join(__dirname, 'public', 'download-progress.html'));
    downloadWindow.on('closed', () => { downloadWindow = null; });
    return downloadWindow;
}

// 发送进度到下载窗口
function sendProgress(data) {
    log(`[进度] phase=${data.phase} percent=${data.percent ?? '-'} speed=${data.speed ?? '-'} msg=${data.message ?? ''}`);
    if (downloadWindow && !downloadWindow.isDestroyed()) {
        downloadWindow.webContents.send('download-progress', data);
    }
}

// ── 图片下载逻辑 ──────────────────────────────────
async function ensureImageDir(imageDir) {
    // 用标记文件判断是否下载完成（避免下载中途退出导致误判）
    const doneFlag = path.join(imageDir, '.download_complete');
    const ready = fs.existsSync(doneFlag);
    log(`图片目录检查: ${imageDir} → ${ready ? '已完成' : '需要下载'}`);
    return ready;
}

async function startDownload(imageDir, tempDir) {
    log('开始下载图片库...');
    log(`imageDir: ${imageDir}`);
    log(`tempDir: ${tempDir}`);
    log(`TOS配置: bucket=${process.env.TOS_BUCKET} key=${process.env.TOS_OBJECT_KEY} region=${process.env.TOS_REGION} endpoint=${process.env.TOS_ENDPOINT}`);

    // 动态 import ESM 模块
    const { downloadImages } = await import('./tos-downloader.js');

    return new Promise((resolve, reject) => {
        downloadImages({
            imageDir,
            tempDir,
            onProgress: (data) => {
                sendProgress(data);
            },
            onError: (err) => {
                logError('下载错误:', err);
                sendProgress({ phase: 'error', message: err.message });
                reject(err);
            },
            onComplete: () => {
                log('下载完成！');
                sendProgress({ phase: 'complete' });
                resolve();
            }
        });
    });
}

// ── 服务器启动 ────────────────────────────────────
function startServer(clipCacheDir, generatedImagesDir, vectorIndexDir, imageDir) {
    return new Promise(async (resolve, reject) => {
        log('🚀 启动 Express 服务器（同进程模式）...');

        try {
            // 设置环境变量（动态 import 前必须设置好）
            process.env.PORT = String(PORT);
            process.env.ELECTRON_MODE = '1';
            process.env.CLIP_CACHE_DIR = clipCacheDir;
            process.env.GENERATED_IMAGES_DIR = generatedImagesDir;
            process.env.VECTOR_INDEX_DIR = vectorIndexDir;
            process.env.IMAGE_LIBRARY_PATH = imageDir;
            // 确保 dotenv 能找到 .env
            process.env.DOTENV_PATH = path.join(__dirname, '.env');

            // 直接在同一进程内 import server.js，避免 spawn 路径问题
            // Windows 上需要转换为 file:// URL
            const serverPath = path.join(__dirname, 'server.js');
            const serverUrl = new URL(`file:///${serverPath.replace(/\\/g, '/')}`);
            log(`加载 server: ${serverUrl}`);

            // server.js import 后会异步启动，等待端口可用
            import(serverUrl).catch(err => logError('server import error:', err));

            // 轮询等待端口就绪
            const { default: http } = await import('http');
            const waitForPort = (port, timeout = 15000) => new Promise((res, rej) => {
                const start = Date.now();
                const check = () => {
                    const req = http.get(`http://127.0.0.1:${port}/`, (r) => { r.destroy(); res(); });
                    req.on('error', () => {
                        if (Date.now() - start > timeout) rej(new Error('服务器启动超时'));
                        else setTimeout(check, 300);
                    });
                    req.end();
                };
                check();
            });

            await waitForPort(PORT);
            log('✅ 服务器端口就绪');
            resolve();
        } catch(err) {
            logError('server.js 加载失败:', err);
            reject(err);
        }
    });
}

// ── 主窗口 ────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1200,
        minHeight: 700,
        title: '角色筛选机 v2.0',
        backgroundColor: '#0a0504',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.cjs')
        }
    });

    mainWindow.loadURL(`http://localhost:${PORT}/index.html`);

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.includes('localhost') || url.includes('127.0.0.1')) {
            if (/\.(png|jpg|jpeg|webp|gif|zip)(\?|$)/i.test(url)) {
                mainWindow.webContents.downloadURL(url);
                return { action: 'deny' };
            }
            return { action: 'allow' };
        }
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.webContents.session.on('will-download', (event, item) => {
        const suggestedName = item.getFilename() || '下载文件';
        dialog.showSaveDialog(mainWindow, {
            title: '保存文件',
            defaultPath: path.join(app.getPath('downloads'), suggestedName),
            filters: [{ name: 'All Files', extensions: ['*'] }]
        }).then(({ filePath, canceled }) => {
            if (canceled || !filePath) {
                item.cancel();
            } else {
                item.setSavePath(filePath);
            }
        });
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

// ── 应用启动流程 ──────────────────────────────────
app.whenReady().then(async () => {
    initLogger();
    try {
        // CLIP 模型缓存：打包后在 resources/clip-cache（extraResources），开发时在 .cache/clip
        let clipCacheDir;
        if (app.isPackaged) {
            clipCacheDir = path.join(process.resourcesPath, 'clip-cache');
        } else {
            clipCacheDir = path.join(__dirname, '.cache', 'clip');
        }
        log(`CLIP 缓存目录: ${clipCacheDir}`);

        const generatedImagesDir = getWritableDir('generated_images');
        const vectorIndexDir     = getWritableDir('vector-index');
        const tempDir            = getWritableDir('temp');

        // 图片素材目录：从 settings.json 读取用户配置，若无则留空由用户设置
        const savedSettings = loadElectronSettings();
        let imageDir = savedSettings.imageLibraryPath || '';
        
        // 开发模式下的默认值（方便开发调试）
        if (!imageDir && !app.isPackaged) {
            const devDefault = path.join(__dirname, 'image');
            if (fs.existsSync(devDefault)) {
                imageDir = devDefault;
            }
        }
        
        log(`图片素材目录: ${imageDir || '(未设置，需用户配置)'}`);

        log(`userData: ${app.getPath('userData')}`);
        log(`__dirname: ${__dirname}`);

        // 复制 vector-index 到可写目录（首次启动）
        const asarVectorIndex = path.join(__dirname, 'vector-index');
        if (fs.existsSync(asarVectorIndex)) {
            const files = fs.readdirSync(asarVectorIndex);
            for (const file of files) {
                const dest = path.join(vectorIndexDir, file);
                if (!fs.existsSync(dest)) {
                    fs.copyFileSync(path.join(asarVectorIndex, file), dest);
                    log(`📋 复制索引文件: ${file}`);
                }
            }
        }

        await launchMainApp(clipCacheDir, generatedImagesDir, vectorIndexDir, imageDir);

    } catch (err) {
        logError('启动失败:', err);
        dialog.showErrorBox('启动失败', `${err.message}\n\n日志文件: ${logFilePath || '未初始化'}`);
        app.quit();
    }
});

async function launchMainApp(clipCacheDir, generatedImagesDir, vectorIndexDir, imageDir) {
    if (downloadWindow && !downloadWindow.isDestroyed()) {
        downloadWindow.close();
    }
    await startServer(clipCacheDir, generatedImagesDir, vectorIndexDir, imageDir);
    log('✅ 服务器已启动');
    createWindow();

    // ── IPC: 文件夹选择对话框 ──────────────────────
    ipcMain.handle('select-image-folder', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: '选择素材库文件夹 (image)',
            properties: ['openDirectory'],
            buttonLabel: '选择此文件夹'
        });
        if (result.canceled || !result.filePaths.length) {
            return null;
        }
        return result.filePaths[0];
    });
}

app.on('window-all-closed', () => {
    if (!mainWindow) {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

app.on('before-quit', () => {
    // server 在同进程内运行，退出时自动结束
});

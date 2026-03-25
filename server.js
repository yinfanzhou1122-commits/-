import express from 'express';
import cors from 'cors';
import fs from 'fs';
import os from 'os';
import path from 'path';
import fetch from 'node-fetch';
import https from 'https';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import FormData from 'form-data';
import { buildAllIndexes, buildIndex, buildSceneIndex, search, searchScene, autoMatch, autoMatchScene, getStatus, checkClipHealth } from './vector-db.js';
import { batchEmbedImages, embedImage, embedText, getClipHealth, preloadClipModel } from './clip-service.js';

dotenv.config({ path: process.env.DOTENV_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3115;

app.use(cors());
// 请求日志中间件
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - start;
        console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
    });
    next();
});
// 增加 JSON body 大小限制
app.use(express.json({ limit: '50mb' }));
// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));
// Serve stitch (场景设定) page
app.use('/stitch', express.static(path.join(__dirname, 'stitch 场景设定')));

// 临时下载文件存储
const _tempDownloads = {};
// 接收 ZIP blob 并返回下载链接
app.post('/api/download-zip', express.raw({ type: 'application/octet-stream', limit: '200mb' }), (req, res) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const filename = req.query.filename || '角色图片.zip';
    // 使用可写目录（打包后 __dirname 在 asar 内部不可写）
    const tempDir = process.env.GENERATED_IMAGES_DIR || path.join(__dirname, 'generated_images');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `_temp_${id}.zip`);
    fs.writeFileSync(tempPath, req.body);
    _tempDownloads[id] = { path: tempPath, filename, created: Date.now() };
    // 30秒后自动清理
    setTimeout(() => {
        try { fs.unlinkSync(tempPath); } catch(e) {}
        delete _tempDownloads[id];
    }, 30000);
    res.json({ url: `/api/download-temp/${id}` });
});
app.get('/api/download-temp/:id', (req, res) => {
    const entry = _tempDownloads[req.params.id];
    if (!entry || !fs.existsSync(entry.path)) {
        return res.status(404).send('File not found');
    }
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(entry.filename)}"`);
    res.setHeader('Content-Type', 'application/zip');
    const stream = fs.createReadStream(entry.path);
    stream.pipe(res);
    stream.on('end', () => {
        try { fs.unlinkSync(entry.path); } catch(e) {}
        delete _tempDownloads[req.params.id];
    });
});

// Configuration loaded from .env
const API_BASE_URL = process.env.API_BASE_URL || 'https://ai.t8star.cn';
const API_KEY = process.env.API_KEY || '';

// ── 用户设置持久化 ──────────────────────────────────
// settings.json 存储在 userData 目录（Electron）或 ~/.character-filter/（Node.js 独立运行）
const SETTINGS_DIR = process.env.ELECTRON_MODE
    ? path.dirname(process.env.DOTENV_PATH || path.join(__dirname, '.env'))  // Electron: 与 .env 同级
    : (process.env.SETTINGS_DIR || path.join(os.homedir(), '.character-filter'));
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
        }
    } catch (e) {
        console.warn(`⚠️  读取 settings.json 失败: ${e.message}`);
    }
    return {};
}

function saveSettings(settings) {
    try {
        if (!fs.existsSync(SETTINGS_DIR)) {
            fs.mkdirSync(SETTINGS_DIR, { recursive: true });
        }
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
        console.log(`💾 设置已保存: ${SETTINGS_FILE}`);
    } catch (e) {
        console.error(`❌ 保存 settings.json 失败: ${e.message}`);
    }
}

// 从设置文件或环境变量加载图片库路径
const _savedSettings = loadSettings();
let IMAGE_LIBRARY_PATH = _savedSettings.imageLibraryPath
    || process.env.IMAGE_LIBRARY_PATH
    || path.join(__dirname, 'image');

// 风格 → 文件夹映射
const STYLE_FOLDER_MAP = {
    'real': '真人',
    '2d': '2D',
    '3d': '3D'
};

// 默认风格（未选择风格时使用）
const DEFAULT_STYLE = 'real';

/**
 * 根据风格代码获取对应的图片库路径
 * @param {string} style - 'real' | '2d' | '3d'
 * @returns {string} 对应风格子文件夹的完整路径
 */
function getStyleLibraryPath(style) {
    const folder = STYLE_FOLDER_MAP[style] || STYLE_FOLDER_MAP[DEFAULT_STYLE];
    return path.join(IMAGE_LIBRARY_PATH, folder);
}

// Ensure the local image library exists (warn only, don't block startup)
if (IMAGE_LIBRARY_PATH && !fs.existsSync(IMAGE_LIBRARY_PATH)) {
    console.warn(`⚠️  Warning: Image library path does not exist: ${IMAGE_LIBRARY_PATH}`);
}

const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
    minVersion: 'TLSv1',
    timeout: 60000,
    maxSockets: 10
});

// 请求超时设置 (10分钟，因为图片生成可能较慢)
const FETCH_TIMEOUT = 600000;

// 带重试的 fetch 包装器（解决 Electron 中 TLS 握手偶发失败）
// 预配置的 axios 实例（使用与 httpsAgent 相同的 TLS 设置）
const axiosInstance = axios.create({
    httpsAgent: httpsAgent,
    timeout: FETCH_TIMEOUT,
    maxBodyLength: Infinity,
    maxContentLength: Infinity
});

async function fetchWithRetry(url, options = {}, maxRetries = 2) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                console.log(`  🔄 第 ${attempt} 次重试: ${url.substring(0, 80)}...`);
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
            return await fetch(url, { agent: httpsAgent, ...options });
        } catch (err) {
            lastError = err;
            const isRetryable = err.message?.includes('TLS') ||
                err.message?.includes('socket') ||
                err.message?.includes('ECONNRESET') ||
                err.message?.includes('ECONNREFUSED') ||
                err.code === 'ERR_TLS_CERT_ALTNAME_INVALID';
            if (!isRetryable || attempt >= maxRetries) throw err;
            console.warn(`  ⚠️ 网络错误 (尝试 ${attempt + 1}/${maxRetries + 1}): ${err.message}`);
        }
    }
    throw lastError;
}

// 日志工具
function logRequest(endpoint, message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warn' ? '⚠️' : '📡';
    console.log(`${prefix} [${timestamp}] [${endpoint}] ${message}`);
}

const LIBRARY_PART_FOLDERS = {
    face: '脸',
    halfbody: '半身图',
    hair: '发型',
    clothes: '服装',
    threeview: '三视图'
};

function normalizeGenderKey(gender) {
    return gender === 'male' || String(gender || '').includes('男') ? 'male' : 'female';
}

function sanitizePathSegments(input) {
    return String(input || '')
        .split(/[\\/]/)
        .map(seg => seg.trim())
        .filter(seg => seg && seg !== '.' && seg !== '..')
        .map(seg => seg.replace(/[<>:"|?*\x00-\x1F]/g, '_'));
}

function saveBase64ImageToLibrary({ endpoint, dataUrl, gender, partType, filename, subfolder }) {
    const genderKey = normalizeGenderKey(gender);
    const genderFolder = genderKey === 'male' ? '男性' : genderKey === 'monster' ? '妖兽' : '女性';
    const partFolder = LIBRARY_PART_FOLDERS[partType] || partType;

    if (!Object.values(LIBRARY_PART_FOLDERS).includes(partFolder)) {
        throw new Error('不支持的素材类型');
    }

    const matches = String(dataUrl || '').match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) {
        throw new Error('无效的图片数据');
    }

    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const base64Data = matches[2];
    const safeSegments = sanitizePathSegments(subfolder);
    const targetPath = path.join(getStyleLibraryPath(DEFAULT_STYLE), genderFolder, partFolder, ...safeSegments);

    if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true });
    }

    const rawBaseName = path.parse(filename || `upload_${Date.now()}`).name;
    const safeBaseName = (rawBaseName || `upload_${Date.now()}`).replace(/[^\w\u4e00-\u9fa5._-]/g, '_');
    const imageFileName = `${safeBaseName}.${ext}`;
    const imagePath = path.join(targetPath, imageFileName);

    fs.writeFileSync(imagePath, Buffer.from(base64Data, 'base64'));
    logRequest(endpoint, `图片已保存: ${imagePath}`, 'success');

    const relPath = [...safeSegments, imageFileName].join('/');
    const urlPath = relPath
        ? `${partFolder}/${encodeURIComponent(relPath).replace(/%2F/g, '/')}`
        : `${partFolder}/${encodeURIComponent(imageFileName)}`;

    return {
        genderKey,
        genderFolder,
        partFolder,
        filename: imageFileName,
        path: imagePath,
        relPath,
        url: `/images/${genderFolder}/${urlPath}`,
        message: `已添加到素材库: ${genderFolder}/${partFolder}/${relPath || imageFileName}`
    };
}

function rebuildVectorIndexInBackground(endpoint, gender, partType) {
    setImmediate(async () => {
        try {
            const clipOk = await checkClipHealth();
            if (!clipOk) {
                logRequest(endpoint, `JS CLIP 运行时不可用，跳过自动建索引: ${gender}/${partType}`, 'warn');
                return;
            }

            logRequest(endpoint, `开始自动更新索引: ${gender}/${partType}`);
            await buildIndex(getStyleLibraryPath(DEFAULT_STYLE), gender, partType, (msg) => logRequest(endpoint, msg));
            logRequest(endpoint, `索引更新完成: ${gender}/${partType}`, 'success');
        } catch (error) {
            logRequest(endpoint, `自动建索引失败: ${error.message}`, 'error');
        }
    });
}

console.log('🚀 Node.js Server Starting...');
console.log(`📡 API Base URL: ${API_BASE_URL}`);
console.log(`📂 Image Library: ${IMAGE_LIBRARY_PATH}`);
console.log(`🌐 Server Port: ${PORT}`);

// 兼容原 Python CLIP 微服务的接口
app.get('/health', async (req, res) => {
    const health = await getClipHealth();
    res.status(health.status === 'ok' ? 200 : 503).json(health);
});

app.post('/embed-text', async (req, res) => {
    try {
        const vector = await embedText(req.body?.text);
        res.json({ vector, dimension: vector.length });
    } catch (error) {
        console.error(error);
        const statusCode = String(error.message || '').includes('缺少 text 参数') ? 400 : 500;
        res.status(statusCode).json({ error: error.message });
    }
});

app.post('/embed-image', async (req, res) => {
    try {
        const vector = await embedImage(req.body?.path);
        res.json({ vector, dimension: vector.length });
    } catch (error) {
        console.error(error);
        const message = String(error.message || '');
        const statusCode = message.includes('缺少 path 参数') || message.includes('图片不存在') ? 400 : 500;
        res.status(statusCode).json({ error: error.message });
    }
});

app.post('/batch-embed-images', async (req, res) => {
    try {
        const result = await batchEmbedImages(req.body?.paths || []);
        res.json(result);
    } catch (error) {
        console.error(error);
        const statusCode = String(error.message || '').includes('缺少 paths 参数') ? 400 : 500;
        res.status(statusCode).json({ error: error.message });
    }
});

// 健康检查端点
app.get('/api/health', async (req, res) => {
    const clip = await getClipHealth();
    res.json({
        status: 'ok',
        api_base_url: API_BASE_URL,
        image_library: IMAGE_LIBRARY_PATH,
        style_folders: STYLE_FOLDER_MAP,
        default_style: DEFAULT_STYLE,
        clip,
        timestamp: new Date().toISOString()
    });
});

// ── 用户设置 API ──────────────────────────────────
app.get('/api/settings', (req, res) => {
    // 检测哪些风格子文件夹存在
    const availableStyles = {};
    if (IMAGE_LIBRARY_PATH && fs.existsSync(IMAGE_LIBRARY_PATH)) {
        for (const [code, folder] of Object.entries(STYLE_FOLDER_MAP)) {
            availableStyles[code] = fs.existsSync(path.join(IMAGE_LIBRARY_PATH, folder));
        }
    }
    res.json({
        success: true,
        imageLibraryPath: IMAGE_LIBRARY_PATH,
        availableStyles,
        settingsFile: SETTINGS_FILE
    });
});

app.post('/api/settings', (req, res) => {
    const endpoint = 'settings';
    const { imageLibraryPath } = req.body;

    if (imageLibraryPath !== undefined) {
        // 校验路径
        if (imageLibraryPath && !fs.existsSync(imageLibraryPath)) {
            logRequest(endpoint, `路径不存在: ${imageLibraryPath}`, 'error');
            return res.status(400).json({ success: false, message: `路径不存在: ${imageLibraryPath}` });
        }

        const oldPath = IMAGE_LIBRARY_PATH;
        IMAGE_LIBRARY_PATH = imageLibraryPath || '';
        logRequest(endpoint, `图片库路径已更新: ${oldPath} → ${IMAGE_LIBRARY_PATH}`, 'success');

        // 持久化
        const settings = loadSettings();
        settings.imageLibraryPath = IMAGE_LIBRARY_PATH;
        saveSettings(settings);

        // 热更新静态路由
        refreshImageStaticRoutes();
    }

    res.json({
        success: true,
        imageLibraryPath: IMAGE_LIBRARY_PATH
    });
});

// ── 原生文件夹选择对话框 ──────────────────────────
app.post('/api/select-folder', async (req, res) => {
    const { execSync } = await import('child_process');
    const fs = await import('fs');
    const os = await import('os');
    const pathMod = await import('path');
    try {
        let selected = '';
        if (process.platform === 'win32') {
            // Windows: PowerShell FolderBrowserDialog
            // 使用临时文件传递路径，避免控制台编码导致中文乱码
            const tmpFile = pathMod.join(os.tmpdir(), `_folder_pick_${Date.now()}.txt`);
            const psScript = [
                'Add-Type -AssemblyName System.Windows.Forms',
                '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
                "$f.Description = '选择素材库文件夹 (image)'",
                '$f.ShowNewFolderButton = $false',
                `if ($f.ShowDialog() -eq 'OK') { [System.IO.File]::WriteAllText('${tmpFile.replace(/\\/g, '\\\\')}', $f.SelectedPath, [System.Text.Encoding]::UTF8) }`
            ].join('; ');
            execSync(`powershell -NoProfile -Command "${psScript}"`, {
                timeout: 120000,
                windowsHide: false
            });
            if (fs.existsSync(tmpFile)) {
                selected = fs.readFileSync(tmpFile, 'utf-8').replace(/^\uFEFF/, '').trim();
                fs.unlinkSync(tmpFile);
            }
        } else {
            // macOS: osascript
            selected = execSync(
                `osascript -e 'POSIX path of (choose folder with prompt "选择素材库文件夹 (image)")'`,
                { encoding: 'utf-8', timeout: 120000 }
            ).trim();
        }

        if (selected) {
            res.json({ success: true, path: selected });
        } else {
            res.json({ success: false, message: '未选择文件夹' });
        }
    } catch (err) {
        // User cancelled the dialog
        res.json({ success: false, message: '取消选择' });
    }
});

// Endpoint to proxy Gemini AI prompt parsing
app.post('/api/parse-prompt', async (req, res) => {
    const endpoint = 'parse-prompt';
    const { prompt, apiKey } = req.body;

    const validKey = apiKey || API_KEY;

    if (!validKey) {
        logRequest(endpoint, '缺少 API Key', 'error');
        return res.status(400).json({
            success: false,
            message: '请在 .env 文件中配置 API_KEY 或在前端输入 API Key'
        });
    }

    logRequest(endpoint, '='.repeat(50));
    logRequest(endpoint, `收到请求，提示词长度: ${prompt?.length || 0} 字符`);
    logRequest(endpoint, `API Key: ${validKey.substring(0, 8)}...${validKey.substring(validKey.length - 4)}`);
    logRequest(endpoint, `目标URL: ${API_BASE_URL}/v1/chat/completions`);
    logRequest(endpoint, `模型: gemini-3.1-pro-preview`);

    // Use Gemini to extract character details
    const geminiPrompt = `
You are a character tag extractor. Please extract ALL characters from this character description.
For each character, extract:
- name (名字)
- gender (性别)
- age (年龄)
- era (时代背景)
- profession (职业)
- hair_description (发型描述)
- clothing_description (服装描述)
- original_text (原始描述文本 - 完整复制用户输入中关于这个角色的所有描述，不要省略任何内容)

Return a JSON array of characters. If any information is missing, infer a reasonable default or write "Unknown".
Respond in strict JSON format as an array. Do not include markdown blocks or any other text.

Example format:
[{"name":"小红","gender":"女","age":"20岁","era":"现代","profession":"学生","hair_description":"长发","clothing_description":"白色连衣裙","original_text":"小红是一个20岁的女学生，留着长发，穿着白色连衣裙"}]

Description: ${prompt}
        `;

    const requestBody = {
        model: 'gemini-3.1-pro-preview',
        response_format: { type: "json_object" },
        messages: [
            { role: 'system', content: 'You are a helpful assistant that outputs JSON.' },
            { role: 'user', content: geminiPrompt }
        ]
    };

    try {
        logRequest(endpoint, '⏳ 发送请求到 API...');
        const startTime = Date.now();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

        const response = await fetchWithRetry(`${API_BASE_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${validKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        logRequest(endpoint, `API 响应! 耗时: ${elapsed}s, HTTP状态: ${response.status}`, response.ok ? 'success' : 'error');

        if (!response.ok) {
            const errText = await response.text();
            logRequest(endpoint, `API 错误响应: ${errText.substring(0, 500)}`, 'error');
            return res.status(500).json({
                success: false,
                message: `API Error (HTTP ${response.status}): ${errText.substring(0, 300)}`,
                debug: {
                    status_code: response.status,
                    elapsed: elapsed,
                    response_preview: errText.substring(0, 500)
                }
            });
        }

        const data = await response.json();
        logRequest(endpoint, `JSON 解析成功`);

        // 检查返回结构
        if (!data.choices || !data.choices[0]) {
            logRequest(endpoint, '响应中没有 choices 字段!', 'error');
            return res.status(500).json({
                success: false,
                message: 'API 响应格式异常：没有 choices 字段',
                debug: { raw_response: data }
            });
        }

        const content = data.choices[0].message.content;
        logRequest(endpoint, `AI 返回内容: ${content.substring(0, 500)}`);

        // 解析角色数组
        let characters = JSON.parse(content);
        // 如果返回的是对象而不是数组，尝试提取
        if (!Array.isArray(characters)) {
            if (characters.characters) {
                characters = characters.characters;
            } else if (characters.tags) {
                characters = [characters.tags];
            } else {
                characters = [characters];
            }
        }

        logRequest(endpoint, `🎯 解析成功! 识别到 ${characters.length} 个角色`, 'success');

        res.json({
            success: true,
            characters,
            debug: {
                elapsed: parseFloat(elapsed),
                model_used: data.model || 'unknown',
                usage: data.usage || {}
            }
        });
    } catch (error) {
        logRequest(endpoint, `请求异常: ${error.message}`, 'error');
        console.error(error);

        if (error.name === 'AbortError') {
            return res.status(500).json({
                success: false,
                message: `请求超时（>${FETCH_TIMEOUT / 1000}秒）`
            });
        }

        res.status(500).json({
            success: false,
            message: `请求失败: ${error.message}`
        });
    }
});

// Endpoint to read local image library and find matching images
// 新的文件夹结构: image/{male|female}/{face|hair|clothes}/
app.post('/api/get-images', (req, res) => {
    const endpoint = 'get-images';
    const { gender, partType } = req.body;

    logRequest(endpoint, '='.repeat(50));
    logRequest(endpoint, `收到请求，性别: ${gender}, 部件类型: ${partType}`);

    try {
        // 根据性别确定文件夹 (默认 female)
        let genderFolder = 'female';
        if (gender && gender.includes('男')) {
            genderFolder = 'male';
        }

        // 构建图片文件夹路径
        const targetPath = path.join(getStyleLibraryPath(DEFAULT_STYLE), genderFolder, partType);

        logRequest(endpoint, `查找路径: ${targetPath}`);

        // 检查文件夹是否存在
        if (!fs.existsSync(targetPath)) {
            logRequest(endpoint, `文件夹不存在: ${targetPath}`, 'warn');
            // 创建文件夹
            fs.mkdirSync(targetPath, { recursive: true });
            return res.json({
                success: true,
                images: [],
                folder: `${genderFolder}/${partType}`,
                message: '文件夹已创建，请添加图片'
            });
        }

        // 读取图片文件
        const files = fs.readdirSync(targetPath);
        const imageFiles = files.filter(f => f.match(/\.(png|jpe?g|webp|gif)$/i));

        // 返回图片列表，包含完整路径
        const images = imageFiles.map(filename => ({
            filename,
            url: `/images/${genderFolder}/${partType}/${filename}`
        }));

        logRequest(endpoint, `找到 ${images.length} 个图片`, 'success');

        res.json({
            success: true,
            images,
            folder: `${genderFolder}/${partType}`
        });
    } catch (error) {
        logRequest(endpoint, `错误: ${error.message}`, 'error');
        console.error("Error reading image library:", error);
        res.status(500).json({ success: false, message: 'Failed to access image library.' });
    }
});

// 获取所有可用图片 (带标签匹配)
// 标签文件格式: 女，20-25岁，主角
// 递归收集所有图片（支持多级子文件夹）
function collectImagesRecursively(dirPath, relativePath = '', characters = []) {
    const images = [];
    if (!fs.existsSync(dirPath)) return images;

    const items = fs.readdirSync(dirPath);
    const subfolders = [];
    const imageFiles = [];

    // 分类：子文件夹和图片文件
    items.forEach(item => {
        if (item.startsWith('.')) return;
        const itemPath = path.join(dirPath, item);
        try {
            const stat = fs.statSync(itemPath);
            if (stat.isDirectory()) {
                subfolders.push(item);
            } else if (item.match(/\.(png|jpe?g|webp|gif)$/i)) {
                imageFiles.push(item);
            }
        } catch (e) { /* ignore */ }
    });

    // 如果有子文件夹，递归到子文件夹（优先使用子文件夹中的图片）
    if (subfolders.length > 0) {
        subfolders.forEach(subfolder => {
            const subPath = path.join(dirPath, subfolder);
            const subRelPath = relativePath ? `${relativePath}/${subfolder}` : subfolder;
            const subImages = collectImagesRecursively(subPath, subRelPath, characters);
            images.push(...subImages);
        });
        return images; // 有子文件夹时，只返回子文件夹中的图片
    }

    // 没有子文件夹，收集当前目录的图片（最底层）
    imageFiles.forEach(filename => {
        const baseName = filename.substring(0, filename.lastIndexOf('.'));
        const txtPath = path.join(dirPath, `${baseName}.txt`);

        let tags = [];
        let matchedCharacters = [];

        if (fs.existsSync(txtPath)) {
            const txtContent = fs.readFileSync(txtPath, 'utf8').trim();
            tags = txtContent.split(/[,，、\s]+/).filter(t => t.trim());

            if (characters && characters.length > 0) {
                matchedCharacters = characters.map((char, idx) => {
                    const charGender = char.gender || '';
                    const charAge = char.age || '';

                    const genderMatch = tags.some(tag => {
                        if (charGender.includes('男')) return tag.includes('男');
                        if (charGender.includes('女')) return tag.includes('女');
                        return true;
                    });

                    const ageMatch = tags.some(tag => {
                        if (tag.includes('岁') || tag.includes('年龄')) {
                            const ageRange = tag.match(/(\d+)[-~](\d+)/);
                            if (ageRange) {
                                const minAge = parseInt(ageRange[1]);
                                const maxAge = parseInt(ageRange[2]);
                                let charAgeNum = parseInt(charAge.match(/\d+/)?.[0] || 0);
                                if (!charAgeNum) {
                                    const chineseNums = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '二十': 20, '三十': 30, '四十': 40, '五十': 50 };
                                    for (const [cn, num] of Object.entries(chineseNums)) {
                                        if (charAge.includes(cn)) { charAgeNum = num; break; }
                                    }
                                }
                                if (!charAgeNum) return true;
                                return charAgeNum >= minAge && charAgeNum <= maxAge;
                            }
                        }
                        return true;
                    });

                    return (genderMatch && ageMatch) ? idx : -1;
                }).filter(idx => idx >= 0);
            }
        }

        // 构建 URL：包含完整的子路径
        const urlPath = relativePath ? `${relativePath}/${filename}` : filename;

        images.push({
            filename,
            subfolder: relativePath,
            url: `/images/${urlPath}`,
            tags,
            matchedCharacters
        });
    });

    return images;
}

app.post('/api/get-all-images', (req, res) => {
    const endpoint = 'get-all-images';
    const { characters } = req.body;

    logRequest(endpoint, `获取图片并匹配标签，角色数: ${characters?.length || 0}`);

    try {
        const results = {
            male: { face: [], hair: [], clothes: [] },
            female: { face: [], hair: [], clothes: [] }
        };
        const genderMap = { male: '男性', female: '女性', monster: '妖兽' };
        const partMap = { face: '脸', hair: '发型', clothes: '服装' };

        ['male', 'female'].forEach(g => {
            ['face', 'hair', 'clothes'].forEach(p => {
                // 使用中文文件夹名
                const targetPath = path.join(getStyleLibraryPath(DEFAULT_STYLE), genderMap[g], partMap[p]);
                if (fs.existsSync(targetPath)) {
                    const images = collectImagesRecursively(targetPath, `${genderMap[g]}/${partMap[p]}`, characters);
                    results[g][p] = images;
                }
            });
        });

        logRequest(endpoint, `图片统计: 男脸${results.male.face.length}, 男发型${results.male.hair.length}, 男服装${results.male.clothes.length}, 女脸${results.female.face.length}, 女发型${results.female.hair.length}, 女服装${results.female.clothes.length}`, 'success');
        res.json({ success: true, images: results });
    } catch (error) {
        logRequest(endpoint, `错误: ${error.message}`, 'error');
        res.status(500).json({ success: false, message: error.message });
    }
});

// 图片上传接口
app.post('/api/upload-image', (req, res) => {
    const endpoint = 'upload-image';
    logRequest(endpoint, '收到图片上传请求');

    const { image, gender, partType, filename, subfolder } = req.body;

    if (!image || !gender || !partType) {
        return res.status(400).json({ success: false, message: '缺少参数' });
    }

    try {
        const saved = saveBase64ImageToLibrary({
            endpoint,
            dataUrl: image,
            gender,
            partType,
            filename,
            subfolder
        });

        res.json({
            success: true,
            message: saved.message,
            url: saved.url,
            filename: saved.filename,
            path: saved.path
        });

        rebuildVectorIndexInBackground(endpoint, saved.genderKey, partType);
    } catch (error) {
        logRequest(endpoint, `上传失败: ${error.message}`, 'error');
        res.status(500).json({ success: false, message: error.message });
    }
});

// Serve local images - 按风格分文件夹：image/{真人|2D|3D}/{男性|女性|场景}/...
// 使用动态中间件，支持 IMAGE_LIBRARY_PATH 热更新
function refreshImageStaticRoutes() {
    // 移除旧的 /images 路由层（Express 5 Router.stack）
    if (app._router && app._router.stack) {
        app._router.stack = app._router.stack.filter(layer => {
            if (layer.name === 'serveStatic' && layer.regexp && layer.regexp.toString().includes('images')) {
                return false;
            }
            return true;
        });
    }
    if (!IMAGE_LIBRARY_PATH) return;
    for (const [styleCode, folderName] of Object.entries(STYLE_FOLDER_MAP)) {
        const stylePath = path.join(IMAGE_LIBRARY_PATH, folderName);
        if (fs.existsSync(stylePath)) {
            app.use(`/images/${styleCode}`, express.static(stylePath));
        }
    }
    // 保持向后兼容：默认 /images 指向当前选中的风格（真人）
    const defaultStylePath = getStyleLibraryPath(DEFAULT_STYLE);
    if (fs.existsSync(defaultStylePath)) {
        app.use('/images', express.static(defaultStylePath));
    }
    console.log(`🔄 静态图片路由已刷新 → ${IMAGE_LIBRARY_PATH}`);
}
refreshImageStaticRoutes();

// =============================================
// 文件夹浏览 API — 返回指定目录下的子文件夹和图片
// =============================================
app.post('/api/browse-folder', (req, res) => {
    const endpoint = 'browse-folder';
    let { folderPath } = req.body;

    // 安全限制：不允许访问系统敏感目录（跨平台）
    const blockedUnix = ['/etc', '/System', '/Library', '/private', '/var', '/usr', '/bin', '/sbin'];
    const blockedWin = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];
    const blocked = process.platform === 'win32' ? blockedWin : blockedUnix;
    const normalizedPath = path.resolve(folderPath);
    if (blocked.some(b => normalizedPath.toLowerCase().startsWith(b.toLowerCase()))) {
        return res.status(403).json({ success: false, message: '不允许访问系统目录' });
    }

    logRequest(endpoint, `浏览文件夹: ${folderPath}`);

    try {
        if (!fs.existsSync(folderPath)) {
            return res.json({ success: false, message: '文件夹不存在', currentPath: folderPath });
        }

        const stat = fs.statSync(folderPath);
        if (!stat.isDirectory()) {
            return res.json({ success: false, message: '不是文件夹', currentPath: folderPath });
        }

        const parentPath = path.dirname(folderPath);
        const items = fs.readdirSync(folderPath);

        // 收集子文件夹
        const folders = [];
        const images = [];

        for (const item of items) {
            if (item.startsWith('.')) continue; // 跳过隐藏文件
            const fullPath = path.join(folderPath, item);
            try {
                const itemStat = fs.statSync(fullPath);
                if (itemStat.isDirectory()) {
                    // 计算子文件夹内的图片数量（递归）
                    let imageCount = 0;
                    const countImages = (dir) => {
                        try {
                            const entries = fs.readdirSync(dir);
                            for (const e of entries) {
                                if (e.startsWith('.')) continue;
                                const ep = path.join(dir, e);
                                const es = fs.statSync(ep);
                                if (es.isDirectory()) countImages(ep);
                                else if (e.match(/\.(png|jpe?g|webp|gif)$/i)) imageCount++;
                            }
                        } catch (e) { /* ignore permission errors */ }
                    };
                    countImages(fullPath);
                    folders.push({ name: item, path: fullPath, imageCount });
                } else if (item.match(/\.(png|jpe?g|webp|gif)$/i)) {
                    images.push({ filename: item, path: fullPath });
                }
            } catch (e) { /* skip permission errors */ }
        }

        logRequest(endpoint, `${folders.length} 个文件夹, ${images.length} 张图片`, 'success');

        res.json({
            success: true,
            currentPath: folderPath,
            parentPath,
            folderName: path.basename(folderPath),
            folders,
            images
        });
    } catch (error) {
        logRequest(endpoint, `浏览失败: ${error.message}`, 'error');
        res.status(500).json({ success: false, message: error.message });
    }
});

// =============================================
// 图片文件访问 — 根据绝对路径返回图片（支持项目外图片）
// =============================================
app.get('/api/browse-image', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) {
        return res.status(400).json({ success: false, message: '缺少 path 参数' });
    }

    // 安全限制（跨平台）
    const blockedUnix = ['/etc', '/System', '/Library', '/private', '/var', '/usr', '/bin', '/sbin'];
    const blockedWin = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];
    const blocked = process.platform === 'win32' ? blockedWin : blockedUnix;
    const normalizedFilePath = path.resolve(filePath);
    if (blocked.some(b => normalizedFilePath.toLowerCase().startsWith(b.toLowerCase()))) {
        return res.status(403).json({ success: false, message: '不允许访问系统目录' });
    }

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, message: '文件不存在' });
    }

    // 仅允许图片文件
    if (!filePath.match(/\.(png|jpe?g|webp|gif)$/i)) {
        return res.status(400).json({ success: false, message: '不是图片文件' });
    }

    res.sendFile(filePath);
});

// 在资源管理器/Finder中打开指定文件夹（跨平台）
app.post('/api/open-folder', (req, res) => {
    const { gender, partType } = req.body;
    const genderFolder = gender === 'male' ? 'male' : 'female';
    const folderPath = path.join(getStyleLibraryPath(DEFAULT_STYLE), genderFolder, partType);

    logRequest('open-folder', `请求打开文件夹: ${folderPath}`);

    // 跨平台打开文件夹
    const platform = process.platform;
    let cmd;
    if (platform === 'win32') {
        cmd = `start "" "${folderPath}"`;
    } else if (platform === 'darwin') {
        cmd = `open "${folderPath}"`;
    } else {
        cmd = `xdg-open "${folderPath}"`;
    }
    exec(cmd, (error) => {
        if (error) {
            logRequest('open-folder', `打开失败: ${error.message}`, 'error');
            return res.json({ success: false, message: error.message });
        }
        logRequest('open-folder', `已打开文件夹`, 'success');
        res.json({ success: true, path: folderPath });
    });
});

// Endpoint to proxy nano-banana-2 generation
// 支持两种模式：
// 1. 发送拼接后的单张图片 (image 参数)
// 2. 发送三张独立图片 (face, hair, clothes 参数)
app.post('/api/generate-image', async (req, res) => {
    const endpoint = 'generate-image';
    const { face, hair, clothes, image, prompt: customPrompt, apiKey, aspect_ratio: reqAspectRatio } = req.body;

    const validKey = apiKey || API_KEY;

    if (!validKey) {
        logRequest(endpoint, '缺少 API Key', 'error');
        return res.status(400).json({
            success: false,
            message: '请在 .env 文件中配置 API_KEY 或在前端输入 API Key'
        });
    }

    // Format prompt as requested
    const prompt = customPrompt || "将图中的发型、人物脸部、服装，融合成一个新的人物，保持人物画风不变，纯白色背景，全身照，正对镜头，双手自然下垂。";
    const aspectRatio = reqAspectRatio || '3:4';

    logRequest(endpoint, '='.repeat(50));

    // 判断是单张拼接图片还是三张独立图片
    let imageData;
    let mode;
    if (image) {
        // 模式1：前端已拼接的单张图片
        logRequest(endpoint, '收到请求，模式: 单张拼接图片');
        imageData = image;
        mode = 'single_merged';
    } else {
        // 模式2：三张独立图片
        const imageRefs = [face, hair, clothes].filter(x => x);
        logRequest(endpoint, `收到请求，模式: 三张独立图片，数量: ${imageRefs.length}`);
        imageData = imageRefs;
        mode = 'multi_input';
    }

    logRequest(endpoint, `目标URL: ${API_BASE_URL}/v1/images/edits (图生图)`);
    logRequest(endpoint, `模型: nano-banana-2`);

    try {
        const requestInputDebug = await saveGenerateImageRequestInputs({
            endpoint,
            mode,
            image,
            face,
            hair,
            clothes,
            prompt,
            aspectRatio
        });
        logRequest(endpoint, '⏳ 发送请求到 API...');
        const startTime = Date.now();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

        const imageInputs = Array.isArray(imageData) ? imageData : [imageData];

        // 使用 FormData 构建请求
        const formData = new FormData();
        formData.append('model', 'nano-banana-2');
        formData.append('prompt', prompt);
        formData.append('response_format', 'url');
        formData.append('aspect_ratio', aspectRatio);
        if (aspectRatio === '3:4') {
            formData.append('image_size', '2K');
        }
        imageInputs.forEach((input, index) => {
            const decoded = decodeIncomingImageInput(input);
            if (!decoded) {
                throw new Error(`第 ${index + 1} 张输入图片不是有效的 base64 图片`);
            }

            formData.append('image', decoded.buffer, {
                filename: imageInputs.length === 1 ? 'merged_image.png' : `input_${index + 1}${decoded.ext}`,
                contentType: `image/${decoded.ext.replace('.', '') === 'jpg' ? 'jpeg' : decoded.ext.replace('.', '')}`
            });
        });
        logRequest(endpoint, `已附加输入图片数量: ${imageInputs.length}`);

        // 图生图使用 /v1/images/edits 端点 (带重试的 axios 调用，解决 TLS 握手偶发失败)
        let axiosResponse;
        for (let _attempt = 0; _attempt <= 2; _attempt++) {
            try {
                if (_attempt > 0) {
                    logRequest(endpoint, `🔄 第 ${_attempt} 次重试 axios 请求...`);
                    await new Promise(r => setTimeout(r, 1000 * _attempt));
                }
                axiosResponse = await axiosInstance.post(`${API_BASE_URL}/v1/images/edits`, formData, {
                    headers: {
                        'Authorization': `Bearer ${validKey}`,
                        ...formData.getHeaders()
                    },
                    signal: controller.signal,
                    validateStatus: () => true
                });
                break; // 成功则跳出重试循环
            } catch (axErr) {
                const isRetryable = axErr.message?.includes('TLS') || axErr.message?.includes('socket') || axErr.message?.includes('ECONNRESET') || axErr.code === 'ECONNREFUSED';
                if (!isRetryable || _attempt >= 2) throw axErr;
                logRequest(endpoint, `⚠️ axios 网络错误 (尝试 ${_attempt + 1}/3): ${axErr.message}`, 'error');
            }
        }

        clearTimeout(timeoutId);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        logRequest(endpoint, `API 响应! 耗时: ${elapsed}s, HTTP状态: ${axiosResponse.status}`, axiosResponse.status >= 200 && axiosResponse.status < 300 ? 'success' : 'error');

        if (axiosResponse.status < 200 || axiosResponse.status >= 300) {
            const errText = typeof axiosResponse.data === 'string' ? axiosResponse.data : JSON.stringify(axiosResponse.data);
            logRequest(endpoint, `API 错误响应: ${errText.substring(0, 500)}`, 'error');
            return res.status(500).json({
                success: false,
                message: `API Error (HTTP ${axiosResponse.status}): ${errText.substring(0, 300)}`,
                debug: { status_code: axiosResponse.status, elapsed }
            });
        }

        const data = axiosResponse.data;

        // The exact response schema depends on the API. Often it's response.data.data[0].url
        const outputImage = data.data?.[0]?.url || data.url;

        logRequest(endpoint, `🎯 生成成功! 图片URL: ${outputImage?.substring(0, 100) || 'NONE'}`, 'success');

        // 异步保存图片到本地
        const localUrl = await saveImageLocally(outputImage, 'character');

        res.json({
            success: true,
            imageUrl: outputImage,
            localUrl: localUrl,
            debug: {
                elapsed: parseFloat(elapsed),
                requestInputRecord: requestInputDebug.debugRecordFile,
                savedInputs: requestInputDebug.savedInputs
            }
        });
    } catch (error) {
        logRequest(endpoint, `请求异常: ${error.message}`, 'error');
        console.error("Error generating image:", error);

        if (error.name === 'AbortError') {
            return res.status(500).json({
                success: false,
                message: `请求超时（>${FETCH_TIMEOUT / 1000}秒）`
            });
        }

        res.status(500).json({
            success: false,
            message: `请求失败: ${error.message}`
        });
    }
});


// =============================================
// 场景文生图 API
// POST /api/generate-scene
// 使用 https://ai.t8star.cn/v1/images/generations (纯文生图，无参考图)
// =============================================
app.post('/api/generate-scene', async (req, res) => {
    const endpoint = 'generate-scene';
    const { prompt, apiKey, aspect_ratio: reqAspectRatio } = req.body;

    const validKey = apiKey || API_KEY;

    if (!validKey) {
        logRequest(endpoint, '缺少 API Key', 'error');
        return res.status(400).json({
            success: false,
            message: '请在 .env 文件中配置 API_KEY 或在前端输入 API Key'
        });
    }

    if (!prompt) {
        logRequest(endpoint, '缺少 prompt', 'error');
        return res.status(400).json({ success: false, message: '缺少提示词' });
    }

    const aspectRatio = reqAspectRatio || '16:9';

    logRequest(endpoint, '='.repeat(50));
    logRequest(endpoint, `目标URL: https://ai.t8star.cn/v1/images/generations (文生图)`);
    logRequest(endpoint, `模型: nano-banana-2, 比例: ${aspectRatio}`);
    logRequest(endpoint, `提示词: ${prompt.substring(0, 100)}...`);

    try {
        logRequest(endpoint, '⏳ 发送请求到 API...');
        const startTime = Date.now();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

        const response = await fetchWithRetry('https://ai.t8star.cn/v1/images/generations', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${validKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'nano-banana-2',
                prompt: prompt,
                response_format: 'url',
                aspect_ratio: aspectRatio
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        logRequest(endpoint, `API 响应! 耗时: ${elapsed}s, HTTP状态: ${response.status}`, response.ok ? 'success' : 'error');

        if (!response.ok) {
            const errText = await response.text();
            logRequest(endpoint, `API 错误响应: ${errText.substring(0, 500)}`, 'error');
            return res.status(500).json({
                success: false,
                message: `API Error (HTTP ${response.status}): ${errText.substring(0, 300)}`,
                debug: { status_code: response.status, elapsed }
            });
        }

        const data = await response.json();
        const outputImage = data.data?.[0]?.url || data.url;

        logRequest(endpoint, `🎯 生成成功! 图片URL: ${outputImage?.substring(0, 100) || 'NONE'}`, 'success');

        // 异步保存图片到本地
        const localUrl = await saveImageLocally(outputImage, 'scene');

        res.json({
            success: true,
            imageUrl: outputImage,
            localUrl: localUrl,
            debug: { elapsed: parseFloat(elapsed) }
        });
    } catch (error) {
        logRequest(endpoint, `请求异常: ${error.message}`, 'error');
        console.error("Error generating scene:", error);

        if (error.name === 'AbortError') {
            return res.status(500).json({
                success: false,
                message: `请求超时（>${FETCH_TIMEOUT / 1000}秒）`
            });
        }

        res.status(500).json({
            success: false,
            message: `请求失败: ${error.message}`
        });
    }
});

// =============================================
// 场景图生图 (多角度) API
// POST /api/generate-scene-edit
// 下载URL图片 → 发送到 /v1/images/edits (图生图)
// =============================================
app.post('/api/generate-scene-edit', async (req, res) => {
    const endpoint = 'generate-scene-edit';
    const { imageUrl, prompt, apiKey, aspect_ratio: reqAspectRatio } = req.body;

    const validKey = apiKey || API_KEY;

    if (!validKey) {
        logRequest(endpoint, '缺少 API Key', 'error');
        return res.status(400).json({ success: false, message: '缺少 API Key' });
    }
    if (!imageUrl || !prompt) {
        logRequest(endpoint, '缺少 imageUrl 或 prompt', 'error');
        return res.status(400).json({ success: false, message: '缺少图片URL或提示词' });
    }

    const aspectRatio = reqAspectRatio || '16:9';

    logRequest(endpoint, '='.repeat(50));
    logRequest(endpoint, `目标URL: https://ai.t8star.cn/v1/images/edits (图生图)`);
    logRequest(endpoint, `模型: nano-banana-2, 比例: ${aspectRatio}`);
    logRequest(endpoint, `图片源: ${imageUrl.substring(0, 80)}...`);
    logRequest(endpoint, `提示词: ${prompt.substring(0, 80)}...`);

    try {
        logRequest(endpoint, '⏳ 下载源图片...');
        const imgResponse = await fetchWithRetry(imageUrl);
        if (!imgResponse.ok) {
            logRequest(endpoint, `下载图片失败: HTTP ${imgResponse.status}`, 'error');
            return res.status(500).json({ success: false, message: `下载图片失败: HTTP ${imgResponse.status}` });
        }
        const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());
        logRequest(endpoint, `图片大小: ${(imgBuffer.length / 1024).toFixed(1)}KB`);

        logRequest(endpoint, '⏳ 发送请求到 API...');
        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

        const formData = new FormData();
        formData.append('model', 'nano-banana-2');
        formData.append('prompt', prompt);
        formData.append('response_format', 'url');
        formData.append('aspect_ratio', aspectRatio);
        formData.append('image', imgBuffer, { filename: 'scene_ref.png', contentType: 'image/png' });

        const response = await fetchWithRetry('https://ai.t8star.cn/v1/images/edits', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${validKey}`,
                ...formData.getHeaders()
            },
            body: formData,
            signal: controller.signal
        });

        clearTimeout(timeoutId);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        logRequest(endpoint, `API 响应! 耗时: ${elapsed}s, HTTP状态: ${response.status}`, response.ok ? 'success' : 'error');

        if (!response.ok) {
            const errText = await response.text();
            logRequest(endpoint, `API 错误: ${errText.substring(0, 500)}`, 'error');
            return res.status(500).json({ success: false, message: `API Error (HTTP ${response.status}): ${errText.substring(0, 300)}` });
        }

        const data = await response.json();
        const outputImage = data.data?.[0]?.url || data.url;
        logRequest(endpoint, `🎯 生成成功! 图片URL: ${outputImage?.substring(0, 100) || 'NONE'}`, 'success');

        // 异步保存图片到本地
        const localUrl = await saveImageLocally(outputImage, 'multiangle');

        res.json({ success: true, imageUrl: outputImage, localUrl: localUrl, debug: { elapsed: parseFloat(elapsed) } });
    } catch (error) {
        logRequest(endpoint, `请求异常: ${error.message}`, 'error');
        if (error.name === 'AbortError') {
            return res.status(500).json({ success: false, message: `请求超时（>${FETCH_TIMEOUT / 1000}秒）` });
        }
        res.status(500).json({ success: false, message: `请求失败: ${error.message}` });
    }
});
app.post('/api/search-images', (req, res) => {
    const endpoint = 'search-images';
    const { gender, partType, query, subfolder: filterSubfolder, style } = req.body;

    if (!gender || !partType) {
        return res.status(400).json({ success: false, message: '缺少 gender 或 partType 参数' });
    }

    // 根据风格选择对应图片库路径
    const styleCode = style || DEFAULT_STYLE;
    const styleLibPath = getStyleLibraryPath(styleCode);

    // 映射为中文文件夹名
    const genderFolder = gender === 'male' ? '男性' : gender === 'monster' ? '妖兽' : '女性';
    // 妖兽只有 头/服装 两个文件夹，face和hair都映射到 头
    const partTypeFolder = gender === 'monster'
        ? (partType === 'clothes' ? '服装' : '头')
        : ({ face: '脸', halfbody: '半身图', hair: '发型', clothes: '服装' }[partType] || partType);
    let basePath = path.join(styleLibPath, genderFolder, partTypeFolder);

    // 如果指定了子文件夹，直接定位到该子文件夹
    if (filterSubfolder) {
        const specificPath = path.join(basePath, filterSubfolder);
        if (fs.existsSync(specificPath)) {
            basePath = specificPath;
        }
    }

    logRequest(endpoint, `搜索: ${basePath}, 关键词: "${query || '(全部)'}", 子文件夹: "${filterSubfolder || '(全部)'}"`);

    try {
        const images = [];
        const origBasePath = path.join(styleLibPath, genderFolder, partTypeFolder);

        // 递归扫描子文件夹
        const scanDir = (dirPath, subfolder, urlBaseParts) => {
            if (!fs.existsSync(dirPath)) return;
            const items = fs.readdirSync(dirPath);
            for (const item of items) {
                const fullPath = path.join(dirPath, item);
                const stat = fs.statSync(fullPath);

                if (stat.isDirectory()) {
                    scanDir(fullPath, item, urlBaseParts);
                } else if (item.match(/\.(png|jpe?g|webp|gif)$/i)) {
                    // 读取同名 txt 标签
                    const baseName = item.substring(0, item.lastIndexOf('.'));
                    const txtPath = path.join(dirPath, `${baseName}.txt`);
                    let tags = [];
                    if (fs.existsSync(txtPath)) {
                        const txtContent = fs.readFileSync(txtPath, 'utf8').trim();
                        tags = txtContent.split(/[,，、\s]+/).filter(t => t.trim());
                    }

                    // 模糊匹配
                    const q = (query || '').toLowerCase();
                    if (!q ||
                        (subfolder && subfolder.toLowerCase().includes(q)) ||
                        tags.some(t => t.toLowerCase().includes(q)) ||
                        item.toLowerCase().includes(q)) {
                        const relPath = path.relative(urlBaseParts.base, fullPath);
                        images.push({
                            filename: item,
                            url: `/images/${styleCode}/${genderFolder}/${urlBaseParts.prefix}${relPath}`,
                            subfolder: subfolder || filterSubfolder || '',
                            tags
                        });
                    }
                }
            }
        };

        // 扫描直接路径（旧平面结构）
        if (fs.existsSync(basePath)) {
            scanDir(basePath, filterSubfolder || '', { base: origBasePath, prefix: `${partTypeFolder}/` });
        }

        // 2D 风格：额外扫描时代子目录（古代/{partType}、现代/{partType}）
        if (styleCode === '2d' && !filterSubfolder) {
            const eraFolders = ['古代', '现代'];
            for (const era of eraFolders) {
                const eraPartPath = path.join(styleLibPath, genderFolder, era, partTypeFolder);
                if (fs.existsSync(eraPartPath)) {
                    scanDir(eraPartPath, era, { base: eraPartPath, prefix: `${era}/${partTypeFolder}/` });
                }
            }
        }

        logRequest(endpoint, `找到 ${images.length} 张图片`, 'success');
        res.json({ success: true, images });
    } catch (error) {
        logRequest(endpoint, `搜索失败: ${error.message}`, 'error');
        res.status(500).json({ success: false, message: error.message });
    }
});

// =============================================
// 三视图自动匹配 API
// =============================================
app.post('/api/search-three-views', async (req, res) => {
    const endpoint = '/api/search-three-views';
    const { gender, role, keywords } = req.body;

    logRequest(endpoint, `性别=${gender}, 角色=${role}, 关键词=${JSON.stringify(keywords)}`);

    try {
        // 确定搜索文件夹
        const genderFolder = gender === 'male' ? '男性' : '女性';
        const roleFolder = role === 'lead'
            ? (gender === 'male' ? '男主角' : '女主角')
            : (gender === 'male' ? '男配角' : '女配角');

        const searchDir = path.join(getStyleLibraryPath(DEFAULT_STYLE), genderFolder, '三视图', roleFolder);
        logRequest(endpoint, `搜索文件夹路径 ${searchDir} `, 'success');
        if (!fs.existsSync(searchDir)) {
            logRequest(endpoint, `文件夹不存在: ${searchDir}`, 'warn');
            return res.json({ success: true, images: [], message: '三视图文件夹不存在' });
        }

        const files = fs.readdirSync(searchDir);
        const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
        const imageFiles = files.filter(f => imageExts.includes(path.extname(f).toLowerCase()));

        const results = [];

        for (const imgFile of imageFiles) {
            const baseName = imgFile.replace(/\.[^/.]+$/, '');
            const tagFile = path.join(searchDir, baseName + '.txt');

            // 只匹配有 .txt 标签文件的图片
            if (!fs.existsSync(tagFile)) continue;

            const tagContent = fs.readFileSync(tagFile, 'utf-8').trim();
            const tags = tagContent.split(/[，,]/).map(t => t.trim()).filter(Boolean);

            const matchKw = (kw) => tags.some(tag => tag.includes(kw) || kw.includes(tag));

            if (keywords && keywords.length > 0) {
                // ===== 必须匹配的维度（全部通过才推荐）=====
                // 维度1: 年龄段必须匹配
                const ageKeywords = keywords.filter(kw => /\d+-\d+/.test(kw));
                const ageMatched = ageKeywords.length === 0 || ageKeywords.some(kw => matchKw(kw));

                // 维度2: 时代/风格必须匹配（古装 or 现代）
                const eraKeywords = keywords.filter(kw =>
                    ['古风', '古装', '现代', '仙侠', '武侠', '赛博朋克', '校园', '军装', '奇幻', '哥特', '洛丽塔',
                        '道袍', '汉服', '盔甲', '制服', '仙'].includes(kw));
                const eraMatched = eraKeywords.length === 0 || eraKeywords.some(kw => matchKw(kw));

                // 必须同时满足年龄和时代匹配
                if (!ageMatched || !eraMatched) continue;

                // ===== 排序分数（P3 脸型+发型 ×3，P4 其他 ×1）=====
                let matchScore = 0;
                const matchedTags = [];

                // 记录匹配的必要维度
                ageKeywords.filter(kw => matchKw(kw)).forEach(kw => matchedTags.push(`[年龄]${kw}`));
                eraKeywords.filter(kw => matchKw(kw)).forEach(kw => matchedTags.push(`[风格]${kw}`));

                // P3: 脸型 + 发型 (权重 ×3)
                const p3Keywords = keywords.filter(kw =>
                    ['圆脸', '鹅蛋脸', '瓜子脸', '方脸', '长脸', '心形脸', '菱形脸', '国字脸',
                        '长发', '短发', '中长发', '直发', '卷发', '波浪', '马尾', '双马尾', '丸子头',
                        '编发', '盘发', '齐刘海', '斜刘海', '空气刘海',
                        '黑发', '棕发', '金发', '银发', '红发', '白发'].includes(kw));
                for (const kw of p3Keywords) {
                    if (matchKw(kw)) { matchScore += 3; matchedTags.push(`[脸型/发型]${kw}`); }
                }

                // P4: 其他所有标签 (权重 ×1)
                const usedKws = new Set([...ageKeywords, ...eraKeywords, ...p3Keywords]);
                const p4Keywords = keywords.filter(kw => !usedKws.has(kw));
                for (const kw of p4Keywords) {
                    if (matchKw(kw)) { matchScore += 1; matchedTags.push(kw); }
                }

                const imgUrl = `/images/${genderFolder}/三视图/${roleFolder}/${encodeURIComponent(imgFile)}`;
                results.push({
                    url: imgUrl,
                    filename: imgFile,
                    tags: tags.join('，'),
                    hasTagFile: true,
                    matchScore,
                    matchedTags
                });
            }
        }

        // 按匹配分数降序排列
        results.sort((a, b) => b.matchScore - a.matchScore);

        logRequest(endpoint, `找到 ${results.length} 张已打标三视图`, 'success');
        res.json({ success: true, images: results });
    } catch (error) {
        logRequest(endpoint, `搜索失败: ${error.message}`, 'error');
        res.status(500).json({ success: false, message: error.message });
    }
});

// =============================================
// 图片本地保存功能
// =============================================
// 优先使用 Electron 传入的可写目录（打包后 __dirname 在 asar 内部不可写）
const GENERATED_IMAGES_DIR = process.env.GENERATED_IMAGES_DIR || path.join(__dirname, 'generated_images');
if (!fs.existsSync(GENERATED_IMAGES_DIR)) {
    fs.mkdirSync(GENERATED_IMAGES_DIR, { recursive: true });
}
const DEBUG_RECORDS_DIR = path.join(GENERATED_IMAGES_DIR, '_debug');
if (!fs.existsSync(DEBUG_RECORDS_DIR)) {
    fs.mkdirSync(DEBUG_RECORDS_DIR, { recursive: true });
}
// 提供保存的图片静态访问
app.use('/generated_images', express.static(GENERATED_IMAGES_DIR));

function ensureDebugRecordsDir() {
    if (!fs.existsSync(DEBUG_RECORDS_DIR)) {
        fs.mkdirSync(DEBUG_RECORDS_DIR, { recursive: true });
    }
}

function sanitizeDebugPrefix(value) {
    return String(value || '')
        .trim()
        .replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'debug';
}

function appendDebugRecord(recordName, payload) {
    ensureDebugRecordsDir();
    const safeName = sanitizeDebugPrefix(recordName || 'debug_record');
    const filename = `${safeName}.jsonl`;
    const filepath = path.join(DEBUG_RECORDS_DIR, filename);
    const line = JSON.stringify({
        recordedAt: new Date().toISOString(),
        ...payload
    }, null, 0) + '\n';
    fs.appendFileSync(filepath, line, 'utf8');
    return `/generated_images/_debug/${filename}`;
}

function decodeIncomingImageInput(input) {
    if (!input || typeof input !== 'string') return null;

    if (input.startsWith('data:image/')) {
        const match = input.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) return null;
        const ext = match[1] === 'jpeg' ? '.jpg' : `.${match[1]}`;
        return {
            ext,
            buffer: Buffer.from(match[2], 'base64')
        };
    }

    return {
        ext: '.png',
        buffer: Buffer.from(input, 'base64')
    };
}

function saveIncomingImageBuffer(buffer, prefix = 'incoming_image', ext = '.png') {
    if (!buffer) return null;
    ensureDebugRecordsDir();
    const safePrefix = sanitizeDebugPrefix(prefix || 'incoming_image');
    const timestamp = Date.now();
    const filename = `${safePrefix}_${timestamp}${ext.startsWith('.') ? ext : `.${ext}`}`;
    const filepath = path.join(DEBUG_RECORDS_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    return {
        filename,
        filepath,
        localUrl: `/generated_images/_debug/${filename}`,
        sizeKB: Number((buffer.length / 1024).toFixed(1))
    };
}

async function saveGenerateImageRequestInputs({ endpoint, mode, image, face, hair, clothes, prompt, aspectRatio }) {
    const savedInputs = [];
    const entries = image
        ? [{ key: 'image', value: image }]
        : [
            { key: 'face', value: face },
            { key: 'hair', value: hair },
            { key: 'clothes', value: clothes }
        ].filter(item => item.value);

    for (const entry of entries) {
        const decoded = decodeIncomingImageInput(entry.value);
        if (!decoded) {
            logRequest(endpoint, `收到的 ${entry.key} 不是可保存的 base64 图片`, 'warn');
            continue;
        }

        const saved = saveIncomingImageBuffer(decoded.buffer, `${endpoint}_${mode}_${entry.key}`, decoded.ext);
        if (!saved) continue;

        savedInputs.push({
            type: entry.key,
            localUrl: saved.localUrl,
            filename: saved.filename,
            sizeKB: saved.sizeKB
        });
        logRequest(endpoint, `已保存收到的 ${entry.key}: ${saved.localUrl} (${saved.sizeKB}KB)`);
    }

    const debugRecordFile = appendDebugRecord('generate_image_request_inputs', {
        mode,
        aspectRatio,
        prompt,
        inputs: savedInputs
    });
    logRequest(endpoint, `输入调试记录已追加: ${debugRecordFile}`);

    return { savedInputs, debugRecordFile };
}

/**
 * 下载远程图片并保存到本地
 * @returns {string|null} 本地可访问的URL
 */
async function saveImageLocally(imageUrl, prefix = 'img') {
    try {
        if (!imageUrl || imageUrl.startsWith('data:')) return null;
        const timestamp = Date.now();
        const ext = (imageUrl.match(/\.(png|jpg|jpeg|webp)/i) || ['.png'])[0] || '.png';
        const filename = `${prefix}_${timestamp}${ext.startsWith('.') ? ext : '.' + ext}`;
        const filepath = path.join(GENERATED_IMAGES_DIR, filename);

        const response = await fetchWithRetry(imageUrl);
        if (!response.ok) return null;
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(filepath, buffer);
        console.log(`💾 图片已保存: ${filename} (${(buffer.length / 1024).toFixed(1)}KB)`);
        return `/generated_images/${filename}`;
    } catch (err) {
        console.error('保存图片失败:', err.message);
        return null;
    }
}

// POST /api/save-image - 手动保存远程图片到本地
app.post('/api/save-image', async (req, res) => {
    const { imageUrl, prefix } = req.body;
    if (!imageUrl) return res.status(400).json({ success: false, message: '缺少 imageUrl' });
    const localUrl = await saveImageLocally(imageUrl, prefix || 'saved');
    if (localUrl) {
        res.json({ success: true, localUrl });
    } else {
        res.status(500).json({ success: false, message: '保存失败' });
    }
});

// POST /api/save-base64 - 保存 base64 图片到本地
app.post('/api/save-base64', (req, res) => {
    try {
        const { data, prefix, metadata, recordName } = req.body;
        if (!data) return res.status(400).json({ success: false, message: '缺少 data' });
        // 去掉 data:image/png;base64, 前缀
        const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const timestamp = Date.now();
        const filename = `${sanitizeDebugPrefix(prefix || 'combined')}_${timestamp}.png`;
        const filepath = path.join(GENERATED_IMAGES_DIR, filename);
        fs.writeFileSync(filepath, buffer);
        console.log(`💾 Base64图片已保存: ${filename} (${(buffer.length / 1024).toFixed(1)}KB)`);
        const localUrl = `/generated_images/${filename}`;
        let recordFile = null;
        if (recordName || metadata) {
            recordFile = appendDebugRecord(recordName || 'base64_debug', {
                filename,
                localUrl,
                sizeKB: Number((buffer.length / 1024).toFixed(1)),
                metadata: metadata || {}
            });
            console.log(`📝 调试记录已追加: ${recordFile}`);
        }
        res.json({ success: true, localUrl, filename, recordFile });
    } catch (err) {
        console.error('保存base64图片失败:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// =============================================
// 向量数据库 API — CLIP 图文跨模态匹配
// =============================================

// 构建/重建向量索引
app.post('/api/vector/build', async (req, res) => {
    const endpoint = 'vector/build';
    const { gender, partType, style } = req.body; // 可选，不传则全量构建

    logRequest(endpoint, `开始构建索引 gender=${gender || '全部'}, partType=${partType || '全部'}, style=${style || '全部'}`);

    try {
        // 先检查 CLIP 服务
        const clipOk = await checkClipHealth();
        if (!clipOk) {
            logRequest(endpoint, 'JS CLIP 运行时不可用', 'error');
            return res.status(503).json({
                success: false,
                message: 'JS CLIP 运行时不可用，请检查模型下载或缓存目录'
            });
        }

        let stats = {};

        // 确定要构建的风格列表
        const stylesToBuild = style
            ? [style]
            : Object.keys(STYLE_FOLDER_MAP); // 全部风格: ['real', '2d', '3d']

        for (const styleCode of stylesToBuild) {
            const styleLibPath = getStyleLibraryPath(styleCode);
            if (!fs.existsSync(styleLibPath)) {
                logRequest(endpoint, `风格文件夹不存在: ${styleLibPath}`, 'warn');
                continue;
            }

            if (gender && partType) {
                const result = await buildIndex(styleLibPath, gender, partType, (msg) => {
                    logRequest(endpoint, msg);
                }, styleCode);
                stats[`${styleCode}/${gender}/${partType}`] = result;
            } else {
                const styleStats = await buildAllIndexes(styleLibPath, (msg) => {
                    logRequest(endpoint, msg);
                }, styleCode);
                Object.entries(styleStats).forEach(([key, val]) => {
                    stats[`${styleCode}/${key}`] = val;
                });
                // 同时构建场景索引
                try {
                    const sceneResult = await buildSceneIndex(styleLibPath, (msg) => {
                        logRequest(endpoint, msg);
                    });
                    stats[`${styleCode}/scene`] = sceneResult;
                } catch (sceneErr) {
                    stats[`${styleCode}/scene`] = { error: sceneErr.message };
                }
            }
        }

        logRequest(endpoint, `索引构建完成`, 'success');
        res.json({ success: true, stats });
    } catch (error) {
        logRequest(endpoint, `构建失败: ${error.message}`, 'error');
        res.status(500).json({ success: false, message: error.message });
    }
});

// 语义搜索
app.post('/api/vector/search', async (req, res) => {
    const endpoint = 'vector/search';
    const { query, gender, partType, topK } = req.body;

    if (!query || !gender || !partType) {
        return res.status(400).json({ success: false, message: '缺少 query/gender/partType 参数' });
    }

    logRequest(endpoint, `搜索: "${query}" in ${gender}/${partType}`);

    try {
        const clipOk = await checkClipHealth();
        if (!clipOk) {
            return res.status(503).json({ success: false, message: 'JS CLIP 运行时不可用' });
        }

        const results = await search(query, gender, partType, topK || 5);
        logRequest(endpoint, `找到 ${results.length} 个匹配`, 'success');
        res.json({ success: true, results });
    } catch (error) {
        logRequest(endpoint, `搜索失败: ${error.message}`, 'error');
        res.status(500).json({ success: false, message: error.message });
    }
});

// 自动匹配：输入角色信息，返回脸/发型/服装/三视图各 Top-K
app.post('/api/vector/auto-match', async (req, res) => {
    const endpoint = 'vector/auto-match';
    const { character, topK } = req.body;

    if (!character) {
        return res.status(400).json({ success: false, message: '缺少 character 参数' });
    }

    // 根据风格选择对应的图片库路径
    const styleCode = character.style || DEFAULT_STYLE;
    const styleLibPath = getStyleLibraryPath(styleCode);
    const styleFolderName = STYLE_FOLDER_MAP[styleCode] || STYLE_FOLDER_MAP[DEFAULT_STYLE];

    logRequest(endpoint, `自动匹配角色: ${character.name || '未知'}, 风格: ${styleCode} → ${styleFolderName}`);

    try {
        const clipOk = await checkClipHealth();
        if (!clipOk) {
            return res.status(503).json({ success: false, message: 'JS CLIP 运行时不可用' });
        }

        const result = await autoMatch(character, topK || 3, { imageLibPath: styleLibPath, stylePrefix: styleCode });
        logRequest(endpoint, `匹配完成: 脸${result.face.length} 发${result.hair.length} 服${result.clothes.length} 三视图${result.threeview.length} 半身图${result.halfbody.length}`, 'success');
        res.json({ success: true, ...result });
    } catch (error) {
        logRequest(endpoint, `匹配失败: ${error.message}`, 'error');
        res.status(500).json({ success: false, message: error.message });
    }
});

const ANIME_FACE_FOLDER_MAP = {
    male: {
        ancient: { lead: '二次元古代男主角', support: '二次元古代男配角' },
        modern: { lead: '二次元现代男主角', support: '二次元现代男配角' }
    },
    female: {
        ancient: { lead: '二次元古代女主角', support: '二次元古代女配角' },
        modern: { lead: '二次元现代女主角', support: '二次元现代女配角' }
    }
};

function inferAnimeEra(text = '') {
    const source = String(text || '');
    if (/古装|古代|古风|汉服|仙侠|修仙|宗门|门派|朝堂|宫廷|侠客|江湖/.test(source)) return 'ancient';
    if (/现代|都市|校园|职场|西装|制服|婚礼|医院|军嫂|军属|警察|公寓|总裁/.test(source)) return 'modern';
    return '';
}

function inferAnimeRole(character = {}) {
    const source = [
        character.preferred_face_folder,
        character.original_text,
        character.face_description,
        character.name
    ].filter(Boolean).join('，');
    return /主角|男主|女主|主咖/.test(source) ? 'lead' : 'support';
}

function getAnimeFaceFolder(character = {}) {
    const genderKey = String(character.gender || '').includes('男') ? 'male' : 'female';
    const roleKey = inferAnimeRole(character);
    const eraKey = inferAnimeEra([
        character.clothing_description,
        character.original_text,
        character.face_description
    ].filter(Boolean).join('，')) || 'ancient';

    return {
        genderKey,
        roleKey,
        eraKey,
        folderName: ANIME_FACE_FOLDER_MAP[genderKey]?.[eraKey]?.[roleKey] || ''
    };
}

function readAnimeFaceCandidates(genderKey, folderName) {
    const genderFolder = genderKey === 'male' ? '男性' : genderKey === 'monster' ? '妖兽' : '女性';
    const halfbodyBasePath = path.join(getStyleLibraryPath(DEFAULT_STYLE), genderFolder, '半身图');
    if (!fs.existsSync(halfbodyBasePath)) return [];

    const targetFolders = folderName
        ? [folderName]
        : fs.readdirSync(halfbodyBasePath).filter(name => name.startsWith('二次元'));

    const candidates = [];
    for (const subfolder of targetFolders) {
        const folderPath = path.join(halfbodyBasePath, subfolder);
        if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) continue;

        const files = fs.readdirSync(folderPath)
            .filter(name => /\.(png|jpe?g|webp|gif)$/i.test(name))
            .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

        for (const filename of files) {
            const fullPath = path.join(folderPath, filename);
            const baseName = path.basename(filename, path.extname(filename));
            const txtPath = path.join(folderPath, `${baseName}.txt`);
            let tags = [];

            if (fs.existsSync(txtPath)) {
                const content = fs.readFileSync(txtPath, 'utf8').trim();
                tags = content.split(/[,，、\s]+/).filter(Boolean);
            }

            const relPath = path.relative(halfbodyBasePath, fullPath).split(path.sep).join('/');
            candidates.push({
                filename,
                subfolder,
                tags,
                url: `/images/${genderFolder}/半身图/${relPath.split('/').map(part => encodeURIComponent(part)).join('/')}`
            });
        }
    }

    return candidates;
}

function scoreAnimeFaceCandidate(candidate, character = {}, folderName = '') {
    const text = [
        character.name,
        character.age,
        character.face_description,
        character.original_text,
        character.clothing_description
    ].filter(Boolean).join('，');

    let score = 0;
    const lowerText = text.toLowerCase();
    const lowerFile = String(candidate.filename || '').toLowerCase();

    if (folderName && candidate.subfolder === folderName) score += 6;
    if (/古代|古装|古风|仙侠|修仙/.test(text) && candidate.subfolder.includes('古代')) score += 2;
    if (/现代|都市|校园|职场|婚礼|医院|军嫂|警察/.test(text) && candidate.subfolder.includes('现代')) score += 2;
    if (/主角|男主|女主/.test(text) && candidate.subfolder.includes('主角')) score += 2;
    if (/配角|男配|女配/.test(text) && candidate.subfolder.includes('配角')) score += 2;

    for (const tag of candidate.tags || []) {
        const token = String(tag).toLowerCase();
        if (token && lowerText.includes(token)) score += 1;
    }

    const baseName = lowerFile.replace(/\.(png|jpe?g|webp|gif)$/i, '');
    if (baseName && lowerText.includes(baseName)) score += 3;

    return score;
}

function uniqueAnimeFaceResults(items = []) {
    const seen = new Set();
    const unique = [];

    for (const item of items) {
        const subfolder = String(item.subfolder || '').toLowerCase();
        const normalizedUrl = decodeURIComponent(String(item.url || '').split('?')[0])
            .replace(/^https?:\/\/[^/]+/i, '')
            .replace(/\\/g, '/')
            .toLowerCase();
        const source = String(item.filename || item.id || item.url || '');
        const baseName = path.basename(decodeURIComponent(source), path.extname(source)).toLowerCase();
        const dedupeKey = normalizedUrl || `${subfolder}::${baseName || source.toLowerCase()}`;

        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        unique.push(item);
    }

    return unique;
}

app.post('/api/vector/anime-face-examples', async (req, res) => {
    const endpoint = 'vector/anime-face-examples';
    const { character, topK } = req.body;

    if (!character) {
        return res.status(400).json({ success: false, message: '缺少 character 参数' });
    }

    const limit = Math.max(1, Math.min(parseInt(topK, 10) || 6, 12));
    const { genderKey, folderName } = getAnimeFaceFolder(character);
    const animeFolderPrefix = '二次元';
    const queryText = [
        character.name,
        character.age,
        character.face_description,
        character.original_text,
        'anime character half body portrait, 2d illustration'
    ].filter(Boolean).join(', ');

    logRequest(endpoint, `二次元半身图示例: ${character.name || '未知'} → ${folderName || '全部二次元半身图'}`);

    try {
        let results = [];
        const clipOk = await checkClipHealth();

        if (clipOk) {
            const searchResults = await search(queryText, genderKey, 'halfbody', limit * 3, {
                styleFilter: '2d',
                preferredSubfolder: folderName || '',
                keywordHints: []
            });

            results = searchResults.filter(item => {
                const subfolder = String(item.subfolder || '');
                const styleOk = item.style === '2d';
                const folderOk = folderName ? subfolder === folderName : subfolder.includes(animeFolderPrefix);
                return styleOk && folderOk;
            }).slice(0, limit);

            if (results.length === 0 && folderName) {
                const broadResults = await search(queryText, genderKey, 'halfbody', limit * 3, {
                    styleFilter: '2d',
                    preferredSubfolder: '',
                    keywordHints: []
                });

                results = broadResults.filter(item => {
                    const subfolder = String(item.subfolder || '');
                    return item.style === '2d' && subfolder.includes(animeFolderPrefix);
                });
            }
        }

        if (results.length > 0) {
            results = uniqueAnimeFaceResults(results).slice(0, limit);
            logRequest(endpoint, `向量命中 ${results.length} 张`, 'success');
            return res.json({
                success: true,
                source: 'vector',
                folderLabel: folderName || '二次元半身图',
                results
            });
        }

        let fallbackCandidates = readAnimeFaceCandidates(genderKey, folderName);
        if (fallbackCandidates.length === 0 && folderName) {
            fallbackCandidates = readAnimeFaceCandidates(genderKey, '');
        }

        const fallback = uniqueAnimeFaceResults(fallbackCandidates
            .map(item => ({
                ...item,
                score: scoreAnimeFaceCandidate(item, character, folderName)
            }))
            .sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename, 'zh-Hans-CN'))
        ).slice(0, limit);

        logRequest(endpoint, `回退目录匹配 ${fallback.length} 张`, fallback.length > 0 ? 'success' : 'warn');
        res.json({
            success: true,
            source: 'fallback',
            folderLabel: folderName || '二次元半身图',
            results: fallback
        });
    } catch (error) {
        logRequest(endpoint, `匹配失败: ${error.message}`, 'error');
        res.status(500).json({ success: false, message: error.message });
    }
});

// 索引状态
app.get('/api/vector/status', async (req, res) => {
    try {
        const clipOk = await checkClipHealth();
        const status = getStatus();
        res.json({ success: true, clipServiceAvailable: clipOk, indexes: status });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 场景匹配
app.post('/api/vector/scene-match', async (req, res) => {
    const endpoint = 'vector/scene-match';
    const { text, style, topK } = req.body;

    if (!text) {
        return res.status(400).json({ success: false, message: '缺少 text 参数' });
    }

    logRequest(endpoint, `场景匹配: "${text.substring(0, 60)}..." style=${style || '不限'}`);

    try {
        const clipOk = await checkClipHealth();
        if (!clipOk) {
            return res.status(503).json({ success: false, message: 'JS CLIP 运行时不可用' });
        }

        const results = await autoMatchScene(text, { style: style || null, topK: topK || 5 });
        logRequest(endpoint, `找到 ${results.length} 个匹配`, 'success');
        res.json({ success: true, results });
    } catch (error) {
        logRequest(endpoint, `匹配失败: ${error.message}`, 'error');
        res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/browse-three-views', (req, res) => {
// (app.listen 已移至文件末尾)
    const endpoint = '/api/browse-three-views';
    const { gender, role, query } = req.body;

    logRequest(endpoint, `性别=${gender}, 角色=${role}, 搜索=${query || '(全部)'}`);

    try {
        const genderFolder = gender === 'male' ? '男性' : '女性';
        const roleFolder = role === 'lead'
            ? (gender === 'male' ? '男主角' : '女主角')
            : (gender === 'male' ? '男配角' : '女配角');

        const searchDir = path.join(getStyleLibraryPath(DEFAULT_STYLE), genderFolder, '三视图', roleFolder);

        if (!fs.existsSync(searchDir)) {
            logRequest(endpoint, `文件夹不存在: ${searchDir}`, 'warn');
            return res.json({ success: true, images: [], folderPath: `${genderFolder}/三视图/${roleFolder}` });
        }

        const files = fs.readdirSync(searchDir);
        const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
        const imageFiles = files.filter(f => imageExts.includes(path.extname(f).toLowerCase()));

        const results = [];
        const q = (query || '').toLowerCase().trim();

        for (const imgFile of imageFiles) {
            const baseName = imgFile.replace(/\.[^/.]+$/, '');
            const tagFile = path.join(searchDir, baseName + '.txt');

            let tags = [];
            let hasTagFile = false;

            if (fs.existsSync(tagFile)) {
                hasTagFile = true;
                const tagContent = fs.readFileSync(tagFile, 'utf-8').trim();
                tags = tagContent.split(/[，,]/).map(t => t.trim()).filter(Boolean);
            }

            // 如果有搜索关键词，过滤
            if (q) {
                const matchFile = imgFile.toLowerCase().includes(q);
                const matchTag = tags.some(t => t.toLowerCase().includes(q));
                const matchFolder = roleFolder.toLowerCase().includes(q);
                if (!matchFile && !matchTag && !matchFolder) continue;
            }

            const imgUrl = `/images/${genderFolder}/三视图/${roleFolder}/${encodeURIComponent(imgFile)}`;
            results.push({
                url: imgUrl,
                filename: imgFile,
                tags: tags.join('，'),
                hasTagFile
            });
        }

        logRequest(endpoint, `找到 ${results.length} 张图片`, 'success');
        res.json({ success: true, images: results, folderPath: `${genderFolder}/三视图/${roleFolder}` });
    } catch (error) {
        logRequest(endpoint, `浏览失败: ${error.message}`, 'error');
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── 启动服务器（必须在所有路由注册完毕后）─────────────
process.on('uncaughtException', (err) => {
    console.error('💥 未捕获异常:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 未处理的 Promise 拒绝:', reason);
});
app.listen(PORT, () => {
    console.log('');
    console.log('═'.repeat(50));
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📡 API Base URL: ${API_BASE_URL}`);
    console.log(`📂 Image Library: ${IMAGE_LIBRARY_PATH}`);
    console.log(`💾 Generated Images: ${GENERATED_IMAGES_DIR}`);
    console.log('═'.repeat(50));
    console.log('');

    if (process.env.PRELOAD_CLIP_MODEL !== '0') {
        setImmediate(async () => {
            try {
                console.log('🧠 后台预热 JS CLIP 模型...');
                await preloadClipModel();
            } catch (error) {
                console.error(`⚠️  JS CLIP 预热失败: ${error.message}`);
            }
        });
    }
});

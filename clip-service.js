import fs from 'fs';
import path from 'path';
import {
    env,
    AutoProcessor,
    AutoTokenizer,
    CLIPTextModelWithProjection,
    CLIPVisionModelWithProjection,
    RawImage
} from '@huggingface/transformers';

const MODEL_NAME = process.env.CLIP_MODEL_NAME || 'Xenova/clip-vit-base-patch32';
const REMOTE_HOST = normalizeRemoteHost(process.env.HF_ENDPOINT || 'https://hf-mirror.com');
const CACHE_DIR = process.env.CLIP_CACHE_DIR || path.join(process.cwd(), '.cache', 'clip');

env.allowRemoteModels = true;
env.allowLocalModels = true;
env.remoteHost = REMOTE_HOST;
env.cacheDir = CACHE_DIR;

// 如果模型已经在本地缓存（打包模式），禁用远程下载避免网络失败
const cachedModelCheck = path.join(CACHE_DIR, MODEL_NAME, 'onnx', 'text_model.onnx');
if (fs.existsSync(cachedModelCheck)) {
    env.allowRemoteModels = false;
    console.log(`📦 CLIP 模型已在本地缓存，跳过远程下载: ${CACHE_DIR}`);
} else {
    console.log(`🌐 CLIP 模型未缓存，将从远程下载: ${REMOTE_HOST}`);
}

let tokenizer = null;
let processor = null;
let textModel = null;
let visionModel = null;
let loadPromise = null;
let lastLoadError = null;

function normalizeRemoteHost(value) {
    const base = String(value || '').trim() || 'https://hf-mirror.com';
    if (/^https?:\/\//i.test(base)) {
        return base.endsWith('/') ? base : `${base}/`;
    }
    return `https://${base.replace(/\/+$/, '')}/`;
}

function ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

function isModelReady() {
    return !!(tokenizer && processor && textModel && visionModel);
}

function vectorFromTensor(tensor) {
    const values = Array.from(tensor.data, (value) => Number(value));
    let norm = 0;
    for (const value of values) {
        norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    return values.map((value) => value / norm);
}

async function embedImageWithLoadedModel(imagePath) {
    const image = await RawImage.read(imagePath);
    const imageInputs = await processor(image);
    const { image_embeds } = await visionModel(imageInputs);
    return vectorFromTensor(image_embeds);
}

export async function preloadClipModel() {
    if (isModelReady()) {
        return {
            model: MODEL_NAME,
            cacheDir: CACHE_DIR
        };
    }

    if (loadPromise) {
        return loadPromise;
    }

    loadPromise = (async () => {
        ensureCacheDir();
        lastLoadError = null;

        const startedAt = Date.now();
        console.log(`🧠 正在加载 JS CLIP 模型: ${MODEL_NAME}`);
        console.log(`   模型源: ${REMOTE_HOST}`);
        console.log(`   缓存目录: ${CACHE_DIR}`);

        tokenizer = await AutoTokenizer.from_pretrained(MODEL_NAME);
        processor = await AutoProcessor.from_pretrained(MODEL_NAME);
        textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL_NAME);
        visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_NAME);

        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`✅ JS CLIP 模型加载完成，耗时 ${elapsed}s`);

        return {
            model: MODEL_NAME,
            cacheDir: CACHE_DIR
        };
    })().catch((error) => {
        tokenizer = null;
        processor = null;
        textModel = null;
        visionModel = null;
        lastLoadError = error;
        throw error;
    }).finally(() => {
        loadPromise = null;
    });

    return loadPromise;
}

export async function getClipHealth() {
    return {
        status: lastLoadError ? 'error' : 'ok',
        runtime: 'node',
        model: MODEL_NAME,
        remote_host: REMOTE_HOST,
        cache_dir: CACHE_DIR,
        model_loaded: isModelReady(),
        last_error: lastLoadError ? lastLoadError.message : null
    };
}

export async function embedText(text) {
    if (!text) {
        throw new Error('缺少 text 参数');
    }

    await preloadClipModel();
    const textInputs = tokenizer([text], { padding: true, truncation: true });
    const { text_embeds } = await textModel(textInputs);
    return vectorFromTensor(text_embeds);
}

export async function embedImage(imagePath) {
    if (!imagePath) {
        throw new Error('缺少 path 参数');
    }
    if (!fs.existsSync(imagePath)) {
        throw new Error(`图片不存在: ${imagePath}`);
    }

    await preloadClipModel();
    return embedImageWithLoadedModel(imagePath);
}

export async function batchEmbedImages(paths = []) {
    if (!Array.isArray(paths) || paths.length === 0) {
        throw new Error('缺少 paths 参数');
    }

    await preloadClipModel();

    const results = [];
    let successCount = 0;

    for (let i = 0; i < paths.length; i += 1) {
        const imagePath = paths[i];

        try {
            if (!fs.existsSync(imagePath)) {
                results.push({ path: imagePath, ok: false, error: '文件不存在' });
                continue;
            }

            const vector = await embedImageWithLoadedModel(imagePath);
            results.push({ path: imagePath, vector, ok: true });
            successCount += 1;

            if ((i + 1) % 10 === 0) {
                console.log(`  📸 JS CLIP 编码进度: ${i + 1}/${paths.length}`);
            }
        } catch (error) {
            results.push({ path: imagePath, ok: false, error: error.message });
        }
    }

    console.log(`✅ JS CLIP 批量编码完成: ${successCount}/${paths.length} 成功`);
    return {
        results,
        total: paths.length,
        success: successCount
    };
}

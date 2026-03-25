/**
 * vector-db.js — 向量数据库引擎
 *
 * 负责：
 * - 调用 CLIP 服务获取图片/文本向量
 * - 按 gender/partType 分区管理索引（JSON 持久化）
 * - 余弦相似度 Top-K 检索
 * - 增量更新
 * - 风格分类（真人/3D/2D）
 * - 场景图片索引与匹配
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { batchEmbedImages, embedImage, embedText, getClipHealth } from './clip-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_DIR = process.env.VECTOR_INDEX_DIR || path.join(__dirname, 'vector-index');

// 确保索引目录存在（仅在非 asar 环境下创建，打包后由 electron-main.cjs 通过环境变量指定可写路径）
if (!fs.existsSync(INDEX_DIR)) {
    try {
        fs.mkdirSync(INDEX_DIR, { recursive: true });
    } catch(e) {
        console.warn('⚠️ 无法创建索引目录:', INDEX_DIR, e.message);
    }
}

// ── 工具函数 ──────────────────────────────────────

/** 余弦相似度 */
function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

/** 获取索引文件路径，支持风格前缀 */
function getIndexPath(gender, partType, stylePrefix) {
    const prefix = stylePrefix ? `${stylePrefix}_` : '';
    return path.join(INDEX_DIR, `${prefix}${gender}_${partType}.json`);
}

/** 加载索引 */
function loadIndex(gender, partType, stylePrefix) {
    const p = getIndexPath(gender, partType, stylePrefix);
    if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
    return { version: 1, dimension: 512, items: [] };
}

/** 保存索引 */
function saveIndex(gender, partType, index, stylePrefix) {
    const p = getIndexPath(gender, partType, stylePrefix);
    fs.writeFileSync(p, JSON.stringify(index, null, 2), 'utf-8');
}

function uniqueValues(values) {
    return [...new Set((values || []).filter(Boolean))];
}

function splitTagText(text) {
    return uniqueValues(String(text || '')
        .split(/[\s,，、;；|]+/)
        .map(token => token.trim())
        .filter(Boolean));
}

function normalizeRelativePath(relPath) {
    return String(relPath || '').replace(/\\/g, '/');
}

function getEffectiveSubfolder(item) {
    const relPath = normalizeRelativePath(item?.relativePath);
    const relDir = relPath ? path.posix.dirname(relPath) : '.';
    if (relDir && relDir !== '.') return relDir;
    return normalizeRelativePath(item?.subfolder || '');
}

function keywordMatches(keyword, token) {
    const a = String(keyword || '').trim().toLowerCase();
    const b = String(token || '').trim().toLowerCase();
    if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
}

function inferAgeBucket(text) {
    const source = String(text || '');
    if (!source) return null;

    if (/幼儿|婴儿|孩童|儿童|小孩|稚童|toddler|child/.test(source)) return 'child';
    if (/少年|少女|青少年|teen|十二三岁|十四五岁|十五六岁|1[2-7]岁/.test(source)) return 'teen';
    if (/青年|年轻|二十|20岁|18岁|19岁|2[0-9]岁|20-29|20~29|20到29|20至29/.test(source)) return 'young_adult';
    if (/三十|30岁|3[0-9]岁|30-39|30~39|30到39|30至39/.test(source)) return 'adult_30s';
    if (/中年|四十|五十|40岁|50岁|4[0-9]岁|5[0-9]岁|40-59|40~59|40到59|40至59/.test(source)) return 'middle_aged';
    if (/老年|老人|老者|六十|七十|60岁|70岁|[6-9][0-9]岁|elderly/.test(source)) return 'elderly';

    return null;
}

function inferRoleHint(text) {
    const source = String(text || '');
    if (!source) return null;
    if (/主角|男主|女主|主咖|主角团/.test(source)) return 'lead';
    if (/配角|男配|女配/.test(source)) return 'support';
    return null;
}

function inferEraHint(text) {
    const source = String(text || '');
    if (!source) return null;
    if (/古代|古风|古装|汉服|仙侠|武侠|修仙|宗门|门派/.test(source)) return 'ancient';
    if (/现代|都市|校园|西装|城市|办公|公寓/.test(source)) return 'modern';
    return null;
}

function inferStyleHint(text) {
    const source = String(text || '');
    if (!source) return null;
    if (/写实|真实|摄影|照片|真人/.test(source)) return 'real';
    if (/3[dD]|三维|CG|渲染/.test(source)) return '3d';
    if (/2[dD]|二次元|动漫|漫画|卡通|插画/.test(source)) return '2d';
    return null;
}

function inferGenderHint(text) {
    const source = String(text || '');
    if (!source) return null;
    if (/男性|男主|男配|男/.test(source)) return 'male';
    if (/女性|女主|女配|女/.test(source)) return 'female';
    return null;
}

function extractKeywordHintsFromText(text) {
    const source = String(text || '');
    if (!source) return [];

    const mappedKeywords = Object.keys(ZH_EN_MAP || {})
        .filter(keyword => keyword.length > 1 && source.includes(keyword));
    const rawTokens = splitTagText(source).filter(token => token.length > 1);

    return uniqueValues([...mappedKeywords, ...rawTokens]);
}

function buildTagMetadata(tags, subfolder, partType) {
    const subfolderText = normalizeRelativePath(subfolder).replace(/\//g, ' ');
    const baseText = [tags, subfolderText, partType].filter(Boolean).join('，');
    const tokens = uniqueValues([
        ...splitTagText(tags),
        ...splitTagText(subfolderText),
        ...extractKeywordHintsFromText(baseText)
    ]);

    return {
        tokens,
        ageBucket: inferAgeBucket(baseText),
        role: inferRoleHint(baseText),
        era: inferEraHint(baseText),
        styleHint: inferStyleHint(baseText),
        genderHint: inferGenderHint(baseText)
    };
}

function subfolderMatches(subfolder, preferredSubfolder) {
    const current = normalizeRelativePath(subfolder).toLowerCase();
    const preferred = normalizeRelativePath(preferredSubfolder).toLowerCase();
    if (!current || !preferred) return false;
    return current === preferred || current.endsWith(`/${preferred}`) || current.includes(preferred);
}

function computeKeywordOverlapScore(queryKeywords, itemTokens) {
    if (!queryKeywords?.length || !itemTokens?.length) return 0;
    let matches = 0;
    for (const keyword of queryKeywords) {
        if (itemTokens.some(token => keywordMatches(keyword, token))) {
            matches += 1;
        }
    }
    return matches / Math.max(2, Math.min(queryKeywords.length, 8));
}

function normalizeSearchOptions(styleFilterOrOptions) {
    if (!styleFilterOrOptions || typeof styleFilterOrOptions === 'string') {
        return {
            styleFilter: styleFilterOrOptions || null,
            preferredSubfolder: '',
            keywordHints: [],
            ageBucket: null,
            role: null,
            era: null,
            excludeUrls: []
        };
    }

    return {
        styleFilter: styleFilterOrOptions.styleFilter || null,
        preferredSubfolder: styleFilterOrOptions.preferredSubfolder || '',
        keywordHints: uniqueValues(styleFilterOrOptions.keywordHints || []),
        ageBucket: styleFilterOrOptions.ageBucket || null,
        role: styleFilterOrOptions.role || null,
        era: styleFilterOrOptions.era || null,
        excludeUrls: styleFilterOrOptions.excludeUrls || []
    };
}

function getThreeviewPreferredSubfolder(genderKey, ...texts) {
    const role = inferRoleHint(texts.filter(Boolean).join('，'));
    if (!role) return '';
    if (genderKey === 'male') {
        return role === 'lead' ? '男主角' : '男配角';
    }
    return role === 'lead' ? '女主角' : '女配角';
}

// ── CLIP 运行时调用 ────────────────────────────────

// ── 风格分类（CLIP 零样本）───────────────────────

const STYLE_PROMPTS = {
    real: 'a realistic photograph of a person, photorealistic, real photo',
    '3d': 'a 3D rendered character, CGI, 3D model rendering',
    '2d': 'a 2D anime illustration, cartoon drawing, manga style artwork'
};

/** 缓存风格文本向量（启动后只计算一次）*/
let _styleVectors = null;

async function getStyleVectors() {
    if (_styleVectors) return _styleVectors;
    _styleVectors = {};
    for (const [key, prompt] of Object.entries(STYLE_PROMPTS)) {
        _styleVectors[key] = await embedText(prompt);
    }
    console.log('✅ 风格分类向量已缓存');
    return _styleVectors;
}

/** 用 CLIP 零样本分类判断图片风格 */
async function classifyStyle(imageVector) {
    const styleVecs = await getStyleVectors();
    let bestStyle = 'real';
    let bestScore = -1;
    for (const [style, vec] of Object.entries(styleVecs)) {
        const score = cosineSimilarity(imageVector, vec);
        if (score > bestScore) {
            bestScore = score;
            bestStyle = style;
        }
    }
    return { style: bestStyle, confidence: bestScore };
}

/** 检查 CLIP 服务是否可用 */
async function checkClipHealth() {
    try {
        const data = await getClipHealth();
        return data.status === 'ok';
    } catch {
        return false;
    }
}

// ── 索引管理 ─────────────────────────────────────

/**
 * 扫描目录，收集所有图片的绝对路径和元信息
 */
function scanImages(imageLibPath, gender, partType, overrides = {}) {
    // 中文文件夹映射
    const genderFolder = gender === 'male' ? '男性' : '女性';
    const partMap = { face: '脸', halfbody: '半身图', hair: '发型', clothes: '服装', threeview: '三视图' };
    const partFolder = partMap[partType] || partType;

    const basePath = path.join(imageLibPath, genderFolder, partFolder);
    if (!fs.existsSync(basePath)) {
        fs.mkdirSync(basePath, { recursive: true });
        console.log(`📁 自动创建目录: ${basePath}`);
        return [];
    }

    // URL 前缀：如果有风格前缀，使用 /images/{stylePrefix}/ 路径
    const urlPrefix = overrides.urlStylePrefix
        ? `/images/${overrides.urlStylePrefix}`
        : `/images`;

    const results = [];
    const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

    // 递归扫描
    const scan = (dir, subfolder) => {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            if (item.startsWith('.')) continue;
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                const nextSubfolder = subfolder ? path.posix.join(subfolder, item) : item;
                scan(fullPath, nextSubfolder);
            } else if (imageExts.includes(path.extname(item).toLowerCase())) {
                // 读取同名 txt 标签
                const baseName = item.substring(0, item.lastIndexOf('.'));
                const txtPath = path.join(dir, `${baseName}.txt`);
                let tags = '';
                if (fs.existsSync(txtPath)) {
                    tags = fs.readFileSync(txtPath, 'utf-8').trim();
                }

                const relPath = path.relative(path.join(imageLibPath, genderFolder, partFolder), fullPath);
                const effectiveSubfolder = subfolder || '';
                const tagMeta = buildTagMetadata(tags, effectiveSubfolder, partType);
                results.push({
                    id: item,
                    absolutePath: fullPath,
                    relativePath: relPath,
                    subfolder: effectiveSubfolder,
                    tags,
                    tagTokens: tagMeta.tokens,
                    tagMeta,
                    url: `${urlPrefix}/${genderFolder}/${partFolder}/${encodeURIComponent(relPath).replace(/%2F/g, '/')}`
                });
            }
        }
    };

    scan(basePath, '');
    return results;
}

/**
 * 扫描场景图片目录
 */
function scanSceneImages(imageLibPath) {
    const basePath = path.join(imageLibPath, '场景');
    if (!fs.existsSync(basePath)) {
        fs.mkdirSync(basePath, { recursive: true });
        console.log(`📁 自动创建目录: ${basePath}`);
        return [];
    }

    const results = [];
    const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

    // 遍历 古代/现代 → 室内/室外
    const eras = ['古代', '现代'];
    const locations = ['室内', '室外'];

    for (const era of eras) {
        for (const location of locations) {
            const dirPath = path.join(basePath, era, location);
            if (!fs.existsSync(dirPath)) continue;

            const items = fs.readdirSync(dirPath);
            for (const item of items) {
                if (item.startsWith('.')) continue;
                const fullPath = path.join(dirPath, item);
                const stat = fs.statSync(fullPath);
                if (!stat.isFile()) continue;
                if (!imageExts.includes(path.extname(item).toLowerCase())) continue;

                // 读取同名 txt 标签
                const baseName = item.substring(0, item.lastIndexOf('.'));
                const txtPath = path.join(dirPath, `${baseName}.txt`);
                let tags = '';
                if (fs.existsSync(txtPath)) {
                    tags = fs.readFileSync(txtPath, 'utf-8').trim();
                }

                const relPath = path.relative(basePath, fullPath);
                const tagMeta = buildTagMetadata(tags, `${era}/${location}`, 'scene');
                results.push({
                    id: item,
                    absolutePath: fullPath,
                    relativePath: relPath,
                    era,        // '古代' | '现代'
                    location,   // '室内' | '室外'
                    tags,
                    tagTokens: tagMeta.tokens,
                    tagMeta,
                    url: `/images/场景/${encodeURIComponent(relPath).replace(/%2F/g, '/')}`
                });
            }
        }
    }

    return results;
}

/**
 * 为指定 gender/partType 构建向量索引
 */
async function buildIndex(imageLibPath, gender, partType, progressCallback, stylePrefix) {
    const images = scanImages(imageLibPath, gender, partType, { urlStylePrefix: stylePrefix });
    if (images.length === 0) {
        return { built: 0, total: 0, message: '没有找到图片' };
    }

    // 检查已有索引，实现增量更新
    const existingIndex = loadIndex(gender, partType, stylePrefix);
    const existingMap = new Map(existingIndex.items.map(it => [it.absolutePath, it]));

    // 找出需要新编码的图片（没有向量或没有风格的需要重新编码）
    const needEncode = images.filter(img => {
        const existing = existingMap.get(img.absolutePath);
        return !existing || !existing.style;  // 没有风格标签的也需要重新编码
    });
    const reuse = images.filter(img => {
        const existing = existingMap.get(img.absolutePath);
        return existing && existing.style;  // 有风格标签的才能复用
    });

    if (progressCallback) {
        progressCallback(`${stylePrefix ? stylePrefix+'/' : ''}${gender}/${partType}: 共 ${images.length} 张图，复用 ${reuse.length}，需编码 ${needEncode.length}`);
    }

    let newItems = reuse.map(img => {
        const existing = existingMap.get(img.absolutePath);
        return {
            ...existing,
            id: img.id,
            absolutePath: img.absolutePath,
            relativePath: img.relativePath,
            subfolder: img.subfolder,
            tags: img.tags,
            tagTokens: img.tagTokens,
            tagMeta: img.tagMeta,
            url: img.url
        };
    });

    if (needEncode.length > 0) {
        const paths = needEncode.map(img => img.absolutePath);
        const batchResult = await batchEmbedImages(paths);

        for (const result of batchResult.results) {
            if (!result.ok) continue;
            const img = needEncode.find(i => i.absolutePath === result.path);
            if (!img) continue;

            // 对每张图片进行风格分类
            const { style, confidence } = await classifyStyle(result.vector);

            newItems.push({
                id: img.id,
                absolutePath: img.absolutePath,
                relativePath: img.relativePath,
                subfolder: img.subfolder,
                tags: img.tags,
                tagTokens: img.tagTokens,
                tagMeta: img.tagMeta,
                url: img.url,
                vector: result.vector,
                style,           // 'real' | '3d' | '2d'
                styleConfidence: confidence
            });
        }
    }

    const index = {
        version: 3,
        dimension: 512,
        gender,
        partType,
        stylePrefix: stylePrefix || null,
        builtAt: new Date().toISOString(),
        items: newItems
    };

    saveIndex(gender, partType, index, stylePrefix);

    return {
        built: needEncode.length,
        reused: reuse.length,
        total: newItems.length,
        failed: images.length - newItems.length
    };
}

/**
 * 构建场景向量索引
 */
async function buildSceneIndex(imageLibPath, progressCallback) {
    const images = scanSceneImages(imageLibPath);
    if (images.length === 0) {
        return { built: 0, total: 0, message: '没有找到场景图片' };
    }

    // 加载已有场景索引
    const indexPath = path.join(INDEX_DIR, 'scene.json');
    let existingIndex = { version: 2, dimension: 512, items: [] };
    if (fs.existsSync(indexPath)) {
        existingIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    }
    const existingMap = new Map(existingIndex.items.map(it => [it.absolutePath, it]));

    const needEncode = images.filter(img => {
        const existing = existingMap.get(img.absolutePath);
        return !existing || !existing.style;
    });
    const reuse = images.filter(img => {
        const existing = existingMap.get(img.absolutePath);
        return existing && existing.style;
    });

    if (progressCallback) {
        progressCallback(`场景: 共 ${images.length} 张图，复用 ${reuse.length}，需编码 ${needEncode.length}`);
    }

    let newItems = reuse.map(img => {
        const existing = existingMap.get(img.absolutePath);
        return {
            ...existing,
            id: img.id,
            absolutePath: img.absolutePath,
            relativePath: img.relativePath,
            era: img.era,
            location: img.location,
            tags: img.tags,
            tagTokens: img.tagTokens,
            tagMeta: img.tagMeta,
            url: img.url
        };
    });

    if (needEncode.length > 0) {
        const paths = needEncode.map(img => img.absolutePath);
        const batchResult = await batchEmbedImages(paths);

        for (const result of batchResult.results) {
            if (!result.ok) continue;
            const img = needEncode.find(i => i.absolutePath === result.path);
            if (!img) continue;

            const { style, confidence } = await classifyStyle(result.vector);

            newItems.push({
                id: img.id,
                absolutePath: img.absolutePath,
                relativePath: img.relativePath,
                era: img.era,
                location: img.location,
                tags: img.tags,
                tagTokens: img.tagTokens,
                tagMeta: img.tagMeta,
                url: img.url,
                vector: result.vector,
                style,
                styleConfidence: confidence
            });
        }
    }

    const index = {
        version: 3,
        dimension: 512,
        builtAt: new Date().toISOString(),
        items: newItems
    };

    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');

    return {
        built: needEncode.length,
        reused: reuse.length,
        total: newItems.length,
        failed: images.length - newItems.length
    };
}

/**
 * 构建所有分区索引
 */
async function buildAllIndexes(imageLibPath, progressCallback, stylePrefix) {
    const partitions = [
        { gender: 'male', partType: 'face' },
        { gender: 'male', partType: 'halfbody' },
        { gender: 'male', partType: 'hair' },
        { gender: 'male', partType: 'clothes' },
        { gender: 'male', partType: 'threeview' },
        { gender: 'female', partType: 'face' },
        { gender: 'female', partType: 'halfbody' },
        { gender: 'female', partType: 'hair' },
        { gender: 'female', partType: 'clothes' },
        { gender: 'female', partType: 'threeview' },
    ];

    const stats = {};
    for (const { gender, partType } of partitions) {
        try {
            const result = await buildIndex(imageLibPath, gender, partType, progressCallback, stylePrefix);
            stats[`${gender}/${partType}`] = result;
        } catch (err) {
            stats[`${gender}/${partType}`] = { error: err.message };
        }
    }
    return stats;
}

// ── 搜索 ─────────────────────────────────────────

/**
 * 语义搜索：文本 → Top-K 最匹配的图片
 * @param {string} styleFilter - 可选风格过滤: 'real' | '3d' | '2d'
 */
async function search(queryText, gender, partType, topK = 5, styleFilterOrOptions = null, stylePrefix = null) {
    const index = loadIndex(gender, partType, stylePrefix);
    if (index.items.length === 0) {
        return [];
    }

    const searchOptions = normalizeSearchOptions(styleFilterOrOptions);

    // 获取查询向量
    const queryVector = await embedText(queryText);

    // 过滤和计算相似度
    let items = index.items.filter(item =>
        item.vector &&
        item.vector.length > 0 &&
        (!item.absolutePath || fs.existsSync(item.absolutePath))
    );

    if (items.length === 0) {
        return [];
    }

    // 风格过滤（最高优先级）
    if (searchOptions.styleFilter) {
        const styleFiltered = items.filter(item => item.style === searchOptions.styleFilter);
        // 如果过滤后有结果则使用，否则回退到全集
        if (styleFiltered.length > 0) {
            items = styleFiltered;
        } else {
            console.log(`[search] 风格 '${searchOptions.styleFilter}' 无匹配，回退到全集`);
        }
    }

    if (searchOptions.excludeUrls.length > 0) {
        const excludeSet = new Set(searchOptions.excludeUrls);
        items = items.filter(item => !excludeSet.has(item.url));
    }

    if (searchOptions.preferredSubfolder) {
        const folderFiltered = items.filter(item => subfolderMatches(getEffectiveSubfolder(item), searchOptions.preferredSubfolder));
        if (folderFiltered.length > 0) {
            items = folderFiltered;
        }
    }

    if (searchOptions.role && partType === 'threeview') {
        const roleFiltered = items.filter(item => {
            const itemSubfolder = getEffectiveSubfolder(item);
            const itemMeta = item.tagMeta || buildTagMetadata(item.tags, itemSubfolder, partType);
            return itemMeta.role === searchOptions.role;
        });
        if (roleFiltered.length > 0) {
            items = roleFiltered;
        }
    }

    const scored = items.map(item => {
        const itemSubfolder = getEffectiveSubfolder(item);
        const itemMeta = item.tagMeta || buildTagMetadata(item.tags, itemSubfolder, partType);
        const itemTokens = item.tagTokens?.length ? item.tagTokens : itemMeta.tokens;
        const clipScore = cosineSimilarity(queryVector, item.vector);
        const keywordScore = computeKeywordOverlapScore(searchOptions.keywordHints, itemTokens);
        const folderMatched = !!(searchOptions.preferredSubfolder && subfolderMatches(itemSubfolder, searchOptions.preferredSubfolder));
        const ageMatched = !!(searchOptions.ageBucket && itemMeta.ageBucket && searchOptions.ageBucket === itemMeta.ageBucket);
        const roleMatched = !!(searchOptions.role && itemMeta.role && searchOptions.role === itemMeta.role);
        const eraMatched = !!(searchOptions.era && itemMeta.era && searchOptions.era === itemMeta.era);

        let finalScore = clipScore;
        finalScore += keywordScore * 0.18;
        if (folderMatched) finalScore += 0.18;
        if (ageMatched) finalScore += 0.08;
        if (roleMatched) finalScore += 0.12;
        if (eraMatched) finalScore += 0.06;
        if (searchOptions.role && itemMeta.role && searchOptions.role !== itemMeta.role) finalScore -= 0.06;
        if (searchOptions.ageBucket && itemMeta.ageBucket && searchOptions.ageBucket !== itemMeta.ageBucket) finalScore -= 0.03;

        return {
            id: item.id,
            url: item.url,
            subfolder: itemSubfolder,
            tags: item.tags,
            tagTokens: itemTokens,
            style: item.style || itemMeta.styleHint || 'unknown',
            clipScore,
            keywordScore,
            score: finalScore
        };
    });

    // 按相似度降序
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK);
}

/**
 * 场景搜索：按优先级链匹配场景图片
 * 优先级：风格(real/3d/2d) → 时代(古代/现代) → 地点(室内/室外)
 */
async function searchScene(queryText, { style, era, location, topK = 5 } = {}) {
    const indexPath = path.join(INDEX_DIR, 'scene.json');
    if (!fs.existsSync(indexPath)) return [];

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    if (index.items.length === 0) return [];

    const queryVector = await embedText(queryText);

    let items = index.items.filter(item =>
        item.vector &&
        item.vector.length > 0 &&
        (!item.absolutePath || fs.existsSync(item.absolutePath))
    );

    if (items.length === 0) return [];

    // 优先级 1: 风格过滤
    if (style) {
        const filtered = items.filter(item => item.style === style);
        if (filtered.length > 0) items = filtered;
        else console.log(`[searchScene] 风格 '${style}' 无匹配，跳过`);
    }

    // 优先级 2: 时代过滤
    if (era) {
        const filtered = items.filter(item => item.era === era);
        if (filtered.length > 0) items = filtered;
        else console.log(`[searchScene] 时代 '${era}' 无匹配，跳过`);
    }

    // 优先级 3: 地点过滤
    if (location) {
        const filtered = items.filter(item => item.location === location);
        if (filtered.length > 0) items = filtered;
        else console.log(`[searchScene] 地点 '${location}' 无匹配，跳过`);
    }

    const scored = items.map(item => ({
        id: item.id,
        url: item.url,
        era: item.era,
        location: item.location,
        style: item.style || 'unknown',
        tags: item.tags,
        score: cosineSimilarity(queryVector, item.vector)
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
}

// ── 中文→英文翻译映射 ─────────────────────────────

/** 中文→英文关键词映射表 */
const ZH_EN_MAP = {
    // 性别
    '男': 'male', '女': 'female', '男性': 'male', '女性': 'female',
    '男孩': 'boy', '女孩': 'girl',
    // 年龄（使用具体数字范围加强 CLIP 匹配精度）
    '年轻': 'young person in early 20s', '年轻人': 'young person in 20s',
    '青年': 'young adult in 20s', '少年': 'teenage boy around 14-17',
    '少女': 'teenage girl around 14-17', '中年': 'middle-aged person in 40s-50s',
    '老年': 'elderly old person over 60', '老人': 'elderly old person over 60',
    '老者': 'elderly old person over 65', '年幼': 'young child around 8-12',
    '儿童': 'child around 8-10', '幼儿': 'toddler around 3-5',
    '约二十岁': 'around 20 years old', '约三十岁': 'around 30 years old',
    '约四十岁': 'around 40 years old', '约五十岁': 'around 50 years old',
    '约六十岁': 'around 60 years old', '约七十岁': 'around 70 years old',
    '二十': '20 years old', '三十': '30 years old',
    '四十': '40 years old', '五十': '50 years old',
    '六十': '60 years old', '七十': '70 years old',
    '20岁': '20 years old', '25岁': '25 years old', '30岁': '30 years old',
    '18岁': '18 years old', '15岁': '15 years old', '40岁': '40 years old',
    '十二三岁': 'around 12-13 years old', '十五六岁': 'around 15-16 years old',
    '十四五岁': 'around 14-15 years old', '二十岁': '20 years old',
    '成年': 'adult',
    // 脸部
    '脸': 'face', '脸部': 'face', '面部': 'face', '面部特写': 'face close-up',
    '肖像': 'portrait', '特写': 'close-up', '五官': 'facial features',
    '圆脸': 'round face', '鹅蛋脸': 'oval face', '瓜子脸': 'V-shaped face',
    '方脸': 'square face', '长脸': 'long face', '心形脸': 'heart-shaped face',
    '菱形脸': 'diamond face', '国字脸': 'square jaw face',
    '英俊': 'handsome', '帅气': 'handsome', '美丽': 'beautiful', '可爱': 'cute',
    '精致': 'delicate', '清秀': 'elegant', '俊美': 'handsome',
    '剑眉星目': 'sharp brows and bright eyes', '大眼': 'big eyes',
    '凤眼': 'phoenix eyes', '丹凤眼': 'upturned eyes',
    '潇洒': 'charming', '冷峻': 'cold stern', '温柔': 'gentle',
    // 发型
    '发型': 'hairstyle', '头发': 'hair',
    '长发': 'long hair', '短发': 'short hair', '中长发': 'medium hair',
    '直发': 'straight hair', '卷发': 'curly hair', '波浪': 'wavy hair',
    '马尾': 'ponytail', '双马尾': 'twin tails', '丸子头': 'bun',
    '编发': 'braided hair', '盘发': 'updo', '披肩发': 'shoulder-length hair',
    '齐刘海': 'bangs', '斜刘海': 'side bangs', '空气刘海': 'air bangs',
    '黑发': 'black hair', '棕发': 'brown hair', '金发': 'blonde hair',
    '银发': 'silver hair', '红发': 'red hair', '白发': 'white hair',
    '蓝发': 'blue hair', '紫发': 'purple hair', '绿发': 'green hair',
    '束发': 'tied hair', '发髻': 'hair bun', '高马尾': 'high ponytail',
    '发丝': 'hair strands', '发丝随性散落': 'messy loose hair',
    '古代发型': 'ancient Chinese hairstyle', '现代发型': 'modern hairstyle',
    '古装主角长发': 'ancient style protagonist long hair',
    '古装配角长发': 'ancient style supporting role long hair',
    '古装长发': 'ancient style long hair',
    // 服装
    '服装': 'clothing', '衣服': 'clothes', '穿着': 'outfit', '服饰': 'costume',
    '古装': 'ancient Chinese costume', '汉服': 'hanfu Chinese traditional dress',
    '长袍': 'long robe', '道袍': 'Taoist robe', '青布长衫': 'blue cotton robe',
    '连衣裙': 'dress', '西装': 'suit', '制服': 'uniform', '校服': 'school uniform',
    '盔甲': 'armor', '铠甲': 'plate armor', '战甲': 'battle armor',
    '外袍': 'outer robe', '内衫': 'inner shirt', '披风': 'cape cloak',
    '丝绸': 'silk', '棉麻': 'cotton linen', '纱裙': 'gauze skirt',
    '刺绣': 'embroidery', '腰带': 'belt', '腰间': 'waist',
    '粗麻': 'coarse linen', '布料': 'fabric', '衣领': 'collar',
    '粉色': 'pink', '白色': 'white', '黑色': 'black', '红色': 'red',
    '蓝色': 'blue', '青色': 'cyan', '绿色': 'green', '紫色': 'purple',
    '金色': 'gold', '银色': 'silver', '灰色': 'grey',
    '华丽': 'gorgeous', '朴素': 'plain', '简约': 'simple',
    '轻纱': 'light gauze', '流仙裙': 'flowing fairy dress',
    '仙裙': 'fairy dress', '仙袍': 'celestial robe',
    // 风格/时代
    '仙侠': 'xianxia fantasy', '武侠': 'wuxia martial arts',
    '修仙': 'cultivation fantasy', '修仙者': 'cultivator',
    '古风': 'ancient Chinese style', '古代': 'ancient',
    '现代': 'modern', '都市': 'urban', '时尚': 'fashion',
    '赛博朋克': 'cyberpunk', '校园': 'campus school',
    '奇幻': 'fantasy', '哥特': 'gothic', '洛丽塔': 'lolita',
    '军装': 'military uniform',
    // 三视图
    '三视图': 'three-view character turnaround', '全身': 'full body',
    '正面': 'front view', '侧面': 'side view', '背面': 'back view',
    '站姿': 'standing pose', '全身照': 'full body shot',
    // 体型
    '纤细': 'slim', '高挑': 'tall slender', '娇小': 'petite',
    '健壮': 'muscular', '魁梧': 'burly', '苗条': 'slender',
    // 其他
    '电影级': 'cinematic', '光影': 'lighting', '纯白背景': 'white background',
    '背景虚化': 'blurred background', '玉佩': 'jade pendant',
    '折扇': 'folding fan', '宝剑': 'sword', '法器': 'magic weapon',
};

/**
 * 将中文文本翻译为英文（基于关键词映射）
 * 策略：按长度降序匹配，避免短词覆盖长词
 */
function translateToEnglish(chineseText) {
    if (!chineseText) return '';
    let text = chineseText;
    const result = [];

    // 按长度降序排列，优先匹配长词
    const sortedKeys = Object.keys(ZH_EN_MAP).sort((a, b) => b.length - a.length);
    const matched = new Set();

    for (const zh of sortedKeys) {
        if (text.includes(zh) && !matched.has(zh)) {
            result.push(ZH_EN_MAP[zh]);
            matched.add(zh);
            // 避免子串重复匹配
            for (const other of sortedKeys) {
                if (other !== zh && zh.includes(other)) {
                    matched.add(other);
                }
            }
        }
    }

    return result.join(', ');
}

/**
 * 全自动匹配：给定角色描述，在所有分区搜索最匹配的图片
 * @param {string} characterInfo.style - 可选风格过滤: 'real' | '3d' | '2d'
 */
async function autoMatch(characterInfo, topK = 3, options = {}) {
    const { imageLibPath, stylePrefix } = options;
    const { gender, age, hair_description, clothing_description, original_text, name,
            face_description, preferred_face_folder, preferred_hair_folder, preferred_clothes_folder,
            exclude_face_urls, exclude_halfbody_urls, style } = characterInfo;

    // 确定搜索性别
    const genderKey = (gender && gender.includes('男')) ? 'male' : 'female';
    const genderEn = genderKey === 'male' ? 'male' : 'female';

    // 翻译各部分描述为英文
    const ageEn = translateToEnglish(age || '');
    const faceEn = translateToEnglish(face_description || '');
    const hairEn = translateToEnglish(hair_description || '');
    const clothesEn = translateToEnglish(clothing_description || '');
    const textEn = translateToEnglish(original_text || '');

    const ageBucket = inferAgeBucket([age, original_text].filter(Boolean).join('，'));
    const eraHint = inferEraHint([clothing_description, original_text].filter(Boolean).join('，'));
    const threeviewRole = inferRoleHint([preferred_face_folder, original_text].filter(Boolean).join('，'));
    const preferredThreeviewFolder = getThreeviewPreferredSubfolder(genderKey, preferred_face_folder, original_text);

    const faceRawText = [face_description, original_text, age].filter(Boolean).join('，');
    const hairRawText = [hair_description, original_text, age].filter(Boolean).join('，');
    const clothesRawText = [clothing_description, original_text, age].filter(Boolean).join('，');
    const threeviewRawText = [original_text, age, hair_description, clothing_description, preferred_face_folder].filter(Boolean).join('，');
    const halfbodyRawText = [face_description, hair_description, clothing_description, original_text, age].filter(Boolean).join('，');

    // 构建英文查询文本；当部位描述缺失时，回退到 original_text 的翻译结果
    const faceQuery = [genderEn, ageEn, faceEn || textEn, 'face portrait close-up', ageEn].filter(Boolean).join(', ');
    const hairQuery = [genderEn, hairEn || textEn, 'hairstyle, hair', ageEn].filter(Boolean).join(', ');
    const clothesQuery = [genderEn, clothesEn || textEn, 'clothing, outfit, costume', ageEn].filter(Boolean).join(', ');
    const threeviewQuery = [genderEn, ageEn, hairEn, clothesEn, textEn, 'character turnaround, full body, front side back view'].filter(Boolean).join(', ');
    const halfbodyQuery = [genderEn, ageEn, faceEn, hairEn, clothesEn, textEn, 'half body portrait, upper body'].filter(Boolean).join(', ');

    console.log(`[autoMatch] 查询翻译 (风格: ${stylePrefix || '不限'}, 路径: ${imageLibPath || '默认'}):`);
    console.log(`  face: ${faceQuery}  [folder: ${preferred_face_folder || '不限'}]`);
    console.log(`  hair: ${hairQuery}  [folder: ${preferred_hair_folder || '不限'}]`);
    console.log(`  clothes: ${clothesQuery}  [folder: ${preferred_clothes_folder || '不限'}]`);
    console.log(`  threeview: ${threeviewQuery}  [folder: ${preferredThreeviewFolder || '不限'}]`);
    console.log(`  halfbody: ${halfbodyQuery}`);
    console.log(`  style filter: ${style || '不限'}`);

    // 搜索时请求更多结果（因为过滤后数量可能不足）
    const searchK = topK * 8;
    let [faceResults, hairResults, clothesResults, threeviewResults, halfbodyResults] = await Promise.all([
        search(faceQuery, genderKey, 'face', searchK, {
            styleFilter: style || null,
            preferredSubfolder: preferred_face_folder || '',
            keywordHints: extractKeywordHintsFromText(faceRawText),
            ageBucket,
            excludeUrls: exclude_face_urls || []
        }, stylePrefix),
        search(hairQuery, genderKey, 'hair', searchK, {
            styleFilter: style || null,
            preferredSubfolder: preferred_hair_folder || '',
            keywordHints: extractKeywordHintsFromText(hairRawText),
            ageBucket
        }, stylePrefix),
        search(clothesQuery, genderKey, 'clothes', searchK, {
            styleFilter: style || null,
            preferredSubfolder: preferred_clothes_folder || '',
            keywordHints: extractKeywordHintsFromText(clothesRawText),
            ageBucket,
            era: eraHint
        }, stylePrefix),
        search(threeviewQuery, genderKey, 'threeview', searchK, {
            styleFilter: style || null,
            preferredSubfolder: preferredThreeviewFolder,
            keywordHints: extractKeywordHintsFromText(threeviewRawText),
            ageBucket,
            role: threeviewRole,
            era: eraHint
        }, stylePrefix),
        search(halfbodyQuery, genderKey, 'halfbody', searchK, {
            styleFilter: style || null,
            keywordHints: extractKeywordHintsFromText(halfbodyRawText),
            ageBucket,
            excludeUrls: exclude_halfbody_urls || []
        }, stylePrefix),
    ]);

    // 截取 topK
    faceResults = faceResults.slice(0, topK);
    hairResults = hairResults.slice(0, topK);
    clothesResults = clothesResults.slice(0, topK);
    threeviewResults = threeviewResults.slice(0, topK);
    halfbodyResults = halfbodyResults.slice(0, topK);

    return {
        face: faceResults,
        hair: hairResults,
        clothes: clothesResults,
        threeview: threeviewResults,
        halfbody: halfbodyResults,
        queries: { face: faceQuery, hair: hairQuery, clothes: clothesQuery, threeview: threeviewQuery, halfbody: halfbodyQuery }
    };
}

/**
 * 从文本中检测风格/时代/地点信息
 */
function detectSceneAttributes(text) {
    const result = { style: null, era: null, location: null };

    // 风格检测
    if (/写实|真实|摄影|照片|真人/.test(text)) result.style = 'real';
    else if (/3[dD]|三维|CG|渲染/.test(text)) result.style = '3d';
    else if (/2[dD]|二次元|动漫|漫画|卡通|插画/.test(text)) result.style = '2d';

    // 时代检测
    if (/古代|古风|古装|仙侠|武侠|修仙|宫殿|宗门|门派/.test(text)) result.era = '古代';
    else if (/现代|都市|城市|高楼|办公|学校|公寓|酒吧|商场/.test(text)) result.era = '现代';

    // 地点检测
    if (/室内|屋内|房间|厅堂|大殿|密室|书房|卧室|客厅|厨房|办公室|教室/.test(text)) result.location = '室内';
    else if (/室外|户外|山|水|河|湖|海|林|森|野|街|路|广场|花园|天空|悬崖/.test(text)) result.location = '室外';

    return result;
}

/**
 * 自动匹配场景图片
 * 优先级链：风格(real/3d/2d) → 时代(古代/现代) → 地点(室内/室外)
 */
async function autoMatchScene(sceneText, { style, topK = 5 } = {}) {
    const attrs = detectSceneAttributes(sceneText);
    // 外部传入的风格优先
    const finalStyle = style || attrs.style;

    const sceneEn = translateToEnglish(sceneText);
    const queryText = sceneEn || sceneText;

    console.log(`[autoMatchScene] 查询: ${queryText.substring(0, 80)}...`);
    console.log(`  风格=${finalStyle || '不限'}, 时代=${attrs.era || '不限'}, 地点=${attrs.location || '不限'}`);

    return searchScene(queryText, {
        style: finalStyle,
        era: attrs.era,
        location: attrs.location,
        topK
    });
}

/**
 * 获取所有索引的状态信息
 */
function getStatus() {
    const partitions = [
        { gender: 'male', partType: 'face' },
        { gender: 'male', partType: 'halfbody' },
        { gender: 'male', partType: 'hair' },
        { gender: 'male', partType: 'clothes' },
        { gender: 'male', partType: 'threeview' },
        { gender: 'female', partType: 'face' },
        { gender: 'female', partType: 'halfbody' },
        { gender: 'female', partType: 'hair' },
        { gender: 'female', partType: 'clothes' },
        { gender: 'female', partType: 'threeview' },
    ];

    const result = {};
    for (const { gender, partType } of partitions) {
        const index = loadIndex(gender, partType);
        result[`${gender}/${partType}`] = {
            count: index.items.length,
            builtAt: index.builtAt || null,
            dimension: index.dimension
        };
    }

    // 场景索引状态
    const sceneIndexPath = path.join(INDEX_DIR, 'scene.json');
    if (fs.existsSync(sceneIndexPath)) {
        const sceneIndex = JSON.parse(fs.readFileSync(sceneIndexPath, 'utf-8'));
        result['scene'] = {
            count: sceneIndex.items.length,
            builtAt: sceneIndex.builtAt || null,
            dimension: sceneIndex.dimension
        };
    } else {
        result['scene'] = { count: 0, builtAt: null, dimension: 512 };
    }

    return result;
}

export {
    buildIndex,
    buildAllIndexes,
    buildSceneIndex,
    search,
    searchScene,
    autoMatch,
    autoMatchScene,
    getStatus,
    checkClipHealth,
    embedText,
    embedImage,
    scanImages,
    scanSceneImages
};

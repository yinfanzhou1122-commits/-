// API 服务器配置 - Node.js 服务器端口
const API_SERVER = 'http://localhost:3115/api';
// 后端返回的 url 已经包含了 /images，所以这里只保留协议和端口
const IMAGES_SERVER = 'http://localhost:3115';

// State
let allCharacters = []; // 所有解析出的角色数据
let characterStates = {}; // 每个角色的选择状态 { charIndex: { face, hair, clothes } }
let currentModalCharIndex = null;
let currentModalPartType = null;
let allAvailableImages = { male: { face: [], hair: [], clothes: [] }, female: { face: [], hair: [], clothes: [] } };

// DOM Elements
const analyzeBtn = document.getElementById('analyze-btn');
const mainPrompt = document.getElementById('main-prompt');
const modal = document.getElementById('selection-modal');
const modalTitle = document.getElementById('modal-title');
const modalGrid = document.getElementById('modal-grid');
const downloadBtn = document.getElementById('download-btn');
const resultCharName = document.getElementById('result-char-name');
const apiKeyInput = document.getElementById('api-key-input');
const charactersContainer = document.getElementById('characters-container');

// History Modal Elements
const historyBtn = document.getElementById('history-btn');
const historyModal = document.getElementById('history-modal');
const historyGrid = document.getElementById('history-grid');
const historyCount = document.getElementById('history-count');

// =============================================
// IndexedDB 历史记录封装
// =============================================
const DB_NAME = 'FusionHistoryDB';
const STORE_NAME = 'history_images';
const DB_VERSION = 1;

let db;
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (event) => reject('IndexedDB error: ' + event.target.errorCode);
        request.onsuccess = (event) => {
            db = event.target.result;
            resolve(db);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                // 以时间戳为键
                db.createObjectStore(STORE_NAME, { keyPath: 'timestamp' });
            }
        };
    });
}

async function saveHistoryImage(base64Image, charName) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const item = {
            timestamp: Date.now(),
            charName: charName || '未命名角色',
            image: base64Image
        };
        const request = store.add(item);
        request.onsuccess = () => resolve(true);
        request.onerror = (e) => reject(e);
    });
}

async function getAllHistory() {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => {
            // 按时间倒序返回
            const result = request.result || [];
            resolve(result.sort((a, b) => b.timestamp - a.timestamp));
        };
        request.onerror = (e) => reject(e);
    });
}

// 初始化数据库
initDB().catch(err => console.error("History DB Init failed:", err));

// 从 localStorage 恢复上次输入的 API Key
const savedApiKey = localStorage.getItem('zhenzhen_api_key');
if (savedApiKey) {
    apiKeyInput.value = savedApiKey;
}
apiKeyInput.addEventListener('input', () => {
    localStorage.setItem('zhenzhen_api_key', apiKeyInput.value);
});

// =============================================
// 1. 人物拆解 - 解析多段提示词
// =============================================
analyzeBtn.addEventListener('click', async () => {
    const promptText = mainPrompt.value.trim();
    const apiKey = apiKeyInput.value.trim();

    if (!apiKey) return alert('请在左侧输入 zhenzhen API Key');
    if (!promptText) return alert('请输入提示词');

    analyzeBtn.disabled = true;
    analyzeBtn.innerText = '分析中... / ANALYZING';

    try {
        const res = await fetch(`${API_SERVER}/parse-prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: promptText, apiKey: apiKey })
        });

        const data = await res.json();
        console.log('[解析结果]', data);

        if (data.success && data.characters && data.characters.length > 0) {
            allCharacters = data.characters;
            characterStates = {};

            // 初始化每个角色的选择状态
            allCharacters.forEach((char, i) => {
                characterStates[i] = { face: null, hair: null, clothes: null };
            });

            // 动态生成角色卡片
            renderCharacterCards();

            // 预加载所有可用图片（带标签匹配）
            await loadAllImages();
        } else {
            alert('解析失败: ' + (data.message || '未识别到角色'));
        }
    } catch (err) {
        console.error(err);
        alert('接口请求错误，请查阅控制台');
    } finally {
        analyzeBtn.disabled = false;
        analyzeBtn.innerText = '人物拆解 / ANALYZE';
    }
});

// =============================================
// 预加载所有图片（带标签匹配）
// =============================================
async function loadAllImages() {
    try {
        const res = await fetch(`${API_SERVER}/get-all-images`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characters: allCharacters })
        });
        const data = await res.json();
        if (data.success) {
            allAvailableImages = data.images;
            console.log('[图片库加载完成，带标签匹配]', allAvailableImages);
        }
    } catch (err) {
        console.error('加载图片库失败', err);
    }
}

// =============================================
// 动态渲染角色卡片
// =============================================
function renderCharacterCards() {
    charactersContainer.innerHTML = '';

    allCharacters.forEach((char, index) => {
        const card = document.createElement('div');
        card.className = 'character-config cp-card';
        card.id = `char-card-${index}`;

        const genderClass = char.gender && char.gender.includes('男') ? 'gender-male' : 'gender-female';
        const originalText = char.original_text || `${char.name || '角色'}：${char.gender || ''}，${char.age || ''}，${char.era || ''}时代`;

        card.innerHTML = `
            <div class="config-header">
                <span class="char-index-badge ${genderClass}">${index + 1}</span>
                <input type="text" class="cp-input name-input" id="char-name-${index}"
                       value="${char.name || ''}" placeholder="角色名">
                <span class="char-tags-mini">${char.gender || ''} · ${char.age || ''}</span>
            </div>

            <div class="prompt-display cp-panel">
                <p class="char-original-text">${originalText}</p>
            </div>

            <div class="selection-row">
                <div class="selection-box cp-panel" id="box-face-${index}" onclick="openModal(${index}, 'face')">
                    <div class="box-title">脸部</div>
                    <div class="preview-area" id="preview-face-${index}">
                        <span class="empty-text">+</span>
                    </div>
                </div>

                <div class="selection-box cp-panel" id="box-hair-${index}" onclick="openModal(${index}, 'hair')">
                    <div class="box-title">发型</div>
                    <div class="preview-area" id="preview-hair-${index}">
                        <span class="empty-text">+</span>
                    </div>
                </div>

                <div class="selection-box cp-panel" id="box-clothes-${index}" onclick="openModal(${index}, 'clothes')">
                    <div class="box-title">服装</div>
                    <div class="preview-area" id="preview-clothes-${index}">
                        <span class="empty-text">+</span>
                    </div>
                </div>
            </div>

            <div class="card-actions" style="display: flex; align-items: stretch; gap: var(--cp-spacing-sm);">
                <select id="gen-count-${index}" class="cp-input" style="width: 80px; flex-shrink: 0; padding: 0 var(--cp-spacing-sm);">
                    <option value="1">1 张</option>
                    <option value="2">2 张</option>
                    <option value="3">3 张</option>
                    <option value="4">4 张</option>
                </select>
                <button class="cp-btn cp-btn-warning action-generate" id="gen-btn-${index}" disabled
                        onclick="generateForCharacter(${index})" style="flex-grow: 1;">
                    生成 / GENERATE
                </button>
            </div>
        `;

        charactersContainer.appendChild(card);
    });
}

// =============================================
// 选择部件弹窗（只显示匹配的图片）
// =============================================
window.openModal = async (charIndex, type) => {
    currentModalCharIndex = charIndex;
    currentModalPartType = type;

    const char = allCharacters[charIndex];
    const gender = char.gender || '女';
    const genderKey = gender.includes('男') ? 'male' : 'female';
    const genderName = genderKey === 'male' ? '男' : '女';

    const titleMap = { face: '选择脸部', hair: '选择发型', clothes: '选择服装' };
    modalTitle.innerText = `${char.name || '角色'} - ${titleMap[type]} (${genderName}性)`;

    modalGrid.innerHTML = '<p style="color:var(--cp-text-muted);text-align:center;padding:20px;">加载中...</p>';
    modal.classList.remove('hidden');

    // 从预加载的图片中获取
    let allImages = allAvailableImages[genderKey][type];

    // 过滤出匹配当前角色的图片
    let matchedImages = allImages.filter(img => {
        // 必须有标签文件
        if (!img.tags || img.tags.length === 0) return false;
        // 必须匹配当前角色
        return img.matchedCharacters && img.matchedCharacters.includes(charIndex);
    });

    modalGrid.innerHTML = '';

    if (matchedImages.length === 0) {
        modalGrid.innerHTML = `
            <div class="no-match-message">
                <p>没有找到匹配的图片</p>
                <p class="hint">标签要求: ${char.gender || ''}，${char.age || ''}</p>
                <p class="hint">请确保图片文件夹中有对应的 .txt 标签文件</p>
            </div>
        `;
    } else {
        matchedImages.forEach(img => {
            const div = document.createElement('div');
            div.className = 'grid-item';
            div.innerHTML = `
                <img src="${IMAGES_SERVER}${img.url}" alt="${img.filename}">
                <div class="img-tags">${img.tags.slice(0, 3).join('、')}</div>
            `;
            div.onclick = () => selectItem(charIndex, type, img.url, `${IMAGES_SERVER}${img.url}`);
            modalGrid.appendChild(div);
        });
    }

    // 添加按钮
    const uploadDiv = document.createElement('div');
    uploadDiv.className = 'manual-upload-section';
    const partTypeName = type === 'face' ? '脸部' : type === 'hair' ? '头发' : '服装';
    uploadDiv.innerHTML = `
        <p class="upload-hint">没有匹配的图片？手动操作：</p>
        <p class="folder-path">目录: image/${genderKey}/${type}/</p>
        <div class="upload-buttons">
            <input type="file" id="file-input-${charIndex}-${type}" accept="image/*" style="display:none"
                   onchange="handleFileSelect(event, ${charIndex}, '${type}', '${genderKey}')">
            <button class="cp-btn cp-btn-small btn-upload" onclick="document.getElementById('file-input-${charIndex}-${type}').click()">
                📁 选择${partTypeName}图片
            </button>
            <button class="cp-btn cp-btn-small btn-switch-gender" onclick="switchModalGender('${genderKey === 'male' ? 'female' : 'male'}', '${type}', ${charIndex})">
                切换${genderKey === 'male' ? '女' : '男'}性图库
            </button>
        </div>
    `;
    modalGrid.appendChild(uploadDiv);
};

// 打开文件夹
window.openFolder = async (gender, partType) => {
    try {
        const res = await fetch(`${API_SERVER}/open-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gender, partType })
        });
        const data = await res.json();
        if (data.success) {
            console.log('已打开文件夹:', data.path);
        } else {
            alert('打开文件夹失败: ' + data.message);
        }
    } catch (err) {
        console.error('打开文件夹失败', err);
    }
};

// 处理文件选择
window.handleFileSelect = async (event, charIndex, type, genderKey) => {
    const file = event.target.files[0];
    if (!file) return;

    // 读取文件并转换为 base64
    const reader = new FileReader();
    reader.onload = async (e) => {
        const base64 = e.target.result;

        // 仅在前端显示预览，不再上传到服务器保存到对应文件夹中
        selectItem(charIndex, type, base64, base64);
    };
    reader.readAsDataURL(file);
};

// 切换性别图库（显示所有图片，包括不匹配的）
window.switchModalGender = (genderKey, type, charIndex) => {
    const char = allCharacters[charIndex];
    let allImages = allAvailableImages[genderKey][type];

    modalGrid.innerHTML = '';

    if (allImages.length === 0) {
        modalGrid.innerHTML = `
            <div class="no-match-message">
                <p>${genderKey === 'male' ? '男' : '女'}性图库中没有图片</p>
            </div>
        `;
    } else {
        allImages.forEach(img => {
            const isMatched = img.matchedCharacters && img.matchedCharacters.includes(charIndex);
            const div = document.createElement('div');
            div.className = `grid-item ${isMatched ? '' : 'not-matched'}`;
            div.innerHTML = `
                <img src="${IMAGES_SERVER}${img.url}" alt="${img.filename}">
                ${img.tags && img.tags.length > 0 ? `<div class="img-tags">${img.tags.slice(0, 3).join('、')}</div>` : '<div class="img-tags no-tags">无标签</div>'}
            `;
            div.onclick = () => selectItem(charIndex, type, img.url, `${IMAGES_SERVER}${img.url}`);
            modalGrid.appendChild(div);
        });
    }

    // 重新添加按钮
    const uploadDiv = document.createElement('div');
    uploadDiv.className = 'manual-upload-section';
    const partTypeName = type === 'face' ? '脸部' : type === 'hair' ? '头发' : '服装';
    uploadDiv.innerHTML = `
        <p class="upload-hint">手动操作：</p>
        <p class="folder-path">目录: image/${genderKey}/${type}/</p>
        <div class="upload-buttons">
            <input type="file" id="file-input-switch-${charIndex}-${type}" accept="image/*" style="display:none"
                   onchange="handleFileSelect(event, ${charIndex}, '${type}', '${genderKey}')">
            <button class="cp-btn cp-btn-small btn-upload" onclick="document.getElementById('file-input-switch-${charIndex}-${type}').click()">
                📁 选择${partTypeName}图片
            </button>
            <button class="cp-btn cp-btn-small btn-switch-gender" onclick="switchModalGender('${genderKey === 'male' ? 'female' : 'male'}', '${type}', ${charIndex})">
                切换${genderKey === 'male' ? '女' : '男'}性图库
            </button>
        </div>
    `;
    modalGrid.appendChild(uploadDiv);
};

window.closeModal = () => {
    modal.classList.add('hidden');
    currentModalCharIndex = null;
    currentModalPartType = null;
};

function selectItem(charIndex, type, imgPath, fullUrl) {
    // 对于本地图片，使用完整URL；对于base64图片，直接使用base64数据
    const previewUrl = fullUrl;

    characterStates[charIndex][type] = fullUrl;

    // 更新对应卡片的预览
    const box = document.getElementById(`box-${type}-${charIndex}`);
    const preview = document.getElementById(`preview-${type}-${charIndex}`);
    if (preview) {
        preview.innerHTML = `<img src="${previewUrl}">`;
    }
    if (box) {
        box.classList.add('selected');
    }

    closeModal();
    checkGenerateBtn(charIndex);
}

function checkGenerateBtn(charIndex) {
    const state = characterStates[charIndex];
    const btn = document.getElementById(`gen-btn-${charIndex}`);
    if (state && state.face && state.hair && state.clothes && btn) {
        btn.disabled = false;
    }
}

// =============================================
// 本地拼接图片函数
// =============================================
async function mergeImages(faceUrl, hairUrl, clothesUrl) {
    return new Promise((resolve, reject) => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // 设置拼接后图片的尺寸 (三张图横向排列)
        const imgWidth = 512;
        const imgHeight = 768;
        canvas.width = imgWidth * 3;
        canvas.height = imgHeight;

        // 绘制白色背景
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // 加载图片
        const loadImg = (url) => {
            return new Promise((res, rej) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => res(img);
                img.onerror = rej;
                img.src = url;
            });
        };

        Promise.all([
            loadImg(faceUrl),
            loadImg(hairUrl),
            loadImg(clothesUrl)
        ]).then(([faceImg, hairImg, clothesImg]) => {
            // 从左到右依次绘制：脸部、发型、服装
            ctx.drawImage(faceImg, 0, 0, imgWidth, imgHeight);
            ctx.drawImage(hairImg, imgWidth, 0, imgWidth, imgHeight);
            ctx.drawImage(clothesImg, imgWidth * 2, 0, imgWidth, imgHeight);

            // 转换为 base64
            const mergedBase64 = canvas.toDataURL('image/png');
            resolve(mergedBase64);
        }).catch(reject);
    });
}

// =============================================
// 为单个角色生成融合图
// =============================================
window.generateForCharacter = async (charIndex) => {
    const char = allCharacters[charIndex];
    const state = characterStates[charIndex];
    const btn = document.getElementById(`gen-btn-${charIndex}`);
    const apiKey = apiKeyInput.value.trim();

    if (!apiKey) return alert('请输入 API Key');

    btn.disabled = true;
    btn.innerText = '拼接图片中...';

    const loadingOverlay = document.getElementById('loading-overlay');
    loadingOverlay.classList.remove('hidden');

    // 检查并获取生成数量
    const countSelect = document.getElementById(`gen-count-${charIndex}`);
    const genCount = countSelect ? parseInt(countSelect.value, 10) : 1;

    try {
        // 第一步：本地拼接三张图片
        btn.innerText = '拼接图片中...';
        const mergedImageBase64 = await mergeImages(state.face, state.hair, state.clothes);
        console.log('[图片拼接完成]');

        // 第二步：循环生成并上传
        document.getElementById('result-placeholder').classList.add('hidden');
        const resultGrid = document.getElementById('result-grid');
        resultGrid.innerHTML = ''; // 清空现有图片
        resultGrid.classList.remove('hidden');

        // 设置角色名
        const nameInput = document.getElementById(`char-name-${charIndex}`);
        const name = nameInput ? nameInput.value.trim() : char.name || '未命名角色';
        resultCharName.innerText = name;

        // 保存当前所有生成结果的URLs用于批量下载
        window._currentBatchResultUrls = [];
        window._currentCharName = name;

        for (let i = 0; i < genCount; i++) {
            const loadingText = document.getElementById('loading-text');
            if (loadingText) loadingText.innerText = `融合中 ... (${i + 1}/${genCount})`;
            btn.innerText = `上传生成中...(${i + 1}/${genCount})`;

            const reqBody = {
                apiKey: apiKey,
                image: mergedImageBase64,
                prompt: "将图中的发型、人物脸部、服装，融合成一个新的人物，保持人物画风不变，纯白色背景，全身照，正对镜头，双手自然下垂。"
            };

            const res = await fetch(`${API_SERVER}/generate-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(reqBody)
            });
            const data = await res.json();

            if (data.success) {
                const currentResultImageUrl = data.imageUrl;
                window._currentBatchResultUrls.push(currentResultImageUrl);

                // 往结果网格里追加图片
                const imgEl = document.createElement('img');
                imgEl.src = currentResultImageUrl;
                imgEl.alt = `Fusion Result ${i + 1}`;
                resultGrid.appendChild(imgEl);

                // --- 将生成的图片保存到历史记录 ---
                try {
                    let finalBase64ToSave = null;
                    if (currentResultImageUrl.startsWith('data:image')) {
                        finalBase64ToSave = currentResultImageUrl;
                    } else {
                        btn.innerText = `正在保存历史记录...(${i + 1}/${genCount})`;
                        const imgRes = await fetch(currentResultImageUrl);
                        const blob = await imgRes.blob();
                        finalBase64ToSave = await new Promise((res, rej) => {
                            const reader = new FileReader();
                            reader.onloadend = () => res(reader.result);
                            reader.onerror = rej;
                            reader.readAsDataURL(blob);
                        });
                    }
                    await saveHistoryImage(finalBase64ToSave, name);
                    console.log(`[历史记录保存成功] ${name} (${i + 1}/${genCount})`);
                } catch (err) {
                    console.error('[历史保存失败]', err);
                }
            } else {
                alert(`第 ${i + 1} 张生成失败: ${data.message}`);
                // 如果一张失败，可以选择退出循环或者继续，这里选择弹窗提示后记录错误但不抛出致命异常
            }
        }

        if (window._currentBatchResultUrls.length > 0) {
            downloadBtn.classList.remove('hidden');
        }

    } catch (err) {
        console.error(err);
        alert('接口请求错误，请查阅控制台');
    } finally {
        btn.disabled = false;
        btn.innerText = `生成 / GENERATE`;
        loadingOverlay.classList.add('hidden');
    }
};

// =============================================
// 下载图片（主界面当前生成结果在用，支持批量下载）
// =============================================
downloadBtn.addEventListener('click', async () => {
    const urls = window._currentBatchResultUrls || [];
    if (urls.length === 0) return;

    const baseName = window._currentCharName || 'fusion_character';

    urls.forEach(async (url, idx) => {
        const filename = urls.length > 1 ? `${baseName}_${idx + 1}.png` : `${baseName}.png`;

        try {
            const res = await fetch(url);
            const blob = await res.blob();
            const blobUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(blobUrl);
            document.body.removeChild(a);
        } catch (err) {
            console.error("Failed to download image:", err);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.target = '_blank';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    });
});

// =============================================
// 历史记录界面功能
// =============================================
if (historyBtn) {
    historyBtn.addEventListener('click', async () => {
        historyGrid.innerHTML = '<p style="text-align:center;width:100%;color:var(--cp-text-muted);">读取中...</p>';
        historyModal.classList.remove('hidden');

        try {
            const historyItems = await getAllHistory();
            if (historyCount) historyCount.innerText = historyItems.length;

            if (historyItems.length === 0) {
                historyGrid.innerHTML = `
                    <div class="no-match-message">
                        <p>暂无生成历史记录</p>
                        <p class="hint">您生成的角色融合图片会保存在这里</p>
                    </div>
                `;
                return;
            }

            historyGrid.innerHTML = '';
            historyItems.forEach(item => {
                const date = new Date(item.timestamp).toLocaleString();

                const div = document.createElement('div');
                div.className = 'history-item-card';
                div.innerHTML = `
                    <div class="history-img-wrapper">
                        <img src="${item.image}" alt="${item.charName}">
                    </div>
                    <div class="history-info">
                        <div class="history-name">${item.charName}</div>
                        <div class="history-date">${date}</div>
                        <button class="cp-btn cp-btn-small btn-history-download" onclick="downloadDataUrl('${item.image}', '${item.charName}')">
                            ⏬ 下载
                        </button>
                    </div>
                `;
                historyGrid.appendChild(div);
            });
        } catch (err) {
            console.error("加载历史记录失败", err);
            historyGrid.innerHTML = '<p style="text-align:center;width:100%;color:var(--cp-color-error);">加载失败</p>';
        }
    });
}

window.closeHistoryModal = () => {
    historyModal.classList.add('hidden');
};

window.downloadDataUrl = (dataUrl, name) => {
    const filename = `${name}_${Date.now()}.png`;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
};

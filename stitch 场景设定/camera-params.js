// =============================================
// 相机参数模块 - 共享组件
// 用于角色锻造 & 场景锻造
// =============================================

(function() {
'use strict';

// =============================================
// 相机参数数据
// =============================================
const CAMERA_BODIES = [
  { id: 'venice', name: 'Sony Venice 2', desc: '8.6K超清·16+档动态范围·零噪点', promptContext: 'CAMERA: Sony Venice 2 with full-frame 8.6K sensor. VISUAL CHARACTERISTICS: Ultra-clean digital image with near-zero noise floor. 16+ stops dynamic range. Color science features neutral-to-cool shadows, warm highlights, and accurate skin tones. Extremely sharp with pristine micro-contrast. Modern clinical aesthetic with deep blacks and clean highlights.' },
  { id: 'imax', name: 'IMAX 15/70', desc: '70mm胶片·极致分辨率·史诗颗粒感', promptContext: 'CAMERA: IMAX 15/70mm film camera (70mm film, 15 perforations horizontal). VISUAL CHARACTERISTICS: Extremely high resolution (12K+ equivalent). Fine organic film grain visible. Shallow depth of field for ultra-wide shots. Epic sense of scale and grandeur. Rich texture and density. Warm color saturation with increased contrast.' },
  { id: 'alexa', name: 'Arri Alexa Mini', desc: 'Super35·传奇色彩科学·肤色柔和', promptContext: 'CAMERA: ARRI Alexa Mini with Super 35mm sensor. VISUAL CHARACTERISTICS: Legendary ARRI color science with soft highlight roll-off. Natural and pleasing skin tones with slight warmth. 14+ stops dynamic range with clean shadows. Organic look with subtle digital noise. Moderate sharpness with gentle contrast.' },
  { id: 'komodo', name: 'RED Komodo', desc: '全局快门·锐利高对比·动作感', promptContext: 'CAMERA: RED Komodo 6K with global shutter. VISUAL CHARACTERISTICS: Global shutter eliminates rolling shutter artifacts. Punchy and vibrant colors with RED IPP2 color science. High contrast with hard edge definition. Clinical sharpness with enhanced micro-contrast. Slightly cooler color temperature.' },
  { id: '16mm', name: 'Bolex 16mm', desc: '复古16mm胶片·怀旧颗粒·边缘模糊', promptContext: 'CAMERA: Vintage Bolex H16 reflex 16mm film camera. VISUAL CHARACTERISTICS: Heavy and coarse film grain throughout. Soft focus with reduced sharpness. Significant lens vignetting. Occasional light leaks and flares. Warm/sepia color shift. Nostalgic home-movie aesthetic.' },
  { id: 'vhs', name: 'Camcorder VHS', desc: '90年代录像机·低保真·扫描线', promptContext: 'CAMERA: 1990s consumer VHS camcorder. VISUAL CHARACTERISTICS: Low resolution with soft details. Visible horizontal scan lines and interlacing artifacts. Chromatic aberration on high-contrast edges. Washed-out colors. Bleeding highlights. Glitch aesthetic.' }
];

const FOCAL_LENGTHS = [
  { id: '14mm', name: '14mm 超广角', desc: '极宽视野·强透视变形·史诗大场景', promptContext: 'FOCAL LENGTH: 14mm ultra-wide angle. FIELD OF VIEW: ~114° diagonal. PERSPECTIVE: Extreme perspective distortion - dramatic size relationships. Grand, expansive, dramatic perspective that emphasizes environment over subject.' },
  { id: '24mm', name: '24mm 广角', desc: '风景环境人像·视野开阔·有冲击力', promptContext: 'FOCAL LENGTH: 24mm wide angle. FIELD OF VIEW: ~84° diagonal. PERSPECTIVE: Noticeable but controlled wide-angle perspective. Natural wide view with context, classic storytelling focal length.' },
  { id: '35mm', name: '35mm 人文', desc: '经典纪实·适中环境感·接近人眼', promptContext: 'FOCAL LENGTH: 35mm classic documentary. FIELD OF VIEW: ~63° diagonal. PERSPECTIVE: Similar to human vision. Balanced subject and environment. Honest, realistic representation with environmental context.' },
  { id: '50mm', name: '50mm 标准', desc: '人眼视角·真实透视·畸变极小', promptContext: 'FOCAL LENGTH: 50mm standard. FIELD OF VIEW: ~47° diagonal. PERSPECTIVE: Completely natural and realistic. No perspective exaggeration. What you see is what you get.' },
  { id: '85mm', name: '85mm 人像', desc: '特写首选·空间压缩·主体分离', promptContext: 'FOCAL LENGTH: 85mm portrait telephoto. FIELD OF VIEW: ~28° diagonal. PERSPECTIVE: Flattering compression. Enhanced depth separation isolates subject. Professional portrait look.' },
  { id: '135mm', name: '135mm 长焦', desc: '强空间压缩·背景如墙·极致分离', promptContext: 'FOCAL LENGTH: 135mm short telephoto. FIELD OF VIEW: ~18° diagonal. PERSPECTIVE: Strong compression. Background feels like a wall behind subject. Intimate, compressed look with strong subject isolation.' },
  { id: '200mm', name: '200mm 超长焦', desc: '极致压缩·抽象背景·局部特写', promptContext: 'FOCAL LENGTH: 200mm super-telephoto. FIELD OF VIEW: ~12° diagonal. PERSPECTIVE: Extreme compression. Background becomes abstract color/texture. Total subject isolation.' }
];

const APERTURES = [
  { id: 'f0.95', name: 'f/0.95 梦幻', desc: '景深如纸·背景融化为光斑·夜神', promptContext: 'APERTURE: f/0.95 ultra-fast prime. DEPTH OF FIELD: Extremely thin. Only focal point razor sharp. BOKEH: Background completely melts into large dreamy orbs. Ethereal, painterly background abstraction.' },
  { id: 'f1.4', name: 'f/1.4 大光圈', desc: '刀锐奶化·主体突出·背景柔美', promptContext: 'APERTURE: f/1.4 fast prime. DEPTH OF FIELD: Very shallow. BOKEH: Creamy, smooth circular highlights. Strong subject separation. Professional fast prime look with creamy background.' },
  { id: 'f2.8', name: 'f/2.8 电影感', desc: '电影标准光圈·主体清晰·适度分离', promptContext: 'APERTURE: f/2.8 standard cinema zoom. DEPTH OF FIELD: Shallow but manageable. Classic Hollywood cinematic look with subject focus and environmental context.' },
  { id: 'f4', name: 'f/4 通用', desc: '最佳锐度·景深适中·画面扎实', promptContext: 'APERTURE: f/4 sweet spot. DEPTH OF FIELD: Moderate. SHARPNESS: Optimal lens performance. Clean, crisp, high-fidelity look with maximum detail.' },
  { id: 'f5.6', name: 'f/5.6 纪实', desc: '环境清晰·适合叙事·自然还原', promptContext: 'APERTURE: f/5.6 documentary standard. DEPTH OF FIELD: Good depth. Excellent sharpness across frame. Natural, realistic representation of scene.' },
  { id: 'f11', name: 'f/11 全深', desc: '远近都清晰·风景大场景·无虚化', promptContext: 'APERTURE: f/11 deep focus. DEPTH OF FIELD: Everything from foreground to background is sharp. Edge-to-edge sharpness. No bokeh.' }
];

const FILTERS = [
  { id: 'std', name: '标准色彩', desc: '中性自然·还原真实场景', color: '#9CA3AF', promptContext: 'Color Grade: Standard Natural. True-to-life colors, neutral white balance, standard contrast, realistic lighting.' },
  { id: 'teal-orange', name: '青橙色调', desc: '好莱坞大片·冷影暖光', color: '#F97316', promptContext: 'Color Grade: Teal & Orange Blockbuster. Cyan/Blue shadows and Warm/Orange highlights, high contrast, hollywood action movie look.' },
  { id: 'bw-noir', name: '黑色电影', desc: '高对比黑白·神秘光影', color: '#1F2937', promptContext: 'Color Grade: Film Noir B&W. Black and white, high contrast, dramatic chiaroscuro lighting, deep shadows, moody atmosphere.' },
  { id: 'portra', name: 'Portra 400', desc: '温暖胶片·肤色透亮', color: '#FCD34D', promptContext: 'Color Grade: Kodak Portra 400. Warm pastel tones, fine grain, glowing highlights, vibrant natural skin tones, slightly overexposed film look.' },
  { id: 'cyber', name: '赛博朋克', desc: '霓虹色调·紫红青蓝', color: '#D946EF', promptContext: 'Color Grade: Cyberpunk Neon. High saturation, Magenta/Purple/Cyan lighting, dark futuristic atmosphere, neon glow.' },
  { id: 'vintage', name: '复古泛黄', desc: '低饱和·褐色·老照片', color: '#78350F', promptContext: 'Color Grade: Vintage Sepia. Low saturation, brown/sepia tint, faded blacks, aged paper texture, retro 70s vibe.' }
];

const ANGLES = [
  { id: 'none', name: '默认视角', desc: '不指定，AI自由发挥', promptContext: '' },
  { id: 'left', name: '向左 90°', desc: '视角左转90度', promptContext: '视角向左转移90度，展现左侧场景' },
  { id: 'right', name: '向右 90°', desc: '视角右转90度', promptContext: '视角向右转移90度，展现右侧场景' },
  { id: 'reverse', name: '反向 180°', desc: '视角反转，展现对面', promptContext: '视角向后转移180度角，展现对面场景' },
  { id: 'push-in', name: '近景 (推进)', desc: '镜头拉近聚焦', promptContext: '视角镜头拉近，向中心聚焦' },
  { id: 'pull-out', name: '远景 (拉远)', desc: '镜头拉远50%', promptContext: '视角镜头拉远50%，扩展四周环境' },
  { id: 'core', name: '核心区域', desc: '聚焦核心元素近景', promptContext: '镜头聚焦到场景核心元素，展现近景' }
];

// =============================================
// 全局状态
// =============================================
window.cameraParams = window.cameraParams || {
  body: CAMERA_BODIES[0],
  focal: FOCAL_LENGTHS[0],
  aperture: APERTURES[2],
  filter: FILTERS[0],
  angle: ANGLES[0]
};
window.cameraEnabled = window.cameraEnabled || false;

// =============================================
// 获取相机提示词
// =============================================
window.getCameraPromptString = function() {
  if (!window.cameraEnabled) return '';
  const p = window.cameraParams;
  const parts = [];
  if (p.body && p.body.promptContext) parts.push(p.body.promptContext);
  if (p.focal && p.focal.promptContext) parts.push(p.focal.promptContext);
  if (p.aperture && p.aperture.promptContext) parts.push(p.aperture.promptContext);
  if (p.filter && p.filter.promptContext) parts.push(p.filter.promptContext);
  if (p.angle && p.angle.promptContext) parts.push(p.angle.promptContext);
  return parts.join(' ');
};

// =============================================
// 获取当前相机摘要文本
// =============================================
window.getCameraSummary = function() {
  const p = window.cameraParams;
  return `${p.body.name} · ${p.focal.name.split(' ')[0]} · ${p.aperture.name.split(' ')[0]}`;
};

// =============================================
// DrumPicker - 纯JS滚轮选择器
// =============================================
function createDrumPicker(container, items, selectedId, onSelect, renderFn) {
  const itemHeight = 72;
  const visibleItems = 5;
  const containerHeight = itemHeight * visibleItems;
  const paddingHeight = (containerHeight - itemHeight) / 2;

  let selectedIndex = items.findIndex(it => it.id === selectedId);
  if (selectedIndex < 0) selectedIndex = 0;
  let scrollTop = selectedIndex * itemHeight;
  let isDragging = false, startY = 0, startScrollTop = 0, lastY = 0, lastTime = 0;

  container.innerHTML = '';
  container.style.height = containerHeight + 'px';
  container.style.position = 'relative';
  container.style.overflow = 'hidden';
  container.style.cursor = 'grab';
  container.style.userSelect = 'none';

  // 顶部渐变
  const topMask = document.createElement('div');
  topMask.style.cssText = `position:absolute;top:0;left:0;right:0;height:${paddingHeight}px;z-index:10;pointer-events:none;background:linear-gradient(to bottom, rgba(13,6,5,1) 0%, rgba(13,6,5,0) 100%)`;
  container.appendChild(topMask);

  // 底部渐变
  const botMask = document.createElement('div');
  botMask.style.cssText = `position:absolute;bottom:0;left:0;right:0;height:${paddingHeight}px;z-index:10;pointer-events:none;background:linear-gradient(to top, rgba(13,6,5,1) 0%, rgba(13,6,5,0) 100%)`;
  container.appendChild(botMask);

  // 中间选中指示器
  const indicator = document.createElement('div');
  indicator.style.cssText = `position:absolute;left:0;right:0;top:${paddingHeight}px;height:${itemHeight}px;z-index:5;pointer-events:none;border-top:1px solid rgba(255,94,0,0.3);border-bottom:1px solid rgba(255,94,0,0.3);background:linear-gradient(to bottom, transparent, rgba(255,94,0,0.08), transparent)`;
  container.appendChild(indicator);

  // 项目容器
  const itemsWrap = document.createElement('div');
  itemsWrap.style.cssText = `position:relative;width:100%`;
  container.appendChild(itemsWrap);

  // 渲染项目
  const itemEls = [];
  items.forEach((item, index) => {
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;left:0;right:0;height:${itemHeight}px;top:${index * itemHeight}px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all 0.2s ease-out;padding:0 16px`;
    el.innerHTML = renderFn(item, item.id === selectedId);
    el.addEventListener('click', () => {
      selectedIndex = index;
      scrollTop = selectedIndex * itemHeight;
      onSelect(item);
      updatePositions();
    });
    itemsWrap.appendChild(el);
    itemEls.push(el);
  });

  function updatePositions(animate) {
    itemsWrap.style.transform = `translateY(${-scrollTop + paddingHeight}px)`;
    itemsWrap.style.transition = animate !== false ? 'transform 0.25s ease-out' : 'none';

    itemEls.forEach((el, i) => {
      const dist = Math.abs((scrollTop - i * itemHeight) / itemHeight);
      const opacity = Math.max(0.25, 1 - dist * 0.35);
      const scale = (i === selectedIndex) ? 1.05 : Math.max(0.88, 1 - dist * 0.1);
      el.style.opacity = opacity;
      el.style.transform = `scale(${scale})`;
      el.innerHTML = renderFn(items[i], i === selectedIndex);
    });
  }

  function snapToNearest() {
    selectedIndex = Math.round(scrollTop / itemHeight);
    selectedIndex = Math.max(0, Math.min(items.length - 1, selectedIndex));
    scrollTop = selectedIndex * itemHeight;
    onSelect(items[selectedIndex]);
    updatePositions(true);
  }

  // 鼠标拖拽
  container.addEventListener('mousedown', e => {
    isDragging = true; startY = e.clientY; startScrollTop = scrollTop; lastY = e.clientY; lastTime = performance.now();
    container.style.cursor = 'grabbing';
  });
  container.addEventListener('mousemove', e => {
    if (!isDragging) return;
    const delta = startY - e.clientY;
    scrollTop = Math.max(-paddingHeight, Math.min((items.length - 1) * itemHeight + paddingHeight, startScrollTop + delta));
    lastY = e.clientY; lastTime = performance.now();
    updatePositions(false);
  });
  const endDrag = () => { if (isDragging) { isDragging = false; container.style.cursor = 'grab'; snapToNearest(); } };
  container.addEventListener('mouseup', endDrag);
  container.addEventListener('mouseleave', endDrag);

  // 触摸支持
  container.addEventListener('touchstart', e => {
    isDragging = true; startY = e.touches[0].clientY; startScrollTop = scrollTop;
  }, { passive: true });
  container.addEventListener('touchmove', e => {
    if (!isDragging) return;
    const delta = startY - e.touches[0].clientY;
    scrollTop = Math.max(-paddingHeight, Math.min((items.length - 1) * itemHeight + paddingHeight, startScrollTop + delta));
    updatePositions(false);
  }, { passive: true });
  container.addEventListener('touchend', () => { isDragging = false; snapToNearest(); });

  // 鼠标滚轮
  container.addEventListener('wheel', e => {
    e.preventDefault();
    scrollTop = Math.max(-paddingHeight, Math.min((items.length - 1) * itemHeight + paddingHeight, scrollTop + e.deltaY));
    updatePositions(false);
    clearTimeout(container._wheelTimer);
    container._wheelTimer = setTimeout(snapToNearest, 150);
  }, { passive: false });

  updatePositions(false);
}

// =============================================
// 打开相机参数模态框
// =============================================
window.openCameraParamsModal = function() {
  document.getElementById('camera-params-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'camera-params-modal';
  overlay.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[9999]';
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  const panel = document.createElement('div');
  panel.className = 'bg-[#0d0605] border border-orange-900/60 w-[560px] max-h-[85vh] overflow-hidden flex flex-col';
  panel.onclick = e => e.stopPropagation();

  // 头部
  panel.innerHTML = `
    <div class="p-4 border-b border-orange-900/40 flex justify-between items-center flex-shrink-0">
      <div class="flex items-center gap-2">
        <span class="text-lg">📷</span>
        <span class="text-sm font-bold text-orange-500">相机参数设置</span>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="window.cameraEnabled=false; updateCameraButton(); document.getElementById('camera-params-modal').remove();" class="px-3 py-1 text-[10px] text-red-400 border border-red-600/40 hover:bg-red-600 hover:text-white transition-all font-bold">关闭相机</button>
        <button onclick="document.getElementById('camera-params-modal').remove()" class="text-orange-600 hover:text-white text-lg">✕</button>
      </div>
    </div>
    <div class="flex border-b border-orange-900/30 flex-shrink-0" id="cam-tabs"></div>
    <div class="flex-1 overflow-hidden relative" id="cam-picker-area"></div>
    <div class="p-3 border-t border-orange-900/30 flex justify-between items-center flex-shrink-0 bg-orange-950/10">
      <div class="text-[10px] text-orange-600" id="cam-summary"></div>
      <button onclick="window.cameraEnabled=true; updateCameraButton(); document.getElementById('camera-params-modal').remove();" class="px-4 py-1.5 bg-[#ff5e00] text-white text-xs font-bold hover:bg-orange-500 transition-all">✅ 启用并确认</button>
    </div>`;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const tabs = [
    { key: 'body', label: '机身 / BODY', data: CAMERA_BODIES },
    { key: 'focal', label: '焦距 / FOCAL', data: FOCAL_LENGTHS },
    { key: 'aperture', label: '光圈 / APERTURE', data: APERTURES },
    { key: 'filter', label: '胶片 / FILTER', data: FILTERS },
    { key: 'angle', label: '视角 / ANGLE', data: ANGLES }
  ];

  const tabsEl = document.getElementById('cam-tabs');
  const pickerArea = document.getElementById('cam-picker-area');
  let activeTab = 0;

  function renderTab(idx) {
    activeTab = idx;
    tabsEl.querySelectorAll('button').forEach((b, i) => {
      b.className = i === idx
        ? 'flex-1 py-2.5 text-[10px] font-bold text-[#ff5e00] border-b-2 border-[#ff5e00] bg-orange-950/20 transition-all'
        : 'flex-1 py-2.5 text-[10px] font-bold text-orange-600/60 border-b-2 border-transparent hover:text-orange-400 transition-all';
    });

    const tab = tabs[idx];
    pickerArea.innerHTML = '<div id="cam-drum" style="width:100%;height:100%"></div>';
    const drum = document.getElementById('cam-drum');

    const renderFn = (item, isActive) => {
      if (tab.key === 'filter') {
        return `<div class="w-full flex items-center gap-3 px-3">
          <div class="w-8 h-8 rounded-full flex-shrink-0 border ${isActive ? 'border-[#ff5e00] shadow-[0_0_8px_rgba(255,94,0,0.4)]' : 'border-orange-900/40'}" style="background:${item.color}"></div>
          <div>
            <div class="text-[11px] font-bold ${isActive ? 'text-[#ff5e00]' : 'text-orange-300'}">${item.name}</div>
            <div class="text-[8px] ${isActive ? 'text-orange-400' : 'text-orange-700'}">${item.desc}</div>
          </div>
        </div>`;
      }
      return `<div class="w-full text-center px-2">
        <div class="text-[12px] font-bold ${isActive ? 'text-[#ff5e00]' : 'text-orange-300'}">${item.name}</div>
        <div class="text-[8px] mt-0.5 ${isActive ? 'text-orange-400' : 'text-orange-700'} leading-tight">${item.desc}</div>
      </div>`;
    };

    createDrumPicker(drum, tab.data, window.cameraParams[tab.key].id, (item) => {
      window.cameraParams[tab.key] = item;
      updateSummary();
    }, renderFn);
  }

  function updateSummary() {
    const el = document.getElementById('cam-summary');
    if (el) el.textContent = getCameraSummary();
  }

  // 创建 Tab 按钮
  tabs.forEach((tab, i) => {
    const btn = document.createElement('button');
    btn.textContent = tab.label;
    btn.onclick = () => renderTab(i);
    tabsEl.appendChild(btn);
  });

  renderTab(0);
  updateSummary();
};

// =============================================
// 更新页面上的相机按钮文本
// =============================================
window.updateCameraButton = function() {
  const btns = document.querySelectorAll('.camera-params-btn-text');
  const wrappers = document.querySelectorAll('.camera-params-btn');
  btns.forEach(btn => {
    if (window.cameraEnabled) {
      btn.textContent = '📷 ' + getCameraSummary();
    } else {
      btn.textContent = '📷 相机参数';
    }
  });
  wrappers.forEach(w => {
    if (window.cameraEnabled) {
      w.classList.add('bg-[#ff5e00]', 'text-white', 'border-[#ff5e00]');
      w.classList.remove('bg-orange-950/30', 'text-orange-400', 'border-orange-600/40');
    } else {
      w.classList.remove('bg-[#ff5e00]', 'text-white', 'border-[#ff5e00]');
      w.classList.add('bg-orange-950/30', 'text-orange-400', 'border-orange-600/40');
    }
  });
};

})();

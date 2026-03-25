"""
Chinese CLIP 以文搜图 Web 应用
功能：文本搜图、图片上传、索引管理、结果可视化
"""

import torch
import torch.nn.functional as F
from PIL import Image
import os
import numpy as np
from pathlib import Path
from tqdm import tqdm
import pickle
import base64
from io import BytesIO
from datetime import datetime
import json
import threading
from typing import List, Dict, Optional

# Web 框架
from flask import Flask, render_template_string, request, jsonify, send_file
from werkzeug.utils import secure_filename

# 初始化 Flask 应用
app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB 上传限制
app.config['UPLOAD_FOLDER'] = './uploads'
app.config['GALLERY_FOLDER'] = './gallery'

# 确保目录存在
Path(app.config['UPLOAD_FOLDER']).mkdir(exist_ok=True)
Path(app.config['GALLERY_FOLDER']).mkdir(exist_ok=True)


class ChineseCLIPSearchEngine:
    """Chinese CLIP 搜索引擎核心类"""
    
    def __init__(self, model_name="OFA-Sys/chinese-clip-vit-base-patch16", device=None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.model_name = model_name
        self.model = None
        self.processor = None
        self.image_features = []
        self.image_paths = []
        self.index_built = False
        self.is_loading = False
        self.cache_dir = Path("./clip_cache")
        self.cache_dir.mkdir(exist_ok=True)
        
    def load_model(self):
        """懒加载模型"""
        if self.model is None and not self.is_loading:
            self.is_loading = True
            print(f"正在加载 Chinese CLIP 模型到 {self.device}...")
            try:
                from transformers import CLIPModel, CLIPProcessor
                self.model = CLIPModel.from_pretrained(
                        self.model_name,
                        torch_dtype=torch.float32,
                        use_safetensors=True,  # 强制使用 safetensors
                        device_map=self.device if self.device != "cpu" else None
                    )
                self.processor = CLIPProcessor.from_pretrained(self.model_name)
                self.model.eval()
                print("✓ 模型加载完成")
            except Exception as e:
                print(f"模型加载失败: {e}")
                raise
            finally:
                self.is_loading = False
    
    def extract_image_features(self, image):
        """提取图片特征"""
        self.load_model()
        inputs = self.processor(images=image, return_tensors="pt")
        pixel_values = inputs["pixel_values"].to(self.device)
        
        with torch.no_grad():
            features = self.model.get_image_features(pixel_values=pixel_values)
            features = F.normalize(features, dim=-1)
        return features.cpu().numpy().flatten()
    
    def extract_text_features(self, text):
        """提取文本特征"""
        self.load_model()
        inputs = self.processor(text=[text], return_tensors="pt", padding=True)
        input_ids = inputs["input_ids"].to(self.device)
        attention_mask = inputs["attention_mask"].to(self.device)
        
        with torch.no_grad():
            features = self.model.get_text_features(
                input_ids=input_ids,
                attention_mask=attention_mask
            )
            features = F.normalize(features, dim=-1)
        return features.cpu().numpy().flatten()
    
    def build_index(self, image_folder, progress_callback=None):
        """构建图片索引"""
        self.load_model()
        image_folder = Path(image_folder)
        
        # 收集图片
        extensions = ('.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif')
        image_files = []
        for ext in extensions:
            image_files.extend(image_folder.rglob(f"*{ext}"))
            image_files.extend(image_folder.rglob(f"*{ext.upper()}"))
        image_files = list(set(image_files))
        
        if not image_files:
            return 0
        
        # 提取特征
        self.image_features = []
        self.image_paths = []
        
        for i, img_path in enumerate(tqdm(image_files, desc="索引图片")):
            try:
                img = Image.open(img_path).convert("RGB")
                features = self.extract_image_features(img)
                self.image_features.append(features)
                self.image_paths.append(str(img_path))
                
                if progress_callback and i % 10 == 0:
                    progress_callback(i + 1, len(image_files))
            except Exception as e:
                print(f"处理失败 {img_path}: {e}")
        
        self.image_features = np.array(self.image_features)
        self.index_built = len(self.image_paths) > 0
        
        # 保存缓存
        self.save_index()
        
        return len(self.image_paths)
    
    def search(self, query, top_k=12, threshold=0.0):
        """搜索图片"""
        if not self.index_built:
            return []
        
        text_features = self.extract_text_features(query)
        similarities = np.dot(self.image_features, text_features)
        
        # 获取 top-k
        top_indices = np.argsort(similarities)[::-1][:top_k]
        
        results = []
        for idx in top_indices:
            score = float(similarities[idx])
            if score < threshold:
                continue
            
            img_path = self.image_paths[idx]
            # 生成 base64 缩略图
            try:
                with Image.open(img_path) as img:
                    img.thumbnail((300, 300))
                    buffered = BytesIO()
                    img.save(buffered, format="JPEG")
                    img_base64 = base64.b64encode(buffered.getvalue()).decode()
            except:
                img_base64 = ""
            
            results.append({
                'path': img_path,
                'score': round(score, 4),
                'filename': os.path.basename(img_path),
                'thumbnail': f"data:image/jpeg;base64,{img_base64}" if img_base64 else ""
            })
        
        return results
    
    def add_image(self, image_path):
        """添加单张图片"""
        self.load_model()
        try:
            with Image.open(image_path) as img:
                img = img.convert("RGB")
                features = self.extract_image_features(img)
                
                if not self.index_built:
                    self.image_features = np.array([features])
                    self.image_paths = [str(image_path)]
                    self.index_built = True
                else:
                    self.image_features = np.vstack([self.image_features, features])
                    self.image_paths.append(str(image_path))
                
                self.save_index()
                return True
        except Exception as e:
            print(f"添加图片失败: {e}")
            return False
    
    def save_index(self):
        """保存索引"""
        cache_file = self.cache_dir / "index.pkl"
        with open(cache_file, 'wb') as f:
            pickle.dump({
                'features': self.image_features,
                'paths': self.image_paths
            }, f)
    
    def load_index(self):
        """加载索引"""
        cache_file = self.cache_dir / "index.pkl"
        if cache_file.exists():
            with open(cache_file, 'rb') as f:
                data = pickle.load(f)
                self.image_features = data['features']
                self.image_paths = data['paths']
                self.index_built = True
            return len(self.image_paths)
        return 0
    
    def get_stats(self):
        """获取统计信息"""
        return {
            'indexed_images': len(self.image_paths),
            'index_built': self.index_built,
            'model_loaded': self.model is not None,
            'device': str(self.device)
        }


# 全局搜索引擎实例
search_engine = ChineseCLIPSearchEngine()

# HTML 模板
HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Chinese CLIP 智能搜图</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: #333;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
        }
        
        header {
            text-align: center;
            color: white;
            padding: 40px 0;
        }
        
        header h1 {
            font-size: 3em;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
        }
        
        header p {
            font-size: 1.2em;
            opacity: 0.9;
        }
        
        .main-card {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
            margin-bottom: 30px;
        }
        
        .search-section {
            padding: 40px;
            background: linear-gradient(to bottom, #f8f9fa, white);
        }
        
        .search-box {
            display: flex;
            gap: 15px;
            margin-bottom: 20px;
        }
        
        .search-input {
            flex: 1;
            padding: 18px 25px;
            font-size: 18px;
            border: 2px solid #e0e0e0;
            border-radius: 50px;
            outline: none;
            transition: all 0.3s;
        }
        
        .search-input:focus {
            border-color: #667eea;
            box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.1);
        }
        
        .search-btn {
            padding: 18px 40px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 50px;
            font-size: 18px;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        
        .search-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 30px rgba(102, 126, 234, 0.4);
        }
        
        .search-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }
        
        .quick-tags {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 15px;
        }
        
        .tag {
            padding: 8px 16px;
            background: #f0f0f0;
            border-radius: 20px;
            cursor: pointer;
            transition: all 0.2s;
            font-size: 14px;
        }
        
        .tag:hover {
            background: #667eea;
            color: white;
            transform: translateY(-1px);
        }
        
        .results-section {
            padding: 40px;
            min-height: 400px;
        }
        
        .results-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
        }
        
        .results-title {
            font-size: 1.5em;
            color: #333;
        }
        
        .results-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 25px;
        }
        
        .result-card {
            background: white;
            border-radius: 15px;
            overflow: hidden;
            box-shadow: 0 4px 15px rgba(0,0,0,0.1);
            transition: transform 0.3s, box-shadow 0.3s;
            cursor: pointer;
            position: relative;
        }
        
        .result-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 12px 30px rgba(0,0,0,0.15);
        }
        
        .result-image {
            width: 100%;
            height: 250px;
            object-fit: cover;
            background: #f0f0f0;
        }
        
        .result-info {
            padding: 15px;
        }
        
        .result-filename {
            font-size: 14px;
            color: #666;
            margin-bottom: 8px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .result-score {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .score-bar {
            flex: 1;
            height: 6px;
            background: #e0e0e0;
            border-radius: 3px;
            overflow: hidden;
        }
        
        .score-fill {
            height: 100%;
            background: linear-gradient(90deg, #667eea, #764ba2);
            border-radius: 3px;
            transition: width 0.5s ease;
        }
        
        .score-text {
            font-size: 14px;
            font-weight: bold;
            color: #667eea;
            min-width: 50px;
            text-align: right;
        }
        
        .upload-section {
            padding: 30px 40px;
            background: #f8f9fa;
            border-top: 1px solid #e0e0e0;
        }
        
        .drop-zone {
            border: 3px dashed #ccc;
            border-radius: 15px;
            padding: 60px 40px;
            text-align: center;
            transition: all 0.3s;
            cursor: pointer;
            background: white;
        }
        
        .drop-zone:hover, .drop-zone.dragover {
            border-color: #667eea;
            background: rgba(102, 126, 234, 0.05);
        }
        
        .drop-zone-icon {
            font-size: 48px;
            margin-bottom: 15px;
        }
        
        .drop-zone-text {
            font-size: 18px;
            color: #666;
            margin-bottom: 10px;
        }
        
        .drop-zone-hint {
            font-size: 14px;
            color: #999;
        }
        
        .stats-bar {
            display: flex;
            gap: 30px;
            padding: 20px 40px;
            background: #f8f9fa;
            border-bottom: 1px solid #e0e0e0;
            font-size: 14px;
            color: #666;
        }
        
        .stat-item {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .stat-value {
            font-weight: bold;
            color: #667eea;
        }
        
        .loading-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(255,255,255,0.9);
            display: none;
            justify-content: center;
            align-items: center;
            flex-direction: column;
            z-index: 1000;
        }
        
        .loading-overlay.active {
            display: flex;
        }
        
        .spinner {
            width: 60px;
            height: 60px;
            border: 4px solid #f3f3f3;
            border-top: 4px solid #667eea;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 20px;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .empty-state {
            text-align: center;
            padding: 80px 20px;
            color: #999;
        }
        
        .empty-state-icon {
            font-size: 64px;
            margin-bottom: 20px;
        }
        
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.8);
            z-index: 2000;
            justify-content: center;
            align-items: center;
            padding: 40px;
        }
        
        .modal.active {
            display: flex;
        }
        
        .modal-content {
            max-width: 90%;
            max-height: 90%;
            position: relative;
        }
        
        .modal-image {
            max-width: 100%;
            max-height: 80vh;
            border-radius: 10px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        }
        
        .modal-close {
            position: absolute;
            top: -40px;
            right: 0;
            color: white;
            font-size: 36px;
            cursor: pointer;
            background: none;
            border: none;
        }
        
        .toast {
            position: fixed;
            bottom: 30px;
            left: 50%;
            transform: translateX(-50%) translateY(100px);
            background: #333;
            color: white;
            padding: 15px 30px;
            border-radius: 50px;
            opacity: 0;
            transition: all 0.3s;
            z-index: 3000;
        }
        
        .toast.show {
            transform: translateX(-50%) translateY(0);
            opacity: 1;
        }
        
        .progress-bar {
            width: 100%;
            height: 4px;
            background: #e0e0e0;
            border-radius: 2px;
            overflow: hidden;
            margin-top: 10px;
            display: none;
        }
        
        .progress-bar.active {
            display: block;
        }
        
        .progress-fill {
            height: 100%;
            background: #667eea;
            width: 0%;
            transition: width 0.3s;
        }
    </style>
</head>
<body>
    <div class="loading-overlay" id="loadingOverlay">
        <div class="spinner"></div>
        <p id="loadingText">正在处理...</p>
    </div>
    
    <div class="modal" id="imageModal" onclick="closeModal()">
        <div class="modal-content" onclick="event.stopPropagation()">
            <button class="modal-close" onclick="closeModal()">&times;</button>
            <img class="modal-image" id="modalImage" src="" alt="">
        </div>
    </div>
    
    <div class="toast" id="toast"></div>

    <div class="container">
        <header>
            <h1>🔍 Chinese CLIP 智能搜图</h1>
            <p>输入中文描述，AI 帮您找到最匹配的服装图片</p>
        </header>
        
        <div class="main-card">
            <div class="stats-bar">
                <div class="stat-item">
                    <span>📊 已索引图片:</span>
                    <span class="stat-value" id="statCount">0</span>
                </div>
                <div class="stat-item">
                    <span>⚡ 状态:</span>
                    <span class="stat-value" id="statStatus">未加载</span>
                </div>
                <div class="stat-item">
                    <span>💻 设备:</span>
                    <span class="stat-value" id="statDevice">-</span>
                </div>
            </div>
            
            <div class="search-section">
                <div class="search-box">
                    <input type="text" 
                           class="search-input" 
                           id="searchInput" 
                           placeholder="描述您想找的服装，例如：红色连衣裙、蓝色牛仔裤、白色运动鞋..."
                           onkeypress="if(event.key==='Enter') performSearch()">
                    <button class="search-btn" id="searchBtn" onclick="performSearch()">
                        搜索
                    </button>
                </div>
                
                <div class="quick-tags">
                    <span style="color: #666; margin-right: 10px;">热门搜索:</span>
                    <span class="tag" onclick="quickSearch('红色连衣裙')">红色连衣裙</span>
                    <span class="tag" onclick="quickSearch('蓝色牛仔裤')">蓝色牛仔裤</span>
                    <span class="tag" onclick="quickSearch('白色衬衫')">白色衬衫</span>
                    <span class="tag" onclick="quickSearch('黑色西装')">黑色西装</span>
                    <span class="tag" onclick="quickSearch('碎花裙子')">碎花裙子</span>
                    <span class="tag" onclick="quickSearch('运动休闲鞋')">运动休闲鞋</span>
                    <span class="tag" onclick="quickSearch('复古皮衣')">复古皮衣</span>
                    <span class="tag" onclick="quickSearch('纯棉T恤')">纯棉T恤</span>
                </div>
            </div>
            
            <div class="results-section" id="resultsSection">
                <div class="empty-state">
                    <div class="empty-state-icon">🖼️</div>
                    <h3>开始您的第一次搜索</h3>
                    <p>在上方输入服装描述，或拖拽图片到下方上传</p>
                </div>
            </div>
            
            <div class="upload-section">
                <h3 style="margin-bottom: 20px; color: #333;">📤 上传图片到图库</h3>
                <div class="drop-zone" 
                     id="dropZone"
                     onclick="document.getElementById('fileInput').click()"
                     ondrop="handleDrop(event)" 
                     ondragover="handleDragOver(event)"
                     ondragleave="handleDragLeave(event)">
                    <input type="file" 
                           id="fileInput" 
                           multiple 
                           accept="image/*" 
                           style="display: none"
                           onchange="handleFiles(this.files)">
                    <div class="drop-zone-icon">📁</div>
                    <div class="drop-zone-text">点击或拖拽图片到此处上传</div>
                    <div class="drop-zone-hint">支持 JPG、PNG、WebP 格式，单张最大 16MB</div>
                    <div class="progress-bar" id="uploadProgress">
                        <div class="progress-fill" id="progressFill"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // 页面加载时获取统计信息
        window.onload = function() {
            updateStats();
            // 尝试加载已有索引
            fetch('/api/load_index', {method: 'POST'});
        };
        
        function showLoading(text) {
            document.getElementById('loadingText').textContent = text;
            document.getElementById('loadingOverlay').classList.add('active');
        }
        
        function hideLoading() {
            document.getElementById('loadingOverlay').classList.remove('active');
        }
        
        function showToast(message) {
            const toast = document.getElementById('toast');
            toast.textContent = message;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 3000);
        }
        
        function updateStats() {
            fetch('/api/stats')
                .then(r => r.json())
                .then(data => {
                    document.getElementById('statCount').textContent = data.indexed_images;
                    document.getElementById('statStatus').textContent = 
                        data.index_built ? '就绪' : '未建索引';
                    document.getElementById('statDevice').textContent = data.device;
                });
        }
        
        function quickSearch(query) {
            document.getElementById('searchInput').value = query;
            performSearch();
        }
        
        async function performSearch() {
            const query = document.getElementById('searchInput').value.trim();
            if (!query) return;
            
            const btn = document.getElementById('searchBtn');
            btn.disabled = true;
            btn.textContent = '搜索中...';
            
            try {
                const response = await fetch('/api/search', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({query: query, top_k: 12})
                });
                
                const data = await response.json();
                
                if (data.error) {
                    showToast(data.error);
                    return;
                }
                
                displayResults(data.results, query);
            } catch (err) {
                showToast('搜索失败: ' + err.message);
            } finally {
                btn.disabled = false;
                btn.textContent = '搜索';
            }
        }
        
        function displayResults(results, query) {
            const section = document.getElementById('resultsSection');
            
            if (results.length === 0) {
                section.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">🔍</div>
                        <h3>未找到匹配结果</h3>
                        <p>尝试使用其他关键词，或上传更多图片</p>
                    </div>
                `;
                return;
            }
            
            let html = `
                <div class="results-header">
                    <h3 class="results-title">"${query}" 的搜索结果 (${results.length}个)</h3>
                </div>
                <div class="results-grid">
            `;
            
            results.forEach((item, index) => {
                const percentage = Math.round(item.score * 100);
                html += `
                    <div class="result-card" onclick="openModal('${item.path}')" style="animation: fadeIn 0.5s ease ${index * 0.1}s both;">
                        <img class="result-image" src="${item.thumbnail}" alt="${item.filename}" loading="lazy">
                        <div class="result-info">
                            <div class="result-filename" title="${item.filename}">${item.filename}</div>
                            <div class="result-score">
                                <div class="score-bar">
                                    <div class="score-fill" style="width: ${percentage}%"></div>
                                </div>
                                <span class="score-text">${item.score}</span>
                            </div>
                        </div>
                    </div>
                `;
            });
            
            html += '</div>';
            section.innerHTML = html;
        }
        
        function openModal(path) {
            document.getElementById('modalImage').src = '/api/image?path=' + encodeURIComponent(path);
            document.getElementById('imageModal').classList.add('active');
        }
        
        function closeModal() {
            document.getElementById('imageModal').classList.remove('active');
        }
        
        // 拖拽上传功能
        function handleDragOver(e) {
            e.preventDefault();
            e.currentTarget.classList.add('dragover');
        }
        
        function handleDragLeave(e) {
            e.currentTarget.classList.remove('dragover');
        }
        
        function handleDrop(e) {
            e.preventDefault();
            e.currentTarget.classList.remove('dragover');
            handleFiles(e.dataTransfer.files);
        }
        
        async function handleFiles(files) {
            if (files.length === 0) return;
            
            const progressBar = document.getElementById('uploadProgress');
            const progressFill = document.getElementById('progressFill');
            progressBar.classList.add('active');
            
            let success = 0;
            let failed = 0;
            
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (!file.type.startsWith('image/')) continue;
                
                const formData = new FormData();
                formData.append('file', file);
                
                try {
                    const response = await fetch('/api/upload', {
                        method: 'POST',
                        body: formData
                    });
                    
                    const data = await response.json();
                    if (data.success) success++;
                    else failed++;
                } catch (err) {
                    failed++;
                }
                
                // 更新进度
                const percent = ((i + 1) / files.length) * 100;
                progressFill.style.width = percent + '%';
            }
            
            setTimeout(() => {
                progressBar.classList.remove('active');
                progressFill.style.width = '0%';
                showToast(`上传完成: ${success} 成功, ${failed} 失败`);
                updateStats();
            }, 500);
        }
        
        // 添加淡入动画
        const style = document.createElement('style');
        style.textContent = `
            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(20px); }
                to { opacity: 1; transform: translateY(0); }
            }
        `;
        document.head.appendChild(style);
    </script>
</body>
</html>
"""


# API 路由
@app.route('/')
def index():
    """主页"""
    return render_template_string(HTML_TEMPLATE)


@app.route('/api/stats')
def get_stats():
    """获取统计信息"""
    return jsonify(search_engine.get_stats())


@app.route('/api/search', methods=['POST'])
def search():
    """搜索接口"""
    data = request.get_json()
    query = data.get('query', '')
    top_k = data.get('top_k', 12)
    
    if not query:
        return jsonify({'error': '请输入搜索关键词'})
    
    if not search_engine.index_built:
        return jsonify({'error': '请先上传图片或构建索引'})
    
    results = search_engine.search(query, top_k=top_k)
    return jsonify({'results': results})


@app.route('/api/upload', methods=['POST'])
def upload():
    """上传图片"""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': '没有文件'})
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'success': False, 'error': '文件名为空'})
    
    filename = secure_filename(file.filename)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_")
    filename = timestamp + filename
    
    filepath = os.path.join(app.config['GALLERY_FOLDER'], filename)
    file.save(filepath)
    
    # 添加到索引
    success = search_engine.add_image(filepath)
    
    return jsonify({
        'success': success,
        'path': filepath,
        'filename': filename
    })


@app.route('/api/image')
def get_image():
    """获取原图"""
    path = request.args.get('path', '')
    if os.path.exists(path):
        return send_file(path)
    return jsonify({'error': '图片不存在'}), 404


@app.route('/api/build_index', methods=['POST'])
def build_index():
    """构建索引（用于批量索引已有图片）"""
    def progress_callback(current, total):
        print(f"索引进度: {current}/{total}")
    
    count = search_engine.build_index(
        app.config['GALLERY_FOLDER'],
        progress_callback=progress_callback
    )
    
    return jsonify({
        'success': True,
        'indexed_count': count
    })


@app.route('/api/load_index', methods=['POST'])
def load_index():
    """加载已有索引"""
    count = search_engine.load_index()
    if count > 0:
        return jsonify({'success': True, 'count': count})
    return jsonify({'success': False, 'message': '没有现有索引'})


if __name__ == '__main__':
    print("="*60)
    print("Chinese CLIP 智能搜图系统")
    print("="*60)
    print(f"图片上传目录: {app.config['GALLERY_FOLDER']}")
    print(f"访问地址: http://localhost:5000")
    print("="*60)
    
    # 启动时尝试加载已有索引
    existing = search_engine.load_index()
    if existing > 0:
        print(f"已加载现有索引: {existing} 张图片")
    else:
        print("提示: 首次使用请上传图片或运行 build_index")
    
    # 运行 Flask 应用
    app.run(host='0.0.0.0', port=5001, debug=True, threaded=True)
# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec file for Chinese CLIP 搜图系统 (test.py)

import os

block_cipher = None

# 收集需要带入的数据目录
datas = []
for d in ['clip_cache', 'gallery', 'uploads']:
    if os.path.exists(d):
        datas.append((d, d))
    else:
        os.makedirs(d, exist_ok=True)
        datas.append((d, d))

hidden_imports = [
    'torch',
    'torch.nn',
    'torch.nn.functional',
    'torchvision',
    'transformers',
    'transformers.models.clip',
    'transformers.models.clip.modeling_clip',
    'transformers.models.clip.processing_clip',
    'transformers.models.clip.feature_extraction_clip',
    'transformers.models.clip.image_processing_clip',
    'transformers.models.clip.tokenization_clip',
    'PIL',
    'PIL.Image',
    'numpy',
    'tqdm',
    'flask',
    'werkzeug',
    'werkzeug.utils',
    'pickle',
    'base64',
    'json',
    'threading',
    'sentencepiece',
    'tokenizers',
    'regex',
    'safetensors',
    'safetensors.torch',
    'huggingface_hub',
    'filelock',
    'packaging',
    'requests',
    'urllib3',
    'certifi',
    'charset_normalizer',
    'idna',
]

a = Analysis(
    ['test.py'],
    pathex=['.'],
    binaries=[],
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'matplotlib',
        'IPython',
        'jupyter',
        'notebook',
        'tkinter',
        '_tkinter',
        'wx',
        'PyQt5',
        'PyQt6',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='Chinese_CLIP_搜图',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='Chinese_CLIP_搜图',
)

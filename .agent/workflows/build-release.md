---
description: 打包发布流程规范 - 版本号管理和打包步骤
---

# 打包发布流程规范

## ⚠️ 核心规则：每次打包必须升级版号

**每次打包新的安装包或升级补丁之前，必须先升级版本号。** 这是强制性规定，不可跳过。

## 版本号位置（必须同步修改）

需要修改以下文件中的版本号：

| 文件 | 字段 | 示例 |
|------|------|------|
| `update.iss` 第5行 | `#define MyAppVersion` | `"2.2_Patch"` |
| `update.iss` 第19行 | `OutputBaseFilename` | `角色锻造炉_v2.2_快速升级补丁` |
| `installer.iss` 第5行 | `#define MyAppVersion` | `"2.2"` |
| `installer.iss` 第19行 | `OutputBaseFilename` | `角色锻造炉_v2.2_安装包` |

## 版本号规则

- 主版本号.次版本号格式，如 `2.2`
- 升级补丁在版本号后加 `_Patch`，如 `2.2_Patch`
- 每次发布递增次版本号：`2.1` → `2.2` → `2.3`
- 重大功能变更递增主版本号：`2.x` → `3.0`

## 打包命令

### 升级补丁（快速更新，仅代码）
```powershell
& 'C:\InnoSetup\ISCC.exe' 'e:\程序\角色筛选机4.0\角色筛选机4.0\update.iss'
```

### 完整安装包（含素材库+依赖）
```powershell
& 'C:\InnoSetup\ISCC.exe' 'e:\程序\角色筛选机4.0\角色筛选机4.0\installer.iss'
```

### 素材包更新
```powershell
& 'C:\InnoSetup\ISCC.exe' 'e:\程序\角色筛选机4.0\角色筛选机4.0\image-update.iss'
```

## 输出目录

所有打包产物输出到 `e:\程序\角色筛选机4.0\角色筛选机4.0\dist\`

## 打包前检查清单

1. ✅ 确认版本号已升级（所有 `.iss` 文件）
2. ✅ 确认代码改动已保存
3. ✅ 运行 Inno Setup 编译
4. ✅ 确认 `dist\` 目录中生成了新文件

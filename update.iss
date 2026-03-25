; 角色锻造炉 v1.0 - 快速升级补丁 (仅含代码更新)
; 用于给已经安装完整包的老用户快速更新代码，无需重新下载 4GB 素材库和依赖。

#define MyAppName "酱油暖暖"
#define MyAppVersion "2.17_Patch"
#define MyAppPublisher "Character Forge"
#define SrcDir "e:\程序\角色筛选机4.0\角色筛选机4.0"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName} 更新补丁
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; 使用相同的 DefaultDirName 确保补丁直接覆盖到原安装目录
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir={#SrcDir}\dist
OutputBaseFilename=酱油暖暖_v2.17_快速升级补丁
Compression=lzma2/fast
SolidCompression=no
DiskSpanning=no
WizardStyle=modern
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
; 禁用卸载程序生成 (因为这是个补丁，不需要独立卸载)
Uninstallable=no
DirExistsWarning=no
SetupIconFile={#SrcDir}\app.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; 应用核心代码文件 (不含 node_modules, image, .cache)
; 打包核心运行时所需补充的 VC++ redist DLLs
Source: "{#SrcDir}\node\*.dll"; DestDir: "{app}\node"; Flags: ignoreversion
Source: "{#SrcDir}\server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\clip-service.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\vector-db.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\camera-params.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\.env"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\start.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\preload.cjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\electron-main.cjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\app.ico"; DestDir: "{app}"; DestName: "app_v3.ico"; Flags: ignoreversion

; 前端文件
Source: "{#SrcDir}\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs

; 运行库安装程序 (解压到系统临时目录)
Source: "{#SrcDir}\VC_redist.x64.exe"; DestDir: "{tmp}"; Flags: ignoreversion deleteafterinstall

[Icons]
; 更新快捷方式图标
Name: "{group}\{#MyAppName}"; Filename: "{app}\start.bat"; WorkingDir: "{app}"; IconFilename: "{app}\app_v3.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\start.bat"; WorkingDir: "{app}"; IconFilename: "{app}\app_v3.ico"

[Run]
Filename: "{tmp}\VC_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "正在安装底层组件库 (VC++ Redistributable)，请耐心等待..."; Flags: waituntilterminated

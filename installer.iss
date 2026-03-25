; 角色锻造炉 v1.0 - Inno Setup 安装脚本
; 包含: Node.js 运行时 + 应用代码 + 依赖 + CLIP 模型 + 图片素材库

#define MyAppName "角色锻造炉"
#define MyAppVersion "2.12"
#define MyAppPublisher "Character Forge"
#define MyAppExeName "start.bat"
#define SrcDir "e:\程序\角色筛选机4.0\角色筛选机4.0"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir={#SrcDir}\dist
OutputBaseFilename=角色锻造炉_v2.12_安装包_不含素材库
Compression=lzma2/fast
SolidCompression=no
DiskSpanning=no
WizardStyle=modern
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
UninstallDisplayName={#MyAppName}
SetupIconFile={#SrcDir}\app.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加功能:"; Flags: unchecked

[Files]
; Node.js 运行时
Source: "{#SrcDir}\node\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs createallsubdirs

; 应用核心文件
Source: "{#SrcDir}\server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\clip-service.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\vector-db.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\camera-params.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\.env"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\start.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\preload.cjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\electron-main.cjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\app.ico"; DestDir: "{app}"; Flags: ignoreversion

; 前端文件
Source: "{#SrcDir}\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs

; 场景设定
Source: "{#SrcDir}\stitch 场景设定\*"; DestDir: "{app}\stitch 场景设定"; Flags: ignoreversion recursesubdirs createallsubdirs

; node_modules (依赖)
Source: "{#SrcDir}\node_modules\*"; DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs

; CLIP 模型缓存
Source: "{#SrcDir}\.cache\*"; DestDir: "{app}\.cache"; Flags: ignoreversion recursesubdirs createallsubdirs


; 运行库安装程序 (解压到系统临时目录)
Source: "{#SrcDir}\VC_redist.x64.exe"; DestDir: "{tmp}"; Flags: ignoreversion deleteafterinstall

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\app.ico"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon; IconFilename: "{app}\app.ico"

[Run]
Filename: "{tmp}\VC_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "正在安装底层组件库 (VC++ Redistributable)，可能会耗时几分钟..."; Flags: waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent shellexec

; 角色锻造炉 - 素材升级包 (仅含新增/更新的图片素材)
; 用法：将新图片按照 image/ 相同的文件夹结构放入 image-update/ 目录，然后运行 build-image-update.bat

#define MyAppName "角色锻造炉"
#define MyAppVersion "素材包_v1.0"
#define MyAppPublisher "Character Forge"
#define SrcDir "e:\程序\角色筛选机4.0\角色筛选机4.0"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName} 素材升级包
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; 使用相同的 DefaultDirName 确保素材直接合并到原安装目录
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir={#SrcDir}\dist
OutputBaseFilename=角色锻造炉_素材升级包_v1.0
Compression=lzma2/fast
SolidCompression=yes
DiskSpanning=no
WizardStyle=modern
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
; 禁用卸载程序生成 (补丁性质)
Uninstallable=no
DirExistsWarning=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WelcomeLabel2=本程序将为 {#MyAppName} 安装新的素材图片。%n%n新图片将被合并到程序的素材库目录中，不会删除已有素材。%n%n点击"下一步"继续安装。

[Files]
; 递归复制 image-update/ 下的所有文件到 {app}\image\
; 使用 ignoreversion 确保文件被覆盖（同名图片更新为新版本）
Source: "{#SrcDir}\image-update\*"; DestDir: "{app}\image"; Flags: ignoreversion recursesubdirs createallsubdirs

[Code]
// 安装前检查 image-update 目录是否有内容
function InitializeSetup(): Boolean;
var
  FindRec: TFindRec;
  SrcPath: String;
  HasFiles: Boolean;
begin
  Result := True;
  SrcPath := ExpandConstant('{#SrcDir}\image-update');
  
  // 检查源目录是否存在
  if not DirExists(SrcPath) then
  begin
    MsgBox('错误：未找到 image-update 目录！' + #13#10 + 
           '请先将新素材放入 image-update/ 文件夹中。', mbError, MB_OK);
    Result := False;
    Exit;
  end;
end;

// 安装完成后提示
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    MsgBox('素材升级完成！' + #13#10#13#10 + 
           '新素材已合并到程序目录中。' + #13#10 +
           '重新启动角色锻造炉即可使用新素材。', mbInformation, MB_OK);
  end;
end;

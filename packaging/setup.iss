#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef PackageRoot
  #error PackageRoot must be provided by scripts/build-exe.ps1
#endif
#ifndef OutputDir
  #error OutputDir must be provided by scripts/build-exe.ps1
#endif
#ifndef AppId
  #define AppId "{{E20F73F0-A63F-4B72-BF42-CC0C949BB27D}"
#endif
#ifndef DefaultInstallDir
  #define DefaultInstallDir "{localappdata}\CodexCCSwitchUsage"
#endif

[Setup]
AppId={#AppId}
AppName=Codex CCSwitch Usage
AppVersion={#AppVersion}
AppVerName=Codex CCSwitch Usage {#AppVersion}
AppPublisher=Local
DefaultDirName={#DefaultInstallDir}
DefaultGroupName=Codex CCSwitch Usage
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=CodexCCSwitchUsage-Setup-{#AppVersion}
SetupIconFile={#PackageRoot}\assets\codex.ico
UninstallDisplayIcon={app}\CodexCCSwitchUsage.exe
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
UsePreviousAppDir=yes
MinVersion=10.0.17763
VersionInfoVersion={#AppVersion}
VersionInfoProductName=Codex CCSwitch Usage
VersionInfoDescription=Codex CCSwitch Usage installer
VersionInfoCompany=Local

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: checkedonce

[Files]
Source: "{#PackageRoot}\*"; Excludes: "runtime-bin\node.exe"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PackageRoot}\runtime-bin\node.exe"; DestDir: "{app}\runtime-bin"
Source: "{#PackageRoot}\scripts\stop-host.ps1"; Flags: dontcopy

[InstallDelete]
Type: files; Name: "{app}\scripts\instance-guard.ps1"
Type: files; Name: "{app}\scripts\migrate-default-profile.ps1"

[Dirs]
Name: "{app}\runtime"

[Icons]
Name: "{userprograms}\Codex + CCSwitch 用量"; Filename: "{app}\CodexCCSwitchUsage.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Codex + CCSwitch 用量"; Filename: "{app}\CodexCCSwitchUsage.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\CodexCCSwitchUsage.exe"; Description: "启动 Codex + CCSwitch 用量"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\runtime"
Type: dirifempty; Name: "{app}"

[Code]
function StopHost(const ScriptPath: String; AllInstances: Boolean): Boolean;
var
  ResultCode: Integer;
  Parameters: String;
begin
  Parameters := '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + ScriptPath +
    '" -InstallRoot "' + ExpandConstant('{app}') + '"';
  if AllInstances then Parameters := Parameters + ' -AllInstances';
  Result := Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    Parameters,
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  ) and (ResultCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  ExtractTemporaryFile('stop-host.ps1');
  if not StopHost(
    ExpandConstant('{tmp}\stop-host.ps1'),
    CompareText(ExpandConstant('{param:nostopall|0}'), '1') <> 0
  ) then
    Result := '无法停止旧版插件宿主，请关闭后重试。';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ScriptPath: String;
begin
  if CurUninstallStep <> usUninstall then Exit;
  ScriptPath := ExpandConstant('{app}\scripts\stop-host.ps1');
  if FileExists(ScriptPath) then StopHost(ScriptPath, False);
end;

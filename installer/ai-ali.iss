; Inno Setup script for the AI Ali Windows installer.
; Built by .github/workflows/release.yml. Installs for the current user only: no admin rights needed.
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{8F3C6B2E-6A41-4C8B-9E0D-5A1A1A11A1A1}
AppName=AI Ali
AppVersion={#AppVersion}
AppVerName=AI Ali {#AppVersion}
AppPublisher=Hassan Ali
AppPublisherURL=https://github.com/hassanaliarshad110/AIAli
AppSupportURL=https://github.com/hassanaliarshad110/AIAli/issues
DefaultDirName={localappdata}\Programs\AI Ali
DefaultGroupName=AI Ali
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=AI-Ali-Setup
SetupIconFile=..\assets\ai-ali.ico
UninstallDisplayIcon={app}\app\assets\ai-ali.ico
UninstallDisplayName=AI Ali
LicenseFile=..\LICENSE
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\build\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "..\src\*"; DestDir: "{app}\app\src"; Flags: ignoreversion recursesubdirs
Source: "..\public\*"; DestDir: "{app}\app\public"; Flags: ignoreversion recursesubdirs
Source: "..\samples\*"; DestDir: "{app}\app\samples"; Flags: ignoreversion recursesubdirs
Source: "..\assets\*"; DestDir: "{app}\app\assets"; Flags: ignoreversion recursesubdirs
Source: "..\package.json"; DestDir: "{app}\app"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}\app"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}\app"; Flags: ignoreversion
Source: "..\.env.example"; DestDir: "{app}\app"; Flags: ignoreversion

[Icons]
Name: "{group}\AI Ali"; Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\src\desktop.js"""; WorkingDir: "{app}\app"; IconFilename: "{app}\app\assets\ai-ali.ico"; Comment: "Open AI Ali"; Flags: runminimized
Name: "{group}\Uninstall AI Ali"; Filename: "{uninstallexe}"
Name: "{userdesktop}\AI Ali"; Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\src\desktop.js"""; WorkingDir: "{app}\app"; IconFilename: "{app}\app\assets\ai-ali.ico"; Comment: "Open AI Ali"; Flags: runminimized; Tasks: desktopicon

[Run]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\src\desktop.js"""; WorkingDir: "{app}\app"; Description: "Open AI Ali now"; Flags: postinstall nowait skipifsilent runminimized

[UninstallRun]
; Stop a running AI Ali before removing files. Your settings and invoices in %APPDATA%\AI Ali are kept.
Filename: "{cmd}"; Parameters: "/c taskkill /f /fi ""WINDOWTITLE eq AI Ali*"" /im node.exe"; Flags: runhidden; RunOnceId: "StopAIAli"

!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "nsProcess.nsh"

; Never allow NSIS to force-stop a worker while its financial journal is open.
!macro customCheckAppRunning
  ${If} ${isUpdated}
    Sleep 1500
  ${EndIf}
  ${nsProcess::FindProcess} "Autosell V3.exe" $R0
  ${nsProcess::FindProcess} "Autosell-Worker.exe" $R1
  ${nsProcess::Unload}
  ${If} $R0 == 0
  ${OrIf} $R1 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Autosell V3 is running. Choose Exit safely in Updates & settings or the system tray, then run setup again." /SD IDOK
    SetErrorLevel 23
    Quit
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
Var DesktopShortcutCheckbox
Var DesktopShortcutSelection

!macro customPageAfterChangeDir
  Page custom AutosellOptions AutosellOptionsLeave
!macroend

Function AutosellOptions
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 42u "Autosell V3 includes Node.js and Chromium. Minecraft 26.3, Fabric Loader 0.20.1, Java and a Minecraft account are required separately. The two bridge JARs are included."
  Pop $0
  ${NSD_CreateLabel} 0 48u 100% 35u "Payment journals, credentials, evidence and settings are stored in your local application data and are preserved during upgrades and uninstall."
  Pop $0
  ${NSD_CreateCheckbox} 0 92u 100% 16u "Create a desktop shortcut"
  Pop $DesktopShortcutCheckbox
  nsDialogs::Show
FunctionEnd

Function AutosellOptionsLeave
  ${NSD_GetState} $DesktopShortcutCheckbox $DesktopShortcutSelection
FunctionEnd

!macro customInstall
  ${If} $DesktopShortcutSelection == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\Autosell V3.lnk" "$INSTDIR\Autosell V3.exe"
  ${EndIf}
!macroend
!endif

!macro customUnInstall
  Delete "$DESKTOP\Autosell V3.lnk"
!macroend

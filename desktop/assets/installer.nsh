!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "nsProcess.nsh"
!include "Sections.nsh"
!ifdef BUILD_UNINSTALLER
Var RemoveAllDataConfirmed
!endif

!macro customUnInit
  StrCpy $RemoveAllDataConfirmed "0"
  InitPluginsDir
  File /oname=$PLUGINSDIR\autosell-remove-data.ps1 "${BUILD_RESOURCES_DIR}\remove-data.ps1"
  ${IfNot} ${isUpdated}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "--remove-all-autosell-data" $R1
    ${IfNot} ${Errors}
      ClearErrors
      ${GetOptions} $R0 "--confirm-remove-all-autosell-data" $R1
      ${IfNot} ${Errors}
        StrCpy $RemoveAllDataConfirmed "1"
        ; The built-in uninstall section is 0. The optional data section is 1.
        SectionSetFlags 1 ${SF_SELECTED}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstallSection
  Section /o "un.Remove all Autosell data" REMOVE_AUTOSELL_DATA
    ${IfNot} ${isUpdated}
      ${If} $RemoveAllDataConfirmed != "1"
        MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Permanently remove all Autosell desktop data for this Windows user? This deletes the database, payment journals, encrypted credentials, browser sessions, screenshots, logs and settings from $LOCALAPPDATA\Autosell V3. Export anything you need before continuing." /SD IDNO IDYES +2
        Goto keepAutosellData
      ${EndIf}
      nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\autosell-remove-data.ps1" -LocalApplicationData "$LOCALAPPDATA"'
      Pop $R0
      ${If} $R0 != "0"
        MessageBox MB_OK|MB_ICONEXCLAMATION "Autosell was uninstalled, but its personal data could not be removed safely. Review $LOCALAPPDATA\Autosell V3 and the uninstall details." /SD IDOK
        SetErrorLevel 24
      ${EndIf}
    ${EndIf}
    keepAutosellData:
  SectionEnd
!macroend

; Never allow NSIS to force-stop a worker while its financial journal is open.
!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\autosell-check-directory.ps1 "${BUILD_RESOURCES_DIR}\verify-install-directory.ps1"
  !ifdef BUILD_UNINSTALLER
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\autosell-check-directory.ps1" -Directory "$INSTDIR" -LocalApplicationData "$LOCALAPPDATA" -Uninstall'
  !else
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\autosell-check-directory.ps1" -Directory "$INSTDIR" -LocalApplicationData "$LOCALAPPDATA"'
  !endif
  Pop $R0
  ${If} $R0 != "0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Choose a dedicated, empty installation folder separate from Autosell user data. Existing installations must carry their installer ownership marker. Setup stopped before replacing any files." /SD IDOK
    SetErrorLevel 25
    Quit
  ${EndIf}
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
  ${NSD_CreateLabel} 0 48u 100% 35u "Payment journals, credentials and settings stay in local application data during upgrades. Uninstall offers a separate option to permanently remove all Autosell data."
  Pop $0
  ${NSD_CreateCheckbox} 0 92u 100% 16u "Create a desktop shortcut"
  Pop $DesktopShortcutCheckbox
  nsDialogs::Show
FunctionEnd

Function AutosellOptionsLeave
  ${NSD_GetState} $DesktopShortcutCheckbox $DesktopShortcutSelection
FunctionEnd

!macro customInstall
  FileOpen $R0 "$INSTDIR\autosell-install.id" w
  FileWrite $R0 "gg.autosell.desktop"
  FileClose $R0
  CreateDirectory "$LOCALAPPDATA\autosell-v3-desktop-updater"
  FileOpen $R0 "$LOCALAPPDATA\autosell-v3-desktop-updater\autosell-cache.id" w
  FileWrite $R0 "gg.autosell.desktop"
  FileClose $R0
  CreateShortCut "$SMPROGRAMS\Uninstall Autosell V3.lnk" "$INSTDIR\Uninstall Autosell V3.exe"
  ${If} $DesktopShortcutSelection == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\Autosell V3.lnk" "$INSTDIR\Autosell V3.exe"
  ${EndIf}
!macroend
!endif

!macro customUnInstall
  Delete "$DESKTOP\Autosell V3.lnk"
  Delete "$SMPROGRAMS\Uninstall Autosell V3.lnk"
!macroend

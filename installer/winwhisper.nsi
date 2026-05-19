; WinWhisper NSIS Installer Script
; Build:  makensis winwhisper.nsi
; Requires:  NSIS 3.x + AccessControl plug-in

!define APP_NAME        "WinWhisper"
!define APP_VERSION     "0.1.0"
!define PUBLISHER       "WinWhisper"
!define APP_EXE         "WinWhisper.exe"
!define UNINSTALL_KEY   "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
!define APP_REG_KEY     "Software\${PUBLISHER}\${APP_NAME}"

; Compression
SetCompressor /SOLID lzma
SetCompressorDictSize 32

; Modern UI
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

; Metadata
Name          "${APP_NAME} ${APP_VERSION}"
OutFile       "..\target\winwhisper-${APP_VERSION}-setup.exe"
InstallDir    "$PROGRAMFILES64\${APP_NAME}"
InstallDirRegKey HKLM "${APP_REG_KEY}" "InstallDir"
RequestExecutionLevel admin

; MUI pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ─── Installer ────────────────────────────────────────────────────────────────

Section "WinWhisper" SecMain
  SectionIn RO   ; required section

  SetOutPath "$INSTDIR"

  ; Main application (built by Tauri)
  File /r "..\src-tauri\target\release\bundle\nsis\*.*"

  ; Engine sidecar bundle (built by PyInstaller)
  SetOutPath "$INSTDIR\binaries"
  File /r "..\engine\dist\winwhisper_engine\*.*"

  ; Write registry
  WriteRegStr   HKLM "${APP_REG_KEY}" "InstallDir"  "$INSTDIR"
  WriteRegStr   HKLM "${APP_REG_KEY}" "Version"     "${APP_VERSION}"

  ; Uninstall info
  WriteRegStr   HKLM "${UNINSTALL_KEY}" "DisplayName"          "${APP_NAME}"
  WriteRegStr   HKLM "${UNINSTALL_KEY}" "DisplayVersion"       "${APP_VERSION}"
  WriteRegStr   HKLM "${UNINSTALL_KEY}" "Publisher"            "${PUBLISHER}"
  WriteRegStr   HKLM "${UNINSTALL_KEY}" "InstallLocation"      "$INSTDIR"
  WriteRegStr   HKLM "${UNINSTALL_KEY}" "UninstallString"      '"$INSTDIR\Uninstall.exe"'
  WriteRegStr   HKLM "${UNINSTALL_KEY}" "DisplayIcon"          "$INSTDIR\${APP_EXE}"
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify"             1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair"             1

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Desktop Shortcut" SecDesktop
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
SectionEnd

Section "Start Menu" SecStartMenu
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut  "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"  "$INSTDIR\${APP_EXE}"
  CreateShortcut  "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk"    "$INSTDIR\Uninstall.exe"
SectionEnd

; Auto-start with Windows (optional, not selected by default)
Section /o "Start with Windows" SecAutoStart
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" \
    "${APP_NAME}" '"$INSTDIR\${APP_EXE}"'
SectionEnd

; ─── Uninstaller ──────────────────────────────────────────────────────────────

Section "Uninstall"
  ; Remove auto-start entry (if set)
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_NAME}"

  ; Remove files
  RMDir /r "$INSTDIR\binaries"
  Delete   "$INSTDIR\${APP_EXE}"
  Delete   "$INSTDIR\Uninstall.exe"
  RMDir    "$INSTDIR"

  ; Remove shortcuts
  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"

  ; Remove registry keys
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  DeleteRegKey HKLM "${APP_REG_KEY}"

  ; Note: user data in %APPDATA%\WinWhisper (models, transcripts) is intentionally
  ; left intact so users don't lose their transcription history on reinstall.
  ; Show a message about this:
  MessageBox MB_ICONINFORMATION \
    "WinWhisper has been uninstalled.$\n$\nYour transcripts and downloaded models in$\n\
$APPDATA\WinWhisper$\nhave been preserved. Delete that folder manually if you want to remove them."
SectionEnd

; ─── Descriptions ─────────────────────────────────────────────────────────────

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain}      "Core WinWhisper application and Whisper engine."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop}   "Add a shortcut to your Desktop."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartMenu} "Add WinWhisper to your Start Menu."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecAutoStart} "Launch WinWhisper automatically when Windows starts."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

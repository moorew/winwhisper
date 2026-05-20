; Kill any running WinWhisper processes before files are written.
; Without this the installer errors "Error opening file for writing:
; winwhisper_engine.exe" because the running engine holds the handle.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /IM WinWhisper.exe /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM winwhisper_engine.exe /T'
  Pop $0
  Sleep 1500
!macroend

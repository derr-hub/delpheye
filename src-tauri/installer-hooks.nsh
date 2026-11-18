; DelphEye installer hooks.
;
; The app's data (journal, quarantine, error log) lives in %APPDATA%\com.delpheye.app and
; %LOCALAPPDATA%\com.delpheye.app, which the uninstaller's "delete application data" option
; already removes. All that is left to do here is make sure the sensor helper is not running,
; so its file can be replaced or removed.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /IM DelphEye.Sensors.exe /F'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /IM DelphEye.Sensors.exe /F'
!macroend

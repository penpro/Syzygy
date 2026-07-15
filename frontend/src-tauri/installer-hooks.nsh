; Custom NSIS hooks for Syzygy.
;
; The standard uninstaller removes the app + bundled engine, but NOT the user's
; downloaded models and workspace data (kept in %APPDATA%\com.penumbra.syzygy, which
; can be several GB). On uninstall, offer to remove those too.

!macro NSIS_HOOK_POSTUNINSTALL
  MessageBox MB_YESNO|MB_ICONQUESTION "Delete Syzygy data and downloaded models?$\n$\nThis permanently removes downloaded models (which can be several GB), settings, local conversations, and Google Drive connection data from this computer.$\n$\nChoose No to keep them — for example, if you plan to reinstall." /SD IDNO IDNO syz_keep_data
    RMDir /r "$APPDATA\com.penumbra.syzygy"
    RMDir /r "$LOCALAPPDATA\com.penumbra.syzygy"
  syz_keep_data:
!macroend

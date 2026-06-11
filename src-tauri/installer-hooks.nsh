; Dotdown NSIS 安装钩子：为 .md / .markdown 添加右键菜单「用 Dotdown 打开」
; 写在 SystemFileAssociations 下，独立于默认打开程序，对所有同类文件生效。

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.md\shell\OpenWithDotdown" "" "用 Dotdown 打开"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.md\shell\OpenWithDotdown" "Icon" '"$INSTDIR\Dotdown.exe",0'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.md\shell\OpenWithDotdown\command" "" '"$INSTDIR\Dotdown.exe" "%1"'

  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.markdown\shell\OpenWithDotdown" "" "用 Dotdown 打开"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.markdown\shell\OpenWithDotdown" "Icon" '"$INSTDIR\Dotdown.exe",0'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.markdown\shell\OpenWithDotdown\command" "" '"$INSTDIR\Dotdown.exe" "%1"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.md\shell\OpenWithDotdown"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.markdown\shell\OpenWithDotdown"
!macroend

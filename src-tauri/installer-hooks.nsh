; Dotdown NSIS 安装钩子：
; 1. 为 .md / .markdown 添加右键菜单「用 Dotdown 打开」
;    写在 SystemFileAssociations 下，独立于默认打开程序，对所有同类文件生效。
; 2. 为 .md 注册 ShellNew，让资源管理器右键「新建」子菜单出现 Markdown 项
;    （Explorer 建空文件并原地改名，双击再按默认程序打开）。

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.md\shell\OpenWithDotdown" "" "用 Dotdown 打开"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.md\shell\OpenWithDotdown" "Icon" '"$INSTDIR\Dotdown.exe",0'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.md\shell\OpenWithDotdown\command" "" '"$INSTDIR\Dotdown.exe" "%1"'

  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.markdown\shell\OpenWithDotdown" "" "用 Dotdown 打开"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.markdown\shell\OpenWithDotdown" "Icon" '"$INSTDIR\Dotdown.exe",0'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.markdown\shell\OpenWithDotdown\command" "" '"$INSTDIR\Dotdown.exe" "%1"'

  WriteRegStr HKCU "Software\Classes\.md\ShellNew" "NullFile" ""
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.md\shell\OpenWithDotdown"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.markdown\shell\OpenWithDotdown"
  DeleteRegKey HKCU "Software\Classes\.md\ShellNew"
!macroend

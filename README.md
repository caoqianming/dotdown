# mdview

一个用 [Tauri 2](https://v2.tauri.app/) 打造的 Markdown 预览/编辑桌面小工具（自用）。

## 功能

- 左右分栏：CodeMirror 6 源码编辑 + markdown-it 实时预览
- **多标签页**：并行打开多个文档，按路径去重，未保存 ● 标记
- **会话恢复**：重启自动还原上次打开的标签
- **深色模式**：浅色 / 深色 / 跟随系统三态切换
- **大纲侧栏**：标题 TOC，点击跳转
- 文件操作：新建 / 打开 / 保存 / 另存为（原生对话框，Rust 读写）
- GitHub 风格渲染：表格、任务列表、代码高亮（highlight.js）
- 视图切换：编辑 / 分栏 / 预览；编辑器 → 预览滚动同步
- 拖拽 `.md` 文件到窗口即可打开

## 快捷键

| 快捷键        | 功能         |
| ------------- | ------------ |
| Ctrl+N / Ctrl+T | 新建标签   |
| Ctrl+O        | 打开         |
| Ctrl+S        | 保存         |
| Ctrl+Shift+S  | 另存为       |
| Ctrl+W        | 关闭当前标签 |
| Ctrl+\        | 开关大纲侧栏 |

## 技术栈

- **Tauri 2.11**（Rust 后端：原生对话框 + 文件读写命令）
- 前端：**Vanilla TS + Vite 6**
- 编辑器：**CodeMirror 6**（`@codemirror/lang-markdown`）
- 渲染：**markdown-it** + `markdown-it-task-lists` + **highlight.js**

## 开发

```bash
npm install
npm run tauri dev     # 开发模式（热重载）
npm run tauri build   # 打包发布版（生成安装包 / exe）
```

## Windows 工具链注意事项

本机默认 Rust 工具链为 **GNU (`x86_64-pc-windows-gnu`)**。Tauri 默认的
`cdylib` crate-type 会导出海量符号，触发 GNU `ld` 的 “export ordinal too large”
链接错误。因此 `src-tauri/Cargo.toml` 中已将 `crate-type` 精简为 `["rlib"]`
（桌面端足够；`cdylib`/`staticlib` 仅移动端构建需要）。

若日后要做 Android/iOS，需要把 `crate-type` 改回
`["staticlib", "cdylib", "rlib"]`，并改用 MSVC 工具链或解决 GNU 链接器限制。

## 后续可扩展

- 大纲/目录侧栏、字数统计
- 主题切换（深色模式）
- 图片粘贴、文件关联（双击 .md 打开）
- 导出 PDF / HTML

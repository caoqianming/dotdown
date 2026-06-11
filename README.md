<div align="center">

<img src="app-icon.svg" width="96" alt="mdview logo" />

# mdview

轻量的 Markdown 预览 / 编辑桌面小工具，用 [Tauri 2](https://v2.tauri.app/) 打造。

![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-1.93-000000?logo=rust&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

</div>

## ✨ 功能

- **分栏编辑** — 左侧源码（CodeMirror 6）+ 右侧实时预览（markdown-it）
- **多标签页** — 并行打开多个文档，按路径去重，未保存以 ● 标记
- **会话恢复** — 重启自动还原上次打开的标签
- **大纲侧栏** — 标题目录，点击平滑跳转
- **深色模式** — 浅色 / 深色 / 跟随系统三态切换
- **视图切换** — 编辑 / 分栏 / 预览；编辑器 → 预览滚动同步
- **GitHub 风格渲染** — 表格、任务列表、代码高亮（highlight.js）
- **文件操作** — 新建 / 打开 / 保存 / 另存为（原生对话框，Rust 读写）
- **拖拽打开** — 把 `.md` 文件拖进窗口即可打开
- **关于 / 帮助** — 内置弹窗展示功能介绍与快捷键

## ⌨️ 快捷键

| 快捷键              | 功能         |
| ------------------- | ------------ |
| `Ctrl+N` / `Ctrl+T` | 新建标签     |
| `Ctrl+O`            | 打开         |
| `Ctrl+S`            | 保存         |
| `Ctrl+Shift+S`      | 另存为       |
| `Ctrl+W`            | 关闭当前标签 |
| `Ctrl+\`            | 开关大纲侧栏 |

## 🧱 技术栈

| 层    | 选型                                                          |
| ----- | ------------------------------------------------------------- |
| 外壳  | Tauri 2（Rust 后端：原生对话框 + 文件读写命令）               |
| 前端  | Vanilla TypeScript + Vite 6                                   |
| 编辑器 | CodeMirror 6（`@codemirror/lang-markdown`）                  |
| 渲染  | markdown-it + `markdown-it-task-lists` + highlight.js          |

## 🚀 开始

### 环境要求

- [Node.js](https://nodejs.org/)（18+）
- [Rust](https://www.rust-lang.org/tools/install) 工具链
- 平台依赖见 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/)（Windows 需 WebView2 + MSVC/GNU 构建工具）

### 开发

```bash
npm install
npm run tauri dev     # 开发模式（前端热重载）
```

### 打包

```bash
npm run tauri build   # 生成发布版
```

构建产物位于 `src-tauri/target/release/`：

- 可执行文件：`mdview.exe`
- 安装包：`bundle/msi/*.msi`、`bundle/nsis/*-setup.exe`

## 📁 项目结构

```
mdview/
├─ index.html          # 应用外壳
├─ src/
│  ├─ main.ts          # 标签 / 编辑器 / 预览 / 文件 / 主题 / 大纲 / 会话
│  └─ styles.css       # 样式（CSS 变量 + 明暗主题）
├─ src-tauri/
│  ├─ src/lib.rs       # Rust 命令：read_file / write_file
│  ├─ Cargo.toml       # crate-type = ["rlib"]（见下方说明）
│  └─ tauri.conf.json  # 应用配置 / 权限
├─ app-icon.svg        # 应用图标源文件（tauri icon 生成全套）
├─ design.md           # 设计文档
└─ process.md          # 进度记录
```

## ⚠️ Windows 工具链说明

若使用 **GNU 工具链（`x86_64-pc-windows-gnu`）**，Tauri 默认的 `cdylib`
crate-type 会导出海量符号，触发 GNU `ld` 的 `export ordinal too large` 链接错误。
因此本项目 `src-tauri/Cargo.toml` 中已将 `crate-type` 精简为 `["rlib"]`（桌面端足够）。

> 若日后要做 Android/iOS，需把 `crate-type` 改回 `["staticlib", "cdylib", "rlib"]`，
> 并改用 MSVC 工具链或解决 GNU 链接器限制。

## 🗺️ 路线图

- [ ] 字数统计、查找替换
- [ ] 图片粘贴、文件关联（双击 `.md` 打开）
- [ ] 导出 PDF / HTML
- [ ] 标签拖拽重排

## 📄 License

[MIT](LICENSE)

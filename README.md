<div align="center">

<img src="app-icon.svg" width="96" alt="Dotdown logo" />

# Dotdown

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
- **最近打开** — 工具栏「最近」下拉列出近期打开/保存过的文件，一键重开（失效自动剔除）
- **大纲侧栏** — 标题目录，点击平滑跳转
- **深色模式** — 浅色 / 深色 / 跟随系统三态切换
- **视图切换** — 编辑 / 分栏 / 预览；编辑器 → 预览滚动同步；打开 / 新建文档自动切到分栏
- **查找** — `Ctrl+F` 唤起搜索条，编辑器与预览均可逐个高亮跳转（按当前视图分派）
- **GitHub 风格渲染** — 表格、任务列表、代码高亮（highlight.js）
- **导出 PDF** — 一键把预览导出为 PDF（走系统打印「另存为 PDF」）
- **文件关联** — 双击 `.md` 或右键「用 Dotdown 打开」，在现有窗口开新标签
- **文件操作** — 新建 / 打开 / 保存 / 另存为（原生对话框，Rust 读写）
- **图片** — 本地图片自动显示（相对/绝对路径）；粘贴或拖入图片自动落盘到文档同级 `assets/` 并插入引用（未保存文档会先提示保存，避免内联 base64 撑大文件）
- **拖拽打开** — 把 `.md` 文件拖进窗口即可打开；拖入图片则插入到当前文档
- **检查更新** — 关于弹窗内一键检查新版（优先 Gitee、回退 GitHub），有新版直达发行版下载页
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
| `Ctrl+F`            | 查找         |
| `Ctrl+P`            | 导出 PDF     |

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

- 免安装可执行文件：`dotdown.exe`
- 安装包（NSIS）：`bundle/nsis/Dotdown_<版本>_x64-setup.exe`

> 仅打 NSIS 安装包：它支持文件关联并承载右键菜单钩子；WiX/MSI 在带文件关联时打包失败，故移除。

## 📁 项目结构

```
dotdown/
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

项目用 `src-tauri/rust-toolchain.toml` 固定 **MSVC 工具链**
（`stable-x86_64-pc-windows-msvc`）：MSVC 会把 WebView2 loader 静态链接，生成自包含
exe；若用 GNU 构建则会**动态依赖 `WebView2Loader.dll`**，安装后可能报缺 dll。
构建前请先安装 [VS C++ 生成工具](https://visualstudio.microsoft.com/visual-cpp-build-tools/)。

> `Cargo.toml` 的 `crate-type` 保留为 `["rlib"]`（桌面端足够，MSVC/GNU 均可）。
> 仅打 NSIS 安装包（WiX/MSI 带文件关联时打包失败）。

## 📥 下载

发行版同时发布到 **Gitee**（国内更快）与 **GitHub**，二选一下载安装包即可：

- Gitee：<https://gitee.com/caoqianming/dotdown/releases>
- GitHub：<https://github.com/caoqianming/dotdown/releases>

应用内「关于」弹窗的「检查更新」会自动比对最新发行版（优先 Gitee，失败回退 GitHub）。

## 🗺️ 路线图

- [x] 查找（编辑器 + 预览统一搜索条）
- [x] 图片：本地显示 + 粘贴/拖入落盘
- [ ] 字数统计、查找替换（替换待补）
- [ ] 导出 HTML
- [ ] 标签拖拽重排

## 📄 License

[MIT](LICENSE)

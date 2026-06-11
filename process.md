# mdview 进度记录

> 开发进度与变更日志。新进展追加到顶部。

## 里程碑总览

- [x] **M1 项目骨架**：Tauri 2 + Vanilla TS 脚手架、命名、工具链打通
- [x] **M2 核心编辑/预览**：CodeMirror 编辑 + markdown-it 预览、文件读写、视图切换、滚动同步
- [x] **M3 多标签页**：多文档并行、标签栏、切换/关闭/去重
- [x] **M4 体验增强**：会话恢复 ✅ / 深色模式 ✅ / 大纲侧栏 ✅
- [x] **M5 发布**：`tauri build` 打包 + GitHub Release v0.1.0（含 exe/msi/setup）

---

## 2026-06-11

### 已完成：M5 发布
- `npm run tauri build` 生成 release 产物：`mdview.exe`、`mdview_0.1.0_x64_en-US.msi`、
  `mdview_0.1.0_x64-setup.exe`。
- 源码推送到 GitHub（`caoqianming/mdview`，HTTPS）。
- 经 REST API 创建 Release `v0.1.0`，上传 exe / msi / setup 三个资产。
- 新增「关于/帮助」弹窗、面向 GitHub 的 README、MIT LICENSE。

### 已完成：扁平化图标 + 大纲侧栏
- **图标**：新增 `app-icon.svg`（扁平蓝底圆角方 + 白色 Markdown 标志），`tauri icon`
  生成全套；主题按钮改用 Lucide 扁平 SVG（sun/moon/monitor）。移除移动端图标目录。
- **大纲侧栏**：从渲染后的预览提取 h1–h6 生成可点击跳转的 TOC，按层级缩进；
  工具栏按钮 / Ctrl+\ 开关，开关状态持久化。`setMode` 改用 classList 避免清掉
  `outline-open`。
- 验证：`tsc` ✅、`tauri dev` 启动成功 ✅。

### 已完成：深色模式
- 三态切换：浅色 / 深色 / 跟随系统，工具栏按钮循环切换（☀️/🌙/🖥️），选择持久化。
  - [x] CSS 变量 + `:root[data-theme="dark"]` 覆盖；编辑器用 oneDark（Compartment 运行时切换）
  - [x] `index.html` 内联脚本首屏前定主题，避免启动闪白
  - [x] 跟随系统时监听 `prefers-color-scheme` 变化即时生效
  - [x] 切换标签时按当前主题重配编辑器 state
  - [x] 验证：`tsc` ✅、`tauri dev` 启动成功 ✅

### 已完成：M4 会话恢复（重启还原标签）
- localStorage 持久化（key `mdview.session`），详见 design.md §4.4。
  - [x] 干净已存盘文件只存路径、重启从磁盘重载；脏/未命名标签连内容一起存
  - [x] 保存时机：结构性操作即时 + 编辑防抖 500ms + beforeunload 兜底
  - [x] 文件被外部删除则跳过；恢复后还原 activeIndex
  - [x] 抽出 `createTab`/`activate`，新建与恢复复用
  - [x] 验证：`tsc` ✅、`tauri dev` 启动成功 ✅

### 已完成：M3 多标签页
- 实现：单 `EditorView` + 每标签独立 `EditorState`（详见 design.md §4.2）。
  - [x] 标签数据模型与全局状态（`tabs` / `activeId` / `tabSeq`）
  - [x] 标签栏 UI（名称 + dirty 点 + 关闭按钮 + `+` 新建按钮）
  - [x] 新建 / 打开（按路径去重）/ 切换 / 关闭 标签；关到 0 个自动新建空白
  - [x] dirty 判定改为按标签计算（`docOf` / `isDirty`）
  - [x] 快捷键 Ctrl+T / Ctrl+N 新建、Ctrl+W 关闭
  - [x] 拖拽多文件 → 每个文件一个标签
  - [x] 验证：`tsc` ✅、`tauri dev` 启动成功 ✅
- 下一步候选：M4（深色模式 / 大纲侧栏 / 会话恢复）。

### 文档
- 新增 `design.md`（架构/数据模型/决策）与 `process.md`（本文件）。

### 已完成：M1 + M2（初始提交 `6bd1eb8`）
- Tauri 2.11 + Vanilla TS + Vite 脚手架，统一命名为 `mdview`。
- Rust 命令 `read_file` / `write_file` + `plugin-dialog`。
- CodeMirror 6 编辑 + markdown-it 渲染（GFM / 任务列表 / highlight.js）。
- 新建/打开/保存/另存为、视图切换、滚动同步、拖拽打开、未保存提醒。
- 工具链坑：GNU `ld` 导出上限 → `crate-type=["rlib"]` 绕过。
- 验证：`tsc` ✅、`cargo build` ✅、`tauri dev` 启动成功 ✅。

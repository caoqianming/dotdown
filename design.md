# Dotdown 设计文档

> Markdown 预览/编辑桌面小工具（自用）。本文档记录架构、数据模型与关键设计决策，随功能演进持续更新。

## 1. 目标与范围

- 轻量、启动快的本地 Markdown 编辑/预览工具。
- 核心体验：源码编辑 + 实时预览，多文件并行（多标签页）。
- 平台：Windows 桌面优先（作者本机环境）。

## 2. 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 外壳 | Tauri 2.11 | Rust 后端 + 系统 WebView，包体小 |
| 后端 | Rust | 文件读写命令 + 原生对话框插件 |
| 前端 | Vanilla TS + Vite 6 | 自用工具，避免重框架 |
| 编辑器 | CodeMirror 6 | `@codemirror/lang-markdown` 语法高亮 |
| 渲染 | markdown-it | `markdown-it-task-lists` + highlight.js |

选型理由：CodeMirror 提供"真·Markdown 源码"输入输出与可控的编辑体验；markdown-it
渲染稳定、插件生态成熟。相比 Milkdown/Tiptap 等 WYSIWYG 方案，源码+预览分栏更贴合
"预览与编辑"的诉求，实现成本更低。

## 3. 进程与边界

```
┌─────────────────────────── Tauri App ───────────────────────────┐
│  WebView (前端)                     Rust 核心 (后端)              │
│  ┌────────────────────────┐         ┌──────────────────────────┐ │
│  │ index.html / main.ts   │  invoke │ lib.rs                   │ │
│  │  - 标签栏 / 工具栏      │ ──────▶ │  read_file(path)         │ │
│  │  - CodeMirror 编辑器    │ ◀────── │  write_file(path,content)│ │
│  │  - markdown-it 预览     │ events  │ plugin-dialog (open/save)│ │
│  └────────────────────────┘         └──────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

- 文件读写走自定义 Rust 命令（`read_file`/`write_file`），而非 `plugin-fs`，
  以免去 fs 作用域配置，权限边界更清晰。
- 打开/保存路径选择走 `plugin-dialog`（原生对话框）。
- 权限在 `src-tauri/capabilities/default.json`：`core:default` / `opener:default` /
  `dialog:default`。

## 4. 前端架构

### 4.1 模块职责（`src/main.ts`）

- **Markdown 渲染器**：单例 `md`，负责将源码渲染为 HTML（GFM、代码高亮、任务列表）。
- **标签模型**：维护打开的文档集合与当前激活标签。
- **编辑器**：单个 CodeMirror `EditorView` 实例，按标签切换 `EditorState`。
- **文件操作**：新建 / 打开 / 保存 / 另存为 / 关闭。
- **视图与同步**：视图模式切换（编辑/分栏/预览）、编辑器→预览滚动同步。

### 4.2 多标签页设计（核心）

**数据模型**

```ts
interface Tab {
  id: number;            // 自增唯一 id
  path: string | null;   // 磁盘路径，null = 未保存的新文档
  lastSaved: string;     // 上次保存时的内容，用于判定 dirty
  state: EditorState;    // 该标签的 CodeMirror 状态（含文档/撤销历史/光标）
}
```

全局状态：`tabs: Tab[]`、`activeId: number`、自增计数 `tabSeq`。

**关键决策：单 View + 多 State**

只创建**一个** `EditorView`，每个标签各自持有一份 `EditorState`。切换标签时：

1. 把当前 `editor.state` 写回旧标签的 `tab.state`（保存撤销历史/光标）；
2. `editor.setState(目标.state)` 载入目标标签。

好处：撤销历史、光标、选区**按标签隔离**，且只挂一个 DOM 编辑器，省内存、滚动
同步逻辑只需绑定一次。

**dirty 判定**：比较前先用 `eol()` 把两边换行符规范化为 LF（CodeMirror 会把文档规范化为
LF，否则打开 CRLF 文件会被误判为已编辑），即 `eol(docOf(tab)) !== eol(tab.lastSaved)`。
激活标签的实时内容取自 `editor.state`（`tab.state` 可能滞后），非激活标签取 `tab.state`。
关掉最后一个标签后留一个空白未命名（不重现欢迎文档）。

**打开去重**：打开已在某标签中的文件时，直接切换到该标签，不重复打开。

**关闭**：若该标签 dirty 则二次确认；关闭后激活相邻标签；关到 0 个时自动新建一个空白标签（始终保持 ≥1）。

### 4.3 视图模式

`#app` 的 class 在 `mode-editor` / `mode-split` / `mode-preview` 间切换，用 CSS
控制左右面板显隐，无需 JS 重排。默认 **预览** 模式，并记住上次选择（`localStorage`
key `dotdown.mode`）。

**打开/新建文档自动切分栏**：默认预览模式下编辑器不可见——打开文件只能看不能改，新建空白
文档更是无处下笔。故**打开文件**（`loadPath`，含对话框/拖拽/双击关联）与**用户主动新建**
（Ctrl+N/T 或「新建」按钮，`newBlankDoc`）后切到 `split`。会话恢复（启动还原标签）与关掉
最后一个标签后的占位空白**不强切**，以尊重记住的模式。

### 4.4 会话恢复

重启后自动还原上次打开的标签。持久化到 WebView 的 `localStorage`
（key `dotdown.session`，Tauri 数据目录会保留）。

持久化结构：

```ts
interface PersistedTab {
  path: string | null;
  content: string | null; // null = 干净的已存盘文件，重启时从磁盘重载
}
// { activeIndex: number, tabs: PersistedTab[] }
```

策略：

- **干净的已存盘文件**：只存路径（`content = null`），重启时从磁盘重载——能反映
  外部改动，也避免大文件占满 localStorage 配额。文件已删除则跳过该标签。
- **有未保存改动 / 未命名标签**：连内容一起存，重启后 `lastSaved` 取磁盘内容（若可读），
  故未保存差异仍标记为 dirty，编辑不丢失。

保存时机：结构性操作（新建/切换/关闭/保存）后立即保存；编辑时防抖 500ms 保存；
`beforeunload` 兜底刷新。

### 4.5 主题（深色模式）

三态：浅色 / 深色 / 跟随系统，工具栏按钮循环切换，选择存于 `localStorage`（key `dotdown.theme`）。

- **UI 换肤**：CSS 变量 + `:root[data-theme="dark"]` 覆盖；`index.html` 头部内联
  脚本在首屏前设好 `data-theme`，避免启动闪白。
- **编辑器换肤**：CodeMirror 用 `Compartment` 包裹主题（深色用 `oneDark`），运行时
  `reconfigure` 切换；切标签时按当前主题重配，保证各标签观感一致。
- **跟随系统**：监听 `prefers-color-scheme` 变化即时生效。

### 4.6 大纲侧栏

从**渲染后的预览** DOM 中提取 `h1`–`h6`（而非另行解析 Markdown，保证与预览一致），
给每个标题分配 `id` 并生成可点击项，点击 `scrollIntoView` 平滑跳转。按标题层级缩进。
工具栏按钮或 Ctrl+\ 开关，状态存于 `localStorage`（key `dotdown.outline`）。
**默认展开**：无记录时默认开，仅当用户上次显式关闭（`"0"`）才保持收起。

注意：视图模式切换用 `classList` 增删 `mode-*`，避免覆盖 `outline-open` 类。

**WebView2 局部不重绘修复（两层）**：

1. *DOM 层*：预览渲染后偶发局部空白（尤其下半部分），拖动/缩放窗口才刷新。
   `forceRepaint()` 在同一 JS 任务内切一次预览 `display` 触发同步重排+重绘（中间态不被
   绘制故无闪烁，并保留滚动位置），于 `renderPreview` / `setMode` / `setOutline` 后调用。

2. *窗口/画面层（扩展屏 DPI）*：扩展屏与主屏**缩放比例不同**时，窗口以非最大化尺寸
   在扩展屏首次出现，会按错误的栅格化比例渲染，右侧内容被裁掉，需手动双击标题栏/拖动才铺满。
   前端首屏渲染完成后 `invoke("fix_webview_paint")`，后端 `nudge_repaint()` 在**仅当窗口
   落在非主显示器**（`on_secondary_monitor`，按显示器位置判断）时，**把窗口最大化并保持**
   （等价于用户手动双击标题栏）——这一步是 Windows 驱动的重排，逼 WebView2 重新铺满。
   **关键：最终必须停在最大化状态**：1px 抖动太小无效、最大化窗口 `set_size` 被系统忽略、
   且切回非最大化又会复现裁切。仅在扩展屏触发，主屏正常打开不受影响、无多余闪烁。

### 4.7 滚动同步

编辑器 `scrollDOM` 滚动时按比例设置预览面板 `scrollTop`（编辑器 → 预览，单向）。
绑定一次，跨标签复用同一 View 故无需重绑。

### 4.8 关于 / 帮助弹窗

工具栏 ⓘ 按钮打开模态弹窗，展示软件信息、功能介绍、快捷键、技术栈；版本号经
`@tauri-apps/api/app` 的 `getVersion()` 动态读取。关闭：× / 点遮罩 / Esc。
弹窗用同一套 CSS 变量随主题换肤。

### 4.9 导出 PDF

走 WebView 的 `window.print()` → 系统打印「另存为 PDF」。`@media print` 只输出
`.markdown-body`、强制浅色（用 `!important` 覆盖主题变量，保证可读），代码块以
`print-color-adjust: exact` 保留深色高亮；并对代码块/表格/图片 `break-inside: avoid`
避免跨页截断。打印前把 `document.title` 临时设为文件名（PDF 默认文件名），`afterprint`
还原。

### 4.10 文件关联 / 双击打开

- `tauri.conf.json` 的 `bundle.fileAssociations` 注册 `.md/.markdown/.mdown`，安装包
  把应用登记为可打开这些类型（出现在「打开方式」）。
- **右键「用 Dotdown 打开」**：NSIS 安装钩子 `installer-hooks.nsh` 在
  `HKCU\...\SystemFileAssociations\.md\shell` 下写入菜单项，卸载时删除。
- **打开流程**：双击/右键经命令行把文件路径传给应用。后端 `initial_file` 命令读取本次
  启动参数；已运行时，`tauri-plugin-single-instance` 捕获二次启动并 `emit("open-file")`
  转发到现有窗口 + 聚焦。前端在启动时调 `initial_file`、并 `listen("open-file")`，
  统一交给 `loadPath`（按路径去重）。

### 4.11 更新检查（轻量方案，已实现 v0.2.2）

应用内「检查更新」：只**检查 + 跳转下载页**，不在应用内下载安装（后者是完整自动更新方案，
需签名密钥与长期维护，暂不采用），因此零密钥、零额外发布产物。

- **取版本**：当前版本用 `getVersion()`；远端"最新版"用发布平台 API 的 `tag_name`。
  - 仓库坐标常量 `REPO = "caoqianming/dotdown"`。
  - **优先 Gitee**：`GET https://gitee.com/api/v5/repos/caoqianming/dotdown/releases/latest`
    （国内访问快）；失败回退 GitHub：`GET https://api.github.com/repos/.../releases/latest`。
  - 请求方式：webview `fetch` 直接请求；CSP 当前为 null 放行。
- **比较**：`compareVersion()` 按语义化版本逐段比较 `tag`（去前缀 `v`、忽略预发布标记）。
- **下载**：有新版时在关于弹窗内显示 `发现新版本 vX · 去下载`，「去下载」用 `openUrl()`
  （`tauri-plugin-opener`）打开对应**发行版页面**（Gitee 命中则开 Gitee，回退 GitHub）。
- **入口**：关于弹窗内「检查更新」按钮（`checkUpdate(false)`，会反馈「检查中／已是最新／失败」）；
  启动时静默检查一次 `checkUpdate(true)`——仅在有新版时自动弹出关于窗提示，最新/失败不打扰。
- **依赖/权限**：`@tauri-apps/plugin-opener` 的 `openUrl`；`opener:default` 含 `allow-default-urls`
  放行 `https://*`，无需改 capabilities；网络走 webview `fetch`，无需额外插件。

> 升级到「完整自动更新」时再引入 `tauri-plugin-updater` + 签名密钥 + `latest.json` 端点
> （端点可列 Gitee 优先、GitHub 备用）。

### 4.12 查找（编辑器 + 预览统一搜索条）

`Ctrl+F`（或工具栏「查找」按钮）唤起浮于面板右上角的搜索条。**搜索目标随当前视图模式分派**：

- **预览模式** → 搜渲染后的预览 DOM：用 `TreeWalker` 收集匹配的文本节点，把命中片段
  包成 `<mark class="search-hit">`（大小写不敏感），逐个高亮；当前项额外加
  `search-hit-current` 并 `scrollIntoView`。计数显示「当前/总数」。
- **编辑/分栏模式** → 驱动 CodeMirror 的 `@codemirror/search` 扩展：`setSearchQuery`
  设置查询（高亮全部匹配），`findNext`/`findPrevious` 跳转；计数用 `SearchQuery.getCursor`
  遍历得到总数。**不开 CM 自带面板**，统一用自定义搜索条。

**清理与重标**：关闭搜索条时还原所有 `<mark>`（用文本节点替换 + `normalize` 合并）并清空
编辑器查询。预览被重建（编辑、切标签）会清掉高亮，故 `renderPreview` 末尾若正在预览中搜索
则重新标注；`setMode` 切换会改变搜索目标，开着搜索条时重跑当前查询。

**交互**：输入即时搜索；`Enter`/`Shift+Enter` 下一个/上一个；`Esc` 关闭。打印时
`.search-bar` 一并隐藏。

## 5. 快捷键

| 快捷键 | 功能 |
| --- | --- |
| Ctrl+N / Ctrl+T | 新建标签 |
| Ctrl+O | 打开 |
| Ctrl+S | 保存 |
| Ctrl+Shift+S | 另存为 |
| Ctrl+W | 关闭当前标签 |
| Ctrl+\ | 开关大纲侧栏 |
| Ctrl+F | 查找（编辑器 / 预览） |
| Ctrl+P | 导出 PDF |

## 6. 构建与工具链注意

- **MSVC 工具链**：`src-tauri/rust-toolchain.toml` 固定为 `stable-x86_64-pc-windows-msvc`。
  MSVC 会把 WebView2 loader 静态链接，生成自包含 exe；若用 GNU 构建则动态依赖
  `WebView2Loader.dll`，安装后会报缺 dll。需先装 VS C++ 生成工具。
- **crate-type**：保留 `["rlib"]`（桌面端足够，MSVC/GNU 均可）。早期用 GNU 时，Tauri 默认的
  `cdylib` 会触发 GNU `ld` 的 `export ordinal too large` 链接错误，故精简为 rlib；改用 MSVC
  后该限制已不存在，但 rlib 仍够用故保留。
- **打包目标**：仅 NSIS（见 §4.10）。WiX/MSI 在带文件关联时打包失败。

## 7. 后续路线（Roadmap）

> 已完成：多标签页、会话恢复、深色模式、大纲侧栏、关于弹窗、导出 PDF、
> 文件关联 / 双击打开 / 右键菜单、发布打包、更新检查（Gitee 优先）、查找。

- [x] 更新检查（轻量方案，见 §4.11）
- [x] Gitee 镜像（国内用户下载提速，发行版优先 Gitee）
- [x] 查找（编辑器 + 预览统一搜索条，见 §4.12）
- [ ] 导出 HTML
- [ ] 标签拖拽重排
- [ ] 字数统计、查找替换（替换待补）

## 8. 关键设计决策记录

1. **自定义 Rust 文件命令 vs plugin-fs**：选前者，权限边界清晰、无需配置 fs scope。
2. **源码+预览分栏 vs WYSIWYG**：选分栏，贴合诉求且实现成本低。
3. **单 View + 多 State 的标签实现**：隔离每标签历史/光标，省内存。
4. **固定 MSVC 工具链**：WebView2 loader 静态链接，exe 自包含；避免 GNU 动态依赖
   `WebView2Loader.dll` 导致安装缺 dll。`crate-type` 保留 `["rlib"]`。

# mdview 设计文档

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

**dirty 判定**：`docOf(tab) !== tab.lastSaved`。激活标签的实时内容取自
`editor.state`（`tab.state` 可能滞后），非激活标签取 `tab.state`。

**打开去重**：打开已在某标签中的文件时，直接切换到该标签，不重复打开。

**关闭**：若该标签 dirty 则二次确认；关闭后激活相邻标签；关到 0 个时自动新建一个空白标签（始终保持 ≥1）。

### 4.3 视图模式

`#app` 的 class 在 `mode-editor` / `mode-split` / `mode-preview` 间切换，用 CSS
控制左右面板显隐，无需 JS 重排。

### 4.4 会话恢复

重启后自动还原上次打开的标签。持久化到 WebView 的 `localStorage`
（key `mdview.session`，Tauri 数据目录会保留）。

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

三态：浅色 / 深色 / 跟随系统，工具栏按钮循环切换，选择存于 `localStorage`（key `mdview.theme`）。

- **UI 换肤**：CSS 变量 + `:root[data-theme="dark"]` 覆盖；`index.html` 头部内联
  脚本在首屏前设好 `data-theme`，避免启动闪白。
- **编辑器换肤**：CodeMirror 用 `Compartment` 包裹主题（深色用 `oneDark`），运行时
  `reconfigure` 切换；切标签时按当前主题重配，保证各标签观感一致。
- **跟随系统**：监听 `prefers-color-scheme` 变化即时生效。

### 4.6 滚动同步

编辑器 `scrollDOM` 滚动时按比例设置预览面板 `scrollTop`（编辑器 → 预览，单向）。
绑定一次，跨标签复用同一 View 故无需重绑。

## 5. 快捷键

| 快捷键 | 功能 |
| --- | --- |
| Ctrl+N / Ctrl+T | 新建标签 |
| Ctrl+O | 打开 |
| Ctrl+S | 保存 |
| Ctrl+Shift+S | 另存为 |
| Ctrl+W | 关闭当前标签 |

## 6. 构建与工具链注意

本机默认 Rust 工具链为 GNU（`x86_64-pc-windows-gnu`）。Tauri 默认 `cdylib`
crate-type 会导出海量符号，触发 GNU `ld` 的 `export ordinal too large` 链接错误。
故 `src-tauri/Cargo.toml` 已将 `crate-type` 精简为 `["rlib"]`（桌面端足够）。
日后做移动端需改回含 `cdylib` 并切换 MSVC 工具链。

## 7. 后续路线（Roadmap）

- [ ] 深色模式（系统跟随 + 手动切换）
- [ ] 大纲/目录侧栏（标题跳转）
- [ ] 文件关联 / 双击 `.md` 打开（启动参数）
- [ ] 导出 PDF / HTML
- [ ] 标签拖拽重排、会话恢复（记住上次打开的文件）
- [ ] 字数统计、查找替换

## 8. 关键设计决策记录

1. **自定义 Rust 文件命令 vs plugin-fs**：选前者，权限边界清晰、无需配置 fs scope。
2. **源码+预览分栏 vs WYSIWYG**：选分栏，贴合诉求且实现成本低。
3. **单 View + 多 State 的标签实现**：隔离每标签历史/光标，省内存。
4. **crate-type = ["rlib"]**：适配本机 GNU 工具链，绕开链接器导出上限。

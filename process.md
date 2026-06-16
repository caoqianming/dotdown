# Dotdown 进度记录

> 开发进度与变更日志。新进展追加到顶部。
>
> 注：项目原名 mdview，2026-06-11 更名为 **Dotdown**；下方旧记录中的 `mdview*` 为更名前内容。

## 里程碑总览

- [x] **M1 项目骨架**：Tauri 2 + Vanilla TS 脚手架、命名、工具链打通
- [x] **M2 核心编辑/预览**：CodeMirror 编辑 + markdown-it 预览、文件读写、视图切换、滚动同步
- [x] **M3 多标签页**：多文档并行、标签栏、切换/关闭/去重
- [x] **M4 体验增强**：会话恢复 ✅ / 深色模式 ✅ / 大纲侧栏 ✅
- [x] **M5 发布**：`tauri build` 打包 + GitHub Release v0.1.0（含 exe/msi/setup）

---

## 2026-06-16（续）

### 新功能：查找替换 + 字数统计 + 导出 HTML + 标签拖拽重排（v0.3.0）
- **查找替换**：搜索条加三角切换 + 替换行（替换输入 + 「替换」/「全部」），`Ctrl+H` 展开。
  复用 `@codemirror/search` 的 `replaceNext`/`replaceAll`（设置含 `replace` 字段的 `SearchQuery`）。
  仅编辑器有效，预览模式隐藏替换。详见 `design.md §4.15`。
- **字数统计**：底部状态栏实时显示「字数 · 字符 · 行」，有选区追加「已选 N 字」。CJK 按字、
  拉丁字母/数字串按词。编辑器 `updateListener`（docChanged/selectionSet）+ 切标签刷新。详见 §4.16。
- **导出 HTML**：渲染自包含单文件（内联浅色 `EXPORT_CSS`），默认存源文件同级同名。
  导出时 `rawImagePaths=true` 跳过 `convertFileSrc`、保留相对 `assets/…` 路径。详见 §4.17。
- **导出菜单**：PDF / HTML 合并到工具栏「导出 ▾」下拉（复用「最近」下拉样式），`Ctrl+P` 仍直达 PDF。
- **标签拖拽重排**：标签 `draggable`，HTML5 拖放调 `reorderTab` 重排数组并持久化。详见 §4.18。
- 路线图 §7 余项全部完成。`tsc` ✅、`vite build` ✅。

## 2026-06-16

### 新功能：最近打开历史（v0.2.7）
- 工具栏新增「最近 ▾」下拉,列出近期打开/保存过的已存盘文件,点击经 `loadPath` 一键重开。
- 存于 `localStorage`（`dotdown.recent`,仅路径,去重置顶限长 15）;`loadPath`/`writeTo`
  成功时记录,打开失败时自动剔除失效条目。与会话恢复正交。
- 详见 `design.md §4.14`。

### 新功能：图片支持（显示 + 粘贴/拖入）（v0.2.6）
- **本地图片显示**：覆写 markdown-it 的 `image` 渲染规则，本地路径（相对/绝对/`C:/…`）经
  `convertFileSrc` 重写为 asset 协议；外部链接（`http(s)`/`data:`/`//`）原样保留。相对路径以
  当前标签文件所在目录为基准解析（含 `.`/`..` 归一）。需开启 `assetProtocol`（scope `**`）并为
  `tauri` crate 加 `protocol-asset` feature。
- **粘贴图片**：监听编辑器 `paste`，剪贴板含图片时落盘到文档同级 `assets/image-<ts>-<n>.<ext>`
  并插入 `![](assets/…)`；未保存文档先提示并走「另存为」确定 `assets/` 落点，取消则放弃插入
  （不退回内联 base64——会把图片整段塞进 `.md`、撑大文件）。
- **拖入图片**：扩展 `onDragDropEvent`——`.md` 仍新开标签，图片文件则复制到 `assets/` 并插入引用；
  无文档路径时引用原始绝对路径。预览模式下插入自动切到分栏以便确认。
- 新增 Rust 命令 `write_bytes`（粘贴字节落盘）与 `copy_file`（拖入文件复制），共用 `ensure_parent`。
- 详见 `design.md`。

---

## 2026-06-15

### 体验：打开/新建文档自动切分栏
- 默认预览模式下编辑器不可见——打开文件只能看不能改、新建空白文档无处下笔。
- 打开文件（`loadPath`：对话框/拖拽/双击关联）与用户主动新建（Ctrl+N/T、「新建」按钮，
  新增 `newBlankDoc`）后切到 `split`；会话恢复与关到最后一个标签的占位空白不强切，尊重记住的模式。
- 详见 `design.md §4.3`。

### 新功能：查找（编辑器 + 预览统一搜索条）
- `Ctrl+F`（或工具栏「查找」）唤起浮于面板右上角的搜索条，**搜索目标随视图模式分派**：
  - 预览模式：`TreeWalker` 遍历预览 DOM，命中片段包 `<mark>` 高亮，逐个跳转，计数「当前/总数」。
  - 编辑/分栏：驱动 `@codemirror/search`（`setSearchQuery` + `findNext/findPrevious`），
    用 `SearchQuery.getCursor` 统计总数；不开 CM 自带面板，统一自定义搜索条。
- 交互：输入即时搜索；`Enter`/`Shift+Enter` 下/上一个；`Esc` 关闭。打印时隐藏搜索条。
- 细节：关闭/切目标时还原 `<mark>` 并清空编辑器查询；`renderPreview`/`setMode` 会重跑当前查询，
  避免预览重建丢高亮。新增直接依赖 `@codemirror/search`（原为 codemirror 元包的传递依赖）。
- 替换暂未做（路线图保留「查找替换」）。详见 `design.md §4.12`。

## 2026-06-11（续 2）

### 已发布：v0.2.3（体验修复）
- 打 tag `v0.2.3`：GitHub 建 Release 并上传 NSIS 安装包 + 免安装 exe；源码+tag 也推了 Gitee
  （Gitee Release 二进制因上午 gitee 不可用未传，留作手动补）。

## 2026-06-12

### 修复：扩展屏（双屏 DPI 不同）下预览右侧被裁掉（v0.2.4）
- 现象：双击 md 在扩展屏打开，窗口右侧大片不显示；**手动双击标题栏（最大化）就好了**。
- 根因：扩展屏与主屏**缩放比例不同**，窗口以非最大化尺寸在扩展屏首次出现时按错误的
  栅格化比例渲染 → 右侧裁掉。这是窗口/画面层问题，`forceRepaint` 的 DOM 重绘治不了。
- 踩坑（两次没中）：① 1px `set_size` 抖动——太小无效，且最大化窗口 set_size 被系统忽略；
  ② 最大化状态切换但**切回了非最大化**——非最大化正是坏状态，等于又坏回去（用户："抖了一下还是不全"）。
- 最终修法：前端首屏渲染后 `invoke("fix_webview_paint")`，后端 `nudge_repaint()` 仅当窗口落在
  **非主显示器**（`on_secondary_monitor`）时**把窗口最大化并保持**（复刻用户手动双击标题栏）。
  **关键：最终停在最大化状态**。仅扩展屏触发，主屏不受影响。详见 `design.md §4.6`。
- 经验：定位前先问用户两点——"修好后窗口是最大化还是还原" + "两屏缩放是否相同"，直接锁定根因，
  少打两次没用的包。

### 体验修复：大纲默认展开 + 预览不重绘
- **大纲默认展开**：启动时 `OUTLINE_KEY` 无记录则默认展开（仅当用户上次显式关闭 `"0"`
  才保持收起）。
- **WebView2 局部不重绘**：预览（尤其下半部分）渲染后偶发空白，拖动/缩放窗口才刷新。
  新增 `forceRepaint()`——同一 JS 任务内切一次预览 `display` 触发同步重排+重绘（中间态不被
  绘制，无闪烁，保留滚动位置）；在 `renderPreview` / `setMode` / `setOutline` 后调用。

## 2026-06-11（续）

### 已发布：v0.2.2 双平台
- 打 tag `v0.2.2` 推 GitHub + Gitee；两边各建 Release，上传 `Dotdown_0.2.2_x64-setup.exe`
  （NSIS 2.8MB）与免安装 `dotdown.exe`（9.8MB）。
- 两仓库补充简介描述（GitHub 经 stored credential、Gitee 经 API v5）；Gitee 描述含中文，
  注意 `--data-urlencode` 直传命令行会被外层 shell 二次编码成乱码，**改用 `description@文件`
  从 UTF-8 文件读取**才正确。
- 打包踩坑：旧的 `target/` 缓存里残留更名前路径 `D:\projects\mdview\...` 导致首次
  `tauri build` 读取插件权限失败；`cargo clean` 后全量重编通过。

### 已完成：更新检查（轻量方案，v0.2.2）
- 关于弹窗加「检查更新」按钮 + 状态文案；启动时静默检查一次（仅有新版时弹关于窗提示）。
- 取版本：当前 `getVersion()`，远端取发行版 `tag_name`——**优先 Gitee**
  （`gitee.com/api/v5/...releases/latest`，国内快），失败回退 GitHub。
- `compareVersion()` 语义化逐段比较；有新版显示 `发现新版本 vX · 去下载`，
  用 `openUrl()`（`tauri-plugin-opener`）打开对应发行版页面（Gitee 命中开 Gitee）。
- 网络走 webview `fetch`（CSP=null 放行）；`opener:default` 含 `allow-default-urls`，
  无需改 capabilities。详见 `design.md §4.11`。
- **Gitee 镜像上线**：`https://gitee.com/caoqianming/dotdown.git`（国内下载提速）。

## 2026-06-11

### 修复（v0.2.1）
- **CRLF 文件被误判为已编辑**：CodeMirror 把文档规范化为 LF，而基准 `lastSaved` 仍是
  CRLF，导致 `isDirty` 恒为真（显示 ● + 关闭误报）。`isDirty` 改为按 `eol()` 规范化后比较。
- **关掉最后一个标签会重现欢迎文档**（显得未命名关不掉）：改为留一个空白未命名。
- **默认视图改为预览模式**，并记住上次选择（`localStorage` key `dotdown.mode`）。

### 已完成：导出 PDF + 文件关联（v0.2.0）
- **导出 PDF**：`window.print()` + `@media print`（只输出预览、强制浅色、代码块保留高亮、
  避免跨页截断）；工具栏「导出PDF」按钮 / Ctrl+P；PDF 默认文件名取自文件名。
- **文件关联 / 双击打开**：`bundle.fileAssociations` 注册 `.md/.markdown/.mdown`；
  `tauri-plugin-single-instance` 转发二次启动的文件到现有窗口；后端 `initial_file`
  读取启动参数，前端 `listen("open-file")` + 启动时打开。
- **右键「用 Dotdown 打开」**：NSIS 钩子 `installer-hooks.nsh` 写 `SystemFileAssociations`
  注册表项（卸载删除）。
- 版本号升至 **0.2.0**。
- 打包目标改为**仅 NSIS**：WiX/MSI 带文件关联时 `light.exe` 打包失败，且右键钩子本就只用于 NSIS。
- **修复安装后“缺 web dll”**：GNU 构建动态依赖 `WebView2Loader.dll`，安装包未带 → 启动报错。
  改用 `rust-toolchain.toml` 固定 **MSVC** 工具链，WebView2 loader 静态链接，exe 自包含
  （10MB，安装包 2.9MB）；dumpbin 确认依赖里已无 `WebView2Loader.dll`。
- 注：文件关联/右键菜单需**安装新包后生效**。

### 更名：mdview → Dotdown
- 全量替换：productName / 包名 / crate 名（`dotdown_lib`）/ identifier
  (`com.caoqi.dotdown`) / 窗口标题 / 关于弹窗 / localStorage key（`dotdown.*`）/ 文档。
- 更新应用图标（`tauri icon` 重新生成）。
- GitHub 仓库 `mdview` 重命名为 `dotdown`。

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

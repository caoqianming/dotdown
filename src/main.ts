import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open, save, message, ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  search,
  setSearchQuery,
  SearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
} from "@codemirror/search";

import MarkdownIt from "markdown-it";
// @ts-expect-error: 该插件无类型声明
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";

// 启动时的欢迎文档
const WELCOME = `# 欢迎使用 Dotdown

一个用 **Tauri** 打造的 Markdown 预览/编辑小工具。

## 试试这些功能

- 左侧编辑，右侧 **实时预览**
- 顶部切换 *编辑 / 分栏 / 预览* 视图
- 多标签页：Ctrl+T 新建，Ctrl+W 关闭
- 拖拽 \`.md\` 文件到窗口即可打开

### 代码高亮

\`\`\`js
function hello(name) {
  console.log(\`Hello, \${name}!\`);
}
\`\`\`

### 任务列表

- [x] 打开文件
- [x] 实时预览
- [ ] 写点东西

### 表格

| 快捷键 | 功能 |
| ------ | ---- |
| Ctrl+T | 新建标签 |
| Ctrl+O | 打开 |
| Ctrl+S | 保存 |

> 开始编辑左侧内容，预览会随之更新。
`;

// ---------- Markdown 渲染器 ----------
const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch {
        /* 忽略，回退到转义 */
      }
    }
    return md.utils.escapeHtml(code);
  },
}).use(taskLists, { enabled: true, label: true });

// ---------- 图片路径解析 ----------
/** 网络/数据 URI 等外部来源：原样输出，不当作本地文件处理。 */
function isExternalSrc(src: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src) && !/^[a-z]:[\\/]/i.test(src);
}

/** Windows 盘符路径或 POSIX 绝对路径。 */
function isAbsolutePath(p: string): boolean {
  return /^[a-z]:[\\/]/i.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

/** 取路径所在目录（兼容 \\ 与 /）。 */
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : "";
}

/** 以 baseDir 为基准解析相对路径，归一 . 与 ..，保留原平台分隔符。 */
function resolvePath(baseDir: string, rel: string): string {
  const sep = baseDir.includes("\\") ? "\\" : "/";
  const parts = (baseDir + "/" + rel).split(/[\\/]+/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join(sep);
}

/** 把 Markdown 里的本地图片 src 转成 WebView 可加载的 asset:// URL。 */
function resolveLocalImage(src: string): string {
  let p = src;
  try {
    p = decodeURI(src);
  } catch {
    /* 非法转义就用原串 */
  }
  if (isAbsolutePath(p)) return convertFileSrc(p);
  const base = activeTab()?.path ? dirOf(activeTab()!.path!) : "";
  if (!base) return src; // 未保存的新文档无目录，无法定位相对路径
  return convertFileSrc(resolvePath(base, p));
}

// 导出 HTML 时置真：保留图片原始路径（asset:// URL 换台机器打不开，
// 相对引用 assets/… 在导出文件同级时仍可用）。
let rawImagePaths = false;

// 覆写图片渲染：本地路径经 convertFileSrc 重写，外部链接原样保留
const defaultImageRender =
  md.renderer.rules.image ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const i = token.attrIndex("src");
  if (i >= 0 && token.attrs) {
    const src = token.attrs[i][1];
    if (!rawImagePaths && !isExternalSrc(src)) token.attrs[i][1] = resolveLocalImage(src);
  }
  return defaultImageRender(tokens, idx, options, env, self);
};

// ---------- 标签数据模型 ----------
interface Tab {
  id: number; // 自增唯一 id
  path: string | null; // 磁盘路径，null = 未保存的新文档
  lastSaved: string; // 上次保存时的内容，用于判定 dirty
  state: EditorState; // 该标签的 CodeMirror 状态（含撤销历史/光标）
}

const tabs: Tab[] = [];
let activeId = -1;
let tabSeq = 0;

// ---------- DOM 引用 ----------
const previewEl = document.getElementById("preview") as HTMLElement;
const titleEl = document.getElementById("doc-title") as HTMLElement;
const appEl = document.getElementById("app") as HTMLElement;
const tabbarEl = document.getElementById("tabbar") as HTMLElement;
const previewPane = document.querySelector(".pane-preview") as HTMLElement;

// ---------- 主题（浅色 / 深色 / 跟随系统）----------
type ThemeMode = "light" | "dark" | "system";
const THEME_KEY = "dotdown.theme";
const themeCompartment = new Compartment();
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

let themeMode: ThemeMode = readThemeMode();

function readThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

/** 当前生效的明暗（解析 system）。 */
function isDark(): boolean {
  return themeMode === "dark" || (themeMode === "system" && darkQuery.matches);
}

function editorThemeExt() {
  return isDark() ? oneDark : [];
}

// Lucide 扁平图标（MIT），用 currentColor 自适应明暗
const ICON_WRAP = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const THEME_ICON: Record<ThemeMode, string> = {
  light: ICON_WRAP(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  ),
  dark: ICON_WRAP('<path d="M12 3a6.364 6.364 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
  system: ICON_WRAP(
    '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  ),
};

/** 应用主题：设置根节点 data-theme、重配编辑器主题、刷新按钮。 */
function applyTheme() {
  document.documentElement.dataset.theme = isDark() ? "dark" : "light";
  editor.dispatch({ effects: themeCompartment.reconfigure(editorThemeExt()) });
  const btn = document.getElementById("btn-theme");
  if (btn) {
    const name: Record<ThemeMode, string> = { light: "浅色", dark: "深色", system: "跟随系统" };
    btn.innerHTML = THEME_ICON[themeMode];
    btn.title = `主题：${name[themeMode]}（点击切换）`;
  }
}

function cycleTheme() {
  const order: ThemeMode[] = ["light", "dark", "system"];
  themeMode = order[(order.indexOf(themeMode) + 1) % order.length];
  try {
    localStorage.setItem(THEME_KEY, themeMode);
  } catch {
    /* ignore */
  }
  applyTheme();
}

// 跟随系统时，系统明暗变化即时生效
darkQuery.addEventListener("change", () => {
  if (themeMode === "system") applyTheme();
});

// ---------- CodeMirror 编辑器（单 View，按标签换 State）----------
const onChange = EditorView.updateListener.of((u) => {
  if (u.docChanged) {
    renderPreview();
    refreshActiveDirty();
    updateTitle();
    scheduleSave();
  }
  // 文档或选区变化都刷新字数（选区变化用于显示「已选 N 字」）
  if (u.docChanged || u.selectionSet) updateWordCount();
});

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      themeCompartment.of(editorThemeExt()),
      EditorView.lineWrapping,
      // 搜索高亮（用自定义搜索条驱动，不开 CM 自带面板）
      search(),
      onChange,
      keymap.of([
        { key: "Mod-f", run: () => (openSearch(), true) },
        { key: "Mod-h", run: () => (openSearch(true), true) },
        { key: "Mod-s", run: () => (saveFile(), true) },
        { key: "Mod-Shift-s", run: () => (saveFileAs(), true) },
        { key: "Mod-o", run: () => (openFile(), true) },
        { key: "Mod-n", run: () => (newBlankDoc(), true) },
        { key: "Mod-t", run: () => (newBlankDoc(), true) },
        { key: "Mod-w", run: () => (closeTab(activeId), true) },
        { key: "Mod-\\", run: () => (toggleOutline(), true) },
        { key: "Mod-p", run: () => (exportPdf(), true) },
      ]),
    ],
  });
}

const editor = new EditorView({
  parent: document.getElementById("editor") as HTMLElement,
  state: makeState(""),
});

// ---------- 标签辅助 ----------
function activeTab(): Tab | undefined {
  return tabs.find((t) => t.id === activeId);
}

/** 取标签当前内容：激活标签以 editor 为准，其余以保存的 state 为准。 */
function docOf(t: Tab): string {
  return t.id === activeId ? editor.state.doc.toString() : t.state.doc.toString();
}

/** 统一换行符再比较：CodeMirror 会把文档规范化为 LF，避免 CRLF 文件被误判为已编辑。 */
function eol(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

function isDirty(t: Tab): boolean {
  return eol(docOf(t)) !== eol(t.lastSaved);
}

function nameOf(t: Tab): string {
  if (!t.path) return "未命名";
  return t.path.split(/[\\/]/).pop() ?? t.path;
}

/** 把激活标签的实时 state 写回其 tab 对象（切换/关闭前调用）。 */
function syncActive() {
  const cur = activeTab();
  if (cur) cur.state = editor.state;
}

// ---------- 标签栏渲染 ----------
const tabNameEls = new Map<number, HTMLElement>();
let dragTabId = -1;

/** 把标签 srcId 移到标签 destId 之前，重排并持久化。 */
function reorderTab(srcId: number, destId: number) {
  if (srcId < 0 || srcId === destId) return;
  const from = tabs.findIndex((t) => t.id === srcId);
  if (from < 0) return;
  const [moved] = tabs.splice(from, 1);
  const to = tabs.findIndex((t) => t.id === destId);
  tabs.splice(to < 0 ? tabs.length : to, 0, moved);
  renderTabs();
  saveSession();
}

function renderTabs() {
  tabbarEl.innerHTML = "";
  tabNameEls.clear();
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.id === activeId ? " active" : "");
    el.title = t.path ?? "未命名";
    el.addEventListener("click", () => switchTo(t.id));

    // 拖拽重排标签
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      dragTabId = t.id;
      el.classList.add("dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", () => {
      dragTabId = -1;
      el.classList.remove("dragging");
      tabbarEl.querySelectorAll(".tab.drop-target").forEach((x) => x.classList.remove("drop-target"));
    });
    el.addEventListener("dragover", (e) => {
      if (dragTabId < 0 || dragTabId === t.id) return;
      e.preventDefault();
      el.classList.add("drop-target");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("drop-target");
      reorderTab(dragTabId, t.id);
    });

    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = (isDirty(t) ? "● " : "") + nameOf(t);
    el.appendChild(name);
    tabNameEls.set(t.id, name);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "关闭 (Ctrl+W)";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeTab(t.id);
    });
    el.appendChild(close);

    tabbarEl.appendChild(el);
  }

  const add = document.createElement("button");
  add.className = "tab-add";
  add.textContent = "+";
  add.title = "新建标签 (Ctrl+T)";
  add.addEventListener("click", () => newTab());
  tabbarEl.appendChild(add);
}

/** 仅刷新激活标签的 dirty 标记（编辑时高频调用，避免整栏重建）。 */
function refreshActiveDirty() {
  const t = activeTab();
  if (!t) return;
  const span = tabNameEls.get(t.id);
  if (span) span.textContent = (isDirty(t) ? "● " : "") + nameOf(t);
}

// ---------- 预览渲染 ----------
function renderPreview() {
  previewEl.innerHTML = md.render(editor.state.doc.toString());
  buildOutline();
  forceRepaint();
  // 预览被重建会清掉高亮，若正在预览中搜索则重新标注
  if (!searchBar.hidden && searchTarget() === "preview") highlightPreview(searchInput.value);
}

/**
 * 修复 WebView2 偶发的局部不重绘：预览（尤其下半部分）有时渲染后仍空白，
 * 拖动/缩放窗口才刷新。在同一个 JS 任务内切一次 display 触发同步重排+重绘，
 * 中间态不会被绘制（无闪烁），并保留滚动位置。
 */
function forceRepaint() {
  const top = previewPane.scrollTop;
  previewEl.style.display = "none";
  void previewEl.offsetHeight; // 触发同步重排
  previewEl.style.display = "";
  previewPane.scrollTop = top;
}

// ---------- 标题栏 ----------
function updateTitle() {
  const t = activeTab();
  const dirty = t ? isDirty(t) : false;
  const dot = dirty ? "● " : "";
  const label = t ? (t.path ?? "未命名") : "未命名";
  titleEl.textContent = dot + label;
  void getCurrentWindow()
    .setTitle(`${dot}${t ? nameOf(t) : "Dotdown"} — Dotdown`)
    .catch(() => {});
}

// ---------- 标签操作 ----------
/** 仅创建并加入标签，不激活（供新建与会话恢复复用）。 */
function createTab(path: string | null, content: string, lastSaved: string): Tab {
  const t: Tab = { id: ++tabSeq, path, lastSaved, state: makeState(content) };
  tabs.push(t);
  return t;
}

/** 激活指定标签：换入其 state 并刷新界面。 */
function activate(id: number) {
  activeId = id;
  const t = activeTab();
  if (t) {
    editor.setState(t.state);
    // 该标签的 state 可能在不同主题下创建，换入后对齐当前主题
    editor.dispatch({ effects: themeCompartment.reconfigure(editorThemeExt()) });
  }
  renderTabs();
  renderPreview();
  updateTitle();
  updateWordCount();
  editor.focus();
}

function newTab(path: string | null = null, content = ""): Tab {
  syncActive();
  const t = createTab(path, content, content);
  activate(t.id);
  saveSession();
  return t;
}

function switchTo(id: number) {
  if (id === activeId) return;
  syncActive();
  activate(id);
  saveSession();
}

/** 用户主动新建空白文档：新建标签并切到分栏（预览模式下看不到编辑器，无法直接写）。 */
function newBlankDoc() {
  newTab();
  setMode("split");
}

async function closeTab(id: number) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  if (isDirty(t)) {
    const discard = await ask(`「${nameOf(t)}」有未保存的修改，确定要关闭吗？`, {
      title: "未保存的修改",
      kind: "warning",
    });
    if (!discard) return;
  }
  const idx = tabs.indexOf(t);
  tabs.splice(idx, 1);

  if (tabs.length === 0) {
    // 关掉最后一个标签后留一个空白未命名（而非重现欢迎文档）
    activeId = -1;
    newTab();
    return;
  }
  if (id === activeId) {
    const neighbor = tabs[Math.max(0, idx - 1)];
    activate(neighbor.id);
  } else {
    renderTabs();
  }
  saveSession();
}

// ---------- 文件操作 ----------
async function openFile() {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] }],
  });
  if (typeof selected === "string") {
    await loadPath(selected);
  }
}

async function loadPath(path: string) {
  // 已打开则切换到对应标签，不重复打开
  const existing = tabs.find((t) => t.path === path);
  if (existing) {
    switchTo(existing.id);
    setMode("split"); // 打开文件即切到分栏，方便边看边改
    pushRecent(path);
    return;
  }
  try {
    const content = await invoke<string>("read_file", { path });
    newTab(path, content);
    setMode("split");
    pushRecent(path);
  } catch (e) {
    removeRecent(path); // 文件已不存在/打不开，从历史移除
    await message(String(e), { title: "打开失败", kind: "error" });
  }
}

async function saveFile() {
  const t = activeTab();
  if (!t) return;
  if (!t.path) return saveFileAs();
  await writeTo(t, t.path);
}

async function saveFileAs() {
  const t = activeTab();
  if (!t) return;
  const path = await save({
    defaultPath: t.path ?? "未命名.md",
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (path) await writeTo(t, path);
}

async function writeTo(t: Tab, path: string) {
  try {
    const content = editor.state.doc.toString();
    await invoke("write_file", { path, content });
    t.path = path;
    t.lastSaved = content;
    pushRecent(path);
    renderTabs();
    updateTitle();
    saveSession();
  } catch (e) {
    await message(String(e), { title: "保存失败", kind: "error" });
  }
}

// ---------- 图片插入（粘贴 / 拖入）----------
const IMG_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
let imgSeq = 0;

/** 在光标处插入文本，并把光标移到插入内容之后。 */
function insertAtCursor(text: string) {
  const { from, to } = editor.state.selection.main;
  editor.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
  });
  editor.focus();
}

function baseNameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 预览模式下看不到编辑器，插入图片后切到分栏以便确认。 */
function ensureVisibleForEdit() {
  if (appEl.classList.contains("mode-preview")) setMode("split");
}

/**
 * 把粘贴的图片字节落到文档同级 assets/ 并插入相对引用。
 * 文档尚未保存（无路径）时退回内联 base64，保证仍能显示。
 */
async function insertPastedImage(bytes: Uint8Array, mime: string) {
  // 未保存文档没有同级目录可放 assets/——先让用户保存，避免退回臃肿的内联 base64
  if (!activeTab()?.path) {
    await message("粘贴图片前请先保存文档：图片会存到文档同级 assets/ 目录。", {
      title: "请先保存文档",
      kind: "info",
    });
    await saveFileAs();
  }
  const path = activeTab()?.path;
  if (!path) return; // 用户取消保存，放弃插入（不再吐 base64）
  const dir = dirOf(path);
  const sep = dir.includes("\\") ? "\\" : "/";
  const ext = IMG_MIME_EXT[mime] ?? "png";
  const name = `image-${Date.now()}-${++imgSeq}.${ext}`;
  try {
    await invoke("write_bytes", { path: `${dir}${sep}assets${sep}${name}`, bytes: Array.from(bytes) });
    insertAtCursor(`![](assets/${name})`);
  } catch (e) {
    await message(String(e), { title: "图片保存失败", kind: "error" });
  }
}

/** 把拖入的图片文件复制到文档同级 assets/ 并插入相对引用；无文档路径则引用原始绝对路径。 */
async function insertDroppedImage(srcPath: string) {
  const t = activeTab();
  const name = baseNameOf(srcPath);
  ensureVisibleForEdit();
  if (t?.path) {
    const dir = dirOf(t.path);
    const sep = dir.includes("\\") ? "\\" : "/";
    try {
      await invoke("copy_file", { src: srcPath, dest: `${dir}${sep}assets${sep}${name}` });
      insertAtCursor(`![](assets/${name})`);
    } catch (e) {
      await message(String(e), { title: "图片导入失败", kind: "error" });
    }
  } else {
    insertAtCursor(`![](${srcPath.replace(/\\/g, "/")})`);
  }
}

// 粘贴图片：拦截剪贴板里的图片，落盘并插入引用
editor.dom.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const file = it.getAsFile();
      if (!file) continue;
      e.preventDefault();
      void (async () => {
        await insertPastedImage(new Uint8Array(await file.arrayBuffer()), file.type);
      })();
      return;
    }
  }
});

// ---------- 视图模式 ----------
type ViewMode = "editor" | "split" | "preview";
const MODE_KEY = "dotdown.mode";

function setMode(mode: ViewMode) {
  appEl.classList.remove("mode-editor", "mode-split", "mode-preview");
  appEl.classList.add(`mode-${mode}`);
  document
    .querySelectorAll(".view-modes button")
    .forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.mode === mode));
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* ignore */
  }
  forceRepaint();
  // 切换视图会改变搜索目标（编辑器/预览），重跑当前查询
  if (!searchBar.hidden) runSearch();
}

// ---------- 大纲侧栏 ----------
const outlineEl = document.getElementById("outline") as HTMLElement;
const OUTLINE_KEY = "dotdown.outline";

/** 从已渲染的预览中提取标题，生成可点击跳转的大纲。 */
function buildOutline() {
  const heads = previewEl.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6");
  outlineEl.innerHTML = "";
  if (heads.length === 0) {
    const empty = document.createElement("div");
    empty.className = "outline-empty";
    empty.textContent = "（无标题）";
    outlineEl.appendChild(empty);
    return;
  }
  heads.forEach((h, i) => {
    h.id = `mdh-${i}`;
    const level = Number(h.tagName[1]);
    const item = document.createElement("button");
    item.className = "outline-item";
    item.textContent = h.textContent ?? "";
    item.title = item.textContent;
    item.style.paddingLeft = `${12 + (level - 1) * 14}px`;
    item.addEventListener("click", () => h.scrollIntoView({ behavior: "smooth", block: "start" }));
    outlineEl.appendChild(item);
  });
}

function setOutline(open: boolean) {
  appEl.classList.toggle("outline-open", open);
  try {
    localStorage.setItem(OUTLINE_KEY, open ? "1" : "0");
  } catch {
    /* ignore */
  }
  forceRepaint();
}

function toggleOutline() {
  setOutline(!appEl.classList.contains("outline-open"));
}

// ---------- 搜索（编辑器 + 预览统一搜索条）----------
// 预览模式搜渲染后的 DOM（高亮 mark 并逐个跳转）；编辑/分栏模式驱动 CodeMirror
// 的 search 扩展（高亮全部匹配，findNext/findPrevious 跳转）。
const searchBar = document.getElementById("search-bar") as HTMLElement;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchCount = document.getElementById("search-count") as HTMLElement;
const replaceRow = document.getElementById("replace-row") as HTMLElement;
const replaceInput = document.getElementById("replace-input") as HTMLInputElement;
const replaceToggle = document.getElementById("search-toggle-replace") as HTMLButtonElement;

let previewHits: HTMLElement[] = [];
let previewIdx = -1;

/** 当前搜索目标：预览模式搜预览，否则（编辑/分栏）搜编辑器。 */
function searchTarget(): "editor" | "preview" {
  return appEl.classList.contains("mode-preview") ? "preview" : "editor";
}

/** 当前查询：附带替换串，供 replaceNext/replaceAll 使用。 */
function searchQuery(): SearchQuery {
  return new SearchQuery({ search: searchInput.value, replace: replaceInput.value });
}

/** 展开/收起替换行；替换仅对编辑器有效，预览模式下隐藏整块。 */
function setReplaceOpen(open: boolean) {
  replaceRow.hidden = !open;
  replaceToggle.textContent = open ? "▾" : "▸";
  replaceToggle.classList.toggle("open", open);
}

/** 预览模式无法替换：隐藏替换切换与替换行。 */
function updateReplaceAvailability() {
  const preview = searchTarget() === "preview";
  replaceToggle.hidden = preview;
  if (preview) replaceRow.hidden = true;
}

function openSearch(withReplace = false) {
  searchBar.hidden = false;
  updateReplaceAvailability();
  if (withReplace && searchTarget() === "editor") setReplaceOpen(true);
  searchInput.focus();
  searchInput.select();
  runSearch();
}

function closeSearch() {
  searchBar.hidden = true;
  clearPreviewHighlights();
  editor.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
  editor.focus();
}

/** 输入变化时执行：按当前目标分派到编辑器或预览。 */
function runSearch() {
  if (searchBar.hidden) return;
  updateReplaceAvailability();
  const q = searchInput.value;
  if (searchTarget() === "preview") {
    editor.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
    highlightPreview(q);
  } else {
    clearPreviewHighlights();
    editor.dispatch({ effects: setSearchQuery.of(searchQuery()) });
    if (q) findNext(editor);
    updateCount();
  }
}

/** 替换当前匹配（仅编辑器）。 */
function replaceOne() {
  if (searchTarget() !== "editor" || !searchInput.value) return;
  editor.dispatch({ effects: setSearchQuery.of(searchQuery()) });
  replaceNext(editor);
  updateCount();
}

/** 替换全部匹配（仅编辑器）。 */
function replaceAllMatches() {
  if (searchTarget() !== "editor" || !searchInput.value) return;
  editor.dispatch({ effects: setSearchQuery.of(searchQuery()) });
  replaceAll(editor);
  updateCount();
}

function searchNext() {
  if (searchTarget() === "preview") {
    if (!previewHits.length) return;
    previewIdx = (previewIdx + 1) % previewHits.length;
    setCurrentHit();
    updateCount();
  } else {
    findNext(editor);
  }
}

function searchPrev() {
  if (searchTarget() === "preview") {
    if (!previewHits.length) return;
    previewIdx = (previewIdx - 1 + previewHits.length) % previewHits.length;
    setCurrentHit();
    updateCount();
  } else {
    findPrevious(editor);
  }
}

// ----- 预览（DOM）搜索 -----
/** 还原所有 <mark> 高亮：用其文本节点替换，并合并相邻文本节点。 */
function clearPreviewHighlights() {
  previewEl.querySelectorAll("mark.search-hit").forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent ?? ""), m);
    parent.normalize();
  });
  previewHits = [];
  previewIdx = -1;
}

/** 在预览 DOM 中大小写不敏感地高亮所有匹配，定位到第一个。 */
function highlightPreview(query: string) {
  clearPreviewHighlights();
  if (!query) {
    updateCount();
    return;
  }
  const needle = query.toLowerCase();
  const targets: Text[] = [];
  const walker = document.createTreeWalker(previewEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const v = node.nodeValue;
      if (!v) return NodeFilter.FILTER_REJECT;
      const tag = node.parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      return v.toLowerCase().includes(needle)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) targets.push(n as Text);

  for (const node of targets) {
    const text = node.nodeValue ?? "";
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let i = 0;
    let pos = lower.indexOf(needle, i);
    while (pos !== -1) {
      if (pos > i) frag.appendChild(document.createTextNode(text.slice(i, pos)));
      const mark = document.createElement("mark");
      mark.className = "search-hit";
      mark.textContent = text.slice(pos, pos + query.length);
      frag.appendChild(mark);
      previewHits.push(mark);
      i = pos + query.length;
      pos = lower.indexOf(needle, i);
    }
    if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
    node.parentNode?.replaceChild(frag, node);
  }

  previewIdx = previewHits.length ? 0 : -1;
  setCurrentHit();
  updateCount();
}

function setCurrentHit() {
  previewHits.forEach((m, i) => m.classList.toggle("search-hit-current", i === previewIdx));
  if (previewIdx >= 0)
    previewHits[previewIdx].scrollIntoView({ behavior: "smooth", block: "center" });
}

/** 更新匹配计数：预览显示「当前/总数」，编辑器显示总数。 */
function updateCount() {
  const q = searchInput.value;
  if (searchTarget() === "preview") {
    searchCount.textContent = previewHits.length
      ? `${previewIdx + 1}/${previewHits.length}`
      : q
        ? "无结果"
        : "";
    return;
  }
  if (!q) {
    searchCount.textContent = "";
    return;
  }
  const sq = new SearchQuery({ search: q });
  let count = 0;
  if (sq.valid) {
    const cursor = sq.getCursor(editor.state.doc);
    while (!cursor.next().done) count++;
  }
  searchCount.textContent = count ? `${count} 处` : "无结果";
}

// ---------- 字数统计（状态栏）----------
const statusWordsEl = document.getElementById("status-words") as HTMLElement;

/** 统计字数：CJK 字符按字计，连续的字母/数字串算一个词。 */
function countWords(text: string): number {
  const cjk = (text.match(/[㐀-鿿぀-ヿ가-힯]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9À-ɏ]+/g) ?? []).length;
  return cjk + words;
}

/** 刷新底部状态栏：字数 / 字符 / 行；有选区时额外显示已选字数。 */
function updateWordCount() {
  const doc = editor.state.doc;
  const text = doc.toString();
  const chars = text.replace(/\r?\n/g, "").length;
  let s = `字数 ${countWords(text)} · 字符 ${chars} · 行 ${doc.lines}`;
  const sel = editor.state.selection.main;
  if (!sel.empty) {
    const picked = editor.state.sliceDoc(sel.from, sel.to);
    s += ` · 已选 ${countWords(picked)} 字`;
  }
  statusWordsEl.textContent = s;
}

// ---------- 导出 HTML（自包含单文件）----------
// 内联一套浅色 markdown 样式（不随应用主题），换台机器/浏览器打开也好看。
const EXPORT_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#24292f;font-family:-apple-system,"Segoe UI","Microsoft YaHei",Roboto,sans-serif;font-size:16px;line-height:1.7}
.markdown-body{max-width:860px;margin:0 auto;padding:40px 24px}
.markdown-body h1,.markdown-body h2{border-bottom:1px solid #e2e4e8;padding-bottom:.3em}
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4{margin-top:1.4em;margin-bottom:.6em;font-weight:600;line-height:1.3}
.markdown-body h1{font-size:1.9em}.markdown-body h2{font-size:1.5em}.markdown-body h3{font-size:1.25em}
.markdown-body p,.markdown-body ul,.markdown-body ol{margin:.6em 0}
.markdown-body a{color:#1a56db;text-decoration:none}.markdown-body a:hover{text-decoration:underline}
.markdown-body code{background:#f3f4f6;padding:.15em .4em;border-radius:4px;font-family:"Cascadia Code",Consolas,monospace;font-size:.88em}
.markdown-body pre{background:#0d1117;color:#e6edf3;padding:14px 16px;border-radius:8px;overflow:auto}
.markdown-body pre code{background:none;padding:0;color:inherit;font-size:.85em}
.markdown-body blockquote{margin:.8em 0;padding:.2em 1em;color:#6b7280;border-left:4px solid #e2e4e8;background:#f6f7f9}
.markdown-body table{border-collapse:collapse;margin:.8em 0}
.markdown-body th,.markdown-body td{border:1px solid #e2e4e8;padding:6px 13px}
.markdown-body th{background:#f6f7f9}
.markdown-body img{max-width:100%;border-radius:6px}
.markdown-body hr{border:none;border-top:1px solid #e2e4e8;margin:1.5em 0}
.markdown-body ul.contains-task-list{list-style:none;padding-left:1.2em}
.markdown-body .task-list-item-checkbox{margin-right:.5em}
.hljs-comment,.hljs-quote{color:#8b949e}
.hljs-keyword,.hljs-selector-tag{color:#ff7b72}
.hljs-string,.hljs-attr{color:#a5d6ff}
.hljs-number,.hljs-literal{color:#79c0ff}
.hljs-title,.hljs-section{color:#d2a8ff}
.hljs-built_in,.hljs-type{color:#ffa657}
`;

/** 渲染当前文档为自包含 HTML 文档字符串（图片保留原始路径）。 */
function buildExportHtml(title: string): string {
  rawImagePaths = true;
  let body: string;
  try {
    body = md.render(editor.state.doc.toString());
  } finally {
    rawImagePaths = false;
  }
  const safeTitle = md.utils.escapeHtml(title);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<article class="markdown-body">
${body}</article>
</body>
</html>
`;
}

async function exportHtml() {
  const t = activeTab();
  const stem = t && t.path ? nameOf(t).replace(/\.[^.]+$/, "") : "未命名";
  const path = await save({
    defaultPath: t?.path ? `${dirOf(t.path)}${t.path.includes("\\") ? "\\" : "/"}${stem}.html` : `${stem}.html`,
    filters: [{ name: "HTML", extensions: ["html", "htm"] }],
  });
  if (!path) return;
  try {
    await invoke("write_file", { path, content: buildExportHtml(stem) });
  } catch (e) {
    await message(String(e), { title: "导出 HTML 失败", kind: "error" });
  }
}

// ---------- 关于 / 帮助 弹窗 ----------
const aboutOverlay = document.getElementById("about-overlay") as HTMLElement;

function openAbout() {
  aboutOverlay.hidden = false;
}

function closeAbout() {
  aboutOverlay.hidden = true;
}

// ---------- 检查更新（轻量方案：只查版本 + 跳转下载页，不在应用内下载）----------
// 仓库坐标。国内用户优先 Gitee，失败回退 GitHub。
const REPO = "caoqianming/dotdown";
const GITEE_RELEASES = `https://gitee.com/${REPO}/releases`;
const GITHUB_RELEASES = `https://github.com/${REPO}/releases`;

// 语义化版本比较：a > b 返回正数。仅比较数字段，忽略前缀 v 与预发布标记。
function compareVersion(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .replace(/^v/i, "")
      .split(/[.\-+]/)
      .map((x) => parseInt(x, 10))
      .filter((n) => !Number.isNaN(n));
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// 取最新发行版：优先 Gitee，失败回退 GitHub。返回 tag、下载页与（可选）更新说明。
async function fetchLatest(): Promise<{ tag: string; page: string; body: string } | null> {
  // Gitee：国内访问快，作为首选
  try {
    const r = await fetch(`https://gitee.com/api/v5/repos/${REPO}/releases/latest`);
    if (r.ok) {
      const j = await r.json();
      if (j?.tag_name) return { tag: j.tag_name, page: GITEE_RELEASES, body: j.body || "" };
    }
  } catch {
    /* 回退 GitHub */
  }
  // GitHub 回退
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (r.ok) {
      const j = await r.json();
      if (j?.tag_name)
        return { tag: j.tag_name, page: j.html_url || GITHUB_RELEASES, body: j.body || "" };
    }
  } catch {
    /* 两端均失败 */
  }
  return null;
}

const updateStatus = document.getElementById("update-status") as HTMLElement;
const btnCheckUpdate = document.getElementById("btn-check-update") as HTMLButtonElement;

// silent=true：仅在有新版时提示，无新版/出错都不打扰（用于启动时静默检查）。
async function checkUpdate(silent = false) {
  if (!silent) {
    btnCheckUpdate.disabled = true;
    updateStatus.textContent = "检查中…";
  }
  const latest = await fetchLatest();
  if (!latest) {
    if (!silent) updateStatus.textContent = "检查失败，请稍后重试";
    btnCheckUpdate.disabled = false;
    return;
  }
  const current = await getVersion();
  if (compareVersion(latest.tag, current) > 0) {
    // 有新版：在关于弹窗内提示，并提供“去下载”链接
    updateStatus.innerHTML = `发现新版本 ${latest.tag} · <a id="update-download">去下载</a>`;
    document.getElementById("update-download")!.addEventListener("click", () => {
      void openUrl(latest.page);
    });
    if (silent && aboutOverlay.hidden) openAbout();
  } else if (!silent) {
    updateStatus.textContent = "已是最新版本";
  }
  btnCheckUpdate.disabled = false;
}

// ---------- 导出 PDF（走 WebView 打印，选“另存为 PDF”）----------
let titleBeforePrint = "";

window.addEventListener("afterprint", () => {
  if (titleBeforePrint) {
    document.title = titleBeforePrint;
    titleBeforePrint = "";
  }
});

function exportPdf() {
  const t = activeTab();
  // 用文件名作为 PDF 默认文件名（去扩展名），打印结束后还原
  titleBeforePrint = document.title;
  document.title = t && t.path ? nameOf(t).replace(/\.[^.]+$/, "") : "Dotdown";
  window.print();
}

// ---------- 滚动同步（编辑器 -> 预览）----------
editor.scrollDOM.addEventListener("scroll", () => {
  const se = editor.scrollDOM;
  const ratio = se.scrollTop / Math.max(1, se.scrollHeight - se.clientHeight);
  previewPane.scrollTop = ratio * (previewPane.scrollHeight - previewPane.clientHeight);
});

// ---------- 会话持久化（重启恢复）----------
// 存于 WebView 的 localStorage（Tauri 数据目录持久化）。干净的已存盘文件只记录
// 路径、重启时从磁盘重载（能反映外部改动）；有未保存改动或未命名的标签则连内容
// 一起保存，避免丢失。
const SESSION_KEY = "dotdown.session";

interface PersistedTab {
  path: string | null;
  content: string | null; // null = 干净的已存盘文件，重启时从磁盘重载
}

let saveTimer = 0;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveSession, 500);
}

function saveSession() {
  syncActive();
  const data = {
    activeIndex: Math.max(
      0,
      tabs.findIndex((t) => t.id === activeId),
    ),
    tabs: tabs.map<PersistedTab>((t) => ({
      path: t.path,
      content: t.path && !isDirty(t) ? null : docOf(t),
    })),
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch {
    /* 配额/隐私模式等失败时忽略 */
  }
}

async function restoreSession(): Promise<boolean> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SESSION_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;

  let data: { activeIndex?: number; tabs?: PersistedTab[] };
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!data || !Array.isArray(data.tabs) || data.tabs.length === 0) return false;

  for (const pt of data.tabs) {
    const path = typeof pt.path === "string" ? pt.path : null;
    let disk: string | null = null;
    if (path) {
      try {
        disk = await invoke<string>("read_file", { path });
      } catch {
        disk = null;
      }
    }

    let content: string;
    let lastSaved: string;
    if (pt.content == null) {
      // 干净文件：用磁盘最新内容；文件已不存在则跳过该标签
      if (disk == null) continue;
      content = disk;
      lastSaved = disk;
    } else {
      content = pt.content;
      lastSaved = path ? (disk ?? pt.content) : "";
    }
    createTab(path, content, lastSaved);
  }

  if (tabs.length === 0) return false;
  const idx = Math.min(Math.max(0, data.activeIndex ?? 0), tabs.length - 1);
  activate(tabs[idx].id);
  saveSession();
  return true;
}

// ---------- 最近打开历史 ----------
// 记录已存盘文件的路径，供「最近」下拉一键重开。仅存路径（不存内容），
// 与会话恢复正交：会话恢复上次的标签，历史是所有近期打开过的文件。
const RECENT_KEY = "dotdown.recent";
const RECENT_MAX = 15;

interface RecentItem {
  path: string;
  name: string;
  ts: number;
}

function loadRecent(): RecentItem[] {
  try {
    const arr = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x.path === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(items: RecentItem[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(items));
  } catch {
    /* 配额/隐私模式失败时忽略 */
  }
}

/** 记录一次打开/保存：去重置顶、限长。 */
function pushRecent(path: string) {
  const items = loadRecent().filter((x) => x.path !== path);
  items.unshift({ path, name: baseNameOf(path), ts: Date.now() });
  saveRecent(items.slice(0, RECENT_MAX));
}

function removeRecent(path: string) {
  saveRecent(loadRecent().filter((x) => x.path !== path));
}

const recentBtn = document.getElementById("btn-recent") as HTMLButtonElement;
const recentMenu = document.getElementById("recent-menu") as HTMLElement;

function renderRecentMenu() {
  recentMenu.innerHTML = "";
  const items = loadRecent();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    empty.textContent = "暂无最近打开的文件";
    recentMenu.appendChild(empty);
    return;
  }
  for (const it of items) {
    const row = document.createElement("button");
    row.className = "recent-item";
    row.title = it.path;
    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = it.name;
    const path = document.createElement("span");
    path.className = "recent-path";
    path.textContent = it.path;
    row.append(name, path);
    row.addEventListener("click", () => {
      closeRecent();
      void loadPath(it.path);
    });
    recentMenu.appendChild(row);
  }
  const foot = document.createElement("div");
  foot.className = "recent-foot";
  const clear = document.createElement("button");
  clear.textContent = "清空历史";
  clear.addEventListener("click", () => {
    saveRecent([]);
    renderRecentMenu();
  });
  foot.appendChild(clear);
  recentMenu.appendChild(foot);
}

function openRecent() {
  renderRecentMenu();
  recentMenu.hidden = false;
}
function closeRecent() {
  recentMenu.hidden = true;
}

recentBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (recentMenu.hidden) openRecent();
  else closeRecent();
});

// ---------- 导出下拉菜单（PDF / HTML）----------
const exportBtn = document.getElementById("btn-export") as HTMLButtonElement;
const exportMenu = document.getElementById("export-menu") as HTMLElement;

function closeExportMenu() {
  exportMenu.hidden = true;
}
exportBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  exportMenu.hidden = !exportMenu.hidden;
});

// 点击菜单外、或按 Esc 关闭（最近 / 导出 两个下拉）
document.addEventListener("click", (e) => {
  const target = e.target as Node;
  if (!recentMenu.hidden && !recentMenu.contains(target) && !recentBtn.contains(target))
    closeRecent();
  if (!exportMenu.hidden && !exportMenu.contains(target) && !exportBtn.contains(target))
    closeExportMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!recentMenu.hidden) closeRecent();
  if (!exportMenu.hidden) closeExportMenu();
});

// ---------- 事件绑定 ----------
document.getElementById("btn-new")!.addEventListener("click", () => newBlankDoc());
document.getElementById("btn-open")!.addEventListener("click", openFile);
document.getElementById("btn-save")!.addEventListener("click", saveFile);
document.getElementById("btn-saveas")!.addEventListener("click", saveFileAs);
document.getElementById("btn-pdf")!.addEventListener("click", () => {
  closeExportMenu();
  exportPdf();
});
document.getElementById("btn-html")!.addEventListener("click", () => {
  closeExportMenu();
  void exportHtml();
});
document.getElementById("btn-search")!.addEventListener("click", () => openSearch());
document.getElementById("btn-theme")!.addEventListener("click", cycleTheme);
document.getElementById("btn-outline")!.addEventListener("click", toggleOutline);
document.getElementById("btn-about")!.addEventListener("click", openAbout);
document.getElementById("about-close")!.addEventListener("click", closeAbout);
btnCheckUpdate.addEventListener("click", () => void checkUpdate(false));
aboutOverlay.addEventListener("click", (e) => {
  if (e.target === aboutOverlay) closeAbout();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !aboutOverlay.hidden) closeAbout();
});

// 搜索条事件
document.getElementById("search-next")!.addEventListener("click", searchNext);
document.getElementById("search-prev")!.addEventListener("click", searchPrev);
document.getElementById("search-close")!.addEventListener("click", closeSearch);
document.getElementById("replace-one")!.addEventListener("click", replaceOne);
document.getElementById("replace-all")!.addEventListener("click", replaceAllMatches);
replaceToggle.addEventListener("click", () => setReplaceOpen(replaceRow.hidden));
replaceInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) replaceAllMatches();
    else replaceOne();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  }
});
searchInput.addEventListener("input", runSearch);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) searchPrev();
    else searchNext();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  }
});
// 预览模式下编辑器无焦点，靠全局 Ctrl+F 唤起搜索条
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    openSearch();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === "h" || e.key === "H")) {
    e.preventDefault();
    openSearch(true);
  }
});
document
  .querySelectorAll(".view-modes button")
  .forEach((b) =>
    b.addEventListener("click", () =>
      setMode((b as HTMLElement).dataset.mode as "editor" | "split" | "preview"),
    ),
  );

// 拖拽到窗口：.md 文件新开标签；图片文件插入当前文档
getCurrentWebview().onDragDropEvent(async (event) => {
  if (event.payload.type !== "drop") return;
  for (const p of event.payload.paths) {
    if (/\.(md|markdown|mdown|txt)$/i.test(p)) await loadPath(p);
    else if (IMG_EXT_RE.test(p)) await insertDroppedImage(p);
  }
});

// 关闭前刷新会话并提醒未保存
window.addEventListener("beforeunload", (e) => {
  saveSession();
  if (tabs.some(isDirty)) e.preventDefault();
});

// ---------- 外部改动检测（窗口聚焦时比对磁盘）----------
// 运行期间别的编辑器改了已打开的文件，Dotdown 自己不会知道。窗口重新聚焦时
// 逐个比对已打开文件的磁盘内容：干净标签静默重载；有未保存修改（冲突）则弹窗让用户选。
let checkingExternal = false;

/** 用磁盘内容重载某标签：换入新 state 并把 lastSaved 对齐磁盘（变干净）。 */
function reloadTabFromDisk(t: Tab, disk: string) {
  t.lastSaved = disk;
  if (t.id === activeId) {
    editor.setState(makeState(disk));
    editor.dispatch({ effects: themeCompartment.reconfigure(editorThemeExt()) });
    renderPreview();
    updateWordCount();
  } else {
    t.state = makeState(disk);
  }
}

async function checkExternalChanges() {
  if (checkingExternal) return;
  checkingExternal = true;
  try {
    syncActive();
    let changed = false;
    // 拷贝一份快照：await 期间标签数组可能变动（用户关标签等）
    for (const t of [...tabs]) {
      if (!t.path || !tabs.includes(t)) continue;
      let disk: string;
      try {
        disk = await invoke<string>("read_file", { path: t.path });
      } catch {
        continue; // 文件被删/暂时读不到，忽略，不打扰
      }
      if (eol(disk) === eol(t.lastSaved)) continue; // 磁盘无外部改动

      if (!isDirty(t)) {
        reloadTabFromDisk(t, disk); // 干净标签：静默重载
      } else {
        const reload = await ask(
          `「${nameOf(t)}」在外部被修改了，磁盘内容与你未保存的修改不一致。\n\n重载会放弃你的本地修改。`,
          {
            title: "文件已被外部修改",
            kind: "warning",
            okLabel: "重载（放弃本地）",
            cancelLabel: "保留本地修改",
          },
        );
        if (reload) reloadTabFromDisk(t, disk);
        else t.lastSaved = disk; // 记下已知磁盘状态，避免每次聚焦重复弹窗
      }
      changed = true;
    }
    if (changed) {
      renderTabs();
      updateTitle();
      saveSession();
    }
  } finally {
    checkingExternal = false;
  }
}

// ---------- 初始化 ----------
async function init() {
  applyTheme();
  try {
    // 默认展开大纲；仅当用户上次显式关闭（"0"）才保持收起
    setOutline(localStorage.getItem(OUTLINE_KEY) !== "0");
  } catch {
    setOutline(true);
  }
  try {
    // 默认预览模式；记住上次选择
    const m = localStorage.getItem(MODE_KEY);
    setMode(m === "editor" || m === "split" || m === "preview" ? m : "preview");
  } catch {
    setMode("preview");
  }
  try {
    document.getElementById("about-version")!.textContent = "v" + (await getVersion());
  } catch {
    /* ignore */
  }
  const restored = await restoreSession();
  if (!restored) newTab(null, WELCOME);

  // 文件关联：监听二次实例转发的文件
  void listen<string>("open-file", (e) => {
    if (e.payload) void loadPath(e.payload);
  });
  // 窗口重新聚焦时检查已打开文件是否被外部改动（干净标签静默重载，冲突弹窗）
  void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) void checkExternalChanges();
  });
  // 本次启动若由双击/右键“用 Dotdown 打开”带入文件，打开它
  try {
    const f = await invoke<string | null>("initial_file");
    if (f) await loadPath(f);
  } catch {
    /* ignore */
  }
  // 启动时静默检查一次更新：仅在有新版时弹关于窗提示，失败/最新都不打扰
  void checkUpdate(true);

  // 首屏渲染完成后，让后端抖一下窗口尺寸，逼 WebView2 按当前显示器/DPI 重新铺设画面。
  // 修复在扩展屏上首次打开时右侧内容被裁掉、需手动拖动才正常的问题。
  requestAnimationFrame(() => void invoke("fix_webview_paint").catch(() => {}));
}
void init();

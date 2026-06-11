import { invoke } from "@tauri-apps/api/core";
import { open, save, message, ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";

import MarkdownIt from "markdown-it";
// @ts-expect-error: 该插件无类型声明
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";

// 启动时的欢迎文档
const WELCOME = `# 欢迎使用 mdview

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
const THEME_KEY = "mdview.theme";
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
});

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      themeCompartment.of(editorThemeExt()),
      EditorView.lineWrapping,
      onChange,
      keymap.of([
        { key: "Mod-s", run: () => (saveFile(), true) },
        { key: "Mod-Shift-s", run: () => (saveFileAs(), true) },
        { key: "Mod-o", run: () => (openFile(), true) },
        { key: "Mod-n", run: () => (newTab(), true) },
        { key: "Mod-t", run: () => (newTab(), true) },
        { key: "Mod-w", run: () => (closeTab(activeId), true) },
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

function isDirty(t: Tab): boolean {
  return docOf(t) !== t.lastSaved;
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

function renderTabs() {
  tabbarEl.innerHTML = "";
  tabNameEls.clear();
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.id === activeId ? " active" : "");
    el.title = t.path ?? "未命名";
    el.addEventListener("click", () => switchTo(t.id));

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
}

// ---------- 标题栏 ----------
function updateTitle() {
  const t = activeTab();
  const dirty = t ? isDirty(t) : false;
  const dot = dirty ? "● " : "";
  const label = t ? (t.path ?? "未命名") : "未命名";
  titleEl.textContent = dot + label;
  void getCurrentWindow()
    .setTitle(`${dot}${t ? nameOf(t) : "mdview"} — mdview`)
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
    activeId = -1;
    newTab(null, WELCOME);
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
    return;
  }
  try {
    const content = await invoke<string>("read_file", { path });
    newTab(path, content);
  } catch (e) {
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
    renderTabs();
    updateTitle();
    saveSession();
  } catch (e) {
    await message(String(e), { title: "保存失败", kind: "error" });
  }
}

// ---------- 视图模式 ----------
function setMode(mode: "editor" | "split" | "preview") {
  appEl.className = `mode-${mode}`;
  document
    .querySelectorAll(".view-modes button")
    .forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.mode === mode));
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
const SESSION_KEY = "mdview.session";

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

// ---------- 事件绑定 ----------
document.getElementById("btn-new")!.addEventListener("click", () => newTab());
document.getElementById("btn-open")!.addEventListener("click", openFile);
document.getElementById("btn-save")!.addEventListener("click", saveFile);
document.getElementById("btn-saveas")!.addEventListener("click", saveFileAs);
document.getElementById("btn-theme")!.addEventListener("click", cycleTheme);
document
  .querySelectorAll(".view-modes button")
  .forEach((b) =>
    b.addEventListener("click", () =>
      setMode((b as HTMLElement).dataset.mode as "editor" | "split" | "preview"),
    ),
  );

// 拖拽 .md 文件到窗口即打开（每个文件一个标签）
getCurrentWebview().onDragDropEvent(async (event) => {
  if (event.payload.type === "drop") {
    for (const p of event.payload.paths) {
      if (/\.(md|markdown|mdown|txt)$/i.test(p)) await loadPath(p);
    }
  }
});

// 关闭前刷新会话并提醒未保存
window.addEventListener("beforeunload", (e) => {
  saveSession();
  if (tabs.some(isDirty)) e.preventDefault();
});

// ---------- 初始化 ----------
async function init() {
  applyTheme();
  const restored = await restoreSession();
  if (!restored) newTab(null, WELCOME);
}
void init();

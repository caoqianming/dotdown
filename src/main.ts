import { invoke } from "@tauri-apps/api/core";
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
  buildOutline();
  forceRepaint();
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

// ---------- 事件绑定 ----------
document.getElementById("btn-new")!.addEventListener("click", () => newTab());
document.getElementById("btn-open")!.addEventListener("click", openFile);
document.getElementById("btn-save")!.addEventListener("click", saveFile);
document.getElementById("btn-saveas")!.addEventListener("click", saveFileAs);
document.getElementById("btn-pdf")!.addEventListener("click", exportPdf);
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
  // 本次启动若由双击/右键“用 Dotdown 打开”带入文件，打开它
  try {
    const f = await invoke<string | null>("initial_file");
    if (f) await loadPath(f);
  } catch {
    /* ignore */
  }
  // 启动时静默检查一次更新：仅在有新版时弹关于窗提示，失败/最新都不打扰
  void checkUpdate(true);
}
void init();

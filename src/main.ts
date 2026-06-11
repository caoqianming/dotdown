import { invoke } from "@tauri-apps/api/core";
import { open, save, message, ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";

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

// ---------- CodeMirror 编辑器（单 View，按标签换 State）----------
const onChange = EditorView.updateListener.of((u) => {
  if (u.docChanged) {
    renderPreview();
    refreshActiveDirty();
    updateTitle();
  }
});

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      markdown({ base: markdownLanguage, codeLanguages: languages }),
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
function newTab(path: string | null = null, content = ""): Tab {
  syncActive();
  const t: Tab = { id: ++tabSeq, path, lastSaved: content, state: makeState(content) };
  tabs.push(t);
  activeId = t.id;
  editor.setState(t.state);
  renderTabs();
  renderPreview();
  updateTitle();
  editor.focus();
  return t;
}

function switchTo(id: number) {
  if (id === activeId) return;
  syncActive();
  activeId = id;
  const next = activeTab();
  if (next) editor.setState(next.state);
  renderTabs();
  renderPreview();
  updateTitle();
  editor.focus();
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
    activeId = neighbor.id;
    editor.setState(neighbor.state);
    renderPreview();
    updateTitle();
    editor.focus();
  }
  renderTabs();
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

// ---------- 事件绑定 ----------
document.getElementById("btn-new")!.addEventListener("click", () => newTab());
document.getElementById("btn-open")!.addEventListener("click", openFile);
document.getElementById("btn-save")!.addEventListener("click", saveFile);
document.getElementById("btn-saveas")!.addEventListener("click", saveFileAs);
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

// 关闭前提醒未保存
window.addEventListener("beforeunload", (e) => {
  if (tabs.some(isDirty)) e.preventDefault();
});

// ---------- 初始化 ----------
newTab(null, WELCOME);

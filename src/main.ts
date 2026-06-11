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
| Ctrl+N | 新建 |
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

// ---------- 应用状态 ----------
let currentPath: string | null = null; // 当前文件磁盘路径
let dirty = false; // 是否有未保存修改
let lastSaved = ""; // 上次保存时的内容（用于判定 dirty）

const previewEl = document.getElementById("preview") as HTMLElement;
const titleEl = document.getElementById("doc-title") as HTMLElement;
const appEl = document.getElementById("app") as HTMLElement;

// ---------- CodeMirror 编辑器 ----------
const onChange = EditorView.updateListener.of((u) => {
  if (u.docChanged) {
    renderPreview();
    setDirty(getDoc() !== lastSaved);
  }
});

const editor = new EditorView({
  parent: document.getElementById("editor") as HTMLElement,
  state: EditorState.create({
    doc: WELCOME,
    extensions: [
      basicSetup,
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      onChange,
      keymap.of([
        { key: "Mod-s", run: () => (saveFile(), true) },
        { key: "Mod-Shift-s", run: () => (saveFileAs(), true) },
        { key: "Mod-o", run: () => (openFile(), true) },
        { key: "Mod-n", run: () => (newFile(), true) },
      ]),
    ],
  }),
});

function getDoc(): string {
  return editor.state.doc.toString();
}

function setDoc(text: string) {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
  });
}

// ---------- 预览渲染 ----------
function renderPreview() {
  previewEl.innerHTML = md.render(getDoc());
}

// ---------- 标题与 dirty 状态 ----------
function setDirty(d: boolean) {
  dirty = d;
  updateTitle();
}

function fileName(): string {
  if (!currentPath) return "未命名";
  return currentPath.split(/[\\/]/).pop() ?? currentPath;
}

function updateTitle() {
  const dot = dirty ? "● " : "";
  titleEl.textContent = dot + fileName();
  void getCurrentWindow()
    .setTitle(`${dot}${fileName()} — mdview`)
    .catch(() => {});
}

// ---------- 文件操作 ----------
async function confirmDiscard(): Promise<boolean> {
  if (!dirty) return true;
  return await ask("当前文件有未保存的修改，确定要放弃吗？", {
    title: "未保存的修改",
    kind: "warning",
  });
}

async function newFile() {
  if (!(await confirmDiscard())) return;
  currentPath = null;
  setDoc("");
  lastSaved = "";
  setDirty(false);
  editor.focus();
}

async function openFile() {
  if (!(await confirmDiscard())) return;
  const selected = await open({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] }],
  });
  if (typeof selected === "string") {
    await loadPath(selected);
  }
}

async function loadPath(path: string) {
  try {
    const content = await invoke<string>("read_file", { path });
    currentPath = path;
    setDoc(content);
    lastSaved = content;
    setDirty(false);
    editor.focus();
  } catch (e) {
    await message(String(e), { title: "打开失败", kind: "error" });
  }
}

async function saveFile() {
  if (!currentPath) return saveFileAs();
  await writeTo(currentPath);
}

async function saveFileAs() {
  const path = await save({
    defaultPath: currentPath ?? "未命名.md",
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (path) await writeTo(path);
}

async function writeTo(path: string) {
  try {
    const content = getDoc();
    await invoke("write_file", { path, content });
    currentPath = path;
    lastSaved = content;
    setDirty(false);
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
const previewPane = document.querySelector(".pane-preview") as HTMLElement;
editor.scrollDOM.addEventListener("scroll", () => {
  const se = editor.scrollDOM;
  const ratio = se.scrollTop / Math.max(1, se.scrollHeight - se.clientHeight);
  previewPane.scrollTop = ratio * (previewPane.scrollHeight - previewPane.clientHeight);
});

// ---------- 事件绑定 ----------
document.getElementById("btn-new")!.addEventListener("click", newFile);
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

// 拖拽 .md 文件到窗口即打开
getCurrentWebview().onDragDropEvent(async (event) => {
  if (event.payload.type === "drop" && event.payload.paths.length > 0) {
    const p = event.payload.paths[0];
    if (/\.(md|markdown|mdown|txt)$/i.test(p) && (await confirmDiscard())) {
      await loadPath(p);
    }
  }
});

// 关闭前提醒未保存
window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});

// ---------- 初始化 ----------
renderPreview();
updateTitle();

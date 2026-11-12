import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface Entry { name: string; path: string; directory: boolean }
interface Change { status: string; path: string; previous_path: string | null }
interface Commit { hash: string; date: string; author: string; subject: string }
interface Repository { root: string; branch: string; changes: Change[]; history: Commit[] }
interface Directory { entries?: Entry[]; error?: string }
type View = "explorer" | "scm";

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const get = (id: string) => document.getElementById(id)!;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function button(className: string, label: string, action: () => void) {
  const node = element("button", className, label);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

export function fileMark(name: string): [string, string] {
  if (/\.(?:tsx?|jsx?|mjs|cjs)$/i.test(name)) return [/\.tsx?$/i.test(name) ? "TS" : "JS", "script"];
  if (/\.rs$/i.test(name)) return ["Rs", "rust"];
  if (/\.py$/i.test(name)) return ["Py", "script"];
  if (/\.(?:md|mdown|markdown)$/i.test(name)) return ["M↓", "script"];
  if (/\.(?:json|ya?ml|toml)$/i.test(name)) return ["{}", "config"];
  if (/\.(?:css|scss)$/i.test(name)) return ["#", "config"];
  if (/\.(?:html?|xml|svg)$/i.test(name)) return ["<>", "rust"];
  return ["≡", "plain"];
}

export function setupRepository(loadPath: (path: string) => Promise<void>, restoreEditorFocus: () => void) {
  const panel = get("repository");
  const refresh = get("repository-refresh") as HTMLButtonElement;
  const list = get("repository-files");
  const filter = get("repository-filter") as HTMLInputElement;
  const info = get("repository-info");
  const changes = get("repository-changes");
  const history = get("repository-history");
  const diffEditor = get("git-editor");
  const diffTab = get("git-tab");
  const diffTabOpen = get("git-tab-open");
  const diffTitle = get("git-title");
  const diffContent = get("git-content");
  const gitBadge = get("git-badge");
  const gitStatus = get("status-git");
  const rail = { explorer: get("btn-repository"), scm: get("btn-source-control") };
  const directories = new Map<string, Directory>();
  const expanded = new Set<string>();
  let root = "";
  let activePath = "";
  let view: View | null = null;
  let treeGeneration = 0;
  let gitSequence = 0;
  let diffSequence = 0;
  let activeChange = "";
  let repoState: Repository | undefined;

  function setView(next: View | null) {
    view = next;
    panel.hidden = !view;
    for (const name of ["explorer", "scm"] as const) {
      rail[name].setAttribute("aria-expanded", String(view === name));
      get(name === "explorer" ? "repository-explorer" : "repository-scm").hidden = !root || view !== name;
    }
    get("repository-empty").hidden = !!root;
    get("repository-view-title").textContent = view === "scm" ? "源代码管理" : "资源管理器";
    refresh.disabled = !root;
  }

  function renderFiles() {
    const focusedPath = (document.activeElement as HTMLElement | null)?.dataset.treePath;
    const rows = document.createDocumentFragment();
    const query = filter.value.trim().toLocaleLowerCase();
    const matching = (entry: Entry): boolean =>
      entry.name.toLocaleLowerCase().includes(query) ||
      (entry.directory && expanded.has(entry.path) && !!directories.get(entry.path)?.entries?.some(matching));

    function add(path: string, depth: number, showAll: boolean) {
      const dir = directories.get(path);
      const entries = dir?.entries;
      if (!entries || !entries.length) {
        const note = element("p", "repository-note", dir?.error ?? (entries ? "空文件夹" : "正在读取…"));
        note.style.paddingInlineStart = `${12 + depth * 14}px`;
        rows.append(note);
        return;
      }
      for (const entry of entries) {
        if (!showAll && !matching(entry)) continue;
        const isOpen = expanded.has(entry.path);
        const [symbol, tone] = entry.directory ? ["", "folder"] : fileMark(entry.name);
        const row = button("repository-row tree-row", "", () => {
          if (!entry.directory) { void loadPath(entry.path); return; }
          if (expanded.delete(entry.path)) renderFiles();
          else {
            expanded.add(entry.path);
            if (directories.has(entry.path) && !directories.get(entry.path)?.error) renderFiles();
            else void readDirectory(entry.path);
          }
        });
        row.dataset.treePath = entry.path;
        row.style.setProperty("--depth", String(depth));
        row.title = entry.path;
        if (entry.directory) row.setAttribute("aria-expanded", String(isOpen));
        else if (activePath === entry.path) row.setAttribute("aria-current", "true");
        const arrow = element("span", "tree-arrow", entry.directory ? (isOpen ? "⌄" : "›") : "");
        const icon = element("span", `file-mark mark-${tone}`, symbol);
        arrow.setAttribute("aria-hidden", "true");
        icon.setAttribute("aria-hidden", "true");
        row.append(arrow, icon, element("span", "row-name", entry.name));
        rows.append(row);
        if (entry.directory && isOpen) {
          add(entry.path, depth + 1, showAll || entry.name.toLocaleLowerCase().includes(query));
        }
      }
    }

    if (root) add(root, 0, !query);
    if (root && !rows.childNodes.length) rows.append(element("p", "repository-note", "已展开的目录中没有匹配项"));
    list.replaceChildren(rows);
    if (focusedPath) Array.from(list.querySelectorAll<HTMLButtonElement>("button")).find((row) =>
      row.dataset.treePath === focusedPath)?.focus({ preventScroll: true });
  }

  async function readDirectory(path: string, render = true) {
    const generation = treeGeneration;
    directories.set(path, {});
    if (render) renderFiles();
    try {
      const entries = await invoke<Entry[]>("repository_entries", { root, path });
      if (generation === treeGeneration) directories.set(path, { entries });
    } catch (error) {
      if (generation === treeGeneration) directories.set(path, { error: String(error) });
    }
    if (render && generation === treeGeneration) renderFiles();
  }

  function showDocument() {
    if (diffEditor.hidden) return false;
    diffEditor.hidden = true;
    diffTab.classList.remove("active");
    get("app").classList.remove("diff-reading");
    return true;
  }

  function focusDiff() {
    if (diffTab.hidden) return;
    diffEditor.hidden = false;
    diffTab.classList.add("active");
    get("app").classList.add("diff-reading");
    diffContent.focus();
  }

  function closeDiff(restoreFocus = true) {
    ++diffSequence;
    const wasShowing = showDocument();
    diffTab.hidden = true;
    diffContent.replaceChildren();
    activeChange = "";
    if (repoState) renderGit(repoState);
    if (wasShowing && restoreFocus) restoreEditorFocus();
  }

  function renderDiff(text: string, untracked: boolean) {
    const fragment = document.createDocumentFragment();
    const lines = text ? text.split(/\r?\n/) : [];
    if (lines[lines.length - 1] === "") lines.pop();
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    let remainingOld = 0;
    let remainingNew = 0;
    for (const [index, line] of lines.slice(0, 12000).entries()) {
      const match = !untracked && /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      let previous = "", next = "", tone = "";
      if (untracked) next = String(index + 1);
      else if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[3]);
        remainingOld = Number(match[2] ?? 1);
        remainingNew = Number(match[4] ?? 1);
        inHunk = true;
        tone = "diff-hunk";
      } else if (inHunk && (remainingOld || remainingNew) && /^[ +\-]/.test(line)) {
        if (line[0] !== "+") { previous = String(oldLine++); --remainingOld; }
        if (line[0] !== "-") { next = String(newLine++); --remainingNew; }
        tone = line[0] === "+" ? "diff-added" : line[0] === "-" ? "diff-removed" : "";
      } else tone = "diff-meta";
      const row = element("div", `diff-line ${tone}`);
      const gutters = untracked ? [next] : [previous, next];
      for (const number of gutters) {
        const gutter = element("span", "diff-number", number);
        gutter.setAttribute("aria-hidden", "true");
        row.append(gutter);
      }
      row.append(element("span", "diff-code", line));
      fragment.append(row);
    }
    if (!lines.length || lines.length > 12000) {
      fragment.append(element("p", "repository-note", lines.length
        ? "仅显示前 12,000 行。" : (untracked ? "空文件" : "没有可显示的文本差异")));
    }
    diffContent.replaceChildren(fragment);
  }

  async function showDiff(repo: Repository, change: Change, staged: boolean) {
    const seq = ++diffSequence;
    const untracked = change.status === "??";
    const scope = untracked ? "未跟踪文件" : staged ? "暂存的更改" : "工作区更改";
    activeChange = `${staged}:${change.path}`;
    if (repoState) renderGit(repoState);
    diffTitle.textContent = `${scope}  ›  ${change.path}`;
    diffTitle.title = diffTitle.textContent;
    diffTabOpen.textContent = `${basename(change.path)} · ${scope}`;
    diffTabOpen.title = diffTitle.textContent;
    diffTab.hidden = false;
    diffContent.textContent = "正在读取…";
    focusDiff();
    try {
      const text = untracked
        ? await invoke<string>("repository_read", { root: repo.root, path: change.path })
        : await invoke<string>("repository_diff", {
            root: repo.root, path: change.path, staged,
            previousPath: staged ? change.previous_path : null,
          });
      if (seq === diffSequence) {
        renderDiff(text, untracked);
        diffContent.scrollTo(0, 0);
      }
    } catch (error) {
      if (seq === diffSequence) diffContent.replaceChildren(element("p", "repository-note", String(error)));
    }
  }

  function renderGit(repo: Repository) {
    const groups = ([true, false] as const).map((staged) => {
      const group = element("details", "scm-group");
      const title = element("summary", "repository-section", staged ? "暂存的更改" : "工作区更改");
      const files = repo.changes.filter((change) => staged
        ? change.status !== "??" && change.status[0] !== " "
        : change.status === "??" || change.status[1] !== " ");
      title.append(element("span", "section-count", String(files.length)));
      group.open = changes.querySelectorAll("details")[staged ? 0 : 1]?.open ?? true;
      group.append(title);
      if (!files.length) group.append(element("p", "repository-note", "没有更改"));
      for (const change of files) {
        const status = change.status === "??" ? "U" : change.status[staged ? 0 : 1];
        const row = button("repository-row scm-row", "", () => void showDiff(repo, change, staged));
        row.title = change.previous_path ? `${change.previous_path} → ${change.path}` : change.path;
        if (activeChange === `${staged}:${change.path}`) row.setAttribute("aria-current", "true");
        const name = basename(change.path);
        const [symbol, tone] = fileMark(name);
        const icon = element("span", `file-mark mark-${tone}`, symbol);
        icon.setAttribute("aria-hidden", "true");
        row.append(icon, element("span", "row-name", name));
        const parent = change.path.slice(0, -(name.length + 1));
        if (parent) row.append(element("span", "scm-path", parent));
        row.append(element("span", `scm-status scm-status-${status}`, status));
        group.append(row);
      }
      return group;
    });
    changes.replaceChildren(...groups);
  }

  async function refreshGit() {
    const seq = ++gitSequence;
    info.textContent = "正在读取 Git…";
    try {
      const repo = await invoke<Repository>("repository_git", { root });
      if (seq !== gitSequence) return;
      repoState = repo;
      info.textContent = `${repo.branch} · ${repo.changes.length} 个变更`;
      info.title = repo.root;
      gitBadge.hidden = !repo.changes.length;
      gitBadge.textContent = repo.changes.length > 99 ? "99+" : String(repo.changes.length);
      gitStatus.textContent = `⑂ ${repo.branch}`;
      gitStatus.hidden = false;
      renderGit(repo);
      history.replaceChildren(...repo.history.map((commit) => {
        const row = element("li", "scm-commit");
        row.title = `${commit.hash} · ${commit.author} · ${commit.date}\n${commit.subject}`;
        row.append(element("span", "commit-subject", commit.subject), element("span", "commit-meta",
          `${commit.hash}  ·  ${commit.date}  ·  ${commit.author}`));
        return row;
      }));
      if (!repo.history.length) history.append(element("li", "repository-note", "尚无提交"));
    } catch (error) {
      if (seq !== gitSequence) return;
      repoState = undefined;
      changes.replaceChildren();
      history.replaceChildren();
      info.textContent = String(error).includes("not a git repository") ? "当前文件夹不是 Git 仓库" : `无法读取 Git：${String(error)}`;
      info.title = "";
      gitBadge.hidden = gitStatus.hidden = true;
    }
  }

  async function openFolder() {
    try {
      const selected = await open({ directory: true, multiple: false, title: "打开代码库或文件夹" });
      if (typeof selected !== "string") return;
      repoState = undefined;
      closeDiff(false);
      root = selected;
      ++treeGeneration;
      directories.clear();
      expanded.clear();
      changes.replaceChildren();
      history.replaceChildren();
      gitBadge.hidden = gitStatus.hidden = true;
      filter.value = "";
      const title = get("repository-title");
      title.textContent = basename(root);
      title.title = root;
      setView(view ?? "explorer");
      await Promise.all([readDirectory(root), refreshGit()]);
    } catch (error) {
      console.error("无法打开文件夹", error);
    }
  }

  for (const id of ["btn-folder", "repository-open", "repository-open-empty"]) {
    get(id).addEventListener("click", () => void openFolder());
  }
  for (const name of ["explorer", "scm"] as const) {
    rail[name].addEventListener("click", () => setView(view === name ? null : name));
  }
  gitStatus.addEventListener("click", () => setView("scm"));
  refresh.addEventListener("click", async () => {
    if (!root) return;
    const generation = ++treeGeneration;
    const visited = new Set<string>();
    await Promise.all([
      (async () => {
        async function refreshDirectory(path: string) {
          if (generation !== treeGeneration) return;
          visited.add(path);
          await readDirectory(path, false);
          for (const entry of directories.get(path)?.entries ?? []) {
            if (entry.directory && expanded.has(entry.path)) await refreshDirectory(entry.path);
          }
        }
        await refreshDirectory(root);
        if (generation === treeGeneration) {
          for (const path of directories.keys()) {
            if (!visited.has(path)) { directories.delete(path); expanded.delete(path); }
          }
          renderFiles();
        }
      })(),
      refreshGit(),
    ]);
  });
  get("git-close").addEventListener("click", () => closeDiff());
  diffTabOpen.addEventListener("click", focusDiff);
  diffEditor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDiff();
  });
  filter.addEventListener("input", renderFiles);
  return {
    showDocument,
    selectFile(path: string | null) {
      activePath = path ?? "";
      if (root) renderFiles();
    },
  };
}

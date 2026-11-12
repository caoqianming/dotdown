import { invoke } from "@tauri-apps/api/core";
import { message, open } from "@tauri-apps/plugin-dialog";

interface Entry { name: string; path: string; directory: boolean }
interface Change { status: string; path: string; previous_path: string | null }
interface Commit { hash: string; date: string; author: string; subject: string }
interface Repository { root: string; branch: string; changes: Change[]; head: string | null }
interface HistoryPage { commits: Commit[]; has_more: boolean }
interface Directory { entries?: Entry[]; error?: string }
interface Project {
  root: string;
  open: boolean;
  directories: Map<string, Directory>;
  expanded: Set<string>;
  generation: number;
}
type View = "explorer" | "scm";

const PROJECTS_KEY = "dotdown.projects";
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const get = (id: string) => document.getElementById(id)!;

function pathKey(path: string) {
  return /^(?:[a-z]:|[\\/]{2})/i.test(path)
    ? path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    : path.replace(/\/+$/, "") || "/";
}

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
  const scm = get("repository-scm");
  const projectPicker = get("repository-project") as HTMLSelectElement;
  const history = get("repository-history");
  const historyGroup = get("repository-history-group") as HTMLDetailsElement;
  const historyStatus = get("repository-history-status");
  const historyMore = get("repository-history-more") as HTMLButtonElement;
  const diffEditor = get("git-editor");
  const diffTab = get("git-tab");
  const diffTabOpen = get("git-tab-open");
  const diffTitle = get("git-title");
  const commitActions = get("git-commit-actions");
  const diffContent = get("git-content");
  const gitBadge = get("git-badge");
  const gitStatus = get("status-git");
  const rail = { explorer: get("btn-repository"), scm: get("btn-source-control") };
  const projects = new Map<string, Project>();
  let activeProject: Project | undefined;
  let choosingFolders = false;
  let activePath = "";
  let view: View | null = null;
  let gitSequence = 0;
  let diffSequence = 0;
  let activeChange = "";
  let activeCommit = "";
  let repoState: Repository | undefined;
  let historyOffset = 0;
  let historyLoading = false;
  let historyHasMore = false;
  let historyFailed = false;
  const historyObserver = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !historyFailed) void loadHistory();
  }, { root: scm, rootMargin: "0px 0px 100px 0px" });

  function setView(next: View | null) {
    view = next;
    panel.hidden = !view;
    for (const name of ["explorer", "scm"] as const) {
      rail[name].setAttribute("aria-expanded", String(view === name));
      get(name === "explorer" ? "repository-explorer" : "repository-scm").hidden = !activeProject || view !== name;
    }
    get("repository-empty").hidden = !!activeProject;
    get("repository-view-title").textContent = view === "scm" ? "源代码管理" : "资源管理器";
    refresh.disabled = !activeProject;
    if (view === "scm") startHistory();
  }

  function renderFiles() {
    const focused = (document.activeElement as HTMLElement | null)?.dataset;
    const rows = document.createDocumentFragment();
    const query = filter.value.trim().toLocaleLowerCase();
    const matching = (project: Project, entry: Entry): boolean =>
      entry.name.toLocaleLowerCase().includes(query) || (entry.directory && project.expanded.has(entry.path) &&
        !!project.directories.get(entry.path)?.entries?.some((child) => matching(project, child)));

    function add(project: Project, path: string, depth: number, showAll: boolean) {
      const { directories, expanded } = project;
      const dir = directories.get(path);
      const entries = dir?.entries;
      if (!entries || !entries.length) {
        const note = element("p", "repository-note", dir?.error ?? (entries ? "空文件夹" : "正在读取…"));
        note.style.paddingInlineStart = `${12 + depth * 14}px`;
        rows.append(note);
        return;
      }
      const visibleEntries = showAll ? entries : entries.filter((entry) => matching(project, entry));
      if (!visibleEntries.length && depth === 1) {
        rows.append(element("p", "repository-note", "此项目的已展开目录中没有匹配项"));
      }
      for (const entry of visibleEntries) {
        const isOpen = expanded.has(entry.path);
        const [symbol, tone] = entry.directory ? ["", "folder"] : fileMark(entry.name);
        const row = button("repository-row tree-row", "", () => {
          if (!entry.directory) {
            selectProject(project);
            void loadPath(entry.path);
            return;
          }
          if (expanded.delete(entry.path)) renderFiles();
          else {
            expanded.add(entry.path);
            if (directories.has(entry.path) && !directories.get(entry.path)?.error) renderFiles();
            else void readDirectory(project, entry.path);
          }
        });
        row.dataset.treePath = entry.path;
        row.dataset.projectRoot = project.root;
        row.style.setProperty("--depth", String(depth));
        row.title = entry.path;
        if (entry.directory) row.setAttribute("aria-expanded", String(isOpen));
        else if (activePath && pathKey(activePath) === pathKey(entry.path)) row.setAttribute("aria-current", "true");
        const arrow = element("span", "tree-arrow", entry.directory ? (isOpen ? "⌄" : "›") : "");
        const icon = element("span", `file-mark mark-${tone}`, symbol);
        arrow.setAttribute("aria-hidden", "true");
        icon.setAttribute("aria-hidden", "true");
        row.append(arrow, icon, element("span", "row-name", entry.name));
        rows.append(row);
        if (entry.directory && isOpen) {
          add(project, entry.path, depth + 1, showAll || entry.name.toLocaleLowerCase().includes(query));
        }
      }
    }

    for (const project of projects.values()) {
      const name = basename(project.root);
      const header = element("div", "repository-project-heading");
      const toggle = button("repository-row project-toggle", "", () => {
        project.open = !project.open;
        selectProject(project);
        renderFiles();
        if (project.open && (!project.directories.has(project.root) || project.directories.get(project.root)?.error)) {
          void readDirectory(project, project.root);
        }
      });
      toggle.title = project.root;
      toggle.dataset.treePath = project.root;
      toggle.dataset.projectRoot = project.root;
      toggle.setAttribute("aria-expanded", String(project.open));
      if (activeProject === project) toggle.setAttribute("aria-current", "true");
      const arrow = element("span", "tree-arrow", project.open ? "⌄" : "›");
      arrow.setAttribute("aria-hidden", "true");
      toggle.append(arrow, element("span", "row-name", name));
      const remove = button("project-remove", "×", () => removeProject(project));
      remove.title = "从工作区移除";
      remove.setAttribute("aria-label", `从工作区移除 ${name}`);
      header.append(toggle, remove);
      rows.append(header);
      if (project.open) add(project, project.root, 1, !query || name.toLocaleLowerCase().includes(query));
    }
    list.replaceChildren(rows);
    if (focused?.treePath) Array.from(list.querySelectorAll<HTMLButtonElement>("[data-tree-path]")).find((row) =>
      row.dataset.treePath === focused.treePath && row.dataset.projectRoot === focused.projectRoot)?.focus({ preventScroll: true });
  }

  async function readDirectory(project: Project, path: string, render = true) {
    const { directories, generation, root } = project;
    directories.set(path, {});
    if (render) renderFiles();
    try {
      const entries = await invoke<Entry[]>("repository_entries", { root, path });
      if (generation === project.generation) directories.set(path, { entries });
    } catch (error) {
      if (generation === project.generation) directories.set(path, { error: String(error) });
    }
    if (render && generation === project.generation) renderFiles();
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
    commitActions.replaceChildren();
    commitActions.hidden = true;
    activeChange = "";
    selectCommit("");
    if (repoState) renderGit(repoState);
    if (wasShowing && restoreFocus) restoreEditorFocus();
  }

  function setGitHeading(title: string, tabLabel: string) {
    diffTitle.textContent = title;
    diffTitle.title = title;
    diffTabOpen.textContent = tabLabel;
    diffTabOpen.title = title;
  }

  function openGitEditor(title: string, tabLabel: string) {
    setGitHeading(title, tabLabel);
    diffTab.hidden = false;
    diffContent.textContent = "正在读取…";
    diffContent.scrollTo(0, 0);
    focusDiff();
  }

  function selectCommit(hash: string) {
    activeCommit = hash;
    for (const row of history.querySelectorAll<HTMLButtonElement>("[aria-current], [data-hash]")) {
      if (row.dataset.hash === hash) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
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
    selectCommit("");
    commitActions.replaceChildren();
    commitActions.hidden = true;
    if (repoState) renderGit(repoState);
    openGitEditor(`${scope}  ›  ${change.path}`, `${basename(change.path)} · ${scope}`);
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

  function showCommitList(repo: Repository, commit: Commit, files: Change[]) {
    ++diffSequence;
    const shortHash = commit.hash.slice(0, 8);
    commitActions.replaceChildren();
    commitActions.hidden = true;
    setGitHeading(`提交 ${shortHash}  ›  ${commit.subject || "无提交说明"}`, `提交 ${shortHash}`);
    const content = element("div", "commit-details");
    content.append(
      element("p", "commit-detail-meta", `${commit.author} · ${commit.date} · ${files.length} 个变更文件`),
    );
    if (!files.length) content.append(element("p", "repository-note", "此提交没有文件变更"));
    for (const file of files) {
      content.append(changeRow(file, file.status[0], () => void showCommitFile(repo, commit, files, file, "diff")));
    }
    diffContent.replaceChildren(content);
    diffContent.scrollTo(0, 0);
  }

  async function openCommit(repo: Repository, commit: Commit) {
    const seq = ++diffSequence;
    const shortHash = commit.hash.slice(0, 8);
    selectCommit(commit.hash);
    activeChange = "";
    if (repoState) renderGit(repoState);
    commitActions.replaceChildren();
    commitActions.hidden = true;
    openGitEditor(`提交 ${shortHash}  ›  ${commit.subject || "无提交说明"}`, `提交 ${shortHash}`);
    try {
      const files = await invoke<Change[]>("repository_commit_files", { root: repo.root, hash: commit.hash });
      if (seq === diffSequence) showCommitList(repo, commit, files);
    } catch (error) {
      if (seq === diffSequence) diffContent.replaceChildren(element("p", "repository-note", String(error)));
    }
  }

  async function showCommitFile(repo: Repository, commit: Commit, files: Change[], file: Change, mode: "diff" | "content" | "before") {
    const seq = ++diffSequence;
    const snapshotMode = file.status === "D" ? "before" : "content";
    const back = button("commit-action", "‹ 提交文件", () => {
      showCommitList(repo, commit, files);
      diffContent.focus();
    });
    const diff = button("commit-action", "差异", () => void showCommitFile(repo, commit, files, file, "diff"));
    const snapshot = button("commit-action", snapshotMode === "before" ? "删除前的内容" : "提交时的内容",
      () => void showCommitFile(repo, commit, files, file, snapshotMode));
    diff.setAttribute("aria-pressed", String(mode === "diff"));
    snapshot.setAttribute("aria-pressed", String(mode !== "diff"));
    commitActions.replaceChildren(back, diff, snapshot);
    commitActions.hidden = false;
    const shortHash = commit.hash.slice(0, 8);
    openGitEditor(`提交 ${shortHash}  ›  ${file.path}`, `${basename(file.path)} · ${shortHash}`);
    try {
      const text = await invoke<string>("repository_commit_file", {
        root: repo.root, hash: commit.hash, path: file.path, previousPath: file.previous_path, mode,
      });
      if (seq === diffSequence) renderDiff(text, mode !== "diff");
    } catch (error) {
      if (seq === diffSequence) diffContent.replaceChildren(element("p", "repository-note", String(error)));
    }
  }

  function changeRow(change: Change, status: string, action: () => void) {
    const row = button("repository-row scm-row", "", action);
    row.title = change.previous_path ? `${change.previous_path} → ${change.path}` : change.path;
    const name = basename(change.path);
    const [symbol, tone] = fileMark(name);
    const icon = element("span", `file-mark mark-${tone}`, symbol);
    icon.setAttribute("aria-hidden", "true");
    row.append(icon, element("span", "row-name", name));
    const parent = change.path.slice(0, -(name.length + 1));
    if (parent) row.append(element("span", "scm-path", parent));
    row.append(element("span", `scm-status scm-status-${status}`, status));
    return row;
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
        const row = changeRow(change, status, () => void showDiff(repo, change, staged));
        if (activeChange === `${staged}:${change.path}`) row.setAttribute("aria-current", "true");
        group.append(row);
      }
      return group;
    });
    changes.replaceChildren(...groups);
  }

  function setHistoryStatus(message: string) {
    historyStatus.textContent = message;
    historyStatus.hidden = !message;
  }

  function resetHistory() {
    historyObserver.unobserve(historyMore);
    history.replaceChildren();
    historyOffset = 0;
    historyHasMore = historyLoading = historyFailed = false;
    historyMore.hidden = true;
    historyMore.disabled = false;
    historyMore.textContent = "加载更早的提交";
    setHistoryStatus("");
  }

  function startHistory() {
    if (historyGroup.open && historyHasMore && historyOffset === 0 && !historyFailed) void loadHistory();
  }

  async function loadHistory() {
    const repo = repoState;
    if (!repo?.head || !historyHasMore || historyLoading || view !== "scm" || !historyGroup.open) return;
    const seq = gitSequence;
    historyObserver.unobserve(historyMore);
    historyLoading = true;
    historyFailed = false;
    historyMore.disabled = true;
    historyMore.textContent = "加载更早的提交";
    setHistoryStatus("正在读取提交…");
    try {
      const page = await invoke<HistoryPage>("repository_history", { root: repo.root, head: repo.head, offset: historyOffset });
      if (seq !== gitSequence) return;
      const rows = document.createDocumentFragment();
      for (const commit of page.commits) {
        const item = element("li", "");
        const shortHash = commit.hash.slice(0, 8);
        const row = button("scm-commit", "", () => void openCommit(repo, commit));
        row.dataset.hash = commit.hash;
        row.title = `${commit.hash} · ${commit.author} · ${commit.date}\n${commit.subject}`;
        if (activeCommit === commit.hash) row.setAttribute("aria-current", "true");
        row.append(element("span", "commit-subject", commit.subject || "无提交说明"),
          element("span", "commit-meta", `${shortHash} · ${commit.date} · ${commit.author}`));
        item.append(row);
        rows.append(item);
      }
      history.append(rows);
      historyOffset += page.commits.length;
      historyHasMore = page.has_more;
      setHistoryStatus(historyHasMore ? "" : historyOffset ? "已显示全部提交" : "尚无提交");
    } catch (error) {
      if (seq !== gitSequence) return;
      historyFailed = true;
      historyMore.textContent = "重试加载提交";
      setHistoryStatus(`无法读取提交历史：${String(error)}`);
    } finally {
      if (seq === gitSequence) {
        historyLoading = false;
        historyMore.hidden = !historyHasMore;
        historyMore.disabled = false;
        if (historyHasMore && !historyFailed) historyObserver.observe(historyMore);
      }
    }
  }

  async function refreshGit() {
    const project = activeProject;
    if (!project) return;
    const seq = ++gitSequence;
    repoState = undefined;
    resetHistory();
    info.textContent = "正在读取 Git…";
    try {
      const repo = await invoke<Repository>("repository_git", { root: project.root });
      if (seq !== gitSequence) return;
      repoState = repo;
      info.textContent = `${repo.branch} · ${repo.changes.length} 个变更`;
      info.title = repo.root;
      gitBadge.hidden = !repo.changes.length;
      gitBadge.textContent = repo.changes.length > 99 ? "99+" : String(repo.changes.length);
      gitStatus.textContent = `⑂ ${repo.branch}`;
      gitStatus.title = `${basename(project.root)} · ${repo.branch}（打开源代码管理）`;
      gitStatus.hidden = false;
      renderGit(repo);
      historyHasMore = !!repo.head;
      if (historyHasMore) startHistory();
      else setHistoryStatus("尚无提交");
    } catch (error) {
      if (seq !== gitSequence) return;
      repoState = undefined;
      changes.replaceChildren();
      info.textContent = String(error).includes("not a git repository") ? "当前文件夹不是 Git 仓库" : `无法读取 Git：${String(error)}`;
      info.title = "";
      gitBadge.hidden = gitStatus.hidden = true;
    }
  }

  function addProject(root: string) {
    const key = pathKey(root);
    const existing = projects.get(key);
    if (existing) return existing;
    const project: Project = { root, open: false, directories: new Map(), expanded: new Set(), generation: 0 };
    projects.set(key, project);
    return project;
  }

  function saveProjects() {
    try {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify({
        roots: Array.from(projects.values(), (project) => project.root),
        active: activeProject?.root,
      }));
    } catch { /* 存储不可用时，项目仍可在当前会话中使用。 */ }
  }

  function renderProjectPicker() {
    const nameCounts = new Map<string, number>();
    for (const project of projects.values()) {
      const name = basename(project.root);
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    projectPicker.replaceChildren(...Array.from(projects.values(), (project) => {
      const name = basename(project.root);
      const option = element("option", "", nameCounts.get(name) === 1 ? name : project.root);
      option.value = pathKey(project.root);
      option.title = project.root;
      return option;
    }));
    projectPicker.value = activeProject ? pathKey(activeProject.root) : "";
    projectPicker.title = activeProject?.root ?? "";
  }

  function selectProject(project: Project | undefined) {
    if (activeProject === project) return;
    activeProject = project;
    repoState = undefined;
    closeDiff(false);
    changes.replaceChildren();
    info.textContent = "";
    info.title = "";
    gitBadge.hidden = gitStatus.hidden = true;
    scm.scrollTop = 0;
    renderProjectPicker();
    renderFiles();
    setView(view);
    saveProjects();
    if (project) void refreshGit();
    else {
      ++gitSequence;
      resetHistory();
    }
  }

  function removeProject(project: Project) {
    ++project.generation;
    projects.delete(pathKey(project.root));
    if (activeProject === project) selectProject(projects.values().next().value);
    else {
      renderProjectPicker();
      renderFiles();
      saveProjects();
    }
    const next = list.querySelector<HTMLButtonElement>('.project-toggle[aria-current="true"]');
    (next ?? get("repository-open")).focus({ preventScroll: true });
  }

  function expandProject(project: Project) {
    project.open = true;
    if (!project.directories.has(project.root) || project.directories.get(project.root)?.error) {
      void readDirectory(project, project.root);
    }
  }

  async function openFolder() {
    if (choosingFolders) return;
    choosingFolders = true;
    try {
      const selected = await open({ directory: true, multiple: true, title: "添加文件夹到工作区" });
      const roots = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (!roots.length) return;
      const added = roots.map(addProject);
      selectProject(added[0]);
      setView(view ?? "explorer");
      for (const project of added) expandProject(project);
      renderProjectPicker();
      renderFiles();
      saveProjects();
    } catch (error) {
      await message(String(error), { title: "无法添加文件夹", kind: "error" });
    } finally {
      choosingFolders = false;
    }
  }

  function restoreProjects() {
    try {
      const saved = JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? "null");
      if (!Array.isArray(saved?.roots)) return;
      for (const root of saved.roots) {
        if (typeof root === "string" && root) addProject(root);
      }
      const project = (typeof saved.active === "string" ? projects.get(pathKey(saved.active)) : undefined)
        ?? projects.values().next().value;
      if (project) {
        selectProject(project);
        setView("explorer");
        expandProject(project);
      }
    } catch { /* 无法恢复时显示空工作区。 */ }
  }

  for (const id of ["btn-folder", "repository-open", "repository-open-empty"]) {
    get(id).addEventListener("click", () => void openFolder());
  }
  for (const name of ["explorer", "scm"] as const) {
    rail[name].addEventListener("click", () => setView(view === name ? null : name));
  }
  gitStatus.addEventListener("click", () => setView("scm"));
  projectPicker.addEventListener("change", () => selectProject(projects.get(projectPicker.value)));
  historyGroup.addEventListener("toggle", startHistory);
  historyMore.addEventListener("click", () => void loadHistory());
  async function refreshProjectTree(project: Project) {
    const { root, directories, expanded } = project;
    const generation = ++project.generation;
    const visited = new Set<string>();
    async function refreshDirectory(path: string) {
      if (generation !== project.generation) return;
      visited.add(path);
      await readDirectory(project, path, false);
      for (const entry of directories.get(path)?.entries ?? []) {
        if (entry.directory && expanded.has(entry.path)) await refreshDirectory(entry.path);
      }
    }
    await refreshDirectory(root);
    if (generation !== project.generation) return;
    for (const path of directories.keys()) {
      if (!visited.has(path)) {
        directories.delete(path);
        expanded.delete(path);
      }
    }
    renderFiles();
  }

  refresh.addEventListener("click", () => {
    if (activeProject) void Promise.all([refreshProjectTree(activeProject), refreshGit()]);
  });
  get("git-close").addEventListener("click", () => closeDiff());
  diffTabOpen.addEventListener("click", focusDiff);
  diffEditor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDiff();
  });
  filter.addEventListener("input", renderFiles);
  restoreProjects();
  return {
    showDocument,
    selectFile(path: string | null) {
      activePath = path ?? "";
      if (projects.size) renderFiles();
    },
  };
}

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface Entry { name: string; path: string; directory: boolean }
interface Change { status: string; path: string }
interface Repository { root: string; branch: string; changes: Change[]; history: string }

export function setupRepository(loadPath: (path: string) => Promise<void>) {
  const panel = document.getElementById("repository")!;
  const title = document.getElementById("repository-title")!;
  const list = document.getElementById("repository-files")!;
  const filter = document.getElementById("repository-filter") as HTMLInputElement;
  const info = document.getElementById("repository-info")!;
  const changes = document.getElementById("repository-changes")!;
  const history = document.getElementById("repository-history")!;
  const dialog = document.getElementById("git-dialog") as HTMLDialogElement;
  const diffTitle = document.getElementById("git-title")!;
  const diffContent = document.getElementById("git-content")!;
  let root = "";
  let current = "";
  let parents: string[] = [];
  let entries: Entry[] = [];
  let directorySequence = 0;
  let gitSequence = 0;
  let diffSequence = 0;

  function button(text: string, action: () => void) {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = text;
    el.addEventListener("click", action);
    return el;
  }

  function renderFiles() {
    list.replaceChildren();
    if (parents.length) list.append(button("↰ 上级目录", () => {
      const next = parents.slice();
      const parent = next.pop()!;
      void browse(parent, next);
    }));
    const query = filter.value.toLocaleLowerCase();
    const shown = entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query));
    for (const entry of shown) {
      const el = button(`${entry.directory ? "▸" : "·"} ${entry.name}`, () => {
        if (entry.directory) void browse(entry.path, [...parents, current]);
        else void loadPath(entry.path);
      });
      el.title = entry.path;
      list.append(el);
    }
    if (!shown.length) {
      const empty = document.createElement("p");
      empty.textContent = entries.length ? "没有匹配的文件" : "空目录";
      list.append(empty);
    }
  }

  async function browse(path: string, nextParents: string[]) {
    const seq = ++directorySequence;
    list.textContent = "正在读取目录…";
    try {
      const result = await invoke<Entry[]>("repository_entries", { root, path });
      if (seq !== directorySequence) return;
      entries = result;
      current = path;
      parents = nextParents;
      filter.value = "";
      title.textContent = path;
      title.title = path;
      renderFiles();
    } catch (error) {
      if (seq !== directorySequence) return;
      list.textContent = String(error);
      list.append(button("返回文件夹根目录", () => void browse(root, [])));
    }
  }

  async function showDiff(repo: Repository, change: Change, staged: boolean) {
    const seq = ++diffSequence;
    diffTitle.textContent = `${staged ? "暂存区" : "工作区"} · ${change.path}`;
    diffContent.textContent = "正在读取差异…";
    if (!dialog.open) dialog.showModal();
    try {
      let text: string;
      if (change.status === "??") {
        text = await invoke<string>("read_file", { path: `${repo.root}/${change.path}` });
      } else {
        text = await invoke<string>("repository_diff", { root: repo.root, path: change.path, staged });
      }
      if (seq !== diffSequence) return;
      diffContent.replaceChildren();
      // 使用 textContent，文件内容和文件名不进入 HTML。
      const fragment = document.createDocumentFragment();
      for (const line of (text || "此侧没有文本差异（可能是重命名或二进制文件）").split("\n")) {
        const span = document.createElement("span");
        if (change.status !== "??") {
          span.className = line.startsWith("+") ? "diff-added" : line.startsWith("-") ? "diff-removed" : line.startsWith("@@") ? "diff-hunk" : "";
        }
        span.textContent = line + "\n";
        fragment.append(span);
      }
      diffContent.append(fragment);
    } catch (error) {
      if (seq === diffSequence) diffContent.textContent = String(error);
    }
  }

  async function refreshGit() {
    if (!root) return;
    const seq = ++gitSequence;
    info.textContent = "正在读取 Git…";
    changes.replaceChildren();
    history.textContent = "";
    try {
      const repo = await invoke<Repository>("repository_git", { root });
      if (seq !== gitSequence) return;
      info.textContent = `${repo.branch} · ${repo.changes.length} 个变更`;
      info.title = repo.root;
      if (!repo.changes.length) changes.textContent = "工作区干净";
      for (const change of repo.changes) {
        const row = document.createElement("div");
        row.className = "repository-change";
        const label = document.createElement("span");
        label.textContent = `${change.status} ${change.path}`;
        label.title = change.path;
        row.append(label);
        if (change.status === "??") row.append(button("内容", () => void showDiff(repo, change, false)));
        else {
          if (change.status[0] !== " ") row.append(button("暂存差异", () => void showDiff(repo, change, true)));
          if (change.status[1] !== " ") row.append(button("工作区差异", () => void showDiff(repo, change, false)));
        }
        changes.append(row);
      }
      history.textContent = repo.history;
    } catch (error) {
      if (seq !== gitSequence) return;
      info.textContent = `无法读取 Git：${String(error)}`;
    }
  }

  async function openFolder() {
    const selected = await open({ directory: true, multiple: false, title: "打开代码库或文件夹" });
    if (typeof selected !== "string") return;
    root = selected;
    panel.hidden = false;
    document.getElementById("btn-repository")!.setAttribute("aria-expanded", "true");
    await Promise.all([browse(root, []), refreshGit()]);
  }

  document.getElementById("btn-folder")!.addEventListener("click", () => void openFolder());
  document.getElementById("btn-repository")!.addEventListener("click", () => {
    if (!root) { void openFolder(); return; }
    panel.hidden = !panel.hidden;
    document.getElementById("btn-repository")!.setAttribute("aria-expanded", String(!panel.hidden));
  });
  document.getElementById("repository-refresh")!.addEventListener("click", () => {
    if (root) void Promise.all([browse(current || root, parents), refreshGit()]);
  });
  document.getElementById("git-close")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { ++diffSequence; });
  filter.addEventListener("input", renderFiles);
}

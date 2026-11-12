use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_TEXT: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    directory: bool,
}

fn within(root: &str, path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !path.starts_with(root) {
        return Err("路径不在打开的文件夹内".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn repository_entries(root: String, path: String) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = within(&root, &path)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            // 不遍历链接和 Git 内部数据库；避免循环或跳出工作区。
            if kind.is_symlink() || entry.file_name() == ".git" {
                continue;
            }
            if !kind.is_dir() && !kind.is_file() {
                continue;
            }
            if entries.len() >= 10000 {
                return Err("目录超过 10000 项，请打开更小的子目录".into());
            }
            entries.push(Entry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: Path::new(&path)
                    .join(entry.file_name())
                    .to_string_lossy()
                    .into_owned(),
                directory: kind.is_dir(),
            });
        }
        entries.sort_by(|a, b| {
            b.directory
                .cmp(&a.directory)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn read_text(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| format!("读取失败: {e}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_TEXT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_TEXT {
        return Err("文件超过 2 MiB，暂不支持阅读".into());
    }
    decode_text(bytes)
}

fn decode_text(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.contains(&0) {
        return Err("这是二进制文件，无法作为文本阅读".into());
    }
    String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 文本，暂不支持阅读".into())
}

// 固定 Git 子命令，不经 shell；禁用外部 diff / textconv 和可选索引写入。
fn git(root: &str, args: &[&str]) -> Result<String, String> {
    git_bytes(root, args).map(|output| String::from_utf8_lossy(&output).into_owned())
}

fn git_bytes(root: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command
        .args([
            "--no-optional-locks",
            "-c",
            "core.quotepath=false",
            "-c",
            "color.ui=false",
            "-c",
            "core.fsmonitor=false",
            "-C",
            root,
        ])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法运行 Git，请先安装 Git 并加入 PATH：{e}"))?;
    fn collect(mut pipe: impl Read) -> Vec<u8> {
        let mut output = Vec::new();
        let mut buffer = [0; 8192];
        while let Ok(n) = pipe.read(&mut buffer) {
            if n == 0 {
                break;
            }
            let keep = n.min((MAX_TEXT as usize + 1).saturating_sub(output.len()));
            output.extend_from_slice(&buffer[..keep]);
        }
        output
    }
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || collect(stdout));
    let err = std::thread::spawn(move || collect(stderr));
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if start.elapsed() > Duration::from_secs(10) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Git 查询超时，请缩小仓库或稍后重试".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let output = out.join().map_err(|_| "读取 Git 输出失败")?;
    let error = err.join().map_err(|_| "读取 Git 错误失败")?;
    if !status.success() {
        return Err(String::from_utf8_lossy(&error).trim().to_owned());
    }
    if output.len() as u64 > MAX_TEXT {
        return Err("Git 输出超过 2 MiB，请使用其他工具查看".into());
    }
    Ok(output)
}

#[derive(Serialize)]
pub struct Change {
    status: String,
    path: String,
    previous_path: Option<String>,
}
#[derive(Serialize)]
pub struct Commit {
    hash: String,
    date: String,
    author: String,
    subject: String,
}
#[derive(Serialize)]
pub struct Repository {
    root: String,
    branch: String,
    changes: Vec<Change>,
    head: Option<String>,
}

#[derive(Serialize)]
pub struct HistoryPage {
    commits: Vec<Commit>,
    has_more: bool,
}

fn parse_changes(output: &str) -> Vec<Change> {
    let mut parts = output.split('\0');
    let mut changes = Vec::new();
    while let Some(item) = parts.next() {
        if item.len() < 4 || !item.is_char_boundary(3) {
            continue;
        }
        let status = &item[..2];
        let previous_path = if status.contains('R') || status.contains('C') {
            parts.next().map(str::to_owned)
        } else {
            None
        };
        changes.push(Change {
            status: status.to_owned(),
            path: item[3..].to_owned(),
            previous_path,
        });
    }
    changes
}

#[tauri::command]
pub async fn repository_git(root: String) -> Result<Repository, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let actual = git(&root, &["rev-parse", "--show-toplevel"])?
            .trim()
            .to_owned();
        let status = git(
            &actual,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )?;
        let branch = git(&actual, &["rev-parse", "--abbrev-ref", "HEAD"])
            .or_else(|_| git(&actual, &["symbolic-ref", "--short", "HEAD"]))?;
        let head = git(&actual, &["rev-parse", "--verify", "HEAD"])
            .ok()
            .map(|hash| hash.trim().into());
        Ok(Repository {
            root: actual,
            branch: branch.trim().into(),
            changes: parse_changes(&status),
            head,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn parse_history(log: &str) -> Vec<Commit> {
    log.split_terminator('\0')
        .collect::<Vec<_>>()
        .chunks_exact(4)
        .map(|fields| Commit {
            hash: fields[0].into(),
            date: fields[1].into(),
            author: fields[2].into(),
            subject: fields[3].into(),
        })
        .collect()
}

fn validate_hash(hash: &str) -> Result<(), String> {
    if !matches!(hash.len(), 40 | 64) || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("无效的 Git 提交标识".into());
    }
    Ok(())
}

fn history_page(
    root: &str,
    head: &str,
    offset: u32,
    page_size: usize,
) -> Result<HistoryPage, String> {
    validate_hash(head)?;
    // 固定首次读取的 HEAD，分页期间新增提交不会移动页边界。
    let skip = format!("--skip={offset}");
    let limit = format!("--max-count={}", page_size + 1);
    let log = git(
        root,
        &[
            "log",
            &skip,
            &limit,
            "-z",
            "--date=short",
            "--no-show-signature",
            "--no-notes",
            "--format=%H%x00%ad%x00%an%x00%s",
            head,
            "--",
        ],
    )?;
    let mut commits = parse_history(&log);
    let has_more = commits.len() > page_size;
    commits.truncate(page_size);
    Ok(HistoryPage { commits, has_more })
}

#[tauri::command]
pub async fn repository_history(
    root: String,
    head: String,
    offset: u32,
) -> Result<HistoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || history_page(&root, &head, offset, 30))
        .await
        .map_err(|e| e.to_string())?
}

fn first_parent(root: &str, hash: &str) -> Result<Option<String>, String> {
    validate_hash(hash)?;
    // 读取提交对象的父提交，避免把浅克隆的边界误当成仓库的初始提交。
    let commit = git(root, &["cat-file", "commit", hash])?;
    let parent = commit
        .lines()
        .take_while(|line| !line.is_empty())
        .find_map(|line| line.strip_prefix("parent "));
    if let Some(parent) = parent {
        validate_hash(parent)?;
    }
    Ok(parent.map(str::to_owned))
}

fn commit_diff(root: &str, hash: &str, paths: &[&str]) -> Result<String, String> {
    let parent = first_parent(root, hash)?;
    let mut args = vec![
        "--literal-pathspecs",
        "diff-tree",
        "--no-commit-id",
        "-r",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
    ];
    if paths.is_empty() {
        args.extend(["--name-status", "-z"]);
    } else {
        args.push("--patch");
    }
    match &parent {
        Some(parent) => args.push(parent),
        None => args.push("--root"),
    }
    args.extend([hash, "--"]);
    args.extend_from_slice(paths);
    git(root, &args)
}

fn parse_commit_changes(output: &str) -> Vec<Change> {
    let mut fields = output.split_terminator('\0');
    let mut changes = Vec::new();
    while let Some(status) = fields.next() {
        let Some(first_path) = fields.next() else {
            break;
        };
        let (path, previous_path) = if status.starts_with(['R', 'C']) {
            let Some(new_path) = fields.next() else { break };
            (new_path, Some(first_path.to_owned()))
        } else {
            (first_path, None)
        };
        changes.push(Change {
            status: status.to_owned(),
            path: path.to_owned(),
            previous_path,
        });
    }
    changes
}

#[tauri::command]
pub async fn repository_commit_files(root: String, hash: String) -> Result<Vec<Change>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        commit_diff(&root, &hash, &[]).map(|output| parse_commit_changes(&output))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn commit_file_text(root: &str, hash: &str, path: &str, before: bool) -> Result<String, String> {
    validate_hash(hash)?;
    validate_relative_path(path)?;
    let parent;
    let revision = if before {
        parent = first_parent(root, hash)?.ok_or("没有可读取的父提交")?;
        &parent
    } else {
        hash
    };
    let object = format!("{revision}:{path}");
    let bytes = git_bytes(root, &["cat-file", "blob", &object])?;
    decode_text(bytes)
}

#[tauri::command]
pub async fn repository_commit_file(
    root: String,
    hash: String,
    path: String,
    previous_path: Option<String>,
    mode: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_relative_path(&path)?;
        match mode.as_str() {
            "diff" => {
                let mut paths = vec![path.as_str()];
                if let Some(previous) = &previous_path {
                    validate_relative_path(previous)?;
                    paths.push(previous);
                }
                commit_diff(&root, &hash, &paths)
            }
            "content" | "before" => commit_file_text(&root, &hash, &path, mode == "before"),
            _ => Err("无效的提交文件视图".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn repository_read(root: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_relative_path(&path)?;
        let file = within(&root, &Path::new(&root).join(path).to_string_lossy())?;
        if !file.is_file() {
            return Err("这不是可阅读的普通文件".into());
        }
        read_text(&file)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err("无效的仓库相对路径".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn repository_diff(
    root: String,
    path: String,
    staged: bool,
    previous_path: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 删除的文件也应能查看 diff，因此只校验相对路径，不 canonicalize 文件。
        validate_relative_path(&path)?;
        let mut args = vec![
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
        ];
        if staged {
            args.push("--cached");
        }
        args.extend(["--", &path]);
        if let Some(previous) = &previous_path {
            validate_relative_path(previous)?;
            args.push(previous);
        }
        git(&root, &args)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_renames_unicode_and_untracked_paths() {
        let changes = parse_changes("R  新 名.ts\0旧.ts\0 M src/a.rs\0?? :(glob)*.ts\0");
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].path, "新 名.ts");
        assert_eq!(changes[0].previous_path.as_deref(), Some("旧.ts"));
        assert_eq!(changes[1].status, " M");
        assert_eq!(changes[2].path, ":(glob)*.ts");
    }

    #[test]
    fn pages_fixed_history_and_reads_committed_versions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_str().unwrap();
        git(root, &["init", "--initial-branch=main"]).unwrap();
        let commit = |message: &str| {
            git(root, &["add", "-A"]).unwrap();
            git(
                root,
                &[
                    "-c",
                    "user.name=Dotdown Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-m",
                    message,
                ],
            )
            .unwrap();
            git(root, &["rev-parse", "HEAD"]).unwrap().trim().to_owned()
        };
        let original = temp.path().join("原 文件.txt");
        let renamed = temp.path().join("新 文件.txt");
        fs::write(&original, "original\n").unwrap();
        let initial = commit("initial");
        fs::rename(&original, &renamed).unwrap();
        let rename = commit("rename");
        fs::remove_file(&renamed).unwrap();
        let deletion = commit("deletion");
        fs::write(&renamed, "working tree\n").unwrap();
        let later = commit("later");

        let page = history_page(root, &deletion, 0, 2).unwrap();
        assert_eq!(
            page.commits
                .iter()
                .map(|c| c.hash.as_str())
                .collect::<Vec<_>>(),
            [&deletion, &rename]
        );
        assert!(page.has_more);
        let page = history_page(root, &deletion, 2, 2).unwrap();
        assert_eq!(page.commits[0].hash, initial);
        assert!(!page.has_more);
        assert_eq!(
            history_page(root, &later, 0, 1).unwrap().commits[0].hash,
            later
        );
        assert!(history_page(root, "--all", 0, 1).is_err());

        let added = parse_commit_changes(&commit_diff(root, &initial, &[]).unwrap());
        assert_eq!(added[0].status, "A");
        let renamed_files = parse_commit_changes(&commit_diff(root, &rename, &[]).unwrap());
        assert_eq!(renamed_files[0].status, "R100");
        assert_eq!(
            renamed_files[0].previous_path.as_deref(),
            Some("原 文件.txt")
        );
        assert_eq!(renamed_files[0].path, "新 文件.txt");
        assert!(commit_diff(root, &rename, &["新 文件.txt", "原 文件.txt"])
            .unwrap()
            .contains("similarity index 100%"));
        assert_eq!(
            commit_file_text(root, &rename, "新 文件.txt", false).unwrap(),
            "original\n"
        );
        let deleted = parse_commit_changes(&commit_diff(root, &deletion, &[]).unwrap());
        assert_eq!(deleted[0].status, "D");
        assert_eq!(
            commit_file_text(root, &deletion, "新 文件.txt", true).unwrap(),
            "original\n"
        );
    }

    #[test]
    fn reads_text_and_rejects_binary_large_and_escaping_paths() {
        let root = std::env::temp_dir().join(format!("dotdown-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("text");
        fs::write(&file, "中文\nhello").unwrap();
        assert_eq!(read_text(&file).unwrap(), "中文\nhello");
        fs::write(&file, [0, 1, 2]).unwrap();
        assert!(read_text(&file).is_err());
        fs::write(&file, vec![b'a'; MAX_TEXT as usize + 1]).unwrap();
        assert!(read_text(&file).is_err());
        assert!(within(file.to_str().unwrap(), root.to_str().unwrap()).is_err());
        fs::remove_file(file).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn git_reads_unborn_staged_worktree_and_deleted_files() {
        let temporary = std::env::temp_dir();
        let root = temporary.join(format!(
            "dotdown-git-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let directory = root.to_str().unwrap();
        git(directory, &["init", "--initial-branch=main"]).unwrap();
        assert_eq!(
            git(directory, &["symbolic-ref", "--short", "HEAD"])
                .unwrap()
                .trim(),
            "main"
        );
        assert!(git(directory, &["rev-parse", "--verify", "HEAD"]).is_err());
        let file = root.join("新 名.ts");
        fs::write(&file, "initial\n").unwrap();
        let changes = parse_changes(&git(directory, &["status", "--porcelain=v1", "-z"]).unwrap());
        assert_eq!(changes[0].path, "新 名.ts");
        assert_eq!(changes[0].status, "??");
        git(directory, &["add", "--", "新 名.ts"]).unwrap();
        git(
            directory,
            &[
                "-c",
                "user.name=Dotdown Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "fixture",
            ],
        )
        .unwrap();
        let log = git(
            directory,
            &[
                "log",
                "-30",
                "-z",
                "--date=short",
                "--format=%h%x00%ad%x00%an%x00%s",
            ],
        )
        .unwrap();
        let history = parse_history(&log);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].author, "Dotdown Test");
        assert_eq!(history[0].subject, "fixture");
        fs::write(&file, "staged\n").unwrap();
        git(directory, &["add", "--", "新 名.ts"]).unwrap();
        fs::write(&file, "working\n").unwrap();
        let changes = parse_changes(&git(directory, &["status", "--porcelain=v1", "-z"]).unwrap());
        assert_eq!(changes[0].status, "MM");
        let staged = git(
            directory,
            &[
                "--literal-pathspecs",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--cached",
                "--",
                "新 名.ts",
            ],
        )
        .unwrap();
        let working = git(
            directory,
            &[
                "--literal-pathspecs",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--",
                "新 名.ts",
            ],
        )
        .unwrap();
        assert!(staged.contains("+staged"));
        assert!(!staged.contains("+working"));
        assert!(working.contains("+working"));
        fs::remove_file(&file).unwrap();
        assert!(git(
            directory,
            &["diff", "--no-ext-diff", "--no-textconv", "--", "新 名.ts"]
        )
        .unwrap()
        .contains("deleted file"));
        // 测试独占的临时仓库：删除前确认路径仍在临时目录内。
        assert!(root.starts_with(&temporary));
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("dotdown-git-test-"));
        fs::remove_dir_all(root).unwrap();
    }
}

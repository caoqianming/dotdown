use std::fs;
use std::path::Path;
use tauri::{Emitter, Manager};

/// 读取磁盘上的文本文件，返回内容。
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取失败: {e}"))
}

/// 把内容写入磁盘文件（覆盖写入）。
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    fs::write(&path, content).map_err(|e| format!("写入失败: {e}"))
}

/// 启动参数里携带的待打开文件（双击/右键“用 Dotdown 打开”时传入）。
#[tauri::command]
fn initial_file() -> Option<String> {
    first_file_arg(&std::env::args().collect::<Vec<_>>())
}

fn is_md_path(s: &str) -> bool {
    let l = s.to_lowercase();
    l.ends_with(".md") || l.ends_with(".markdown") || l.ends_with(".mdown") || l.ends_with(".txt")
}

/// 从 argv 中取第一个 Markdown 文件路径（跳过程序自身路径）。
fn first_file_arg(argv: &[String]) -> Option<String> {
    argv.iter().skip(1).find(|a| is_md_path(a)).cloned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例：已运行时再次双击文件，转发路径到现有窗口并聚焦（须最先注册）
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = first_file_arg(&argv) {
                let _ = app.emit("open-file", path);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_file, write_file, initial_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use std::fs;
use std::path::Path;
use std::time::Duration;
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

/// 复刻“双击标题栏把窗口最大化”那一下：在扩展屏上把窗口**最大化并保持**，逼 WebView2
/// 按当前显示器 DPI 重新铺满画面。扩展屏与主屏 DPI 不同时，窗口以非最大化尺寸首次出现
/// 会按错误的栅格化比例渲染，导致右侧内容被裁掉；最大化这一步是 Windows 驱动的重排，
/// 会让 WebView2 重新铺满。**关键：最终必须停在最大化状态**——上一版切回非最大化又坏了。
fn nudge_repaint(window: tauri::WebviewWindow) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(60));
        if window.is_maximized().unwrap_or(false) {
            // 已最大化但画面坏：切出去再切回来，最终仍停在最大化
            let _ = window.unmaximize();
            std::thread::sleep(Duration::from_millis(80));
        }
        let _ = window.maximize();
    });
}

/// 窗口当前是否落在非主显示器上（按显示器位置判断）。
fn on_secondary_monitor(window: &tauri::WebviewWindow) -> bool {
    let cur = window.current_monitor().ok().flatten();
    let pri = window.primary_monitor().ok().flatten();
    match (cur, pri) {
        (Some(c), Some(p)) => c.position() != p.position(),
        _ => false,
    }
}

/// 前端首屏渲染完成后调用：仅当窗口落在扩展屏时才抖一下（主屏无此问题，避免无谓闪烁）。
#[tauri::command]
fn fix_webview_paint(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if on_secondary_monitor(&w) {
            nudge_repaint(w);
        }
    }
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
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            initial_file,
            fix_webview_paint
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

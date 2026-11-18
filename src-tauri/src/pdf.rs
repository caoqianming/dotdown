use std::fs;
use std::path::Path;
use tauri::{async_runtime::channel, webview::PlatformWebview, WebviewWindow};
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2PrintToPdfCompletedHandler, ICoreWebView2_7,
    },
    PrintToPdfCompletedHandler,
};
use windows::core::{w, Interface, HSTRING};

const MILLIMETERS_PER_INCH: f64 = 25.4;

pub async fn export(window: WebviewWindow, path: &Path, title: String) -> Result<(), String> {
    let folder = path
        .parent()
        .filter(|_| path.is_absolute())
        .ok_or("请选择有效的 PDF 保存路径")?;
    // 生成完成后再替换目标文件，避免导出失败时损坏已有 PDF。
    let staging = tempfile::tempdir_in(folder).map_err(|e| format!("无法创建临时目录：{e}"))?;
    let temporary_pdf = staging.path().join("export.pdf");
    let output = HSTRING::from(temporary_pdf.as_os_str());
    let title = HSTRING::from(title);
    let (sender, mut receiver) = channel(1);

    window
        .with_webview(move |webview| {
            let completed = sender.clone();
            let handler = PrintToPdfCompletedHandler::create(Box::new(move |status, printed| {
                let result = match status {
                    Err(error) => Err(error.to_string()),
                    Ok(()) if !printed => Err("WebView2 未能生成 PDF".into()),
                    Ok(()) => Ok(()),
                };
                let _ = completed.try_send(result);
                Ok(())
            }));
            if let Err(error) = print_to_pdf(webview, &output, &title, &handler) {
                let _ = sender.try_send(Err(error.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;
    receiver.recv().await.ok_or("PDF 导出已中断")??;

    fs::rename(&temporary_pdf, path).map_err(|e| format!("无法保存 PDF：{e}"))
}

fn print_to_pdf(
    webview: PlatformWebview,
    path: &HSTRING,
    title: &HSTRING,
    handler: &ICoreWebView2PrintToPdfCompletedHandler,
) -> windows::core::Result<()> {
    // WebView2 的 COM 接口只能在 with_webview 调度到的 UI 线程上调用。
    unsafe {
        let environment: ICoreWebView2Environment6 = webview.environment().cast()?;
        let settings = environment.CreatePrintSettings()?;
        settings.SetPageWidth(210.0 / MILLIMETERS_PER_INCH)?;
        settings.SetPageHeight(297.0 / MILLIMETERS_PER_INCH)?;
        settings.SetShouldPrintBackgrounds(true)?;
        settings.SetShouldPrintHeaderAndFooter(true)?;
        settings.SetHeaderTitle(title)?;
        settings.SetFooterUri(w!(""))?;

        let core: ICoreWebView2_7 = webview.controller().CoreWebView2()?.cast()?;
        core.PrintToPdf(path, &settings, handler)
    }
}

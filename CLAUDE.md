# CLAUDE.md

Dotdown —— 用 Tauri 2 打造的 Markdown 预览/编辑桌面小工具。

## 文档维护约定（重要）

每次改动后，**按需同步更新这三个文档**，使其与代码保持一致：

- `design.md` —— 架构、数据模型、关键设计决策；新增/调整功能时更新对应小节与路线图。
- `process.md` —— 进度与变更日志；完成一项就追加记录（新进展写在顶部），更新里程碑勾选。
- `README.md` —— 面向用户/GitHub 的功能、快捷键、构建说明；功能或用法变化时更新。

## 关键约定

- **开发**：`npm run tauri dev`；**打包**：`npm run tauri build`（产物在 `src-tauri/target/release/`，含 `Dotdown.exe` 与 `bundle/` 下的 msi/nsis）。
- **联网命令需带代理**：`$env:HTTP_PROXY/HTTPS_PROXY = "http://127.0.0.1:7897"`（npm/cargo/git 推送/REST API）。
- **Windows 工具链坑**：本机默认 Rust 为 GNU，`src-tauri/Cargo.toml` 的 `crate-type` 已精简为 `["rlib"]` 以绕开 GNU 链接器导出上限；做移动端才需改回含 `cdylib` 并切 MSVC。
- **发布**：源码推 GitHub（`caoqianming/dotdown`，HTTPS），二进制作为 **Release 资产**上传（不进 git 历史）。
- **提交信息**：用中文、`类型: 摘要` 风格（如 `feat:` / `docs:` / `chore:`）。

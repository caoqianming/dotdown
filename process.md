# mdview 进度记录

> 开发进度与变更日志。新进展追加到顶部。

## 里程碑总览

- [x] **M1 项目骨架**：Tauri 2 + Vanilla TS 脚手架、命名、工具链打通
- [x] **M2 核心编辑/预览**：CodeMirror 编辑 + markdown-it 预览、文件读写、视图切换、滚动同步
- [x] **M3 多标签页**：多文档并行、标签栏、切换/关闭/去重
- [ ] **M4 体验增强**：深色模式、大纲侧栏、会话恢复
- [ ] **M5 发布**：图标/产品信息、`tauri build` 打包

---

## 2026-06-11

### 已完成：M3 多标签页
- 实现：单 `EditorView` + 每标签独立 `EditorState`（详见 design.md §4.2）。
  - [x] 标签数据模型与全局状态（`tabs` / `activeId` / `tabSeq`）
  - [x] 标签栏 UI（名称 + dirty 点 + 关闭按钮 + `+` 新建按钮）
  - [x] 新建 / 打开（按路径去重）/ 切换 / 关闭 标签；关到 0 个自动新建空白
  - [x] dirty 判定改为按标签计算（`docOf` / `isDirty`）
  - [x] 快捷键 Ctrl+T / Ctrl+N 新建、Ctrl+W 关闭
  - [x] 拖拽多文件 → 每个文件一个标签
  - [x] 验证：`tsc` ✅、`tauri dev` 启动成功 ✅
- 下一步候选：M4（深色模式 / 大纲侧栏 / 会话恢复）。

### 文档
- 新增 `design.md`（架构/数据模型/决策）与 `process.md`（本文件）。

### 已完成：M1 + M2（初始提交 `6bd1eb8`）
- Tauri 2.11 + Vanilla TS + Vite 脚手架，统一命名为 `mdview`。
- Rust 命令 `read_file` / `write_file` + `plugin-dialog`。
- CodeMirror 6 编辑 + markdown-it 渲染（GFM / 任务列表 / highlight.js）。
- 新建/打开/保存/另存为、视图切换、滚动同步、拖拽打开、未保存提醒。
- 工具链坑：GNU `ld` 导出上限 → `crate-type=["rlib"]` 绕过。
- 验证：`tsc` ✅、`cargo build` ✅、`tauri dev` 启动成功 ✅。

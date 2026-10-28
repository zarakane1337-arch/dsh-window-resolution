# Changelog

本文件记录 dsh-plugin-resolution 的显著变更。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-28

首个版本。为 DSH 桌面端提供自定义窗口分辨率：设置页即改即用，每次启动**强制应用**。

### 新增

- 设置页「窗口分辨率」分区：六档**预设分辨率**（1280×720、1366×768、1600×900、1920×1080、2560×1440、3840×2160）、**自定义分辨率**（200–16384 的整数宽高）与「关闭」三选一；选择后立即调用 `window.dshWindowResolution.setBounds` 并用主进程回读的实际尺寸回显。
- 配置持久化到 profile 的 `localStorage`（`dsh-plugin-resolution:config`），变更通过 `dsh-plugin-resolution:changed` 广播；非法值回落到默认配置（关闭 + 1920×1080），不静默改成用户没选过的尺寸。
- Host 半体对 `resources/app.asar` 的 `lib/main.js` 与 `lib/preload-app.cjs` 做等长 ASCII 注入，打开 `dsh-desktop:window-bounds-set` IPC（`assertDesktopSender` + `BrowserWindow.setBounds`）；重算条目 `integrity.hash`，不改归档布局。
- **强制应用**：启动时按配置先退出全屏/取消最大化（等待窗口状态迁移，400ms 兜底超时），按当前屏幕工作区**钳制**目标尺寸，再居中并回读实际 bounds；接受一次轻微闪烁。
- 注入锚点用候选数组，写入前校验目标符号与 ASCII/等长/字节预算，失败即中止不写入；自动避开 `dsh-window-control` 占用的字节区间。
- 回滚边车 `.dsh-window-resolution.restore.json` 记录被覆盖字节与原/新哈希；`restore` 精确还原，`uninstall` 强制先还原再删状态文件；**绝不使用** `app.asar.orig`（dwc 的备份）。
- 启动自检：未注入就注入，载荷版本过期就还原后重注，失败只写状态文件、不阻塞 DSH 启动。
- CLI `node lib/bridge-cli.mjs`：`status`、`check`、`install`（`--dry-run`/`--force`）、`restore`（`--force`）、`uninstall`、`self-heal`。
- 文档：`docs/asar-injection.md`（注入面与回滚）、`docs/ipc-contract.md`（IPC 契约）、`docs/settings-ui.md`（设置页与存储键）、ADR 0001、中英双语 README。

### 修复

评审阶段修复的问题：

- `fix(patch)`：按 IPC 契约钳制宽高，注入载荷等待 `leave-full-screen`/`unmaximize` 状态迁移（400ms 兜底），并给载荷打 `/*dsh-wrp:v2*/` 版本标记。
- `fix(install)`：已注入的归档不再被自身载荷的标识符误报为「规划失败」；改为按 `payloadVersion` 判断是否需要重注。
- `fix(cli)`：对齐 `status`/`restore`/`uninstall` 的退出码（未注入时 `status` 为 2、`restore`/`uninstall` 无事可做为 2），补齐 `self-heal` 用法与状态报告。
- `fix(bridge)`：从归档位置反推 DSH 进程名；DSH 运行中就地写入、已退出时原子改名。
- `feat(bridge)`：注入前做写权限前置检查，无权限时报 `not-writable`，避免写到一半失败。

### 已知限制

- **DSH 升级后注入失效**：升级会整包替换 `app.asar`。启动自检会尝试重注；若锚点/符号漂移导致自检失败，需在升级完成后重新执行 `node lib/bridge-cli.mjs install`。
- **首次安装需要两次重启 DSH**：第一次让注入后的 `app.asar` 生效，第二次验证自检幂等。
- **卸载必须先 `restore` 再移除插件**：先移除插件会留下无法通过插件自身还原的注入字节。
- Windows 下 `app.asar` 位于 `Program Files` 时，首次注入可能需要管理员权限（`not-writable`）。
- 启动应用发生在页面加载之后，窗口会先按上次尺寸出现再 snap 到设定尺寸（一次轻微闪烁）。
- 只调整主窗口**外框**尺寸，不改 DPI/系统缩放，不控制辅助窗口，不支持多窗口或 per-project 配置。
- 与 `dsh-window-control` 同时控制窗口时，后应用者生效；本插件在启动时最后应用。
- 浏览器标签页 / 非 Electron 环境下通道缺席，插件静默降级为静态提示，无法在该环境调整窗口。

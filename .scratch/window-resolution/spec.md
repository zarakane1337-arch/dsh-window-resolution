# Spec：DSH 窗口自定义分辨率插件

状态：已定稿（三轮回谈 + ADR 0001）。术语见仓库根 `GLOSSARY.md`，路线取舍见 `docs/adr/0001-asar-injection-window-bounds-route.md`。

## 目标

为 DeepSeek Harness 桌面端提供可自定义的主窗口分辨率：设置页选择预设或自定义尺寸，即改即用，并在每次 DSH 启动时按配置强制应用；另将插件开源发布到 GitHub。

## 已定行为

- **分辨率语义**：主窗口**外框宽×高**（逻辑像素），不含 DPI 缩放与全屏渲染差异。
- **预设**：1280×720、1366×768、1600×900、1920×1080、2560×1440、3840×2160；另有自定义宽高输入与"关闭"项。
- **生效时机**：设置页即改即用；每次 DSH 启动时按配置应用。
- **强制应用**：启动应用时先退出全屏/取消最大化，再设为目标尺寸；目标尺寸超出当前屏幕可用工作区时钳制；应用后窗口在当前屏幕居中。
- **降级**：非桌面环境（浏览器标签页）或注入通道不可用时静默跳过，设置页给出静态状态提示。
- **发布**：MIT，公开 GitHub 仓库（名 `dsh-window-resolution`），README 中英双语；npm 发布为可选后续。

## 实现路线约束（ADR 0001）

- Host 半体对 `resources/app.asar` 的 `lib/main.js` 与 `lib/preload-app.cjs` 做**等长 ASCII 字节注入**，新增 `dsh-desktop:window-bounds-set` IPC（`assertDesktopSender` + `BrowserWindow.setBounds`，主进程内居中+钳制），并重算 `integrity.hash`。
- 注入锚点必须**避开已安装的 `dsh-window-control@1.4.2` 已占用区**；锚点用候选数组，写入前校验目标符号，失败即中止不写入。
- DSH 升级后注入失效由 host `apply()` 每次启动自检重注；首次安装需**两次重启**生效；卸载必须先 restore 还原 asar 再移除插件。
- 启动应用发生在客户端页面加载后（接受一次轻微闪烁）。
- Windows 下 `Program Files` 中的 `app.asar` 首次注入可能需要一次提权。

## 非目标

- 不改 DPI/系统缩放；不做 per-project 配置；不做多窗口控制；不改辅助窗口（欢迎窗、更新遮罩等）。

## 风险与对策（已接受）

- 升级后重注、双重启、卸载顺序、提权 —— 全部做成安装/状态 UI 与文档中的显式步骤，不静默发生。
- 与 `dsh-window-control` 自动最大化功能冲突时，本插件最后执行（后应用者优先）。

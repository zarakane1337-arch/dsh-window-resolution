# 0001 窗口尺寸控制采用 app.asar 等长注入路线

DSH 宿主没有官方窗口控制 API：Host 进程无 Electron API，主进程无窗口几何 IPC（唯一窗口 IPC 是单向 `windowFullscreen` 推送），`dshPlatform.setBounds` 只改窗口内嵌 WebContentsView；纯客户端 `window.resizeTo` 在最大化/全屏时被忽略、渲染端无法取消最大化、设定的是内容尺寸（与需求定义的"外框尺寸"差一个标题栏），且在普通浏览器标签页中静默失败。为满足"启动时强制应用自定义外框尺寸（含取消最大化/全屏）"，决定仿照已在本机验证的 `dsh-window-control@1.4.2` 模式：由插件 Host 半体对 `app.asar` 的 `lib/main.js` 与 `lib/preload-app.cjs` 做等长字节注入（重算 integrity hash），添加 `dsh-desktop:window-bounds-set` IPC（主进程 `BrowserWindow.setBounds`，带 `assertDesktopSender` 校验），客户端经 `window.dshWindowControl` 同族命名空间调用。拒绝了纯客户端与混合路线，因为它们都无法实现"强制应用"且尺寸语义不符。

## Consequences

- DSH 每次升级后注入失效，插件检测并提示（或自动）重新注入；注入锚点用候选数组以容忍注释漂移。
- 首次安装/注入需两次重启 DSH 才生效；写入前做符号存在性校验（`ipcMain`、`BrowserWindow`、`assertDesktopSender` 等），失败即中止不写入。
- 卸载必须先 restore 还原 asar 再移除插件，插件在卸载路径上强制校验并提示。
- Windows 下 `app.asar` 位于 `Program Files` 时首次注入可能需要一次提权；等长替换要求注入代码 ASCII 并留空（main 块约 1000 B 预算）。
- 启动时窗口先按上次状态出现、客户端页面加载完成后 snap 到设定尺寸（一次轻微闪烁）——换取最小注入面，未把启动逻辑注进主进程 `createWindow`。
- 应用尺寸后在当前屏幕居中。

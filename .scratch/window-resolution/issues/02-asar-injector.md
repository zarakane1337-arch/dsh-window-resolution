# 02: Host 注入器与 setBounds 通道

**What to build:** host 半体的 asar 注入引擎：在本机 `resources/app.asar` 中定位可安全占用的等长字节区（避开 `dsh-window-control` 已占用区），注入 `dsh-desktop:window-bounds-set` IPC 通道与 preload 暴露，重算 integrity hash，提供状态/检查/还原/卸载 CLI，并在每次 DSH 启动时自检重注。完成后两次重启 DSH，DevTools 中可调用该通道改变窗口尺寸。

**Blocked by:** 01（骨架与 IPC 契约）

**Status:** resolved

- [ ] 注入器拆为纯函数（header 解析、偏移计算、锚点扫描、字节预算、ASCII 校验）并有单测覆盖
- [ ] 锚点候选数组，扫描时跳过已被占用字节；与 `dsh-window-control` 注入区互不覆盖（本机实测）
- [ ] 写出前校验目标符号存在；预算不足、无写权限、符号缺失时**不修改文件**并给出明确错误
- [ ] 注入后 `integrity.hash` 重算，DSH 正常启动（两次重启流程验证）
- [ ] `setBounds` 通道：拒绝非 `dsh-app://app/` 发送者与非主 frame；主进程内取消最大化/退出全屏后 `setBounds`，在当前显示器工作区居中且钳制，遵循最小尺寸约束
- [ ] preload 暴露 `window.dshWindowResolution`（版本号 + setBounds/getState）
- [ ] CLI：`status`、`check`、`install`、`restore`、`uninstall`；restore 精确还原原始字节；uninstall 先执行 restore
- [ ] host `apply()` 每次启动自检，DSH 升级后自动重注
- [ ] 状态文件记录注入状态、目标版本与时间戳

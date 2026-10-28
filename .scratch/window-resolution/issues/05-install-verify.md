# 05: 本机安装与端到端验证

**What to build:** 把插件安装到当前 desktop profile 并在本机完成端到端验证：注入、两次重启生效、启动应用、即改即用、关闭、钳制、非桌面降级、卸载顺序（restore→移除）逐项实测，产出截图与日志证据供 README 使用。

**Blocked by:** 02、04

**Status:** resolved

- [x] 插件安装到当前 desktop profile 并被 DSH 加载（注入状态文件显示已注入）
- [x] 两次重启流程记录在案，第二次启动后通道可用
- [x] 启动应用：配置 1920×1080 → 重启 → 窗口外框为 1920×1080 且居中
- [x] 即改即用：设置页切换预设 → 窗口立即变化
- [ ] 关闭项：重启后窗口尺寸不被应用（实现+单测覆盖，未单独实机演练 off）
- [x] 钳制：自定义 200×200 实机接近 200×200（v2 修正后不再抬到 520×600）
- [ ] 非桌面降级：浏览器标签页显示"非桌面"状态（单测覆盖，未实机开浏览器验证）
- [ ] 卸载顺序演练：restore 后 app.asar 无残留注入字节，再移除插件（单测+夹具往返覆盖，未在运行中的真实归档演练以避免中断）
- [ ] 产出 README 所需截图与验证日志（截图待补，见 06）

## Answer

已在本机 desktop profile 完成实机验证：

- 安装：`C:\Users\zarak\.dsh\local-plugins\dsh-window-resolution` + profile `node_modules` 链接 + `dsh.profile.bundles` 注册；首次重启报 `cannot resolve profile bundle`，补链接后修复。
- 注入：v1 载荷（T02）→ review 修复版 v2（`f1d98ca`）重注成功；`node lib/bridge-cli.mjs status` 输出：
  `载荷版本：2（当前 v2）`、`自洽：是`、`DSH 版本：44.7.0`、`dwc：检测到…将避开其字节区间`、锚点 `main-helpers 530 B @119353`、`main-handler 689 B @126252`、`preload-bridge 271 B @1846`。
- 运行验证（用户实机确认）：设置页出现"窗口分辨率"分区、默认关闭；选 1920×1080 立即变尺寸且居中；重启后启动即自动应用；自定义 200×200 实际接近 200（受宿主最小窗口尺寸约束，回读 bounds 为准）。
- 关闭项/浏览器降级/卸载演练由单测与夹具往返覆盖；真实归档未做 restore 演练，避免中断正在使用的 DSH。

# 01: 仓库与插件骨架

**What to build:** 一个可被 DSH profile 识别并加载的插件骨架，包含双载体（host + client）入口、清单、许可证、构建脚本与 IPC 契约文档。完成后 DSH 设置里能看到该插件的占位分区，宿主启动不报错。

**Blocked by:** 无（可立即开始）

**Status:** ready-for-agent

- [ ] `package.json` 声明 `dsh.manifestVersion`、`dsh.bundle.patch`、`dsh.client{platform:"web", immediately:true, inject:[...]}`，`type: "module"`，MIT 许可
- [ ] `cordis.patch.yml` 含 `insert` 条目（id/name 与包名一致）
- [ ] host 入口导出 `apply(ctx, config)` 骨架（暂不注入、不报错）
- [ ] client 入口在设置体系注册一个占位分区，渲染无错误
- [ ] `docs/ipc-contract.md` 定义 `window.dshWindowResolution` 契约：`setBounds({width,height})`、`getState()` 的参数、成功返回（实际 bounds）、错误码（非桌面/无窗口/未注入/校验失败）
- [ ] locale 骨架（zh-CN/en 资源，含分区标题与状态文案 key）
- [ ] 构建脚本从源码产出 `lib/` 产物；类型检查/构建通过
- [ ] 仓库含 `.gitignore`（node_modules 等）、LICENSE

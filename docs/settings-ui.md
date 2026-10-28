# 设置页与持久化（T03）

设置页分区 `settings.section` / id `window-resolution` 由 `lib/client.js` 提供：六档预设
（1280×720、1366×768、1600×900、1920×1080、2560×1440、3840×2160）、自定义宽高（200..16384
的整数）和「关闭」三选一。选择或输入变化后立刻调用 `window.dshWindowResolution.setBounds`，
并用返回的 `bounds` 回显窗口实际尺寸（主进程可能钳制请求值）。

## 配置存在哪里

客户端没有官方设置存储服务，已装插件（如 `dsh-window-control`）一律用 `localStorage`。
本插件沿用同一机制，键名固定：

| 键 | 写入方 | 内容 |
| --- | --- | --- |
| `dsh-plugin-resolution:config` | 设置页、启动应用（T04） | `{"mode":"preset"\|"custom"\|"off","width":number,"height":number,"presetValue":string\|null}` |
| `dsh-plugin-resolution:last-applied` | 启动应用（T04） | 最近一次真正生效的 `{width,height,x?,y?,at}`（可能被钳制） |
| `dsh-plugin-resolution:status` | 启动应用（T04） | `{state,at,...}`，`state` ∈ `not-desktop` / `off` / `pending` / `not-patched` / `applied` / `failed`（失败带 `code`、`message`） |

`presetValue` 是派生字段：等于尺寸对应预设的 key（`"1920x1080"` 形态），不是预设尺寸时为
`null`。读取时一律经过与 `lib/config.js` 的 `normalizeConfig()` 相同的规则：存储损坏、
字段非法、自定义宽高越界都回落 `DEFAULT_CONFIG`（关闭 + 1920×1080），**不**把非法值悄悄
修成用户没选过的尺寸。「关闭」也会持久化，保证下次启动不擅自改窗口。

注入侧的现状（`installed`、`payloadVersion`、`targetVersion`、`consistent`）由 host 自检写入
`~/.dsh/profiles/<profile>/.dsh-window-resolution.json`（字段见
[`docs/asar-injection.md`](./asar-injection.md)）；设置页只展示 `status` 键里最近一次应用结果，
不直接读这个文件，也不显示注入版本。

## 变更广播

每次用户变更都会：写入 `config` 键 → 在当前 `window` 上派发
`dsh-plugin-resolution:changed`，`event.detail` 是完整配置对象。同页其他分区/其他窗口
据此同步显示；监听方只更新界面，不重复写存储、不重复调桥。外部广播（例如 T04 补应用
前更新配置）也会让设置页刷新选中项与状态行。

## 组件约束

- 工厂函数无副作用：加载时不读存储、不调桥、不派发事件。
- 事件监听与 400ms 输入防抖都由 `React.useEffect` 的清理函数释放；卸载后不再发 IPC。
- 不操作他人 DOM，不改 app root。
- 所有用户可见文案走 locale（`locale/zh-CN.json`、`locale/en.json`），客户端内置字典与
  资源文件逐字一致。

## 降级与错误文案

- 通道整体缺席或 `v !== 1`：显示「非桌面端 / 通道未注入」静态提示；交互仍然可用并把
  选择记进 localStorage，下一次启动由 T04 强制应用。
- `invalid`：输入框内联提示，不发 IPC（客户端先校验，理论上不会走到 IPC）。
- `no-window`：提示重开窗口；`not-desktop` / `not-patched`：提示环境未就绪；
  `rejected`：展示桌面端返回的 `message` 原文（不翻译）；其余错误走 `statusError`。
- `getState()` 缺席或抛错：跳过 patched/desktop 探测，界面照常渲染。

## 测试

- `test/settings-ui.test.js`：假 React 挂载后覆盖渲染、校验、持久化、广播、卸载清理与
  全部错误码文案映射。
- `test/settings-parity.test.js`：客户端字面量（`exports.meta`）与 `lib/contract.js`、
  `lib/config.js` 对拍，并检查本文档记录了存储键与事件名。

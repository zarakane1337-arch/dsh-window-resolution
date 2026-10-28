# IPC 契约：`window.dshWindowResolution`

状态：已定稿（契约版本 1）。本文是 T02（宿主注入）与 T03（设置页）的**并行基准**：两边都按这里的参数、返回形状与错误码实现，任何一侧单独改动都算破坏契约。

- 可执行版本：`lib/contract.js`（常量、`validateSetBounds()`、报文构造器）——本文与它由 `test/ipc-contract-doc.test.js` 绑定。
- 路线与注入面：`docs/adr/0001-asar-injection-window-bounds-route.md`。
- 术语：`GLOSSARY.md`（窗口分辨率 = 主窗口**外框**宽×高，逻辑像素）。

## 为什么需要这条通道

DSH 的宿主进程跑在 `ELECTRON_RUN_AS_NODE=1` 下、没有 Electron API；主进程原本也不开放任何窗口几何通道（唯一相关的是单向 `windowFullscreen` 推送）。要在**启动时**取消最大化/全屏并把窗口设成指定外框尺寸，只能由插件把一小段代码等长注入 `resources/app.asar`，开一条自己的 IPC。这条 IPC 的形状就是本文。

## 命名空间与特性检测

```js
window.dshWindowResolution
// → { v: 1, setBounds, getState }   桌面端且桥已注入
// → undefined                       非桌面端 / 未注入
```

`v` 是契约版本常量，当前 `v: 1`。检测顺序固定为：

1. `window.dshWindowResolution` 不存在 → 桥未注入（`not-patched`）或非桌面端（`not-desktop`）；
2. 存在但 `v !== 1` → 视为不兼容，调用方按 `not-patched` 降级，不猜测旧版本语义；
3. 存在且 `v === 1` → 可调用。

命名空间由 preload 桥注入，**不是**空对象占位：未注入时属性整个缺席，所以 `typeof window.dshWindowResolution === 'object'` 就是特性检测。

## 通道

| 项 | 值 |
| --- | --- |
| IPC 通道名 | `dsh-desktop:window-bounds-set` |
| 方向 | 渲染端 → 主进程（`ipcRenderer.invoke` / `ipcMain.handle`） |
| 发送方校验 | 主进程侧 `assertDesktopSender(event)`；非桌面 sender 直接以 `not-desktop` 拒绝 |

## `setBounds`

签名：

```ts
setBounds({ width: number, height: number }) => Promise<
  | { ok: true, bounds: { x: number, y: number, width: number, height: number } }
  | { ok: false, code: ErrorCode, message: string }
>
```

参数：

| 参数 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| width | number | 是 | 整数，200 ≤ width ≤ 16384 |
| height | number | 是 | 整数，200 ≤ height ≤ 16384 |

- 位置（`x`/`y`）**不接受**：目标窗口由主进程选定（主窗口），位置由主进程计算（当前屏幕居中），调用方传了会被忽略。
- 非对象、缺字段、非整数、`NaN`/`Infinity`、越界 → 客户端本地即可判定为 `invalid`，主进程也会再判一次（纵深防御）；两次判定必须给出同一个错误码。

成功返回（**实际**应用后的 bounds，可能与请求值不同 —— 被钳制时）：

```json
{ "ok": true, "bounds": { "x": 320, "y": 180, "width": 1920, "height": 1080 } }
```

失败返回：

```json
{ "ok": false, "code": "rejected", "message": "BrowserWindow.setBounds failed: ..." }
```

行为约定（主进程内，顺序固定）：

1. `assertDesktopSender` 校验 sender；
2. 取主窗口，取不到 → `no-window`；
3. 若全屏则退出全屏；若最大化则取消最大化；两条路径都**等待事件**（`leave-full-screen` / `unmaximize`）
   或以 400ms 兜底超时才继续（强制应用语义，见 `GLOSSARY.md`）；
4. 先按契约 `MIN_SIDE = 200` / `MAX_SIDE = 16384` 钳制请求宽高，再与当前屏幕**可用工作区**
   取交集（不叠加任何宿主窗口尺寸假设：宿主自己的最小尺寸由主进程 `setBounds` 决定，回读即真实结果）；
5. `setBounds({ width, height })`（只给尺寸，位置由下一步决定）；
6. 在当前屏幕居中；
7. 回读 `getBounds()` 并按上面的成功形状返回。

重复调用幂等：同样的入参重复调用不改变最终几何，也不报错。

## `getState`

签名：

```ts
getState() => Promise<{
  patched: boolean
  desktop: boolean
  bounds?: { x: number, y: number, width: number, height: number }
}>
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| patched | boolean | 窗口通道是否就位。桌面端下等于「命名空间 `v === 1` 且主进程 handler 已注册」；浏览器标签页下恒为 `false` |
| desktop | boolean | 当前是否运行在 DSH 桌面端（由 preload 桥标记，而不是猜 userAgent） |
| bounds | object? | 主窗口当前几何；窗口尚未创建或已销毁时**整个字段缺席**（不是 `null`） |

示例：

```json
{ "patched": true, "desktop": true, "bounds": { "x": 0, "y": 0, "width": 1280, "height": 720 } }
```

`getState()` 永远 resolve，不 reject：状态查询失败本身就是要展示的状态，用异常表达会让设置页多一层 try/catch。

## 错误码

| 错误码 | 触发场景 | 调用方应有反应 |
| --- | --- | --- |
| `not-desktop` | 在浏览器标签页里运行，或主进程 sender 校验不通过 | 静默降级：隐藏控件，显示「非桌面端」静态提示 |
| `no-window` | 主进程找不到可操作的 BrowserWindow（已销毁 / 只有辅助窗口） | 提示重开窗口，不重试 |
| `not-patched` | 桌面端但 preload 桥未注入（`window.dshWindowResolution` 缺席），或 `v` 不匹配 | 提示「注入未就绪」并给出安装/重启指引，绝不重试注入 |
| `invalid` | 入参形状非法：非对象、缺字段、非整数、越界 | 控件内联报错，不发送 IPC |
| `rejected` | `BrowserWindow.setBounds` 抛错、窗口不可调整（如被系统锁定） | 展示 `message` 原文供排障，允许用户重试 |

新增错误码 = 契约版本升级；已发布的错误码语义不得复用或改写。

## 返回形状的共同约定

- 所有方法都返回 `{ ok: boolean, ... }` 形状的对象，**不 reject**；异常一律转成 `rejected` 报文（`getState` 例外，见上）。
- `message` 是面向排障的英文单行文本，不含堆栈、不含本地路径以外的隐私信息；UI 展示原文，不翻译。
- 报文里**不**重复携带 `v`：版本由命名空间属性承载，避免两处不一致。

## 版本与兼容

三个版本号**相互独立**，不要混用：

| 常量 | 值 | 承载位置 | 作用 |
| --- | --- | --- | --- |
| `CONTRACT_VERSION` | `1` | 命名空间上的 `v: 1`（`lib/contract.js`） | IPC 报文形状；新增错误码 = 升级 |
| `BRIDGE_VERSION` | `1` | 回滚边车与状态文件的 `version`（`lib/bridge/install.js`） | 边车/状态文件格式；格式变更才升级 |
| `PAYLOAD_VERSION` | `2` | 注入注释里的 `/*dsh-wrp:v2*/` 标记（`lib/bridge/patch.js`） | 决定「要不要重新注入」 |

重注规则：

- 载荷行为变化（新增等待、改钳制等）必须把 `PAYLOAD_VERSION` 加一并更新标记；标记由注入器写进
  `main-helpers` 注释末尾，`detect()` 用 `/*dsh-wrp:v(\d+)*/` 解析。
- `install` / `ensurePatched` 先比较 `detection.payloadVersion !== PAYLOAD_VERSION`：不一致即视为陈旧，
  用回滚边车还原旧字节后重注，并在报告里给 `reinstalled: true`（与首次安装的 `changed`、
  已最新的 `already` 区分）。
- 没有标记的历史注入（本机 v1）`payloadVersion === null`，同样判为陈旧。
- 陈旧且**边车缺失**时不能安全重注（无法精确还原旧字节），`install` 以 `no-state` 失败，
  此时重装 DSH 桌面端即可恢复干净归档。
- `dryRun` 下陈旧归档返回 `needsReinstall: true`，只报告不写盘。

客户端无法 `import` 本仓库的 `lib/contract.js`（它的模块加载器只负责 `react` 等宿主提供的依赖），
因此客户端里的字面量（命名空间、`v`、错误码、200/16384）必须与本文一致，并在 T03 补一条
「客户端字面量 ↔ `lib/contract.js`」的 parity 测试。

## 实现分工

- **T02（宿主注入）**：`lib/main.js` / `lib/preload-app.cjs` 等长 ASCII 注入、`assertDesktopSender`、`BrowserWindow.setBounds`、钳制与居中；注入前做符号存在性校验，失败即中止。
- **T03（设置页）**：预设/自定义控件、即改即用、`getState()` 驱动的状态文案；非桌面端与未注入时静默降级。
- **T04（启动应用）**：页面加载完成后按配置调用 `setBounds`，接受一次轻微闪烁。

# app.asar 注入器（注入面、锚点与还原）

本文说明 host 半边怎么把 `dsh-desktop:window-bounds-set` 通道塞进 DSH 的
`resources/app.asar`，以及怎么安全地拿回来。契约本身在
[`docs/ipc-contract.md`](./ipc-contract.md)，决策记录在
[`docs/adr/0001-asar-injection-window-bounds-route.md`](../docs/adr/0001-asar-injection-window-bounds-route.md)。

## 为什么是等长字节替换

`app.asar` 的每个条目在头部 JSON 里带 `size` 与 `integrity.hash`。改变条目长度就要重写
整个数据区与所有 `offset`，风险远大于收益。所以注入只做三件事：

1. 在 `lib/main.js` / `lib/preload-app.cjs` 里各找一段**注释**（注释不参与执行）；
2. 用**等长 ASCII** 代码覆盖这段注释的字节，不足部分补空格；
3. 按新字节重算该条目的 `integrity.hash`，在头部里就地改掉原来那两处哈希。

条目长度、其它条目、头部长都不会变，因此不需要重排归档。

## 锚点表（本机 DSH 实测）

`dsh-window-control`（下称 dwc）已经占用了 `lib/main.js` 与 `lib/preload-app.cjs` 里
原本最适合注入的两段注释区。注入器因此用**候选数组**：按顺序试，第一个「字节区间空闲 +
符号校验通过」的候选胜出。

| 块 | 条目 | 锚点（注释首行） | 起始字节 | 块长 | 载荷 | 余量 |
| --- | --- | --- | --- | --- | --- | --- |
| `main-helpers` | `/lib/main.js` | `/**\n* Compare two raw configs, …` | 119353 | 572 B | 516 B | 56 B |
| `main-handler` | `/lib/main.js` | `/**\n* Zero-dependency atomic file replacement …` | 126252 | 710 B | 499 B | 211 B |
| `preload-bridge` | `/lib/preload-app.cjs` | `//#region lib/types/preload-platform.js` | 1846 | 291 B | 271 B | 20 B |

- `main-helpers` 的备选是 `/**\n* Resolve the single-root DeepSeek Harness home.`（字节 3062，
  块 600 B，余量 84 B）；首选被占用时自动退到它。
- 块长是「从注释首行开始，连续吃掉后续注释与空白」的长度；扫描到第一个非注释 token 就停。
- 候选区上若出现 `DWC=[[`（main）或 `dshWindowControl`（preload）即视为被占用，跳过。

## 载荷

三块都在 `lib/bridge/patch.js` 里以字符串常量给出，安装前会校验：

- **全 ASCII**（`Buffer.byteLength(code) === code.length`），否则拒绝；
- 长度不超过块长，不足补**普通空格**（绝不补 `//`，那会把后面一行代码注释掉）；
- 目标文件里已经存在同名顶层常量（如 `RSZ`）时报错，避免标识符撞车；
- `main` 的载荷写成 `const RSZ={…}` + `ipcMain.handle(…)` 两块，因为「校验 + 报告 + 居中钳制」
  的完整实现塞不进单一候选块（最强候选只有 572 B）。

载荷里刻意**不做**的事：

- 不 `import` 项目里的任何模块（注入代码在 `app.asar` 内，拿不到本插件的文件）；
- 不动态 `import("electron")`：`screen` 不在 `lib/main.js` 顶部的 electron 导入列表里，
  所以用文件顶部已经存在的 `createRequire(import.meta.url)("electron")` 取，且只在 handler
  内部求值（那时 app 已就绪）；
- preload 不再重复校验 `dsh-app:` 协议：主进程侧 `assertDesktopSender(event, ["app"])` 已是
  权威校验，preload 只按 `hostname === "app"` 与 `process.isMainFrame` 做范围过滤。

## 安装、还原与回滚边车

`install` 的顺序是：定位归档 → 解析头部 → 选锚点 → 校验符号/ASCII/长度 → 算新哈希 →
**先写回滚边车** → 写条目 → 最后写头部 → 回读校验。

回滚边车 `.dsh-window-resolution.restore.json` 只记录我们动过的字节：

| 字段 | 含义 |
| --- | --- |
| `blocks[].original` | 被覆盖区间的原始字节（base64），长度等于 `byteLength` |
| `targets[].hashOffsets` | 头部里被改写的那两处哈希的**文件绝对偏移** |
| `targets[].oldHash` / `newHash` | 还原前后该条目的 integrity 哈希 |
| `layout` | 头部 JSON 长度与数据区起点，用于自检 |

**绝不使用 `app.asar.orig`**：那是 dwc 的备份，用它会连带抹掉 dwc 的注入。

`restore` 的前置条件：两个条目当前哈希必须等于边车里的 `newHash`。DSH 升级换掉整个
归档后哈希对不上，`restore` 会以 `stale-state` 拒绝动手（此时删掉边车、重新 `install`
即可），而不是把新版本写坏。`uninstall` 永远先 `restore` 再删状态文件。

## CLI

```bash
node lib/bridge-cli.mjs status              # 只读：归档、注入状态、dwc 共存、锚点与字节预算
node lib/bridge-cli.mjs check               # 只读：哈希自洽性；未注入时报告可否安装
node lib/bridge-cli.mjs install --dry-run    # 打印将写入的偏移与字节预算，不落盘
node lib/bridge-cli.mjs install             # 真注入（需要写权限；建议先退出 DSH）
node lib/bridge-cli.mjs restore             # 用回滚边车精确还原
node lib/bridge-cli.mjs uninstall           # 先还原，再删状态文件
```

退出码：`0` 成功/已注入，`1` 失败，`2` 未注入或无事可做。

需要指定归档时把路径放在子命令后面；也可用环境变量 `DSH_WINDOW_RESOLUTION_ASAR`
（或 `DSH_ASAR`）覆盖定位结果。

## 状态文件

`~/.dsh/profiles/<profile>/.dsh-window-resolution.json`，每次 `apply()` 启动自检后覆盖写入：

```json
{ "ok": true, "archive": "…\\app.asar", "installed": true, "version": 1,
  "targetVersion": "1.2.3", "changed": false, "at": "2026-10-28T11:00:00.000Z" }
```

失败时 `ok: false` 并带 `error: {code, message}`。字段与 dwc 的
`.dsh-window-control.json` 对齐，便于用户在同一处排查两个注入器。

## 失效与恢复

| 场景 | 表现 | 处理 |
| --- | --- | --- |
| DSH 升级 | 锚点或符号找不到，自检失败 | 状态文件 `ok:false`；升级完成后重新 `install` |
| 只有一半补丁在 | `install` 报 `inconsistent` | `restore --force`，再 `install` |
| 注入后 DSH 起不来 | — | 删 `app.asar.orig` 之外别动；用 `restore` 还原，或重装 DSH |
| 没有写权限 | `install` 报 `not-writable` | 提权后重试（Windows：管理员终端），期间退出 DSH |
| 边车丢失但已注入 | `restore` 报 `no-state` | 重装 DSH 恢复原状；不要在缺边车时手改字节 |

首次注入后需要**重启 DSH 两次**（第一次让新 `app.asar` 生效，第二次验证自检幂等）。

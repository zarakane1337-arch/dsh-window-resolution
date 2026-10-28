# dsh-plugin-resolution — 源码级侦察笔记（A–E）

- 侦察时间：2026-10-28T18:53+08:00（DSH 运行中，app.asar 已装 dsh-window-control v3 桥）
- 只读原则：全程未修改任何 DSH 安装文件；所有探针脚本写在 Temp。
- **路径限制（必须知道）**：任务指定的 `C:\Users\zarak\AppData\Local\Temp\dsh-plugin-notes\` 在本会话的 workspace-write 沙箱下**不可创建**
  （bash `mkdir` → `Permission denied`；pwsh `New-Item` → `UnauthorizedAccessException`）。可写 Temp 是会话私有目录
  `C:\Users\zarak\AppData\Local\Temp\dsh-3NfvOP\`（bash 里显示为 `/tmp`）。本文件因此落在
  `C:\Users\zarak\AppData\Local\Temp\dsh-3NfvOP\dsh-plugin-notes\exploration.md`，并在工作区
  `C:\Users\zarak\Desktop\dsh-plugin\_probe\exploration.md` 放同一份副本供检索。探针脚本同样在该目录。

环境常量：

| 名称 | 值 |
| --- | --- |
| $ASAR | `C:\Users\zarak\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（182,794,869 B；jsonLength 4,779,780；dataStart 4,779,796；18,309 条目） |
| 备份 | `app.asar.orig` 存在（dwc 创建） |
| $DWC | `C:\Users\zarak\.dsh\profiles\desktop\node_modules\dsh-window-control`（1.4.2） |
| $PROFILE | `C:\Users\zarak\.dsh\profiles\desktop` |
| 归档内客户端前缀 | `/dsh/node_modules/@deepseek-ai/...`（**不是** `/node_modules/...`） |
| 工作区 | `C:\Users\zarak\Desktop\dsh-plugin` |

探针脚本（均在 Temp 目录）：`probe1.mjs`（解析 header、导出 main/preload 字节与注释清单）、`probe2.mjs`（自写 JS 词法器求"安全区"= 注释+空白的极大连续段，char→byte）、`probe3.mjs`（把注入代码等长塞进候选区 → `node --check` 判定语法）、`probe4.mjs`（定位 dwc 自己的锚点/注入块并做重叠检查）、`probe5–9.mjs`（单注释锚点、变体字节数与最终 splice 校验）、`extract.mjs`（`list/cat/dump` 读 asar 任意条目）。

---

## A. dwc 注入器逐点拆解

证据文件：`C:\Users\zarak\.dsh\profiles\desktop\node_modules\dsh-window-control\lib\asar-bridge.js`（1,466 行）、`lib\bridge-cli.mjs`（208 行）、`lib\index.js`（337 行）。

### A1. asar 解析

- 头布局（asar-bridge.js:292–308 注释 + 实现）：`[0,16)` 固定头，其中 `[12,16)` 小端 uint32 = JSON 长度；JSON 紧随其后，之后可能有对齐填充 ⇒ 解析时取到最后一个 `}`：`const text = head.toString('utf8'); const jsonLength = raw.readUInt32LE(12); const dataStart = 16 + jsonLength; JSON.parse(text.slice(0, text.lastIndexOf('}') + 1))`。
  守卫：`if (!(jsonLength > 0 && jsonLength <= 64 * 1024 * 1024)) throw ...`（asar-bridge.js:301–308）。
- 只读头部：`readArchive`（356–379）只读 `[0, 16 + jsonLength)`（≈4.8 MB / 25 ms），**不**读整包 182 MB。
- 条目寻址（390–414）：`absolute = dataStart + Number(meta.offset)`，在该偏移读 `meta.size` 字节。实测 `/lib/main.js`：
  `meta = { size: 516716, offset: "177003298", integrity: { algorithm:"SHA256", hash:"cfbbcff898be7ce07fbe08eaba6c0c1a9ee841f6109daab953a11cf58d798368", blockSize:4194304, blocks:[同上] } }`，绝对文件偏移 **181,783,094**。
  `/lib/preload-app.cjs`：`size = 41075`，`offset = "177520014"`，`hash = 6b46a27b324be0bdcd0e55a368d8e32221242e2fb22f588ace3a171d5a7f03a9`，绝对偏移 **182,299,810**。
- 完整性算法（866–887 + 449–451）：`integrity.algorithm` 必须是 `'SHA256'`，`blocks.length === 1`，且 `integrity.hash === blocks[0]`，长度 64；新哈希 = `sha256(打过补丁的条目字节).toString('hex')`。头部里的旧 hex 出现两次（`"hash"` 与 `"blocks":[` 各一次）**必须同时换掉**。
  `patchHeaderHash`（795–821）：先数旧 hex 在头缓冲里出现次数；==2 ⇒ 全文就地 ASCII 替换（mode `'plain'`）；否则用唯一锚 `"offset":"<n>"` / `"offset":<n>` 定位本条目，替换其后的两次出现（mode `'offset'`）；都不行 ⇒ 抛 `头部哈希命中 N 次，且无法用 offset 定位本条目（期望 2 次）`。
- 写入（1130–1291）：头部补丁是 `writes[0]`，`fileOffset = 16`（`HEADER_FIXED`）；条目补丁各自的 `fileOffset = dataStart + offset + byteStart`。
- fs 陷阱（44–68）：Electron 会把 `.asar` 路径劫持成"归档内路径"（`existsSync` 真、`openSync` ENOENT、`statSync` size 0）。所以引擎优先 `require('original-fs')`，失败退回 `node:fs`，导出 `fs` 与 `fsSource`。**我们照抄这一层，否则在宿主进程里读不到归档字节。**

### A2. 锚点机制

- `TARGETS = { main: '/lib/main.js', preload: '/lib/preload-app.cjs' }`（71–74）；`MARKS = { main: 'DWC=[[', preload: 'dshWindowControl' }`（82–89，幂等标记）；`BRIDGE_VERSION = 3`（98）。
- `ANCHORS`（111–114）是**候选数组**，按序尝试，第一个命中即用；新版本只在末尾追加锚点以保持向前兼容。锚点只用于搜索，不占字节预算：
  - main: `/**\n* Replace \`filename\` with \`content\` in one atomic step`
  - preload: `/**\n* Watches \`html[data-ds-theme-source]\``
- `replaceAnchor`（676–701）：拒绝非 ASCII 代码（`Buffer.byteLength(code) !== code.length`）；锚点必须**唯一**（找不到 ⇒ `找不到注入锚点（DSH 版本可能已变化）`；多次 ⇒ `注入锚点出现多次`）；替换范围 = **锚点起点 → 其后第一个 `*/` + 2**；`padding = byteLength(范围) - code.length`（<0 直接失败）；载荷 = `code + ' '.repeat(padding)`（**右侧补普通空格**，无注释块保留）。`replaceAnchorAny`（715–733）逐个候选尝试并汇总失败原因。
- 字节预算（实测，见 `node lib/bridge-cli.mjs check`）：
  - main.js 替换块 **1000 B**，注入代码 **953 B**，填充 **47 B**
  - preload-app.cjs 替换块 **504 B**，注入代码 **432 B**，填充 **72 B**
  - 两处都是单块 SHA256；自检通过；其余 18,307 条目不参与改动。
- 注入代码原文（asar-bridge.js:132–162）——**main（953 ASCII 字符）**：

```
const P="dsh-desktop:",DWC=[[P+"app-quit",async(w,o={})=>{const r=await dialog.showMessageBox(w,o);if(r.response)return false;try{skipQuitConfirmation=true}catch(e){}app.quit();return true}],[P+"window-fullscreen-set",(w,v)=>{w.setFullScreen(!!v);return w.isFullScreen()}],[P+"window-maximize",(w,v)=>{if(v)w.maximize();else w.unmaximize();return w.isMaximized()}],[P+"window-minimize",(w,v)=>{if(v)w.minimize();else w.restore();return w.isMinimized()}],[P+"window-top",(w,v)=>{w.setAlwaysOnTop(!!v);return w.isAlwaysOnTop()}],[P+"window-state",w=>({fullscreen:w.isFullScreen(),maximized:w.isMaximized(),minimized:w.isMinimized(),top:w.isAlwaysOnTop()})]];for(const[k,fn]of DWC){ipcMain.removeHandler(k);ipcMain.handle(k,(e,v)=>{assertDesktopSender(e,["app"]);if(e.senderFrame!==e.sender.mainFrame)throw new Error("dwc: sender");const w=BrowserWindow.fromWebContents(e.sender);if(w===null||w.isDestroyed())throw new Error("dwc: nowin");return fn(w,v)})}
```

  ——**preload（432 ASCII 字符）**：

```
if(location.protocol==="dsh-app:"&&location.hostname==="app"&&process.isMainFrame){const V=(k,v)=>electron.ipcRenderer.invoke(k,v),P="dsh-desktop:";electron.contextBridge.exposeInMainWorld("dshWindowControl",{v:3,setFullscreen:x=>V(P+"window-fullscreen-set",x),setMaximized:x=>V(P+"window-maximize",x),setMinimized:x=>V(P+"window-minimize",x),setTop:x=>V(P+"window-top",x),state:()=>V(P+"window-state"),quit:o=>V(P+"app-quit",o)});}
```

- 落点实测：main 的注入块在条目内 byte **127,956**（绝对 181,911,050，`_lib_main.js.txt` 第 **3333** 行），位于 `}`（`renameAtomicTemp` 结束）与 `async function writeFileAtomic` 之间——**模块顶层语句位置**，行尾 47 个空格。preload 的在条目内 byte **3,451**（绝对 182,303,261，第 **76** 行）。

### A3. 写入 / 回滚 / 状态 / CLI

- 锁（526–608）：`LOCK_SUFFIX='.dwc.lock'`、`LOCK_STALE_MS=30_000`、`openSync(file,'wx')` 写 `{pid,at}`；mtime 过期可抢占；二次失败返回 `另一个进程正在改写归档（锁已存在约 N 秒），本次跳过`。
- 可写探测（install 内）：`fs.openSync(archive,'r+')`，`EACCES/EPERM/EROFS` ⇒ 长中文提示（含建议 `config: { autoInstall: false }`）。
- 进程内改写：`isRunning()`（1035–1064）win32 用 `tasklist /FI IMAGENAME eq <name>.exe /NH`；探测失败按"运行中"处理（保守）。运行中 ⇒ `open('r+')` + 逐个 `writeSync(fileOffset)` + `fsyncSync`（就地覆盖可信，因为补丁只有几百字节且两个文件都已加载）；未运行 ⇒ 复制到 `archive + '.tmp-' + pid`、打补丁、`renameSync` 覆盖。
- 备份：`BACKUP_SUFFIX='.orig'`（165），即 `app.asar.orig`。`backupFresh`（624–634）比对**大小 + 全文件 sha256**（4 MB 分块）——因为 Electron 的 original-fs 保留 mtime，只比时间不可靠。`install` 仅当 `!backupFresh()` 时 `fs.copyFileSync`。
- 还原（1341–1410）：未打桥且未 `force` 时拒绝；运行中 ⇒ 4 MB 分块就地拷贝；提示 `已还原为原始 app.asar（重启 DSH 后生效）`。`uninstall`（1424–1466）= `restore(force)` + 删 `.orig`。
- 升级语义（关键）：等长替换**摧毁了锚点文本**，所以 `install` 在 `installed && (version < target || force)` 时先 `restore(force)` 再重新注入。
- 状态文件：`lib/index.js:statusFile()`（128–136）= `path.join(DSH_HOME || ~/.dsh, 'profiles', DSH_PROFILE || 'desktop', '.dsh-window-control.json')`；`status()`（463–498）返回 `{ok, archive, backup, backupExists, installed, version, entryCount, error, targetVersion, upgradable}`；版本号从 preload 文本用 `/\{v:(\d+)/` 读（508–513）。本机状态：`installed:true version:3 targetVersion:3`。
- CLI（`lib/bridge-cli.mjs`）：`status | check | install [--force] | restore [--force] | uninstall | bench`；`locate({explicit, argv:[], execPath})`；`check` 在活归档已打桥时改为对 `app.asar.orig` 构建（46–58），所以能验证"如果没装是否还能装"。
- 实测：`node lib/bridge-cli.mjs status` ⇒ 归档路径、`.orig` 存在、锁空闲、条目数 18309、**DSH 进程运行中（就地覆盖）**、桥状态 已安装 v3、目标 v3。

### A4. REQUIRED_SYMBOLS 与失败行为

- main `['ipcMain','BrowserWindow','dialog','assertDesktopSender','skipQuitConfirmation','app.quit']`；preload `['contextBridge','ipcRenderer']`（123–126）。
- 校验方式 = 在目标条目文本里 `includes` 每个符号；**缺一个就中止安装**，宁可"没有桥"也不要把主进程改坏（因为注入点若落在错版本的错误位置，主进程会直接起不来）。
- 其余失败面：`已经打过桥补丁`（MARKS 命中）、`替换后长度变化`（字节数变了）、`verify()` 失败（922–974：重算 sha256 必须等于 newHash、头部长度不变、新 hash 在头部文本里、`plain` 模式下旧 hash 必须消失）。

---

## B. 共存冲突（本插件最重要的一节）

### B0. 现场事实

1. 本机 main.js 的 dwc 注入块在条目内 byte **127,956**（第 3333 行）；preload 在 byte **3,451**（第 76 行）。
2. **dwc 自己的两个锚点文本在活文件里已经不存在了**（`probe4.mjs` 实测 MISS）。这正是 A3 里"等长替换摧毁锚点"的直接证据：dwc 能升级，是因为它先 `restore(.orig)` 再重注入。
   ⇒ 推论：**任何第三方对 dwc 锚点的占用都会打断 dwc 的原地升级路径**；反过来，**dwc 的 `restore` 会顺手抹掉我们的补丁**。所以"每次启动自愈"是硬要求（见 B4）。
3. 撞名风险（致命级）：dwc 在 main.js **模块顶层**声明 `const P="dsh-desktop:",DWC=[[...]]`。同一模块再写一个顶层 `const P` ⇒ `SyntaxError: Identifier 'P' has already been declared`，**整个主进程起不来**。我们的注入因此必须整段包在 `{ ... }` 块里（块级作用域），并使用不同标识符（草稿里的 `Z`/`R`/`S`）。

### B1. 安全区扫描结果（实测，行号取自导出的 `_lib_main.js.txt`）

方法：自写词法器（`probe2.mjs`，处理行/块注释、`'`/`"`/模板串（含 `${}` 嵌套）、正则字面量启发式）求"注释 + 空白"的极大连续段，char→byte，输出 `runs.json`。
**必须用词法器**：朴素正则会把 main.js 里 17,883 B 的"注释"当成安全区（byte 488,432），那是字符串里的 `/*`（证书主机名列表）。

- `/lib/main.js` 516,716 B / 13,183 行：43,189 个安全区。**最大 825 B**（第 3748 行），其余 795 / 780 / 728 / 702 / 657 / 640 / 634 / 621 / 611 / 573 / 571 / 563 / 554 …
- `/lib/preload-app.cjs` 41,075 B / 876 行：2,255 个安全区。**最大 305 B**（第 42–49 行），其余 293 / 287 / 278 / 247 / 236 / 225 / 197。单个块注释最大 234 B（第 57 行）。

⇒ **任务书假设的"main ≥1 KB ×2、preload ≥600 B"在本 DSH 构建上不成立**（真实上限 825 B / 305 B，而且 825 B 那个还不能用，见 B2）。设计必须按 main ≈700 B、preload ≈200–300 B 来做。

### B2. 语法安全性不是"看起来像注释"就够——必须实测

`probe3.mjs` 把注入代码等长塞进每个 ≥400 B 的候选区，再 `node --check`（只解析、不执行、不解析 import）判定：

- **FAIL**: byte 145960/825（第 3748 行）、251928/795、259448/640、312247/621、249774/611、239527/563、238400/554、335930/496、381759/487、245239/508、242355/502
- 825 B 那个的失败原因（决定性证据）：

```
_lib_main.js:3748  controlRequests = /* @__PURE__ */ new Map();{const Z="dsh-desktop:";...
SyntaxError: Unexpected token '{'
```

  即该区在 **class 体内部**（`constructor(...)` 的 JSDoc，第 3761 行是 `constructor(`）。同理，对象字面量/实参列表里的注释区也会 FAIL。

### B3. 推荐候选表（全部通过 `node --check`，锚点唯一、语句位置在模块顶层）

main.js（条目内字节偏移；绝对文件偏移 = 181,783,094 + byteStart）：

| 级别 | 锚点文本（唯一，搜索用） | 行 | byteStart | 块长 | 我们的代码 | 余量 | 上下文（前后） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **P1（首选）** | `/**\n* Zero-dependency atomic file replacement and writer coordination.` | 3293–3304 | 126252 | **709 B** | A=480 / B2=704 | 229 / **5** | 前：`Service.check;`(3290) `//#endregion`(3291) `//#region ../../packages/util/atomic-write/lib/index.js`(3292)；后：`const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set([`(3305) |
| P2 | `/**\n* Compare two raw configs, treating schema-declared volatile fields` | 3101–3109 | 119353 | 571 B | A=480 | 91 | 前：`}`(3100) 结束 `deepEqual`；后：`function equalExceptVolatile(previous, next, schema) {`(3110) |
| P3 | `/**\n* Resolve the single-root DeepSeek Harness home.` | 57–67 | 3062 | 534 B | A=480 | 54 | 前：`}`(56) 结束 `resolveRoot`；后：`function resolveDshHome(configured, env = process.env) {`(68) |
| (备) | `//#region ../../packages/util/atomic-write/lib/index.js` 起的整段 run | 3290–3304 | 126182 | 780 B | B=743 | 37 | 同 P1，但会连 `//#region` 标记一起吃掉 |

preload-app.cjs（绝对偏移 = 182,299,810 + byteStart）：

| 级别 | 锚点文本 | 行 | byteStart | 块长 | 代码 | 余量 | 上下文 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Q1（首选，纯 ASCII）** | `//#region lib/types/preload-platform.js` | 44–49 | 1846 | 段 290 B（含 `//#endregion` 的整 run 为 305 B @1832） | 196 | 94 | 前：`};`(42) 结束 `PLATFORM_IPC`；后：`function markDocumentPlatform() {`(50) |
| Q2 | `/**\n* Mirrors the window’s macOS and Windows fullscreen state`（正文含 U+2019 弯引号，锚点非 ASCII，注意 char/byte 换算） | 57–61 | 2368 | 234 B | 196 | 38 | 前：`function` 段语句边界；后：函数声明。`probe9` 已 splice + `node --check` 通过 |

风险与处置：

- 这些块都是 **JSDoc/`//#region` 注释**：运行时零成本，压缩器保留（rollup 产物保留 JSDoc 与 region 标记，实测存在），且没有任何代码路径读取注释文本 ⇒ 风险 = **仅文档丢失**（丢掉一段 JSDoc 说明 / 一个 region 折叠加）。
- 唯一"会被读取"的注释类型是 `//# sourceMappingURL=` —— 本归档 main/preload **都没有**，不用考虑。
- 右填充 = 普通空格，位于**语句序列中**（前一个语句已用 `;`/`}` 结束，后面紧跟 `const`/`function` 声明），`}` + 空格 + `const` 是合法空白，不产生语法噪音。**禁止**在填充里出现换行以外的非空白，也禁止补 `//`（会把后续代码注释掉）。
- 注入代码必须全 ASCII（`probe6/7/9` 都断言 `Buffer.byteLength(code) === code.length`：A=480、B2=704、preload=196）。

### B4. 全新机器（dwc 未装）与共存顺序

1. **不要复用 dwc 锚点**。dwc 的锚点 `/**\n* Replace \`filename\`...` 与 `/**\n* Watches \`html[data-ds-theme-source]\`` 属于它的预算区间（1000 B / 504 B），我们若占掉，dwc 之后装不上（且它的 `REQUIRED`/唯一性检查会直接失败）。我们的候选（B3 表）与 dwc 的落点各自独立：main 占 126,252（dwc 在 127,956，相距 1,704 B）；preload 占 1,846（dwc 在 3,451）。
2. 扫描策略：**只在"没被占用"的位置注入**——注入前先扫 MARKS（我们自己的 `window-bounds-set` / `dshResolution`）+ 检查目标块是否仍是原注释文本（锚点匹配即证明未被占用）。
3. 交叉破坏的真相：
   - dwc 升级 ⇒ `restore(.orig)` ⇒ 我们的补丁消失 ⇒ 我们的宿主半体在**同一次启动**里（1.5 s 后）发现 marker 不在并重注入，自愈。
   - 我们"卸载/还原"时**绝不能**用 `restore(.orig)` 覆盖，否则顺手抹掉 dwc ⇒ 我们只做"把自己的注入块换回原注释文本"（等长反向替换，注释原文写死在代码里），或用 `app.asar.orig` 重建后再按顺序重放所有已知补丁。
   - 备份文件 `.orig` **只共享一份**：存在就不碰（dwc 的 `backupFresh` 逻辑）；不存在才从当前归档复制，并在日志里注明"此 .orig 可能已含其它补丁"。
4. 我们的状态文件独立：`.dsh-plugin-resolution.json`（同 dwc 的 `statusFile()` 规则），字段建议 `{ok, archive, installed, version, targetVersion, markerFound, message, at}`。

---

## C. 客户端插件规范

### C1. 设置页注册（slot 树）

- 客户端包里 `lib/index.js` 是**宿主半体**（Cordis 插件），`lib/client.js` 是**浏览器半体**；`package.json` 的 `"dsh".client` 声明客户端清单。settings-general 的清单（package.json:32–46）：
  `{"platform":"web","inject":["@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-api-remotes","@deepseek-ai/dsh-client-ui-sidebar","@deepseek-ai/dsh-client-shortcuts","@deepseek-ai/dsh-client-modules","@deepseek-ai/dsh-client-ui-layout"]}`（包名！）。
- client.js 是 loader 包裹的工厂：`window.__ModuleLoader__.load({ id:"@deepseek-ai/dsh-client-ui-settings-general", factory:(require)=>{ ... exports.apply = apply; exports.inject = inject; return module.exports } })`，末尾 `//# sourceMappingURL=client.js.map`。**`exports.inject` 是 cordis 服务名**（`["slots","locale","connection","remote","remote.settings","configForms","shortcuts","modules"]`，client.js:1063–1072），与 package.json 里的包名列表是两码事。
- 设置对话框的**根**本身是一个 slot：settings-general 注册 `sidebar.settings`，`children` 声明了 `settings.launcher/trigger/header/action/close/section/onboarding`，其中 `"settings.section": { kind:"list", scope:"root" }`（client.js:1258）。
- **导航列表由 slot 条目推导**，不是硬编码菜单：`ctx.slots.entries("settings.section").map(e => ({id:e.options.id ?? "", order:e.options.order ?? 0, label: resolveSlotLabel(e.options.label) ?? ""})).sort((a,b)=>a.order-b.order)`，并 `ctx.slots.subscribe("settings.section", ...)` + `ctx.locale.subscribe(...)`（client.js:1138–1161）。
- 因此**新增一个设置页 = 向 `settings.section` 注册一条**。General 的原文模板（client.js:1293–1303）：

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section",
  id: "general",
  order: 0,
  label: () => t("general.nav"),
  locale: NS,
  children: { "settings.general.item": { kind: "list", scope: "root" } }
}, GeneralSection));
```

  dwc 的做法（`lib/client.js:1698–1720`，更短、无 children）：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name:"settings.section", id:"window-control", order:90, label:()=>strings().section }, () => React.createElement(Boundary,null,React.createElement(Panel,null))))`。
- 行的渲染惯例（settings-general client.js:620–640、690–724）：section 组件只是容器 `jsx('div',{className:css.section, children: renderSlot("settings.general.item", {})})`；行 = 标题 + 说明 + 右侧控件；`Switch` 来自 `@deepseek-ai/dsh-client-ui-primitives`；CSS 用 `<style data-plugin-css=...>` 注入；行样式 `padding:16px 0; borderBottom:1px solid var(--dsw-alias-border-l1)`。
- **我们必须做的防御**：用 class Boundary（`getDerivedStateFromError`）包住整节，渲染崩溃只坏一节而不是整个设置页（dwc client.js:1678–1696）。

### C2. locale 服务

- 服务名 `locale`，dwc 的用法（client.js:508–528）：

```js
if (!ctx || !ctx.locale || typeof ctx.locale.register !== 'function') return
ctx.locale.register(NS, { zh: ZH, en: EN })          // NS = 'dsh-window-control'
const translate = ctx.locale.bind(NS)                 // t(key) -> string
localeBound = new Proxy({}, { get: (_, k) => translate(String(k)) })
```

- 双语文典结构 = `{ zh: {k:'…'}, en: {k:'…'} }` 扁平字典（dwc 里 ZH/EN 是常量对象，key 如 `section`、`intro`、`windowGroup`）；settings-general 则是 `ctx.effect(() => ctx.locale.register(NS,{zh,en}), "ui-settings-general: dictionaries")` + `const t = ctx.locale.bind(NS)`（client.js:1095–1098、1113），section 上再带 `locale: NS` 让导航标签也能翻译。
- 包内 `locale/en.json`、`locale/zh.json` 只服务插件市场的清单文案（settings-general 的 en.json 仅 55 B ≈ `{}`），**不是**运行期字典。
- 降级：dwc `strings()`（client.js:486–494）在 `ctx.locale` 不可用或 `navigator.language` 非 zh 时用内置英文；CSR 场景永远不抛。

### C3. 设置持久化

- **没有**通用的"客户端设置存储 service"。可用面：`localStorage`（页面 origin 为 `dsh-app://app`，持久）；或走宿主插件的 `Config`（schemastery）+ `configForms`/`remote.settings` 表单行。
- 已装插件的实际选择（实测 grep）：
  - `dsh-window-control`：`var CFG_KEY='dsh-window-control:settings'`（client.js:42）；`readConfig()` = `JSON.parse(localStorage.getItem(CFG_KEY))` → `normalizeConfig`（134–141）；`writeConfig(next)` = `setItem` + `dispatchEvent(new CustomEvent('dsh-window-control:changed',{detail:next}))`（143–154）；默认值 `DEFAULT_CFG`（71–80）。
  - `dsh-better-sidebar`：同样 localStorage（12 处），如 `localStorage.setItem(\`${STORAGE_PREFIX}:${sessionId}\`, …)`。
  - `dsh-plugin-wallpaper-engine`：localStorage 94 处。
  - `dsh-task-progress`：0 处 localStorage（它只有宿主侧状态/事件）。
- 结论：**本插件用 localStorage 单一真源**（boot 时同步可读，这是启动即生效的前提），key 建议 `dsh-plugin-resolution:settings`，值 `{mode:'preset'|'custom'|'off', width, height, center:true}`；写入后 `window.dispatchEvent(new CustomEvent('dsh-plugin-resolution:changed',{detail}))` 让设置页与启动逻辑共享。

### C4. 启动时机与启动应用逻辑

- `dsh.client.immediately` 的**真实语义**（证据：`/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-CN7NIWNw.js`）：

```js
async prefetchImmediateTier(){ await Promise.all(this.manifest.plugins.filter(e=>e.immediately).map(e=>this.modules.prefetch(e.id).catch(()=>{}))) }
```

  ⇒ 它只影响**启动档预取**（把该插件的客户端 bundle 提前下载/解析），不是"激活"。清单侧只是透传与校验：`dsh-client-modules/lib/client.js:68,140`（`plugins.push({id, inject, immediately: row.immediately === true})`）、`lib/index.js:69,408,745`。**我们的启动应用逻辑必须在模块 `apply()` 里跑（与是否 immediately 无关），并自带重试。**
- dwc 的启动逻辑（client.js:648–739，`applyStartMode()`），可直接照抄骨架：

```
读 cfg；!enabled || startMode==='off' ⇒ 返回 noop
run():
  cfg 变了（用户中途改） ⇒ 停
  桥在 ⇒ refreshState() → 若 fullscreen 冲突先退出 → 应用目标形态 → 已收敛则停，否则 attempts<10 时 setTimeout(run, 400)
  桥不在 ⇒ attempts<3 时 setTimeout(run, 600)      // 注释：「桥不可能在本次运行中出现（它需要重启才生效）」
返回 cleanup: stopped=true; clearTimeout
```

  桥访问器（client.js:160–175）：`window.dshWindowControl`（要求存在 `state` 且 `setMaximized`）→ 否则 `window.dshDesktop.windowControl` → 否则 `null`。
- 我们的时序：页面加载（`dsh-app://app`）→ `apply()` 读 localStorage → 有桥 ⇒ `setBounds(...)`（第一次常常在窗口 `show` 之前，效果就是"启动即目标尺寸"）→ 200–400 ms 重试 3–5 次以防主进程尚未 ready → 收敛后停。无桥 ⇒ 记 `:nobridge` 计数（localStorage + sessionStorage 各一份，dwc 同款 54–57），设置页显示"需重启 DSH 生效"卡片。

---

## D. 宿主插件规范

### D1. `apply(ctx, config)` / Config / profile patch

- 入口形状（settings-general `lib/index.js`，14 行全文）：

```js
import z from "@deepseek-ai/schemastery";
const Config = z.object({ welcomeNoticeVersion: z.string().volatile() });
function apply(ctx) { ctx.inject(["settings"], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)); }); }
export { Config, apply };
```

- 带真实字段的 Config 例子（`$PROFILE/node_modules/dsh-better-sidebar/lib/index.js:126–130`）：`const Config = z.object({ ...LimitsSchema.dict, ...volatilePrefs })`，其中 `volatilePrefs` 由每个字段 `.volatile()` 得到（volatile = 变更时不触发整树重载）；文件末尾 `export { Config, FS_TREES_MAX_PATHS, apply, contentInjectionOf…, inject, name }`（9386）。schemastery 必须用宿主提供的 `@deepseek-ai/schemastery`，不要引公共包（better-sidebar 注释 57 行明说）。
- dwc 的 `apply`（`lib/index.js:317–337`）**不导出 Config**（config 靠约定读 `options.autoInstall === false`），主体：

```js
export function apply(ctx, config) {
  const options = config && typeof config === 'object' ? config : {}
  const disabled = options.autoInstall === false
  try {
    ctx.effect(() => {
      const timer = setTimeout(() => { const task = disabled ? rollbackOnce(ctx) : runOnce(ctx); void task.catch(...) }, START_DELAY_MS /* 1500 */)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearTimeout(timer)
    })
  } catch (error) { emit(ctx, 'warn', '注册启动自检失败: ' + describe(error)) }
}
export default apply
```

  日志：`ctx.logger('dsh-window-control')`，取不到就退回 `console.log/warn`（`emit()`，`lib/index.js:100–126`）。**注意 `ctx.effect` 的返回值是 disposer，别在 effect 里 await 长任务。**
- profile patch 覆盖：`$PROFILE/cordis.patch.yml` 是**按 id 覆盖**的 YAML 数组，例：

```yaml
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-08-13.1
- id: dsh-opencode-go-usage
  disabled: true
```

  ⇒ 用户可在不改包的情况下 `config:`（进 Config schema）/`disabled: true` 关掉我们的自愈逻辑（建议暴露 `autoInstall: boolean`、`presets: string[]`）。
- `ctx.tools` 等注入：本轮**未采样**（不在五个问题范围内），需要时读 `$ASAR/dsh/node_modules/@deepseek-ai/dsh-tools/lib/*` 或已装 `dsh-ops` 的 `lib/index.js` 找 `ctx.tools.register` 的写法。

### D2. 宿主半体怎么拿到 app.asar 真实路径

- 宿主半体是 `dsh-desktop-host` 子进程（Electron `ELECTRON_RUN_AS_NODE`），**没有 BrowserWindow**，因此"应用尺寸"必须经 IPC 由渲染端触发；宿主只负责**确保补丁在位**。
- dwc 的做法：`lib/index.js:166` `const found = module.locate()`，失败时把 `{argv: process.argv.slice(0,8), execPath: process.execPath, platform, localAppData, fsSource, candidates}` 写进状态文件（`runOnce()`，157–205）。
- `locate()`/`candidates()`（asar-bridge.js:190–286）的候选顺序，抄关键几行：

```js
push(options.explicit); push(process.env.DSH_ASAR)
const runtimeDir = argv[2]                      // 形如 <res>\app.asar\dsh 或 <res>\app.asar.unpacked\dsh
for (let level = 0; level < 5; level += 1) {    // 逐级向上找同名 app.asar
  push(path.join(dir, 'app.asar'))
  if (path.basename(dir) === 'app.asar') push(dir)   // ← 本机就是这条命中
  const up = path.dirname(dir); if (up === dir) break; dir = up
}
const root = path.dirname(execPath)
push(path.join(root, 'resources', 'app.asar')); push(path.join(root, 'app.asar')); push(path.join(root, '..', 'Resources', 'app.asar'))
if (process.platform === 'win32' && process.env.LOCALAPPDATA) push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
```

  每个候选都是"能 `openSync('r')` 且能解析头部"才算命中（`locate()` 269–286）。本机 `process.argv[2]`（运行时目录）= `C:\Users\zarak\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh`（DSH 自己的运行时上下文就是这么报的），所以 `basename === 'app.asar'` 分支命中，`execPath` 分支也命中 `…\resources\app.asar`。
- 不要用 `process.resourcesPath`（只有真 Electron 主进程才有）。

### D3. `dsh plugin add` / profile 清单 / 手动安装

- CLI 存在但**不在 PATH**（`which dsh` 无输出）。入口 `@deepseek-ai/dsh/lib/bin.js`（254 行，`"bin":{"dsh":"lib/bin.js"}`，描述 "dsh CLI: profile launch, plugin management, and configuration inspection"）。
- `dsh plugin` 的语义 = **把参数原样转发给 profile 目录里的 pnpm**（bin.js:115–120）：

```js
program.command("plugin").description("manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory")
  .passThroughOptions().requiredOption("--profile <name>", ...).allowUnknownOption()
  .argument("[args...]", "pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)")
if (!manageDesktopProfile) rejectElectronProfile(plugin, options.profile)
```

  且 bin.js:35–37：`if (profile.toLowerCase() === "desktop") program.error('error: profile "desktop" is managed exclusively by the Electron application')` ⇒ **终端里 `dsh plugin --profile desktop add …` 会被拒绝**；只有 Electron 载体（`manageDesktopProfile=true`，即应用内插件市场/插件管理器界面）才能改 desktop profile。帮助示例：`dsh plugin --profile tui add <package>`。
- 实际执行 `runProfilePnpm(context,args,options)`（`@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:299+`）：加 `package.json` 文件锁（`lockWaitMs:12e4`）、把 pnpm 日志写进 `.plugin-manager/logs/operation-*/pnpm.log`、失败时用快照原子回滚 `package.json`/`pnpm-lock.yaml`。
- **`dependencies` 与 `dsh.profile.bundles` 的区别（决定性）**：
  - `dependencies` 只表示"装进了 node_modules"；`dsh.profile.bundles` 才是"挂载成 Cordis 层"。
  - 组合引擎 `loadProfileDirectory()`（`@deepseek-ai/dsh-app-boot/lib/index.js:1015–1051`）按 `dsh.profile.bundles` 顺序逐包解析目录、读该包 `dsh.bundle.patch` 指向的 patch 文件（字符串或字符串数组，517–530）、并入层；**列在 bundles 里但没声明 `dsh.bundle` ⇒ 报 `profile bundle "x" declares no dsh.bundle in its package.json`**；失败被收集进 `skippedBundles`（静默跳过，不炸启动）。profile 自己的 `cordis.patch.yml` 是最后一层用户覆盖（1041–1042）。
  - `reconcileProfilePlugins()`（appboot.js:1209–1228）会**把声明了 `dsh.bundle` 的依赖自动追加进 bundles**（插件管理器安装/卸载流程调用，boot 不调用），并回报 `enabled: bundles.includes(name)`。
  - 现场验证：`$PROFILE/package.json` 的 dependencies 里有 `dsh-window-control: "1.4.2"`，但 bundles 列表里**没有它** ⇒ 它的 bundle patch 未挂载（于是它的宿主半体根本没跑；`.dsh-window-control.json` 时间戳 2026-10-26T16:15:38Z 也印证）。但它的 asar 补丁仍在磁盘上 —— **补丁与插件启停是两件独立的事**（正好是我们想要的容错形态：插件被禁用时窗口通道依然可用）。
- 手动安装可行（我们开发期就用这条路）：把包目录放到 `$PROFILE/node_modules/<name>`（或直接 `link:` 本地路径，先例 `dsh-startup-secret": "link:C:/Users/zarak/.dsh/local-plugins/dsh-startup-secret"`）→ 在 `package.json` 的 `dependencies` 加条目 → 在 `dsh.profile.bundles` 末尾加包名 → 重启 DSH。**不需要** `pnpm install`（除非我们的包有第三方运行期依赖；pnpm-workspace 是 `nodeLinker: hoisted`、`autoInstallPeers: false`）。改 `package.json` 前先备份，别在 DSH 运行时改（组合在启动时读一次）。

---

## E. IPC 与 API 契约

### E1. 通道设计（预算驱动）

- main.js 里 **`screen` 没有 import**（第 5 行的 electron 具名 import 列表里没有），要用就在用到时 `createRequire(import.meta.url)("electron").screen`（`createRequire` 在 main.js 第 1 行已 import；同款先例：main.js:5872 `const { version } = createRequire(import.meta.url)("../package.json")`）。**必须在 app ready 之后取值**，所以放在 handler 内部而不是模块顶层。
- `assertDesktopSender(event, hostnames)` 声明在 main.js:7000–7005（`function` 声明 ⇒ 提升，可被更早的顶层注入调用）：`senderFrame === null` ⇒ `dsh desktop: rejected IPC without a sender frame`；`url.protocol !== 'dsh-app:'` 或 hostname 不在白名单 ⇒ `dsh desktop: rejected IPC from an unowned renderer`。
- 现成 IPC 里**没有**通用 invoke 桥（preload 只暴露固定方法：`dshWindowControl`(dwc)、`dshOnboarding`、`__DSH_DIRECTORY_PICKER__`、`__DSH_HOST_PATHS__`、`dshDesktopBoot`、`dshPlatform{open,setBounds,close}`、`dshDesktop`、`__DSH_LOCALE__`；`_lib_preload-app.cjs.txt:76,837–870`）。
  **不能复用** `dshPlatform.setBounds`：它走 `PLATFORM_IPC.bounds = "dsh-platform:bounds"`（main.js:6692–6696），handler 在 main.js:12472–12475 是 `platformView.setBounds(platformBounds(bounds))` —— 那是 WebContentsView，不是 BrowserWindow。

### E2. 注入代码草稿（已实测字节数与 `node --check`）

**preload（196 B ASCII，落 Q1/Q2 均可）**：

```js
if(location.protocol==="dsh-app:"&&process.isMainFrame){electron.contextBridge.exposeInMainWorld("dshResolution",{v:1,setBounds:b=>electron.ipcRenderer.invoke("dsh-desktop:window-bounds-set",b)})}
```

**main 变体 A（480 B ASCII；居中/钳制在渲染端算，main 只应用绝对 bounds；落 P1 余量 229 B）**：

```js
{const Z="dsh-desktop:";ipcMain.removeHandler(Z+"window-bounds-set");ipcMain.handle(Z+"window-bounds-set",(e,v)=>{assertDesktopSender(e,["app"]);if(e.senderFrame!==e.sender.mainFrame)throw new Error("rsz: sender");const w=BrowserWindow.fromWebContents(e.sender);if(!w||w.isDestroyed())throw new Error("rsz: nowin");if(w.isFullScreen())w.setFullScreen(false);if(w.isMaximized())w.unmaximize();w.setBounds({x:v.x|0,y:v.y|0,width:v.width|0,height:v.height|0});return w.getBounds()})}
```

**main 变体 B2（704 B ASCII；main 自己用 `screen` 居中 + 工作区钳制；落 P1 余量仅 5 B —— 首选仍给它是因为"权限在 main"更稳，但改动任何字符都会溢出，改代码请改用 P1 的 780 B 整段 run 或 P3 + 缩字）**：

```js
{const Z="dsh-desktop:";ipcMain.removeHandler(Z+"window-bounds-set");ipcMain.handle(Z+"window-bounds-set",(e,v)=>{assertDesktopSender(e,["app"]);if(e.senderFrame!==e.sender.mainFrame)throw new Error("rsz: sender");const w=BrowserWindow.fromWebContents(e.sender);if(!w||w.isDestroyed())throw new Error("rsz: nowin");w.setFullScreen(false);w.unmaximize();const a=createRequire(import.meta.url)("electron").screen.getDisplayMatching(w.getBounds()).workArea,W=Math.min(Math.max(v.width|0,520),a.width),H=Math.min(Math.max(v.height|0,600),a.height),b=w.getBounds();w.setBounds({x:v.center===false?b.x:a.x+((a.width-W)>>1),y:v.center===false?b.y:a.y+((a.height-H)>>1),width:W,height:H});return w.getBounds()})}
```

实现要点：

- 整段包在 `{ }` 里（避免与 dwc 顶层 `const P`/`DWC` 撞名）；我们的幂等标记 = `"window-bounds-set"`（main/preload 都能搜到）/ `"dshResolution"`（preload）。
- `w.setFullScreen(false)` 在非全屏时是 no-op；`w.unmaximize()` 对已还原窗口也是 no-op ⇒ 省掉 `isFullScreen()/isMaximized()` 两个判断（B2 就此省 47 B）。
- `v.x|0` 把 undefined/NaN 收敛成 0；DIP 单位（Electron `setBounds` 用 DIP）。
- `win32` 注意点：外框尺寸受 `minWidth/minHeight`（main.js:11920 `createWindow()` = `width:1280, height:820, minWidth:520, minHeight:600`）与 **onboarding 期 960** 约束（main.js:12514–12522：`window.setMinimumSize(active ? 960 : 520, 600)`，且 active 时若 `width < 960` 会 `setSize(960, height)`）。⇒ 我们的钳制下限用 **520×600**（B2 已内置），但 onboarding 期间实际会被系统抬到 960 宽；预设最小 1280×720 不受影响。
- 无框/自绘标题栏（win32 primary 用 `titleBarStyle:"hidden"` + `titleBarOverlay:{height:40}`）不影响 `setBounds`（外框语义）。
- 应用侧还要"取消最大化/全屏"：B2 已做；变体 A 也做了。全屏与最大化互斥（Electron 全屏先退出再 unmaximize 是安全的顺序）。

### E3. 建议的通道契约

请求（`dshResolution.setBounds(req)` → `ipcRenderer.invoke("dsh-desktop:window-bounds-set", req)`）：

```ts
{ width: number; height: number; center?: boolean; x?: number; y?: number }
```

- `width/height` 必填，DIP，正整数；`center` 缺省 `true`；`x/y` 仅在 `center === false` 时生效（缺省 = 保持当前位置）。
- 钳制规则（main 侧权威，B2 实现）：`W = clamp(width, 520, workArea.width)`、`H = clamp(height, 600, workArea.height)`、`x = workArea.x + ((workArea.width - W) >> 1)`、`y = workArea.y + ((workArea.height - H) >> 1)`；`workArea` 取 `screen.getDisplayMatching(w.getBounds()).workArea`（当前屏）。
- 返回：`BrowserWindow.getBounds()` 的**实际**结果 `{x,y,width,height}`（Electron/BrowserWindow 可能因最小尺寸再调整，所以以返回值为准，客户端把它回写进设置页状态）。
- 错误码（抛 `Error` 的 message，渲染端 catch 后按前缀识别；沿用 dwc 的短码风格）：

| message | 含义 |
| --- | --- |
| `rsz: sender` | `senderFrame !== sender.mainFrame`（子帧调用） |
| `rsz: nowin` | `BrowserWindow.fromWebContents` 为 null 或已销毁 |
| `dsh desktop: rejected IPC without a sender frame` / `... from an unowned renderer` | `assertDesktopSender` 拒绝（非 `dsh-app://app`） |
| 桥缺失（客户端侧） | `window.dshResolution` 不存在 ⇒ 非桌面环境或未打补丁 ⇒ **静默跳过**，只在设置页显示"需重启 DSH"提示 |

- 非桌面环境：`dshResolution` 不存在即可判定，不抛错、不写日志噪音（spec 要求静默跳过）。

---

## F. 未确认 / 需最小验证

1. `main.js` 里 `process.argv[2]` 的真实值（DSH 运行中无法读进程命令行：`Get-CimInstance Win32_Process` 在沙箱下被拒绝）。
   - 现有旁证：本会话运行时上下文自报 checkout = `…\resources\app.asar\dsh`，且 `locate()` 的 `basename === 'app.asar'` 分支正好命中。
   - 最小验证：写一个临时宿主插件，在 `apply()` 里 `console.log(JSON.stringify({argv:process.argv.slice(0,8),execPath:process.execPath}))`，看 DSH 日志。
2. `ctx.tools` 等注入 API（D1 第四问）本轮未采样。最小验证：`node extract.mjs cat dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js | grep -n "ctx.tools\|register"`。
3. 客户端 `remote.settings`/`configForms` 表单化配置的确切 API（若想不用 localStorage 而用宿主 Config 驱动设置页）。最小验证：`grep -n "configForms\|remote.settings" dsh__node_modules__@deepseek-ai__dsh-client-ui-settings-general__lib__client.js`。
4. 我们的包若声明 `dsh.bundle.patch`，`reconcileProfilePlugins` 会自动把它加进 bundles；但如果用户先在 `cordis.patch.yml` 手工挂过一遍，会**双挂载**（两个宿主半体）——better-sidebar 的 patch 注释明确警告过这一点，照抄它的 `!!js` disabled 守卫写法。

---

## G. 实现清单

```
dsh-plugin-resolution/
  package.json          # type:module, exports {".":lib/index.js,"./client":lib/client.js},
                        # dsh:{manifestVersion:1,
                        #      bundle:{patch:'./cordis.patch.yml'},
                        #      client:{platform:'web',immediately:true,
                        #              inject:['@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-locale']}},
                        # engines:{node:'>=20',dsh:'>=0.2.0-rc.2'}
  cordis.patch.yml      # - insert: [{id: dsh-plugin-resolution, name: dsh-plugin-resolution}]
  lib/index.js          # host: apply(ctx,config) + Config(schemastery) + 1500ms 自愈注入 + 状态文件
  lib/bridge/asar.js    # 从 dwc asar-bridge.js 裁剪：header/entry/integrity/lock/backup（≈MIT，注明出处与版本）
  lib/bridge/patch.js   # 我们的 TARGETS/MARKS/ANCHORS/CODE/REQUIRED_SYMBOLS（B3 表 + E2 代码）
  lib/bridge/cli.mjs    # status|check|install|restore（与 dwc 同构，便于排障；bin: dsh-resolution-bridge）
  lib/client.js         # 设置节 settings.section(order≈95) + localStorage + boot 应用 + 重试 + Boundary
  locale/en.json, locale/zh.json
```

注入器算法（与 dwc 1:1，只换常量）：

1. `locate()` 找归档（候选表见 D2）→ 读头 → `dataStart`。
2. 读 entry 字节 → 若 MARKS 命中：`installed`（幂等，直接 status）。
3. 校验 `REQUIRED_SYMBOLS`（main: `ipcMain/BrowserWindow/assertDesktopSender`；preload: `contextBridge/ipcRenderer`）。
4. 逐候选锚点：唯一命中 → 算 `[anchorStart, first "*/"+2)` 的字节区间 → `padding = 区间 - code.length` ≥ 0 → 载荷 `code + ' '.repeat(padding)`。
5. 重算 sha256 → 改头部两处 hex（`plain`/`offset` 两模式）→ `verify()`（重建 + 比对）。
6. `.orig` 不存在才备份；加锁；DSH 运行中就地 `writeSync`+`fsync`，否则临时文件 + `renameSync`。
7. 失败一律回滚；成功写状态文件并提示"重启 DSH 后生效"。

# DSH 窗口分辨率插件（dsh-window-resolution）

<a id="zh"></a>

## 中文

[English](#en)

为 DeepSeek Harness（下称 DSH）桌面端提供可自定义的**窗口分辨率**：在设置页选择**预设分辨率**或输入**自定义分辨率**，**即改即用**，并在每次 DSH 启动时**强制应用**。插件同时支持「关闭」——选择关闭后，插件不再调整主窗口。

> 窗口分辨率指主窗口**外框**宽×高（逻辑像素），不含 DPI 缩放与全屏渲染差异。

### 功能

- **预设分辨率 6 档**：1280×720、1366×768、1600×900、1920×1080、2560×1440、3840×2160。
- **自定义分辨率**：宽、高各取 200–16384 之间的整数。
- **关闭**：不调整窗口（默认值，安装后不会擅自改窗口）。
- **即改即用**：设置页选中或输入后立即生效，并用主进程回读的**实际**尺寸回显——被**钳制**时看到的就是真实结果。
- **每次启动强制应用**：按保存的配置，先取消最大化/全屏（等待窗口状态迁移，400ms 兜底超时），再按当前屏幕**可用工作区钳制**目标尺寸，最后在当前屏幕居中。启动瞬间窗口可能先按上次状态出现，随后 snap 到设定尺寸（一次轻微闪烁）。
- 配置保存在当前 profile 的 `localStorage`；改动会广播到同页其他分区，宿主启动时按同一份配置应用。

### 与 `dsh-window-control` 共存

本插件可以与 `dsh-window-control`（下称 dwc）同时安装：

- 两者向 `app.asar` 注入的是**各自独立**的载荷，锚点用候选数组，写入前校验目标符号；本插件会跳过 dwc 已占用的字节区间（`DWC=[[` / `dshWindowControl`），绝不会覆盖 dwc 的代码。
- 本插件使用**自己的**回滚边车（`.dsh-window-resolution.restore.json`），**绝不动** `app.asar.orig`——那是 dwc 的备份，用它还原会连带抹掉 dwc 的注入。
- 若两个插件都想控制窗口尺寸，实际生效的是**后应用者**：dwc 在启动早期介入，本插件在页面加载后强制应用，因此启动尺寸以本插件为准；随后手动调整窗口不受影响。

### 安装

#### 前置条件

- DSH **桌面端**（Electron）。浏览器标签页里的 DSH 无法调整窗口，插件会自动降级（见下文）。
- 注入器需要读写 `resources/app.asar`；Windows 上它通常位于 `Program Files`，首次注入可能需要**提权**。
- 运行 CLI 需要 Node.js ≥ 20。

#### 1. 把插件装进 profile

在 DSH 的插件安装对话框里填包名或本地路径，或使用 CLI（`dsh plugin add` 后面跟包名、Git 地址、压缩包或本地绝对路径）：

```bash
dsh plugin add dsh-window-resolution             # npm 发布后：包名
dsh plugin add C:/path/to/dsh-window-resolution  # 未发布时：本地绝对路径
```

手动方式：在 `~/.dsh/profiles/<profile>/package.json` 里把 `"dsh-window-resolution": "link:C:/path/to/dsh-window-resolution"` 加进 `dependencies`、把 `"dsh-window-resolution"` 加进 `dsh.profile.bundles`，再在该 profile 目录执行 `pnpm install`，然后重启 DSH 让插件加载。

#### 2. 注入窗口通道

在插件目录（本地路径安装时就是仓库根；从 profile 安装时是 `~/.dsh/profiles/<profile>/node_modules/dsh-window-resolution`，`link:` 安装则指向源目录）执行：

```bash
node lib/bridge-cli.mjs status              # 只读：归档路径、注入状态、dwc 共存、锚点与预算
node lib/bridge-cli.mjs install --dry-run   # 只打印偏移与字节预算，不落盘
node lib/bridge-cli.mjs install             # 真注入（建议先退出 DSH）
```

- 建议先退出 DSH 再注入，避免归档被占用；注入器也会在 DSH 运行时就地写入、已退出时原子替换。
- Windows 报 `not-writable` 表示没有写权限：用管理员终端重跑（注入期间保持 DSH 退出）。
- 首次注入后需要**两次重启 DSH**（见下）。

宿主半体在每次启动时也会自检：未注入就自动注入，载荷版本过期就还原旧载荷后重注；自检失败只写状态文件，不阻塞 DSH 启动。因此手动 `install` 不是必须的，但它能立刻给出错误码与退出码，推荐首次安装时执行。

#### 3. 两次重启

注入写的是 DSH 正在运行的 `resources/app.asar`，新字节要到下一次进程启动才被加载：

1. **第一次重启**：DSH 加载注入后的 `app.asar`，`window.dshWindowResolution` 通道就位。
2. **第二次重启**：验证启动自检幂等（已是最新时只更新状态文件、不重复写归档），此后每次启动都按配置**强制应用**。

只重启一次时，设置页可能仍显示「窗口通道尚未注入」；这不是安装失败。

#### 4. 验证

```bash
node lib/bridge-cli.mjs status   # 期望「状态：已注入」，退出码 0
node lib/bridge-cli.mjs check    # 期望「自洽：是」
```

设置页的「窗口分辨率」分区应显示「窗口通道已就绪」；选择一档预设，窗口立即变化。

### 使用

打开 DSH 设置 → 「窗口分辨率」分区：

- 选择一档**预设分辨率**，或切到**自定义分辨率**输入宽高（200–16384 的整数，输入防抖 400ms）。
- 选择「关闭」后插件不再调整窗口，重启也不会应用。
- 状态行显示最近一次应用结果与实际尺寸；`invalid` 在输入框内联提示，`rejected` 展示桌面端返回的原文。

### 卸载

**顺序不能反：先还原 `app.asar`，再移除插件。**

1. 退出 DSH。
2. 在插件目录还原注入（`uninstall` 内部会先 `restore`，再删除状态文件；还原失败时不会谎报卸载成功，退出码非 0）：

   ```bash
   node lib/bridge-cli.mjs uninstall
   ```

   也可以先单独执行 `node lib/bridge-cli.mjs restore` 确认还原，再移除插件。
3. 移除插件：在 DSH 插件管理里移除，或从 profile 的 `package.json` 删除 `dependencies` 与 `dsh.profile.bundles` 里的 `dsh-window-resolution` 条目后重新安装依赖、重启 DSH。
4. 复核：`node lib/bridge-cli.mjs status` 应显示「未注入」（退出码 2）。

先移除插件会失去插件自带的还原入口，`app.asar` 里的注入字节会残留；此时需要重新拿到插件（或同版本源码）再执行 `restore`。不要在缺少回滚边车时手改 `app.asar` 字节。

### 风险与降级

| 场景 | 行为 |
| --- | --- |
| DSH 升级 | DSH 升级会整包替换 `resources/app.asar`，注入随之失效。下次启动宿主自检会重注；若锚点/符号漂移，自检失败并写入状态文件 `ok:false`，设置页提示「通道尚未注入」，重跑 `install` 即可。 |
| 浏览器标签页 / 非 Electron 环境 | 通道整体缺席，插件**静默降级**：设置页显示「非桌面端」静态提示，不报错、不重试注入；选择仍会保存，等下次在桌面端启动时应用。 |
| 注入失败（锚点找不到、无写权限、归档不一致） | 只记录状态与日志，**不阻塞 DSH 启动**；窗口保持 DSH 默认尺寸。 |
| 载荷版本过期 | `install` / 启动自检会先用回滚边车还原旧载荷，再按当前载荷重注（报告 `reinstalled: true`）。 |
| 只注入了一半 | `install` 报 `inconsistent`：先 `restore --force`，再 `install`。 |
| 回滚边车丢失但已注入 | `restore` 报 `no-state`，此时**不要手改字节**；重装 DSH 桌面端恢复干净归档。 |
| 目标尺寸大于当前工作区 | 按工作区**钳制**，返回并回显实际尺寸，不会越界。 |
| 写入需要提权 | Windows `Program Files` 下首次注入可能被拒（`not-writable`）：管理员终端重试。 |

已知限制：仅调整主窗口**外框**尺寸，不改 DPI/系统缩放，不控制辅助窗口（欢迎窗、更新遮罩等），不做多窗口与 per-project 配置；启动应用发生在页面加载之后，接受一次轻微闪烁。

### 命令行速查

在插件目录执行 `node lib/bridge-cli.mjs <命令> [app.asar] [--dry-run] [--force]`：

| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `status` | 只读：归档路径、DSH/载荷版本、注入状态、dwc 共存、锚点与字节预算 | `0` 已注入；`2` 未注入或归档不一致；`1` 失败 |
| `check` | 只读：校验归档自洽（哈希、半注入）；未注入时报告可否安装 | `0` 已注入且自洽；`2` 未注入；`1` 发现问题 |
| `install` | 注入；载荷过期时先还原再重注；`--dry-run` 只报告不落盘；`--force` 强制重注 | `0` 成功/已是最新；`1` 失败 |
| `restore` | 用回滚边车精确还原；`--force` 跳过哈希校验（不碰 dwc 的 `app.asar.orig`） | `0` 已还原；`2` 未注入无事可做；`1` 失败 |
| `uninstall` | 先 `restore`，再删状态文件 | `0` 已还原；`2` 未注入无事可做；`1` 还原失败 |
| `self-heal` | 启动自检：未注入或载荷过期就注入，已最新只更新状态文件 | `0` 通过；`1` 失败 |

- 归档路径可以放在命令后；也可用环境变量 `DSH_WINDOW_RESOLUTION_ASAR`（或 `DSH_ASAR`）覆盖自动定位。
- 退出码约定：`0` 成功/已注入，`1` 失败，`2` 未注入（`status`/`check`）或无事可做（`restore`/`uninstall`）。

### 文档

- [`CHANGELOG.md`](CHANGELOG.md)：版本记录

### 开发

```bash
node --test          # 单元测试（Node.js >= 20）
npm pack --dry-run   # 核对发布物清单
```

### 许可证

[MIT](LICENSE)

---

<a id="en"></a>

## English

[中文](#zh)

Give the DeepSeek Harness (DSH) desktop app a custom **window resolution**: choose a **preset** or enter a **custom resolution** in Settings and it applies immediately, then is **force-applied** on every DSH launch. An "Off" option leaves the window alone.

> Window resolution is the main window's **outer frame** width × height in logical pixels, independent of DPI scaling and fullscreen rendering differences.

### Features

- **Six presets**: 1280×720, 1366×768, 1600×900, 1920×1080, 2560×1440, 3840×2160.
- **Custom resolution**: width and height are integers from 200 to 16384.
- **Off**: never touch the window (the default, so installing the plugin alone changes nothing).
- **Immediate apply**: selecting or typing a size takes effect at once, and the actual bounds read back from the main process are echoed — a **clamped** result is what you see.
- **Force-apply on every launch**: leaving fullscreen and un-maximizing first (waiting for the window state transition, with a 400 ms fallback timeout), then **clamping** to the current screen's work area and centering on that screen. The window may appear at its previous size for an instant before snapping (one brief flicker).

### Coexistence with `dsh-window-control`

This plugin can be installed alongside `dsh-window-control` (dwc):

- Both inject **separate** equal-length payloads. Anchors are tried from a candidate list and validated against target symbols before writing; this plugin skips the byte ranges dwc already owns (`DWC=[[` / `dshWindowControl`) and never overwrites dwc's code.
- This plugin uses **its own** rollback sidecar (`.dsh-window-resolution.restore.json`) and **never** touches `app.asar.orig` — that is dwc's backup, and restoring from it would also wipe dwc's injection.
- If both plugins want to control the window size, the last one to run wins: dwc acts early in startup and this plugin force-applies after the page loads, so the launch size comes from this plugin.

### Installation

**Requirements:** the DSH desktop app (Electron); write access to `resources/app.asar` (on Windows it usually lives under `Program Files`, so the first injection may need elevation); Node.js ≥ 20 for the CLI.

**1. Install the plugin into a profile.** Use the DSH plugin install dialog, or the `dsh plugin add` CLI with a package name, Git URL, tarball, or absolute local path:

```bash
dsh plugin add dsh-window-resolution             # package name (once published)
dsh plugin add C:/path/to/dsh-window-resolution  # local absolute path
```

Or edit `~/.dsh/profiles/<profile>/package.json` directly: add `"dsh-window-resolution": "link:C:/path/to/dsh-window-resolution"` to `dependencies` and `"dsh-window-resolution"` to `dsh.profile.bundles`, then run `pnpm install` in the profile directory and restart DSH.

**2. Inject the window channel.** From the plugin directory (the repo root for a local install, or `~/.dsh/profiles/<profile>/node_modules/dsh-window-resolution`):

```bash
node lib/bridge-cli.mjs status              # read-only: archive, injection state, dwc, anchors
node lib/bridge-cli.mjs install --dry-run   # print offsets and byte budget, write nothing
node lib/bridge-cli.mjs install             # inject (quit DSH first)
```

`not-writable` means you need an elevated terminal on Windows. The host half also self-heals on every launch (inject if missing, restore-and-reinject when the payload version is stale) and never blocks DSH startup on failure, so the manual `install` is optional but gives you error codes and exit codes right away.

**3. Restart DSH twice.** Injection writes into the `app.asar` that the running process already loaded:

1. First restart: DSH loads the injected `app.asar` and the `window.dshWindowResolution` channel becomes available.
2. Second restart: verifies the self-heal is idempotent (nothing to rewrite, status file refreshed). From now on the configured resolution is force-applied on every launch.

A single restart may still show "the window channel is not injected yet" in Settings — that is not an installation failure.

**4. Verify.** `node lib/bridge-cli.mjs status` should report "状态：已注入" (injected) with exit code 0, and `check` should report consistency. In Settings, pick a preset and the window should resize immediately.

### Uninstall

**Order matters: restore `app.asar` first, remove the plugin second.**

1. Quit DSH.
2. Restore from the plugin directory. `uninstall` runs `restore` first and then deletes the state file; it never claims success when the restore failed (non-zero exit):
   `node lib/bridge-cli.mjs uninstall`
   You can also run `restore` on its own and verify before removing the plugin.
3. Remove the plugin: use the DSH plugin manager, or delete the `dsh-window-resolution` entry from the profile's `dependencies` and `dsh.profile.bundles`, then reinstall dependencies and restart DSH.
4. Re-check: `node lib/bridge-cli.mjs status` should report "未注入" (not injected) with exit code 2.

Removing the plugin first loses the bundled restore entry point and leaves the injected bytes behind; you would then need to obtain the plugin again to run `restore`. Never hand-edit `app.asar` bytes without the rollback sidecar.

### Risks and graceful degradation

| Situation | Behavior |
| --- | --- |
| DSH upgrade | Upgrading replaces `resources/app.asar` and the injection is gone. The host self-check re-injects on the next launch; if anchors/symbols drifted it records `ok:false` in the state file, Settings shows "channel not injected", and re-running `install` fixes it. |
| Browser tab / non-Electron environment | The channel is absent and the plugin **degrades silently**: a static "not desktop" hint, no errors and no injection retries. The selection is still saved for the next desktop launch. |
| Injection failure (missing anchor, no write access, inconsistent archive) | Logged and written to the state file only — DSH startup is **never blocked**; the window keeps DSH's default size. |
| Stale payload version | `install` / startup self-heal restores the old payload from the sidecar and re-injects the current one (`reinstalled: true`). |
| Only half the patch is present | `install` reports `inconsistent`: run `restore --force`, then `install`. |
| Rollback sidecar lost while injected | `restore` reports `no-state`; do **not** hand-edit bytes — reinstall DSH to get a clean archive. |
| Target larger than the work area | **Clamped** to the work area; the actual size is returned and echoed. |
| Write requires elevation | First injection under `Program Files` may fail with `not-writable`: retry from an elevated terminal. |

Known limits: only the main window's **outer** size is managed; DPI/system scaling is untouched; auxiliary windows (welcome window, update overlay, etc.) are not controlled; no multi-window or per-project configuration; startup apply happens after the page loads, at the cost of one brief flicker.

### CLI cheat sheet

Run `node lib/bridge-cli.mjs <command> [app.asar] [--dry-run] [--force]` from the plugin directory:

| Command | What it does | Exit codes |
| --- | --- | --- |
| `status` | Read-only: archive, DSH/payload versions, injection state, dwc coexistence, anchors and byte budget | `0` injected; `2` not injected or inconsistent; `1` failed |
| `check` | Read-only: archive consistency (hashes, half-patches); reports installability when not injected | `0` injected and consistent; `2` not injected; `1` problems found |
| `install` | Inject; restores and re-injects when the payload is stale; `--dry-run` reports only; `--force` forces a re-inject | `0` success/up to date; `1` failed |
| `restore` | Restore exact bytes from the rollback sidecar; `--force` skips hash checks (never touches dwc's `app.asar.orig`) | `0` restored; `2` nothing to do; `1` failed |
| `uninstall` | `restore` first, then delete the state file | `0` restored; `2` nothing to do; `1` restore failed |
| `self-heal` | Startup self-check: inject when missing/stale, otherwise refresh the state file only | `0` passed; `1` failed |

Pass an archive path after the command, or override auto-detection with `DSH_WINDOW_RESOLUTION_ASAR` (or `DSH_ASAR`). Exit codes: `0` success/injected, `1` failed, `2` not injected (`status`/`check`) or nothing to do (`restore`/`uninstall`).

### Docs

- [`CHANGELOG.md`](CHANGELOG.md): release history

### Development

```bash
node --test          # unit tests (Node.js >= 20)
npm pack --dry-run   # inspect the published file list
```

### License

[MIT](LICENSE)

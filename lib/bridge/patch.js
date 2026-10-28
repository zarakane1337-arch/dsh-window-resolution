/**
 * dsh-plugin-resolution — 注入载荷与「等长替换」规划。
 *
 * ## 注入面
 *
 * 三块 ASCII 代码，替换归档里三段等长注释（注释是唯一天然「可丢弃」的字节）：
 *
 * | 块 | 归档条目 | 位置 | 作用 |
 * | --- | --- | --- | --- |
 * | `main-helpers` | `/lib/main.js` | 顶层语句处 | 校验 / 取窗口 / 组装报文（`const RSZ`） |
 * | `main-handler` | `/lib/main.js` | 顶层语句处 | `ipcMain.handle(CHANNEL, …)` 真正调 `setBounds` |
 * | `preload-bridge` | `/lib/preload-app.cjs` | 顶层语句处 | `contextBridge` 暴露 `window.dshWindowResolution` |
 *
 * 为什么拆两块而不是一块大的：主进程必须同时做「入参校验 + 无窗口判定 + getState
 * 查询 + 异常映射」，一块塞进 709 字节的注释里只剩个位数余量；拆成 516 + 488 两块，
 * 每块都有 50 字节以上余量，DSH 小版本改注释长度时不至于立刻失效。
 *
 * ## 为什么必须等长 + ASCII
 *
 * asar 的 header 记录每个条目的 `size`/`offset`，改长度就要重排整个文件区（182 MB）。
 * 等长替换把改动收敛成两个条目内的字节区间 + 头部两处哈希，风险最小。ASCII 则保证
 * 「字符串长度 = 字节长度」，中文注释一旦混进载荷，偏移就全错。
 *
 * ## 与 `dsh-window-control`（dwc）共存
 *
 * dwc 已经占了两段原始注释区，所以本模块：
 * - 只用**自己的**候选锚点，绝不写 dwc 的 `app.asar.orig` 备份，也不用 dwc 的锚点；
 * - 选点后检查候选字节区间里没有 dwc 的标记（`DWC=[[` / `dshWindowControl`），有就跳到下个候选；
 * - 载荷里不与 `RSZ` 之外的顶层标识符重名（dwc 有顶层 `const P`，重名会整进程 `SyntaxError`）。
 *
 * @packageDocumentation
 */

import { BridgeError, ensure } from './error.js'
import { assertIntegrity, entryOffset, findEntry, patchHeaderHash, readEntry, sha256 } from './asar.js'

/**
 * 主进程前置逻辑：报文构造函数、尺寸校验、发送方校验、窗口解析。
 *
 * 每个字母都是一次调用点，长度即预算；注释在 {@link BLOCKS} 里解释语义。
 */
const MAIN_HELPERS =
  'const RSZ={F:(c,m)=>({ok:false,code:c,message:m}),G:n=>n===~~n&&n>199&&n<16385,' +
  'S:e=>{try{assertDesktopSender(e,["app"]);return e.senderFrame===e.sender.mainFrame}catch{return 0}},' +
  'P:(e,v)=>{if(!RSZ.S(e))return RSZ.F("not-desktop","bad sender");' +
  'const w=BrowserWindow.fromWebContents(e.sender);' +
  'if(v&&v.get)return{patched:true,desktop:true,...(w&&{bounds:w.getBounds()})};' +
  'if(!w||w.isDestroyed())return RSZ.F("no-window","no window");' +
  'if(!v||!RSZ.G(v.width)||!RSZ.G(v.height))return RSZ.F("invalid","bad size");return w}};'

/**
 * 主进程处理器：先退全屏/最大化，再在工作区内居中 + 钳制，最后 `setBounds`。
 *
 * `screen` 不在主进程入口第 5 行的 import 列表里，而 ESM 里又不能凭空 `require`：
 * 借入口第 1 行就有的 `createRequire` 现取（`createRequire(import.meta.url)("electron")`），
 * 只在处理器内部求值，早于 app ready 也不会碰到 `screen` 尚未就绪。
 */
const MAIN_HANDLER =
  'ipcMain.handle("dsh-desktop:window-bounds-set",(e,v)=>{const w=RSZ.P(e,v);' +
  'if(!(w instanceof BrowserWindow))return w;' +
  'try{w.setFullScreen(false);w.unmaximize();' +
  'const a=createRequire(import.meta.url)("electron").screen.getDisplayMatching(w.getBounds()).workArea,' +
  'X=Math.min(a.width,Math.max(520,v.width)),Y=Math.min(a.height,Math.max(600,v.height));' +
  'w.setBounds({x:a.x+(a.width-X>>1),y:a.y+(a.height-Y>>1),width:X,height:Y});' +
  'return{ok:true,bounds:w.getBounds()}}catch(r){return RSZ.F("rejected",""+r)}});'

/**
 * preload 桥：只在 DSH 桌面窗口（`hostname === "app"`）的主框架里暴露命名空间。
 *
 * 这里只做**便宜的**作用域过滤：`dsh-app:` 协议与 `app` 主机名的权威校验在主进程
 * （`assertDesktopSender(event, ["app"])`），渲染端这层挡的是「辅助窗口/子框架误用」。
 * `getState` 额外兜一个 `.catch`，让「preload 在、handler 不在」也返回契约里的
 * `{ patched: false, desktop: true }` 而不是让调用方看到 rejection。
 */
const PRELOAD_BRIDGE =
  'if(location.hostname==="app"&&process.isMainFrame){' +
  'const E=electron,V=v=>E.ipcRenderer.invoke("dsh-desktop:window-bounds-set",v);' +
  'E.contextBridge.exposeInMainWorld("dshWindowResolution",{v:1,setBounds:V,' +
  'getState:()=>V({get:1}).catch(()=>({patched:false,desktop:true}))})};'

/** 三个载荷（导出给测试断言字节预算与 ASCII）。 */
export const PAYLOADS = Object.freeze({
  mainHelpers: MAIN_HELPERS,
  mainHandler: MAIN_HANDLER,
  preloadBridge: PRELOAD_BRIDGE,
})

/**
 * 注入目标：归档条目、必须存在的符号、以及「已注入」标记。
 *
 * `symbols` 是符号校验的白名单：DSH 改到没有 `assertDesktopSender` 这类函数时，
 * 注入出去只会得到运行时报错，不如提前失败。
 */
export const TARGETS = Object.freeze({
  main: Object.freeze({
    entry: '/lib/main.js',
    symbols: Object.freeze(['ipcMain', 'BrowserWindow', 'assertDesktopSender']),
    markers: Object.freeze(['DWC=[[']),
    mark: 'desktop:window-bounds-set',
  }),
  preload: Object.freeze({
    entry: '/lib/preload-app.cjs',
    symbols: Object.freeze(['contextBridge', 'ipcRenderer', 'electron']),
    markers: Object.freeze(['dshWindowControl']),
    mark: 'dshWindowResolution',
  }),
})

/**
 * 候选锚点：`text` 必须唯一；`mode` 决定替换到哪结束。
 *
 * 真实归档里三段注释的实测字节区间见 `docs/bridge-anchors.md`。候选按顺序尝试，
 * 第一个「唯一 + 区间空闲 + 装得下」的胜出；全都不行就失败，绝不退化成猜测。
 */
export const BLOCKS = Object.freeze([
  Object.freeze({
    id: 'main-helpers',
    target: 'main',
    code: MAIN_HELPERS,
    anchors: Object.freeze([
      Object.freeze({
        id: 'p2-config-compare',
        text: '/**\n* Compare two raw configs, treating schema-declared volatile fields',
      }),
      Object.freeze({
        id: 'p3-harness-home',
        text: '/**\n* Resolve the single-root DeepSeek Harness home.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'main-handler',
    target: 'main',
    code: MAIN_HANDLER,
    anchors: Object.freeze([
      Object.freeze({
        id: 'p1-file-replace',
        text: '/**\n* Zero-dependency atomic file replacement and writer coordination.',
      }),
    ]),
  }),
  Object.freeze({
    id: 'preload-bridge',
    target: 'preload',
    code: PRELOAD_BRIDGE,
    anchors: Object.freeze([
      Object.freeze({ id: 'q1-preload-platform-region', text: '//#region lib/types/preload-platform.js' }),
    ]),
  }),
])

/**
 * 载荷是否全 ASCII（长度即字节长度）。
 *
 * @param {string} text - 待检查文本。
 * @returns {boolean} 全 ASCII 为 true。
 */
export function isAscii(text) {
  return typeof text === 'string' && Buffer.byteLength(text, 'utf8') === text.length
}

/**
 * 从注释起点向右吃掉连续注释与空白，得到「可安全丢弃」的字节区间。
 *
 * 只向右扩展是有意的：左侧紧邻的换行/缩进属于上一条语句，退回左边容易破坏 ASI。
 *
 * @param {string} source - 条目源码。
 * @param {number} start - 注释起点字符下标（必须正好在 `//` 或 `/*` 上）。
 * @returns {{charStart: number, charEnd: number}} 字符区间（左闭右开）。
 */
export function commentRun(source, start) {
  let cursor = start
  for (;;) {
    if (source.startsWith('//', cursor)) {
      const newline = source.indexOf('\n', cursor)
      cursor = newline < 0 ? source.length : newline + 1
    } else if (source.startsWith('/*', cursor)) {
      const close = source.indexOf('*/', cursor)
      ensure(close >= 0, 'anchor-missing', '块注释没有闭合')
      cursor = close + 2
    } else {
      break
    }
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
  }
  ensure(cursor > start, 'anchor-missing', '锚点不是注释')
  return { charStart: start, charEnd: cursor }
}

/**
 * 把字符区间换算成字节区间。
 *
 * @param {string} source - 条目源码。
 * @param {{charStart: number, charEnd: number}} range - 字符区间。
 * @returns {{byteStart: number, byteLength: number}} 字节区间。
 */
export function byteRange(source, range) {
  return {
    byteStart: Buffer.byteLength(source.slice(0, range.charStart), 'utf8'),
    byteLength: Buffer.byteLength(source.slice(range.charStart, range.charEnd), 'utf8'),
  }
}

/**
 * 检查一个候选区间是否压到别的插件的注入区。
 *
 * 判据是「区间内出现别的插件的标记文本」——dwc 的载荷里必然带 `DWC=[[` /
 * `dshWindowControl`，一旦落在同一段注释里就说明那段注释已被占用。
 *
 * @param {string} source - 条目源码。
 * @param {{byteStart: number, byteLength: number}} range - 候选字节区间。
 * @param {string[]} markers - 其他插件的标记。
 * @returns {{marker: string, byteOffset: number} | null} 命中的标记；无冲突为 null。
 */
export function findOccupiedMarker(source, range, markers) {
  for (const marker of markers) {
    let index = source.indexOf(marker)
    while (index >= 0) {
      const byteOffset = Buffer.byteLength(source.slice(0, index), 'utf8')
      if (byteOffset >= range.byteStart && byteOffset < range.byteStart + range.byteLength) {
        return { marker, byteOffset }
      }
      index = source.indexOf(marker, index + marker.length)
    }
  }
  return null
}

/**
 * 规划一个候选锚点。
 *
 * @param {string} source - 条目源码。
 * @param {{id: string, text: string}} anchor - 候选锚点。
 * @param {string} code - 要写入的载荷。
 * @param {string[]} [markers] - 其他插件的标记。
 * @returns {{anchor: string, byteStart: number, byteLength: number, codeLength: number, padding: number}} 规划结果。
 */
export function planAnchor(source, anchor, code, markers = []) {
  const index = source.indexOf(anchor.text)
  ensure(index >= 0, 'anchor-missing', `锚点不存在：${anchor.id}`)
  ensure(
    source.indexOf(anchor.text, index + 1) < 0,
    'anchor-duplicated',
    `锚点不唯一：${anchor.id}（同一段文本出现多次，替换目标不确定）`,
  )
  ensure(isAscii(code), 'payload-not-ascii', `载荷含非 ASCII 字符：${anchor.id}`)
  const range = commentRun(source, index)
  const bytes = byteRange(source, range)
  ensure(
    bytes.byteLength >= code.length,
    'payload-too-long',
    `载荷 ${code.length} 字节放不进 ${bytes.byteLength} 字节的注释：${anchor.id}`,
  )
  const occupied = findOccupiedMarker(source, bytes, markers)
  ensure(
    !occupied,
    'anchor-occupied',
    `候选注释已被 ${occupied ? occupied.marker : ''} 占用：${anchor.id}`,
  )
  return {
    anchor: anchor.id,
    byteStart: bytes.byteStart,
    byteLength: bytes.byteLength,
    codeLength: code.length,
    padding: bytes.byteLength - code.length,
  }
}

/**
 * 为一个块挑出第一个可用锚点。
 *
 * @param {string} source - 条目源码。
 * @param {object} spec - {@link BLOCKS} 里的一项。
 * @param {string[]} [markers] - 其他插件的标记。
 * @returns {ReturnType<typeof planAnchor> & {id: string, target: string}} 选点结果。
 */
export function selectAnchor(source, spec, markers = []) {
  const reasons = []
  for (const anchor of spec.anchors) {
    try {
      const planned = planAnchor(source, anchor, spec.code, markers)
      return { id: spec.id, target: spec.target, ...planned }
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error
      reasons.push(`${anchor.id}：${error.message}`)
    }
  }
  throw new BridgeError('anchor-missing', `块 ${spec.id} 没有可用锚点`, { reasons })
}

/**
 * 校验某个条目的必需符号都在。
 *
 * @param {string} source - 条目源码。
 * @param {object} target - {@link TARGETS} 里的一项。
 * @returns {void}
 */
export function assertSymbols(source, target) {
  const missing = target.symbols.filter((symbol) => !source.includes(symbol))
  ensure(missing.length === 0, 'symbol-missing', `缺少必需符号：${missing.join('、')}`, { missing })
}

/**
 * 校验载荷里新增的顶层标识符没有和原文重名（重名会让整个进程 `SyntaxError`）。
 *
 * @param {string} source - 条目源码。
 * @param {string} code - 载荷。
 * @returns {void}
 */
export function assertNoCollision(source, code) {
  const declared = code.match(/^const ([A-Za-z_$][\w$]*)=/g) || []
  for (const statement of declared) {
    const identifier = statement.slice('const '.length, -1)
    const pattern = new RegExp(`\\b(?:const|let|var|function|class)\\s+${identifier}\\b`)
    ensure(
      !pattern.test(source),
      'symbol-missing',
      `载荷标识符 ${identifier} 已存在于目标源码，注入后会语法错误`,
    )
  }
}

/**
 * 规划全部块（纯函数，不碰文件）。
 *
 * @param {{sources: Record<string, string>, blocks?: readonly object[], targets?: object}} options - 各条目源码。
 * @returns {Record<string, Array<ReturnType<typeof planAnchor> & {id: string, code: string}>>} 按条目分组的块。
 */
export function planBlocks({ sources, blocks = BLOCKS, targets = TARGETS }) {
  const planned = {}
  for (const targetName of Object.keys(targets)) {
    const source = sources[targetName]
    ensure(typeof source === 'string', 'entry-missing', `缺少条目源码：${targetName}`)
    assertSymbols(source, targets[targetName])
    planned[targetName] = []
  }
  for (const spec of blocks) {
    const source = sources[spec.target]
    assertNoCollision(source, spec.code)
    planned[spec.target].push({ ...selectAnchor(source, spec, targets[spec.target].markers), code: spec.code })
  }
  return planned
}

/**
 * 把一组块按「从后往前」的顺序写进源码，返回新源码。
 *
 * 倒序写是为了让前面的字节偏移保持有效（虽然等长替换不会移动偏移，但倒序让
 * 「等长」这一前提失效时也不会互相污染）。
 *
 * @param {string} source - 原源码。
 * @param {Array<{byteStart: number, byteLength: number, code: string}>} blocks - 已规划的块。
 * @returns {string} 替换后的源码。
 */
export function applyBlocks(source, blocks) {
  const ordered = [...blocks].sort((a, b) => b.byteStart - a.byteStart)
  let text = source
  for (const block of ordered) {
    const chars = text.length === Buffer.byteLength(text, 'utf8')
      ? [block.byteStart, block.byteStart + block.byteLength]
      : byteToCharRange(text, block.byteStart, block.byteLength)
    const [start, end] = chars
    const payload = block.code + ' '.repeat(block.byteLength - block.code.length)
    text = text.slice(0, start) + payload + text.slice(end)
  }
  return text
}

/**
 * 在全 ASCII 源码里字节下标等于字符下标；含有非 ASCII 时按需换算。
 *
 * @param {string} source - 源码。
 * @param {number} byteStart - 起始字节。
 * @param {number} byteLength - 字节长度。
 * @returns {[number, number]} 字符区间。
 */
function byteToCharRange(source, byteStart, byteLength) {
  const bytes = Buffer.from(source, 'utf8')
  let seen = 0
  let start = -1
  let end = -1
  for (let index = 0; index < source.length; index += 1) {
    if (seen === byteStart) start = index
    const size = Buffer.byteLength(source[index], 'utf8')
    seen += size
    if (seen === byteStart + byteLength) {
      end = index + 1
      break
    }
  }
  ensure(start >= 0 && end >= 0, 'anchor-missing', '字节区间换算字符区间失败')
  return [start, end]
}

/**
 * 读出目标条目源码并规划全部块。
 *
 * @param {object} loaded - {@link import('./asar.js').readArchive} 的结果。
 * @returns {{sources: Record<string, string>, metas: Record<string, object>, planned: object}} 源码、元数据、规划。
 */
export function planArchive(loaded) {
  const sources = {}
  const metas = {}
  for (const [targetName, target] of Object.entries(TARGETS)) {
    const meta = findEntry(loaded.header, target.entry)
    ensure(meta, 'entry-missing', `归档里没有 ${target.entry}`)
    assertIntegrity(meta)
    metas[targetName] = meta
    sources[targetName] = readEntry(loaded, meta).toString('utf8')
  }
  return { sources, metas, planned: planBlocks({ sources }) }
}

/**
 * 生成一次安装的全部写入（头部 + 各条目），并保留被替换区间的原始字节以便精确还原。
 *
 * @param {object} loaded - {@link import('./asar.js').readArchive} 的结果。
 * @returns {{
 *   archive: string,
 *   header: {buffer: Buffer, patches: Array<{target: string, mode: string, oldHash: string, newHash: string}>},
 *   targets: Record<string, object>,
 *   blocks: Array<object>,
 *   writes: Array<{label: string, fileOffset: number, buffer: Buffer}>,
 * }} 构建结果；失败时抛 {@link BridgeError}。
 */
export function buildPatch(loaded) {
  const { sources, metas, planned } = planArchive(loaded)
  const targets = {}
  const blocks = []
  const writes = []
  const headerPatches = []
  let headerBuffer = loaded.head

  for (const [targetName, target] of Object.entries(TARGETS)) {
    const source = sources[targetName]
    const meta = metas[targetName]
    const oldHash = assertIntegrity(meta)
    const patches = planned[targetName]
    const patched = applyBlocks(source, patches)
    ensure(
      Buffer.byteLength(patched, 'utf8') === Number(meta.size),
      'length-changed',
      `${target.entry} 替换后长度变化：${Buffer.byteLength(patched, 'utf8')} != ${meta.size}`,
    )
    const patchedBytes = Buffer.from(patched, 'utf8')
    const originalBytes = Buffer.from(source, 'utf8')
    const newHash = sha256(patchedBytes)
    const absolute = entryOffset(loaded, meta)
    writes.push({ label: target.entry, fileOffset: absolute, buffer: patchedBytes })
    for (const patch of patches) {
      blocks.push({
        id: patch.id,
        target: targetName,
        entry: target.entry,
        anchor: patch.anchor,
        byteStart: patch.byteStart,
        byteLength: patch.byteLength,
        codeLength: patch.codeLength,
        padding: patch.padding,
        original: originalBytes.subarray(patch.byteStart, patch.byteStart + patch.byteLength),
      })
    }
    const hashPatch = patchHeaderHash(headerBuffer, oldHash, newHash, meta)
    headerBuffer = hashPatch.buffer
    headerPatches.push({ target: targetName, mode: hashPatch.mode, oldHash, newHash })
    targets[targetName] = {
      entry: target.entry,
      size: Number(meta.size),
      absolute,
      oldHash,
      newHash,
      blocks: patches.map((patch) => patch.id),
    }
  }

  writes.unshift({ label: 'header', fileOffset: 16, buffer: headerBuffer.subarray(16) })
  return {
    archive: loaded.archive,
    header: { buffer: headerBuffer, patches: headerPatches },
    targets,
    blocks,
    writes,
  }
}

/**
 * 合成迷你 asar 夹具：手工拼出「固定头 + header JSON + 文件区」。
 *
 * 真机归档 182 MB、结构不可控，单元测试需要能任意构造的归档：锚点可以缺失、可以重复、
 * 可以被别的插件占着、可以短到放不下载荷。夹具同时提供与真实源码同形的
 * `main.js` / `preload-app.cjs`，让「扫描 → 选点 → 等长替换 → 重算哈希」的整条链路
 * 在内存里就能跑通。
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto'

/** 与 `lib/bridge/patch.js` 里候选锚点一一对应的文本（测试与实现共享同一组常量）。 */
export const FIXTURE_ANCHORS = Object.freeze({
  mainHelpers: '/**\n* Compare two raw configs, treating schema-declared volatile fields',
  mainHelpersFallback: '/**\n* Resolve the single-root DeepSeek Harness home.',
  mainHandler: '/**\n* Zero-dependency atomic file replacement and writer coordination.',
  preload: '//#region lib/types/preload-platform.js',
})

/**
 * 生成一段长度可控的块注释，首行是 `/**`，第二行是 `* <firstLine>`（与真实源码同形）。
 *
 * @param {string} firstLine - 注释正文首句（锚点文本的第二行去掉 `* `）。
 * @param {number} minBytes - 至少多少字节。
 * @returns {string} 注释文本（不含换行结尾）。
 */
export function commentBlock(firstLine, minBytes) {
  const lines = ['/**', `* ${firstLine}`]
  let text = [...lines, '*/'].join('\n')
  for (let index = 0; Buffer.byteLength(text, 'utf8') < minBytes; index += 1) {
    lines.push(`* filler ${index} keeps the comment long enough to host the injected block`)
    text = [...lines, '*/'].join('\n')
  }
  return text
}

/**
 * 造一段与真实 `lib/main.js` 同形的合成源码。
 *
 * @param {{omit?: string[], occupied?: boolean, shortHelpers?: boolean}} [options] - 变形开关。
 *   `omit` 里的键（`mainHelpers` / `mainHelpersFallback` / `mainHandler`）对应的注释不再出现；
 *   `occupied` 在候选注释里塞进外部插件标记；`shortHelpers` 把首个候选注释压到放不下载荷。
 * @returns {string} 源码文本。
 */
export function mainEntry(options = {}) {
  const omit = new Set(options.omit || [])
  const parts = [
    'import { app, BrowserWindow, dialog, ipcMain } from "electron";',
    '',
    '/** 拒绝非 dsh-app 主的 IPC。 */',
    'function assertDesktopSender(event, hostnames) {',
    '\tconst senderFrame = event.senderFrame;',
    '\tif (senderFrame === null) throw new Error("rejected IPC without a sender frame");',
    '\tconst url = new URL(senderFrame.url);',
    '\tif (url.protocol !== `dsh-app:` || !hostnames.includes(url.hostname)) throw new Error("unowned renderer");',
    '}',
    '',
    '//#region lib/types/config.js',
  ]

  if (!omit.has('mainHelpersFallback')) {
    const filler = options.shortHelpers === 'fallback' ? 120 : 560
    parts.push(commentBlock('Resolve the single-root DeepSeek Harness home.', filler))
  }
  parts.push('function resolveHarnessHome() { return "C:\\\\Users\\\\x\\\\.dsh"; }', '')

  if (!omit.has('mainHelpers')) {
    const filler = options.shortHelpers ? 120 : 620
    const body =
      options.occupied === 'helpers'
        ? `${commentBlock('Compare two raw configs, treating schema-declared volatile fields', filler).slice(0, -2)}\n* ${'DWC=[[ external injection marker '}\n*/`
        : commentBlock('Compare two raw configs, treating schema-declared volatile fields', filler)
    parts.push(body)
  }
  parts.push(
    'function equalExceptVolatile(a, b) {',
    '\treturn Object.keys(a).length === Object.keys(b).length;',
    '}',
    '',
    '//#region lib/types/cli-args.js',
  )

  if (!omit.has('mainHandler')) {
    const body =
      options.occupied === 'handler'
        ? `${commentBlock('Zero-dependency atomic file replacement and writer coordination.', 760).slice(0, -2)}\n* DWC=[[ external injection marker\n*/`
        : commentBlock('Zero-dependency atomic file replacement and writer coordination.', 760)
    parts.push(body)
  }
  parts.push(
    'function replaceFileSync(target, bytes) {',
    '\treturn target && bytes;',
    '}',
    '',
    'export { app, Bootstrap };',
    '',
  )
  return parts.join('\n')
}

/**
 * 造一段与真实 `lib/preload-app.cjs` 同形的合成源码。
 *
 * @param {{omit?: boolean, occupied?: boolean}} [options] - `omit` 去掉 Q1 注释；`occupied` 塞进外部标记。
 * @returns {string} 源码文本。
 */
export function preloadEntry(options = {}) {
  const parts = [
    'let electron = require("electron");',
    '',
    'const PLATFORM_IPC = {',
    '\tbootstrap: "dsh-platform:bootstrap",',
    '\tbounds: "dsh-platform:bounds"',
    '};',
    '//#endregion',
  ]
  if (!options.omit) {
    parts.push(
      options.occupied
        ? '//#region lib/types/preload-platform.js /* DWC=[[ external marker */'
        : '//#region lib/types/preload-platform.js',
      '/** Marks the document root with the host platform so shared Web UI CSS can scope desktop-only rules. */',
      '/**',
      '* Sets `data-platform` (e.g. `darwin`) on `<html>`, deferring to DOMContentLoaded',
      '* when the preload runs before the document root exists.',
      '*/',
    )
  }
  parts.push(
    'function markDocumentPlatform() {',
    '\tdocument.documentElement.dataset.platform = process.platform;',
    '}',
    '',
    'electron.contextBridge.exposeInMainWorld("dshDesktop", { protocolVersion: 1 });',
    '',
  )
  return parts.join('\n')
}

/**
 * 把若干条目打包成一份 asar 字节（header JSON + 顺序排列的文件区）。
 *
 * @param {{entries: Record<string, string | Buffer>}} options - 归档内路径 → 内容。
 * @returns {{
 *   buffer: Buffer,
 *   header: object,
 *   jsonLength: number,
 *   dataStart: number,
 *   entries: Record<string, {bytes: Buffer, meta: object}>,
 * }} 归档字节、头部对象与逐条目元数据。
 */
export function buildArchive({ entries }) {
  const files = {}
  const chunks = []
  const normalized = {}
  let offset = 0

  for (const [entryPath, content] of Object.entries(entries)) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
    const parts = entryPath.split('/').filter(Boolean)
    let node = files
    for (const part of parts.slice(0, -1)) {
      if (!node[part]) node[part] = { files: {} }
      node = node[part].files
    }
    const hash = createHash('sha256').update(bytes).digest('hex')
    const meta = {
      size: bytes.length,
      offset: String(offset),
      integrity: { algorithm: 'SHA256', hash, blockSize: 4194304, blocks: [hash] },
    }
    node[parts[parts.length - 1]] = meta
    chunks.push(bytes)
    normalized[entryPath] = { bytes, meta }
    offset += bytes.length
  }

  const header = { files }
  const jsonBuffer = Buffer.from(JSON.stringify(header), 'utf8')
  const fixed = Buffer.alloc(16)
  fixed.writeUInt32LE(jsonBuffer.length, 12)
  const buffer = Buffer.concat([fixed, jsonBuffer, ...chunks])
  return {
    buffer,
    header,
    jsonLength: jsonBuffer.length,
    dataStart: 16 + jsonBuffer.length,
    entries: normalized,
  }
}

/**
 * 造一份「主进程 + preload」都在的默认夹具归档。
 *
 * @param {{main?: Parameters<typeof mainEntry>[0], preload?: Parameters<typeof preloadEntry>[0]}} [options] - 变形开关。
 * @returns {ReturnType<typeof buildArchive>} 归档。
 */
export function defaultArchive(options = {}) {
  return buildArchive({
    entries: {
      '/lib/main.js': mainEntry(options.main),
      '/lib/preload-app.cjs': preloadEntry(options.preload),
    },
  })
}

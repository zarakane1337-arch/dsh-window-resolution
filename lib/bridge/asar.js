/**
 * dsh-window-resolution — asar 归档的只读解析与头部改写（纯逻辑 + 最少文件系统接触）。
 *
 * ## 为什么是 asar
 *
 * DSH 桌面端的主进程与 preload 都打包在 `resources/app.asar` 里，官方没有提供
 * 「自定义窗口尺寸」的 IPC。原理与 `dsh-window-control` 相同：在归档里找到主进程
 * 与 preload 的源码条目，**等长**替换一段注释成我们的代码。等长就没有偏移问题，
 * 只需要重算该条目的 `integrity`（SHA256），否则 Electron 会拒绝加载。
 *
 * ## 归档格式（本模块唯一依赖的事实）
 *
 * ```
 * 0   .. 4     UInt32LE  4        （固定头前 4 字节，本模块不解释）
 * 4   .. 8     UInt32LE  header size（旧字段，本模块不解释）
 * 8   .. 12    UInt32LE  JSON 长度 的备份字段（本模块不解释）
 * 12  .. 16    UInt32LE  JSON 长度（真正生效的那个）
 * 16  .. 16+N  UTF-8     header JSON（末尾可能有对齐填充）
 * 16+N ..      payload   各条目字节，`header.files[*].offset` 相对这里
 * ```
 *
 * `offset` / `size` 在 header JSON 里是**字符串**（Chromium 的 Pickle 序列化结果），
 * 所以本模块一律 `Number()` 之后再用。
 *
 * ## 边界
 *
 * 这里不决定「要改哪里、写成什么」（那是 `patch.js`），也不写文件（那是
 * `install.js`）；只负责读取、定位、算偏移、改写头部哈希。
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { BridgeError, ensure } from './error.js'

/** 固定头长度。 */
export const HEADER_FIXED = 16

/** header JSON 的合理上限：真实归档约 4.8 MB，64 MiB 足够离谱到能识别出损坏。 */
export const MAX_HEADER_JSON = 64 * 1024 * 1024

/** 指定归档路径的环境变量（测试与 CLI 用；与 `dsh-window-control` 的 `DSH_ASAR` 并存）。 */
export const ENV_ARCHIVE = 'DSH_WINDOW_RESOLUTION_ASAR'

const require = createRequire(import.meta.url)

/**
 * 真正落盘的 `fs`。
 *
 * Electron 主进程把 `.asar` 路径交给归档层处理，`node:fs` 读不到原始字节；注入器
 * 必须用 `original-fs`。非 Electron 环境（单测、CLI）没有这个模块，回落到 `node:fs`。
 */
export const fileSystem = (() => {
  try {
    return require('original-fs')
  } catch {
    return fs
  }
})()

/** 十六进制的 SHA256 形状。 */
const HEX64 = /^[0-9a-f]{64}$/

/**
 * 解析固定头 + JSON，得到长度与位置。
 *
 * @param {Buffer} raw - 至少 `HEADER_FIXED + jsonLength` 字节的头部切片。
 * @returns {{jsonLength: number, dataStart: number, header: object}} JSON 长度、数据区起点与头部对象。
 */
export function parseHeader(raw) {
  ensure(Buffer.isBuffer(raw) && raw.length >= HEADER_FIXED, 'bad-header', `asar 头部不足 ${HEADER_FIXED} 字节`)
  const jsonLength = raw.readUInt32LE(12)
  ensure(
    jsonLength > 0 && jsonLength <= MAX_HEADER_JSON,
    'bad-header',
    `asar 头部 JSON 长度异常：${jsonLength}`,
  )
  ensure(raw.length >= HEADER_FIXED + jsonLength, 'bad-header', `asar 头部被截断：需要 ${jsonLength} 字节 JSON`)
  const text = raw.toString('utf8', HEADER_FIXED, HEADER_FIXED + jsonLength)
  return { jsonLength, dataStart: HEADER_FIXED + jsonLength, header: parseHeaderJson(text) }
}

/**
 * 解析 header JSON 文本。
 *
 * JSON 后面可能跟着对齐用的填充字节，所以只取到最后一个 `}`。
 *
 * @param {string} text - 头部文本（UTF-8 解码后的）。
 * @returns {object} 头部对象。
 */
export function parseHeaderJson(text) {
  ensure(typeof text === 'string' && text.length > 0, 'bad-header', 'asar 头部 JSON 为空')
  const end = text.lastIndexOf('}')
  ensure(end >= 0, 'bad-header', 'asar 头部不是 JSON 对象（找不到右花括号）')
  try {
    const header = JSON.parse(text.slice(0, end + 1))
    ensure(header && typeof header === 'object' && header.files, 'bad-header', 'asar 头部缺少 files 节点')
    return header
  } catch (error) {
    if (error instanceof BridgeError) throw error
    throw new BridgeError('bad-header', `asar 头部 JSON 解析失败：${error.message}`)
  }
}

/**
 * 只读打开归档，读出头部与数据区起点。
 *
 * @param {string} archive - `app.asar` 绝对路径。
 * @param {typeof fs} [io] - 文件系统实现（测试可替换）。
 * @returns {{archive: string, jsonLength: number, dataStart: number, header: object, head: Buffer}} 归档视图。
 */
export function readArchive(archive, io = fileSystem) {
  let fd
  try {
    fd = io.openSync(archive, 'r')
  } catch (error) {
    throw new BridgeError('no-archive', `打不开 asar：${archive}（${error.message}）`)
  }
  try {
    const fixed = Buffer.alloc(HEADER_FIXED)
    if (io.readSync(fd, fixed, 0, HEADER_FIXED, 0) !== HEADER_FIXED) {
      throw new BridgeError('bad-header', `asar 头部不足 ${HEADER_FIXED} 字节：${archive}`)
    }
    const jsonLength = fixed.readUInt32LE(12)
    ensure(
      jsonLength > 0 && jsonLength <= MAX_HEADER_JSON,
      'bad-header',
      `asar 头部 JSON 长度异常：${jsonLength}`,
    )
    const json = Buffer.alloc(jsonLength)
    const read = io.readSync(fd, json, 0, jsonLength, HEADER_FIXED)
    ensure(read === jsonLength, 'bad-header', `asar 头部被截断：只读到 ${read}/${jsonLength} 字节`)
    const header = parseHeaderJson(json.toString('utf8'))
    return {
      archive,
      jsonLength,
      dataStart: HEADER_FIXED + jsonLength,
      header,
      head: Buffer.concat([fixed, json]),
    }
  } finally {
    io.closeSync(fd)
  }
}

/**
 * 按 `/lib/main.js` 这种绝对路径在归档里找条目元数据。
 *
 * @param {object} header - 头部对象。
 * @param {string} entryPath - 以 `/` 开头的归档内路径。
 * @returns {object | null} 条目元数据；不存在时 null。
 */
export function findEntry(header, entryPath) {
  if (!header || typeof entryPath !== 'string' || entryPath.length === 0) return null
  const parts = entryPath.split('/').filter(Boolean)
  if (parts.length === 0) return null
  let node = header
  for (const part of parts) {
    if (!node || typeof node !== 'object' || !node.files || !node.files[part]) return null
    node = node.files[part]
  }
  return node && typeof node === 'object' ? node : null
}

/**
 * 条目在归档文件里的绝对字节偏移。
 *
 * @param {{dataStart: number}} loaded - {@link readArchive} 的结果。
 * @param {{offset?: string | number}} meta - 条目元数据。
 * @returns {number} 绝对偏移。
 */
export function entryOffset(loaded, meta) {
  const offset = Number(meta && meta.offset)
  ensure(Number.isFinite(offset) && offset >= 0, 'entry-missing', `条目 offset 非法：${String(meta && meta.offset)}`)
  return loaded.dataStart + offset
}

/**
 * 读出一个条目的完整字节。
 *
 * @param {{archive: string}} loaded - {@link readArchive} 的结果。
 * @param {object} meta - 条目元数据（含 `offset` / `size`）。
 * @param {typeof fs} [io] - 文件系统实现。
 * @returns {Buffer} 条目字节。
 */
export function readEntry(loaded, meta, io = fileSystem) {
  const size = Number(meta && meta.size)
  ensure(Number.isFinite(size) && size > 0, 'entry-missing', `条目 size 非法：${String(meta && meta.size)}`)
  const buffer = Buffer.alloc(size)
  const fd = io.openSync(loaded.archive, 'r')
  try {
    const read = io.readSync(fd, buffer, 0, size, entryOffset(loaded, meta))
    ensure(read === size, 'entry-missing', `条目被截断：只读到 ${read}/${size} 字节`)
  } finally {
    io.closeSync(fd)
  }
  return buffer
}

/**
 * 字节的 SHA256（小写十六进制），用于重算 `integrity`。
 *
 * @param {Buffer} buffer - 待摘要字节。
 * @returns {string} 64 位十六进制。
 */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 校验并取出条目的 integrity 哈希（Electron 只接受单块 SHA256）。
 *
 * 形状不对就直接失败：与其写一个 Electron 会拒绝加载的归档，不如什么都不做。
 *
 * @param {object} meta - 条目元数据。
 * @returns {string} 旧哈希（64 位十六进制）。
 */
export function assertIntegrity(meta) {
  const integrity = meta && meta.integrity
  ensure(integrity && typeof integrity === 'object', 'integrity-shape', '条目缺少 integrity')
  ensure(integrity.algorithm === 'SHA256', 'integrity-shape', `integrity.algorithm 只能是 SHA256，实际 ${integrity.algorithm}`)
  const hash = integrity.hash
  ensure(typeof hash === 'string' && HEX64.test(hash), 'integrity-shape', `integrity.hash 不是 64 位十六进制：${hash}`)
  ensure(Array.isArray(integrity.blocks), 'integrity-shape', 'integrity.blocks 缺失')
  ensure(integrity.blocks.length === 1, 'integrity-shape', `只支持单块 integrity.blocks，实际 ${integrity.blocks.length} 块`)
  ensure(integrity.blocks[0] === hash, 'integrity-shape', 'integrity.hash 必须与 integrity.blocks[0] 一致')
  return hash
}

/**
 * 统计子串出现次数（大小写敏感、允许重叠无关——十六进制串不会自重叠）。
 *
 * @param {string} source - 被搜索文本。
 * @param {string} needle - 要找的子串。
 * @returns {number} 出现次数。
 */
function countOccurrences(source, needle) {
  if (!needle) return 0
  let count = 0
  let index = source.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = source.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * 把头部里旧哈希改成新哈希，输出**等长**的头部副本。
 *
 * 两种模式：
 * - `offset`：先用该条目的 `"offset":"N"` 定位，再改它后面最靠前的两处哈希。
 *   同内容的两个条目（例如 `main.js` 与它的 sourcemap 副本）共享同一哈希时，只有
 *   这一种模式不会误伤别人，所以优先用它。
 * - `plain`：`offset` 定位不到但旧哈希恰好出现两次时，全局替换这两处。
 *
 * 任何一步对不上就抛错 —— 宁可安装失败，也不写一个哈希对不上的归档。
 *
 * @param {Buffer} head - 原始头部（固定头 + JSON）。
 * @param {string} oldHash - 条目当前的 integrity 哈希。
 * @param {string} newHash - 改写后条目字节的新哈希。
 * @param {{offset?: string | number}} meta - 该条目的元数据。
 * @returns {{buffer: Buffer, mode: 'offset' | 'plain', offsets: number[]}} 新头部、所用模式，
 * 以及被改写的两处哈希在**归档文件内**的绝对字节偏移（升序，可直接用于 writeSync；
 * `head` 从文件 0 开始，所以 head 内偏移就是文件偏移）。
 */
export function patchHeaderHash(head, oldHash, newHash, meta) {
  ensure(HEX64.test(String(oldHash)), 'hash-locate', `旧哈希不是 64 位十六进制：${oldHash}`)
  ensure(HEX64.test(String(newHash)), 'hash-locate', `新哈希不是 64 位十六进制：${newHash}`)
  // latin1 保证 1 字符 = 1 字节，替换后长度天然不变。
  const source = head.toString('latin1')
  ensure(countOccurrences(source, oldHash) > 0, 'hash-locate', `头部里找不到旧哈希 ${oldHash}`)

  const offsetValue = meta && meta.offset !== undefined ? String(meta.offset) : ''
  if (offsetValue) {
    const anchors = [`"offset":"${offsetValue}"`, `"offset":${offsetValue}`]
    let anchor = ''
    let anchorIndex = -1
    for (const candidate of anchors) {
      const index = source.indexOf(candidate)
      if (index >= 0 && (anchorIndex < 0 || index < anchorIndex)) {
        anchor = candidate
        anchorIndex = index
      }
    }
    if (anchorIndex >= 0) {
      const positions = []
      let cursor = anchorIndex + anchor.length
      for (;;) {
        const index = source.indexOf(oldHash, cursor)
        if (index < 0) break
        positions.push(index)
        cursor = index + oldHash.length
      }
      if (positions.length >= 2) {
        const chars = source.split('')
        // 从后往前改，避免前一次替换把后一次的偏移推走。
        for (const index of positions.slice(0, 2).sort((a, b) => b - a)) {
          chars.splice(index, oldHash.length, newHash)
        }
        const patched = chars.join('')
        ensure(patched.length === source.length, 'hash-locate', '头部改写后长度变化')
        ensure(countOccurrences(patched, newHash) >= 2, 'hash-locate', '头部改写后没有两处新哈希')
        const offsets = positions.slice(0, 2).sort((a, b) => a - b)
        return { buffer: Buffer.from(patched, 'latin1'), mode: 'offset', offsets }
      }
    }
  }

  ensure(countOccurrences(source, oldHash) === 2, 'hash-locate', `旧哈希出现次数不是 2，无法安全定位：${oldHash}`)
  const offsets = []
  let cursor = 0
  for (;;) {
    const index = source.indexOf(oldHash, cursor)
    if (index < 0) break
    offsets.push(index)
    cursor = index + oldHash.length
  }
  const patched = source.split(oldHash).join(newHash)
  return { buffer: Buffer.from(patched, 'latin1'), mode: 'plain', offsets }
}

/**
 * 从一个文件路径向上找 `resources/app.asar` 或同目录的 `app.asar`。
 *
 * @param {string} start - 起点（文件或目录）。
 * @param {number} [depth] - 最多向上几层。
 * @returns {string[]} 候选路径（先近后远）。
 */
function walkUp(start, depth = 6) {
  const found = []
  let current = path.resolve(start)
  if (path.extname(current) !== '') current = path.dirname(current)
  for (let level = 0; level <= depth; level += 1) {
    found.push(path.join(current, 'app.asar'))
    found.push(path.join(current, 'resources', 'app.asar'))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return found
}

/**
 * 按优先级列出可能的归档路径（不判断是否存在）。
 *
 * @param {{explicit?: string, env?: NodeJS.ProcessEnv, argv?: string[], execPath?: string,
 *   localAppData?: string, programFiles?: string, programFilesX86?: string}} [options] - 线索。
 * @returns {string[]} 去重后的候选路径。
 */
export function archiveCandidates(options = {}) {
  const env = options.env || process.env
  const argv = options.argv || process.argv
  const execPath = options.execPath || process.execPath
  const localAppData = options.localAppData || env.LOCALAPPDATA
  const programFiles = options.programFiles || env.ProgramFiles
  const programFilesX86 = options.programFilesX86 || env['ProgramFiles(x86)']

  const candidates = []
  const push = (value) => {
    if (typeof value !== 'string' || value.length === 0) return
    const resolved = path.resolve(value)
    if (!candidates.includes(resolved)) candidates.push(resolved)
  }

  push(options.explicit)
  push(env[ENV_ARCHIVE])
  push(env.DSH_ASAR)
  for (const arg of argv.slice(1)) {
    if (typeof arg !== 'string' || arg.length === 0) continue
    if (/^[a-z]+:\/\//i.test(arg)) continue
    for (const candidate of walkUp(arg)) push(candidate)
  }
  for (const candidate of walkUp(execPath)) push(candidate)
  for (const base of [localAppData && path.join(localAppData, 'Programs'), programFiles, programFilesX86]) {
    if (!base) continue
    push(path.join(base, 'DeepSeek Harness', 'resources', 'app.asar'))
  }
  return candidates
}

/**
 * 找到要注入的 `app.asar`。
 *
 * @param {Parameters<typeof archiveCandidates>[0] & {io?: typeof fs}} [options] - 线索与文件系统。
 * @returns {string} 存在的归档路径。
 */
export function locateArchive(options = {}) {
  const io = options.io || fileSystem
  const candidates = archiveCandidates(options)
  for (const candidate of candidates) {
    try {
      if (io.existsSync(candidate) && io.statSync(candidate).isFile()) return candidate
    } catch {
      /* 单个候选不可访问就继续找下一个 */
    }
  }
  throw new BridgeError('no-archive', `找不到 app.asar，试过 ${candidates.length} 个候选`, { candidates })
}

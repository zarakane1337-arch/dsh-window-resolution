import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  assertIntegrity,
  entryOffset,
  fileSystem,
  findEntry,
  locateArchive,
  readArchive,
  readEntry,
  sha256,
} from './asar.js'
import { BridgeError, ensure } from './error.js'
import { TARGETS, buildPatch } from './patch.js'
import { RECOVERY_FILE, STATE_VERSION, STATUS_FILE, profileDir, readJson, removeFile, writeJson } from './state.js'

/** 注入修订号：载荷语义变化时递增，与 `lib/contract.js` 的契约版本各自独立。 */
export const BRIDGE_VERSION = 1

/** 锁文件后缀；与归档同目录，避免多个安装进程同时改字节。 */
export const LOCK_SUFFIX = '.dsh-window-resolution.lock'

/** 锁多久算残锁（上一进程被中断时留下的）。 */
export const LOCK_STALE_MS = 30_000

/** 判定「已注入」的标记：两个条目里各有一个独有字符串。 */
export const MARKS = Object.freeze({
  main: 'dsh-desktop:window-bounds-set',
  preload: 'dshWindowResolution',
  dwc: 'DWC=[[',
})

/**
 * 锁：`wx` 打开成功即持有，退出时删掉；超过 {@link LOCK_STALE_MS} 的残锁可以抢。
 *
 * @param {string} archive - 归档路径。
 * @param {number} [now] - 当前时间戳（测试注入）。
 * @returns {{file: string, release: () => void}} 锁句柄。
 */
export function acquireLock(archive, now = Date.now()) {
  const file = `${archive}${LOCK_SUFFIX}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx')
      fs.writeSync(fd, `${process.pid} ${now}\n`)
      fs.closeSync(fd)
      return { file, release: () => removeFile(file) }
    } catch (error) {
      if (error && error.code === 'EEXIST' && attempt === 0) {
        let stale = false
        try {
          stale = now - fs.statSync(file).mtimeMs > LOCK_STALE_MS
        } catch {
          stale = true
        }
        if (stale) {
          removeFile(file)
          continue
        }
      }
      throw new BridgeError('locked', `另一个注入进程正持有锁：${file}`)
    }
  }
  throw new BridgeError('locked', `无法获得注入锁：${file}`)
}

/**
 * 读一份归档的当前状态：两个目标条目在不在、有没有我们的标记、dwc 在不在。
 *
 * @param {string} archive - 归档路径。
 * @param {object} [io] - 文件系统实现（测试注入）。
 * @returns {{
 *   archive: string,
 *   loaded: object,
 *   main: {meta: object, text: string, patched: boolean},
 *   preload: {meta: object, text: string, patched: boolean},
 *   dwc: boolean,
 *   installed: boolean,
 * }} 检测结果。
 */
export function detect(archive, io = fileSystem) {
  const loaded = readArchive(archive, io)
  const read = (entryPath) => {
    const meta = findEntry(loaded.header, entryPath)
    ensure(meta, 'entry-missing', `归档里没有 ${entryPath}`)
    return { meta, text: readEntry(loaded, meta, io).toString('utf8') }
  }
  const main = read(TARGETS.main.entry)
  const preload = read(TARGETS.preload.entry)
  main.patched = main.text.includes(MARKS.main)
  preload.patched = preload.text.includes(MARKS.preload)
  return {
    archive,
    loaded,
    main,
    preload,
    dwc: main.text.includes(MARKS.dwc) || preload.text.includes('dshWindowControl'),
    installed: main.patched && preload.patched,
  }
}

/**
 * 只读状态报告：给 CLI 的 `status` 用，规划失败也只记录不抛。
 *
 * @param {{archive?: string, io?: object}} [options] - 归档覆盖与文件系统实现。
 * @returns {object} 报告。
 */
export function status(options = {}) {
  const archive = options.archive || locateArchive({ env: process.env })
  const detection = detect(archive, options.io || fileSystem)
  let plan
  try {
    const built = buildPatch(detection.loaded)
    plan = {
      ok: true,
      blocks: built.blocks.map((block) => ({
        id: block.id,
        entry: block.entry,
        anchor: block.anchor,
        byteStart: block.byteStart,
        byteLength: block.byteLength,
        codeLength: block.codeLength,
        padding: block.padding,
        budget: block.byteLength - block.codeLength,
      })),
      header: built.header.patches.map((patch) => ({ target: patch.target, mode: patch.mode, offsets: patch.offsets })),
      writes: built.writes.map((write) => ({ label: write.label, fileOffset: write.fileOffset, bytes: write.buffer.length })),
    }
  } catch (error) {
    plan = {
      ok: false,
      error: { code: error instanceof BridgeError ? error.code : 'failed', message: error.message, details: error.details },
    }
  }
  return {
    ok: true,
    archive,
    version: BRIDGE_VERSION,
    installed: detection.installed,
    dwc: detection.dwc,
    targets: {
      main: { entry: TARGETS.main.entry, size: Number(detection.main.meta.size), patched: detection.main.patched },
      preload: { entry: TARGETS.preload.entry, size: Number(detection.preload.meta.size), patched: detection.preload.patched },
    },
    plan,
  }
}

/**
 * 校验当前归档自身是否自洽：哈希对得上、两个标记齐全或都缺。
 *
 * @param {{archive?: string, io?: object}} [options] - 归档覆盖与文件系统实现。
 * @returns {{ok: boolean, installed: boolean, consistent: boolean, problems: string[]}} 校验结果。
 */
export function check(options = {}) {
  const io = options.io || fileSystem
  const archive = options.archive || locateArchive({ env: process.env })
  const problems = []
  let detection
  try {
    detection = detect(archive, io)
  } catch (error) {
    return { ok: false, installed: false, consistent: false, problems: [error.message] }
  }
  for (const target of [detection.main, detection.preload]) {
    const bytes = readEntry(detection.loaded, target.meta, io)
    const actual = sha256(bytes)
    try {
      const declared = assertIntegrity(target.meta)
      if (declared !== actual) problems.push(`${target.meta.size} 字节条目的哈希与头部不一致：头部 ${declared} / 实际 ${actual}`)
    } catch (error) {
      problems.push(error.message)
    }
  }
  if (detection.main.patched !== detection.preload.patched) {
    problems.push('只有一半补丁在：main 与 preload 必须同时注入，请先 restore')
  }
  if (!detection.installed && detection.main.patched === false && detection.preload.patched === false) {
    try {
      buildPatch(detection.loaded)
    } catch (error) {
      problems.push(`尚不可注入：${error.message}`)
    }
  }
  return {
    ok: problems.length === 0 && detection.installed,
    installed: detection.installed,
    consistent: problems.length === 0,
    problems,
  }
}

/**
 * 把重建好的头部 + 条目写回归档。
 *
 * 条目先写、头部最后写：头部哈希是条目的「结论」，最后落盘能让中断窗口里的归档
 * 处于「字节新、哈希旧」这种一眼可查的坏状态，而不是更隐蔽的半新半旧。
 *
 * @param {string} archive - 归档路径。
 * @param {{writes: Array<{label: string, fileOffset: number, buffer: Buffer}>}} built - {@link buildPatch} 结果。
 * @param {{running?: boolean | null, io?: object}} [options] - 运行状态（false 时用临时文件+改名）。
 * @returns {void}
 */
export function writeArchive(archive, built, options = {}) {
  const io = options.io || fileSystem
  const order = [...built.writes].sort((a, b) => Number(a.label === 'header') - Number(b.label === 'header'))
  const running = options.running
  if (running === false) {
    const temp = `${archive}.${process.pid}.tmp`
    io.copyFileSync(archive, temp)
    const fd = io.openSync(temp, 'r+')
    try {
      for (const write of order) io.writeSync(fd, write.buffer, 0, write.buffer.length, write.fileOffset)
      io.fsyncSync(fd)
    } finally {
      io.closeSync(fd)
    }
    io.renameSync(temp, archive)
    return
  }
  const fd = io.openSync(archive, 'r+')
  try {
    for (const write of order) io.writeSync(fd, write.buffer, 0, write.buffer.length, write.fileOffset)
    io.fsyncSync(fd)
  } finally {
    io.closeSync(fd)
  }
}

/**
 * 动手前先确认归档可写：不可写就一个字节都不碰，错误信息直说「需要提权」。
 *
 * @param {string} archive - 归档路径。
 * @param {object} [io] - 文件系统实现（测试注入）。
 * @returns {void}
 */
export function assertWritable(archive, io = fileSystem) {
  try {
    io.accessSync(archive, fs.constants.W_OK)
  } catch (error) {
    throw new BridgeError(
      'not-writable',
      `没有写权限：${archive}（需要管理员/提权后重试，安装期间请退出 DSH）`,
      { cause: error && error.code ? error.code : String(error) },
    )
  }
}

/**
 * 写完之后再读一遍，确认归档真的落在预期状态（防「写了但没生效」）。
 *
 * @param {string} archive - 归档路径。
 * @param {{targets: Record<string, {newHash: string}>}} built - {@link buildPatch} 结果。
 * @param {object} [io] - 文件系统实现。
 * @returns {void}
 */
export function verifyArchive(archive, built, io = fileSystem) {
  const detection = detect(archive, io)
  ensure(detection.installed, 'verify', '写入后仍检测不到两个注入标记')
  for (const [targetName, target] of Object.entries(built.targets)) {
    const files = detection[targetName]
    const actual = sha256(readEntry(detection.loaded, files.meta, io))
    ensure(actual === target.newHash, 'verify', `${target.entry} 写入后哈希不符：${actual} != ${target.newHash}`)
  }
}

/**
 * 判断 DSH 是否正在运行：运行中直接原地写（避免改名撞上已打开的文件）。
 *
 * @returns {boolean | null} 运行中 / 未运行 / 无法判断（`null`）。
 */
export function detectRunning() {
  if (process.platform !== 'win32') return null
  const exe = path.basename(process.execPath || '')
  if (!exe) return null
  try {
    const result = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/NH'], { encoding: 'utf8', windowsHide: true })
    if (result.error || typeof result.stdout !== 'string') return null
    return result.stdout.toLowerCase().includes(exe.toLowerCase())
  } catch {
    return null
  }
}

/**
 * 把「原始字节 + 旧哈希位置」写成回滚边车。
 *
 * @param {object} built - {@link buildPatch} 结果。
 * @param {{entry: string, size: number, oldHash: string, newHash: string}} target - 单条目信息。
 * @param {object} patch - 该条目的头部改写记录。
 * @returns {object} 边车里的单条目记录（`hashOffsets` 是归档文件内的绝对偏移）。
 */
function recoveryTarget(target, patch) {
  return {
    entry: target.entry,
    size: target.size,
    oldHash: target.oldHash,
    newHash: target.newHash,
    hashOffsets: patch.offsets,
  }
}

/**
 * 组装回滚边车：只存「我们动过的那几段字节」，不碰 dwc 的 `app.asar.orig`。
 *
 * @param {object} built - {@link buildPatch} 结果。
 * @param {{jsonLength: number, dataStart: number}} loaded - 归档布局。
 * @returns {object} 边车对象。
 */
export function buildRecovery(built, loaded) {
  const targets = {}
  for (const patch of built.header.patches) {
    targets[patch.target] = recoveryTarget(built.targets[patch.target], patch)
  }
  return {
    version: STATE_VERSION,
    archive: built.archive,
    installedAt: new Date().toISOString(),
    bridge: BRIDGE_VERSION,
    layout: { jsonLength: loaded.jsonLength, dataStart: loaded.dataStart },
    targets,
    blocks: built.blocks.map((block) => ({
      id: block.id,
      entry: block.entry,
      byteStart: block.byteStart,
      byteLength: block.byteLength,
      original: block.original.toString('base64'),
    })),
  }
}

/**
 * 安装（或 dry-run 只报告）。
 *
 * @param {{
 *   archive?: string,
 *   dryRun?: boolean,
 *   force?: boolean,
 *   running?: boolean | null,
 *   dir?: string,
 *   io?: object,
 *   now?: number,
 * }} [options] - 归档覆盖、干跑、强制、运行状态、状态目录、文件系统、时间。
 * @returns {object} 安装报告。
 */
export function install(options = {}) {
  const io = options.io || fileSystem
  const archive = options.archive || locateArchive({ env: process.env })
  const dir = options.dir || profileDir()
  let detection = detect(archive, io)

  if (detection.installed && !options.force) {
    return { ok: true, archive, dryRun: false, installed: true, changed: false, already: true }
  }
  if (options.force && detection.main.patched && detection.preload.patched) {
    restore({ archive, dir, io, now: options.now })
    detection = detect(archive, io)
  } else if (detection.main.patched !== detection.preload.patched) {
    throw new BridgeError('inconsistent', '只有一半补丁在：先跑 restore --force 再安装')
  }

  const built = buildPatch(detection.loaded)
  const report = {
    ok: true,
    archive,
    dryRun: Boolean(options.dryRun),
    installed: false,
    changed: true,
    version: BRIDGE_VERSION,
    blocks: built.blocks.map((block) => ({
      id: block.id,
      entry: block.entry,
      anchor: block.anchor,
      byteStart: block.byteStart,
      byteLength: block.byteLength,
      codeLength: block.codeLength,
      padding: block.padding,
      budget: block.byteLength - block.codeLength,
    })),
    header: built.header.patches.map((patch) => ({ target: patch.target, mode: patch.mode, offsets: patch.offsets })),
    writes: built.writes.map((write) => ({ label: write.label, fileOffset: write.fileOffset, bytes: write.buffer.length })),
  }
  if (options.dryRun) return report

  const lock = acquireLock(archive, options.now)
  try {
    assertWritable(archive, io)
    const recovery = buildRecovery(built, detection.loaded)
    const recoveryFile = path.join(dir, RECOVERY_FILE)
    writeJson(recoveryFile, { ...recovery, complete: false })
    writeArchive(archive, built, { running: options.running, io })
    verifyArchive(archive, built, io)
    writeJson(recoveryFile, { ...recovery, complete: true })
    writeJson(path.join(dir, STATUS_FILE), {
      ok: true,
      archive,
      installed: true,
      version: BRIDGE_VERSION,
      targetVersion: options.targetVersion || null,
      changed: true,
      at: new Date().toISOString(),
    })
  } finally {
    lock.release()
  }
  return { ...report, installed: true }
}

/**
 * 用回滚边车把字节精确还原；只在「当前归档确实是我们注进去的那一版」时才动手。
 *
 * @param {{archive?: string, dir?: string, force?: boolean, running?: boolean | null, io?: object, now?: number}} [options]
 *   - 归档覆盖、状态目录、忽略「已还原」、运行状态、文件系统、时间。
 * @returns {object} 还原报告。
 */
export function restore(options = {}) {
  const io = options.io || fileSystem
  const archive = options.archive || locateArchive({ env: process.env })
  const dir = options.dir || profileDir()
  const recoveryFile = path.join(dir, RECOVERY_FILE)
  const recovery = readJson(recoveryFile)
  if (!recovery) {
    const detection = detect(archive, io)
    if (!detection.main.patched && !detection.preload.patched) {
      return { ok: true, archive, restored: false, reason: 'not-installed' }
    }
    throw new BridgeError('no-state', `找不到回滚边车 ${recoveryFile}：无法安全还原（不会动 app.asar.orig，那是 dwc 的备份）`)
  }
  ensure(recovery.version === STATE_VERSION, 'stale-state', `边车版本 ${recovery.version} 与当前 ${STATE_VERSION} 不一致`)
  ensure(recovery.archive === archive, 'stale-state', `边车记录的归档是 ${recovery.archive}，与当前 ${archive} 不一致`)

  const detection = detect(archive, io)
  for (const [targetName, target] of Object.entries(recovery.targets)) {
    const files = detection[targetName]
    const actual = sha256(readEntry(detection.loaded, files.meta, io))
    ensure(
      actual === target.newHash,
      'stale-state',
      `${target.entry} 已被替换（当前哈希 ${actual}）：DSH 可能升级过，回滚会让应用更坏，已中止`,
    )
  }

  const lock = acquireLock(archive, options.now)
  try {
    const fd = io.openSync(archive, 'r+')
    try {
      const writes = []
      for (const [targetName, target] of Object.entries(recovery.targets)) {
        const absolute = entryOffset(detection.loaded, detection[targetName].meta)
        for (const block of recovery.blocks.filter((item) => item.entry === target.entry)) {
          const bytes = Buffer.from(block.original, 'base64')
          ensure(bytes.length === block.byteLength, 'stale-state', `${block.id} 的备份字节长度不符`)
          writes.push({ fileOffset: absolute + block.byteStart, buffer: bytes })
        }
        for (const offset of target.hashOffsets) {
          writes.push({ fileOffset: offset, buffer: Buffer.from(target.oldHash, 'latin1') })
        }
      }
      for (const write of writes) io.writeSync(fd, write.buffer, 0, write.buffer.length, write.fileOffset)
      io.fsyncSync(fd)
    } finally {
      io.closeSync(fd)
    }
    verifyRestored(archive, recovery, io)
    removeFile(recoveryFile)
    writeJson(path.join(dir, STATUS_FILE), {
      ok: true,
      archive,
      installed: false,
      version: BRIDGE_VERSION,
      targetVersion: options.targetVersion || null,
      changed: true,
      at: new Date().toISOString(),
    })
  } finally {
    lock.release()
  }
  return { ok: true, archive, restored: true, blocks: recovery.blocks.length }
}

/**
 * 还原后回读：两个条目的哈希必须回到旧值，标记必须消失。
 *
 * @param {string} archive - 归档路径。
 * @param {object} recovery - 边车对象。
 * @param {object} [io] - 文件系统实现。
 * @returns {void}
 */
export function verifyRestored(archive, recovery, io = fileSystem) {
  const detection = detect(archive, io)
  ensure(!detection.main.patched && !detection.preload.patched, 'verify', '还原后仍能检测到注入标记')
  for (const [targetName, target] of Object.entries(recovery.targets)) {
    const files = detection[targetName]
    const actual = sha256(readEntry(detection.loaded, files.meta, io))
    ensure(actual === target.oldHash, 'verify', `${target.entry} 还原后哈希不符：${actual} != ${target.oldHash}`)
  }
}

/**
 * 卸载 = 先还原再清状态（顺序不能反：状态是还原的唯一依据）。
 *
 * @param {{archive?: string, dir?: string, io?: object, now?: number}} [options] - 归档覆盖、状态目录、文件系统、时间。
 * @returns {object} 卸载报告。
 */
export function uninstall(options = {}) {
  const dir = options.dir || profileDir()
  const restored = restore({ ...options, dir })
  removeFile(path.join(dir, STATUS_FILE))
  return { ...restored, uninstalled: true }
}

/**
 * 启动自愈：已注入就只写状态；没注入就装；任何失败都只写状态、不抛。
 *
 * @param {{archive?: string, dir?: string, io?: object, running?: boolean | null, targetVersion?: string}} [options]
 *   - 归档覆盖、状态目录、文件系统、运行状态、DSH 版本。
 * @returns {{ok: boolean, action: 'already' | 'installed' | 'failed', error?: object}} 自检结果。
 */
export function ensurePatched(options = {}) {
  const dir = options.dir || profileDir()
  const archive = options.archive || (() => {
    try {
      return locateArchive({ env: process.env })
    } catch {
      return null
    }
  })()
  const at = new Date().toISOString()
  if (!archive) {
    const error = { code: 'no-archive', message: '找不到 app.asar' }
    writeJson(path.join(dir, STATUS_FILE), { ok: false, archive: null, installed: false, version: BRIDGE_VERSION, targetVersion: options.targetVersion || null, changed: false, at, error })
    return { ok: false, action: 'failed', error }
  }
  try {
    const detection = detect(archive, options.io || fileSystem)
    if (detection.installed) {
      writeJson(path.join(dir, STATUS_FILE), {
        ok: true,
        archive,
        installed: true,
        version: BRIDGE_VERSION,
        targetVersion: options.targetVersion || null,
        changed: false,
        at,
      })
      return { ok: true, action: 'already' }
    }
    const result = install({ ...options, archive, dir })
    return { ok: true, action: result.changed ? 'installed' : 'already' }
  } catch (error) {
    const detail = {
      code: error instanceof BridgeError ? error.code : 'failed',
      message: error && error.message ? error.message : String(error),
    }
    try {
      writeJson(path.join(dir, STATUS_FILE), {
        ok: false,
        archive,
        installed: false,
        version: BRIDGE_VERSION,
        targetVersion: options.targetVersion || null,
        changed: false,
        at,
        error: detail,
      })
    } catch {
      // 状态文件都写不了就只能放弃：绝不能因为自检失败让宿主崩掉。
    }
    return { ok: false, action: 'failed', error: detail }
  }
}

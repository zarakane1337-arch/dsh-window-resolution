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
import {
  PAYLOAD_VERSION,
  TARGETS,
  buildPatch,
  detectPayloadVersion,
  locatePayloads,
} from './patch.js'
import { RECOVERY_FILE, STATE_VERSION, STATUS_FILE, profileDir, readJson, removeFile, writeJson } from './state.js'

/**
 * 边车/状态文件格式版本：回滚边车字段变化时递增。
 *
 * 载荷本身要不要重注由 {@link PAYLOAD_VERSION} 决定，两者独立。
 */
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
 *   payloadVersion: number | null,
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
    payloadVersion: detectPayloadVersion(main.text) ?? detectPayloadVersion(preload.text),
  }
}

/**
 * DSH 自身版本号：注入状态要记「注给哪一版 DSH」，重装/升级后能一眼看出错配。
 *
 * 只读归档同目录的 electron-updater 元数据，顺序：
 * `resources/app-update.yml` → `resources/version` → 安装根目录 `version` →
 * `resources/app/package.json`。全都读不到或解析失败时返回 null（不猜、不报错）。
 *
 * @param {string} archive - 归档路径。
 * @returns {string | null} 形如 `44.7.0` 的版本号，未知为 null。
 */
export function locateTargetVersion(archive) {
  if (!archive) return null
  const resourcesDir = path.dirname(path.resolve(archive))
  const rootDir = path.dirname(resourcesDir)
  const candidates = [
    { file: path.join(resourcesDir, 'app-update.yml'), pick: versionFromYaml },
    { file: path.join(resourcesDir, 'version'), pick: versionFromPlain },
    { file: path.join(rootDir, 'version'), pick: versionFromPlain },
    { file: path.join(resourcesDir, 'app', 'package.json'), pick: versionFromJson },
  ]
  for (const candidate of candidates) {
    let text
    try {
      text = fs.readFileSync(candidate.file, 'utf8')
    } catch {
      continue
    }
    let value
    try {
      value = candidate.pick(text)
    } catch {
      value = null
    }
    if (value && SEMVER_PATTERN.test(value)) return value
  }
  return null
}

/** 只接受 `1.2.3` / `1.2.3-beta.1` 这类版本号，避免把 yml 里的别的标量当版本。 */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/**
 * 从 electron-updater 的 `app-update.yml` 里取 `version:`。
 *
 * @param {string} text - 文件内容。
 * @returns {string | null} 版本号或 null。
 */
function versionFromYaml(text) {
  const match = /^\s*version\s*:\s*["']?([^"'\s]+)["']?\s*$/m.exec(text)
  return match ? match[1] : null
}

/**
 * `version` 文件只放一个版本号（可能带换行）。
 *
 * @param {string} text - 文件内容。
 * @returns {string | null} 版本号或 null。
 */
function versionFromPlain(text) {
  return text.trim().split(/\s+/)[0] || null
}

/**
 * `package.json` 里的 `version` 字段。
 *
 * @param {string} text - 文件内容。
 * @returns {string | null} 版本号或 null。
 */
function versionFromJson(text) {
  const parsed = JSON.parse(text)
  return typeof parsed.version === 'string' ? parsed.version : null
}

/**
 * 只读状态报告：给 CLI 的 `status` 用。
 *
 * 只有**未注入**（或半注入待修）时才做规划检查——已注入时归档里已经有载荷，
 * 再做 `buildPatch` 必然撞自己的标识符，会把「一切正常」误报成规划失败。
 * 已注入时改为报告 `consistent` / `payloadVersion` / `anchors` 现状。
 *
 * 顶层 `ok` = 归档可读且（未注入，或已注入且自洽）。失败时带 `error`。
 *
 * @param {{archive?: string, io?: object}} [options] - 归档覆盖与文件系统实现。
 * @returns {object} 报告。
 */
export function status(options = {}) {
  const io = options.io || fileSystem
  const archive = options.archive || locateArchive({ env: process.env })
  const detection = detect(archive, io)
  const base = {
    archive,
    version: BRIDGE_VERSION,
    payloadVersion: detection.payloadVersion,
    targetVersion: locateTargetVersion(archive),
    installed: detection.installed,
    dwc: detection.dwc,
    targets: {
      main: { entry: TARGETS.main.entry, size: Number(detection.main.meta.size), patched: detection.main.patched },
      preload: { entry: TARGETS.preload.entry, size: Number(detection.preload.meta.size), patched: detection.preload.patched },
    },
  }
  const halfPatched = detection.main.patched !== detection.preload.patched
  if (detection.installed || halfPatched) {
    const consistency = check({ archive, io })
    const report = {
      ...base,
      ok: consistency.consistent && !halfPatched,
      consistent: consistency.consistent,
      problems: consistency.problems,
      stale: detection.payloadVersion !== PAYLOAD_VERSION,
      anchors: locatePayloads({ main: detection.main.text, preload: detection.preload.text }),
      plan: null,
    }
    if (!report.ok) {
      report.error = {
        code: 'inconsistent',
        message: consistency.problems.join('；') || '归档自洽校验失败',
      }
    }
    return report
  }
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
  return { ...base, ok: true, consistent: null, problems: [], stale: false, anchors: [], plan }
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
 * 判断 DSH 桌面是否正在运行：运行中只能原地写（改名会撞上已打开的文件）。
 *
 * 进程名从归档位置反推（`<root>/resources/app.asar` → `<root>/*.exe`），而不是用
 * `process.execPath` —— T05 是用 `node lib/bridge-cli.mjs` 跑安装的，那时 execPath 是 node.exe。
 *
 * @param {string} [archive] - 归档路径；给不出就退化成只看 node.exe。
 * @returns {boolean | null} 运行中 / 未运行 / 无法判断（`null`，例如没有 tasklist 权限）。
 */
export function detectRunning(archive) {
  if (process.platform !== 'win32') return null
  const names = new Set()
  if (archive) {
    const root = path.dirname(path.dirname(path.resolve(archive)))
    try {
      for (const entry of fs.readdirSync(root)) {
        if (/\.exe$/i.test(entry) && !/^unins/i.test(entry)) names.add(entry)
      }
    } catch {
      /* 目录读不了就退化成下面的 node.exe */
    }
  }
  if (names.size === 0 && process.execPath) names.add(path.basename(process.execPath))
  for (const name of names) {
    try {
      const result = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], { encoding: 'utf8', windowsHide: true })
      if (result.error || typeof result.stdout !== 'string') continue
      if (result.stdout.toLowerCase().includes(name.toLowerCase())) return true
    } catch {
      /* 单次探测失败不算结论 */
    }
  }
  return null
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
  const targetVersion = options.targetVersion || locateTargetVersion(archive)
  const previousPayloadVersion = detection.payloadVersion
  const stale = detection.installed && detection.payloadVersion !== PAYLOAD_VERSION
  const reinstalled = detection.installed && (stale || Boolean(options.force))

  if (detection.installed && !reinstalled) {
    return {
      ok: true,
      archive,
      dryRun: false,
      installed: true,
      changed: false,
      already: true,
      payloadVersion: detection.payloadVersion,
    }
  }
  if (reinstalled && options.dryRun) {
    return {
      ok: true,
      archive,
      dryRun: true,
      installed: true,
      changed: false,
      needsReinstall: true,
      stale,
      previousPayloadVersion,
      payloadVersion: previousPayloadVersion,
    }
  }
  if (reinstalled) {
    restore({ archive, dir, io, now: options.now, force: true })
    detection = detect(archive, io)
    ensure(
      !detection.installed,
      'inconsistent',
      '重注前没能把旧载荷还原干净：边车缺失或归档已被替换，请重新安装 DSH 桌面端',
    )
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
    reinstalled,
    previousPayloadVersion: reinstalled ? previousPayloadVersion : null,
    version: BRIDGE_VERSION,
    payloadVersion: PAYLOAD_VERSION,
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
    const running = options.running !== undefined ? options.running : detectRunning(archive)
    writeArchive(archive, built, { running, io })
    verifyArchive(archive, built, io)
    writeJson(recoveryFile, { ...recovery, complete: true })
    writeJson(path.join(dir, STATUS_FILE), {
      ok: true,
      archive,
      installed: true,
      version: BRIDGE_VERSION,
      payloadVersion: PAYLOAD_VERSION,
      targetVersion,
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
  const targetVersion = options.targetVersion || locateTargetVersion(archive)
  if (!recovery) {
    const detection = detect(archive, io)
    const untouched = !detection.main.patched && !detection.preload.patched
    if (untouched && !options.force) {
      return { ok: true, archive, restored: false, reason: 'not-installed' }
    }
    throw new BridgeError('no-state', `找不到回滚边车 ${recoveryFile}：无法安全还原（不会动 app.asar.orig，那是 dwc 的备份）`)
  }
  ensure(recovery.version === STATE_VERSION, 'stale-state', `边车版本 ${recovery.version} 与当前 ${STATE_VERSION} 不一致`)
  ensure(recovery.archive === archive, 'stale-state', `边车记录的归档是 ${recovery.archive}，与当前 ${archive} 不一致`)

  const detection = detect(archive, io)
  if (!options.force) {
    for (const [targetName, target] of Object.entries(recovery.targets)) {
      const files = detection[targetName]
      const actual = sha256(readEntry(detection.loaded, files.meta, io))
      ensure(
        actual === target.newHash,
        'stale-state',
        `${target.entry} 已被替换（当前哈希 ${actual}）：DSH 可能升级过，回滚会让应用更坏，已中止`,
      )
    }
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
      payloadVersion: null,
      targetVersion,
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
 * 只有「还原成功」或「本来就没注入」才算 `uninstalled:true`；`restore` 抛错时
 * 状态文件也不删（留着它下次还能重试）。
 *
 * @param {{archive?: string, dir?: string, io?: object, now?: number, force?: boolean}} [options] - 归档覆盖、状态目录、文件系统、时间。
 * @returns {object} 卸载报告。
 */
export function uninstall(options = {}) {
  const dir = options.dir || profileDir()
  const restored = restore({ ...options, dir })
  removeFile(path.join(dir, STATUS_FILE))
  const uninstalled = restored.restored === true || restored.reason === 'not-installed'
  return { ...restored, uninstalled }
}

/**
 * 启动自愈：载荷是当前版本就只写状态；过期或没注入就装（过期会先还原再重注）；
 * 任何失败都只写状态、不抛。
 *
 * @param {{archive?: string, dir?: string, io?: object, running?: boolean | null, targetVersion?: string}} [options]
 *   - 归档覆盖、状态目录、文件系统、运行状态、DSH 版本。
 * @returns {{ok: boolean, action: 'already' | 'installed' | 'reinstalled' | 'failed', error?: object}} 自检结果。
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
    writeJson(path.join(dir, STATUS_FILE), { ok: false, archive: null, installed: false, version: BRIDGE_VERSION, payloadVersion: null, targetVersion: options.targetVersion || null, changed: false, at, error })
    return { ok: false, action: 'failed', error }
  }
  try {
    const detection = detect(archive, options.io || fileSystem)
    const stale = detection.installed && detection.payloadVersion !== PAYLOAD_VERSION
    if (detection.installed && !stale) {
      writeJson(path.join(dir, STATUS_FILE), {
        ok: true,
        archive,
        installed: true,
        version: BRIDGE_VERSION,
        payloadVersion: detection.payloadVersion,
        targetVersion: options.targetVersion || locateTargetVersion(archive),
        changed: false,
        at,
      })
      return { ok: true, action: 'already' }
    }
    const result = install({ ...options, archive, dir })
    return {
      ok: true,
      action: result.reinstalled ? 'reinstalled' : result.changed ? 'installed' : 'already',
      previousPayloadVersion: result.previousPayloadVersion ?? null,
    }
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
        payloadVersion: null,
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

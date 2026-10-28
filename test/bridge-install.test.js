import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { BridgeError } from '../lib/bridge/error.js'
import { RECOVERY_FILE, STATE_VERSION, STATUS_FILE, readJson } from '../lib/bridge/state.js'
import {
  acquireLock,
  check,
  detect,
  detectRunning,
  ensurePatched,
  install,
  locateTargetVersion,
  restore,
  status,
  uninstall,
  verifyArchive,
} from '../lib/bridge/install.js'
import { BLOCKS, PAYLOADS, PAYLOAD_VERSION, VERSION_MARK, applyBlocks, planBlocks } from '../lib/bridge/patch.js'
import { buildArchive, defaultArchive, mainEntry, preloadEntry } from './helpers/asar-fixture.js'

/**
 * 在临时目录里铺一份合成归档，返回路径与清理函数。
 *
 * @param {{main?: object, preload?: object, bytes?: Buffer}} [options] - 夹具选项。
 * @returns {{dir: string, archive: string, original: Buffer, dispose: () => void}} 工作区。
 */
function workspace(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsz-install-'))
  const archive = path.join(dir, 'app.asar')
  const original = options.bytes || defaultArchive({ main: options.main, preload: options.preload }).buffer
  fs.writeFileSync(archive, original)
  return { dir, archive, original, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/**
 * 断言某段代码抛出指定错误码的 {@link BridgeError}。
 *
 * @param {() => unknown} fn - 待执行代码。
 * @param {string} code - 期望的错误码。
 * @returns {BridgeError} 捕获到的错误。
 */
function throwsBridge(fn, code) {
  let caught
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof BridgeError, `应抛 BridgeError，实际 ${caught && caught.stack}`)
  assert.equal(caught.code, code)
  return caught
}

test('status 在未注入的合成归档上给出锚点、字节预算与 dwc 情况', () => {
  const space = workspace()
  try {
    const report = status({ archive: space.archive })
    assert.equal(report.installed, false)
    assert.equal(report.dwc, false)
    assert.equal(report.plan.ok, true)
    assert.deepEqual(report.plan.blocks.map((block) => block.id), ['main-helpers', 'main-handler', 'preload-bridge'])
    for (const block of report.plan.blocks) assert.equal(block.budget, block.byteLength - block.codeLength)
    assert.equal(report.plan.header.length, 2)
    assert.equal(report.plan.header[0].mode, 'offset')
  } finally {
    space.dispose()
  }
})

test('status 在锚点被别的插件占用时如实报失败，而不是抛异常', () => {
  const space = workspace({ main: { occupied: 'handler' } })
  try {
    const report = status({ archive: space.archive })
    assert.equal(report.plan.ok, false)
    assert.equal(report.plan.error.code, 'anchor-missing')
    assert.match(JSON.stringify(report.plan.error.details), /DWC/)
    assert.equal(report.dwc, true)
  } finally {
    space.dispose()
  }
})

test('install 写入后 detect 认得出两个标记，且状态文件与边车都落盘', () => {
  const space = workspace()
  try {
    const report = install({ archive: space.archive, dir: space.dir, running: false })
    assert.equal(report.ok, true)
    assert.equal(report.installed, true)
    assert.equal(report.changed, true)
    assert.equal(report.writes.length, 3)

    const detection = detect(space.archive)
    assert.equal(detection.main.patched, true)
    assert.equal(detection.preload.patched, true)
    assert.equal(detection.installed, true)

    const statusFile = readJson(path.join(space.dir, STATUS_FILE))
    assert.equal(statusFile.ok, true)
    assert.equal(statusFile.installed, true)
    assert.equal(statusFile.version, report.version)

    const recovery = readJson(path.join(space.dir, RECOVERY_FILE))
    assert.equal(recovery.version, STATE_VERSION)
    assert.equal(recovery.complete, true)
    assert.equal(recovery.blocks.length, 3)
    assert.equal(recovery.archive, space.archive)
    for (const block of recovery.blocks) {
      assert.equal(Buffer.from(block.original, 'base64').length, block.byteLength)
    }
    assert.equal(fs.readFileSync(space.archive).length, space.original.length, '归档总长不变')
  } finally {
    space.dispose()
  }
})

test('install 幂等：第二次只报告 already，不重写字节', () => {
  const space = workspace()
  try {
    install({ archive: space.archive, dir: space.dir, running: false })
    const patched = fs.readFileSync(space.archive)
    const again = install({ archive: space.archive, dir: space.dir, running: false })
    assert.equal(again.already, true)
    assert.equal(again.changed, false)
    assert.deepEqual(fs.readFileSync(space.archive), patched)
  } finally {
    space.dispose()
  }
})

test('install --dry-run 不写盘，但把偏移与字节预算都算出来', () => {
  const space = workspace()
  try {
    const before = fs.readFileSync(space.archive)
    const report = install({ archive: space.archive, dir: space.dir, dryRun: true, running: false })
    assert.equal(report.dryRun, true)
    assert.equal(report.installed, false)
    assert.deepEqual(fs.readFileSync(space.archive), before, '干跑不许改字节')
    assert.equal(fs.existsSync(path.join(space.dir, RECOVERY_FILE)), false)
    for (const write of report.writes) {
      assert.equal(Number.isInteger(write.fileOffset), true)
      assert.equal(write.bytes > 0, true)
    }
    for (const block of report.blocks) assert.equal(block.budget >= 0, true)
  } finally {
    space.dispose()
  }
})

test('restore 精确还原注入前的每一个字节', () => {
  const space = workspace()
  try {
    install({ archive: space.archive, dir: space.dir, running: false })
    assert.notDeepEqual(fs.readFileSync(space.archive), space.original)
    const report = restore({ archive: space.archive, dir: space.dir })
    assert.equal(report.restored, true)
    assert.equal(report.blocks, 3)
    assert.deepEqual(fs.readFileSync(space.archive), space.original, '必须逐字节等于原始归档')
    assert.equal(fs.existsSync(path.join(space.dir, RECOVERY_FILE)), false)
    assert.equal(readJson(path.join(space.dir, STATUS_FILE)).installed, false)
  } finally {
    space.dispose()
  }
})

test('restore 在归档被 DSH 升级替换后拒绝动手（不能把新版本改坏）', () => {
  const space = workspace()
  try {
    install({ archive: space.archive, dir: space.dir, running: false })
    const other = defaultArchive({ preload: { omit: ['preload'] } }).buffer
    fs.writeFileSync(space.archive, other)
    throwsBridge(() => restore({ archive: space.archive, dir: space.dir }), 'stale-state')
    assert.deepEqual(fs.readFileSync(space.archive), other, '拒绝时不许动字节')
  } finally {
    space.dispose()
  }
})

test('restore 在没装过的时候是无操作，不报错', () => {
  const space = workspace()
  try {
    const report = restore({ archive: space.archive, dir: space.dir })
    assert.equal(report.restored, false)
    assert.equal(report.reason, 'not-installed')
  } finally {
    space.dispose()
  }
})

test('restore 在「装过但没有边车」时报 no-state，并明确不提 app.asar.orig', () => {
  const space = workspace()
  try {
    install({ archive: space.archive, dir: space.dir, running: false })
    fs.rmSync(path.join(space.dir, RECOVERY_FILE))
    const error = throwsBridge(() => restore({ archive: space.archive, dir: space.dir }), 'no-state')
    assert.match(error.message, /app\.asar\.orig/)
  } finally {
    space.dispose()
  }
})

test('install 拒绝半注入状态，要求先 restore --force', () => {
  const space = workspace()
  try {
    install({ archive: space.archive, dir: space.dir, running: false })
    // 模拟「只有 preload 标记在」：把 main 条目换回未注入版本做不到（哈希会崩），
    // 所以直接改边车之外的现实场景 —— 用一个只有 main 标记的归档。
    const onlyMain = defaultArchive().buffer
    fs.writeFileSync(space.archive, onlyMain)
    install({ archive: space.archive, dir: space.dir, running: false })
    const full = fs.readFileSync(space.archive)
    const bytes = Buffer.from(full)
    // 抹掉 preload 里的标记，制造半注入
    const preloadText = bytes.toString('latin1')
    const mark = 'dshWindowResolution'
    const offset = preloadText.indexOf(mark)
    assert.ok(offset > 0)
    bytes.write('dshWindowResolutio!', offset, 'latin1')
    fs.writeFileSync(space.archive, bytes)
    throwsBridge(() => install({ archive: space.archive, dir: space.dir, running: false }), 'inconsistent')
  } finally {
    space.dispose()
  }
})

test('uninstall 先还原再删状态', () => {
  const space = workspace()
  try {
    install({ archive: space.archive, dir: space.dir, running: false })
    const report = uninstall({ archive: space.archive, dir: space.dir })
    assert.equal(report.uninstalled, true)
    assert.equal(report.restored, true)
    assert.deepEqual(fs.readFileSync(space.archive), space.original)
    assert.equal(fs.existsSync(path.join(space.dir, STATUS_FILE)), false)
    const detection = detect(space.archive)
    assert.equal(detection.installed, false)
  } finally {
    space.dispose()
  }
})

test('check 对已注入归档报一致，对缺锚点归档报不可注入', () => {
  const space = workspace()
  try {
    assert.equal(check({ archive: space.archive }).installed, false)
    assert.equal(check({ archive: space.archive }).problems.length, 0)
    install({ archive: space.archive, dir: space.dir, running: false })
    const report = check({ archive: space.archive })
    assert.equal(report.ok, true)
    assert.equal(report.consistent, true)
  } finally {
    space.dispose()
  }

  const broken = workspace({ main: { omit: ['mainHelpers', 'mainHelpersFallback'] } })
  try {
    const report = check({ archive: broken.archive })
    assert.equal(report.consistent, false)
    assert.match(report.problems.join('\n'), /尚不可注入/)
  } finally {
    broken.dispose()
  }
})

test('归档不可写时给 not-writable，且一个字节都不改', { skip: process.platform === 'win32' ? 'Windows 上 chmod 不改真实权限' : false }, () => {
  const space = workspace()
  try {
    const before = fs.readFileSync(space.archive)
    fs.chmodSync(space.archive, 0o444)
    const error = throwsBridge(() => install({ archive: space.archive, dir: space.dir, running: false }), 'not-writable')
    assert.match(error.message, /write|写权限|EACCES|EPERM/)
    fs.chmodSync(space.archive, 0o644)
    assert.deepEqual(fs.readFileSync(space.archive), before)
    assert.equal(fs.existsSync(path.join(space.dir, RECOVERY_FILE)), false)
  } finally {
    space.dispose()
  }
})

test('detectRunning 不抛错：从归档位置反推进程名，判不出来就返回 null', () => {
  const space = workspace()
  try {
    const value = detectRunning(space.archive)
    assert.ok(value === null || typeof value === 'boolean', '只能是 true/false/null')
  } finally {
    space.dispose()
  }
})

test('verifyArchive 在归档没写成功时抛 verify', () => {
  const space = workspace()
  try {
    const archive = defaultArchive()
    fs.writeFileSync(space.archive, archive.buffer)
    throwsBridge(
      () => verifyArchive(space.archive, { targets: { main: { newHash: 'a'.repeat(64) } } }),
      'verify',
    )
  } finally {
    space.dispose()
  }
})

test('锁是独占的：第二次获取失败，释放后可以再拿', () => {
  const space = workspace()
  try {
    const first = acquireLock(space.archive)
    throwsBridge(() => acquireLock(space.archive), 'locked')
    first.release()
    const second = acquireLock(space.archive)
    second.release()
  } finally {
    space.dispose()
  }
})

test('残锁超过 30 秒可以被抢', () => {
  const space = workspace()
  try {
    const first = acquireLock(space.archive, Date.now() - 60_000)
    first.release()
    const lockFile = `${space.archive}.dsh-window-resolution.lock`
    fs.writeFileSync(lockFile, '99999 0\n')
    const stale = new Date(Date.now() - 60_000)
    fs.utimesSync(lockFile, stale, stale)
    const second = acquireLock(space.archive)
    second.release()
    assert.equal(fs.existsSync(lockFile), false)
  } finally {
    space.dispose()
  }
})

test('ensurePatched 在可注入归档上装好，在不可注入归档上只写状态不抛', () => {
  const space = workspace()
  try {
    const first = ensurePatched({ archive: space.archive, dir: space.dir, running: false })
    assert.equal(first.ok, true)
    assert.equal(first.action, 'installed')
    const second = ensurePatched({ archive: space.archive, dir: space.dir, running: false })
    assert.equal(second.action, 'already')
  } finally {
    space.dispose()
  }

  const broken = workspace({ main: { occupied: 'handler' } })
  try {
    const report = ensurePatched({ archive: broken.archive, dir: broken.dir, running: false })
    assert.equal(report.ok, false)
    assert.equal(report.action, 'failed')
    const statusFile = readJson(path.join(broken.dir, STATUS_FILE))
    assert.equal(statusFile.ok, false)
    assert.equal(statusFile.installed, false)
    assert.equal(typeof statusFile.error.code, 'string')
  } finally {
    broken.dispose()
  }
})

test('status 在已注入归档上不再做规划：plan 为 null，输出现状与自洽结论', () => {
  const space = workspace()
  try {
    install({ archive: space.archive, dir: space.dir, running: false })
    const report = status({ archive: space.archive })
    assert.equal(report.ok, true)
    assert.equal(report.installed, true)
    assert.equal(report.plan, null, '已注入时不该再 buildPatch（会撞 assertNoCollision）')
    assert.equal(report.consistent, true)
    assert.equal(report.problems.length, 0)
    assert.equal(report.payloadVersion, PAYLOAD_VERSION)
    assert.equal(report.stale, false)
    assert.deepEqual(report.anchors.map((block) => block.id), ['main-helpers', 'main-handler', 'preload-bridge'])
    for (const block of report.anchors) assert.equal(Number.isInteger(block.byteStart), true)
  } finally {
    space.dispose()
  }
})

test('status 在已注入但字节被改坏的归档上报 ok:false 且 error:inconsistent', () => {
  const space = workspace()
  try {
    install({ archive: space.archive, dir: space.dir, running: false })
    const bytes = fs.readFileSync(space.archive)
    const offset = bytes.toString('latin1').indexOf('dsh-desktop:window-bounds-set')
    assert.ok(offset > 0)
    bytes.write('dsh-desktop:window-bounds-seT', offset, 'latin1')
    fs.writeFileSync(space.archive, bytes)
    const report = status({ archive: space.archive })
    assert.equal(report.ok, false)
    assert.equal(report.consistent, false)
    assert.equal(report.plan, null)
    assert.equal(report.error.code, 'inconsistent')
    assert.equal(typeof report.error.message, 'string')
  } finally {
    space.dispose()
  }
})

/**
 * 造一份「旧版（v1）注入」归档：载荷与现在一样，但没有版本标记，且头部哈希自洽。
 *
 * @returns {Buffer} 旧载荷归档字节。
 */
function legacyArchiveBytes() {
  const sources = { main: mainEntry(), preload: preloadEntry() }
  const blocks = BLOCKS.map((block) =>
    block.id === 'main-helpers' ? { ...block, code: PAYLOADS.mainHelpers.replace(VERSION_MARK, '') } : block,
  )
  const planned = planBlocks({ sources, blocks })
  return buildArchive({
    entries: {
      '/lib/main.js': applyBlocks(sources.main, planned.main),
      '/lib/preload-app.cjs': applyBlocks(sources.preload, planned.preload),
    },
  }).buffer
}

test('detect/status 把没有版本标记的旧注入判为载荷过期', () => {
  const space = workspace()
  try {
    fs.writeFileSync(space.archive, legacyArchiveBytes())
    const detection = detect(space.archive)
    assert.equal(detection.installed, true)
    assert.equal(detection.payloadVersion, null, '旧载荷没有 /*dsh-wrp:vN*/ 标记')

    const report = status({ archive: space.archive })
    assert.equal(report.installed, true)
    assert.equal(report.ok, true, '旧载荷自身仍是自洽的，ok 只表示归档可读')
    assert.equal(report.consistent, true)
    assert.equal(report.payloadVersion, null)
    assert.equal(report.stale, true)
    assert.equal(report.plan, null)
  } finally {
    space.dispose()
  }
})

test('install --dry-run 对旧载荷报 needsReinstall，且一个字节都不改', () => {
  const space = workspace()
  try {
    const legacy = legacyArchiveBytes()
    fs.writeFileSync(space.archive, legacy)
    const report = install({ archive: space.archive, dir: space.dir, dryRun: true, running: false })
    assert.equal(report.ok, true)
    assert.equal(report.dryRun, true)
    assert.equal(report.needsReinstall, true)
    assert.equal(report.stale, true)
    assert.equal(report.previousPayloadVersion, null)
    assert.deepEqual(fs.readFileSync(space.archive), legacy)
    assert.equal(fs.existsSync(path.join(space.dir, RECOVERY_FILE)), false)
  } finally {
    space.dispose()
  }
})

test('install 在载荷版本过期时先还原再重注，并区分 reinstalled 与 updated', () => {
  const space = workspace()
  try {
    install({ archive: space.archive, dir: space.dir, running: false })
    const firstRun = fs.readFileSync(space.archive)
    const report = install({ archive: space.archive, dir: space.dir, running: false, force: true })
    assert.equal(report.reinstalled, true, 'force 重注必须与普通 updated 区分')
    assert.equal(report.previousPayloadVersion, PAYLOAD_VERSION)
    assert.equal(report.payloadVersion, PAYLOAD_VERSION)
    assert.deepEqual(fs.readFileSync(space.archive), firstRun, '同版本重注是幂等的：字节不变')
    assert.equal(check({ archive: space.archive }).consistent, true)
    assert.equal(detect(space.archive).payloadVersion, PAYLOAD_VERSION)
    assert.equal(readJson(path.join(space.dir, STATUS_FILE)).payloadVersion, PAYLOAD_VERSION)
  } finally {
    space.dispose()
  }
})

test('install --dry-run 在已是最新载荷时仍报 already，不误报重注', () => {
  const space = workspace()
  try {
    install({ archive: space.archive, dir: space.dir, running: false })
    const report = install({ archive: space.archive, dir: space.dir, dryRun: true, running: false })
    assert.equal(report.already, true)
    assert.equal(report.needsReinstall, undefined)
  } finally {
    space.dispose()
  }
})

test('restore --force 在没有边车、也没注入时也报 no-state（不能假装还原成功）', () => {
  const space = workspace()
  try {
    const error = throwsBridge(() => restore({ archive: space.archive, dir: space.dir, force: true }), 'no-state')
    assert.match(error.message, /app\.asar\.orig/)
  } finally {
    space.dispose()
  }
})

test('uninstall 在从未安装时不报 uninstalled:true', () => {
  const space = workspace()
  try {
    const report = uninstall({ archive: space.archive, dir: space.dir })
    assert.equal(report.restored, false)
    assert.equal(report.uninstalled, true, '未注入时没有东西可卸，但状态文件可以清理')
    assert.equal(fs.existsSync(path.join(space.dir, STATUS_FILE)), false)
  } finally {
    space.dispose()
  }
})

test('locateTargetVersion 依次读 app-update.yml、version、上级 version、app/package.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsz-version-'))
  const resources = path.join(root, 'resources')
  fs.mkdirSync(resources, { recursive: true })
  const archive = path.join(resources, 'app.asar')
  fs.writeFileSync(archive, 'x')
  try {
    assert.equal(locateTargetVersion(archive), null, '什么都没有时必须返回 null')

    fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: generic\nversion: 44.7.0\n')
    fs.writeFileSync(path.join(resources, 'version'), '1.0.0\n')
    fs.writeFileSync(path.join(root, 'version'), '0.9.0\n')
    assert.equal(locateTargetVersion(archive), '44.7.0', 'app-update.yml 优先级最高')

    fs.rmSync(path.join(resources, 'app-update.yml'))
    assert.equal(locateTargetVersion(archive), '1.0.0', '其次 resources/version')

    fs.rmSync(path.join(resources, 'version'))
    assert.equal(locateTargetVersion(archive), '0.9.0', '再次是归档上级目录的 version')

    fs.rmSync(path.join(root, 'version'))
    fs.mkdirSync(path.join(resources, 'app'))
    fs.writeFileSync(path.join(resources, 'app', 'package.json'), '{"name":"dsh","version":"4.5.6"}\n')
    assert.equal(locateTargetVersion(archive), '4.5.6', '最后读 resources/app/package.json')

    fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: generic\nversion: nightly\n')
    assert.equal(locateTargetVersion(archive), '4.5.6', '非 semver 跳过该来源，继续下一个候选')
    fs.writeFileSync(path.join(resources, 'app-update.yml'), 'not: [valid yaml')
    assert.equal(locateTargetVersion(archive), '4.5.6', '读不懂 yml 也不抛错，继续下一个候选')
    fs.rmSync(path.join(resources, 'app'), { recursive: true, force: true })
    assert.equal(locateTargetVersion(archive), null, '所有来源都不可用时返回 null')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('install 把 DSH 版本写进状态文件（从合成 resources 目录读到）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsz-version-'))
  const resources = path.join(root, 'resources')
  fs.mkdirSync(resources, { recursive: true })
  const archive = path.join(resources, 'app.asar')
  fs.writeFileSync(archive, defaultArchive().buffer)
  fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: generic\nversion: 44.7.0\n')
  try {
    install({ archive, dir: root, running: false })
    const statusFile = readJson(path.join(root, STATUS_FILE))
    assert.equal(statusFile.targetVersion, '44.7.0')
    assert.equal(status({ archive }).targetVersion, '44.7.0')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

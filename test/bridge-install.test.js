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
  ensurePatched,
  install,
  restore,
  status,
  uninstall,
  verifyArchive,
} from '../lib/bridge/install.js'
import { defaultArchive } from './helpers/asar-fixture.js'

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

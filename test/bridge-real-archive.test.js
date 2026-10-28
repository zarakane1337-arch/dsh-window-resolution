import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { findEntry, locateArchive, readArchive, readEntry } from '../lib/bridge/asar.js'
import { check, detect, install, status } from '../lib/bridge/install.js'
import { PAYLOAD_VERSION, buildPatch, isAscii, locatePayloads } from '../lib/bridge/patch.js'
import { run } from '../lib/bridge-cli.mjs'

/**
 * 真实归档只读测试：找不到归档就整组跳过（CI/别人的机器上本来就没有）。
 *
 * 本机归档可能**已经注入**（开发机反复 install 过），也可能还没注入；两种状态都是
 * 合法现场，所以这里先 `detect()` 再按状态断言，绝不假定「未注入」。整组测试只读：
 * 任何一步都不得改写归档（每条用例前后都比对整文件 sha256）。
 *
 * @returns {string | null} 真实 app.asar 路径。
 */
function realArchive() {
  try {
    const archive = locateArchive({ env: process.env })
    return fs.existsSync(archive) ? archive : null
  } catch {
    return null
  }
}

/**
 * 整文件 sha256，用于证明确实没写盘。
 *
 * @param {string} file - 文件路径。
 * @returns {string} 十六进制哈希。
 */
function fileHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

const ASAR = realArchive()
const skip = ASAR ? false : '本机找不到 DeepSeek Harness 的 app.asar'
const detection = ASAR ? detect(ASAR) : null

test('真实归档：status 只读报告与当前注入状态一致（已注入不再规划，未注入给出预算）', { skip }, () => {
  const before = fileHash(ASAR)
  const report = status({ archive: ASAR })
  assert.equal(report.installed, detection.installed, 'status.installed 必须与 detect 一致')
  assert.equal(typeof report.targetVersion === 'string' || report.targetVersion === null, true)

  if (detection.installed) {
    assert.equal(report.plan, null, '已注入时不该再 buildPatch（会撞 assertNoCollision）')
    assert.equal(report.consistent, true, `已注入归档必须自洽：${report.problems.join('；')}`)
    assert.equal(report.ok, true)
    assert.deepEqual(report.anchors.map((block) => block.id), ['main-helpers', 'main-handler', 'preload-bridge'])
    for (const block of report.anchors) assert.equal(Number.isInteger(block.byteStart), true)
    assert.equal(report.stale, detection.payloadVersion !== PAYLOAD_VERSION)
    assert.equal(report.payloadVersion, detection.payloadVersion)
  } else {
    assert.equal(report.plan.ok, true, `规划应通过：${JSON.stringify(report.plan.error || {})}`)
    assert.equal(report.plan.blocks.length, 3)
    for (const block of report.plan.blocks) {
      assert.equal(block.budget >= 0, true, `${block.id} 余量不能为负`)
      assert.equal(isAscii(Buffer.from(block.id, 'utf8').toString('latin1')), true)
    }
  }
  assert.equal(fileHash(ASAR), before, 'status 绝不能写盘')
})

test('真实归档：install --dry-run 只读；已注入时报 already/过期，未注入时偏移落在文件范围内', { skip }, () => {
  const before = fileHash(ASAR)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsz-real-'))
  try {
    const report = install({ archive: ASAR, dryRun: true, running: false, dir })
    if (detection.installed && detection.payloadVersion === PAYLOAD_VERSION) {
      assert.equal(report.already, true, '已注入同版本载荷时干跑应直接报 already')
    } else {
      assert.equal(report.dryRun, true)
      if (detection.installed) {
        assert.equal(report.already === true || report.needsReinstall === true, true)
        assert.equal(report.needsReinstall, true, '旧载荷必须被判为需重注')
        assert.equal(report.stale, true)
      } else {
        const size = fs.statSync(ASAR).size
        for (const write of report.writes) {
          assert.equal(Number.isInteger(write.fileOffset), true)
          assert.equal(write.fileOffset >= 0, true)
          assert.equal(write.fileOffset + write.bytes <= size, true, `${write.label} 越界`)
        }
      }
    }
    assert.equal(fs.existsSync(path.join(dir, '.dsh-window-resolution.restore.json')), false, '干跑不落边车')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(fileHash(ASAR), before, '干跑绝不能写盘')
})

test('真实归档：载荷区定位准确，等长替换不改变条目长度', { skip }, () => {
  const loaded = readArchive(ASAR)
  const mainText = readEntry(loaded, findEntry(loaded.header, '/lib/main.js')).toString('utf8')
  const preloadText = readEntry(loaded, findEntry(loaded.header, '/lib/preload-app.cjs')).toString('utf8')

  if (detection.installed) {
    const located = locatePayloads({ main: mainText, preload: preloadText })
    assert.deepEqual(located.map((block) => block.id), ['main-helpers', 'main-handler', 'preload-bridge'])
    for (const block of located) {
      const source = block.entry === '/lib/main.js' ? mainText : preloadText
      const start = Buffer.from(source, 'utf8').subarray(block.byteStart, block.byteStart + block.codeLength)
      assert.equal(isAscii(start.toString('latin1')), true, `${block.id} 已注入区必须是 ASCII`)
    }
    assert.match(mainText, /dsh-desktop:window-bounds-set/)
    assert.match(preloadText, /dshWindowResolution/)
    assert.equal(check({ archive: ASAR }).consistent, true)
  } else {
    const built = buildPatch(loaded)
    for (const block of built.blocks) {
      assert.equal(isAscii(block.original.toString('latin1')), true, `${block.id} 的原始区块不是 ASCII`)
      assert.equal(block.codeLength <= block.byteLength, true)
    }
    const mainPatched = built.writes.find((write) => write.label === '/lib/main.js').buffer.toString('utf8')
    const preloadPatched = built.writes.find((write) => write.label === '/lib/preload-app.cjs').buffer.toString('utf8')
    assert.equal(mainPatched.includes('dsh-desktop:window-bounds-set'), true)
    assert.equal(mainPatched.length, mainText.length, '等长替换：字符数不变（全 ASCII 区域）')
    assert.equal(Buffer.byteLength(preloadPatched, 'utf8'), built.targets.preload.size)
    assert.equal(preloadPatched.includes('dshWindowResolution'), true)
  }
})

test('真实归档：check 的退出码随注入状态变化，且不误报损坏', { skip }, () => {
  const before = fileHash(ASAR)
  const report = check({ archive: ASAR })
  const { code, lines } = run(['check', ASAR])
  assert.equal(report.consistent, true, `check 不应报损坏：${report.problems.join('；')}`)
  assert.match(lines.join('\n'), /自洽：是/)
  assert.equal(code, detection.installed ? 0 : 2)
  assert.equal(fileHash(ASAR), before, 'check 绝不能写盘')
})

test('真实归档：restore 在无边车目录下不会碰归档（已注入报 no-state，未注入报无事可做）', { skip }, () => {
  const before = fileHash(ASAR)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsz-real-'))
  try {
    const { code, lines } = run(['restore', ASAR], { dir })
    assert.match(lines.join('\n'), /未注入，无需还原|no-state|找不到回滚边车/)
    assert.equal(code, detection.installed ? 1 : 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(fileHash(ASAR), before, 'restore 失败时更不能写盘')
})

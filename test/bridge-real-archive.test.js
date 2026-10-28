import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { findEntry, locateArchive, readArchive, readEntry } from '../lib/bridge/asar.js'
import { install, status } from '../lib/bridge/install.js'
import { buildPatch, isAscii } from '../lib/bridge/patch.js'
import { run } from '../lib/bridge-cli.mjs'

/**
 * 真实归档只读测试：找不到归档就整组跳过（CI/别人的机器上本来就没有）。
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

test('真实归档：status 只读报告能给出锚点、字节预算与 dwc 共存情况', { skip }, () => {
  const before = fileHash(ASAR)
  const report = status({ archive: ASAR })
  assert.equal(report.installed, false, '本机尚未注入，status 应报未注入')
  assert.equal(report.dwc, true, '本机装了 dwc，必须能识别出来')
  assert.equal(report.plan.ok, true, `规划应通过：${JSON.stringify(report.plan.error || {})}`)
  assert.equal(report.plan.blocks.length, 3)
  for (const block of report.plan.blocks) {
    assert.equal(block.budget >= 0, true, `${block.id} 余量不能为负`)
    assert.equal(isAscii(Buffer.from(block.id, 'utf8').toString('latin1')), true)
  }
  assert.equal(fileHash(ASAR), before, 'status 绝不能写盘')
})

test('真实归档：干跑算出的写入偏移与字节预算都落在文件范围内', { skip }, () => {
  const before = fileHash(ASAR)
  const report = install({ archive: ASAR, dryRun: true, running: false, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'rsz-real-')) })
  assert.equal(report.dryRun, true)
  const size = fs.statSync(ASAR).size
  for (const write of report.writes) {
    assert.equal(Number.isInteger(write.fileOffset), true)
    assert.equal(write.fileOffset >= 0, true)
    assert.equal(write.fileOffset + write.bytes <= size, true, `${write.label} 越界`)
  }
  assert.equal(fileHash(ASAR), before, '干跑绝不能写盘')
})

test('真实归档：三块载荷等长替换后条目长度不变、仍是 ASCII、且不覆盖 dwc 的标记', { skip }, () => {
  const loaded = readArchive(ASAR)
  const built = buildPatch(loaded)
  const mainText = readEntry(loaded, findEntry(loaded.header, '/lib/main.js')).toString('utf8')
  const dwcAt = mainText.indexOf('DWC=[[')
  assert.equal(dwcAt >= 0, true, '真实 main.js 里应有 dwc 标记')

  for (const patch of built.blocks) {
    if (patch.target !== 'main') continue
    const end = patch.byteStart + patch.byteLength
    assert.equal(dwcAt >= 0 && dwcAt >= patch.byteStart && dwcAt < end, false, `${patch.id} 盖住了 dwc 注入区`)
  }
  for (const block of built.blocks) {
    assert.equal(isAscii(block.original.toString('latin1')), true, `${block.id} 的原始区块不是 ASCII`)
    assert.equal(block.codeLength <= block.byteLength, true)
  }
  // 拼出来的条目必须仍然含有双方标记，长度一个字节都不差。
  const mainPatched = built.writes.find((write) => write.label === '/lib/main.js').buffer.toString('utf8')
  const preloadPatched = built.writes.find((write) => write.label === '/lib/preload-app.cjs').buffer.toString('utf8')
  assert.equal(mainPatched.includes('DWC=[['), true)
  assert.equal(mainPatched.includes('dsh-desktop:window-bounds-set'), true)
  assert.equal(mainPatched.length, mainText.length, '等长替换：字符数不变（全 ASCII 区域）')
  assert.equal(Buffer.byteLength(preloadPatched, 'utf8'), built.targets.preload.size)
  assert.equal(preloadPatched.includes('dshWindowControl'), true, 'preload 里 dwc 的桥必须还在')
  assert.equal(preloadPatched.includes('dshWindowResolution'), true)
})

test('真实归档：check 在未注入时报 2 且不误报损坏', { skip }, () => {
  const { code, lines } = run(['check', ASAR])
  assert.equal(code, 2)
  assert.match(lines.join('\n'), /自洽：是/)
})

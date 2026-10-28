import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { run } from '../lib/bridge-cli.mjs'
import { defaultArchive } from './helpers/asar-fixture.js'

/**
 * 铺一份合成归档 + 空的 profile 目录。
 *
 * @param {{main?: object, preload?: object}} [options] - 夹具选项。
 * @returns {{dir: string, archive: string, original: Buffer, dispose: () => void}} 工作区。
 */
function workspace(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsz-cli-'))
  const dir = path.join(root, 'desktop')
  fs.mkdirSync(dir, { recursive: true })
  const archive = path.join(root, 'app.asar')
  const original = defaultArchive({ main: options.main, preload: options.preload }).buffer
  fs.writeFileSync(archive, original)
  return { root, dir, archive, original, dispose: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('status：未注入时退出码 2，并列出三块锚点与字节预算', () => {
  const space = workspace()
  try {
    const { code, lines } = run(['status', space.archive], { dir: space.dir })
    assert.equal(code, 2)
    const text = lines.join('\n')
    assert.match(text, /状态：未注入/)
    assert.match(text, /main-helpers/)
    assert.match(text, /main-handler/)
    assert.match(text, /preload-bridge/)
    assert.match(text, /余量 \d+ B/)
  } finally {
    space.dispose()
  }
})

test('install --dry-run：退出码 0、打印将写入的偏移，且归档字节不变', () => {
  const space = workspace()
  try {
    const before = fs.readFileSync(space.archive)
    const { code, lines } = run(['install', '--dry-run', space.archive], { dir: space.dir, running: false })
    assert.equal(code, 0)
    const text = lines.join('\n')
    assert.match(text, /干跑/)
    assert.match(text, /写入 header @16/)
    assert.match(text, /写入 \/lib\/main\.js @\d+/)
    assert.deepEqual(fs.readFileSync(space.archive), before)
  } finally {
    space.dispose()
  }
})

test('install → status → restore：一条龙的退出码与字节还原', () => {
  const space = workspace()
  try {
    const installed = run(['install', space.archive], { dir: space.dir, running: false })
    assert.equal(installed.code, 0)
    assert.match(installed.lines.join('\n'), /已注入/)

    const status = run(['status', space.archive], { dir: space.dir })
    assert.equal(status.code, 0)
    assert.match(status.lines.join('\n'), /状态：已注入/)

    const restored = run(['restore', space.archive], { dir: space.dir })
    assert.equal(restored.code, 0)
    assert.match(restored.lines.join('\n'), /已还原/)
    assert.deepEqual(fs.readFileSync(space.archive), space.original)
  } finally {
    space.dispose()
  }
})

test('status 在 dwc 占用了首选锚点时自动退到备用候选，并明说检测到 dwc', () => {
  const space = workspace({ main: { occupied: 'helpers' } })
  try {
    const { code, lines } = run(['status', space.archive], { dir: space.dir })
    assert.equal(code, 2)
    const text = lines.join('\n')
    assert.match(text, /dwc：检测到/)
    assert.match(text, /main-helpers .* 锚点 p3-harness-home/)
  } finally {
    space.dispose()
  }
})

test('check：未注入→2，已注入→0，缺锚点→1', () => {
  const space = workspace()
  try {
    assert.equal(run(['check', space.archive], { dir: space.dir }).code, 2)
    run(['install', space.archive], { dir: space.dir, running: false })
    assert.equal(run(['check', space.archive], { dir: space.dir }).code, 0)
  } finally {
    space.dispose()
  }

  const broken = workspace({ main: { omit: ['mainHelpers', 'mainHelpersFallback'] } })
  try {
    const { code, lines } = run(['check', broken.archive], { dir: broken.dir })
    assert.equal(code, 1)
    assert.match(lines.join('\n'), /尚不可注入/)
  } finally {
    broken.dispose()
  }
})

test('uninstall：还原并清状态，再 status 回到未注入', () => {
  const space = workspace()
  try {
    run(['install', space.archive], { dir: space.dir, running: false })
    const { code, lines } = run(['uninstall', space.archive], { dir: space.dir })
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /已还原/)
    assert.deepEqual(fs.readFileSync(space.archive), space.original)
    assert.equal(run(['status', space.archive], { dir: space.dir }).code, 2)
  } finally {
    space.dispose()
  }
})

test('restore 在从未安装时是幂等的无操作', () => {
  const space = workspace()
  try {
    const { code, lines } = run(['restore', space.archive], { dir: space.dir })
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /未注入，无需还原/)
  } finally {
    space.dispose()
  }
})

test('未知子命令给用法并以 2 退出；--help 以 0 退出', () => {
  const unknown = run(['nope'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.lines.join('\n'), /未知子命令/)
  const help = run(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.lines.join('\n'), /用法/)
})

test('归档不存在时 CLI 用 1 退出并说出原因', () => {
  const { code, lines } = run(['status', path.join(os.tmpdir(), 'no-such-archive.asar')])
  assert.equal(code, 1)
  assert.match(lines.join('\n'), /✖/)
})

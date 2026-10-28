import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { run } from '../lib/bridge-cli.mjs'
import { BLOCKS, PAYLOADS, VERSION_MARK, applyBlocks, planBlocks } from '../lib/bridge/patch.js'
import { buildArchive, defaultArchive, mainEntry, preloadEntry } from './helpers/asar-fixture.js'

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

test('status 在首选锚点装不下载荷时自动退到备用候选', () => {
  const space = workspace({ main: { shortHelpers: true } })
  try {
    const { code, lines } = run(['status', space.archive], { dir: space.dir })
    assert.equal(code, 2)
    const text = lines.join('\n')
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

test('restore 在从未安装时是幂等的无操作，但按文档用退出码 2', () => {
  const space = workspace()
  try {
    const { code, lines } = run(['restore', space.archive], { dir: space.dir })
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /未注入，无需还原/)
  } finally {
    space.dispose()
  }
})

test('uninstall 在从未安装时无操作，退出码 2', () => {
  const space = workspace()
  try {
    const { code, lines } = run(['uninstall', space.archive], { dir: space.dir })
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /未注入，已清理状态文件/)
  } finally {
    space.dispose()
  }
})

test('status 在已注入时打印自洽/载荷版本/锚点，而不是拿规划撞自己的标识符', () => {
  const space = workspace()
  try {
    run(['install', space.archive], { dir: space.dir, running: false })
    const { code, lines } = run(['status', space.archive], { dir: space.dir })
    assert.equal(code, 0)
    const text = lines.join('\n')
    assert.match(text, /状态：已注入/)
    assert.match(text, /自洽：是/)
    assert.match(text, /载荷版本：2（当前 v2）/)
    assert.match(text, /已注入 main-helpers\s+\/lib\/main\.js @\d+/)
    assert.doesNotMatch(text, /规划：失败/)
  } finally {
    space.dispose()
  }
})

test('status 在已注入但字节不一致时以 2 退出并打印错误', () => {
  const space = workspace()
  try {
    run(['install', space.archive], { dir: space.dir, running: false })
    const bytes = fs.readFileSync(space.archive)
    const offset = bytes.toString('latin1').indexOf('dsh-desktop:window-bounds-set')
    bytes.write('dsh-desktop:window-bounds-seT', offset, 'latin1')
    fs.writeFileSync(space.archive, bytes)
    const { code, lines } = run(['status', space.archive], { dir: space.dir })
    assert.equal(code, 2)
    const text = lines.join('\n')
    assert.match(text, /自洽：否/)
    assert.match(text, /错误：inconsistent/)
  } finally {
    space.dispose()
  }
})

test('status 展示从 app-update.yml 读到的 DSH 版本', () => {
  const space = workspace()
  try {
    fs.writeFileSync(path.join(space.root, 'app-update.yml'), 'provider: generic\nversion: 44.7.0\n')
    const { lines } = run(['status', space.archive], { dir: space.dir })
    assert.match(lines.join('\n'), /DSH 版本：44\.7\.0/)
  } finally {
    space.dispose()
  }
})

test('install --dry-run 对旧载荷提示版本过期，退出码 0 且不改字节', () => {
  const space = workspace()
  const sources = { main: mainEntry(), preload: preloadEntry() }
  const blocks = BLOCKS.map((block) =>
    block.id === 'main-helpers' ? { ...block, code: PAYLOADS.mainHelpers.replace(VERSION_MARK, '') } : block,
  )
  const planned = planBlocks({ sources, blocks })
  const legacy = buildArchive({
    entries: {
      '/lib/main.js': applyBlocks(sources.main, planned.main),
      '/lib/preload-app.cjs': applyBlocks(sources.preload, planned.preload),
    },
  }).buffer
  fs.writeFileSync(space.archive, legacy)
  try {
    const { code, lines } = run(['install', '--dry-run', space.archive], { dir: space.dir, running: false })
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /载荷版本过期：v1 → 当前 v2/)
    assert.deepEqual(fs.readFileSync(space.archive), legacy, '干跑不许改字节')
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
  assert.match(help.lines.join('\n'), /self-heal/, 'self-heal 必须出现在用法里')
  assert.match(help.lines.join('\n'), /无事可做/, '退出码 2 的含义要写清楚')
})

test('归档不存在时 CLI 用 1 退出并说出原因', () => {
  const { code, lines } = run(['status', path.join(os.tmpdir(), 'no-such-archive.asar')])
  assert.equal(code, 1)
  assert.match(lines.join('\n'), /✖/)
})

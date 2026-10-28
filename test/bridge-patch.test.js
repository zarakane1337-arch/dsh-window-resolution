import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readArchive, sha256 } from '../lib/bridge/asar.js'
import { BridgeError } from '../lib/bridge/error.js'
import {
  BLOCKS,
  PAYLOADS,
  PAYLOAD_VERSION,
  TARGETS,
  VERSION_MARK,
  applyBlocks,
  assertNoCollision,
  assertSymbols,
  buildPatch,
  commentRun,
  detectPayloadVersion,
  findOccupiedMarker,
  isAscii,
  locatePayloads,
  planAnchor,
  planBlocks,
  selectAnchor,
} from '../lib/bridge/patch.js'
import { FIXTURE_ANCHORS, defaultArchive, mainEntry, preloadEntry } from './helpers/asar-fixture.js'

/**
 * 断言某段代码抛出指定错误码的 {@link BridgeError}。
 *
 * @param {() => unknown} fn - 待执行代码。
 * @param {string} code - 期望的错误码。
 * @param {RegExp} [pattern] - 额外的消息匹配。
 * @returns {BridgeError} 捕获到的错误。
 */
function throwsBridge(fn, code, pattern) {
  let caught
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof BridgeError, `应抛 BridgeError，实际 ${caught && caught.stack}`)
  assert.equal(caught.code, code)
  if (pattern) assert.match(caught.message, pattern)
  return caught
}

test('三个载荷全是 ASCII，且不含顶层重名标识符', () => {
  for (const [name, code] of Object.entries(PAYLOADS)) {
    assert.equal(isAscii(code), true, `${name} 必须全 ASCII`)
    assert.equal(Buffer.byteLength(code, 'utf8'), code.length)
  }
  assert.match(PAYLOADS.mainHelpers, /^const RSZ=/)
  assert.match(PAYLOADS.mainHelpers, /\/\*dsh-wrp:v2\*\//, '载荷必须带版本标记，供重注判定')
  assert.equal(PAYLOAD_VERSION, 2)
  assert.equal(VERSION_MARK, '/*dsh-wrp:v2*/')
  assert.equal(detectPayloadVersion(PAYLOADS.mainHelpers), 2)
  assert.equal(detectPayloadVersion('const RSZ={F:1};'), null, '旧载荷没有标记就应判为未知版本')
  assert.match(PAYLOADS.mainHandler, /dsh-desktop:window-bounds-set/)
  assert.match(PAYLOADS.mainHandler, /^ipcMain\.handle\("dsh-desktop:window-bounds-set"/)
  assert.match(PAYLOADS.mainHandler, /w\.isFullScreen\(\)/)
  assert.match(PAYLOADS.mainHandler, /w\.setFullScreen\(false\)/)
  assert.match(PAYLOADS.mainHandler, /await Q\(c=>w\.once\("leave-full-screen",c\)\)/)
  assert.match(PAYLOADS.mainHandler, /w\.isMaximized\(\)/)
  assert.match(PAYLOADS.mainHandler, /w\.unmaximize\(\)/)
  assert.match(PAYLOADS.mainHandler, /await Q\(c=>w\.once\("unmaximize",c\)\)/)
  assert.match(PAYLOADS.mainHandler, /setTimeout\(r,400\)/, '等待窗口状态变化必须有 400ms 兜底')
  assert.match(PAYLOADS.mainHandler, /getDisplayMatching/)
  assert.match(PAYLOADS.mainHandler, /Math\.max\(200,Math\.min\(16384,/, '钳制必须用工约 MIN_SIDE/MAX_SIDE')
  assert.doesNotMatch(PAYLOADS.mainHandler, /520|600/, '不得再固化 DSH 窗口最小尺寸')
  assert.match(PAYLOADS.mainHandler, /setBounds\(/)
  assert.match(PAYLOADS.preloadBridge, /exposeInMainWorld\("dshWindowResolution"/)
  assert.match(PAYLOADS.preloadBridge, /v:1/)
  assert.match(PAYLOADS.preloadBridge, /getState/)
})

test('载荷不含会破坏 ASCII/长度的字符：没有引号外的中文、没有换行', () => {
  for (const [name, code] of Object.entries(PAYLOADS)) {
    assert.equal(code.includes('\n'), false, `${name} 不能带换行`)
    assert.equal(/[^\x20-\x7e]/.test(code), false, `${name} 只能包含可打印 ASCII`)
  }
})

test('isAscii 对中文与 emoji 返回 false', () => {
  assert.equal(isAscii('abc'), true)
  assert.equal(isAscii('a中'), false)
  assert.equal(isAscii(''), true)
  assert.equal(isAscii(null), false)
})

test('commentRun 从注释起点向右吃掉连续注释与空白，停在下一个语句前', () => {
  const source = mainEntry()
  const index = source.indexOf(FIXTURE_ANCHORS.mainHelpers)
  const range = commentRun(source, index)
  const text = source.slice(range.charStart, range.charEnd)
  assert.match(text, /^\/\*\*\n\* Compare two raw configs/)
  assert.match(text, /\*\/\s*$/)
  assert.equal(source.slice(range.charEnd).startsWith('function equalExceptVolatile'), true)
})

test('commentRun 对行注释连续段同样有效（preload 的 region + JSDoc）', () => {
  const source = preloadEntry()
  const index = source.indexOf(FIXTURE_ANCHORS.preload)
  const range = commentRun(source, index)
  const text = source.slice(range.charStart, range.charEnd)
  assert.match(text, /^\/\/#region lib\/types\/preload-platform\.js/)
  assert.match(text, /Marks the document root/)
  assert.match(text, /\/\*\*[\s\S]*\*\/\s*$/)
  assert.equal(source.slice(range.charEnd).startsWith('function markDocumentPlatform'), true)
})

test('commentRun 拒绝不在注释上的锚点', () => {
  throwsBridge(() => commentRun('function x() {}', 0), 'anchor-missing')
})

test('planAnchor 要求锚点唯一：重复出现就失败', () => {
  const source = `${FIXTURE_ANCHORS.mainHandler}\nconst a = 1;\n${FIXTURE_ANCHORS.mainHandler}\nconst b = 2;`
  throwsBridge(
    () => planAnchor(source, { id: 'dup', text: FIXTURE_ANCHORS.mainHandler }, PAYLOADS.mainHandler),
    'anchor-duplicated',
  )
})

test('planAnchor 在注释太短时拒绝，并报出两个长度', () => {
  const source = '/** 短注释 */\nconst a = 1;\n'
  const error = throwsBridge(
    () => planAnchor(source, { id: 'short', text: '/** 短注释' }, PAYLOADS.mainHandler),
    'payload-too-long',
  )
  assert.match(error.message, new RegExp(String(PAYLOADS.mainHandler.length)))
})

test('planAnchor 拒绝非 ASCII 载荷', () => {
  throwsBridge(
    () => planAnchor('/**\n* 足够长的注释填充填充填充填充填充填充填充填充填充填充 */\n', { id: 'cn', text: '/**\n* 足够长' }, 'const 中文=1;'),
    'payload-not-ascii',
  )
})

test('planAnchor 拒绝压到别的插件注入区的候选（dwc 标记在注释内）', () => {
  const source = mainEntry({ occupied: 'handler' })
  const index = source.indexOf(FIXTURE_ANCHORS.mainHandler)
  assert.ok(index >= 0)
  const error = throwsBridge(
    () => planAnchor(source, { id: 'handler', text: FIXTURE_ANCHORS.mainHandler }, PAYLOADS.mainHandler, TARGETS.main.markers),
    'anchor-occupied',
  )
  assert.match(error.message, /DWC=\[\[/)
})

test('findOccupiedMarker 只报区间内的标记，区间外的不算', () => {
  const source = 'const P=1; /* DWC=[[ */\n\n/** keeper */\n'
  const range = { byteStart: source.indexOf('/** keeper'), byteLength: 13 }
  assert.equal(findOccupiedMarker(source, range, TARGETS.main.markers), null)
  const overlapping = { byteStart: 0, byteLength: source.length }
  assert.deepEqual(findOccupiedMarker(source, overlapping, TARGETS.main.markers), {
    marker: 'DWC=[[',
    byteOffset: 14,
  })
})

test('selectAnchor 主候选缺失时退到第二个候选', () => {
  const source = mainEntry({ omit: ['mainHelpers'] })
  const spec = BLOCKS.find((block) => block.id === 'main-helpers')
  const planned = selectAnchor(source, spec, TARGETS.main.markers)
  assert.equal(planned.anchor, 'p3-harness-home')
  assert.equal(planned.byteLength >= spec.code.length, true)
})

test('selectAnchor 全部候选都不可用时报出每个候选的原因', () => {
  const source = mainEntry({ omit: ['mainHelpers', 'mainHelpersFallback'] })
  const spec = BLOCKS.find((block) => block.id === 'main-helpers')
  const error = throwsBridge(() => selectAnchor(source, spec, TARGETS.main.markers), 'anchor-missing')
  assert.equal(error.details.reasons.length, 2)
  assert.match(error.details.reasons[0], /锚点不存在/)
})

test('assertSymbols 缺符号时失败，并列出缺了哪些', () => {
  throwsBridge(
    () => assertSymbols('import { ipcMain } from "electron";', TARGETS.main),
    'symbol-missing',
    /BrowserWindow/,
  )
  assertSymbols(mainEntry(), TARGETS.main)
  assertSymbols(preloadEntry(), TARGETS.preload)
})

test('assertNoCollision 拒绝与目标源码重名的顶层 const', () => {
  throwsBridge(() => assertNoCollision('const RSZ = {};', 'const RSZ={};'), 'symbol-missing', /RSZ/)
  assertNoCollision('function other() {}', 'const RSZ={};')
})

test('planBlocks 在默认夹具上规划出三块、分属两个条目', () => {
  const planned = planBlocks({ sources: { main: mainEntry(), preload: preloadEntry() } })
  assert.deepEqual(Object.keys(planned), ['main', 'preload'])
  assert.deepEqual(planned.main.map((block) => block.id), ['main-helpers', 'main-handler'])
  assert.deepEqual(planned.preload.map((block) => block.id), ['preload-bridge'])
  assert.deepEqual(planned.main.map((block) => block.anchor), ['p2-config-compare', 'p1-file-replace'])
  for (const block of [...planned.main, ...planned.preload]) {
    assert.equal(block.padding >= 0, true)
    assert.equal(block.padding, block.byteLength - block.codeLength)
  }
})

test('applyBlocks 等长替换：长度不变、载荷在起点、余量补空格', () => {
  const source = mainEntry()
  const planned = planBlocks({ sources: { main: source, preload: preloadEntry() } })
  const patched = applyBlocks(source, planned.main)
  assert.equal(Buffer.byteLength(patched, 'utf8'), Buffer.byteLength(source, 'utf8'))
  const first = planned.main[0]
  const bytes = Buffer.from(patched, 'utf8').subarray(first.byteStart, first.byteStart + first.byteLength)
  assert.equal(bytes.toString('ascii').startsWith(PAYLOADS.mainHelpers), true)
  assert.equal(bytes.toString('ascii').slice(PAYLOADS.mainHelpers.length).trim(), '')
  assert.equal(bytes.length, first.byteLength)
})

test('buildPatch 在夹具归档上产出头部 + 两个条目写入，且保留原始字节', () => {
  const archive = defaultArchive()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsz-build-'))
  const file = path.join(dir, 'app.asar')
  fs.writeFileSync(file, archive.buffer)
  try {
    const loaded = readArchive(file)
    const built = buildPatch(loaded)
    assert.equal(built.writes.length, 3)
    assert.deepEqual(built.writes.map((write) => write.label), ['header', '/lib/main.js', '/lib/preload-app.cjs'])
    assert.equal(built.header.buffer.length, loaded.head.length, '头部等长')
    assert.deepEqual(built.header.patches.map((patch) => patch.mode), ['offset', 'offset'])
    assert.equal(built.blocks.length, 3)

    for (const block of built.blocks) {
      const original = archive.entries[block.entry].bytes.subarray(
        block.byteStart,
        block.byteStart + block.byteLength,
      )
      assert.deepEqual(block.original, original, `${block.id} 的原始字节必须精确备份`)
      assert.equal(block.original.length, block.byteLength)
    }

    const mainWrite = built.writes[1]
    assert.equal(mainWrite.buffer.length, archive.entries['/lib/main.js'].meta.size)
    assert.equal(sha256(mainWrite.buffer), built.targets.main.newHash)
    assert.notEqual(built.targets.main.newHash, built.targets.main.oldHash)
    assert.equal(built.header.buffer.toString('utf8').includes(built.targets.main.newHash), true)
    assert.equal(built.header.buffer.toString('utf8').includes(built.targets.main.oldHash), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('buildPatch 在缺锚点的归档上失败且不产生任何写入', () => {
  const archive = defaultArchive({ main: { omit: ['mainHelpers', 'mainHelpersFallback'] } })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsz-build-'))
  const file = path.join(dir, 'app.asar')
  fs.writeFileSync(file, archive.buffer)
  try {
    const loaded = readArchive(file)
    throwsBridge(() => buildPatch(loaded), 'anchor-missing', /main-helpers/)
    assert.deepEqual(fs.readFileSync(file), archive.buffer, '失败时归档必须字节不变')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('locatePayloads 从已注入源码里找回三块的位置与载荷长度', () => {
  const planned = planBlocks({ sources: { main: mainEntry(), preload: preloadEntry() } })
  const sources = {
    main: applyBlocks(mainEntry(), planned.main),
    preload: applyBlocks(preloadEntry(), planned.preload),
  }
  const located = locatePayloads(sources)
  assert.deepEqual(located.map((block) => block.id), ['main-helpers', 'main-handler', 'preload-bridge'])
  for (const block of located) {
    const text = block.entry === '/lib/main.js' ? sources.main : sources.preload
    const bytes = Buffer.from(text, 'utf8').subarray(block.byteStart, block.byteStart + block.codeLength)
    assert.equal(bytes.toString('ascii'), PAYLOADS[block.id.replace(/-(\w)/g, (_, c) => c.toUpperCase())], block.id)
  }
})

test('locatePayloads 在未注入源码上返回空数组，不抛错', () => {
  assert.deepEqual(locatePayloads({ main: mainEntry(), preload: preloadEntry() }), [])
})

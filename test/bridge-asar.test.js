import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  HEADER_FIXED,
  assertIntegrity,
  entryOffset,
  findEntry,
  locateArchive,
  parseHeader,
  parseHeaderJson,
  patchHeaderHash,
  readArchive,
  readEntry,
  sha256,
} from '../lib/bridge/asar.js'
import { buildArchive, mainEntry, preloadEntry } from './helpers/asar-fixture.js'

/**
 * 把一个 asar 头部 JSON 装成 `[16 字节固定头][JSON]` 的 Buffer。
 *
 * @param {string} json - 头部 JSON 文本（允许比真实归档更短，测试只关心偏移算法）。
 * @returns {Buffer} 固定头 + JSON。
 */
function packHeader(json) {
  const jsonBuffer = Buffer.from(json, 'utf8')
  const fixed = Buffer.alloc(HEADER_FIXED)
  fixed.writeUInt32LE(jsonBuffer.length, 12)
  return Buffer.concat([fixed, jsonBuffer])
}

test('parseHeader 读 12..16 的小端 JSON 长度并算出 dataStart', () => {
  const json = '{"files":{"lib":{"files":{"main.js":{"size":1,"offset":"0"}}}}}'
  const parsed = parseHeader(packHeader(json))
  assert.equal(parsed.jsonLength, Buffer.byteLength(json))
  assert.equal(parsed.dataStart, HEADER_FIXED + Buffer.byteLength(json))
  assert.deepEqual(Object.keys(parsed.header.files.lib.files), ['main.js'])
})

test('parseHeader 容忍 JSON 末尾的对齐填充（取到最后一个右花括号）', () => {
  const json = '{"files":{}}'
  const padded = Buffer.concat([packHeader(json), Buffer.alloc(8, 0)])
  assert.deepEqual(parseHeader(padded).header, { files: {} })
})

test('parseHeader 拒绝坏长度：0、超过 64 MiB、以及被截断的头部', () => {
  const zero = Buffer.alloc(HEADER_FIXED)
  assert.throws(() => parseHeader(zero), /JSON 长度/)

  const huge = Buffer.alloc(HEADER_FIXED)
  huge.writeUInt32LE(64 * 1024 * 1024 + 1, 12)
  assert.throws(() => parseHeader(huge), /JSON 长度/)

  const truncated = packHeader('{"files":{}}').subarray(0, HEADER_FIXED + 4)
  assert.throws(() => parseHeader(truncated), /截断|长度/)

  assert.throws(() => parseHeader(Buffer.alloc(8)), /不足 16 字节/)
})

test('parseHeaderJson 对非 JSON 报错而不是返回 undefined', () => {
  assert.throws(() => parseHeaderJson('not json'), /JSON/)
  assert.throws(() => parseHeaderJson(''), /JSON/)
})

test('findEntry 按 / 分段走 header.files，找不到返回 null', () => {
  const header = { files: { lib: { files: { 'main.js': { size: 3 } } } } }
  assert.deepEqual(findEntry(header, '/lib/main.js'), { size: 3 })
  assert.equal(findEntry(header, '/lib/preload-app.cjs'), null)
  assert.equal(findEntry(header, '/nope'), null)
  assert.equal(findEntry(header, ''), null)
})

test('entryOffset 用 dataStart + Number(offset)：asar 的 offset 是字符串', () => {
  const loaded = { dataStart: 1_000 }
  assert.equal(entryOffset(loaded, { offset: '177003298' }), 1_000 + 177003298)
  assert.equal(entryOffset(loaded, { offset: 42 }), 1_042)
  assert.throws(() => entryOffset(loaded, { offset: 'abc' }), /offset/)
  assert.throws(() => entryOffset(loaded, {}), /offset/)
})

test('readArchive 只读头部、readEntry 按绝对偏移取条目字节', () => {
  const archive = buildArchive({
    entries: {
      '/lib/main.js': mainEntry(),
      '/lib/preload-app.cjs': preloadEntry(),
    },
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsz-asar-'))
  const file = path.join(dir, 'app.asar')
  fs.writeFileSync(file, archive.buffer)
  try {
    const loaded = readArchive(file)
    assert.equal(loaded.archive, file)
    assert.equal(loaded.dataStart, archive.dataStart)
    const meta = findEntry(loaded.header, '/lib/main.js')
    assert.deepEqual(readEntry(loaded, meta), archive.entries['/lib/main.js'].bytes)
    assert.equal(readEntry(loaded, meta).length, meta.size)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sha256 与 node:crypto 算出的十六进制一致（integrity 重算的基础）', () => {
  const bytes = Buffer.from('dsh-plugin-resolution', 'utf8')
  assert.equal(sha256(bytes), createHash('sha256').update(bytes).digest('hex'))
  assert.equal(sha256(bytes).length, 64)
})

test('assertIntegrity 只接受单块 SHA256 且 hash === blocks[0]', () => {
  const hash = 'a'.repeat(64)
  const meta = { integrity: { algorithm: 'SHA256', hash, blockSize: 4194304, blocks: [hash] } }
  assert.equal(assertIntegrity(meta), hash)

  assert.throws(() => assertIntegrity({}), /integrity/)
  assert.throws(() => assertIntegrity({ integrity: { algorithm: 'SHA512', hash, blocks: [hash] } }), /SHA256/)
  assert.throws(() => assertIntegrity({ integrity: { algorithm: 'SHA256', hash, blocks: [] } }), /blocks/)
  assert.throws(
    () => assertIntegrity({ integrity: { algorithm: 'SHA256', hash, blocks: [hash, hash] } }),
    /blocks/,
  )
  assert.throws(
    () => assertIntegrity({ integrity: { algorithm: 'SHA256', hash, blocks: ['b'.repeat(64)] } }),
    /一致/,
  )
  assert.throws(() => assertIntegrity({ integrity: { algorithm: 'SHA256', hash: 'zz', blocks: ['zz'] } }), /64/)
})

test('patchHeaderHash offset 模式：按条目 offset 定位，只改它后面的两处哈希', () => {
  const oldHash = 'c'.repeat(64)
  const newHash = 'd'.repeat(64)
  const header = {
    files: {
      lib: {
        files: {
          'main.js': { size: 10, offset: '0', integrity: { algorithm: 'SHA256', hash: oldHash, blocks: [oldHash] } },
        },
      },
    },
  }
  const head = packHeader(JSON.stringify(header))
  const result = patchHeaderHash(head, oldHash, newHash, header.files.lib.files['main.js'])
  assert.equal(result.mode, 'offset')
  assert.equal(result.buffer.length, head.length, '头部长度必须逐字节不变')
  const text = result.buffer.toString('utf8')
  assert.equal(text.split(newHash).length - 1, 2)
  assert.equal(text.includes(oldHash), false)
})

test('patchHeaderHash offset 模式：两个条目共享同一哈希时只改本条目的两处', () => {
  const shared = 'e'.repeat(64)
  const newHash = 'f'.repeat(64)
  const header = {
    files: {
      lib: {
        files: {
          'main.js': { size: 10, offset: '100', integrity: { algorithm: 'SHA256', hash: shared, blocks: [shared] } },
          'main.js.map': { size: 10, offset: '200', integrity: { algorithm: 'SHA256', hash: shared, blocks: [shared] } },
        },
      },
    },
  }
  const head = packHeader(JSON.stringify(header))
  const result = patchHeaderHash(head, shared, newHash, header.files.lib.files['main.js'])
  assert.equal(result.mode, 'offset')
  assert.equal(result.buffer.length, head.length)
  const parsed = JSON.parse(result.buffer.subarray(HEADER_FIXED).toString('utf8'))
  assert.equal(parsed.files.lib.files['main.js'].integrity.hash, newHash)
  assert.equal(parsed.files.lib.files['main.js'].integrity.blocks[0], newHash)
  assert.equal(parsed.files.lib.files['main.js.map'].integrity.hash, shared, '别的条目不能被动到')
})

test('patchHeaderHash offset 模式支持数字型 offset', () => {
  const hash = '1'.repeat(64)
  const header = {
    files: { lib: { files: { 'main.js': { size: 10, offset: 100, integrity: { algorithm: 'SHA256', hash, blocks: [hash] } } } } },
  }
  const head = packHeader(JSON.stringify(header))
  const result = patchHeaderHash(head, hash, '2'.repeat(64), header.files.lib.files['main.js'])
  assert.equal(result.mode, 'offset')
  assert.match(result.buffer.toString('utf8'), /"hash":"2{64}"/)
})

test('patchHeaderHash plain 兜底：offset 定位不到、旧哈希恰好两处时全局替换', () => {
  const oldHash = 'a'.repeat(64)
  const newHash = 'b'.repeat(64)
  const header = {
    files: {
      lib: {
        files: {
          'main.js': { size: 10, offset: '7', integrity: { algorithm: 'SHA256', hash: oldHash, blocks: [oldHash] } },
        },
      },
    },
  }
  const head = packHeader(JSON.stringify(header))
  const result = patchHeaderHash(head, oldHash, newHash, { offset: '424242' })
  assert.equal(result.mode, 'plain')
  assert.equal(result.buffer.length, head.length)
  const text = result.buffer.toString('utf8')
  assert.equal(text.split(newHash).length - 1, 2)
  assert.equal(text.includes(oldHash), false)
})

test('patchHeaderHash 定位不到就抛错（绝不猜着改）', () => {
  const head = packHeader(JSON.stringify({ files: {} }))
  assert.throws(() => patchHeaderHash(head, 'a'.repeat(64), 'b'.repeat(64), { offset: '9' }), /哈希/)
  assert.throws(() => patchHeaderHash(head, 'nothex', 'b'.repeat(64), { offset: '9' }), /哈希/)
})

test('locateArchive 按 explicit → 环境变量 → argv → execPath → LOCALAPPDATA 顺序找', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsz-locate-'))
  const resources = path.join(dir, 'resources')
  fs.mkdirSync(resources, { recursive: true })
  const archive = path.join(resources, 'app.asar')
  fs.writeFileSync(archive, 'x')
  try {
    assert.equal(
      locateArchive({ explicit: archive, env: {}, argv: [], execPath: path.join(dir, 'nope.exe') }),
      archive,
    )
    assert.equal(
      locateArchive({ env: { DSH_WINDOW_RESOLUTION_ASAR: archive }, argv: [], execPath: path.join(dir, 'nope.exe') }),
      archive,
    )
    assert.equal(
      locateArchive({ env: {}, argv: ['node', 'x', path.join(dir, 'app.asar')], execPath: path.join(dir, 'nope.exe') }),
      archive,
    )
    assert.equal(
      locateArchive({ env: {}, argv: [], execPath: path.join(dir, 'DeepSeek Harness.exe') }),
      archive,
      'execPath 同目录下没有 app.asar 时要向上一级找 resources/app.asar',
    )
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rsz-locate-empty-'))
    assert.throws(
      () => locateArchive({ env: {}, argv: [], execPath: path.join(empty, 'nope.exe'), localAppData: empty }),
      /app\.asar/,
    )
    fs.rmSync(empty, { recursive: true, force: true })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

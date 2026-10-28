import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CHANNEL,
  CONTRACT_VERSION,
  ERROR_CODES,
  MAX_SIDE,
  MIN_SIDE,
  NAMESPACE,
} from '../lib/contract.js'
import { DEFAULT_CONFIG, MODES, PRESETS } from '../lib/config.js'
import { loadClient } from './helpers/client-harness.js'
import { CONFIG_KEY, LAST_APPLIED_KEY, STATUS_KEY } from './helpers/startup-harness.js'

/**
 * 仓库根（test/ 的上一级）。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 客户端暴露给测试的常量表（它不能 import，只好把字面量摊出来对拍）。
 *
 * @returns {object} `exports.meta`。
 */
function clientMeta() {
  const { exports } = loadClient()
  assert.ok(exports.meta, '客户端必须导出 meta：客户端不能 import lib/contract.js，字面量只能靠对拍守住')
  return exports.meta
}

test('客户端契约字面量与 lib/contract.js 一致', () => {
  const meta = clientMeta()
  assert.equal(meta.contractVersion, CONTRACT_VERSION)
  assert.equal(meta.namespace, NAMESPACE)
  assert.equal(meta.channel, CHANNEL)
  assert.equal(meta.minSide, MIN_SIDE)
  assert.equal(meta.maxSide, MAX_SIDE)
  assert.deepEqual(meta.errorCodes, [...ERROR_CODES])
})

test('客户端预设、模式与默认配置与 lib/config.js 一致', () => {
  const meta = clientMeta()
  assert.deepEqual(meta.presets, PRESETS.map((preset) => ({ ...preset })))
  assert.deepEqual(meta.modes, [...MODES])
  assert.deepEqual(meta.defaultConfig, { ...DEFAULT_CONFIG })
})

test('客户端与启动半边共用持久化键和变更广播名', () => {
  const meta = clientMeta()
  assert.equal(meta.configKey, CONFIG_KEY)
  assert.equal(meta.statusKey, STATUS_KEY)
  assert.equal(meta.lastAppliedKey, LAST_APPLIED_KEY)
  assert.equal(meta.changeEvent, 'dsh-window-resolution:changed')
})

test('docs/settings-ui.md 记录了存储键、广播名与降级行为', () => {
  const file = path.join(ROOT, 'docs', 'settings-ui.md')
  assert.ok(fs.existsSync(file), '缺少 docs/settings-ui.md：持久化机制必须写进文档')
  const text = fs.readFileSync(file, 'utf8')
  const meta = clientMeta()
  for (const expected of [meta.configKey, meta.statusKey, meta.changeEvent, 'localStorage']) {
    assert.ok(text.includes(expected), `docs/settings-ui.md 应记录 ${expected}`)
  }
})

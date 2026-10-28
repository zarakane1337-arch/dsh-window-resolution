import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadClient } from './helpers/client-harness.js'

/**
 * 仓库根（test/ 的上一级）。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 分区标题、说明与状态文案的 key —— 设置页与降级提示共用的那一组。
 */
const REQUIRED_KEYS = [
  'section',
  'sectionDescription',
  'presetsLabel',
  'modeCustom',
  'modeOff',
  'widthLabel',
  'heightLabel',
  'invalidSize',
  'statusDesktop',
  'statusNotDesktop',
  'statusPatched',
  'statusNotPatched',
  'statusOff',
  'statusApplied',
  'statusStartupApplied',
  'statusPending',
  'statusNoWindow',
  'statusRejected',
  'statusError',
  'renderFailed',
]

/**
 * 读一份 locale 资源。
 *
 * @param {string} file - 文件名（`locale/` 下）。
 * @returns {Record<string, string>} 解析后的文案表。
 */
function readLocale(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'locale', file), 'utf8'))
}

test('中英资源文件都合法且 key 完全一致', () => {
  const zh = readLocale('zh-CN.json')
  const en = readLocale('en.json')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('中英资源都含分区标题、说明与状态文案 key', () => {
  for (const file of ['zh-CN.json', 'en.json']) {
    const locale = readLocale(file)
    for (const key of REQUIRED_KEYS) {
      assert.equal(typeof locale[key], 'string', `${file} 缺少 ${key}`)
      assert.ok(locale[key].trim().length > 0, `${file} 的 ${key} 不能为空`)
    }
    assert.equal(typeof locale.meta, 'object', `${file} 应带 meta（插件列表用的标题/简介）`)
    assert.equal(typeof locale.meta.title, 'string')
    assert.equal(typeof locale.meta.description, 'string')
  }
})

test('中英资源确实是两种语言，不是互相复制的占位', () => {
  const zh = readLocale('zh-CN.json')
  const en = readLocale('en.json')
  for (const key of REQUIRED_KEYS) {
    assert.notEqual(zh[key], en[key], `${key} 在两种语言里不能相同`)
  }
  assert.match(zh.section, /[\u4e00-\u9fa5]/, '中文资源的标题必须含中文')
  assert.match(zh.statusNotPatched, /[\u4e00-\u9fa5]/, '中文资源的状态文案必须含中文')
})

test('客户端内置字典与 locale 资源逐字一致（同一份文案，不写两套）', () => {
  const { exports } = loadClient()
  const zh = readLocale('zh-CN.json')
  const en = readLocale('en.json')
  assert.deepEqual(exports.locales.zh, Object.fromEntries(REQUIRED_KEYS.map((key) => [key, zh[key]])))
  assert.deepEqual(exports.locales.en, Object.fromEntries(REQUIRED_KEYS.map((key) => [key, en[key]])))
  assert.deepEqual(Object.keys(exports.locales.zh).sort(), [...REQUIRED_KEYS].sort())
})

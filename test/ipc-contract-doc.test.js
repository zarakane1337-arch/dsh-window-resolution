import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CHANNEL, CONTRACT_VERSION, ERROR_CODES, MAX_SIDE, MIN_SIDE, NAMESPACE } from '../lib/contract.js'

/**
 * 仓库根（test/ 的上一级）。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * IPC 契约文档正文。
 *
 * @returns {string} 文件内容。
 */
function contractDoc() {
  return fs.readFileSync(path.join(ROOT, 'docs', 'ipc-contract.md'), 'utf8')
}

/**
 * 截取文档里某个二级标题下的正文。
 *
 * @param {string} text - 文档正文。
 * @param {string} heading - 二级标题文字（不含 `## `）。
 * @returns {string} 该标题到下一个二级标题之间的内容。
 */
function section(text, heading) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`)
  assert.notEqual(start, -1, `文档缺少「## ${heading}」一节`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^##\s/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/**
 * 取文档「错误码」表格里首列被反引号包住的标识符。
 *
 * @param {string} text - 文档正文。
 * @returns {string[]} 表格里出现的错误码（按出现顺序）。
 */
function documentedCodes(text) {
  const codes = []
  for (const line of section(text, '错误码').split(/\r?\n/)) {
    const match = /^\|\s*`([a-z][a-z-]*)`\s*\|/.exec(line)
    if (match) codes.push(match[1])
  }
  return codes
}

test('契约文档定义了 setBounds / getState 的完整签名', () => {
  const text = contractDoc()
  assert.match(text, /window\.dshWindowResolution/, '必须写明命名空间')
  assert.match(text, /setBounds\(\{\s*width:\s*number,\s*height:\s*number\s*\}\)/, '必须写明 setBounds 入参')
  assert.match(text, /getState\(\)/, '必须写明 getState 签名')
  assert.match(text, /`v:\s*1`|v:\s*1/, '必须写明版本常量 v: 1')
  assert.match(text, /patched/, 'getState 必须包含 patched')
  assert.match(text, /desktop/, 'getState 必须包含 desktop')
  assert.match(text, /bounds\?/, 'getState 的 bounds 必须是可选项')
  assert.match(text, new RegExp(CHANNEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '必须写明 IPC 通道名')
})

test('契约文档的错误码表格与代码里的 ERROR_CODES 完全一致', () => {
  const documented = documentedCodes(contractDoc())
  assert.deepEqual([...documented].sort(), [...ERROR_CODES].sort())
})

test('契约文档写的版本与上下限来自同一份常量', () => {
  const text = contractDoc()
  assert.match(text, new RegExp(`契约版本[^\\n]*${CONTRACT_VERSION}|v${CONTRACT_VERSION}`), '必须写明契约版本')
  assert.ok(text.includes(String(MIN_SIDE)), `必须写明下限 ${MIN_SIDE}`)
  assert.ok(text.includes(String(MAX_SIDE)), `必须写明上限 ${MAX_SIDE}`)
  assert.ok(text.includes(NAMESPACE))
})

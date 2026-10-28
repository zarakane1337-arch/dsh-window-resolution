import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * 仓库根（test/ 的上一级）。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 从 Cordis 补丁文件里取出 `insert` 列表项。
 *
 * 只解析本仓库用到的最小 YAML 子集（`- insert:` 下的 `- id: / name:` 对），
 * 目的是让清单与补丁的 id 漂移变成一个会红的断言，而不是靠人眼对。
 *
 * @param {string} text - 补丁文件内容。
 * @returns {{id: string, name: string}[]} insert 条目。
 */
function insertEntries(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^- insert:\s*$/.test(line))
  assert.notEqual(start, -1, 'cordis.patch.yml 必须有一个顶层 `- insert:` 列表')
  const entries = []
  let current = null
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && line.trim() !== '') break
    const id = /^\s+-\s+id:\s*(\S+)\s*$/.exec(line)
    if (id) {
      current = { id: id[1], name: undefined }
      entries.push(current)
      continue
    }
    const name = /^\s+name:\s*(\S+)\s*$/.exec(line)
    if (name && current) current.name = name[1]
  }
  return entries
}

test('cordis.patch.yml 的 insert 条目 id 与 name 都等于包名', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const entries = insertEntries(fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8'))
  assert.equal(entries.length, 1, '骨架阶段只应插入一个插件条目')
  assert.equal(entries[0].id, pkg.name)
  assert.equal(entries[0].name, pkg.name)
})

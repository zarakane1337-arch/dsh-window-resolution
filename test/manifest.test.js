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
 * 读仓库根下的文本文件。
 *
 * @param {...string} parts - 相对仓库根的路径片段。
 * @returns {string} 文件内容。
 */
function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8')
}

/**
 * 读仓库根下的 package.json。
 *
 * @returns {object} 解析后的清单。
 */
function manifest() {
  return JSON.parse(read('package.json'))
}

test('清单声明 DSH 能识别的包身份与双载体入口', () => {
  const pkg = manifest()
  assert.equal(pkg.name, 'dsh-plugin-resolution')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
})

test('清单声明 dsh 清单版本、bundle 补丁与客户端载体', () => {
  const pkg = manifest()
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-locale',
  ])
})

test('清单声明 Node 版本下限与无构建的测试入口', () => {
  const pkg = manifest()
  assert.equal(pkg.engines.node, '>=20')
  assert.equal(typeof pkg.scripts.test, 'string')
  assert.match(pkg.scripts.test, /node --test/)
  assert.equal(pkg.scripts.build, undefined, '本插件无构建步骤，不应声明 build 脚本')
  assert.equal(pkg.dependencies, undefined, '骨架阶段不应有任何运行时依赖')
})

test('清单引用的文件全部存在', () => {
  const pkg = manifest()
  const referenced = [
    pkg.main,
    pkg.exports['./client'],
    pkg.dsh.bundle.patch,
    'LICENSE',
    'locale/en.json',
    'locale/zh-CN.json',
    'docs/ipc-contract.md',
  ]
  for (const rel of referenced) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), true, `缺少 ${rel}`)
  }
})

test('lib/ 只含纯 JavaScript 源码，没有类型检查或产物目录', () => {
  const entries = fs.readdirSync(path.join(ROOT, 'lib'), { withFileTypes: true })
  const files = entries.filter((e) => e.isFile()).map((e) => e.name)
  assert.ok(files.length > 0, 'lib/ 不能为空')
  for (const file of files) {
    assert.match(file, /\.js$/, `lib/${file} 必须是 .js（无 TypeScript、无构建产物）`)
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'tsconfig.json')), false)
  assert.equal(fs.existsSync(path.join(ROOT, 'lib', 'dist')), false)
})

test('LICENSE 是 MIT 且版权行固定', () => {
  const text = read('LICENSE')
  assert.match(text, /MIT License/)
  assert.match(text, /Copyright \(c\) 2026 utop14/)
})

test('.gitignore 覆盖 node_modules 与 worktrees', () => {
  const lines = read('.gitignore').split(/\r?\n/).map((line) => line.trim())
  assert.ok(lines.includes('node_modules/'), '应忽略 node_modules/')
  assert.ok(lines.includes('.worktrees/'), '应忽略 .worktrees/（ticket worktree 不入库）')
})

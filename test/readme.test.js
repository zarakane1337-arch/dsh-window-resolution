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
 * 去掉 HTML 注释与围栏代码块后的正文。
 *
 * 注释里的链接是「待补截图」占位，不参与链接存在性检查；代码块里的 `](...)`
 * 是示例文本，不是文档链接。
 *
 * @param {string} markdown - 原始 markdown。
 * @returns {string} 正文。
 */
function prose(markdown) {
  return markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '')
}

/**
 * 收集 markdown 里的相对链接目标（不含锚点、外链与 `mailto:`）。
 *
 * @param {string} markdown - 已去掉注释与代码块的正文。
 * @returns {string[]} 相对路径（保留查询串之前的原始片段）。
 */
function relativeLinks(markdown) {
  const targets = []
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g
  let match = pattern.exec(markdown)
  while (match !== null) {
    const raw = match[1].trim()
    const target = raw.split(/\s+/)[0].replace(/^<|>$/g, '')
    if (target && !target.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      targets.push(target.split('#')[0])
    }
    match = pattern.exec(markdown)
  }
  return targets
}

test('README 同时提供中英文章节，并在文首互相链接', () => {
  const readme = read('README.md')
  assert.match(readme, /<a id="zh"><\/a>/, '中文段落需要稳定锚点 #zh')
  assert.match(readme, /<a id="en"><\/a>/, '英文段落需要稳定锚点 #en')
  assert.match(readme, /^## 中文$/m, '中文段落需要独立标题')
  assert.match(readme, /^## English$/m, '英文段落需要独立标题')
  assert.match(readme, /\[English\]\(#en\)/, '文首需要指向英文段落的链接')
  assert.match(readme, /\[中文\]\(#zh\)/, '文首需要指向中文段落的链接')
})

test('README 的相对链接都指向仓库内真实存在的文件', () => {
  for (const target of relativeLinks(prose(read('README.md')))) {
    assert.equal(fs.existsSync(path.join(ROOT, target)), true, `${target} 在仓库里不存在`)
  }
})

test('README 覆盖预设、强制应用、两次重启、共存、降级与退出码', () => {
  const readme = prose(read('README.md'))
  for (const preset of ['1280×720', '1366×768', '1600×900', '1920×1080', '2560×1440', '3840×2160']) {
    assert.ok(readme.includes(preset), `README 必须列出预设分辨率 ${preset}`)
  }
  assert.match(readme, /强制应用/, '必须使用 GLOSSARY 的「强制应用」')
  assert.match(readme, /force-applied|force-apply/i, '英文段落必须使用 force-apply 术语')
  assert.match(readme, /两次重启/, '必须说明两次重启')
  assert.match(readme, /dsh-window-control/, '必须说明与 dsh-window-control 共存')
  assert.match(readme, /node lib\/bridge-cli\.mjs uninstall/, '卸载必须先还原：给出 uninstall 命令')
  assert.match(readme, /非桌面端/, '必须说明非桌面环境的降级行为')
  assert.match(readme, /退出码/, 'CLI 速查必须解释退出码')
})

test('CHANGELOG 以 package.json 的版本号开篇，并记录新增/修复/已知限制', () => {
  const pkg = JSON.parse(read('package.json'))
  const changelog = read('CHANGELOG.md')
  const version = pkg.version.replace(/\./g, '\\.')
  assert.match(changelog, new RegExp(`^## \\[${version}\\]`, 'm'), '首个条目必须等于 package.json 的版本')
  assert.equal((changelog.match(new RegExp(`^## \\[${version}\\]`, 'gm')) || []).length, 1, '同一版本只能有一个条目')
  assert.match(changelog, /^### 新增$/m)
  assert.match(changelog, /^### 修复/m)
  assert.match(changelog, /^### 已知限制$/m)
})

test('发布清单包含 README 与 CHANGELOG，且不含测试/临时/worktree 产物', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(Array.isArray(pkg.files), 'package.json 必须有 files 字段')
  for (const entry of ['README.md', 'CHANGELOG.md', 'lib', 'locale', 'cordis.patch.yml', 'LICENSE']) {
    assert.ok(pkg.files.includes(entry), `files 必须包含 ${entry}`)
  }
  for (const entry of pkg.files) {
    assert.doesNotMatch(entry, /(^|\/)(test|_probe|\.scratch|\.worktrees?)(\/|$)/, `files 不应包含 ${entry}`)
  }
})

#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

import { BRIDGE_VERSION, check, ensurePatched, install, restore, status, uninstall } from './bridge/install.js'
import { PAYLOAD_VERSION } from './bridge/patch.js'

const USAGE = [
  '用法：node lib/bridge-cli.mjs <status|check|install|restore|uninstall|self-heal> [app.asar] [--dry-run] [--force]',
  '',
  '  status      只读：归档路径、DSH/载荷版本、注入状态、dwc 共存、锚点与字节预算',
  '  check       只读：校验当前归档自洽（哈希、半注入），未注入时报告可否安装',
  '  install     注入；载荷版本过期时先还原再重注；--dry-run 只打印偏移与预算，不落盘',
  '  restore     用回滚边车把字节精确还原（--force 跳过哈希校验；不碰 dwc 的 app.asar.orig）',
  '  uninstall   先 restore，再删掉状态文件',
  '  self-heal   启动自检：未注入或载荷过期就注入，已是最新只更新状态文件',
  '',
  '退出码：0 成功/已注入，1 失败，2 未注入（status/check）或无事可做（restore/uninstall）',
]

/**
 * 把状态报告排成人能读的行。
 *
 * @param {object} report - {@link import('./bridge/install.js').status} 的结果。
 * @returns {string[]} 输出行。
 */
function statusLines(report) {
  const lines = [
    `归档：${report.archive}`,
    `DSH 版本：${report.targetVersion || '未知（app-update.yml / version / app/package.json 都没读到）'}`,
    `注入修订：${report.version}（边车格式），载荷版本：${report.payloadVersion ?? '无标记'}（当前 v${PAYLOAD_VERSION}）`,
    `状态：${report.installed ? '已注入' : '未注入'}`,
    `dwc：${report.dwc ? '检测到（DWC=[[ / dshWindowControl），将避开其字节区间' : '未检测到'}`,
    `main.js：${report.targets.main.size} 字节 ${report.targets.main.patched ? '已注入' : '未注入'}`,
    `preload-app.cjs：${report.targets.preload.size} 字节 ${report.targets.preload.patched ? '已注入' : '未注入'}`,
  ]
  if (report.plan === null) {
    lines.push(`自洽：${report.consistent ? '是' : '否'}`)
    if (report.stale) {
      lines.push(`载荷版本过期：v${report.payloadVersion ?? 1} → 当前 v${PAYLOAD_VERSION}，跑 install 重注`)
    }
    for (const block of report.anchors || []) {
      lines.push(`  已注入 ${block.id.padEnd(14)} ${block.entry} @${block.byteStart}（载荷 ${block.codeLength} B）`)
    }
    for (const problem of report.problems || []) lines.push(`  ✖ ${problem}`)
    if (report.error) lines.push(`错误：${report.error.code}：${report.error.message}`)
    return lines
  }
  if (!report.plan.ok) {
    lines.push(`规划：失败（${report.plan.error.code}）${report.plan.error.message}`)
    return lines
  }
  lines.push(`规划：${report.plan.blocks.length} 块，全部通过锚点/符号/ASCII/等长校验`)
  for (const block of report.plan.blocks) {
    lines.push(
      `  ${block.id.padEnd(14)} ${block.entry} 锚点 ${block.anchor} 字节 ${block.byteStart}..${block.byteStart + block.byteLength}` +
        `（块 ${block.byteLength} B，载荷 ${block.codeLength} B，余量 ${block.budget} B）`,
    )
  }
  for (const patch of report.plan.header) {
    lines.push(`  头部 ${patch.target}：${patch.mode} 模式，改写偏移 ${patch.offsets.join(', ')}`)
  }
  return lines
}

/**
 * 把安装/干跑报告排成人能读的行。
 *
 * @param {object} report - {@link import('./bridge/install.js').install} 的结果。
 * @param {boolean} dryRun - 是否干跑。
 * @returns {string[]} 输出行。
 */
function installLines(report, dryRun) {
  const lines = [
    `归档：${report.archive}`,
    dryRun ? `干跑：将写入 ${report.writes.length} 处（未落盘）` : `已注入：写入 ${report.writes.length} 处`,
  ]
  if (report.reinstalled) {
    lines.push(`重注：旧载荷 v${report.previousPayloadVersion ?? 1} 已还原，写入当前 v${PAYLOAD_VERSION}`)
  }
  for (const block of report.blocks) {
    lines.push(
      `  ${block.id.padEnd(14)} ${block.entry} 锚点 ${block.anchor} 字节 ${block.byteStart}..${block.byteStart + block.byteLength}` +
        `（块 ${block.byteLength} B，载荷 ${block.codeLength} B，余量 ${block.budget} B）`,
    )
  }
  for (const write of report.writes) {
    lines.push(`  写入 ${write.label} @${write.fileOffset}（${write.bytes} B）`)
  }
  for (const patch of report.header) {
    lines.push(`  头部 ${patch.target}：${patch.mode} 模式，改写偏移 ${patch.offsets.join(', ')}`)
  }
  return lines
}

/**
 * 执行一条 CLI 命令。纯函数式返回 `{code, lines}`，方便测试直接断言。
 *
 * @param {string[]} argv - 参数（不含 `node` 与脚本名）。
 * @param {{dir?: string, io?: object, running?: boolean | null, targetVersion?: string}} [options]
 *   - 状态目录、文件系统、运行状态、DSH 版本（测试注入）。
 * @returns {{code: number, lines: string[]}} 退出码与输出行。
 */
export function run(argv = [], options = {}) {
  const [command = 'status', ...rest] = argv
  const flags = new Set(rest.filter((item) => item.startsWith('-')))
  const positional = rest.filter((item) => !item.startsWith('-'))
  const archive = positional[0]
  const common = { archive, dir: options.dir, io: options.io }
  try {
    if (command === 'help' || command === '--help' || command === '-h' || flags.has('--help') || flags.has('-h')) {
      return { code: 0, lines: USAGE }
    }
    if (command === 'status') {
      const report = status(common)
      return { code: report.ok ? (report.installed ? 0 : 2) : 2, lines: statusLines(report) }
    }
    if (command === 'check') {
      const report = check(common)
      const lines = [
        `归档：${archive || '(自动定位)'}`,
        `状态：${report.installed ? '已注入' : '未注入'}`,
        `自洽：${report.consistent ? '是' : '否'}`,
      ]
      if (!report.problems.length) lines.push(report.installed ? '结论：可以通过（哈希与标记都一致）' : '结论：未注入，可以安装')
      for (const problem of report.problems) lines.push(`  ✖ ${problem}`)
      return { code: report.problems.length ? 1 : report.installed ? 0 : 2, lines }
    }
    if (command === 'install') {
      const dryRun = flags.has('--dry-run')
      const report = install({
        ...common,
        dryRun,
        force: flags.has('--force'),
        running: options.running,
        targetVersion: options.targetVersion,
      })
      if (report.needsReinstall) {
        return {
          code: 0,
          lines: [
            `归档：${report.archive}`,
            `载荷版本过期：v${report.previousPayloadVersion ?? 1} → 当前 v${PAYLOAD_VERSION}；正式执行会先还原旧载荷再重注`,
          ],
        }
      }
      if (report.already) return { code: 0, lines: [`归档：${report.archive}`, '已注入，无需重复安装（--force 可强制重注）'] }
      return { code: 0, lines: installLines(report, dryRun) }
    }
    if (command === 'restore') {
      const report = restore({ ...common, force: flags.has('--force') })
      return {
        code: report.restored ? 0 : 2,
        lines: [
          `归档：${report.archive}`,
          report.restored ? `已还原：${report.blocks} 段字节回到注入前` : '未注入，无需还原（无事可做）',
        ],
      }
    }
    if (command === 'uninstall') {
      const report = uninstall(common)
      return {
        code: report.restored ? 0 : 2,
        lines: [
          `归档：${report.archive}`,
          report.restored
            ? `已还原：${report.blocks} 段字节回到注入前，状态文件已删除`
            : '未注入，已清理状态文件（无事可做）',
        ],
      }
    }
    if (command === 'self-heal') {
      const result = ensurePatched({ ...common, running: options.running, targetVersion: options.targetVersion })
      return {
        code: result.ok ? 0 : 1,
        lines: [
          `自检：${result.ok ? `通过（${result.action}）` : `失败（${result.action}）`}`,
          result.error
            ? `  ✖ ${result.error.code}：${result.error.message}`
            : `  注入修订：${BRIDGE_VERSION}，载荷版本：v${PAYLOAD_VERSION}${result.previousPayloadVersion ? `（旧 v${result.previousPayloadVersion} 已重注）` : ''}`,
        ],
      }
    }
    return { code: 2, lines: [`未知子命令：${command}`, ...USAGE] }
  } catch (error) {
    const code = error && error.code ? error.code : 'failed'
    const details = error && error.details ? ` ${JSON.stringify(error.details)}` : ''
    return { code: 1, lines: [`✖ ${code}：${error && error.message ? error.message : String(error)}${details}`] }
  }
}

/**
 * `node lib/bridge-cli.mjs ...` 直接执行时的入口。
 *
 * @returns {void}
 */
function main() {
  const { code, lines } = run(process.argv.slice(2))
  for (const line of lines) console.log(line)
  process.exitCode = code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

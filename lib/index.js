/**
 * dsh-plugin-resolution — 宿主半边（Host half）。
 *
 * ## 这个模块负责什么
 *
 * 1. 解析配置（`lib/config.js`）；
 * 2. 每次启动做一次**注入自检**：DSH 升级会整包替换 `resources/app.asar`，锚点、
 *    哈希、甚至 `lib/preload-app.cjs` 的路径都可能变。自检发现「标记不在」就重新注入，
 *    发现「锚点找不到」就只记录状态，**绝不让宿主启动失败**。
 *
 * 注入面见 `docs/ipc-contract.md` 与 `docs/adr/0001-asar-injection-window-bounds-route.md`；
 * 引擎在 `lib/bridge/`，CLI 在 `lib/bridge-cli.mjs`。
 *
 * @packageDocumentation
 */

import { normalizeConfig } from './config.js'
import { ensurePatched } from './bridge/install.js'

/** Cordis 插件名，必须与 package.json 的 `name` 一致。 */
export const name = 'dsh-plugin-resolution'

/** 本插件不注入任何宿主服务：注入的是 DSH 自己的 `app.asar`，不是 Cordis 服务。 */
export const inject = []

/**
 * 记一行日志：优先走 Cordis logger，拿不到或它自己抛错就静默放弃。
 *
 * 日志是纯诊断用途，任何时候都不该影响插件加载。
 *
 * @param {unknown} ctx - 宿主上下文（可能缺席）。
 * @param {string} message - 日志正文。
 */
function logStartup(ctx, message) {
  try {
    const logger = ctx && typeof ctx.logger === 'function' ? ctx.logger(name) : null
    if (logger && typeof logger.info === 'function') logger.info(message)
  } catch {
    /* 日志失败不影响任何功能 */
  }
}

/**
 * 启动自愈：跑一次「没装就装、装了就核对」，失败只记录。
 *
 * 只在 Electron 里真的动手：`node --test`、CLI、构建脚本都跑在纯 Node 下，
 * 既没有写 `app.asar` 的身份，也不该在测试里碰用户的真实归档。
 *
 * @param {{force?: boolean, archive?: string, dir?: string, targetVersion?: string, running?: boolean | null}} [options]
 *   - `force` 允许在非 Electron 进程里也执行（CLI 自检用）。
 * @returns {{ok: boolean, action: string, error?: object}} 自检结果。
 */
export function selfHealOnLaunch(options = {}) {
  if (!process.versions.electron && !options.force) {
    return { ok: true, action: 'skipped' }
  }
  const targetVersion = options.targetVersion || process.env.DSH_APP_VERSION || null
  try {
    return ensurePatched({ ...options, targetVersion })
  } catch (error) {
    // `ensurePatched` 自己已经兜底；这里再兜一层，宿主启动路径上绝不抛。
    return {
      ok: false,
      action: 'failed',
      error: { code: 'failed', message: error && error.message ? error.message : String(error) },
    }
  }
}

/**
 * Cordis 入口。
 *
 * @param {unknown} ctx - 宿主上下文。
 * @param {unknown} config - 插件配置（形状见 `lib/config.js`）；非法时回落到默认配置。
 * @returns {object} 归一化后的配置。
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  logStartup(ctx, `mode=${resolved.mode} target=${resolved.width}x${resolved.height}`)
  const outcome = selfHealOnLaunch({})
  if (outcome.ok === false) {
    logStartup(ctx, `注入自检失败（${outcome.error.code}）：${outcome.error.message}；窗口尺寸将保持 DSH 默认值`)
  }
  return resolved
}

export default apply

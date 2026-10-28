/**
 * dsh-plugin-resolution — 宿主半边（Host half）。
 *
 * ## 当前阶段（T01 骨架）
 *
 * 只做两件事：解析配置、记一行启动日志。**不注入**任何东西、不注册任何
 * `ctx.effect`，也绝不抛错。
 *
 * ## 下一步（T02 / T04）
 *
 * - T02 在这里做 `resources/app.asar` 的等长注入安装器（幂等、带备份、带符号校验），
 *   注入面见 `docs/ipc-contract.md` 与 `docs/adr/0001-asar-injection-window-bounds-route.md`；
 * - T04 在这里/客户端做「每次启动按配置强制应用」（启动期由客户端页面加载后调用，
 *   接受一次轻微闪烁）。
 *
 * @packageDocumentation
 */

import { normalizeConfig } from './config.js'

/** Cordis 插件名，必须与 package.json 的 `name` 一致。 */
export const name = 'dsh-plugin-resolution'

/** 本插件骨架阶段不注入任何宿主服务。 */
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
 * Cordis 入口。
 *
 * @param {unknown} ctx - 宿主上下文。
 * @param {unknown} config - 插件配置（形状见 `lib/config.js`）；非法时回落到默认配置。
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  logStartup(ctx, `mode=${resolved.mode} target=${resolved.width}x${resolved.height}`)
}

export default apply

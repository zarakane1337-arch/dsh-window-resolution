/**
 * dsh-plugin-resolution — 插件配置（纯逻辑，可单测）。
 *
 * 配置存在 DSH 的插件配置里（T03 由设置页读写），形状固定为：
 *
 *   { mode: 'preset' | 'custom' | 'off', width: number, height: number, presetValue: string | null }
 *
 * `presetValue` 是**派生字段**：它永远等于 `width × height` 对应的那档预设的 key，
 * 不是预设尺寸时是 `null`。派生而不是让调用方自己填，是为了让「显示选中了哪一档」
 * 和「真正要应用的尺寸」不可能互相矛盾。
 *
 * 非法输入一律回落到 `DEFAULT_CONFIG`（关闭 + 1920×1080），**不**把非法值悄悄修成
 * 一个用户没选过的尺寸 —— 静默替换会让人以为设置生效了，实际是另一个分辨率。
 *
 * @packageDocumentation
 */

import { MAX_SIDE, MIN_SIDE, validateSetBounds } from './contract.js'

/**
 * spec 定义的六档预设分辨率，顺序即设置页里的展示顺序。
 */
export const PRESETS = Object.freeze(
  [
    { key: '1280x720', width: 1280, height: 720 },
    { key: '1366x768', width: 1366, height: 768 },
    { key: '1600x900', width: 1600, height: 900 },
    { key: '1920x1080', width: 1920, height: 1080 },
    { key: '2560x1440', width: 2560, height: 1440 },
    { key: '3840x2160', width: 3840, height: 2160 },
  ].map((preset) => Object.freeze(preset)),
)

/** 三种取值模式：预设、自定义、关闭（不改窗口）。 */
export const MODES = Object.freeze(['preset', 'custom', 'off'])

/**
 * 默认配置：关闭 + 1920×1080。
 *
 * 「关闭」是默认值：插件装好但用户还没做选择时，不该擅自改动窗口尺寸。
 */
export const DEFAULT_CONFIG = Object.freeze({
  mode: 'off',
  width: 1920,
  height: 1080,
  presetValue: '1920x1080',
})

/**
 * 尺寸对应的预设 key。
 *
 * @param {number} width - 宽（逻辑像素）。
 * @param {number} height - 高（逻辑像素）。
 * @returns {string | null} 预设 key；不是预设尺寸时为 null。
 */
export function presetKey(width, height) {
  const found = PRESETS.find((preset) => preset.width === width && preset.height === height)
  return found ? found.key : null
}

/**
 * 按 key 取预设。
 *
 * @param {unknown} key - 预设 key。
 * @returns {{key: string, width: number, height: number} | null} 预设；不存在时为 null。
 */
function presetByKey(key) {
  if (typeof key !== 'string') return null
  return PRESETS.find((preset) => preset.key === key) || null
}

/**
 * 组装一条规范化配置。
 *
 * @param {'preset' | 'custom' | 'off'} mode - 模式。
 * @param {number} width - 宽。
 * @param {number} height - 高。
 * @returns {{mode: string, width: number, height: number, presetValue: string | null}} 新对象。
 */
function createConfig(mode, width, height) {
  return { mode, width, height, presetValue: presetKey(width, height) }
}

/**
 * 默认配置的一份拷贝。
 *
 * @returns {{mode: string, width: number, height: number, presetValue: string | null}} 新对象。
 */
function defaults() {
  return createConfig(DEFAULT_CONFIG.mode, DEFAULT_CONFIG.width, DEFAULT_CONFIG.height)
}

/**
 * 把任意输入归一成一条可用配置。
 *
 * 规则（顺序即优先级）：
 * 1. 非对象、缺 `mode` 或 `mode` 不在 `MODES` 里 → 默认配置；
 * 2. `preset`：先用 `presetValue` 查预设，查不到再按 `width`/`height` 匹配预设，都不中 → 默认配置；
 * 3. `custom`：`width`/`height` 必须通过 IPC 契约的同一套校验（整数、`200..16384`），否则 → 默认配置；
 * 4. `off`：尺寸无意义，一律回到默认尺寸。
 *
 * @param {unknown} input - 配置来源（可能来自配置文件、UI 或旧版本）。
 * @returns {{mode: string, width: number, height: number, presetValue: string | null}} 新对象，绝不复用入参。
 */
export function normalizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return defaults()

  const mode = MODES.includes(input.mode) ? input.mode : DEFAULT_CONFIG.mode
  if (mode === 'off') return defaults()

  if (mode === 'preset') {
    const byKey = presetByKey(input.presetValue)
    if (byKey) return createConfig('preset', byKey.width, byKey.height)
    const bySize = PRESETS.find(
      (preset) => preset.width === input.width && preset.height === input.height,
    )
    if (bySize) return createConfig('preset', bySize.width, bySize.height)
    return defaults()
  }

  const checked = validateSetBounds({ width: input.width, height: input.height })
  if (!checked.ok) return defaults()
  return createConfig('custom', checked.width, checked.height)
}

/**
 * 宽高的可接受区间（转发契约常量，方便 T03 的输入控件直接用）。
 */
export const LIMITS = Object.freeze({ min: MIN_SIDE, max: MAX_SIDE })

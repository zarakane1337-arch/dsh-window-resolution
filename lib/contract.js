/**
 * dsh-plugin-resolution — IPC 契约（共享常量与入参校验）。
 *
 * 本模块是 `docs/ipc-contract.md` 的可执行版本：两边由
 * `test/ipc-contract-doc.test.js` 绑定，任何一侧单独漂移都会红。
 *
 * ## 为什么契约要落在代码里
 *
 * 主进程注入（T02）与设置页（T03）是两条并行工作流，唯一的握手点就是这组常量与
 * 返回形状。把它们写成常量 + 校验函数，而不是各写一份字面量，才能让「宽高非法返回
 * `invalid`」这类约定在宿主侧和客户端侧只有一种解释。
 *
 * ## 边界
 *
 * 这里只做**入参形状校验**与返回报文构造，不碰 Electron、不碰窗口。真正的钳制
 * （把尺寸限制在当前屏幕可用工作区）与居中由主进程在 `setBounds` 内完成 —— 见 ADR
 * 0001 与 `docs/ipc-contract.md` 的「行为约定」。
 *
 * @packageDocumentation
 */

/** 契约版本。命名空间上的 `v` 字段必须与它保持一致。 */
export const CONTRACT_VERSION = 1

/** 渲染端暴露的命名空间（挂在 `window` 上，不带 `window.` 前缀）。 */
export const NAMESPACE = 'dshWindowResolution'

/** 主进程 IPC 通道名（注入进 `resources/app.asar` 的 `lib/main.js`）。 */
export const CHANNEL = 'dsh-desktop:window-bounds-set'

/**
 * 宽高下限（逻辑像素）。
 *
 * 低于这个值主窗口已经没法正常使用（设置页本身就放不下），因此在 IPC 边界直接
 * 判为入参非法，而不是交给钳制逻辑去处理。
 */
export const MIN_SIDE = 200

/**
 * 宽高上限（逻辑像素）。
 *
 * 比 8K（7680）留了一倍余量，足够覆盖多屏拼接与超高分辨率屏；超出这个量级的
 * 取值几乎一定是入参错误（比如把 1920 写成了 19200），直接拒绝比默默钳制更容易排障。
 */
export const MAX_SIDE = 16384

/**
 * 全部错误码。
 *
 * - `not-desktop`：不在 DSH 桌面端（浏览器标签页），调用方应静默降级。
 * - `no-window`：主进程找不到可操作的 BrowserWindow（已销毁 / 只有辅助窗口）。
 * - `not-patched`：桌面端但 preload 桥未注入，`window.dshWindowResolution` 缺席。
 * - `invalid`：入参形状非法（非整数、越界、缺字段）。
 * - `rejected`：`BrowserWindow.setBounds` 抛错或窗口不可调整。
 */
export const ERROR_CODES = Object.freeze([
  'not-desktop',
  'no-window',
  'not-patched',
  'invalid',
  'rejected',
])

/**
 * 判定一条错误码是否在契约内。
 *
 * @param {unknown} code - 待判定的取值。
 * @returns {boolean} 是否合法。
 */
export function isErrorCode(code) {
  return typeof code === 'string' && ERROR_CODES.includes(code)
}

/**
 * 判定单个边长是否可用。
 *
 * @param {string} name - 字段名，用于错误文案。
 * @param {unknown} value - 待判定的取值。
 * @returns {string | null} 问题描述；合法时为 null。
 */
function sideProblem(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${name} must be a finite number`
  if (!Number.isInteger(value)) return `${name} must be an integer`
  if (value < MIN_SIDE || value > MAX_SIDE) {
    return `${name} must be between ${MIN_SIDE} and ${MAX_SIDE}`
  }
  return null
}

/**
 * 校验一条窗口几何四元组（主进程返回的「实际 bounds」）。
 *
 * 位置允许为负 —— 多显示器下副屏原点常在主屏左侧/上方。
 *
 * @param {unknown} value - 待判定的取值。
 * @returns {boolean} 是否是一条合法的 bounds。
 */
export function isBounds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const { x, y } = value
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false
  return sideProblem('width', value.width) === null && sideProblem('height', value.height) === null
}

/**
 * 校验 `setBounds` 的入参。
 *
 * 只关心 `width` / `height`：位置由主进程决定（居中），调用方传了也会被忽略。
 *
 * @param {unknown} input - 调用方传入的对象。
 * @returns {{ok: true, width: number, height: number} | {ok: false, code: 'invalid', message: string}}
 *   归一后的宽高，或一条 `invalid` 报文。
 */
export function validateSetBounds(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return setBoundsFail('invalid', 'setBounds expects an object { width, height }')
  }
  const problem = sideProblem('width', input.width) || sideProblem('height', input.height)
  if (problem) return setBoundsFail('invalid', problem)
  return { ok: true, width: input.width, height: input.height }
}

/**
 * 构造成功报文。
 *
 * @param {unknown} bounds - 主进程实际应用后的窗口几何。
 * @returns {{ok: true, bounds: {x: number, y: number, width: number, height: number}}} 成功报文。
 */
export function setBoundsOk(bounds) {
  if (!isBounds(bounds)) throw new TypeError('bounds must be { x, y, width, height } integers')
  return {
    ok: true,
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
  }
}

/**
 * 构造失败报文。
 *
 * 错误码拼错、message 为空都视为编程错误并直接抛 TypeError —— 这类 bug 应该在
 * 单测里炸掉，而不是变成一个谁也看不懂的运行期错误码。
 *
 * @param {string} code - `ERROR_CODES` 里的错误码。
 * @param {string} message - 面向排障的一句话。
 * @returns {{ok: false, code: string, message: string}} 失败报文。
 */
export function setBoundsFail(code, message) {
  if (!isErrorCode(code)) throw new TypeError(`unknown error code: ${String(code)}`)
  if (typeof message !== 'string' || message.trim() === '') {
    throw new TypeError('message must be a non-empty string')
  }
  return { ok: false, code, message }
}

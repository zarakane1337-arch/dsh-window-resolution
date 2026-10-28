/**
 * dsh-window-resolution — 注入失败时抛出的结构化错误。
 *
 * 安装器最怕「静默改坏、下次启动才知道」。所有失败路径都带一个稳定的 `code`，
 * CLI 与宿主日志据此给出可排障的一句话，测试也不必匹配自然语言。
 *
 * @packageDocumentation
 */

/**
 * 注入器错误。
 *
 * `code` 是稳定标识（见各模块注释），`message` 是给人看的中文说明。
 */
export class BridgeError extends Error {
  /**
   * @param {string} code - 稳定错误码，如 `anchor-missing`。
   * @param {string} message - 中文说明（可含细节）。
   * @param {Record<string, unknown>} [details] - 附加信息（偏移、候选、原因等）。
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.details = details
  }
}

/**
 * 断言条件成立，否则抛 {@link BridgeError}。
 *
 * @param {unknown} condition - 必须为真的条件。
 * @param {string} code - 失败时的错误码。
 * @param {string} message - 失败时的说明。
 * @param {Record<string, unknown>} [details] - 附加信息。
 * @returns {void}
 */
export function ensure(condition, code, message, details) {
  if (!condition) throw new BridgeError(code, message, details)
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 状态文件（给人看的）与回滚边车（给 `restore` 用的）都放在 DSH profile 目录里，
 * 与 `dsh-window-control` 的 `.dsh-window-control.json` 同一层：用户排查时一眼能找到。
 */

/** 状态文件名：每次 `apply()` 启动自检后覆盖写入。 */
export const STATUS_FILE = '.dsh-window-resolution.json'

/** 回滚边车文件名：只在「已注入」期间存在，`restore`/`uninstall` 成功即删除。 */
export const RECOVERY_FILE = '.dsh-window-resolution.restore.json'

/** 当前边车格式版本；结构变化时递增，旧边车会被拒绝而不是误读。 */
export const STATE_VERSION = 1

/**
 * 解析 DSH 的 home 目录（与桌面主进程同一规则）。
 *
 * @param {Record<string, string | undefined>} [env] - 环境变量。
 * @returns {string} home 目录绝对路径。
 */
export function homeDir(env = process.env) {
  const override = env && env.DSH_HOME
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override)
  return path.join(os.homedir(), '.dsh')
}

/**
 * 解析当前 profile 目录；`DSH_PROFILE` 缺省时用桌面端的 `desktop`。
 *
 * @param {Record<string, string | undefined>} [env] - 环境变量。
 * @returns {string} profile 目录绝对路径。
 */
export function profileDir(env = process.env) {
  const profile = env && typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim() !== '' ? env.DSH_PROFILE : 'desktop'
  return path.join(homeDir(env), 'profiles', profile)
}

/**
 * 读一个 JSON 文件；不存在或解析失败都返回 `null`（状态文件损坏不该拦住启动）。
 *
 * @param {string} file - 文件路径。
 * @returns {Record<string, unknown> | null} 解析结果。
 */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 原子写 JSON：先写同目录临时文件再改名，避免半个文件被下一次读进来。
 *
 * @param {string} file - 目标路径。
 * @param {Record<string, unknown>} value - 要写入的内容。
 * @returns {void}
 */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temp, file)
}

/**
 * 删除文件（不存在不算错）。
 *
 * @param {string} file - 文件路径。
 * @returns {boolean} 是否真的删掉了。
 */
export function removeFile(file) {
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

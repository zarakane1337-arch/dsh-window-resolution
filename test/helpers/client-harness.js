import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

/**
 * `lib/client.js` 的绝对路径（浏览器半体，不在 Node 里 import）。
 */
const CLIENT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'client.js')

/**
 * 把插件客户端元素树里的文本按顺序拼起来。
 *
 * 只认 `{ type, props, children }` 这种假 React 元素与裸字符串；够用来断言
 * 「设置页渲染出了标题与说明」。
 *
 * @param {unknown} node - 假 React 元素、字符串或它们的数组。
 * @returns {string} 拼接后的纯文本。
 */
export function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && Array.isArray(node.children)) return node.children.map(textOf).join('')
  return ''
}

/**
 * 临时替换一个全局属性，返回恢复函数。
 *
 * 客户端是「浏览器里由 DSH 模块加载器执行」的脚本，靠 `window` / `navigator` 这类
 * 浏览器全局工作；测试在同一 realm 里注入假全局（`runInThisContext`），这样客户端
 * 造出来的数组/对象与断言同一 realm，`deepEqual` 才比得动。
 *
 * @param {string} name - 全局属性名。
 * @param {unknown} value - 临时值。
 * @returns {() => void} 恢复原状的函数。
 */
function stubGlobal(name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous)
    else delete globalThis[name]
  }
}

/**
 * 在指定的假 `window` 下执行一段代码。
 *
 * 组件是在加载之后、交互时读取 `window` 的（localStorage、桌面桥），所以断言必须
 * 覆盖到「渲染与交互」这一段，而不只是加载那一刻。
 *
 * @param {object} windowObject - 假 window。
 * @param {() => unknown} fn - 待执行的代码。
 * @returns {unknown} `fn` 的返回值。
 */
export function withWindow(windowObject, fn) {
  const restore = stubGlobal('window', windowObject)
  try {
    return fn()
  } finally {
    restore()
  }
}

/**
 * 造一个内存版 `localStorage`。
 *
 * `throwOnGet` / `throwOnSet` 用来模拟「站点数据被禁用」：设置页必须在这种环境下
 * 依旧可用（读失败回落默认值、写失败仅本次生效），而不是白屏。
 *
 * @param {Record<string, string>} [seed] - 初始键值。
 * @returns {{
 *   data: Map<string, string>, throwOnGet: boolean, throwOnSet: boolean,
 *   getItem: (key: string) => string | null, setItem: (key: string, value: string) => void,
 *   removeItem: (key: string) => void, clear: () => void,
 * }} 假存储。
 */
export function createFakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed))
  const storage = {
    data,
    throwOnGet: false,
    throwOnSet: false,
    getItem(key) {
      if (storage.throwOnGet) throw new Error('storage unavailable')
      return data.has(key) ? data.get(key) : null
    },
    setItem(key, value) {
      if (storage.throwOnSet) throw new Error('storage unavailable')
      data.set(key, String(value))
    },
    removeItem(key) {
      data.delete(key)
    },
    clear() {
      data.clear()
    },
  }
  return storage
}

/**
 * 造一个假 `window`：事件目标 + 模块装载器 + localStorage + 可选的桌面桥。
 *
 * 用真的 `EventTarget` 是因为客户端会 `dispatchEvent(CustomEvent)` 广播配置变更、
 * 也会 `addEventListener` 监听外部变更；假的 dispatch 很难保证同一个语义。
 *
 * @param {{ storage?: object, bridge?: object }} [options] - 存储与桌面桥。
 * @returns {object} 假 window，`__entries` 收集模块装载器登记项。
 */
export function createFakeWindow(options = {}) {
  const target = new EventTarget()
  target.localStorage = options.storage || createFakeStorage()
  target.__entries = []
  target.__ModuleLoader__ = {
    load(entry) {
      target.__entries.push(entry)
    },
  }
  if (options.bridge !== undefined) target.dshWindowResolution = options.bridge
  return target
}

/**
 * 只做元素工厂的假 React（无 hooks，兼容不渲染组件的旧用例）。
 *
 * @returns {object} 假 React。
 */
function createBasicReact() {
  return {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2).flat()
      return { type, props: props || {}, children }
    },
  }
}

/**
 * 加载 `lib/client.js`，取出 `__ModuleLoader__.load()` 的登记项与工厂导出。
 *
 * @param {{
 *   language?: string,
 *   modules?: Record<string, unknown>,
 *   react?: object,
 *   window?: object,
 *   storage?: object,
 *   bridge?: object,
 * }} [options] - 语言、额外模块、假 React 与假 window（也可分别给 storage/bridge）。
 * @returns {{entry: {id: string, factory: Function}, exports: object, react: object, window: object}}
 *   登记项、工厂导出、假 React 与假 window。
 */
export function loadClient(options = {}) {
  const language = options.language || 'en-US'
  const extraModules = options.modules || {}
  const react = options.react || createBasicReact()
  const windowObject =
    options.window || createFakeWindow({ storage: options.storage, bridge: options.bridge })
  const source = fs.readFileSync(CLIENT_FILE, 'utf8')

  const restoreWindow = stubGlobal('window', windowObject)
  const restoreNavigator = stubGlobal('navigator', { language })
  try {
    vm.runInThisContext(source, { filename: 'lib/client.js' })
  } finally {
    restoreNavigator()
    restoreWindow()
  }

  const registrations = windowObject.__entries
  if (registrations.length !== 1) {
    throw new Error(`lib/client.js 应调用一次 __ModuleLoader__.load()，实际 ${registrations.length} 次`)
  }
  const entry = registrations[0]
  const exports = entry.factory((name) => {
    if (name === 'react') return react
    if (Object.prototype.hasOwnProperty.call(extraModules, name)) return extraModules[name]
    throw new Error(`意外的 require('${name}')：客户端只应依赖宿主提供的模块`)
  })
  return { entry, exports, react, window: windowObject }
}

/**
 * 在指定的浏览器语言下执行一段代码。
 *
 * 客户端「按 navigator 猜语言」是延迟读取的，而 Node 自己的 `navigator.language`
 * 取决于系统区域设置（这里是 zh-CN），所以断言语言回退时必须把假 navigator 撑到
 * 断言结束，不能只撑到加载那一刻。
 *
 * @param {string | {language?: string}} languageOrOptions - 语言标签，或 `{language}` 选项。
 * @param {() => unknown} fn - 待执行的代码。
 * @returns {unknown} `fn` 的返回值。
 */
export function withBrowserLanguage(languageOrOptions, fn) {
  const language =
    typeof languageOrOptions === 'string' ? languageOrOptions : (languageOrOptions || {}).language
  const restore = stubGlobal('navigator', { language })
  try {
    return fn()
  } finally {
    restore()
  }
}

/**
 * 造一个记录调用的插件上下文，覆盖设置页骨架用到（以及明确不该用到）的接口。
 *
 * @param {{
 *   withLocale?: boolean,
 *   bindLocale?: boolean,
 *   boundLanguage?: 'zh' | 'en',
 *   throwOnInject?: boolean,
 * }} [options] - 上下文行为开关。
 * @returns {{ctx: object, record: object}} 上下文与调用记录。
 */
export function createContext(options = {}) {
  const record = {
    localeRegister: [],
    localeBind: [],
    inject: [],
    register: [],
    effects: [],
    events: [],
    logs: [],
  }
  const boundLanguage = options.boundLanguage || 'zh'
  const locale =
    options.withLocale === false
      ? undefined
      : {
          register(namespace, dictionaries) {
            record.localeRegister.push({ namespace, dictionaries })
          },
          bind(namespace) {
            record.localeBind.push(namespace)
            if (options.bindLocale === false) return undefined
            return (key) => {
              const dict = record.localeRegister.find((entry) => entry.namespace === namespace)
              const table = dict ? dict.dictionaries[boundLanguage] : undefined
              return table && typeof table[key] === 'string' ? table[key] : key
            }
          },
        }
  const ctx = {
    locale,
    slots: {
      inject(name, callback) {
        record.inject.push({ name, callback })
        if (options.throwOnInject) throw new Error('slots not ready')
        return () => {}
      },
      register(meta, component) {
        record.register.push({ meta, component })
        return () => {}
      },
    },
    effect(fn, label) {
      record.effects.push({ fn, label })
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(event, callback) {
      record.events.push({ event, callback })
      return () => {}
    },
    logger(name) {
      return {
        info(message) {
          record.logs.push({ level: 'info', name, message })
        },
        warn(message) {
          record.logs.push({ level: 'warn', name, message })
        },
      }
    },
  }
  return { ctx, record }
}

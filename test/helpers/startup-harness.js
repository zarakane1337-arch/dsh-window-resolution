/**
 * 启动应用（T04）的测试环境。
 *
 * 客户端是「浏览器里由 DSH 模块加载器执行」的脚本，启动逻辑只通过浏览器全局
 * （`window` / `location` / `document` / `localStorage` / 定时器）与宿主交互。
 * 这里把这些全局换成可控的假实现，让测试能精确推进时间、切换通道可用性与页面
 * 可见性，而不必真的等 10×400ms。
 *
 * 只替换测试期间需要的全局，`restore()` 逐个还原 —— `node --test` 默认在同一
 * 进程里跑多个文件，残留的假全局会让别的测试莫名其妙地红。
 *
 * @packageDocumentation
 */

/** 与 T03 设置页共用的配置键（localStorage）。 */
export const CONFIG_KEY = 'dsh-window-resolution:config'

/** 最近一次真正应用后的窗口几何（与设置页共享，便于状态展示）。 */
export const LAST_APPLIED_KEY = 'dsh-window-resolution:last-applied'

/** 启动状态（供设置页读取展示）。 */
export const STATUS_KEY = 'dsh-window-resolution:status'

/**
 * 临时替换一个全局属性，返回恢复函数。
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
 * 假定时器：`advance(ms)` 按到期顺序执行，每次回调后清空微任务队列，让
 * `Promise.then` 链（桥调用 → 状态记录 → 下一次重试）继续推进。
 *
 * @returns {{
 *   readonly now: number,
 *   setTimeout: (fn: Function, ms: number) => number,
 *   clearTimeout: (id: number) => void,
 *   pending: () => number,
 *   flush: () => Promise<void>,
 *   advance: (ms: number) => Promise<void>,
 * }} 假时钟。
 */
export function createClock() {
  let now = 0
  let sequence = 0
  const timers = new Map()

  /** 清空当前微任务队列（客户端每条链最多三层 `.then`，12 次足够）。 */
  async function flush() {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  }

  return {
    get now() {
      return now
    },
    setTimeout(fn, ms) {
      sequence += 1
      const id = sequence
      timers.set(id, { id, at: now + Math.max(0, Number(ms) || 0), fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    pending() {
      return timers.size
    },
    flush,
    async advance(ms) {
      const target = now + ms
      for (;;) {
        let next = null
        for (const timer of timers.values()) {
          if (timer.at > target) continue
          if (next === null || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) {
            next = timer
          }
        }
        if (next === null) break
        timers.delete(next.id)
        now = next.at
        next.fn()
        await flush()
      }
      now = target
      await flush()
    },
  }
}

/**
 * 假 localStorage：可注入「读写抛错」以覆盖存储不可用时的静默降级。
 *
 * @param {{throwOnGet?: boolean, throwOnSet?: boolean}} [options] - 抛错开关。
 * @returns {object} 存储实现。
 */
function createStorage(options = {}) {
  const entries = new Map()
  return {
    getItem(key) {
      if (options.throwOnGet) throw new Error('storage unavailable')
      return entries.has(key) ? entries.get(key) : null
    },
    setItem(key, value) {
      if (options.throwOnSet) throw new Error('storage unavailable')
      entries.set(key, String(value))
    },
    removeItem(key) {
      entries.delete(key)
    },
    dump() {
      return Object.fromEntries(entries)
    },
  }
}

/**
 * 假 document：只实现 `visibilitychange` 需要的那一小块。
 *
 * @returns {object} document 与可见性控制方法。
 */
function createDocument() {
  const listeners = new Map()
  const documentObject = {
    visibilityState: 'visible',
    hidden: false,
    addEventListener(type, callback) {
      const list = listeners.get(type) || []
      if (!list.includes(callback)) list.push(callback)
      listeners.set(type, list)
    },
    removeEventListener(type, callback) {
      const list = listeners.get(type) || []
      const index = list.indexOf(callback)
      if (index >= 0) list.splice(index, 1)
    },
  }
  return {
    document: documentObject,
    listenerCount(type) {
      return (listeners.get(type) || []).length
    },
    setVisibility(state) {
      documentObject.visibilityState = state
      documentObject.hidden = state !== 'visible'
      for (const callback of [...(listeners.get('visibilitychange') || [])]) {
        callback({ type: 'visibilitychange' })
      }
    },
  }
}

/**
 * 造一个可控的启动环境。
 *
 * 默认桥会记录调用并成功返回请求尺寸（`x`/`y` 固定为 0）。测试可用
 * `setBounds` 覆盖返回值/抛错，用 `bridge: null` 模拟未注入，用 `setBridge()`
 * 模拟「启动过程中通道才就绪」。
 *
 * @param {{
 *   protocol?: string,
 *   config?: object | null,
 *   lastApplied?: object | null,
 *   bridge?: object | null,
 *   setBounds?: (input: {width: number, height: number}, call: number) => unknown,
 *   throwOnGet?: boolean,
 *   throwOnSet?: boolean,
 * }} [options] - 环境开关。
 * @returns {object} 环境句柄（含 `restore()`）。
 */
export function createStartupEnvironment(options = {}) {
  const clock = createClock()
  const storage = createStorage(options)
  const documentParts = createDocument()
  const calls = []
  let bridgeReads = 0
  let bridgeValue

  const defaultSetBounds = (input) => ({
    ok: true,
    bounds: { x: 0, y: 0, width: input.width, height: input.height },
  })
  const respond = options.setBounds || defaultSetBounds
  const defaultBridge = {
    v: 1,
    setBounds(input) {
      calls.push({ width: input.width, height: input.height })
      return respond({ width: input.width, height: input.height }, calls.length)
    },
  }

  const windowObject = {
    localStorage: storage,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    document: documentParts.document,
  }
  Object.defineProperty(windowObject, 'dshWindowResolution', {
    configurable: true,
    enumerable: true,
    get() {
      bridgeReads += 1
      return bridgeValue
    },
    set(value) {
      bridgeValue = value
    },
  })

  const locationObject = { protocol: options.protocol || 'dsh-app:' }
  windowObject.location = locationObject

  if (options.config !== undefined) storage.setItem(CONFIG_KEY, JSON.stringify(options.config))
  if (options.lastApplied !== undefined) {
    storage.setItem(LAST_APPLIED_KEY, JSON.stringify(options.lastApplied))
  }
  bridgeValue = options.bridge === null ? undefined : options.bridge || defaultBridge

  const restores = [
    stubGlobal('window', windowObject),
    stubGlobal('location', locationObject),
    stubGlobal('document', documentParts.document),
  ]

  return {
    clock,
    storage,
    window: windowObject,
    document: documentParts.document,
    location: locationObject,
    calls,
    get bridgeReads() {
      return bridgeReads
    },
    setBridge(value) {
      bridgeValue = value === null ? undefined : value
    },
    setVisibility(state) {
      documentParts.setVisibility(state)
    },
    listenerCount(type = 'visibilitychange') {
      return documentParts.listenerCount(type)
    },
    setConfig(config) {
      storage.setItem(CONFIG_KEY, JSON.stringify(config))
    },
    lastApplied() {
      const raw = storage.getItem(LAST_APPLIED_KEY)
      return raw === null ? null : JSON.parse(raw)
    },
    status() {
      const raw = storage.getItem(STATUS_KEY)
      return raw === null ? null : JSON.parse(raw)
    },
    flush: clock.flush,
    advance: clock.advance,
    restore() {
      while (restores.length > 0) restores.pop()()
    },
  }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { CHANNEL, NAMESPACE } from '../lib/contract.js'
import { PAYLOADS } from '../lib/bridge/patch.js'

/**
 * 注入的主进程载荷是「一段会被拼进 `lib/main.js` 顶层的 ESM 代码」：它假定
 * `ipcMain` / `BrowserWindow` / `assertDesktopSender` / `createRequire` 已经在作用域里。
 *
 * 这里用 `vm` 造一个假主进程，把这些符号按真实签名塞进去，然后真的 `ipcMain.handle`
 * 注册、真的调处理器 —— 载荷能跑对，才算「注进去不会白注」。
 *
 * 唯一被改写的一处是 `import.meta.url`：`vm.Script` 不能承载模块语法（动态 `import()`
 * 还需要 `--experimental-vm-modules`），所以把它换成一个固定的 file URL 字面量；其余
 * 每个字节都是待验证的载荷本身。
 */
const MAIN_REQUIRE_URL = 'file:///app/resources/app/lib/main.js'

/**
 * 假 `BrowserWindow`：只实现载荷用到的那几个方法，并记录调用顺序。
 */
class FakeBrowserWindow {
  /** @type {Map<object, FakeBrowserWindow | null>} 假 WebContents → 窗口。 */
  static registry = new Map()

  /**
   * @param {{x?: number, y?: number, width?: number, height?: number}} [bounds] - 初始外框。
   */
  constructor(bounds = { x: 10, y: 20, width: 1280, height: 820 }) {
    this.bounds = { ...bounds }
    this.fullScreen = true
    this.maximized = true
    this.destroyed = false
    this.calls = []
    this.throwOnSetBounds = null
  }

  /**
   * @param {object} contents - 假 WebContents。
   * @returns {FakeBrowserWindow | null} 对应窗口。
   */
  static fromWebContents(contents) {
    return FakeBrowserWindow.registry.get(contents) ?? null
  }

  /** @returns {boolean} 是否已销毁。 */
  isDestroyed() {
    return this.destroyed
  }

  /** @returns {object} 当前外框副本。 */
  getBounds() {
    return { ...this.bounds }
  }

  /**
   * @param {object} next - 新外框。
   * @returns {void}
   */
  setBounds(next) {
    if (this.throwOnSetBounds) throw this.throwOnSetBounds
    this.calls.push(next)
    this.bounds = { ...next }
  }

  /**
   * @param {boolean} value - 是否全屏。
   * @returns {void}
   */
  setFullScreen(value) {
    this.fullScreen = value
  }

  /** @returns {void} */
  unmaximize() {
    this.maximized = false
  }
}

/**
 * 造一个假主进程并加载载荷，返回「调用通道」与观察用的句柄。
 *
 * @param {{
 *   window?: FakeBrowserWindow | null,
 *   senderUrl?: string,
 *   senderFrameIsMain?: boolean,
 *   workArea?: {x: number, y: number, width: number, height: number},
 * }} [options] - 场景开关。
 * @returns {{
 *   invoke: (args?: object) => Promise<object> | object,
 *   window: FakeBrowserWindow | null,
 *   ipcMain: {channels: Map<string, Function>},
 *   sender: object,
 * }} 调用入口与观察点。
 */
function loadMainSide(options = {}) {
  const workArea = options.workArea || { x: 0, y: 0, width: 1920, height: 1080 }
  const sender = { id: 'wc-1' }
  const window = options.window === undefined ? new FakeBrowserWindow() : options.window
  if (window) FakeBrowserWindow.registry.set(sender, window)
  const mainFrame = { url: options.senderUrl || 'dsh-app://app/' }
  sender.mainFrame = mainFrame
  const senderFrame = options.senderFrameIsMain === false ? { url: mainFrame.url } : mainFrame
  const event = { sender, senderFrame }
  const ipcMain = {
    channels: new Map(),
    handle(channel, handler) {
      this.channels.set(channel, handler)
    },
  }
  const sandbox = {
    ipcMain,
    BrowserWindow: FakeBrowserWindow,
    assertDesktopSender(eventArg, hostnames) {
      if (!eventArg.senderFrame) throw new Error('dsh desktop: rejected IPC without a sender frame')
      const url = new URL(eventArg.senderFrame.url)
      if (url.protocol !== 'dsh-app:' || !hostnames.includes(url.hostname)) {
        throw new Error('dsh desktop: rejected IPC from an unowned renderer')
      }
    },
    createRequire(url) {
      assert.equal(typeof url, 'string', 'createRequire 需要一个路径或 file URL')
      return (name) => {
        assert.equal(name, 'electron')
        return {
          screen: {
            getDisplayMatching(bounds) {
              assert.equal(typeof bounds.width, 'number')
              return { workArea: { ...workArea } }
            },
          },
        }
      }
    },
  }
  const source = `${PAYLOADS.mainHelpers}\n${PAYLOADS.mainHandler}`.replaceAll('import.meta.url', JSON.stringify(MAIN_REQUIRE_URL))
  const context = vm.createContext(sandbox)
  new vm.Script(source, { filename: 'injected-main.js' }).runInContext(context)
  const handler = ipcMain.channels.get(CHANNEL)
  assert.equal(typeof handler, 'function', `载荷必须注册 ${CHANNEL}`)
  return { invoke: (args) => handler(event, args), window, ipcMain, sender, mainFrame, senderFrame }
}

/**
 * 造一个假 preload 环境并加载载荷。
 *
 * @param {{hostname?: string, isMainFrame?: boolean, invoke?: Function}} [options] - 场景开关。
 * @returns {{exposed: Record<string, object>, calls: Array<{channel: string, payload: unknown}>}} 暴露的命名空间与调用记录。
 */
function loadPreloadSide(options = {}) {
  const calls = []
  const invokeImpl = options.invoke || (async (channel, payload) => ({ ok: true, channel, payload }))
  const exposed = {}
  const sandbox = {
    location: { hostname: options.hostname ?? 'app', protocol: 'dsh-app:' },
    process: { isMainFrame: options.isMainFrame ?? true },
    electron: {
      ipcRenderer: {
        invoke(channel, payload) {
          calls.push({ channel, payload })
          return invokeImpl(channel, payload)
        },
      },
      contextBridge: {
        exposeInMainWorld(name, value) {
          exposed[name] = value
        },
      },
    },
  }
  new vm.Script(PAYLOADS.preloadBridge, { filename: 'injected-preload.js' }).runInContext(vm.createContext(sandbox))
  return { exposed, calls, api: exposed[NAMESPACE] }
}

/**
 * 把 vm 里造出来的对象转回本 realm 的普通对象：跨 realm 的原型不同，
 * `assert.deepEqual` 会因原型不等而误报。序列化一遍是最省事的「按值比较」。
 *
 * @param {object} value - 注入代码返回的报文。
 * @returns {object} 同值的普通对象。
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

test('main 载荷注册了契约里的通道', () => {
  const main = loadMainSide()
  assert.deepEqual([...main.ipcMain.channels.keys()], [CHANNEL])
})

test('main 载荷：合法尺寸 → 退全屏/最大化、按工作区居中、回读 bounds', async () => {
  const main = loadMainSide({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  const result = await main.invoke({ width: 1280, height: 720 })
  assert.deepEqual(plain(result), { ok: true, bounds: { x: 320, y: 180, width: 1280, height: 720 } })
  assert.equal(main.window.fullScreen, false)
  assert.equal(main.window.maximized, false)
  assert.deepEqual(plain(main.window.calls), [{ x: 320, y: 180, width: 1280, height: 720 }])
})

test('main 载荷：工作区偏移时居中结果带偏移', async () => {
  const main = loadMainSide({ workArea: { x: 2560, y: 0, width: 2560, height: 1440 } })
  const result = await main.invoke({ width: 1600, height: 900 })
  assert.deepEqual(plain(result.bounds), { x: 2560 + 480, y: 270, width: 1600, height: 900 })
})

test('main 载荷：超过工作区时钳制到工作区（不留负坐标）', async () => {
  const main = loadMainSide({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  const result = await main.invoke({ width: 3840, height: 2160 })
  assert.deepEqual(plain(result.bounds), { x: 0, y: 0, width: 1920, height: 1080 })
})

test('main 载荷：低于窗口最小尺寸时抬到 520x600', async () => {
  const main = loadMainSide()
  const result = await main.invoke({ width: 200, height: 200 })
  assert.deepEqual(plain(result.bounds), { x: 700, y: 240, width: 520, height: 600 })
})

test('main 载荷：非整数、越界、缺字段都返回 invalid', async () => {
  const main = loadMainSide()
  for (const args of [{ width: 1280.5, height: 720 }, { width: 199, height: 720 }, { width: 1280 }, {}, null]) {
    const result = main.invoke(args)
    assert.equal(result.ok, false, JSON.stringify(args))
    assert.equal(result.code, 'invalid')
    assert.equal(typeof result.message, 'string')
  }
  assert.deepEqual(main.window.calls, [], '非法入参不能碰窗口')
})

test('main 载荷：非 dsh-app://app/ 发送方返回 not-desktop', () => {
  const rejected = loadMainSide({ senderUrl: 'https://example.com/' })
  assert.deepEqual(plain(rejected.invoke({ width: 1280, height: 720 })), {
    ok: false,
    code: 'not-desktop',
    message: 'bad sender',
  })
  const httpApp = loadMainSide({ senderUrl: 'http://app/' })
  assert.equal(httpApp.invoke({ width: 1280, height: 720 }).code, 'not-desktop')
  const subFrame = loadMainSide({ senderFrameIsMain: false })
  assert.equal(subFrame.invoke({ width: 1280, height: 720 }).code, 'not-desktop')
})

test('main 载荷：没有窗口 / 窗口已销毁返回 no-window', async () => {
  const noWindow = loadMainSide({ window: null })
  assert.equal((await noWindow.invoke({ width: 1280, height: 720 })).code, 'no-window')

  const destroyed = loadMainSide()
  destroyed.window.destroyed = true
  assert.equal((await destroyed.invoke({ width: 1280, height: 720 })).code, 'no-window')
})

test('main 载荷：getState 请求返回 patched/desktop 与当前 bounds；无窗口时省略 bounds', () => {
  const main = loadMainSide()
  assert.deepEqual(plain(main.invoke({ get: 1 })), {
    patched: true,
    desktop: true,
    bounds: { x: 10, y: 20, width: 1280, height: 820 },
  })
  const noWindow = loadMainSide({ window: null })
  const state = noWindow.invoke({ get: 1 })
  assert.deepEqual(plain(state), { patched: true, desktop: true })
  assert.equal('bounds' in state, false)
})

test('main 载荷：setBounds 抛错时映射成 rejected 而不是崩主进程', async () => {
  const main = loadMainSide()
  main.window.throwOnSetBounds = new Error('window is not resizable')
  const result = await main.invoke({ width: 1280, height: 720 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'rejected')
  assert.match(result.message, /not resizable/)
})

test('main 载荷：先退全屏再钳制，即使窗口原本是全屏/最大化', async () => {
  const main = loadMainSide()
  main.window.fullScreen = true
  main.window.maximized = true
  const result = await main.invoke({ width: 1366, height: 768 })
  assert.equal(result.ok, true)
  assert.equal(main.window.fullScreen, false)
  assert.equal(main.window.maximized, false)
})

test('preload 载荷把命名空间挂到 window 上，形状符合契约', () => {
  const preload = loadPreloadSide()
  assert.deepEqual(Object.keys(preload.exposed), [NAMESPACE])
  const api = preload.api
  assert.equal(api.v, 1)
  assert.equal(typeof api.setBounds, 'function')
  assert.equal(typeof api.getState, 'function')
})

test('preload 载荷：setBounds 走 invoke(CHANNEL, args)', async () => {
  const preload = loadPreloadSide()
  await preload.api.setBounds({ width: 1280, height: 720 })
  assert.deepEqual(plain(preload.calls), [{ channel: CHANNEL, payload: { width: 1280, height: 720 } }])
})

test('preload 载荷：getState 发 {get:1}，透传主进程报文', async () => {
  const preload = loadPreloadSide({
    invoke: async () => ({ patched: true, desktop: true, bounds: { x: 0, y: 0, width: 1, height: 1 } }),
  })
  const state = await preload.api.getState()
  assert.deepEqual(plain(preload.calls), [{ channel: CHANNEL, payload: { get: 1 } }])
  assert.deepEqual(plain(state), { patched: true, desktop: true, bounds: { x: 0, y: 0, width: 1, height: 1 } })
})

test('preload 载荷：handler 缺席时 getState 降级成 {patched:false,desktop:true}', async () => {
  const preload = loadPreloadSide({
    invoke: async () => {
      throw new Error('No handler registered')
    },
  })
  assert.deepEqual(plain(await preload.api.getState()), { patched: false, desktop: true })
})

test('preload 载荷：非 app 窗口或子框架不暴露命名空间', () => {
  assert.deepEqual(Object.keys(loadPreloadSide({ hostname: 'other' }).exposed), [])
  assert.deepEqual(Object.keys(loadPreloadSide({ isMainFrame: false }).exposed), [])
  assert.deepEqual(Object.keys(loadPreloadSide({ hostname: 'app', isMainFrame: false }).exposed), [])
})

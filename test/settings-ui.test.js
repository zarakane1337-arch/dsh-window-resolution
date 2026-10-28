import assert from 'node:assert/strict'
import test from 'node:test'

import { collect, createReact, numberInputs, radios } from './helpers/fake-react.js'
import {
  createContext,
  createFakeStorage,
  createFakeWindow,
  loadClient,
  textOf,
} from './helpers/client-harness.js'
import { PRESETS } from '../lib/config.js'
import { STATUS_KEY } from './helpers/startup-harness.js'

/** 设置页写配置用的 localStorage 键（必须与 docs/settings-ui.md 一致）。 */
const STORAGE_KEY = 'dsh-window-resolution:config'

/** 配置变更广播的事件名（T04 的启动强制应用也听它）。 */
const CHANGE_EVENT = 'dsh-window-resolution:changed'

/** 自定义宽高输入的防抖时长，必须与实现一致。 */
const DEBOUNCE_MS = 400

/**
 * 等待若干毫秒，让桥接返回的 Promise 落地。
 *
 * @param {number} [ms] - 等待毫秒数。
 * @returns {Promise<void>} 等待完成。
 */
function wait(ms = 5) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等过一次防抖窗口（多给 100ms 富余）。 */
function settle() {
  return wait(DEBOUNCE_MS + 100)
}

/**
 * 造一个记录调用的假桌面桥。
 *
 * @param {{
 *   v?: number,
 *   result?: (input: {width: number, height: number}) => object,
 *   state?: object | (() => object),
 * }} [options] - 版本、setBounds 返回值、getState 返回值。
 * @returns {object} 假桥，`calls` 记录每次 setBounds 入参。
 */
function fakeBridge(options = {}) {
  const calls = []
  const bridge = {
    calls,
    v: options.v === undefined ? 1 : options.v,
    setBounds(input) {
      calls.push(input)
      if (typeof options.result === 'function') return Promise.resolve(options.result(input))
      return Promise.resolve({
        ok: true,
        bounds: { x: 8, y: 8, width: input.width, height: input.height },
      })
    },
    getState() {
      if (typeof options.state === 'function') return Promise.resolve(options.state())
      return Promise.resolve(options.state || { patched: true, desktop: true })
    },
  }
  return bridge
}

/**
 * 加载客户端、注册分区并挂载组件。
 *
 * @param {{
 *   seed?: Record<string, string>, storage?: object, bridge?: object, win?: object,
 * }} [options] - 存储种子、桌面桥、显式假 window、语言。
 * @returns {{
 *   exports: object, win: object, storage: object, bridge: object | undefined,
 *   view: {tree: unknown, text: string, unmount: () => void},
 * }} 可交互的视图与依赖。
 */
function setup(options = {}) {
  const seed = options.seed || {}
  const storage = options.storage || createFakeStorage()
  const win = options.win || createFakeWindow({ storage, bridge: options.bridge })
  const { react, mount } = createReact()
  const { exports } = loadClient({ react, window: win, language: 'zh-CN' })
  const { ctx, record } = createContext({ boundLanguage: 'zh' })
  exports.apply(ctx)
  /*
   * 种子在 apply 之后写入：模拟“启动应用已经跑完并把结果落盘，用户随后打开设置页”。
   * 若在 apply 之前写入，T04 的启动流程会按当前假环境再写一次状态键，把种子覆盖掉。
   */
  for (const [key, value] of Object.entries(seed)) storage.setItem(key, value)
  record.inject[0].callback()
  const view = mount(record.register[0].component)
  return { exports, win, storage, bridge: options.bridge, view }
}

/**
 * 按 `value` 找单选框。
 *
 * @param {object} view - 挂载视图。
 * @param {string} value - 单选框的 value。
 * @returns {object | undefined} 单选框元素。
 */
function radioByValue(view, value) {
  return radios(view.tree).find((radio) => radio.props.value === value)
}

/**
 * 选中一个单选框（模拟用户点击）。
 *
 * @param {object} radio - 单选框元素。
 * @returns {void}
 */
function choose(radio) {
  assert.ok(radio, '找不到目标单选框')
  radio.props.onChange({ target: { value: radio.props.value, checked: true } })
}

/**
 * 取带 `data-field` 的数字输入框。
 *
 * @param {object} view - 挂载视图。
 * @param {'width' | 'height'} field - 字段名。
 * @returns {object | undefined} 输入框元素。
 */
function fieldInput(view, field) {
  return numberInputs(view.tree).find((input) => input.props['data-field'] === field)
}

/**
 * 往输入框里键入一个值。
 *
 * @param {object} input - 输入框元素。
 * @param {string} value - 键入的原始文本。
 * @returns {void}
 */
function typeInto(input, value) {
  assert.ok(input, '找不到目标输入框')
  input.props.onChange({ target: { value } })
}

/**
 * 读取带 `data-role` 的元素文本。
 *
 * @param {object} view - 挂载视图。
 * @param {string} role - `status` / `error` / `applied`。
 * @returns {string} 元素文本（不存在时为空串）。
 */
function textByRole(view, role) {
  const found = collect(view.tree, (node) => node.props && node.props['data-role'] === role)
  return found.length > 0 ? textOf(found[0]) : ''
}

/**
 * 用 locale 模板填值。
 *
 * @param {object} exports - 客户端导出。
 * @param {string} key - locale key。
 * @param {Record<string, string | number>} values - 占位符。
 * @returns {string} 填好的文案。
 */
function fill(exports, key, values) {
  let text = exports.locales.zh[key]
  for (const [name, value] of Object.entries(values)) text = text.split(`{${name}}`).join(String(value))
  return text
}

/**
 * 从 localStorage 里读回插件配置。
 *
 * @param {object} storage - 假存储。
 * @returns {object | null} 解析后的配置。
 */
function storedConfig(storage) {
  const raw = storage.data.get(STORAGE_KEY)
  return raw === undefined ? null : JSON.parse(raw)
}

test('渲染六档预设、自定义与关闭选项', () => {
  const { view, exports } = setup()
  const options = radios(view.tree)
  assert.equal(options.length, PRESETS.length + 2, '六档预设 + 自定义 + 关闭')
  for (const preset of PRESETS) {
    assert.ok(radioByValue(view, `preset:${preset.key}`), `缺少预设 ${preset.key}`)
    assert.ok(
      textOf(view.tree).includes(`${preset.width} × ${preset.height}`),
      `缺少 ${preset.key} 的尺寸文案`,
    )
  }
  assert.ok(radioByValue(view, 'custom'), '缺少自定义选项')
  assert.ok(radioByValue(view, 'off'), '缺少关闭选项')
  assert.ok(textOf(view.tree).includes(exports.locales.zh.presetsLabel), '缺少预设分组标题')
  assert.ok(textOf(view.tree).includes(exports.locales.zh.modeCustom), '缺少自定义文案')
  assert.ok(textOf(view.tree).includes(exports.locales.zh.modeOff), '缺少关闭文案')
})

test('首次打开默认关闭，不主动改动窗口', async () => {
  const bridge = fakeBridge()
  const { view, storage, exports } = setup({ bridge })
  assert.equal(radioByValue(view, 'off').props.checked, true)
  assert.equal(radioByValue(view, 'preset:1920x1080').props.checked, false)
  await wait()
  assert.deepEqual(bridge.calls, [], '默认关闭时不得调用 setBounds')
  assert.equal(storage.data.get(STORAGE_KEY), undefined, '未经用户操作时不应写入存储')
  assert.ok(textByRole(view, 'status').includes(exports.locales.zh.statusOff))
})

test('选择预设后立即调用 setBounds，并用返回的 bounds 回显实际尺寸', async () => {
  const bridge = fakeBridge({
    result: (input) => ({
      ok: true,
      bounds: { x: 0, y: 0, width: input.width, height: input.height - 40 },
    }),
  })
  const { view, exports } = setup({ bridge })

  choose(radioByValue(view, 'preset:1366x768'))
  assert.deepEqual(bridge.calls, [{ width: 1366, height: 768 }], '选择后必须立刻发起一次 setBounds')

  await wait()
  const applied = textByRole(view, 'applied')
  assert.ok(
    applied.includes(fill(exports, 'statusApplied', { width: 1366, height: 728 })),
    `回显必须用返回的 bounds：${applied}`,
  )
})

test('选择预设后把配置写进 localStorage', () => {
  const { view, storage } = setup({ bridge: fakeBridge() })
  choose(radioByValue(view, 'preset:2560x1440'))
  assert.deepEqual(storedConfig(storage), {
    mode: 'preset',
    width: 2560,
    height: 1440,
    presetValue: '2560x1440',
  })
})

test('选择自定义后出现宽高输入，初值为当前尺寸', () => {
  const { view, exports } = setup({
    bridge: fakeBridge(),
    seed: { [STORAGE_KEY]: JSON.stringify({ mode: 'custom', width: 1600, height: 900 }) },
  })
  assert.equal(radioByValue(view, 'custom').props.checked, true)
  const width = fieldInput(view, 'width')
  const height = fieldInput(view, 'height')
  assert.ok(width && height, '自定义模式必须渲染两个输入框')
  assert.equal(width.props.value, '1600')
  assert.equal(height.props.value, '900')
  assert.ok(textOf(view.tree).includes(exports.locales.zh.widthLabel))
  assert.ok(textOf(view.tree).includes(exports.locales.zh.heightLabel))
})

test('自定义宽高非法时给出行内提示，且不发 IPC', async () => {
  const bridge = fakeBridge()
  const { view, exports } = setup({ bridge })
  choose(radioByValue(view, 'custom'))

  for (const bad of ['abc', '', '100', '16385', '-5', '1.5']) {
    typeInto(fieldInput(view, 'width'), bad)
    assert.ok(
      textByRole(view, 'error').includes(exports.locales.zh.invalidSize),
      `非法值 ${JSON.stringify(bad)} 必须给出行内提示`,
    )
  }

  await settle()
  assert.deepEqual(bridge.calls, [], '非法输入不得发 IPC')
})

test('自定义合法输入在防抖后应用并持久化', async () => {
  const bridge = fakeBridge()
  const { view, storage } = setup({ bridge })
  choose(radioByValue(view, 'custom'))
  typeInto(fieldInput(view, 'width'), '1600')
  typeInto(fieldInput(view, 'height'), '900')

  assert.deepEqual(bridge.calls, [], '防抖窗口内不应立刻发 IPC')
  await settle()
  assert.deepEqual(bridge.calls, [{ width: 1600, height: 900 }])
  assert.equal(textByRole(view, 'error'), '', '合法输入不得留下错误提示')
  assert.deepEqual(storedConfig(storage), {
    mode: 'custom',
    width: 1600,
    height: 900,
    presetValue: '1600x900',
  })
})

test('连续输入只应用最后一次', async () => {
  const bridge = fakeBridge()
  const { view } = setup({ bridge })
  choose(radioByValue(view, 'custom'))
  typeInto(fieldInput(view, 'width'), '1280')
  await wait(50)
  typeInto(fieldInput(view, 'width'), '1366')
  await wait(50)
  typeInto(fieldInput(view, 'width'), '1920')
  await settle()
  assert.deepEqual(bridge.calls, [{ width: 1920, height: 1080 }])
})

test('卸载后尚未触发的防抖定时器被清掉', async () => {
  const bridge = fakeBridge()
  const { view } = setup({ bridge })
  choose(radioByValue(view, 'custom'))
  typeInto(fieldInput(view, 'width'), '1280')
  view.unmount()
  await settle()
  assert.deepEqual(bridge.calls, [], '卸载后不得再发 IPC')
})

test('从 localStorage 恢复配置并回显选中项，但不重新应用', async () => {
  const bridge = fakeBridge()
  const { view, storage } = setup({
    bridge,
    seed: { [STORAGE_KEY]: JSON.stringify({ mode: 'preset', presetValue: '3840x2160' }) },
  })
  assert.equal(radioByValue(view, 'preset:3840x2160').props.checked, true)
  await settle()
  assert.deepEqual(bridge.calls, [], '启动时由 T04 负责强制应用，设置页只负责回显')
  assert.equal(storedConfig(storage).mode, 'preset')
})

test('存储损坏或非法时回落到默认配置', () => {
  const raws = [
    '{not json',
    'null',
    '"text"',
    JSON.stringify({ mode: 'nope' }),
    JSON.stringify({ mode: 'custom', width: 10, height: 10 }),
  ]
  for (const raw of raws) {
    const { view } = setup({ seed: { [STORAGE_KEY]: raw } })
    assert.equal(radioByValue(view, 'off').props.checked, true, `非法存储 ${raw} 必须回落到关闭`)
  }
})

test('读取 localStorage 抛错时回落到默认配置且不抛错', () => {
  const storage = createFakeStorage()
  storage.throwOnGet = true
  assert.doesNotThrow(() => {
    const { view } = setup({ storage })
    assert.equal(radioByValue(view, 'off').props.checked, true)
  })
})

test('写入 localStorage 抛错时仍立即应用', async () => {
  const bridge = fakeBridge()
  const storage = createFakeStorage()
  storage.throwOnSet = true
  const { view, exports } = setup({ bridge, storage })
  assert.doesNotThrow(() => choose(radioByValue(view, 'preset:1280x720')))
  assert.deepEqual(bridge.calls, [{ width: 1280, height: 720 }])
  await wait()
  assert.ok(
    textByRole(view, 'applied').includes(fill(exports, 'statusApplied', { width: 1280, height: 720 })),
  )
})

test('关闭项也持久化，且不调用 setBounds', () => {
  const bridge = fakeBridge()
  const { view, storage } = setup({
    bridge,
    seed: { [STORAGE_KEY]: JSON.stringify({ mode: 'preset', presetValue: '1920x1080' }) },
  })
  choose(radioByValue(view, 'off'))
  assert.deepEqual(bridge.calls, [])
  assert.deepEqual(storedConfig(storage), {
    mode: 'off',
    width: 1920,
    height: 1080,
    presetValue: '1920x1080',
  })
})

test('通道缺失时显示静态提示，交互不抛错', () => {
  const { view, storage, exports } = setup()
  const status = textByRole(view, 'status')
  assert.ok(status.includes(exports.locales.zh.statusNotDesktop), `缺少非桌面提示：${status}`)
  assert.ok(status.includes(exports.locales.zh.statusNotPatched), `缺少未注入提示：${status}`)
  assert.doesNotThrow(() => choose(radioByValue(view, 'preset:1280x720')))
  assert.equal(storedConfig(storage).mode, 'preset', '通道缺失也要能记住选择')
})

test('通道版本不符时按未注入降级，不调用 setBounds', async () => {
  const bridge = fakeBridge({ v: 2 })
  const { view, exports } = setup({ bridge })
  await wait()
  assert.ok(
    textByRole(view, 'status').includes(exports.locales.zh.statusNotPatched),
    'v !== 1 必须按「未注入」提示',
  )
  assert.doesNotThrow(() => choose(radioByValue(view, 'preset:1280x720')))
  await wait()
  assert.deepEqual(bridge.calls, [])
})

test('getState 存在时显示 patched / desktop 状态与当前窗口尺寸', async () => {
  const bridge = fakeBridge({
    state: { patched: true, desktop: true, bounds: { x: 0, y: 0, width: 1600, height: 900 } },
  })
  const { view, exports } = setup({ bridge })
  await wait()
  const status = textByRole(view, 'status')
  assert.ok(status.includes(exports.locales.zh.statusDesktop), `缺少桌面端提示：${status}`)
  assert.ok(status.includes(exports.locales.zh.statusPatched), `缺少通道就绪提示：${status}`)
  assert.ok(
    textByRole(view, 'applied').includes(fill(exports, 'statusApplied', { width: 1600, height: 900 })),
    '应回显 getState 报告的实际尺寸',
  )
})

test('getState 报告未注入时显示未注入提示', async () => {
  const bridge = fakeBridge({ state: { patched: false, desktop: true } })
  const { view, exports } = setup({ bridge })
  await wait()
  const status = textByRole(view, 'status')
  assert.ok(status.includes(exports.locales.zh.statusNotPatched))
  assert.ok(status.includes(exports.locales.zh.statusDesktop))
})

test('getState 抛错或返回垃圾时静默降级', async () => {
  const throwing = fakeBridge()
  throwing.getState = () => Promise.reject(new Error('boom'))
  assert.doesNotThrow(() => setup({ bridge: throwing }))
  await wait()

  const junk = fakeBridge()
  junk.getState = () => Promise.resolve(null)
  const { view, exports } = setup({ bridge: junk })
  await wait()
  assert.ok(textByRole(view, 'status').includes(exports.locales.zh.statusNotPatched))
})

test('错误码映射为对应文案', async () => {
  const cases = [
    ['no-window', 'window is gone', 'statusNoWindow', false],
    ['not-patched', 'no channel', 'statusNotPatched', false],
    ['not-desktop', 'not desktop', 'statusNotDesktop', false],
    ['invalid', 'bad size', 'statusError', true],
  ]
  for (const [code, message, key, filled] of cases) {
    const bridge = fakeBridge({ result: () => ({ ok: false, code, message }) })
    const { view, exports } = setup({ bridge })
    choose(radioByValue(view, 'preset:1280x720'))
    await wait()
    const expected = filled ? fill(exports, key, { message }) : exports.locales.zh[key]
    assert.ok(
      textByRole(view, 'status').includes(expected),
      `错误码 ${code} 应映射到 ${key}：${textByRole(view, 'status')}`,
    )
  }
})

test('rejected 展示 message 原文', async () => {
  const bridge = fakeBridge({
    result: () => ({ ok: false, code: 'rejected', message: 'too small for 4K' }),
  })
  const { view, exports } = setup({ bridge })
  choose(radioByValue(view, 'preset:3840x2160'))
  await wait()
  assert.ok(
    textByRole(view, 'status').includes(fill(exports, 'statusRejected', { message: 'too small for 4K' })),
    `rejected 必须展示 message 原文：${textByRole(view, 'status')}`,
  )
})

test('setBounds 抛错时降级为通用错误文案', async () => {
  const bridge = fakeBridge()
  bridge.setBounds = () => Promise.reject(new Error('ipc exploded'))
  const { view, exports } = setup({ bridge })
  assert.doesNotThrow(() => choose(radioByValue(view, 'preset:1280x720')))
  await wait()
  assert.ok(
    textByRole(view, 'status').includes(fill(exports, 'statusError', { message: 'ipc exploded' })),
  )
})

test('变更时广播 CustomEvent，detail 是完整配置', () => {
  const { view, win } = setup({ bridge: fakeBridge() })
  const events = []
  win.addEventListener(CHANGE_EVENT, (event) => events.push(event.detail))
  choose(radioByValue(view, 'preset:1920x1080'))
  assert.deepEqual(events, [
    { mode: 'preset', width: 1920, height: 1080, presetValue: '1920x1080' },
  ])
})

test('外部广播的配置会同步刷新界面且不重复写存储', () => {
  const bridge = fakeBridge()
  const storage = createFakeStorage()
  const { view, win } = setup({ bridge, storage })
  const writes = []
  const originalSet = storage.setItem
  storage.setItem = (key, value) => {
    writes.push(key)
    return originalSet(key, value)
  }

  win.dispatchEvent(
    new CustomEvent(CHANGE_EVENT, {
      detail: { mode: 'preset', presetValue: '3840x2160' },
    }),
  )
  assert.equal(radioByValue(view, 'preset:3840x2160').props.checked, true)
  assert.deepEqual(writes, [], '外部变更不应回写存储')
  assert.deepEqual(bridge.calls, [], '外部变更只改变显示，应用由广播方负责')
})

test('卸载时移除事件监听', () => {
  const storage = createFakeStorage()
  const win = createFakeWindow({ storage, bridge: fakeBridge() })
  const added = []
  const removed = []
  const originalAdd = win.addEventListener.bind(win)
  const originalRemove = win.removeEventListener.bind(win)
  win.addEventListener = (type, handler, ...rest) => {
    if (type === CHANGE_EVENT) added.push(handler)
    return originalAdd(type, handler, ...rest)
  }
  win.removeEventListener = (type, handler, ...rest) => {
    if (type === CHANGE_EVENT) removed.push(handler)
    return originalRemove(type, handler, ...rest)
  }

  const { view } = setup({ win })
  assert.equal(added.length, 1, '挂载时应订阅一次变更广播')
  view.unmount()
  assert.equal(removed.length, 1, '卸载时必须解绑')
  assert.equal(removed[0], added[0], '解绑的必须是同一个处理函数')
})

test('状态区展示上次启动的应用结果', async () => {
  const { view, exports } = setup({
    seed: { [STATUS_KEY]: JSON.stringify({ state: 'applied', width: 2560, height: 1440, at: 1 }) },
  })
  await wait()
  assert.ok(
    textByRole(view, 'status').includes(
      fill(exports, 'statusStartupApplied', { width: 2560, height: 1440 }),
    ),
    `状态区应展示启动应用结果：${textByRole(view, 'status')}`,
  )
})

test('状态区展示上次启动失败的原因', async () => {
  const { view, exports } = setup({
    seed: {
      [STATUS_KEY]: JSON.stringify({ state: 'failed', code: 'no-window', message: 'no window yet', at: 1 }),
    },
  })
  await wait()
  const status = textByRole(view, 'status')
  assert.ok(status.includes(exports.locales.zh.statusNoWindow), `失败状态应映射错误码：${status}`)
})

test('状态区展示 pending 与未注入状态', async () => {
  const pending = setup({ seed: { [STATUS_KEY]: JSON.stringify({ state: 'pending', attempts: 2 }) } })
  await wait()
  assert.ok(textByRole(pending.view, 'status').includes(pending.exports.locales.zh.statusPending))

  const notPatched = setup({ seed: { [STATUS_KEY]: JSON.stringify({ state: 'not-patched' }) } })
  await wait()
  assert.ok(
    textByRole(notPatched.view, 'status').includes(notPatched.exports.locales.zh.statusNotPatched),
  )
})

test('加载客户端不产生副作用：不读存储、不调桥', () => {
  const storage = createFakeStorage()
  const bridge = fakeBridge()
  loadClient({ react: createReact().react, window: createFakeWindow({ storage, bridge }) })
  assert.equal(storage.data.size, 0)
  assert.deepEqual(bridge.calls, [])
})

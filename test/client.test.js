import assert from 'node:assert/strict'
import test from 'node:test'

import { createContext, createFakeWindow, loadClient, textOf, withBrowserLanguage } from './helpers/client-harness.js'
import { createReact } from './helpers/fake-react.js'

/**
 * 拿一份加载好的客户端与一份记录型上下文。
 *
 * @param {{language?: string, withLocale?: boolean}} [options] - 加载选项（语言、是否提供 locale 服务）。
 * @returns {{exports: object, ctx: object, record: object}} 客户端导出、上下文与调用记录。
 */
function setup(options = {}) {
  const { exports } = loadClient({ language: options.language })
  const { ctx, record } = createContext({ withLocale: options.withLocale !== false })
  return { exports, ctx, record }
}

test('客户端以包名登记 lazy factory，并只注入插槽服务', () => {
  const { entry, exports } = loadClient()
  assert.equal(entry.id, 'dsh-window-resolution', 'id 必须与包名一致')
  assert.equal(typeof entry.factory, 'function')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
})

test('apply 在设置体系注册一个 settings.section 分区', () => {
  const { exports, ctx, record } = setup()
  exports.apply(ctx)
  assert.equal(record.inject.length, 1)
  assert.equal(record.inject[0].name, 'settings.section')
  assert.deepEqual(record.register, [], '注册必须发生在插槽就绪回调里，而不是立即注册')

  record.inject[0].callback()
  assert.equal(record.register.length, 1)
  const { meta, component } = record.register[0]
  assert.equal(meta.name, 'settings.section')
  assert.equal(typeof meta.id, 'string')
  assert.ok(meta.id.length > 0)
  assert.equal(typeof meta.order, 'number')
  assert.equal(typeof meta.label, 'function')
  assert.equal(typeof component, 'function')
})

test('分区标题跟随当前语言（未接入 locale 服务时退回 navigator）', () => {
  const en = setup({ language: 'en-US', withLocale: false })
  en.exports.apply(en.ctx)
  en.record.inject[0].callback()
  assert.equal(
    withBrowserLanguage('en-US', () => en.record.register[0].meta.label()),
    'Window Resolution',
  )

  const zh = setup({ language: 'zh-CN', withLocale: false })
  zh.exports.apply(zh.ctx)
  zh.record.inject[0].callback()
  assert.equal(
    withBrowserLanguage('zh-CN', () => zh.record.register[0].meta.label()),
    '窗口分辨率',
  )
})

test('接入 locale 服务后标题跟随应用语言，而不是浏览器语言', () => {
  const { exports, ctx, record } = setup({ language: 'en-US' })
  exports.apply(ctx)
  record.inject[0].callback()
  const label = record.register[0].meta.label
  assert.deepEqual(record.localeRegister.map((entry) => entry.namespace), ['dsh-window-resolution'])
  assert.deepEqual(record.localeBind, ['dsh-window-resolution'])
  assert.equal(label(), '窗口分辨率', 'boundLanguage 默认 zh，应压过 navigator 的 en-US')
})

test('设置分区渲染标题与一行说明', () => {
  const { react, mount } = createReact()
  const { exports } = loadClient({
    react,
    window: createFakeWindow(),
    language: 'en-US',
  })
  const { ctx, record } = createContext({ boundLanguage: 'en' })
  exports.apply(ctx)
  record.inject[0].callback()
  const view = mount(record.register[0].component)
  assert.ok(view.element && typeof view.element === 'object', '必须返回可渲染的元素')
  assert.ok(view.text.includes('Window Resolution'), `标题缺失: ${view.text}`)
  assert.ok(view.text.includes(exports.locales.en.sectionDescription), `说明缺失: ${view.text}`)
  view.unmount()
})

test('上下文不完整或插槽未就绪时静默降级，绝不抛错', () => {
  const { exports } = loadClient()
  assert.doesNotThrow(() => exports.apply({}))
  assert.doesNotThrow(() => exports.apply(undefined))
  assert.doesNotThrow(() => exports.apply(null))

  const { ctx, record } = createContext({ throwOnInject: true })
  assert.doesNotThrow(() => exports.apply(ctx), '插槽注入抛错必须被吞掉')
  assert.deepEqual(record.register, [], '注入失败时不得继续注册')
})

test('骨架没有任何自启行为：不注册 effect，也不监听全局事件', () => {
  const { exports, ctx, record } = setup()
  exports.apply(ctx)
  assert.deepEqual(record.effects, [])
  assert.deepEqual(record.events, [])
  assert.equal(record.logs.length, 0, '客户端不应往宿主日志里写东西')
})

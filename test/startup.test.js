import assert from 'node:assert/strict'
import test from 'node:test'

import { createContext, loadClient } from './helpers/client-harness.js'
import { createStartupEnvironment } from './helpers/startup-harness.js'

/**
 * 在假浏览器环境里加载客户端并跑一次 `apply()`。
 *
 * 接缝是客户端对外的 `exports.apply(ctx)`：测试只观察它对外产生的效果
 * （桥调用、localStorage、document 监听器），不碰内部函数。
 *
 * @param {object} options - 透传给 `createStartupEnvironment`。
 * @returns {{env: object, exports: object, ctx: object, record: object}} 环境与客户端。
 */
function boot(options) {
  const env = createStartupEnvironment(options)
  const { exports } = loadClient()
  const { ctx, record } = createContext()
  exports.apply(ctx)
  return { env, exports, ctx, record }
}

/**
 * 按注册顺序释放所有 `ctx.effect`。
 *
 * @param {object} record - `createContext` 的调用记录。
 */
function disposeAll(record) {
  for (const effect of record.effects) {
    const dispose = effect.fn()
    if (typeof dispose === 'function') dispose()
  }
}

test('启动时把持久化配置应用到窗口，并把实际 bounds 记为 lastApplied', async () => {
  const { env } = boot({
    config: { mode: 'preset', width: 1600, height: 900, presetValue: '1600x900' },
  })
  try {
    await env.flush()

    assert.deepEqual(env.calls, [{ width: 1600, height: 900 }], '应按配置调用一次 setBounds')
    assert.equal(env.status().state, 'applied')

    const lastApplied = env.lastApplied()
    assert.ok(lastApplied, '应用成功后必须记录 lastApplied')
    assert.equal(lastApplied.width, 1600)
    assert.equal(lastApplied.height, 900)
    assert.equal(typeof lastApplied.at, 'number')
  } finally {
    env.restore()
  }
})

test('浏览器标签页（非 dsh-app:）里不碰窗口，也不注册清理资源', async () => {
  const { env, record } = boot({
    protocol: 'https:',
    config: { mode: 'custom', width: 1280, height: 800 },
  })
  try {
    await env.flush()

    assert.deepEqual(env.calls, [], '非桌面端不应尝试改窗口')
    assert.equal(env.status().state, 'not-desktop')
    assert.equal(record.effects.length, 0, '无事可做就不该注册 effect')
    assert.equal(env.listenerCount(), 0)
  } finally {
    env.restore()
  }
})

test('配置为 mode:off 时跳过应用，也不注册清理资源', async () => {
  const { env, record } = boot({
    config: { mode: 'off', width: 1920, height: 1080, presetValue: '1920x1080' },
  })
  try {
    await env.flush()

    assert.deepEqual(env.calls, [])
    assert.equal(env.status().state, 'off')
    assert.equal(record.effects.length, 0)
    assert.equal(env.listenerCount(), 0)
  } finally {
    env.restore()
  }
})

test('配置尺寸越界时按关闭处理，不把非法尺寸发给主进程', async () => {
  const { env } = boot({ config: { mode: 'custom', width: 100, height: 1080 } })
  try {
    await env.flush()

    assert.deepEqual(env.calls, [])
    assert.equal(env.status().state, 'off')
  } finally {
    env.restore()
  }
})

test('通道始终缺席时只探测 3 次就放弃，并记为 not-patched', async () => {
  const { env } = boot({
    bridge: null,
    config: { mode: 'preset', width: 1600, height: 900 },
  })
  try {
    await env.flush()
    assert.deepEqual(env.calls, [])
    assert.equal(env.status().state, 'pending')

    await env.advance(5000)
    assert.deepEqual(env.calls, [])
    assert.equal(env.status().state, 'not-patched')
    assert.ok(env.bridgeReads >= 3, '应至少探测 3 次通道')
    assert.equal(env.clock.pending(), 0, '放弃后不应留下定时器')
  } finally {
    env.restore()
  }
})

test('通道版本不兼容（v!==1）时按未注入降级，不调用', async () => {
  const { env } = boot({
    bridge: {
      v: 2,
      setBounds() {
        throw new Error('must not be called')
      },
    },
    config: { mode: 'custom', width: 1600, height: 900 },
  })
  try {
    await env.flush()
    await env.advance(5000)

    assert.deepEqual(env.calls, [])
    assert.equal(env.status().state, 'not-patched')
  } finally {
    env.restore()
  }
})

test('通道在启动过程中晚就绪时，重试到可用为止并在成功后停止', async () => {
  const { env } = boot({
    bridge: null,
    config: { mode: 'preset', width: 1600, height: 900 },
  })
  try {
    await env.flush()
    await env.advance(600)
    assert.deepEqual(env.calls, [], '通道未就绪时不该调用')

    env.setBridge({
      v: 1,
      setBounds(input) {
        env.calls.push({ width: input.width, height: input.height })
        return { ok: true, bounds: { x: 0, y: 0, width: input.width, height: input.height } }
      },
    })
    await env.advance(600)

    assert.deepEqual(env.calls, [{ width: 1600, height: 900 }])
    assert.equal(env.status().state, 'applied')
    assert.equal(env.clock.pending(), 0, '成功后不应再排重试')

    await env.advance(10_000)
    assert.equal(env.calls.length, 1, '成功一次后必须停止')
  } finally {
    env.restore()
  }
})

test('主进程暂态拒绝（no-window）会退避重试，成功后停止', async () => {
  const { env } = boot({
    config: { mode: 'custom', width: 1600, height: 900 },
    setBounds(input, call) {
      if (call === 1) return { ok: false, code: 'no-window', message: 'window not ready' }
      return { ok: true, bounds: { x: 0, y: 0, width: input.width, height: input.height } }
    },
  })
  try {
    await env.flush()
    assert.equal(env.calls.length, 1)
    assert.equal(env.status().state, 'pending')

    await env.advance(399)
    assert.equal(env.calls.length, 1, '未到 400ms 不该重试')
    await env.advance(1)
    assert.equal(env.calls.length, 2)
    assert.equal(env.status().state, 'applied')

    await env.advance(10_000)
    assert.equal(env.calls.length, 2, '成功后必须停止')
  } finally {
    env.restore()
  }
})

test('终端错误（invalid）不重试，只记录失败状态', async () => {
  const { env } = boot({
    config: { mode: 'custom', width: 1600, height: 900 },
    setBounds() {
      return { ok: false, code: 'invalid', message: 'bad size' }
    },
  })
  try {
    await env.flush()
    await env.advance(10_000)

    assert.equal(env.calls.length, 1, '终端错误重试也不会变好')
    assert.equal(env.status().state, 'failed')
    assert.equal(env.status().code, 'invalid')
  } finally {
    env.restore()
  }
})

test('桥抛错时静默重试，不让异常冒泡打断界面', async () => {
  const { env } = boot({
    config: { mode: 'custom', width: 1600, height: 900 },
    setBounds() {
      throw new Error('bridge exploded')
    },
  })
  try {
    await env.flush()
    await env.advance(10_000)

    assert.equal(env.calls.length, 10, '有通道时预算 10 次')
    assert.equal(env.status().state, 'failed')
    assert.equal(env.status().code, 'rejected')
    assert.equal(env.clock.pending(), 0, '用尽预算后不应留下定时器')
  } finally {
    env.restore()
  }
})

test('窗口重新可见且配置与 lastApplied 不一致时，debounce 1s 后重新应用', async () => {
  const { env } = boot({
    config: { mode: 'preset', width: 1600, height: 900 },
    lastApplied: { width: 1280, height: 720, at: 1 },
  })
  try {
    await env.flush()
    assert.equal(env.calls.length, 1, '启动先应用一次')

    env.setConfig({ mode: 'custom', width: 1920, height: 1080 })
    env.setVisibility('hidden')
    env.setVisibility('visible')

    await env.advance(999)
    assert.equal(env.calls.length, 1, 'debounce 未到不该应用')
    await env.advance(1)

    assert.deepEqual(env.calls.at(-1), { width: 1920, height: 1080 })
    assert.equal(env.lastApplied().width, 1920)
    assert.equal(env.lastApplied().height, 1080)
    assert.equal(env.status().state, 'applied')
  } finally {
    env.restore()
  }
})

test('窗口重新可见但配置与 lastApplied 一致时，不重复应用', async () => {
  const { env } = boot({
    config: { mode: 'preset', width: 1600, height: 900 },
    lastApplied: { width: 1600, height: 900, at: 1 },
  })
  try {
    await env.flush()
    assert.equal(env.calls.length, 1)

    env.setVisibility('hidden')
    env.setVisibility('visible')
    await env.advance(5000)

    assert.equal(env.calls.length, 1, '尺寸没变就不该再调主进程')
  } finally {
    env.restore()
  }
})

test('页面隐藏时不安排补应用', async () => {
  const { env } = boot({
    config: { mode: 'custom', width: 1600, height: 900 },
    lastApplied: { width: 1280, height: 720, at: 1 },
  })
  try {
    await env.flush()
    env.setVisibility('hidden')
    await env.advance(5000)

    assert.equal(env.calls.length, 1)
    assert.equal(env.clock.pending(), 0)
  } finally {
    env.restore()
  }
})

test('dispose 清理重试定时器与 visibilitychange 监听', async () => {
  const { env, record } = boot({
    bridge: null,
    config: { mode: 'custom', width: 1600, height: 900 },
  })
  try {
    await env.flush()
    assert.equal(record.effects.length, 1, '启动应用应有清理资源')
    assert.equal(env.listenerCount(), 1)
    assert.ok(env.clock.pending() > 0, '此时正排着下一次重试')

    disposeAll(record)

    assert.equal(env.listenerCount(), 0, '监听必须移除')
    assert.equal(env.clock.pending(), 0, '定时器必须清掉')

    await env.advance(10_000)
    assert.deepEqual(env.calls, [], 'dispose 后不得再尝试')
  } finally {
    env.restore()
  }
})

test('重复 apply（热重载）不叠加监听、定时器与多余的桥调用', async () => {
  const { env, exports, ctx, record } = boot({
    config: { mode: 'preset', width: 1600, height: 900 },
  })
  try {
    await env.flush()
    assert.equal(env.calls.length, 1)

    exports.apply(ctx)
    await env.flush()
    await env.advance(10_000)

    assert.equal(env.calls.length, 1, '配置已生效时重复 apply 不该再调桥')
    assert.equal(env.listenerCount(), 1, '监听器只能有一份')
    assert.equal(record.effects.length, 1, '配置已生效时重复 apply 复用现有资源，不再登记')

    disposeAll(record)
    assert.equal(env.listenerCount(), 0)
    assert.equal(env.clock.pending(), 0)
  } finally {
    env.restore()
  }
})

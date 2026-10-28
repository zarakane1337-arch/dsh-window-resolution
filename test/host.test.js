import assert from 'node:assert/strict'
import test from 'node:test'

import apply, { apply as namedApply, inject, name } from '../lib/index.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { createContext } from './helpers/client-harness.js'

test('宿主入口声明插件名与空的注入列表', () => {
  assert.equal(name, 'dsh-plugin-resolution')
  assert.deepEqual(inject, [], '骨架阶段不注入任何宿主服务')
  assert.equal(typeof namedApply, 'function')
  assert.equal(apply, namedApply, 'default 导出必须就是 apply')
})

test('apply 在拿不到上下文或配置时也不抛错', () => {
  assert.doesNotThrow(() => apply(undefined))
  assert.doesNotThrow(() => apply(null, null))
  assert.doesNotThrow(() => apply({}, { mode: 'custom', width: 'nope', height: 1080 }))
})

test('apply 把配置归一后记一行日志，而不注册任何行为', () => {
  const { ctx, record } = createContext()
  apply(ctx, { mode: 'preset', presetValue: '2560x1440' })
  assert.equal(record.logs.length, 1, '每次启动只记一行，避免刷屏')
  assert.equal(record.logs[0].level, 'info')
  assert.match(record.logs[0].message, /2560x1440/, '日志里要能看出解析后的目标尺寸')
  assert.deepEqual(record.effects, [], '骨架阶段不应注册任何 effect')
  assert.deepEqual(record.events, [], '骨架阶段不应监听任何事件')
  assert.deepEqual(record.inject, [], '宿主侧不碰插槽')
})

test('非法配置的日志按默认配置记录', () => {
  const { ctx, record } = createContext()
  apply(ctx, { mode: 'custom', width: 10, height: 10 })
  assert.equal(record.logs.length, 1)
  assert.match(
    record.logs[0].message,
    new RegExp(`${DEFAULT_CONFIG.width}x${DEFAULT_CONFIG.height}`),
    '回落后的尺寸必须出现在日志里',
  )
})

test('logger 自己抛错也不影响插件加载', () => {
  const ctx = {
    logger() {
      return {
        info() {
          throw new Error('logger exploded')
        },
      }
    },
  }
  assert.doesNotThrow(() => apply(ctx, { mode: 'off' }))
})

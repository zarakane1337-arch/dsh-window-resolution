import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHANNEL,
  CONTRACT_VERSION,
  ERROR_CODES,
  MAX_SIDE,
  MIN_SIDE,
  NAMESPACE,
  isBounds,
  setBoundsFail,
  setBoundsOk,
  validateSetBounds,
} from '../lib/contract.js'

test('契约常量与文档口径一致：版本 1、命名空间与 IPC 通道名', () => {
  assert.equal(CONTRACT_VERSION, 1)
  assert.equal(NAMESPACE, 'dshWindowResolution')
  assert.equal(CHANNEL, 'dsh-desktop:window-bounds-set')
  assert.equal(MIN_SIDE, 200)
  assert.equal(MAX_SIDE, 16384)
})

test('错误码集合固定为五个，顺序稳定且不可变', () => {
  assert.deepEqual(ERROR_CODES, [
    'not-desktop',
    'no-window',
    'not-patched',
    'invalid',
    'rejected',
  ])
  assert.equal(Object.isFrozen(ERROR_CODES), true)
})

test('validateSetBounds 接受合法的整数宽高，忽略位置字段', () => {
  assert.deepEqual(validateSetBounds({ width: 1920, height: 1080 }), {
    ok: true,
    width: 1920,
    height: 1080,
  })
  assert.deepEqual(validateSetBounds({ width: 2560, height: 1440, x: 12, y: 34 }), {
    ok: true,
    width: 2560,
    height: 1440,
  })
  assert.deepEqual(validateSetBounds({ width: MIN_SIDE, height: MIN_SIDE }), {
    ok: true,
    width: MIN_SIDE,
    height: MIN_SIDE,
  })
  assert.deepEqual(validateSetBounds({ width: MAX_SIDE, height: MAX_SIDE }), {
    ok: true,
    width: MAX_SIDE,
    height: MAX_SIDE,
  })
})

test('validateSetBounds 把各种非法入参归一成 invalid 错误码', () => {
  const cases = [
    undefined,
    null,
    '1920x1080',
    [],
    {},
    { width: 1920 },
    { width: 1920, height: undefined },
    { width: '1920', height: 1080 },
    { width: 1920.5, height: 1080 },
    { width: 0, height: 1080 },
    { width: Number.NaN, height: 1080 },
    { width: Number.POSITIVE_INFINITY, height: 1080 },
    { width: 100, height: 1080 },
    { width: 1920, height: MAX_SIDE + 1 },
  ]
  for (const input of cases) {
    const result = validateSetBounds(input)
    assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(input)}`)
    assert.equal(result.code, 'invalid')
    assert.equal(typeof result.message, 'string')
    assert.ok(result.message.length > 0)
  }
})

test('setBoundsOk 返回实际 bounds 的四元组', () => {
  const bounds = { x: 100, y: 50, width: 1920, height: 1080 }
  assert.deepEqual(setBoundsOk(bounds), { ok: true, bounds })
  assert.notEqual(setBoundsOk(bounds).bounds, bounds, '不应把调用方的对象原样递出去')
})

test('setBoundsOk 拒绝非法的实际 bounds', () => {
  assert.throws(() => setBoundsOk({ width: 1920, height: 1080 }), TypeError)
  assert.throws(() => setBoundsOk({ x: 0, y: 0, width: 1920.5, height: 1080 }), TypeError)
  assert.throws(() => setBoundsOk(null), TypeError)
})

test('setBoundsFail 只接受文档里的错误码与非空 message', () => {
  assert.deepEqual(setBoundsFail('invalid', 'width must be an integer'), {
    ok: false,
    code: 'invalid',
    message: 'width must be an integer',
  })
  assert.throws(() => setBoundsFail('nope', 'x'), /unknown error code/)
  assert.throws(() => setBoundsFail('invalid', ''), TypeError)
  assert.throws(() => setBoundsFail('invalid', 42), TypeError)
})

test('isBounds 判断窗口几何四元组（位置可为负，尺寸受钳制区间约束）', () => {
  assert.equal(isBounds({ x: 0, y: 0, width: 1920, height: 1080 }), true)
  assert.equal(isBounds({ x: -1920, y: -40, width: 2560, height: 1440 }), true)
  assert.equal(isBounds({ x: 0, y: 0, width: 1920, height: 1080, extra: true }), true)

  assert.equal(isBounds(null), false)
  assert.equal(isBounds([]), false)
  assert.equal(isBounds({ x: 0, y: 0, width: 1920 }), false)
  assert.equal(isBounds({ x: 0, y: 0, width: 1920.5, height: 1080 }), false)
  assert.equal(isBounds({ x: 0, y: 0, width: '1920', height: 1080 }), false)
  assert.equal(isBounds({ x: 0, y: 0, width: 100, height: 1080 }), false)
  assert.equal(isBounds({ x: 0, y: 0, width: 1920, height: MAX_SIDE + 1 }), false)
})

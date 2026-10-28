import assert from 'node:assert/strict'
import test from 'node:test'

import { validateSetBounds } from '../lib/contract.js'
import { DEFAULT_CONFIG, MODES, PRESETS, normalizeConfig } from '../lib/config.js'

test('PRESETS 是 spec 定义的六档分辨率，顺序固定', () => {
  assert.deepEqual(
    PRESETS.map((preset) => [preset.width, preset.height]),
    [
      [1280, 720],
      [1366, 768],
      [1600, 900],
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
    ],
  )
  assert.deepEqual(
    PRESETS.map((preset) => preset.key),
    ['1280x720', '1366x768', '1600x900', '1920x1080', '2560x1440', '3840x2160'],
  )
})

test('每一档预设都通过 IPC 契约的入参校验', () => {
  for (const preset of PRESETS) {
    const result = validateSetBounds({ width: preset.width, height: preset.height })
    assert.equal(result.ok, true, `${preset.key} 必须是合法分辨率`)
  }
})

test('MODES 只含预设 / 自定义 / 关闭三种', () => {
  assert.deepEqual(MODES, ['preset', 'custom', 'off'])
})

test('DEFAULT_CONFIG 是关闭 + 1920×1080', () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    mode: 'off',
    width: 1920,
    height: 1080,
    presetValue: '1920x1080',
  })
})

test('normalizeConfig 对空值与垃圾输入回落到默认配置', () => {
  for (const input of [undefined, null, 42, 'preset', [], { mode: 'bogus' }, { width: 1600 }]) {
    assert.deepEqual(normalizeConfig(input), DEFAULT_CONFIG, `应回落: ${JSON.stringify(input)}`)
  }
  assert.notEqual(normalizeConfig(undefined), DEFAULT_CONFIG, '不能把默认对象本身递出去')
})

test('normalizeConfig 解析预设模式并派生出 presetValue', () => {
  assert.deepEqual(normalizeConfig({ mode: 'preset', presetValue: '2560x1440' }), {
    mode: 'preset',
    width: 2560,
    height: 1440,
    presetValue: '2560x1440',
  })
  assert.deepEqual(normalizeConfig({ mode: 'preset', width: 1366, height: 768 }), {
    mode: 'preset',
    width: 1366,
    height: 768,
    presetValue: '1366x768',
  })
  assert.deepEqual(normalizeConfig({ mode: 'preset', presetValue: '999x999' }), DEFAULT_CONFIG)
})

test('normalizeConfig 保留合法的自定义尺寸，非预设尺寸的 presetValue 为 null', () => {
  assert.deepEqual(normalizeConfig({ mode: 'custom', width: 1600, height: 900 }), {
    mode: 'custom',
    width: 1600,
    height: 900,
    presetValue: '1600x900',
  })
  assert.deepEqual(normalizeConfig({ mode: 'custom', width: 1601, height: 900 }), {
    mode: 'custom',
    width: 1601,
    height: 900,
    presetValue: null,
  })
})

test('normalizeConfig 拒绝非法自定义尺寸，不静默替换成用户没选的尺寸', () => {
  for (const input of [
    { mode: 'custom', width: '1600', height: 900 },
    { mode: 'custom', width: 1600.5, height: 900 },
    { mode: 'custom', width: 100, height: 900 },
    { mode: 'custom', width: 1600, height: 20000 },
    { mode: 'custom' },
  ]) {
    assert.deepEqual(normalizeConfig(input), DEFAULT_CONFIG, `应回落: ${JSON.stringify(input)}`)
  }
})

test('normalizeConfig 在关闭模式下只保留默认尺寸', () => {
  assert.deepEqual(normalizeConfig({ mode: 'off', width: 1600, height: 900 }), {
    mode: 'off',
    width: 1920,
    height: 1080,
    presetValue: '1920x1080',
  })
})

test('normalizeConfig 不改写入参、不透传未知字段、每次返回新对象', () => {
  const input = { mode: 'preset', presetValue: '2560x1440', extra: true }
  const frozen = JSON.stringify(input)
  const first = normalizeConfig(input)
  const second = normalizeConfig(input)
  assert.equal(JSON.stringify(input), frozen, '不能改写入参')
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'extra'), false, '未知字段不得透传')
  assert.notEqual(first, second, '每次都要返回新对象')
  assert.deepEqual(first, second)
})

// kit 层测试：设置文件、阈值换算、面板后端（createKit）的保存/同步/清除。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createKit, resolveConfig, triggersFor } from '../lib/kit-ops.mjs'
import { readSettings, setCompaction, settingsPath, writeSettings } from '../lib/settings.mjs'
import { parseManagedBlocks } from '../lib/tuner/tuner.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CORDIS = join(here, 'fixtures', 'cordis.patch.yml')

const makeProfile = () => mkdtempSync(join(tmpdir(), 'kit-profile-'))
const makeApp = () => {
  const root = mkdtempSync(join(tmpdir(), 'kit-app-'))
  const dir = join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.patch.yml'), readFileSync(CORDIS), 'utf8')
  return root
}

test('triggersFor：按 contextWindow 与预算取较小值', () => {
  const settings = resolveConfig({ presets: { cordis: { plugins: { 'compaction-basic': { config: { thresholdRatio: 0.5, retainRatio: 0.16 } } } } } })
  const triggers = triggersFor(settings, 'cordis')
  assert.equal(triggers.thresholdTokens, 524288)
  assert.equal(triggers.retainTokens, Math.floor(1048576 * 0.16))
  assert.equal(triggers.byBudget, 1048576 - 256000 - 65536)
  // 阈值很高时被 W−O−B 截断
  const high = resolveConfig({ presets: { cordis: { plugins: { 'compaction-basic': { config: { thresholdRatio: 0.95 } } } } } })
  assert.equal(triggersFor(high, 'cordis').thresholdTokens, 727040)
  // 没有配置时走默认 0.5/0.16
  assert.equal(triggersFor(resolveConfig({}), 'cordis').thresholdTokens, 524288)
})

test('setCompaction：只改 compaction-basic，保留其它插件与预设', () => {
  const before = {
    presets: {
      cordis: { plugins: { 'tool-result-pruner': { config: { thresholdChars: 8192 } } }, add: [] },
      standard: { plugins: {}, add: [] },
    },
  }
  const after = setCompaction(before, 'cordis', { auto: true, thresholdRatio: 0.4, retainRatio: 0.1 })
  assert.deepEqual(after.presets.cordis.plugins['tool-result-pruner'], { config: { thresholdChars: 8192 } })
  assert.deepEqual(after.presets.cordis.plugins['compaction-basic'], {
    group: 'compaction',
    config: { auto: true, thresholdRatio: 0.4, retainRatio: 0.1 },
  })
  assert.ok(after.presets.standard, '其它预设必须保留')
  // 二次保存合并而不是覆盖
  const again = setCompaction(after, 'cordis', { auto: false, thresholdRatio: 0.3, retainRatio: 0.08 })
  assert.equal(again.presets.cordis.plugins['compaction-basic'].config.auto, false)
  assert.equal(again.presets.cordis.plugins['compaction-basic'].config.thresholdRatio, 0.3)
})

test('readSettings：缺失或坏 JSON 都退回空配置，不抛错', () => {
  const profile = makeProfile()
  assert.deepEqual(readSettings(profile), { presets: {} })
  const file = settingsPath(profile)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '{ this is not json', 'utf8')
  assert.deepEqual(readSettings(profile), { presets: {} })
})

test('writeSettings/readSettings：往返一致且无 BOM', () => {
  const profile = makeProfile()
  const settings = { presets: { cordis: { plugins: { 'compaction-basic': { group: 'compaction', config: { auto: true, thresholdRatio: 0.5, retainRatio: 0.16 } } }, add: [] } } }
  const file = writeSettings(profile, settings)
  assert.deepEqual(readSettings(profile), settings)
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.charCodeAt(0) !== 0xfeff, true, '不能写 BOM')
})

test('createKit：settings.json 覆盖插件 config；保存后 sync 生成托管块，clear 移除', () => {
  const profile = makeProfile()
  const app = makeApp()
  const kit = createKit({ profileDir: profile, appRoot: app, autoSync: false, presets: {} })

  // 未配置时 describe 不报错，但 sync 会拒绝
  const empty = kit.describe()
  assert.equal(empty.presets.length, 0)
  assert.throws(() => kit.sync(), /还没有配置任何预设/)

  // 面板保存 -> settings.json
  const saved = kit.saveCompaction({ presetId: 'cordis', thresholdRatio: 0.45, retainRatio: 0.12 })
  assert.equal(saved.saved, true)
  assert.equal(saved.triggers.thresholdTokens, Math.floor(1048576 * 0.45))

  // 校验：retain 必须小于 threshold
  assert.throws(() => kit.saveCompaction({ presetId: 'cordis', thresholdRatio: 0.1, retainRatio: 0.2 }), /retainRatio/)
  assert.throws(() => kit.saveCompaction({ presetId: 'cordis', thresholdRatio: 1.2, retainRatio: 0.1 }), /thresholdRatio/)

  // sync 落盘
  const result = kit.sync()
  assert.equal(result.changed, true)
  assert.equal(result.restartRequired, true)
  const patch = kit.readPatch()
  assert.equal(parseManagedBlocks(patch).length, 1)
  assert.ok(patch.includes('thresholdRatio: 0.45'), '必须是面板保存的值')
  assert.ok(patch.includes('retainRatio: 0.12'))

  // 幂等
  assert.equal(kit.sync().changed, false)

  // describe 报告已同步
  const state = kit.describe()
  assert.equal(state.entries[0].previousSha, state.entries[0].upstreamSha)
  assert.equal(state.entries[0].drifted, false)
  assert.equal(state.triggers.thresholdRatio, 0.45)

  // clear
  const cleared = kit.clear()
  assert.equal(cleared.changed, true)
  assert.equal(cleared.removed, 1)
  assert.equal(parseManagedBlocks(kit.readPatch()).length, 0)
})

test('createKit：settings.json 优先于插件 config（面板改完不必重启就生效）', () => {
  const profile = makeProfile()
  const app = makeApp()
  writeSettings(profile, { presets: { cordis: { plugins: { 'compaction-basic': { group: 'compaction', config: { auto: true, thresholdRatio: 0.35, retainRatio: 0.1 } } }, add: [] } } })
  const kit = createKit({
    profileDir: profile,
    appRoot: app,
    presets: { cordis: { plugins: { 'compaction-basic': { group: 'compaction', config: { auto: true, thresholdRatio: 0.6, retainRatio: 0.2 } } } } },
  })
  const state = kit.describe()
  assert.equal(state.knobs.thresholdRatio, 0.35, 'settings.json 应该赢过插件 config')
})

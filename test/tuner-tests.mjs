// dsh-context-kit 调优层单元测试：全部用真实 shipped preset 做 fixture，不依赖本机 app。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  applyPluginConfig,
  buildOverride,
  checkPatchShape,
  discoverPresets,
  extractDeclaration,
  findForeignRows,
  parseManagedBlocks,
  pluginItems,
  renderBlock,
  resolveAppSources,
  resolveProfileDir,
  spliceBlocks,
  yamlScalar,
} from '../lib/tuner/tuner.mjs'
import { commitSync, planSync, stripForeignRows } from '../lib/tuner/sync.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(here, 'fixtures')
const CORDIS = readFileSync(join(FIXTURES, 'cordis.patch.yml'), 'utf8')
const STANDARD = readFileSync(join(FIXTURES, 'standard.patch.yml'), 'utf8')

const COMPACTION_TWEAK = {
  plugins: {
    'compaction-basic': {
      group: 'compaction',
      config: { auto: true, thresholdRatio: 0.5, retainRatio: 0.16 },
    },
  },
}

const lines = (text) => text.split(/\r?\n/)
/** after 能否通过“只删除若干行”得到 before —— 用来证明只做插入、不改写。 */
function assertInsertionOnly(before, after, message) {
  let cursor = 0
  for (const line of after) {
    if (cursor < before.length && line === before[cursor]) cursor += 1
  }
  assert.equal(cursor, before.length, `${message}：输出不是“原文 + 插入行”`)
}

/** 造一个假 app 根目录，里面有 shipped preset。 */
function makeFakeApp(fixtures = { cordis: CORDIS, standard: STANDARD }) {
  const root = mkdtempSync(join(tmpdir(), 'preset-tuner-app-'))
  const dir = join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets')
  mkdirSync(dir, { recursive: true })
  for (const [id, text] of Object.entries(fixtures)) writeFileSync(join(dir, `${id}.patch.yml`), text, 'utf8')
  return root
}

function makeProfile() {
  return mkdtempSync(join(tmpdir(), 'preset-tuner-profile-'))
}

test('抽取 shipped 声明：去掉 insert 缩进，得到可直接当覆盖行用的块', () => {
  const { lines: block, indent } = extractDeclaration(CORDIS, 'cordis')
  assert.equal(indent, 4)
  assert.equal(block[0], '- id: preset-cordis')
  assert.ok(block.some((line) => line.startsWith('  name:')))
  assert.ok(block.some((line) => /^\s+plugins:\s*$/.test(line)))
  assert.ok(block.length > 80)
  // 顶层插件行缩进一致
  const { items, itemIndent } = pluginItems(block)
  assert.equal(itemIndent, 6)
  assert.ok(items.length >= 15)
  assert.throws(() => extractDeclaration(CORDIS, 'nope'), /找不到/)
})

test('注入组内插件 config：只插入，且落在 compaction 组内', () => {
  const { lines: upstream } = extractDeclaration(CORDIS, 'cordis')
  const out = buildOverride(upstream, COMPACTION_TWEAK)
  assertInsertionOnly(upstream, out, '注入 config 时不能改写上游行')
  assert.equal(out.length, upstream.length + 4)

  const groupStart = out.findIndex((line) => line.trim() === '- id: compaction')
  const basicIdx = out.findIndex((line) => line.trim() === '- id: compaction-basic')
  assert.ok(groupStart > 0 && basicIdx > groupStart, 'compaction-basic 必须在 compaction 组内')
  const injected = out.slice(basicIdx, basicIdx + 6)
  assert.ok(injected.some((line) => line.trim() === 'config:'))
  assert.ok(injected.some((line) => line.trim() === 'auto: true'))
  assert.ok(injected.some((line) => line.trim() === 'thresholdRatio: 0.5'))
  assert.ok(injected.some((line) => line.trim() === 'retainRatio: 0.16'))
})

test('拒绝覆盖上游已显式设置的键（不静默改上游值）', () => {
  const { lines: upstream } = extractDeclaration(CORDIS, 'cordis')
  assert.throws(
    () => applyPluginConfig(upstream, 'tool-result-pruner', { thresholdChars: 4096 }, { group: 'compaction' }),
    /已显式设置 thresholdChars/,
  )
})

test('往组里加插件：落在该组 config 列表末尾，仍在组内', () => {
  const { lines: upstream } = extractDeclaration(CORDIS, 'cordis')
  const out = buildOverride(upstream, {
    add: [{ id: 'my-evictor', name: 'my-evictor', group: 'compaction', config: { batchTokens: 18000 } }],
  })
  assertInsertionOnly(upstream, out, '加插件时不能改写上游行')
  const groupStart = out.findIndex((line) => line.trim() === '- id: compaction')
  const groupEnd = out.findIndex((line, index) => index > groupStart && line.trim() === '- id: delegation')
  const added = out.findIndex((line) => line.trim() === '- id: my-evictor')
  assert.ok(added > groupStart && added < groupEnd, '新插件必须插在 compaction 组里')
  assert.ok(out.some((line) => line.trim() === 'batchTokens: 18000'))
})

test('顶层加插件：落在 plugins 列表末尾、下一个顶层键之前', () => {
  const { lines: upstream } = extractDeclaration(CORDIS, 'cordis')
  const out = buildOverride(upstream, { add: [{ id: 'tail-plugin', name: 'tail-plugin' }] })
  assertInsertionOnly(upstream, out, '顶层加插件不能改写上游行')
  const added = out.findIndex((line) => line.trim() === '- id: tail-plugin')
  const { items } = pluginItems(out)
  assert.equal(added, items[items.length - 1], '新插件应该是最后一个顶层插件行')
})

test('YAML 标量渲染：布尔/数字/字符串引号', () => {
  assert.equal(yamlScalar(true), 'true')
  assert.equal(yamlScalar(false), 'false')
  assert.equal(yamlScalar(0.5), '0.5')
  assert.equal(yamlScalar('dsh-preset-tuner'), 'dsh-preset-tuner')
  assert.equal(yamlScalar("@deepseek-ai/dsh-compaction-basic"), "'@deepseek-ai/dsh-compaction-basic'")
  assert.equal(yamlScalar("it's"), "'it''s'")
  assert.equal(yamlScalar('true'), "'true'")
})

test('managed block 拼接幂等；标记不配对会被结构校验抓到', () => {
  const { lines: upstream } = extractDeclaration(CORDIS, 'cordis')
  const block = renderBlock({
    presetId: 'cordis',
    upstreamSha: 'abc123',
    upstreamPath: 'presets/cordis.patch.yml',
    declarationLines: buildOverride(upstream, COMPACTION_TWEAK),
  })
  const base = '- id: ui-theme\n  config:\n    theme: dark\n'
  const once = spliceBlocks(base, [block])
  const twice = spliceBlocks(once, [block])
  assert.equal(once, twice, '重复 splice 必须字节相同（幂等）')
  assert.ok(once.includes('theme: dark'), '不能动块外内容')
  assert.equal(parseManagedBlocks(once).length, 1)
  assert.deepEqual(checkPatchShape(once), [])
  assert.ok(checkPatchShape(`${once}# <<< dsh-preset-tuner: managed block: cordis <<<\n`).length > 0)
})

test('外来手写覆盖：默认拒绝写盘，force+replace 才接管', () => {
  const profile = makeProfile()
  const app = makeFakeApp()
  const sources = resolveAppSources({ config: { appRoot: app } })
  const presetTweaks = { cordis: COMPACTION_TWEAK }
  const handwritten = [
    '- id: preset-cordis',
    "  name: '@deepseek-ai/dsh-agent-preset'",
    '  config:',
    '    id: cordis',
    '    plugins:',
    '      - id: persona',
    "        name: '@deepseek-ai/dsh-persona'",
    '',
  ].join('\n')

  const plan = planSync({ sources, presetTweaks, patchText: handwritten })
  assert.equal(plan.problems.length, 0)
  assert.equal(findForeignRows(handwritten, 'cordis').length, 1)

  assert.throws(
    () => commitSync({ profileDir: profile, blocks: plan.blocks, presetIds: ['cordis'], patchText: handwritten }),
    /已有手写的 preset 覆盖/,
  )
  assert.equal(existsSync(join(profile, 'cordis.patch.yml')), false, '拒绝时不能落盘')

  const result = commitSync({
    profileDir: profile,
    blocks: plan.blocks,
    presetIds: ['cordis'],
    patchText: handwritten,
    force: true,
    mode: 'replace',
  })
  assert.equal(result.changed, true)
  assert.equal(result.removedForeign, 1)
  const written = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
  assert.equal(findForeignRows(written, 'cordis').length, 0, '手写覆盖应被移除')
  assert.equal(parseManagedBlocks(written).length, 1)
  assert.equal(parseManagedBlocks(written)[0].sha.length, 16)
})

test('上游升级不冻结：换掉上游声明后重新 sync，新插件自动流入覆盖块', () => {
  const profile = makeProfile()
  const first = makeFakeApp()
  const presetTweaks = { cordis: COMPACTION_TWEAK }

  const plan1 = planSync({ sources: resolveAppSources({ config: { appRoot: first } }), presetTweaks, patchText: '' })
  commitSync({ profileDir: profile, blocks: plan1.blocks, presetIds: ['cordis'], patchText: '' })
  const written1 = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
  assert.equal(written1.includes('upstream-plugin-v2'), false)

  // 模拟 DSH 升级：上游 preset 多了一个插件
  const upgraded = CORDIS.replace(
    '          - id: delegation',
    '          - id: upstream-plugin-v2\n            name: \'@deepseek-ai/dsh-upstream-plugin-v2\'\n          - id: delegation',
  )
  assert.notEqual(upgraded, CORDIS)
  const second = makeFakeApp({ cordis: upgraded })

  const plan2 = planSync({
    sources: resolveAppSources({ config: { appRoot: second } }),
    presetTweaks,
    patchText: written1,
  })
  assert.equal(plan2.problems.length, 0)
  assert.equal(plan2.entries[0].drifted, true, '上游 sha 变化必须被识别为漂移')

  const result = commitSync({
    profileDir: profile,
    blocks: plan2.blocks,
    presetIds: ['cordis'],
    patchText: written1,
  })
  assert.equal(result.changed, true)
  const written2 = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
  assert.ok(written2.includes('upstream-plugin-v2'), '上游新增插件必须自动继承')
  assert.ok(written2.includes('thresholdRatio: 0.5'), '我们的注入必须仍在')
  assert.equal(parseManagedBlocks(written2).length, 1, '不能出现重复托管块')
})

test('重复 sync 不产生写入（幂等，不制造重启噪音）', () => {
  const profile = makeProfile()
  const app = makeFakeApp()
  const sources = resolveAppSources({ config: { appRoot: app } })
  const presetTweaks = { cordis: COMPACTION_TWEAK }
  const plan = planSync({ sources, presetTweaks, patchText: '' })
  commitSync({ profileDir: profile, blocks: plan.blocks, presetIds: ['cordis'], patchText: '' })
  const text = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
  const second = commitSync({ profileDir: profile, blocks: plan.blocks, presetIds: ['cordis'], patchText: text })
  assert.equal(second.changed, false)
  assert.equal(second.backup, null)
})

test('上游没有该预设：报问题且不写文件', () => {
  const profile = makeProfile()
  const app = makeFakeApp()
  const sources = resolveAppSources({ config: { appRoot: app } })
  const plan = planSync({ sources, presetTweaks: { doesnotexist: COMPACTION_TWEAK }, patchText: '' })
  assert.equal(plan.blocks.length, 0)
  assert.ok(plan.problems.some((problem) => problem.includes('找不到预设')))
  assert.equal(plan.missing.length, 1)
  assert.equal(existsSync(join(profile, 'cordis.patch.yml')), false)
})

test('standard fixture 同样适用（不同插件列表也能注入）', () => {
  const { lines: upstream } = extractDeclaration(STANDARD, 'standard')
  const out = buildOverride(upstream, COMPACTION_TWEAK)
  assertInsertionOnly(upstream, out, 'standard 预设注入不能改写上游')
  assert.ok(out.some((line) => line.trim() === 'thresholdRatio: 0.5'))
})

test('discoverPresets：目录来源能列全所有预设并算 sha', () => {
  const app = makeFakeApp()
  const found = discoverPresets(resolveAppSources({ config: { appRoot: app } }))
  assert.deepEqual([...found.keys()].sort(), ['cordis', 'standard'])
  assert.equal(found.get('cordis').sha.length, 16)
  assert.equal(found.get('cordis').sha, found.get('cordis').sha)
})

test('stripForeignRows：只删目标行，块外其它行原样保留', () => {
  const text = [
    '- id: ui-theme',
    '  config:',
    '    theme: dark',
    '- id: preset-cordis',
    '  name: x',
    '  config:',
    '    id: cordis',
    '- id: agent-default-model',
    '  config:',
    '    model: deepseek-flash',
    '',
  ].join('\n')
  const out = stripForeignRows(text, ['cordis'])
  assert.ok(out.includes('ui-theme'))
  assert.ok(out.includes('agent-default-model'))
  assert.equal(out.includes('preset-cordis'), false)
})

test('stripForeignRows：块标量里的空行不会让剥离提前结束（真实 preset 会触发）', () => {
  const { lines: declaration } = extractDeclaration(CORDIS, 'cordis')
  // 声明中间插一个空行：真实 cordis preset 的块标量段落之间本来就有空行
  const withBlank = [...declaration]
  withBlank.splice(Math.floor(withBlank.length / 2), 0, '')
  const text = [
    '- id: ui-theme',
    '  config:',
    '    theme: dark',
    ...withBlank,
    '- id: agent-default-model',
    '  config:',
    '    model: deepseek-flash',
    '',
  ].join('\n')

  const out = stripForeignRows(text, ['cordis'])
  assert.equal(out.includes('preset-cordis'), false, '目标行必须被删掉')
  assert.ok(out.includes('ui-theme'), '前面的行必须保留')
  assert.ok(out.includes('agent-default-model'), '后面的行必须保留')
  // 原 bug 的形态：删了头却留下缩进很深的孤儿续行
  const orphans = out.split('\n').filter((line) => /^\s{8,}\S/.test(line))
  assert.deepEqual(orphans, [], '不能留下孤儿续行')
})

test('旧包名的托管块也能被识别并替换（否则升级会变成两份覆盖）', () => {
  const { lines: upstream } = extractDeclaration(CORDIS, 'cordis')
  const declarationLines = buildOverride(upstream, COMPACTION_TWEAK)
  // 手工拼一个“旧名称”块：模拟从 dsh-preset-tuner 升级过来
  const legacy = [
    '# >>> dsh-preset-tuner: managed block: cordis >>>',
    '# 上游: node_modules/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml',
    '# 上游 sha256: deadbeefdeadbeef',
    ...declarationLines,
    '# <<< dsh-preset-tuner: managed block: cordis <<<',
  ]
  const base = '- id: ui-theme\n  config:\n    theme: dark\n'
  const withLegacy = `${base}\n${legacy.join('\n')}\n`

  const parsed = parseManagedBlocks(withLegacy)
  assert.equal(parsed.length, 1, '旧标记必须被认成托管块')
  assert.equal(parsed[0].presetId, 'cordis')
  assert.equal(parsed[0].sha, 'deadbeefdeadbeef')

  const rendered = renderBlock({
    presetId: 'cordis',
    upstreamSha: 'newsha',
    upstreamPath: 'node_modules/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml',
    declarationLines,
  })
  const replaced = spliceBlocks(withLegacy, [rendered])
  assert.equal(parseManagedBlocks(replaced).length, 1, '替换后只能有一个块')
  assert.equal(replaced.includes('dsh-preset-tuner'), false, '旧标记应被换掉')
  assert.ok(replaced.includes('ui-theme'), '块外内容必须保留')
  assert.equal(findForeignRows(replaced, 'cordis').length, 0)
})

test('resolveProfileDir：优先配置，其次模块路径，其次唯一 profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'preset-tuner-home-'))
  const profile = join(home, '.dsh', 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  const viaModule = resolveProfileDir({
    config: {},
    moduleUrl: `file:///${home.replace(/\\/g, '/')}/.dsh/profiles/desktop/node_modules/dsh-preset-tuner/index.js`,
    home,
    env: {},
  })
  assert.equal(viaModule.via, 'module path')
  assert.equal(viaModule.dir, profile)
  const viaDefault = resolveProfileDir({ config: {}, home, env: {} })
  assert.equal(viaDefault.via, 'profiles/desktop')
  assert.equal(viaDefault.dir, profile)
  const viaConfig = resolveProfileDir({ config: { profileDir: profile }, home, env: {} })
  assert.equal(viaConfig.via, 'config.profileDir')

  // profiles 下只有唯一一个（名字不是 desktop 的）profile 时，能自动选中它
  const home2 = mkdtempSync(join(tmpdir(), 'preset-tuner-home2-'))
  const only = join(home2, '.dsh', 'profiles', 'work')
  mkdirSync(only, { recursive: true })
  const viaOnly = resolveProfileDir({ config: {}, home: home2, env: {} })
  assert.equal(viaOnly.via, '唯一 profile')
  assert.equal(viaOnly.dir, only)
})

test('生成的补丁能被 DSH 的 Loader 读进去（结构层面：无制表符、标记配对、插件行完整）', () => {
  const profile = makeProfile()
  const app = makeFakeApp()
  const presetTweaks = { cordis: COMPACTION_TWEAK }
  const plan = planSync({
    sources: resolveAppSources({ config: { appRoot: app } }),
    presetTweaks,
    patchText: '- id: ui-theme\n  config:\n    theme: dark\n',
  })
  commitSync({ profileDir: profile, blocks: plan.blocks, presetIds: ['cordis'], patchText: '- id: ui-theme\n  config:\n    theme: dark\n' })
  const written = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
  assert.deepEqual(checkPatchShape(written), [])
  assert.ok(written.includes('theme: dark'))
  // 每个块里的插件行都有 name
  const block = parseManagedBlocks(written)[0].text.split('\n')
  for (let i = 0; i < block.length; i += 1) {
    if (/^\s+-\s+id:/.test(block[i])) {
      const next = block.slice(i + 1, i + 3).find((line) => line.trim().length > 0)
      assert.ok(next && /name:/.test(next), `插件行 ${block[i].trim()} 后面必须跟 name`)
    }
  }
})

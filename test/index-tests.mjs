// 单元/集成测试：不安装插件，用假的 ctx 驱动 apply() + 直接测纯函数。
// 运行：node test/run.mjs
//
// 关键验收（2026-11-14 修正版）：
//   - 重建只发生在事件点（会话开始 / compaction/summary / 手动），不是每步；
//   - 同一状态连续重建两次 → 完全相同的字符串（保证 system 投影零事件）；
//   - 字符串没变时不写审计。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { apply, __test, inject } from '../index.js'

const require = createRequire(import.meta.url)
const S = require('../lib/index/sources.cjs')
const R = require('../lib/index/render.cjs')
const T = require('../lib/index/tokens.cjs')
const E = require('../lib/index/events.cjs')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'context-index-test-'))
let caseCounter = 0

// ---- 假 ctx ----------------------------------------------------------------

function makeCtx(config = {}) {
  const handlers = new Map()
  const disposers = []
  let section = null
  const systemPrompt = {
    section(sec) {
      section = sec
      return () => { section = null }
    },
  }
  const ctx = {
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get(name) {
      return name === 'systemPrompt' ? systemPrompt : undefined
    },
  }
  apply(ctx, config)
  return { ctx, handlers, disposers, getSection: () => section }
}

async function fire(api, event, ...args) {
  const list = api.handlers.get(event) ?? []
  for (const handler of list) await handler(...args)
}

function makeEnv(overrides = {}) {
  caseCounter += 1
  const dir = path.join(tmp, `case-${caseCounter}`)
  fs.mkdirSync(dir, { recursive: true })
  const manifest = path.join(dir, 'token-guard-manifest.jsonl')
  const audit = path.join(dir, 'context-index-manifest.jsonl')
  const api = makeCtx({ tokenGuardManifest: manifest, auditManifest: audit, cwd: dir, ...overrides })
  return { dir, manifest, audit, api }
}

function writeManifest(file, records) {
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

// 通过 tools/post-execute 记录一条路径（和线上路径一致）
async function addPath(api, value, toolName = 'read') {
  const args = toolName === 'grep' || toolName === 'glob' ? { path: value } : { file_path: value }
  await fire(api, 'tools/post-execute', { name: toolName, arguments: args }, { content: [] }, async () => ({ kind: 'accept' }))
}

// 会话开始（真实环境里 session/created 与 agent/created 都会到）
async function startSession(api, id = 'a1') {
  await fire(api, 'session/created', { id })
  await fire(api, 'agent/created', { agent: { id } })
}

async function step(api, id, n, messages = []) {
  await fire(api, 'agent/pre-step', { agent: { id }, step: n, turn: 1, messages, signal: undefined }, async () => ({ kind: 'enter', messages: [] }))
}

function textOf(api) {
  const section = api.getSection()
  assert.ok(section, 'section 未注册')
  const text = section.text()
  assert.equal(typeof text, 'string', 'section text 必须是字符串')
  return text
}

async function waitFor(fn, timeoutMs = 1500) {
  const started = Date.now()
  for (;;) {
    if (fn()) return true
    if (Date.now() - started > timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function auditLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

// 取 paths: 段落里的路径行（只跳过 `… (+N more)` 这种溢出标记；
// 降级路径本身以 `…\` 开头，必须保留）
function pathLines(text) {
  const lines = text.split('\n')
  const start = lines.indexOf('paths:')
  if (start < 0) return []
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!lines[i].startsWith('  ')) break
    if (/^  … \(\+\d+ more\)$/.test(lines[i])) continue
    out.push(lines[i].trim())
  }
  return out
}

function artifactLines(text) {
  const lines = text.split('\n')
  const start = lines.indexOf('artifacts:')
  if (start < 0) return []
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!lines[i].startsWith('  ')) break
    if (lines[i].trim().startsWith('…')) continue
    out.push(lines[i])
  }
  return out
}

const cases = []
function test(name, fn) { cases.push({ name, fn }) }

// ---------------------------------------------------------------------------
// 1. 索引生成：格式、条数、顺序
// ---------------------------------------------------------------------------
test('1. 索引生成：格式正确、artifact 与路径都在、路径按最近使用排序', async () => {
  const env = makeEnv()
  // manifest 按写入顺序追加：最后一行 = 最近
  writeManifest(env.manifest, [
    { ts: 1, tool: 'grep', id: 'b000000000000001', isError: true, originalChars: 812 },
    // token-guard 的 `[未变]`：originalChars 12,882，但模型只看到 99 字符标记
    { ts: 2, tool: 'read', id: 'd4e5f6a7b8c9d0e1', mode: 'unchanged', originalChars: 12882, visibleChars: 99 },
    { ts: 3, tool: 'pwsh', id: 'a1b2c3d4e5f60718', mode: 'capped', originalChars: 4198, visibleChars: 4198, path: 'E:\\dsh的工作区\\test\\run.mjs' },
  ])
  await addPath(env.api, 'E:\\dsh的工作区\\reports\\eviction-plan.md')
  await addPath(env.api, 'E:\\dsh的工作区\\context-index\\lib\\render.cjs')
  await addPath(env.api, 'E:\\dsh的工作区\\reports\\eviction-plan.md') // 重复：应去重并置顶
  await startSession(env.api)
  const text = textOf(env.api)

  assert.match(text, /^\[context index · 0 compactions\]\n/, `头部格式不对：${text.slice(0, 80)}`)
  assert.ok(text.includes('artifacts:'), '应有 artifacts 段')
  assert.ok(text.includes('paths:'), '应有 paths 段')
  assert.ok(text.includes('↳ 原文'), '应保留取回提示行')
  assert.equal(artifactLines(text).length, 3, '3 条 artifact')
  const rows = artifactLines(text)
  assert.ok(rows[0].includes('a1b2c3'), '最近的 artifact 在前（id 6 位）')
  assert.ok(rows[0].includes('pwsh'), 'artifact 行含工具名')
  assert.ok(rows[0].includes('4.1K'), 'artifact 行含体积')
  // D1：capped 不再是 ok，而是 trunc
  assert.ok(rows[0].includes('trunc'), `capped 应为 trunc，实际：${rows[0]}`)
  assert.ok(!rows[0].includes(' ok'), 'capped 不应被标成 ok')
  // D1：未变标记 → need，且同时显示"实际看到 99 / 原文 12.6K"
  assert.ok(rows[1].includes('need'), `unchanged+visibleChars<<original 应为 need，实际：${rows[1]}`)
  assert.ok(rows[1].includes('99 / full 12.6K'), `应显示 seen/full，实际：${rows[1]}`)
  assert.ok(rows[2].includes('err'), 'isError 记为 err')
  const paths = pathLines(text)
  assert.equal(paths.length, 2, '重复路径去重')
  assert.equal(paths[0], 'E:\\dsh的工作区\\reports\\eviction-plan.md', '最近使用的路径在最前')
  assert.equal(paths[1], 'E:\\dsh的工作区\\context-index\\lib\\render.cjs')
})

test('1b. section 参数：name/order/interpolate；A1 shipped order 不被夹掉', async () => {
  const env = makeEnv()
  const section = env.api.getSection()
  assert.ok(section, '应注册 section')
  assert.equal(section.name, 'index:index-page')
  assert.equal(section.order, 10500, '默认 order 应为 10500（> persona 10200）')
  assert.equal(section.interpolate, false)
  assert.equal(typeof section.text, 'function')

  // A1：显式传 10250 时必须原样保留（旧实现会夹成 10000）
  assert.equal(__test.normalizeConfig({ sectionOrder: 10250 }).sectionOrder, 10250)
  assert.equal(__test.normalizeConfig({ sectionOrder: 10500 }).sectionOrder, 10500)
  const explicit = makeEnv({ sectionOrder: 10250 })
  assert.equal(explicit.api.getSection().order, 10250, '显式 order 不得被夹')
})

// ---------------------------------------------------------------------------
// 2. 条数上限：100 条路径 → ≤40 且带 (+N more)
// ---------------------------------------------------------------------------
test('2. 上限：100 条路径只输出 40 条，末尾标 (+60 more)', async () => {
  const env = makeEnv()
  for (let i = 1; i <= 100; i += 1) {
    await addPath(env.api, `E:\\dsh的工作区\\src\\file-${String(i).padStart(3, '0')}.mjs`)
  }
  await startSession(env.api)
  const text = textOf(env.api)
  const paths = pathLines(text)
  assert.ok(paths.length <= 40, `路径条数应 ≤40，实际 ${paths.length}`)
  assert.equal(paths.length, 40)
  assert.ok(text.includes('… (+60 more)'), `应带 (+60 more)，实际尾部：${text.split('\n').slice(-2).join(' / ')}`)
  assert.equal(paths[0], 'E:\\dsh的工作区\\src\\file-100.mjs', '最近的路径在最前')
})

test('2b. 上限：30 条 artifact 只输出 20 条，末尾标 (+10 more)', async () => {
  const env = makeEnv()
  const records = []
  for (let i = 1; i <= 30; i += 1) {
    records.push({ ts: i, tool: 'read', id: `${String(i).padStart(6, '0')}0000000000000`, mode: 'capped', originalChars: i * 1000, path: `E:\\ws\\f${i}.mjs` })
  }
  writeManifest(env.manifest, records)
  await startSession(env.api)
  const text = textOf(env.api)
  assert.equal(artifactLines(text).length, 20)
  assert.ok(text.includes('… (+10 more)'), '应带 (+10 more)')
  assert.ok(artifactLines(text)[0].includes('000030'), '最近的 artifact 在最前')
})

// ---------------------------------------------------------------------------
// 3. 脱敏
// ---------------------------------------------------------------------------
test('3. 脱敏：凭据/密钥类路径整条丢弃（B1 全表）', async () => {
  const env = makeEnv()
  await addPath(env.api, 'C:\\Users\\木\\.credentials.yaml')
  await addPath(env.api, 'E:\\tools\\local-proxy\\config.yaml')
  await addPath(env.api, 'E:\\dsh的工作区\\secrets\\prod.json')
  await addPath(env.api, 'E:\\dsh的工作区\\nodes\\token-store.json')
  await addPath(env.api, 'E:\\dsh的工作区\\.env')
  // B1 补充：.ssh / AppData / .git-credentials / .aws\credentials / kubeconfig / .npmrc / id_rsa / cookies
  await addPath(env.api, 'C:\\Users\\x\\.ssh\\id_rsa')
  await addPath(env.api, 'C:\\Users\\x\\.ssh\\known_hosts')
  await addPath(env.api, 'C:\\Users\\木\\AppData\\Roaming\\app\\cache.db')
  await addPath(env.api, 'C:\\Users\\x\\.git-credentials')
  await addPath(env.api, 'C:\\Users\\x\\.aws\\credentials')
  await addPath(env.api, 'C:\\Users\\x\\.kube\\config')
  await addPath(env.api, 'C:\\Users\\x\\.npmrc')
  await addPath(env.api, 'C:\\Users\\x\\cookies.sqlite')
  await addPath(env.api, 'E:\\dsh的工作区\\src\\safe-file.mjs')
  await startSession(env.api)
  const text = textOf(env.api)
  const paths = pathLines(text)
  assert.deepEqual(paths, ['E:\\dsh的工作区\\src\\safe-file.mjs'], `只应保留安全路径，实际：${JSON.stringify(paths)}`)
  for (const denied of ['.credentials', 'local-proxy', 'secrets', 'token-store', '.env', '.ssh', 'id_rsa', 'appdata', 'git-credentials', '.aws', 'kube', '.npmrc', 'cookies']) {
    assert.ok(!text.toLowerCase().includes(denied.toLowerCase()), `不应出现 ${denied}`)
  }
  assert.ok(!text.includes('C:\\Users\\'), '索引文本里不得出现 C:\\Users\\')

  // 纯函数口径
  assert.equal(S.isDeniedPath('C:\\Users\\x\\.CREDENTIALS.yaml'), true, '大小写不敏感')
  assert.equal(S.isDeniedPath('E:\\TOOLS\\Local-Proxy\\config.yaml'), true)
  assert.equal(S.isDeniedPath('E:\\ws\\src\\main.mjs'), false)
  assert.equal(S.normalizePath('C:\\Users\\x\\.credentials.yaml', { cwd: env.dir }), null)
  assert.equal(S.normalizePath('C:\\Users\\x\\.ssh\\id_rsa', { cwd: env.dir }), null)
  assert.equal(S.normalizePath('C:\\Users\\x\\AppData\\Roaming\\a\\b.db', { cwd: env.dir }), null)
  // URL（含 query 里的 token）不是文件路径
  assert.equal(S.normalizePath('https://api.example.com/v1?token=abc', { cwd: env.dir }), null)
})

test('3b. 脱敏也作用于 artifact 的目标路径', async () => {
  const env = makeEnv()
  writeManifest(env.manifest, [
    { ts: 1, tool: 'read', id: 'aaaaaaaaaaaa0001', mode: 'capped', originalChars: 4000, path: 'C:\\Users\\x\\.credentials.yaml' },
    { ts: 2, tool: 'read', id: 'aaaaaaaaaaaa0002', mode: 'capped', originalChars: 4000, path: 'E:\\ws\\ok.mjs' },
  ])
  await startSession(env.api)
  const text = textOf(env.api)
  assert.equal(artifactLines(text).length, 1, '含敏感路径的 artifact 记录整条丢弃')
  assert.ok(!text.includes('.credentials'))
})

test('3c. 非工作区用户目录降级为尾部两段、home 折叠为 ~（B2）', async () => {
  const env = makeEnv()
  await addPath(env.api, 'C:\\Users\\某人\\Documents\\notes.md')
  await addPath(env.api, 'C:\\Users\\某人\\Desktop\\plan.md')
  await addPath(env.api, path.join(os.homedir(), 'scratch', 'test.mjs'))
  await addPath(env.api, 'E:\\dsh的工作区\\src\\inside.mjs')
  await startSession(env.api)
  const text = textOf(env.api)
  const paths = pathLines(text)
  assert.deepEqual(paths, [
    'E:\\dsh的工作区\\src\\inside.mjs',
    `~\\scratch\\test.mjs`,
    '…\\Desktop\\plan.md',
    '…\\Documents\\notes.md',
  ], `实际：${JSON.stringify(paths)}`)
  assert.ok(!text.includes('某人'), '不得出现别人的用户名')
  assert.ok(!text.includes('C:\\Users\\'), '不得出现 C:\\Users\\')
  // 纯函数口径
  assert.equal(S.normalizePath('C:\\Users\\z\\Documents\\a.md', { cwd: env.dir, workspaceRoot: env.dir }), '…\\Documents\\a.md')
  assert.equal(S.normalizePath(path.join(env.dir, 'a.mjs'), { cwd: env.dir, workspaceRoot: env.dir }), path.join(env.dir, 'a.mjs'), '工作区内原样')
})

// ---------------------------------------------------------------------------
// 4. token 估算与 1,000 token 上限的裁剪
// ---------------------------------------------------------------------------
test('4. token 估算函数：中文 1 字≈1 token、ASCII 4 字符≈1 token', async () => {
  assert.equal(T.estimateTokens(''), 0)
  assert.equal(T.estimateTokens('中文'), 2)
  assert.equal(T.estimateTokens('abcdefgh'), 2)
  assert.equal(T.estimateTokens('abcdefg'), 2, 'ASCII 向上取整')
  assert.equal(T.estimateTokens('ab中文cd'), 3, '2 wide + ceil(4 ascii/4)')
  assert.equal(T.estimateTokens(null), 0)
})

test('4b. 1,000 token 上限：超了先裁最不常用的路径，结果仍 ≤1000', async () => {
  const manyPaths = []
  for (let i = 0; i < 40; i += 1) {
    manyPaths.push(`E:\\dsh的工作区\\reports\\很长的中文目录名称用于撑大索引体积\\第${String(i).padStart(2, '0')}号报告文件-${'x'.repeat(60)}.md`)
  }
  const artifacts = []
  for (let i = 0; i < 20; i += 1) {
    artifacts.push({ id: `ab${String(i).padStart(4, '0')}`, tool: 'pwsh', target: `E:\\dsh的工作区\\logs\\很长的日志文件名-${i}.log`, size: '4.1K', status: 'ok', originalChars: 4198 })
  }
  const built = R.buildIndex({ paths: manyPaths, artifacts, step: 512, compactions: 2, limits: { maxTokens: 1000, pathLimit: 40, artifactLimit: 20, targetChars: 48 } })
  assert.ok(built.estTokens <= 1000, `estTokens 应 ≤1000，实际 ${built.estTokens}`)
  assert.equal(built.overBudget, false)
  assert.ok(built.droppedPaths > 0, '应裁掉路径')
  assert.match(built.text, /^\[context index · 2 compactions\]/)
  assert.ok(built.text.includes('… (+'), '裁剪后应有 (+N more) 标记')
  assert.ok(T.estimateTokens(built.text) <= 1000, '估算与渲染一致')

  // 更紧的预算：仍不得超出
  const tight = R.buildIndex({ paths: manyPaths, artifacts, step: 1, compactions: 0, limits: { maxTokens: 200, pathLimit: 40, artifactLimit: 20 } })
  assert.ok(tight.estTokens <= 200, `紧预算下 estTokens 应 ≤200，实际 ${tight.estTokens}`)
  assert.ok(tight.text.startsWith('[context index · 0 compactions]'))

  // 默认配置（线上）在典型数据下不超 1000
  const typicalPaths = Array.from({ length: 40 }, (_, i) => `E:\\dsh的工作区\\src\\module-${String(i).padStart(3, '0')}.mjs`)
  const typical = R.buildIndex({ paths: typicalPaths, artifacts, step: 100, compactions: 0, limits: { maxTokens: 1000, pathLimit: 40, artifactLimit: 20 } })
  assert.ok(typical.estTokens <= 1000)
  assert.equal(typical.pathLines, 40, '典型 ASCII 数据不裁路径')
})

// ---------------------------------------------------------------------------
// 5. 失败开放
// ---------------------------------------------------------------------------
test('5. 失败开放：manifest 不存在 → 空串、不抛；参数读取抛错也不阻断工具', async () => {
  const env = makeEnv()
  await startSession(env.api)
  assert.equal(textOf(env.api), '', '没有任何数据时应返回空串')
  await step(env.api, 'a1', 1)
  assert.equal(textOf(env.api), '', '仍然为空串')
  assert.equal(auditLines(env.audit).length, 0, '没有内容就不写审计')

  // 参数对象里的 getter 抛错：post-execute 必须继续 next()
  let nextCalled = 0
  const badExec = {
    name: 'read',
    arguments: {
      get file_path() {
        throw new Error('boom')
      },
    },
  }
  await fire(env.api, 'tools/post-execute', badExec, { content: [] }, async () => { nextCalled += 1; return { kind: 'accept' } })
  assert.equal(nextCalled, 1, '异常时必须 next()')

  // 坏 manifest 行（非法 JSON）不影响后面的行；下一个事件点能读到好行
  fs.writeFileSync(env.manifest, 'not json\n{"tool":"read","id":"deadbeefdeadbeef","originalChars":2048,"mode":"capped","path":"E:\\\\ws\\\\ok.mjs"}\n', 'utf8')
  await fire(env.api, 'session/created', { id: 'a2' })
  assert.ok(textOf(env.api).includes('deadbe'), '坏行被跳过，好行仍被索引')
})

test('5b. 失败开放：不存在的 manifest 路径 + 只有路径 → 只输出 paths 段', async () => {
  const env = makeEnv({ tokenGuardManifest: path.join(tmp, 'nope', 'missing.jsonl') })
  await addPath(env.api, 'E:\\ws\\a.mjs')
  await startSession(env.api)
  const text = textOf(env.api)
  assert.ok(text.includes('paths:'), '仅有路径时也应输出')
  assert.ok(!text.includes('artifacts:'), '没有 artifact 时不输出该段')
})

// ---------------------------------------------------------------------------
// 6. 更新节奏（本轮修正的核心）
// ---------------------------------------------------------------------------
test('6. 状态更新不重建：post-execute 与 pre-step 都不改变文本', async () => {
  const env = makeEnv()
  writeManifest(env.manifest, [{ ts: 1, tool: 'pwsh', id: 'a1b2c3d4e5f60718', mode: 'capped', originalChars: 4198 }])
  await startSession(env.api)
  const first = textOf(env.api)
  assert.match(first, /^\[context index · 0 compactions\]/)
  await addPath(env.api, 'E:\\ws\\later-1.mjs')
  await addPath(env.api, 'E:\\ws\\later-2.mjs')
  for (let s = 1; s <= 5; s += 1) await step(env.api, 'a1', s)
  assert.equal(textOf(env.api), first, '事件之前文本必须完全不变（不是每步重建）')
  assert.ok(await waitFor(() => auditLines(env.audit).length === 1), `只应有 1 条审计，实际 ${auditLines(env.audit).length}`)
})

test('6b. 会话开始事件会重建，并带上事件前积累的路径', async () => {
  const env = makeEnv()
  writeManifest(env.manifest, [{ ts: 1, tool: 'pwsh', id: 'a1b2c3d4e5f60718', mode: 'capped', originalChars: 4198 }])
  await startSession(env.api)
  const before = textOf(env.api)
  await addPath(env.api, 'E:\\ws\\new-a.mjs')
  await addPath(env.api, 'E:\\ws\\new-b.mjs')
  await fire(env.api, 'session/created', { id: 'a1' })
  const after = textOf(env.api)
  assert.notEqual(after, before, '会话开始事件应重建')
  assert.deepEqual(pathLines(after), ['E:\\ws\\new-b.mjs', 'E:\\ws\\new-a.mjs'], '最近使用在前')
  assert.ok(await waitFor(() => auditLines(env.audit).length === 2))
  assert.deepEqual(auditLines(env.audit).map((e) => e.reason), ['start', 'start'])
})

test('6c. 相同状态重建 → 完全相同的字符串且不写第二条审计（A2：头部不含 step）', async () => {
  const env = makeEnv()
  writeManifest(env.manifest, [{ ts: 1, tool: 'pwsh', id: 'a1b2c3d4e5f60718', mode: 'capped', originalChars: 4198, path: 'E:\\ws\\a.mjs' }])
  await addPath(env.api, 'E:\\ws\\a.mjs')
  await startSession(env.api)
  const first = textOf(env.api)
  assert.ok(!first.includes('step '), '头部不得含 step（否则跨步重建必然出新字符串）')
  await waitFor(() => auditLines(env.audit).length === 1 || auditLines(env.audit).length === 0)

  // 关键：先推进 step，再重建——旧实现在这里就会产出不同字符串
  await step(env.api, 'a1', 5)
  const again = env.api.ctx.contextIndex.rebuild('manual')
  assert.equal(again, first, '跨步后同状态重建必须产出完全相同的字符串（零事件）')
  assert.equal(textOf(env.api), first)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(auditLines(env.audit).length, 1, '字符串没变时不应写审计')
  // agent/created 时已有索引 → 跳过；manual 重建 → unchanged。共 1 次 unchanged
  assert.equal(env.api.ctx.contextIndex.stats.unchanged, 1)
  assert.equal(env.api.ctx.contextIndex.stats.rebuilds, 2, 'rebuild 被调用过 2 次（start + manual）')
})

test('6d. compaction/summary：计数 + 重建，reason=compaction', async () => {
  const env = makeEnv()
  writeManifest(env.manifest, [{ ts: 1, tool: 'pwsh', id: 'a1b2c3d4e5f60718', mode: 'capped', originalChars: 4198 }])
  await addPath(env.api, 'E:\\ws\\pre-compaction.mjs')
  await startSession(env.api)
  assert.match(textOf(env.api), /0 compactions/)

  await fire(env.api, 'session/event', { id: 's1' }, { type: 'compaction/start', seq: 10, data: { compactionId: 'c1', turn: 3 } })
  await fire(env.api, 'session/event', { id: 's1' }, { type: 'compaction/summary', seq: 11, data: { compactionId: 'c1', summary: [{ type: 'text', text: '## Primary Request and Intent\n- 测试' }] } })
  await fire(env.api, 'session/event', { id: 's1' }, { type: 'compaction/end', seq: 12, data: { compactionId: 'c1', turn: 3 } })
  const text = textOf(env.api)
  assert.match(text, /^\[context index · 1 compaction\]/, `实际：${text.slice(0, 60)}`)
  assert.ok(await waitFor(() => auditLines(env.audit).length === 2), '应新增 1 条审计')
  const entries = auditLines(env.audit)
  assert.equal(entries[entries.length - 1].reason, 'compaction')
})

test('6e. 同一次压缩的 start/summary/end 只计一次', async () => {
  const env = makeEnv()
  writeManifest(env.manifest, [{ ts: 1, tool: 'pwsh', id: 'a1b2c3d4e5f60718', mode: 'capped', originalChars: 4198 }])
  await startSession(env.api)
  const c = (type) => fire(env.api, 'session/event', {}, { type, seq: 1, data: { compactionId: 'same-id' } })
  await c('compaction/start')
  await c('compaction/summary')
  await c('compaction/end')
  await c('compaction/summary') // 重复广播
  assert.match(textOf(env.api), /· 1 compaction\]/, `实际：${textOf(env.api).slice(0, 60)}`)
})

test('6f. 退化路径：没有 session/event 时，从 pre-step 消息里的压缩总结识别', async () => {
  const env = makeEnv()
  writeManifest(env.manifest, [{ ts: 1, tool: 'pwsh', id: 'a1b2c3d4e5f60718', mode: 'capped', originalChars: 4198 }])
  await addPath(env.api, 'E:\\ws\\fallback.mjs')
  await startSession(env.api)
  const summary = `## Primary Request and Intent\n- ${'很长的历史内容 '.repeat(40)}\n## Pending Tasks\n- 继续`
  await step(env.api, 'a1', 3, [{ role: 'user', content: [{ type: 'text', text: summary }] }])
  const text = textOf(env.api)
  assert.match(text, /1 compaction\]/, '退化路径应计数')
  assert.ok(text.includes('fallback.mjs'), '重建带上路径')
  // 同一条总结再次出现不应重复计数
  await step(env.api, 'a1', 4, [{ role: 'user', content: [{ type: 'text', text: summary }] }])
  assert.match(textOf(env.api), /1 compaction\]/)
})

test('6g. 手动入口 ctx.contextIndex.rebuild("manual") 会重建并记录 reason=manual', async () => {
  const env = makeEnv()
  writeManifest(env.manifest, [{ ts: 1, tool: 'pwsh', id: 'a1b2c3d4e5f60718', mode: 'capped', originalChars: 4198 }])
  await startSession(env.api)
  const before = textOf(env.api)
  await addPath(env.api, 'E:\\ws\\manual.mjs')
  const after = env.api.ctx.contextIndex.rebuild('manual')
  assert.notEqual(after, before, '手动入口应生效')
  assert.equal(after, textOf(env.api))
  assert.ok(await waitFor(() => auditLines(env.audit).length === 2))
  assert.equal(auditLines(env.audit).pop().reason, 'manual')
})

test('6h. 事件判定纯函数', async () => {
  assert.equal(E.isCompactionEvent({ type: 'compaction/summary' }), true)
  assert.equal(E.isCompactionEvent({ type: 'compaction/start' }), true)
  assert.equal(E.isCompactionEvent({ type: 'compaction/prune' }), false, 'prune 是历史裁剪，不触发重建')
  assert.equal(E.isCompactionEvent({ type: 'compaction/summary-error' }), false, '错误事件不触发重建')
  assert.equal(E.isCompactionEvent({ type: 'tool/result' }), false)
  assert.equal(E.isCompactionEvent({}), false)
  assert.equal(E.isCompactionEvent(null), false)
  assert.equal(E.compactionKey({ data: { compactionId: 'c1' } }), 'c1')
  assert.equal(E.compactionKey({ seq: 7 }), 'seq:7')
  const summary = '## Primary Request and Intent\n' + 'x'.repeat(300)
  assert.ok(E.detectSummaryText([{ role: 'user', content: [{ type: 'text', text: summary }] }]))
  assert.equal(E.detectSummaryText([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), null)
  assert.equal(E.detectSummaryText(null), null)
  const hash1 = E.detectSummaryText([{ role: 'user', content: summary }])
  const hash2 = E.detectSummaryText([{ role: 'user', content: summary }])
  assert.equal(hash1, hash2, '同一段总结 → 同一个 key')
})

// ---------------------------------------------------------------------------
// 7. 来源解析
// ---------------------------------------------------------------------------
test('7. extractPaths：只跟踪 read/write/edit/grep/glob，只取路径键', async () => {
  assert.deepEqual(S.extractPaths('read', { file_path: 'a.mjs', offset: 10, limit: 5 }), ['a.mjs'])
  assert.deepEqual(S.extractPaths('edit', { file_path: 'b.mjs', old_string: 'x', new_string: 'y' }), ['b.mjs'])
  assert.deepEqual(S.extractPaths('write', { file_path: 'c.mjs', content: 'SECRET' }), ['c.mjs'], '绝不取 content')
  assert.deepEqual(S.extractPaths('grep', { pattern: 'needle', path: 'src' }), ['src'])
  assert.deepEqual(S.extractPaths('glob', { pattern: '**/*.mjs', path: 'E:\\ws' }), ['E:\\ws'])
  assert.deepEqual(S.extractPaths('pwsh', { command: 'cat a.mjs' }), [], '不跟踪 pwsh')
  assert.deepEqual(S.extractPaths('read', { paths: ['a', 'b'] }), ['a', 'b'])
  assert.deepEqual(S.extractPaths('read', null), [])
})

test('7b. readManifestTail：只读尾部 N 行、最近在前、坏行跳过', async () => {
  const env = makeEnv()
  const records = []
  for (let i = 1; i <= 50; i += 1) records.push({ tool: 'read', id: `${String(i).padStart(16, 'a')}`, mode: 'capped', originalChars: i })
  fs.writeFileSync(env.manifest, records.map((r) => JSON.stringify(r)).join('\n') + '\nnot-json\n', 'utf8')
  const read = S.readManifestTail(env.manifest, 5)
  assert.equal(read.records.length, 5)
  assert.equal(read.records[0].originalChars, 50, '第一条是最近写入的')
  assert.equal(S.readManifestTail(path.join(tmp, 'missing.jsonl'), 5).records.length, 0)
})

test('7c. 相对路径按 cwd 归一化；URL 与超长路径丢弃', async () => {
  const env = makeEnv()
  const opts = { cwd: env.dir, workspaceRoot: env.dir }
  assert.equal(S.normalizePath('src\\a.mjs', opts), path.join(env.dir, 'src\\a.mjs'))
  assert.equal(S.normalizePath('https://example.com/x', opts), null)
  assert.equal(S.normalizePath(`E:\\${'a'.repeat(400)}.mjs`, opts), null)
  assert.equal(S.normalizePath('', opts), null)
  assert.equal(S.normalizePath('"E:\\ws\\quoted.mjs"', opts), 'E:\\ws\\quoted.mjs')
})

test('7d. formatSize、artifact 摘要、状态语义与去重（D1/D2）', async () => {
  assert.equal(S.formatSize(4198), '4.1K')
  assert.equal(S.formatSize(12185), '11.9K')
  assert.equal(S.formatSize(812), '812')
  assert.equal(S.formatSize(0), '—')
  assert.equal(S.inferTarget({ artifact: 'C:\\u\\.dsh\\token-guard\\artifacts\\a1b2c3d4e5f6.txt' }), '', '溢出副本不当目标')
  assert.equal(S.inferTarget({ artifact: 'E:\\logs\\out.txt' }), 'E:\\logs\\out.txt')
  assert.equal(S.inferTarget({ path: 'E:\\a.mjs', artifact: 'E:\\logs\\out.txt' }), 'E:\\a.mjs')
  assert.equal(S.inferTarget({}), '')
  assert.equal(S.summarizeArtifact({ tool: 'read' }), null, '无 id 丢弃')

  // D1：状态必须来自 mode + visibleChars，而不是一律 ok
  const capped = S.summarizeArtifact({ tool: 'read', id: 'aaaaaa0000000001', mode: 'capped', originalChars: 4198, visibleChars: 4198 })
  assert.equal(capped.status, 'trunc')
  assert.equal(capped.size, '4.1K')
  const summary = S.summarizeArtifact({ tool: 'grep', id: 'aaaaaa0000000002', mode: 'summary', originalChars: 9000, visibleChars: 3000 })
  assert.equal(summary.status, 'trunc')
  const unchangedMarker = S.summarizeArtifact({ tool: 'read', id: 'aaaaaa0000000003', mode: 'unchanged', originalChars: 12882, visibleChars: 99 })
  assert.equal(unchangedMarker.status, 'need', '未变标记 → need')
  assert.equal(unchangedMarker.size, '99 / full 12.6K', '体积必须区分 seen/full')
  const delta = S.summarizeArtifact({ tool: 'pwsh', id: 'aaaaaa0000000004', mode: 'delta', originalChars: 5000, visibleChars: 4000 })
  assert.equal(delta.status, 'Δ')
  const unchangedSame = S.summarizeArtifact({ tool: 'read', id: 'aaaaaa0000000005', mode: 'unchanged', originalChars: 500, visibleChars: 500 })
  assert.equal(unchangedSame.status, 'same')
  const direct = S.summarizeArtifact({ tool: 'read', id: 'aaaaaa0000000006', mode: 'direct', originalChars: 300, visibleChars: 300 })
  assert.equal(direct.status, 'ok')
  const failed = S.summarizeArtifact({ tool: 'pwsh', id: 'aaaaaa0000000007', isError: true, originalChars: 300 })
  assert.equal(failed.status, 'err')

  // D2：同 id 多行只留最近一条，重复次数进 dup
  const deduped = S.summarizeArtifacts([
    { tool: 'read', id: 'bbbbbb0000000001', mode: 'capped', originalChars: 1400, visibleChars: 1400 },
    { tool: 'read', id: 'bbbbbb0000000002', mode: 'capped', originalChars: 200, visibleChars: 200 },
    { tool: 'read', id: 'bbbbbb0000000001', mode: 'capped', originalChars: 1200, visibleChars: 1200 },
    { tool: 'read', id: 'bbbbbb0000000001', mode: 'capped', originalChars: 1000, visibleChars: 1000 },
  ])
  assert.equal(deduped.length, 2, '同 id 去重（前 6 位相同但 fullId 不同 → 不合并）')
  const dupRow = deduped.find((item) => item.fullId === 'bbbbbb0000000001')
  assert.equal(dupRow.id, 'bbbbbb')
  assert.equal(dupRow.dup, 3, '重复 3 次')
  assert.equal(dupRow.size, '1.4K', '保留最近一条的体积')
})

// ---------------------------------------------------------------------------
// 8. 渲染细节与注入开关
// ---------------------------------------------------------------------------
test('8. 空数据 → 空串；只有路径时不输出 artifacts 段', async () => {
  assert.equal(R.buildIndex({ paths: [], artifacts: [], step: 3 }).text, '')
  const onlyPaths = R.buildIndex({ paths: ['E:\\a.mjs'], artifacts: [], step: 3 })
  assert.equal(onlyPaths.text, '[context index · 0 compactions]\npaths:\n  E:\\a.mjs')
  const onlyArtifacts = R.buildIndex({ paths: [], artifacts: [{ id: 'abcdef', tool: 'read', target: '', size: '1.0K', status: 'ok' }], step: 4 })
  assert.ok(onlyArtifacts.text.includes('artifacts:'))
  assert.ok(!onlyArtifacts.text.includes('paths:'))
})

test('8b. 长目标裁剪（保留尾部）与列对齐', async () => {
  const long = `E:\\dsh的工作区\\${'very-long-directory-name\\'.repeat(4)}target-file.mjs`
  const built = R.buildIndex({
    paths: [],
    artifacts: [{ id: 'abcdef', tool: 'pwsh', target: long, size: '4.1K', status: 'ok' }],
    step: 1,
    limits: { targetChars: 32 },
  })
  const line = built.text.split('\n')[2]
  assert.ok(line.includes('target-file.mjs'), '保留尾部')
  assert.ok(line.includes('…'), '过长用省略号')
  assert.ok(line.length < long.length, '显示应比原路径短')
})

test('8c. 全局 section 只注册一次；两个 agent 共享同一份文本', async () => {
  const env = makeEnv()
  writeManifest(env.manifest, [{ ts: 1, tool: 'pwsh', id: 'a1b2c3d4e5f60718', mode: 'capped', originalChars: 4198 }])
  const section = env.api.getSection()
  await startSession(env.api, 'a1')
  await startSession(env.api, 'a2')
  assert.equal(env.api.getSection(), section, '不应为每个 agent 重新注册 section')
  assert.equal(textOf(env.api), textOf(env.api))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(auditLines(env.audit).length, 1, '第二个 agent 触发的事件因文本相同而不写审计')
})

test('8d. injectMode=none：不注册 section，但记账与手动重建仍可用', async () => {
  const env = makeEnv({ injectMode: 'none' })
  assert.equal(env.api.getSection(), null, '不应注入')
  writeManifest(env.manifest, [{ ts: 1, tool: 'pwsh', id: 'a1b2c3d4e5f60718', mode: 'capped', originalChars: 4198 }])
  await addPath(env.api, 'E:\\ws\\x.mjs')
  await fire(env.api, 'session/created', { id: 's1' })
  assert.ok(await waitFor(() => auditLines(env.audit).length === 1), '仍应记账')
  assert.ok(env.api.ctx.contextIndex.text.includes('x.mjs'))
})

// ---------------------------------------------------------------------------
// 9. 评审必修/应修的回归
// ---------------------------------------------------------------------------
test('9. D2：同一 artifact 在索引里只出现一行并标 ×N', async () => {
  const env = makeEnv()
  const id = 'cccccc0000000001'
  writeManifest(env.manifest, [
    { ts: 1, tool: 'read', id, mode: 'capped', originalChars: 1000, visibleChars: 1000, path: 'E:\\ws\\a.mjs' },
    { ts: 2, tool: 'read', id: 'dddddd0000000001', mode: 'capped', originalChars: 2000, visibleChars: 2000, path: 'E:\\ws\\b.mjs' },
    { ts: 3, tool: 'read', id, mode: 'capped', originalChars: 1000, visibleChars: 1000, path: 'E:\\ws\\a.mjs' },
  ])
  await startSession(env.api)
  const text = textOf(env.api)
  const rows = artifactLines(text)
  assert.equal(rows.length, 2, `3 条记录应去重成 2 行，实际 ${rows.length}`)
  const dupRow = rows.find((row) => row.includes('cccccc'))
  assert.ok(dupRow.includes('×2'), `应标 ×2，实际：${dupRow}`)
  assert.ok(!text.includes('(+1 more)'), '去重后不应有多余条目')
})

test('9b. C1：inject 声明 systemPrompt，注入路径在 stats/审计里可见', async () => {
  assert.ok(Array.isArray(inject) && inject.includes('systemPrompt'), 'inject 应声明 systemPrompt')
  assert.ok(inject.includes('tools'))
  const env = makeEnv()
  assert.equal(env.api.ctx.contextIndex.stats.injection, 'global', '全局 section 路径')
  writeManifest(env.manifest, [{ ts: 1, tool: 'read', id: 'eeeeee0000000001', mode: 'capped', originalChars: 100, visibleChars: 100 }])
  await startSession(env.api)
  assert.ok(await waitFor(() => auditLines(env.audit).length === 1))
  assert.equal(auditLines(env.audit)[0].injection, 'global', '审计记录注入路径')
  const off = makeEnv({ injectMode: 'none' })
  assert.equal(off.api.ctx.contextIndex.stats.injection, 'none', 'injectMode=none 应可见')
})

test('9c. C3：session/event 单参签名也能识别压缩', async () => {
  const env = makeEnv()
  writeManifest(env.manifest, [{ ts: 1, tool: 'pwsh', id: 'a1b2c3d4e5f60718', mode: 'capped', originalChars: 4198 }])
  await startSession(env.api)
  // 只传一个参数（事件对象本身），模拟真实签名是 (event)
  await fire(env.api, 'session/event', { type: 'compaction/summary', seq: 42, data: { compactionId: 'one-arg' } })
  assert.match(textOf(env.api), /· 1 compaction\]/, `单参签名应计数，实际：${textOf(env.api).slice(0, 60)}`)
})

// ---- 运行 -----------------------------------------------------------------
let passed = 0
const failures = []
for (const c of cases) {
  try {
    await c.fn()
    passed += 1
    console.log(`  ✅ ${c.name}`)
  } catch (error) {
    failures.push({ name: c.name, error: error.message })
    console.log(`  ❌ ${c.name}: ${error.message}`)
  }
}
console.log(`\n通过 ${passed}/${cases.length}`)
if (failures.length) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
fs.rmSync(tmp, { recursive: true, force: true })

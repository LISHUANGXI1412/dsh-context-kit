// 效果统计：读本机会话日志，给出「实测台账 + 估算节省 + 返工信号」。
//
// 三条原则：
//   1. 只读本地文件，不联网、不上报任何内容。
//   2. 实测与估算分开标注：token 用量是实测，节省百分比是模型估算（反事实无法观测）。
//   3. 解析函数是纯函数（吃 JSONL 文本），便于测试；读文件与解压是薄薄一层。
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from '../vendor/fzstd/index.mjs'

/** 价格比（DeepSeek 公开价：命中/未命中/输出）。只用于把用量折算成可比较的"命中当量"。 */
export const PRICES = { hit: 1, miss: 10, out: 15 }

/** DSH 默认压缩参数，作为"不装本插件"的基线。 */
export const BASE_POLICY = { thresholdRatio: 0.8, retainRatio: 0.16 }

export const DEFAULT_CONTEXT_WINDOW = 1048576

/** 从工具参数里取一个"做什么"的签名，用于识别重复劳动。 */
export function toolKey(name, args) {
  let parsed = args
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args)
    } catch {
      parsed = null
    }
  }
  const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')
  if (parsed && typeof parsed === 'object') {
    const interesting =
      pick(parsed.path) ||
      pick(parsed.file_path) ||
      pick(parsed.command) ||
      pick(parsed.pattern) ||
      pick(parsed.query) ||
      pick(parsed.url)
    if (interesting) return `${name}|${interesting}`
    try {
      return `${name}|${JSON.stringify(parsed).slice(0, 120)}`
    } catch {
      return `${name}|`
    }
  }
  return `${name}|`
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)

/**
 * 解析一个会话的 JSONL 文本。
 * 纯函数：不碰文件系统，测试直接喂字符串。
 */
export function parseSessionJsonl(text) {
  const steps = []
  const deltas = []
  const compactionTriggers = []
  const calls = new Map()
  let compactions = 0
  let summaryTokens = 0
  let prompt = 0
  let previousPrompt = 0
  let firstTime = 0
  let lastTime = 0

  for (const line of String(text).split('\n')) {
    if (!line) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    if (Number.isFinite(event.time)) {
      if (!firstTime) firstTime = event.time
      lastTime = event.time
    }
    const type = event.type

    if (type === 'tool/call') {
      const data = event.data || {}
      const key = toolKey(String(data.name ?? 'unknown'), data.arguments)
      calls.set(key, (calls.get(key) ?? 0) + 1)
      continue
    }

    if (type === 'compaction/start') {
      // 压缩发生时的 prompt 高度 ≈ 当时的阈值：用它给这次会话的运行策略分期
      if (previousPrompt > 0) compactionTriggers.push(previousPrompt)
      continue
    }

    if (type === 'compaction/summary') {
      compactions += 1
      const blocks = event.data?.summary
      if (Array.isArray(blocks)) {
        for (const block of blocks) if (typeof block?.text === 'string') summaryTokens += Math.ceil(block.text.length / 4)
      }
      continue
    }

    if (type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (!usage) continue
    const hit = num(usage.cacheReadTokens)
    const miss = num(usage.inputTokens)
    const out = num(usage.outputTokens)
    prompt = hit + miss
    const delta = prompt - previousPrompt
    // 压缩后 prompt 会变短，这一步的负增量不参与回放（否则会把压缩当成"缩水"）
    if (delta > 0) deltas.push(delta)
    steps.push({ hit, miss, out, prompt })
    previousPrompt = prompt
  }

  let duplicates = 0
  let reused = 0
  for (const count of calls.values()) {
    if (count > 1) {
      duplicates += count - 1
      reused += 1
    }
  }

  return {
    steps,
    deltas,
    compactionTriggers,
    compactions,
    summaryTokens,
    duplicates,
    distinctCalls: calls.size,
    repeatedGroups: reused,
    firstTime,
    lastTime,
  }
}

/** 把解析结果压成紧凑统计（缓存只存这个，别存完整 steps）。 */
export function compactSession(parsed) {
  const compact = {
    stepCount: parsed.steps.length,
    hit: 0,
    miss: 0,
    out: 0,
    promptMax: 0,
    compactions: parsed.compactions,
    duplicates: parsed.duplicates,
    distinctCalls: parsed.distinctCalls,
    deltas: parsed.deltas,
    compactionTriggers: parsed.compactionTriggers ?? [],
  }
  for (const step of parsed.steps) {
    compact.hit += step.hit
    compact.miss += step.miss
    compact.out += step.out
    if (step.prompt > compact.promptMax) compact.promptMax = step.prompt
  }
  return compact
}

/** 把多个会话的紧凑统计汇总成台账。 */
export function summarize(parsed) {
  const totals = { sessions: parsed.length, steps: 0, hit: 0, miss: 0, out: 0, compactions: 0, duplicates: 0, distinctCalls: 0, promptMax: 0 }
  for (const session of parsed) {
    totals.steps += session.stepCount
    totals.hit += session.hit
    totals.miss += session.miss
    totals.out += session.out
    totals.compactions += session.compactions
    totals.duplicates += session.duplicates
    totals.distinctCalls += session.distinctCalls
    if (session.promptMax > totals.promptMax) totals.promptMax = session.promptMax
  }
  const cost = {
    hit: totals.hit * PRICES.hit,
    miss: totals.miss * PRICES.miss,
    out: totals.out * PRICES.out,
  }
  cost.total = cost.hit + cost.miss + cost.out
  const promptTotal = totals.hit + totals.miss
  return {
    ...totals,
    promptAvg: totals.steps > 0 ? Math.round(promptTotal / totals.steps) : 0,
    cost,
    missSharePct: cost.total > 0 ? (cost.miss / cost.total) * 100 : 0,
    duplicatePct: totals.distinctCalls > 0 ? (totals.duplicates / (totals.distinctCalls + totals.duplicates)) * 100 : 0,
  }
}

const triggerFor = (window, ratio) => Math.min(Math.floor(window * ratio), window - 256000 - 65536)

/**
 * 这次会话当时跑的是哪套压缩策略？
 * 只看得到副作用：压缩发生时的 prompt 高度。没有压缩事件的会话无法判断（记为 no-compaction）。
 *
 * 注意：阈值和触发点是多对一的（ratio 超过预算后触发点被 727040 截断），
 * 所以按「触发点的整数高度」分期，不硬猜 ratio。
 */
export function classifySession(session, options = {}) {
  const contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const budget = contextWindow - 256000 - 65536
  const triggers = (session.compactionTriggers ?? []).filter((value) => Number.isFinite(value) && value > 0)
  if (triggers.length === 0) return { key: 'no-compaction', triggerTokens: null, thresholdRatio: null }
  const sorted = [...triggers].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const bucket = Math.max(8192, Math.round(median / 8192) * 8192)
  return {
    key: `t${bucket}`,
    triggerTokens: bucket,
    // 触发点贴着预算上限时，无法反推 ratio（任何更大的 ratio 都给同一个触发点）
    thresholdRatio: bucket >= budget - 8192 ? null : Math.round((bucket / contextWindow) * 100) / 100,
  }
}

/**
 * 按观测到的策略分期。这是「实测归因」的核心：
 * 历史数据里混着旧阈值跑出来的会话，不能整体当作当前配置的效果。
 */
export function groupByPolicy(sessions, options = {}) {
  const contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const budget = contextWindow - 256000 - 65536
  const currentRatio = options.thresholdRatio ?? 0.4
  const currentTrigger = Math.min(Math.floor(contextWindow * currentRatio), budget)
  const groups = new Map()
  for (const session of sessions) {
    const policy = classifySession(session, { contextWindow })
    const group = groups.get(policy.key) ?? { ...policy, members: [] }
    group.members.push(session)
    groups.set(policy.key, group)
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      triggerTokens: group.triggerTokens,
      thresholdRatio: group.thresholdRatio,
      isCurrent:
        group.triggerTokens !== null && Math.abs(group.triggerTokens - currentTrigger) <= 32768,
      totals: summarize(group.members),
    }))
    .sort((a, b) => b.totals.steps - a.totals.steps)
}

/**
 * 反事实回放：同一批"每步新增量"，分别按当前阈值和基线阈值压缩，比较总成本。
 * 这是估算：假设工作量不变、价格比固定、摘要规模与实测同比例。面板里必须标注"估算"。
 */
export function estimateSavings(deltas, options = {}) {
  const window = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const current = { thresholdRatio: options.thresholdRatio ?? 0.4, retainRatio: options.retainRatio ?? 0.12 }
  const base = { thresholdRatio: options.baseThresholdRatio ?? BASE_POLICY.thresholdRatio, retainRatio: options.baseRetainRatio ?? BASE_POLICY.retainRatio }
  const summaryRatio = options.summaryRatio ?? 0.005
  const steps = deltas.filter((value) => Number.isFinite(value) && value > 0)
  if (steps.length === 0) return null

  const replay = (policy) => {
    const trigger = triggerFor(window, policy.thresholdRatio)
    const retain = Math.floor(window * policy.retainRatio)
    let prompt = 0
    let cost = 0
    let events = 0
    for (const step of steps) {
      const previous = prompt
      prompt += step
      if (prompt > trigger && prompt - retain > 20000) {
        const shadowed = prompt - retain
        const summary = Math.max(60, Math.round(shadowed * summaryRatio))
        if (summary < shadowed) {
          cost += shadowed * PRICES.miss + summary * PRICES.out
          events += 1
          prompt = retain + summary
          cost += prompt * PRICES.miss
          continue
        }
      }
      cost += previous * PRICES.hit + step * PRICES.miss
    }
    return { cost, events }
  }

  const currentRun = replay(current)
  const baseRun = replay(base)
  return {
    estimate: true,
    baseThresholdRatio: base.thresholdRatio,
    baseRetainRatio: base.retainRatio,
    thresholdRatio: current.thresholdRatio,
    retainRatio: current.retainRatio,
    baseCost: baseRun.cost,
    currentCost: currentRun.cost,
    baseEvents: baseRun.events,
    currentEvents: currentRun.events,
    savedPct: baseRun.cost > 0 ? ((baseRun.cost - currentRun.cost) / baseRun.cost) * 100 : 0,
    steps: steps.length,
  }
}

const CACHE_VERSION = 2

function readCache(cachePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    if (parsed && parsed.version === CACHE_VERSION && parsed.files && typeof parsed.files === 'object') return parsed
  } catch {}
  return { version: CACHE_VERSION, files: {} }
}

function writeCache(cachePath, cache) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    const tmp = `${cachePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8')
    fs.renameSync(tmp, cachePath)
  } catch {}
}

function collectSessionFiles(home, since, limits) {
  const root = path.join(home, 'sessions')
  const files = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name === 'session.v4.jsonl.zstd') {
        try {
          const stat = fs.statSync(full)
          if (stat.mtimeMs >= since && stat.size <= limits.maxBytes) {
            files.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size })
          }
        } catch {}
      }
    }
  }
  walk(root, 0)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return files.slice(0, limits.maxFiles)
}

/**
 * 读取近期会话并汇总。
 * 生成器形式：每个文件之后让出一次，供同步/异步两个入口复用——
 * 同步入口用于 CLI/测试，异步入口用于宿主 RPC（避免解压大日志时卡住事件循环）。
 */
function* collectReport(options = {}) {
  const home = options.home
  const cachePath = options.cachePath
  const days = options.days ?? 7
  const limits = { maxFiles: options.maxFiles ?? 40, maxBytes: options.maxBytes ?? 16 * 1024 * 1024 }
  const since = Date.now() - days * 24 * 3600 * 1000
  const cache = readCache(cachePath)
  const sessions = []
  const files = []
  const skipped = []
  let decompressed = 0

  for (const item of collectSessionFiles(home, since, limits)) {
    const key = item.file
    const cached = cache.files[key]
    if (cached && cached.mtimeMs === item.mtimeMs && cached.size === item.size && cached.compact) {
      sessions.push(cached.compact)
      files.push(cached.summary)
      yield
      continue
    }
    try {
      const raw = decompress(fs.readFileSync(item.file))
      decompressed += raw.length
      const parsed = parseSessionJsonl(Buffer.from(raw).toString('utf8'))
      const compact = compactSession(parsed)
      const summary = {
        sessionId: path.basename(path.dirname(item.file)),
        mtimeMs: item.mtimeMs,
        size: item.size,
        steps: compact.stepCount,
        compactions: compact.compactions,
        duplicates: compact.duplicates,
      }
      cache.files[key] = { mtimeMs: item.mtimeMs, size: item.size, compact, summary }
      sessions.push(compact)
      files.push(summary)
    } catch (error) {
      skipped.push({ file: path.basename(path.dirname(item.file)), reason: String(error?.message ?? error) })
    }
    yield
  }
  writeCache(cachePath, cache)

  const totals = summarize(sessions)
  const deltas = []
  for (const session of sessions) for (const delta of session.deltas) deltas.push(delta)

  const policies = groupByPolicy(sessions, {
    contextWindow: options.contextWindow,
    thresholdRatio: options.thresholdRatio,
  })
  const currentPolicy = policies.find((policy) => policy.isCurrent) ?? null
  const savings = estimateSavings(deltas, {
    contextWindow: options.contextWindow,
    thresholdRatio: options.thresholdRatio,
    retainRatio: options.retainRatio,
  })

  return {
    generatedAt: new Date().toISOString(),
    window: { days, since: new Date(since).toISOString() },
    home,
    totals,
    policies,
    // 归因：只有「观测到压缩触发点≈当前阈值」的会话，才算当前配置下的实测数据
    coverage: {
      currentThresholdRatio: options.thresholdRatio ?? null,
      sessionsUnderCurrent: currentPolicy?.totals.sessions ?? 0,
      stepsUnderCurrent: currentPolicy?.totals.steps ?? 0,
      sharePct: totals.steps > 0 ? ((currentPolicy?.totals.steps ?? 0) / totals.steps) * 100 : 0,
      isModelOnly: (currentPolicy?.totals.steps ?? 0) < 200,
    },
    savings,
    files,
    skipped,
    decompressedBytes: decompressed,
    privacy: 'local-only: 只读 ~/.dsh/sessions 下的日志并按路径缓存统计结果；不联网、不上报正文。',
  }
}

export function loadReport(options = {}) {
  const iterator = collectReport(options)
  for (;;) {
    const result = iterator.next()
    if (result.done) return result.value
  }
}

export async function loadReportAsync(options = {}) {
  const iterator = collectReport(options)
  for (;;) {
    const result = iterator.next()
    if (result.done) return result.value
    await new Promise((resolve) => setImmediate(resolve))
  }
}

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PRICES,
  classifySession,
  compactSession,
  estimateSavings,
  groupByPolicy,
  parseSessionJsonl,
  summarize,
  toolKey,
} from '../lib/usage.mjs'

const line = (value) => JSON.stringify(value)
const usage = (input, cached, output) => ({ inputTokens: input, cacheReadTokens: cached, outputTokens: output })

test('parseSessionJsonl：取出每步 usage，并按 prompt 差值算增量', () => {
  const text = [
    line({ type: 'assistant/message', time: 1000, data: { usage: usage(40000, 0, 500) } }),
    line({ type: 'user/message', time: 1100, data: { content: [{ type: 'text', text: 'hi' }] } }),
    line({ type: 'assistant/message', time: 1200, data: { usage: usage(2000, 40000, 700) } }),
  ].join('\n')

  const parsed = parseSessionJsonl(text)
  assert.equal(parsed.steps.length, 2)
  assert.deepEqual(parsed.steps[0], { hit: 0, miss: 40000, out: 500, prompt: 40000 })
  assert.deepEqual(parsed.steps[1], { hit: 40000, miss: 2000, out: 700, prompt: 42000 })
  assert.deepEqual(parsed.deltas, [40000, 2000])
  assert.equal(parsed.firstTime, 1000)
  assert.equal(parsed.lastTime, 1200)
})

test('parseSessionJsonl：压缩后的负增量不进 deltas（否则会把压缩算成缩水）', () => {
  const text = [
    line({ type: 'assistant/message', data: { usage: usage(1000, 600000, 100) } }),
    line({ type: 'compaction/summary', data: { summary: [{ type: 'text', text: 'x'.repeat(4000) }] } }),
    line({ type: 'assistant/message', data: { usage: usage(5000, 150000, 100) } }),
  ].join('\n')

  const parsed = parseSessionJsonl(text)
  assert.equal(parsed.compactions, 1)
  assert.equal(parsed.summaryTokens, 1000)
  assert.deepEqual(parsed.deltas, [601000])
  assert.equal(parsed.steps.length, 2)
})

test('parseSessionJsonl：坏行跳过，不抛错', () => {
  const text = ['{not json', line({ type: 'assistant/message', data: { usage: usage(10, 20, 30) } }), ''].join('\n')
  const parsed = parseSessionJsonl(text)
  assert.equal(parsed.steps.length, 1)
})

test('toolKey：优先取路径/命令/模式，作为重复劳动的签名', () => {
  assert.equal(toolKey('read', '{"file_path":"E:\\\\a\\\\b.md"}'), 'read|E:\\a\\b.md')
  assert.equal(toolKey('pwsh', { command: 'node --test' }), 'pwsh|node --test')
  assert.equal(toolKey('grep', { pattern: 'TODO', path: 'src' }), 'grep|src')
  assert.equal(toolKey('x', 'not-json'), 'x|')
})

test('parseSessionJsonl：同一调用重复出现算返工信号', () => {
  const text = [
    line({ type: 'tool/call', data: { name: 'read', arguments: '{"file_path":"a.md"}' } }),
    line({ type: 'tool/call', data: { name: 'read', arguments: '{"file_path":"a.md"}' } }),
    line({ type: 'tool/call', data: { name: 'read', arguments: '{"file_path":"b.md"}' } }),
  ].join('\n')

  const parsed = parseSessionJsonl(text)
  assert.equal(parsed.distinctCalls, 2)
  assert.equal(parsed.duplicates, 1)
  assert.equal(parsed.repeatedGroups, 1)
})

test('summarize：汇总用量、成本与未命中占比', () => {
  const a = compactSession(parseSessionJsonl([
    line({ type: 'assistant/message', data: { usage: usage(1000, 10000, 100) } }),
    line({ type: 'assistant/message', data: { usage: usage(2000, 20000, 200) } }),
  ].join('\n')))
  const b = compactSession(parseSessionJsonl([
    line({ type: 'assistant/message', data: { usage: usage(500, 5000, 50) } }),
  ].join('\n')))

  const totals = summarize([a, b])
  assert.equal(totals.sessions, 2)
  assert.equal(totals.steps, 3)
  assert.equal(totals.hit, 35000)
  assert.equal(totals.miss, 3500)
  assert.equal(totals.out, 350)
  assert.equal(totals.cost.hit, 35000 * PRICES.hit)
  assert.equal(totals.cost.miss, 3500 * PRICES.miss)
  assert.equal(totals.cost.out, 350 * PRICES.out)
  assert.equal(totals.cost.total, 35000 + 35000 + 5250)
  assert.ok(totals.missSharePct > 40 && totals.missSharePct < 50)
  assert.equal(totals.promptMax, 22000)
})

test('estimateSavings：同等参数为 0，降阈值后为正，空数据为 null', () => {
  const deltas = Array.from({ length: 200 }, () => 4000)
  const same = estimateSavings(deltas, { thresholdRatio: 0.8, retainRatio: 0.16, baseThresholdRatio: 0.8, baseRetainRatio: 0.16 })
  assert.equal(same.savedPct, 0)
  assert.equal(same.currentEvents, same.baseEvents)

  const lower = estimateSavings(deltas, { thresholdRatio: 0.4, retainRatio: 0.12 })
  assert.ok(lower.savedPct > 10, `expected meaningful saving, got ${lower.savedPct}`)
  assert.ok(lower.currentEvents >= lower.baseEvents)
  assert.equal(lower.estimate, true)
  assert.equal(lower.baseThresholdRatio, 0.8)

  assert.equal(estimateSavings([], {}), null)
})

test('estimateSavings：增量太大时阈值降到保留量附近就压不动，不能报出虚假节省', () => {
  // 单步 900K：任何阈值都会立刻触发，压缩后仍会立刻再触发
  const deltas = Array.from({ length: 50 }, () => 900000)
  const result = estimateSavings(deltas, { thresholdRatio: 0.3, retainRatio: 0.16 })
  assert.ok(Number.isFinite(result.savedPct))
})

const compactionAt = (prompt) =>
  [
    line({ type: 'assistant/message', data: { usage: usage(1000, prompt, 100) } }),
    line({ type: 'compaction/start', data: {} }),
    line({ type: 'compaction/summary', data: { summary: [{ type: 'text', text: 'x'.repeat(2000) }] } }),
    line({ type: 'assistant/message', data: { usage: usage(2000, 100000, 100) } }),
  ].join('\n')

test('parseSessionJsonl：压缩发生时的 prompt 高度被记下来，用于给会话分期', () => {
  const parsed = parseSessionJsonl(compactionAt(419000))
  assert.equal(parsed.compactionTriggers.length, 1)
  assert.ok(Math.abs(parsed.compactionTriggers[0] - 420000) <= 1)
})

test('classifySession：无压缩判不出来；压缩过的按触发点高度分期', () => {
  assert.equal(classifySession({ compactionTriggers: [] }).key, 'no-compaction')

  const defaultPolicy = classifySession({ compactionTriggers: [727040, 727000] })
  // 727040 吸附到 8192 的整数桶
  assert.equal(defaultPolicy.triggerTokens, 729088)
  // 触发点贴着预算上限时无法反推 ratio
  assert.equal(defaultPolicy.thresholdRatio, null)

  const early = classifySession({ compactionTriggers: [419430] })
  assert.equal(early.triggerTokens, 417792)
  assert.ok(early.thresholdRatio > 0.39 && early.thresholdRatio < 0.41)
})

test('groupByPolicy：旧阈值与当前阈值的会话分开，并标出当前策略覆盖', () => {
  const oldSession = compactSession(parseSessionJsonl(compactionAt(727040)))
  const currentSession = compactSession(parseSessionJsonl(compactionAt(419430)))

  const groups = groupByPolicy([oldSession, currentSession], { thresholdRatio: 0.4 })
  assert.equal(groups.length, 2)
  const current = groups.find((group) => group.isCurrent)
  assert.ok(current, 'expected the 0.4 session to be flagged as current')
  assert.equal(current.totals.sessions, 1)
  assert.equal(current.totals.steps, 2)
  const old = groups.find((group) => !group.isCurrent)
  assert.equal(old.triggerTokens, 729088)
  assert.equal(old.totals.sessions, 1)
})

#!/usr/bin/env node
/**
 * dsh-context-kit CLI —— 在 app 之外跑 status / sync / clear / set。
 * 面板与 Host 工具走的是同一套逻辑（lib/kit-ops.mjs），这里只是命令行外壳。
 *
 *   dsh-context-kit status
 *   dsh-context-kit set --threshold 0.5 --retain 0.16 [--preset cordis]
 *   dsh-context-kit sync [--force --mode replace]
 *   dsh-context-kit preview
 *   dsh-context-kit clear
 *
 * app 位置默认取 --resources / DSH_APP_RESOURCES；profile 默认按模块路径或 ~/.dsh 推断。
 */
import { createKit, triggersFor } from '../lib/kit-ops.mjs'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      out._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
      continue
    }
    out[key] = next
    i += 1
  }
  return out
}

const fail = (message) => {
  console.error(`错误: ${message}`)
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0] ?? 'status'
const fmt = (tokens) => `${Math.round(tokens / 1024)}K`

const config = {
  profileDir: typeof args['profile-dir'] === 'string' ? args['profile-dir'] : '',
  profile: typeof args.profile === 'string' ? args.profile : 'desktop',
  appRoot: typeof args['app-root'] === 'string' ? args['app-root'] : typeof args.resources === 'string' ? args.resources : '',
  autoSync: false,
}

let kit
try {
  kit = createKit(config)
} catch (error) {
  fail(error.message)
}

if (command === 'status') {
  const state = kit.describe()
  console.log(`profile : ${state.profileDir}（${state.profileVia}）`)
  console.log(`补丁    : ${state.patchPath}`)
  console.log(`上游    : ${state.sources.join(' | ')}`)
  console.log(`预设    : ${state.upstreamPresets.join(', ')}`)
  console.log(`托管块  : ${state.managed.map((block) => `${block.presetId}@${block.sha}`).join(', ') || '<无>'}`)
  console.log(
    `阈值    : ${state.knobs.thresholdRatio}（${fmt(state.triggers.thresholdTokens)} 触发）` +
      ` / 保留 ${state.knobs.retainRatio}（${fmt(state.triggers.retainTokens)}）`,
  )
  for (const entry of state.entries) {
    const where = !entry.previousSha ? '未生成' : entry.drifted ? `需重新 sync（${entry.previousSha}→${entry.upstreamSha}）` : '已最新'
    console.log(`  - ${entry.presetId}: ${where}`)
  }
  for (const item of state.foreign) console.log(`  ! 手写覆盖: ${item.presetId} 第 ${item.line} 行`)
  for (const problem of state.problems) console.log(`  ! ${problem}`)
  process.exit(0)
}

if (command === 'set') {
  const threshold = Number(args.threshold ?? 0.5)
  const retain = Number(args.retain ?? 0.16)
  try {
    const result = kit.saveCompaction({
      presetId: typeof args.preset === 'string' ? args.preset : undefined,
      thresholdRatio: threshold,
      retainRatio: retain,
      auto: args.auto !== 'false',
    })
    console.log(`已写入设置: ${result.presetId} threshold=${threshold} retain=${retain}`)
    console.log(`触发点约 ${fmt(result.triggers.thresholdTokens)}，压缩后保留约 ${fmt(result.triggers.retainTokens)}`)
    console.log('接着运行 sync 把它写进 profile 补丁，然后重启 DSH。')
  } catch (error) {
    fail(error.message)
  }
  process.exit(0)
}

if (command === 'preview') {
  try {
    console.log(kit.preview())
  } catch (error) {
    fail(error.message)
  }
  process.exit(0)
}

if (command === 'sync') {
  try {
    const result = kit.sync({ force: Boolean(args.force), mode: args.mode === 'replace' ? 'replace' : 'append' })
    if (!result.changed) {
      console.log('已是最新，文件未改动。')
      process.exit(0)
    }
    console.log(`已写入 ${result.path}`)
    if (result.backup) console.log(`备份   ${result.backup}`)
    if (result.removedForeign) console.log(`接管   移除手写覆盖 ${result.removedForeign} 处`)
    for (const entry of result.entries) {
      console.log(`  - ${entry.presetId}: sha ${entry.upstreamSha}${entry.drifted ? `（漂移 ${entry.previousSha}→${entry.upstreamSha}）` : ''}`)
    }
    console.log('重启 DSH 后生效。')
  } catch (error) {
    fail(error.message)
  }
  process.exit(0)
}

if (command === 'clear') {
  const result = kit.clear()
  if (!result.changed) {
    console.log('没有托管块。')
    process.exit(0)
  }
  console.log(`已移除 ${result.removed} 个托管块${result.backup ? `，备份 ${result.backup}` : ''}。重启 DSH 后生效。`)
  process.exit(0)
}

if (command === 'report') {
  const days = Number(args.days ?? 7)
  const report = await kit.report({ days })
  const t = report.totals
  const big = (value) => (value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : `${Math.round(value / 1e3)}K`)
  console.log(`窗口    : 最近 ${report.window.days} 天（自 ${report.window.since.slice(0, 10)}）`)
  console.log(`规模    : ${t.sessions} 会话 / ${t.steps} 步 / ${t.compactions} 次压缩`)
  for (const policy of report.policies || []) {
    console.log(
      `  分期  : ${policy.triggerTokens === null ? '无压缩（无法判断）' : `触发点 ≈${fmt(policy.triggerTokens)}`}` +
        ` → ${policy.totals.sessions} 会话 / ${policy.totals.steps} 步${policy.isCurrent ? '（当前阈值）' : ''}`,
    )
  }
  if (report.coverage) {
    console.log(`  覆盖  : 当前阈值实测 ${report.coverage.stepsUnderCurrent} 步（${report.coverage.sharePct.toFixed(1)}%）`)
  }
  console.log(`实测用量: 命中 ${big(t.hit)} · 未命中 ${big(t.miss)} · 输出 ${big(t.out)}`)
  console.log(`上下文  : 平均 ${fmt(t.promptAvg)} · 峰值 ${fmt(t.promptMax)}`)
  console.log(`成本    : ${big(t.cost.total)}（命中当量，未命中占 ${t.missSharePct.toFixed(1)}%）`)
  if (report.savings) {
    console.log(
      `节省估算: ${report.savings.savedPct.toFixed(1)}%（基线 ${report.savings.baseThresholdRatio}/${report.savings.baseRetainRatio}` +
        ` → 当前 ${report.savings.thresholdRatio}/${report.savings.retainRatio}，压缩 ${report.savings.baseEvents}→${report.savings.currentEvents} 次）`,
    )
    console.log('          这是估算，不是账单。')
    if (report.coverage && report.coverage.isModelOnly) {
      console.log('          ! 当前阈值下的实测样本太少，只能当方向。')
    }
  }
  console.log(`返工    : 重复调用 ${t.duplicates} / 不同调用 ${t.distinctCalls}（${t.duplicatePct.toFixed(1)}%）`)
  console.log(`解压    : 本次 ${(report.decompressedBytes / 1e6).toFixed(1)}MB，缓存 ${report.files.length} 个文件`)
  console.log(report.privacy)
  process.exit(0)
}

fail(`未知命令: ${command}（可用: status | set | preview | sync | clear | report）`)
export { triggersFor }

import { createKit, resolveConfig, triggersFor } from './lib/kit-ops.mjs'
import { parseManagedBlocks } from './lib/tuner/tuner.mjs'

export const name = 'context-kit-tuner'
export const inject = ['tools']

const k = (tokens) => `${Math.round(tokens / 1024)}K`

function statusText(kit) {
  const state = kit.describe()
  const lines = [
    `profile: ${state.profileDir}（${state.profileVia}）`,
    `补丁文件: ${state.patchPath}`,
    `上游来源: ${state.sources.join(' | ')}`,
    `上游预设: ${state.upstreamPresets.join(', ') || '<无>'}`,
    '',
    `已托管预设: ${state.managed.map((block) => `${block.presetId}@${block.sha}`).join(', ') || '<无>'}`,
    `压缩阈值: ${state.knobs.thresholdRatio}（${k(state.triggers.thresholdTokens)} 触发）` +
      ` / 保留 ${state.knobs.retainRatio}（${k(state.triggers.retainTokens)}）`,
  ]
  for (const entry of state.entries) {
    const where = !entry.previousSha
      ? '未生成（需 sync）'
      : entry.drifted
        ? `上游已变 ${entry.previousSha}→${entry.upstreamSha}，下次 sync 或启动时自动更新`
        : '已是最新'
    lines.push(`  - ${entry.presetId}: ${where}`)
  }
  if (state.foreign.length > 0) {
    lines.push('', `! 补丁里有手写覆盖: ${state.foreign.map((item) => `${item.presetId} 第 ${item.line} 行`).join(', ')}`)
    lines.push('  它们会让 sync 默认拒绝写入；需要接管时用 force + mode="replace"。')
  }
  if (state.problems.length > 0) {
    lines.push('', '问题:')
    for (const problem of state.problems) lines.push(`  - ${problem}`)
  }
  lines.push('', '写盘后需要重启 DSH 生效；Settings → Context 面板可以直接改阈值。')
  return lines.join('\n')
}

const fmtTokens = (value) => (value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : `${Math.round(value / 1e3)}K`)

function reportText(report) {
  const t = report.totals
  const savings = report.savings
  const lines = [
    `窗口: 最近 ${report.window.days} 天（自 ${report.window.since.slice(0, 10)}）`,
    `会话 ${t.sessions} 个 / ${t.steps} 步 / 压缩 ${t.compactions} 次`,
    '',
    '实测用量（来自会话日志里的 usage）:',
    `  缓存命中 ${fmtTokens(t.hit)}   未命中 ${fmtTokens(t.miss)}   输出 ${fmtTokens(t.out)}`,
    `  未命中占成本 ${t.missSharePct.toFixed(1)}%   平均上下文 ${k(t.promptAvg)}   峰值 ${k(t.promptMax)}`,
    `  成本（命中当量） ${fmtTokens(t.cost.total)}`,
  ]
  if (savings) {
    lines.push(
      '',
      `节省估算（非实测）: ${savings.savedPct.toFixed(1)}%`,
      `  基线 ${savings.baseThresholdRatio}/${savings.baseRetainRatio} → 当前 ${savings.thresholdRatio}/${savings.retainRatio}`,
      `  压缩次数 ${savings.baseEvents} → ${savings.currentEvents}；假设工作量与价格比不变`,
    )
  }
  lines.push(
    '',
    `返工信号: 重复调用 ${t.duplicates} 次 / 不同调用 ${t.distinctCalls} 个（${t.duplicatePct.toFixed(1)}%）`,
    '  重复高说明在重读/重跑——那是压缩压过头的第一信号。',
    '',
    `本次解压 ${(report.decompressedBytes / 1e6).toFixed(1)}MB；缓存 ${report.files.length} 个会话文件` +
      (report.skipped.length > 0 ? `；跳过 ${report.skipped.length} 个` : ''),
    report.privacy,
  )
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  const settings = resolveConfig(config)
  const kit = createKit(config)
  const log = (level, message) => {
    try {
      ctx?.logger?.[level]?.(message)
    } catch {}
  }

  // 面板的 RPC 服务依赖 @deepseek-ai/dsh-typert-protocol；缺了只丢面板，
  // 工具与 CLI 必须照常工作（软失败）。
  import('./lib/remote.mjs')
    .then((module) => {
      ctx.plugin(module.ContextKitRemoteService, { kit })
    })
    .catch((error) => {
      log('warn', `context-kit: 面板服务未启动（${error?.message ?? error}）；工具与 CLI 不受影响`)
    })

  ctx.tools.register({
    name: 'preset_tuner',
    description:
      '调整 DSH 的 agent preset（预置）内部配置，例如把 compaction-basic 的自动压缩阈值提前，' +
      '或往 preset 的某个 group 里加插件。做法是：读运行中 app（app.asar）里 shipped 的 preset 声明原文，' +
      '原文逐字节保留、只插入你配置的少量行，生成托管块写进 profile 的 cordis.patch.yml。' +
      '因此不会像手写覆盖那样冻结上游——DSH 升级后会按上游重新生成。' +
      'action=status 报告上游是否漂移；preview 只返回将要写入的文本；sync 真正落盘（需重启 DSH 生效）；' +
      'clear 移除托管块；report 统计最近几天在本机产生的真实用量与节省估算（只读本地会话日志）。' +
      '若 profile 里已有手写的同 id 覆盖，sync 默认拒绝写入，需 force + mode="replace" 接管。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'preview', 'sync', 'clear', 'report'],
          description: 'status（只读报告）/ preview（只返回文本）/ sync（写盘）/ clear（移除托管块）/ report（效果台账）',
        },
        days: {
          type: 'number',
          description: 'report 用：统计最近几天，默认 7',
        },
        force: {
          type: 'boolean',
          description: '与 mode="replace" 一起用：删除 profile 里手写的同 id preset 覆盖行，由本插件接管',
        },
        mode: {
          type: 'string',
          enum: ['append', 'replace'],
          description: 'force 时必须为 replace；否则默认 append（遇到手写覆盖就中止）',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const action = String(args.action ?? 'status')
      if (action === 'status') return statusText(kit)
      if (action === 'preview') {
        return [`将写入 ${kit.paths.patchPath}（预览，未落盘）：`, '', kit.preview()].join('\n')
      }
      if (action === 'sync') {
        const result = kit.sync({ force: Boolean(args.force), mode: args.mode === 'replace' ? 'replace' : 'append' })
        if (!result.changed) return `已是最新，没有写入（${kit.paths.patchPath} 未变）。`
        const drift = result.entries.filter((entry) => entry.drifted)
        return [
          `已写入 ${kit.paths.patchPath}`,
          result.backup ? `备份: ${result.backup}` : '（原文件不存在，未产生备份）',
          result.removedForeign ? `已接管并移除手写覆盖 ${result.removedForeign} 处` : '',
          drift.length > 0
            ? `上游漂移已同步: ${drift.map((entry) => `${entry.presetId} ${entry.previousSha}→${entry.upstreamSha}`).join(', ')}`
            : '',
          '',
          '重启 DSH 后生效（已存在的会话在重启后也会用新的 preset 版本）。',
        ]
          .filter(Boolean)
          .join('\n')
      }
      if (action === 'clear') {
        const result = kit.clear()
        if (!result.changed) return '没有托管块，未改动文件。'
        return `已移除 ${result.removed} 个托管块。备份: ${result.backup ?? '<无>'}\n重启 DSH 后恢复上游默认行为。`
      }
      if (action === 'report') {
        return reportText(await kit.report({ days: Number(args.days) || 7 }))
      }
      throw new Error(`未知 action: ${action}`)
    },
  })

  if (settings.autoSync) {
    queueMicrotask(() => {
      try {
        const active = kit.currentSettings()
        if (Object.keys(active.presetTweaks).length === 0) return
        const owned = new Set(parseManagedBlocks(kit.readPatch()).map((block) => block.presetId))
        const missing = Object.keys(active.presetTweaks).filter((presetId) => !owned.has(presetId))
        if (missing.length > 0) {
          log('info', `context-kit: ${missing.join(', ')} 还没有托管块，先运行 preset_tuner(action="sync")；本次不自动写入`)
          return
        }
        const result = kit.sync()
        if (result.changed) {
          log('info', 'context-kit: 上游已变化，已按上游重新生成覆盖；重启后生效')
        }
      } catch (error) {
        log('warn', `context-kit: 自动同步跳过（${error?.message ?? error}）`)
      }
    })
  }
}

export { triggersFor }

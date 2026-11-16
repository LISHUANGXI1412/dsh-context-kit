/**
 * 工具节省的「独立统计」：直接读 token-trim 的 manifest，不依赖 token-trim 插件在场。
 * 与 token-trim 的 Settings 视图共享同一口径（0.306 token/字符，工具结果占账单 40.7%）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const TOK_PER_CHAR = 0.306
export const TOOL_SHARE_PCT = 40.7
export const TOOL_TOKENS_BASELINE = 751715

export function defaultManifestPath() {
  const current = path.join(homedir(), '.dsh', 'token-trim', 'manifest.jsonl')
  const legacy = path.join(homedir(), '.dsh', 'token-guard', 'manifest.jsonl')
  try {
    if (!existsSync(current) && existsSync(legacy)) return legacy
  } catch {}
  return current
}

function readRecords(file) {
  try {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    const out = []
    for (const line of lines) {
      if (!line) continue
      try { out.push(JSON.parse(line)) } catch {}
    }
    return out
  } catch {
    return []
  }
}

const billPctOf = (savedChars) => (savedChars * TOK_PER_CHAR / TOOL_TOKENS_BASELINE) * TOOL_SHARE_PCT

export function summarizeToolSavings(manifestFile = defaultManifestPath()) {
  const records = readRecords(manifestFile)
  if (!records.length) return { available: false, manifest: manifestFile }
  let orig = 0
  let vis = 0
  const tools = new Map()
  const sessions = new Set()
  let last = 0
  for (const r of records) {
    const o = Number(r.originalChars) || 0
    const v = Number(r.visibleChars) || 0
    orig += o
    vis += v
    if (r.session) sessions.add(String(r.session))
    last = Math.max(last, Number(r.ts) || 0)
    const name = typeof r.tool === 'string' ? r.tool : '(unknown)'
    const t = tools.get(name) || { name, events: 0, saved: 0 }
    t.events += 1
    t.saved += Math.max(0, o - v)
    tools.set(name, t)
  }
  let updatedAt = 0
  try { updatedAt = statSync(manifestFile).mtimeMs } catch {}
  const saved = Math.max(0, orig - vis)
  return {
    available: true,
    manifest: manifestFile,
    events: records.length,
    sessions: sessions.size,
    orig,
    vis,
    saved,
    cutPct: orig ? Number(((1 - vis / orig) * 100).toFixed(1)) : 0,
    tokens: Math.round(saved * TOK_PER_CHAR),
    billPct: Number(billPctOf(saved).toFixed(2)),
    last,
    updatedAt,
    tools: [...tools.values()].sort((a, b) => b.saved - a.saved).slice(0, 6),
  }
}

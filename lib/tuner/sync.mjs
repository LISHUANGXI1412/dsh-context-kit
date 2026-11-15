/**
 * 把“读上游 + 生成覆盖 + 安全落盘”串成一个可复用流程。
 * 这里不碰 ctx，只接收已解析好的路径与配置，便于单测。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildOverride,
  checkPatchShape,
  discoverPresets,
  extractDeclaration,
  findForeignRows,
  parseManagedBlocks,
  renderBlock,
  resolveAppSources,
  spliceBlocks,
  writePatchFile,
  PATCH_FILE,
} from './tuner.mjs'

const isBlank = (line) => line.trim() === ''

/** 删除顶层 `- id: preset-<id>` 行（含其后续缩进行），用于 force+replace 接管外来覆盖。 */
export function stripForeignRows(text, presetIds) {
  const wanted = new Set(presetIds.map((id) => `preset-${id}`))
  const lines = String(text ?? '').split(/\r?\n/)
  const managed = parseManagedBlocks(text)
  const insideManaged = new Set()
  for (const block of managed) for (let i = block.start; i <= block.end; i += 1) insideManaged.add(i)

  const drop = new Set()
  for (let i = 0; i < lines.length; i += 1) {
    if (insideManaged.has(i)) continue
    const match = /^-\s+id:\s*(\S+)\s*$/.exec(lines[i])
    if (!match || !wanted.has(match[1])) continue
    // 该行起，到下一个顶层行/顶层注释为止。中间允许空行（preset 声明里的
    // 块标量本身就有空行，遇到空行就停会把后半截留成孤儿续行）。
    let lastContent = i
    let j = i + 1
    while (j < lines.length) {
      if (isBlank(lines[j])) {
        j += 1
        continue
      }
      if (lines[j].startsWith('#') || lines[j].startsWith('-')) break
      lastContent = j
      j += 1
    }
    for (let k = i; k <= lastContent; k += 1) drop.add(k)
  }
  if (drop.size === 0) return text
  return lines.filter((_, index) => !drop.has(index)).join('\n')
}

/**
 * 只做计算不落盘：为每个配置里的预设生成覆盖块，并报告上游漂移/外来冲突。
 * @returns {{blocks: Array, entries: Array, problems: Array<string>, missing: Array<string>}}
 */
export function planSync({ sources, presetTweaks, patchText, env = process.env, execPath = process.execPath }) {
  const resolvedSources = sources ?? resolveAppSources({ config: { appRoot: env.DSH_APP_ROOT }, execPath })
  const sourceErrors = []
  const upstream = discoverPresets(resolvedSources, { onError: (message) => sourceErrors.push(message) })
  const blocks = []
  const entries = []
  const problems = []
  const missing = []

  for (const [presetId, tweaks] of Object.entries(presetTweaks ?? {})) {
    const found = upstream.get(presetId)
    if (!found) {
      missing.push(presetId)
      problems.push(
        `上游找不到预设 "${presetId}"（可能拼写有误，或该 DSH 版本没有这个预设）` +
          (sourceErrors.length > 0 ? `；读取细节：${sourceErrors.slice(0, 3).join(' | ')}` : ''),
      )
      continue
    }
    try {
      const declaration = extractDeclaration(found.text, presetId)
      const lines = buildOverride(declaration.lines, tweaks)
      const rendered = renderBlock({
        presetId,
        upstreamSha: found.sha,
        upstreamPath: found.internalPath,
        declarationLines: lines,
      })
      blocks.push(rendered)
      const existingBlock = parseManagedBlocks(patchText).find((block) => block.presetId === presetId)
      entries.push({
        presetId,
        upstreamSha: found.sha,
        previousSha: existingBlock?.sha,
        drifted: Boolean(existingBlock && existingBlock.sha && existingBlock.sha !== found.sha),
        pluginCount: (found.text.match(/^\s+-\s+id:/gm) ?? []).length,
        upstreamPath: found.internalPath,
      })
    } catch (error) {
      problems.push(`${presetId}: ${error.message}`)
    }
  }

  return { blocks, entries, problems, missing, upstream }
}

/**
 * 落盘。任何校验不通过都不写文件（失败即放弃，宁可没效果也不弄坏启动）。
 * @returns {{changed: boolean, path: string, backup: string|null, removedForeign: number}}
 */
export function commitSync({ profileDir, blocks, presetIds, patchText, force = false, mode = 'append' }) {
  const file = join(profileDir, PATCH_FILE)
  let text = patchText
  if (text === undefined) text = existsSync(file) ? readFileSync(file, 'utf8') : ''

  const foreign = presetIds.flatMap((id) => findForeignRows(text, id))
  if (foreign.length > 0 && !force) {
    throw new Error(
      `${PATCH_FILE} 里已有手写的 preset 覆盖（第 ${foreign.map((n) => n + 1).join(', ')} 行），` +
        '为避免吞掉你的内容，本次没有写入。先手工删除那几行，或传 force 并选择 mode="replace" 由插件接管。',
    )
  }
  if (foreign.length > 0 && force && mode !== 'replace') {
    throw new Error('force 只配合 mode="replace" 使用：否则会留下两条同 id 的覆盖行')
  }
  let removedForeign = 0
  if (foreign.length > 0 && force) {
    removedForeign = foreign.length
    text = stripForeignRows(text, presetIds)
  }

  const next = spliceBlocks(text, blocks)
  const shapeProblems = checkPatchShape(next)
  if (shapeProblems.length > 0) {
    throw new Error(`生成的补丁没有通过结构校验，已放弃写入：${shapeProblems.join('; ')}`)
  }
  const result = writePatchFile(profileDir, next)
  return { ...result, removedForeign }
}

export { PATCH_FILE }

/**
 * dsh-context-kit 的操作层：
 * 把 settings.json、插件 config、profile 补丁与上游 preset 串成一个对象，
 * Host 工具（preset_tuner）、Settings 面板的 RPC 服务、CLI 都走这里。
 *
 * 路径解析是惰性的：只写 settings.json（面板保存、CLI set）时不需要 app。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { commitSync, planSync } from './tuner/sync.mjs'
import {
  findForeignRows,
  parseManagedBlocks,
  resolveAppSources,
  resolveProfileDir,
  spliceBlocks,
  writePatchFile,
  PATCH_FILE,
} from './tuner/tuner.mjs'
import { readSettings, setCompaction, writeSettings } from './settings.mjs'

const KNOB_DEFAULTS = { auto: true, thresholdRatio: 0.5, retainRatio: 0.16 }
const CONTEXT_DEFAULTS = { contextWindow: 1048576, maxOutputTokens: 256000, headroomTokens: 65536 }

const text = (value, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback)
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** 规范化插件配置。 */
export function resolveConfig(config = {}) {
  const presets = {}
  const raw = config.presets && typeof config.presets === 'object' ? config.presets : {}
  for (const [presetId, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue
    presets[presetId] = {
      plugins: value.plugins && typeof value.plugins === 'object' ? value.plugins : {},
      add: Array.isArray(value.add) ? value.add : [],
    }
  }
  return {
    profileDir: text(config.profileDir),
    profile: text(config.profile, 'desktop'),
    appRoot: text(config.appRoot),
    autoSync: config.autoSync !== false,
    context: {
      contextWindow: finite(config.context?.contextWindow) ?? CONTEXT_DEFAULTS.contextWindow,
      maxOutputTokens: finite(config.context?.maxOutputTokens) ?? CONTEXT_DEFAULTS.maxOutputTokens,
      headroomTokens: finite(config.context?.headroomTokens) ?? CONTEXT_DEFAULTS.headroomTokens,
    },
    presetTweaks: presets,
  }
}

function resourcesPathOf() {
  const path = process.resourcesPath
  if (!path || typeof path !== 'string') return undefined
  if (existsSync(join(path, 'app.asar')) || existsSync(join(path, 'app'))) return path
  return undefined
}

export function resolveProfile(settings) {
  return resolveProfileDir({
    config: { profileDir: settings.profileDir, profile: settings.profile },
    moduleUrl: import.meta.url,
  })
}

export function resolvePaths(settings) {
  const profile = resolveProfile(settings)
  const sources = resolveAppSources({
    config: { appRoot: settings.appRoot },
    resourcesPath: resourcesPathOf(),
    execPath: process.execPath,
  })
  if (sources.length === 0) {
    throw new Error(
      '找不到 DSH app 的 resources 目录（app.asar / app）。' +
        '请用 --resources "<DSH 安装目录>/resources" 或插件配置里的 appRoot 指定',
    )
  }
  return { profile, sources, patchPath: join(profile.dir, PATCH_FILE) }
}

/** 把 contextWindow 与阈值换算成“多少 token 触发 / 保留多少”。 */
export function triggersFor(settings, presetId = 'cordis') {
  const knob = settings.presetTweaks[presetId]?.plugins?.['compaction-basic']?.config ?? KNOB_DEFAULTS
  const { contextWindow, maxOutputTokens, headroomTokens } = settings.context
  const ratio = finite(knob.thresholdRatio) ?? KNOB_DEFAULTS.thresholdRatio
  const retain = finite(knob.retainRatio) ?? KNOB_DEFAULTS.retainRatio
  const byRatio = Math.floor(contextWindow * ratio)
  const byBudget = contextWindow - maxOutputTokens - headroomTokens
  return {
    thresholdRatio: ratio,
    retainRatio: retain,
    contextWindow,
    thresholdTokens: Math.min(byRatio, byBudget),
    retainTokens: Math.floor(contextWindow * retain),
    byBudget,
  }
}

export function createKit(config = {}) {
  const settings = resolveConfig(config)
  let cachedPaths
  let cachedProfile

  const profileOf = () => (cachedProfile ??= resolveProfile(settings))
  const pathsOf = () => (cachedPaths ??= resolvePaths(settings))
  const readPatch = (paths) => (existsSync(paths.patchPath) ? readFileSync(paths.patchPath, 'utf8') : '')

  /** settings.json 优先于插件 config：面板保存后不必重启就能被工具/CLI 看到。 */
  const currentSettings = () => {
    const paths = pathsOf()
    const stored = readSettings(paths.profile.dir)
    const merged = { ...settings, presetTweaks: { ...settings.presetTweaks } }
    for (const [presetId, value] of Object.entries(stored.presets ?? {})) {
      merged.presetTweaks[presetId] = {
        plugins: value.plugins && typeof value.plugins === 'object' ? value.plugins : {},
        add: Array.isArray(value.add) ? value.add : [],
      }
    }
    return merged
  }

  const plan = (active, patchText, paths) =>
    planSync({ sources: paths.sources, presetTweaks: active.presetTweaks, patchText })

  return {
    settings,

    get paths() {
      return pathsOf()
    },

    currentSettings,

    readPatch() {
      return readPatch(pathsOf())
    },

    describe() {
      const paths = pathsOf()
      const active = currentSettings()
      const patchText = readPatch(paths)
      const { entries, problems, upstream } = plan(active, patchText, paths)
      const managed = parseManagedBlocks(patchText)
      const presetIds = Object.keys(active.presetTweaks)
      const foreign = presetIds.flatMap((presetId) =>
        findForeignRows(patchText, presetId).map((line) => ({ presetId, line: line + 1 })),
      )
      const focus = presetIds[0] ?? 'cordis'
      return {
        profileDir: paths.profile.dir,
        profileVia: paths.profile.via,
        patchPath: paths.patchPath,
        sources: paths.sources.map((item) => `${item.kind}:${item.path}`),
        upstreamPresets: [...upstream.keys()].sort(),
        managed: managed.map((block) => ({ presetId: block.presetId, sha: block.sha, upstreamPath: block.upstreamPath })),
        entries,
        foreign,
        problems,
        presets: presetIds,
        triggers: triggersFor(active, focus),
        knobs: active.presetTweaks[focus]?.plugins?.['compaction-basic']?.config ?? KNOB_DEFAULTS,
        restartRequired: false,
      }
    },

    preview() {
      const paths = pathsOf()
      const active = currentSettings()
      const { blocks, problems } = plan(active, readPatch(paths), paths)
      if (problems.length > 0) throw new Error(problems.join('; '))
      return blocks.map((block) => block.join('\n')).join('\n\n')
    },

    sync({ force = false, mode = 'append' } = {}) {
      const paths = pathsOf()
      const active = currentSettings()
      const patchText = readPatch(paths)
      const presetIds = Object.keys(active.presetTweaks)
      if (presetIds.length === 0) throw new Error('还没有配置任何预设：先在面板里保存一次阈值，或运行 CLI set')
      const { blocks, entries, problems } = plan(active, patchText, paths)
      if (problems.length > 0) throw new Error(problems.join('; '))
      const result = commitSync({ profileDir: paths.profile.dir, blocks, presetIds, patchText, force, mode })
      return { ...result, entries, restartRequired: result.changed }
    },

    clear() {
      const paths = pathsOf()
      const patchText = readPatch(paths)
      const managed = parseManagedBlocks(patchText)
      if (managed.length === 0) return { changed: false, removed: 0, restartRequired: false }
      const result = writePatchFile(paths.profile.dir, spliceBlocks(patchText, []))
      return { ...result, removed: managed.length, restartRequired: result.changed }
    },

    /** 面板/CLI 保存：只写 settings.json（不写 YAML），返回最新状态。 */
    saveCompaction(input = {}) {
      const profile = profileOf()
      const stored = readSettings(profile.dir)
      const presetId = text(
        input.presetId,
        Object.keys(stored.presets ?? {})[0] ?? Object.keys(settings.presetTweaks)[0] ?? 'cordis',
      )
      const knobs = {
        auto: input.auto !== false,
        thresholdRatio: Number(input.thresholdRatio ?? KNOB_DEFAULTS.thresholdRatio),
        retainRatio: Number(input.retainRatio ?? KNOB_DEFAULTS.retainRatio),
      }
      if (!(knobs.thresholdRatio > 0 && knobs.thresholdRatio <= 1)) {
        throw new Error('thresholdRatio 必须在 (0,1] 之间')
      }
      if (!(knobs.retainRatio > 0 && knobs.retainRatio < knobs.thresholdRatio)) {
        throw new Error('retainRatio 必须 > 0 且小于 thresholdRatio')
      }
      const next = setCompaction(stored, presetId, knobs, text(input.group, 'compaction'))
      writeSettings(profile.dir, next)
      const merged = { ...settings, presetTweaks: { ...settings.presetTweaks, ...next.presets } }
      return {
        saved: true,
        presetId,
        knobs,
        settingsPath: join(profile.dir, 'dsh-context-kit', 'settings.json'),
        triggers: triggersFor(merged, presetId),
      }
    },
  }
}

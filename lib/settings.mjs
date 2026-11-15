/**
 * 面板可改的少量设置，存成 JSON（不碰 profile 的 YAML）。
 * 位置：<profile>/dsh-context-kit/settings.json
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SETTINGS_FILE = 'settings.json'
export const SETTINGS_DIR = 'dsh-context-kit'

export function settingsPath(profileDir) {
  return join(profileDir, SETTINGS_DIR, SETTINGS_FILE)
}

export function readSettings(profileDir) {
  const file = settingsPath(profileDir)
  if (!existsSync(file)) return { presets: {} }
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    const presets = {}
    for (const [presetId, value] of Object.entries(parsed?.presets ?? {})) {
      if (!value || typeof value !== 'object') continue
      presets[presetId] = {
        plugins: value.plugins && typeof value.plugins === 'object' ? value.plugins : {},
        add: Array.isArray(value.add) ? value.add : [],
      }
    }
    return { presets }
  } catch {
    // 坏文件当作没配置，绝不让面板/工具因此崩掉
    return { presets: {} }
  }
}

export function writeSettings(profileDir, settings) {
  const dir = join(profileDir, SETTINGS_DIR)
  mkdirSync(dir, { recursive: true })
  const file = settingsPath(profileDir)
  const payload = `${JSON.stringify({ presets: settings.presets ?? {} }, null, 2)}\n`
  const temp = `${file}.tmp`
  writeFileSync(temp, payload, 'utf8')
  renameSync(temp, file)
  return file
}

/** 把压缩阈值写进 presets[presetId].plugins['compaction-basic']，保留其它键。 */
export function setCompaction(settings, presetId, knobs, group = 'compaction') {
  const next = {
    presets: JSON.parse(JSON.stringify(settings.presets ?? {})),
  }
  const preset = next.presets[presetId] ?? { plugins: {}, add: [] }
  const plugins = preset.plugins ?? {}
  plugins['compaction-basic'] = {
    ...(plugins['compaction-basic'] ?? {}),
    group: group || 'compaction',
    config: {
      ...(plugins['compaction-basic']?.config ?? {}),
      auto: knobs.auto !== false,
      thresholdRatio: Number(knobs.thresholdRatio),
      retainRatio: Number(knobs.retainRatio),
    },
  }
  preset.plugins = plugins
  preset.add = Array.isArray(preset.add) ? preset.add : []
  next.presets[presetId] = preset
  return next
}

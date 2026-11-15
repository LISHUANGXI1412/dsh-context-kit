/**
 * dsh-preset-tuner 核心逻辑（纯函数 + 文件读写，不依赖任何 npm 包）。
 *
 * 设计原则：
 * 1. 只读上游：从 app 的 asar（或解包目录）里读出 shipped preset 声明原文。
 * 2. 只插入、不改写：生成的覆盖块 = 上游声明逐字节 + 我们注入的行。
 *    因此上游内容永远不会被我们篡改，升级后重新生成即可继承全部上游改动。
 * 3. 失败即放弃：抽取/校验任何一步不通过，就不写文件（宁可没效果，也不能弄坏启动）。
 * 4. 可回滚：每次写入前把原文件备份到 <profile>/dsh-preset-tuner/backups/。
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const MARK_BEGIN = '# >>> dsh-context-kit: managed block: '
export const MARK_END = '# <<< dsh-context-kit: managed block: '
/** 旧包名（dsh-preset-tuner）生成的块仍然要能识别，否则会被当成“外来覆盖”或再追加一份。 */
export const LEGACY_MARK_BEGIN = '# >>> dsh-preset-tuner: managed block: '
export const LEGACY_MARK_END = '# <<< dsh-preset-tuner: managed block: '
export const PATCH_FILE = 'cordis.patch.yml'
export const PRESETS_DIR = 'node_modules/@deepseek-ai/dsh-web-app/presets'

const MARK_BEGIN_RE = /^# >>> (?:dsh-context-kit|dsh-preset-tuner): managed block: (.+?)\s*>>>\s*$/
const isEndMarkerFor = (line, presetId) =>
  [MARK_END, LEGACY_MARK_END].some((prefix) => line.trim().startsWith(`${prefix}${presetId}`))

const sha256 = (input) => createHash('sha256').update(input).digest('hex')
export const shortSha = (input) => sha256(input).slice(0, 16)

/* ────────────────────────────── asar 读取 ────────────────────────────── */

/**
 * Electron 会把 .asar 当成目录来拦截 fs 调用，直接以文件打开会失败。
 * process.noAsar 是官方的绕过开关，读完立刻恢复原值。
 */
function withoutAsarShim(fn) {
  const previous = process.noAsar
  try {
    process.noAsar = true
    return fn()
  } finally {
    process.noAsar = previous
  }
}

/** 打开 asar，解析头部索引。调用方负责 closeAsar。 */
export function openAsar(archive) {
  const fd = withoutAsarShim(() => openSync(archive, 'r'))
  try {
    const head = Buffer.alloc(16)
    withoutAsarShim(() => readSync(fd, head, 0, 16, 0))
    const payloadSize = head.readUInt32LE(4)
    if (!payloadSize || payloadSize > 64 * 1024 * 1024) {
      throw new Error(`asar 头部长度异常: ${payloadSize}`)
    }
    const payload = Buffer.alloc(payloadSize)
    withoutAsarShim(() => readSync(fd, payload, 0, payloadSize, 8))
    const start = payload.indexOf('{"files"')
    if (start < 0) throw new Error('asar 头部找不到文件索引 JSON')
    const json = JSON.parse(payload.subarray(start).toString('utf8').replace(/\0+$/, ''))
    return { fd, base: 8 + payloadSize, json, archive }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

export function closeAsar(asar) {
  try {
    closeSync(asar.fd)
  } catch {}
}

function asarNode(asar, internalPath) {
  const parts = String(internalPath).replace(/\\/g, '/').split('/').filter(Boolean)
  let node = asar.json
  for (const part of parts) {
    node = node?.files?.[part]
    if (!node) return undefined
  }
  return node
}

/** 读 asar 内的文件；不存在或未打包返回 null。 */
export function readAsarEntry(asar, internalPath) {
  const node = asarNode(asar, internalPath)
  if (!node || node.files || node.unpacked || typeof node.size !== 'number') return null
  const buffer = Buffer.alloc(node.size)
  withoutAsarShim(() => readSync(asar.fd, buffer, 0, node.size, asar.base + Number(node.offset)))
  return buffer
}

/** 列 asar 内的目录；不存在返回 []。 */
export function listAsarDir(asar, internalDir) {
  const node = asarNode(asar, internalDir)
  if (!node?.files) return []
  return Object.entries(node.files)
    .filter(([, value]) => !value.files)
    .map(([name]) => name)
}

/* ─────────────────────────── app / 上游定位 ─────────────────────────── */

const uniq = (list) => [...new Set(list.filter(Boolean).map((item) => resolve(item)))]

/**
 * 找出所有可能的“上游来源”。按优先级：显式配置 → Electron resourcesPath →
 * 可执行文件旁边的 resources（普通 node 进程兜底）。
 */
export function resolveAppSources({ config = {}, resourcesPath, execPath } = {}) {
  const roots = uniq([
    config.appRoot,
    resourcesPath,
    execPath ? join(dirname(execPath), 'resources') : undefined,
  ])
  const sources = []
  for (const root of roots) {
    const asar = join(root, 'app.asar')
    if (existsSync(asar)) sources.push({ kind: 'asar', path: asar, root })
    for (const name of ['app', 'app.asar.unpacked']) {
      const dir = join(root, name)
      if (existsSync(dir)) sources.push({ kind: 'dir', path: dir, root })
    }
  }
  return sources
}

/** 统一的读文件接口，asar 与目录两种来源都能用。 */
export function readSourceFile(source, internalPath) {
  if (source.kind === 'dir') {
    const file = join(source.path, ...internalPath.split('/'))
    return existsSync(file) ? readFileSync(file) : null
  }
  const asar = openAsar(source.path)
  try {
    return readAsarEntry(asar, internalPath)
  } finally {
    closeAsar(asar)
  }
}

export function listSourceDir(source, internalDir) {
  if (source.kind === 'dir') {
    const dir = join(source.path, ...internalDir.split('/'))
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  }
  const asar = openAsar(source.path)
  try {
    return listAsarDir(asar, internalDir)
  } finally {
    closeAsar(asar)
  }
}

/**
 * 扫描所有来源，返回 presetId → { source, internalPath, text, sha }。
 * 同一 preset 出现在多个来源时，先出现的优先（asar 优先于解包目录）。
 * onError 用于把“读不到”的原因暴露给调用方（不要静默失败）。
 */
export function discoverPresets(sources, { onError } = {}) {
  const report = (message) => {
    try {
      onError?.(message)
    } catch {}
  }
  const found = new Map()
  for (const source of sources) {
    let names = []
    try {
      names = listSourceDir(source, PRESETS_DIR)
    } catch (error) {
      report(`读取 ${source.kind}:${source.path} 的 presets 目录失败：${error?.message ?? error}`)
      continue
    }
    if (names.length === 0) continue
    for (const name of names) {
      const match = /^(.+)\.patch\.yml$/.exec(name)
      if (!match) continue
      const presetId = match[1]
      if (found.has(presetId)) continue
      const internalPath = `${PRESETS_DIR}/${name}`
      let buffer
      try {
        buffer = readSourceFile(source, internalPath)
      } catch (error) {
        report(`读取 ${internalPath} 失败：${error?.message ?? error}`)
        continue
      }
      if (!buffer) continue
      const text = buffer.toString('utf8')
      found.set(presetId, {
        presetId,
        source: `${source.kind === 'asar' ? 'app.asar' : source.path}`,
        internalPath,
        text,
        sha: shortSha(text),
      })
    }
  }
  return found
}

/* ─────────────────────────── YAML 文本切块 ─────────────────────────── */

const indentOf = (line) => line.match(/^\s*/)[0].length
const isBlank = (line) => line.trim() === ''

/**
 * 从 shipped preset 文件里抽出 `- id: <presetId>` 这一整块，并按该块的
 * 起始缩进去掉公共缩进，得到可直接当作 profile 覆盖行使用的行数组。
 */
export function extractDeclaration(text, presetId) {
  const lines = String(text).split(/\r?\n/)
  const wanted = `preset-${presetId}`
  const start = lines.findIndex((line) => {
    const match = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
    return match?.[1] === wanted
  })
  if (start < 0) throw new Error(`上游声明里找不到 preset-${presetId}（文件名/实现可能已变）`)
  const indent = indentOf(lines[start])
  if (indent < 2) throw new Error(`preset-${presetId} 不是 insert 子项，格式与预期不符`)

  const out = []
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    if (isBlank(line)) {
      out.push('')
      continue
    }
    const current = indentOf(line)
    if (current < indent) break
    out.push(line.slice(indent))
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  if (out.length < 5) throw new Error(`preset-${presetId} 块内容过短，放弃处理`)
  return { lines: out, indent }
}

/** 找出声明里 `plugins:` 的列表项（顶层插件行）。 */
export function pluginItems(lines) {
  const keyIdx = lines.findIndex((line) => /^\s*plugins:\s*$/.test(line))
  if (keyIdx < 0) throw new Error('声明里找不到 plugins: 列表')
  const keyIndent = indentOf(lines[keyIdx])
  const itemIndent = keyIndent + 2
  const items = []
  for (let i = keyIdx + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (isBlank(line)) continue
    const current = indentOf(line)
    if (current <= keyIndent) break
    if (current === itemIndent && /^-\s/.test(line.slice(current))) items.push(i)
  }
  if (items.length === 0) throw new Error('plugins 列表为空，放弃处理')
  return { keyIdx, keyIndent, itemIndent, items }
}

const idOfItem = (line) => {
  const match = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
  return match?.[1]
}

/** 返回某个插件行在 lines 中的 [start, end) 区间。 */
export function pluginRange(lines, items, pluginId) {
  const index = items.findIndex((lineIdx) => idOfItem(lines[lineIdx]) === pluginId)
  if (index < 0) return null
  const start = items[index]
  const end = index + 1 < items.length ? items[index + 1] : lines.length
  return { start, end }
}

/** YAML 标量渲染：只处理 v1 需要的布尔/数字/字符串。 */
export function yamlScalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`不能写入非有限数字: ${value}`)
    return String(value)
  }
  if (value === null) return 'null'
  const text = String(value)
  if (text === '') return "''"
  // 裸标量必须以字母/数字/下划线开头：@ 和 ` 是 YAML 保留指示符，开头用它必须加引号。
  if (/^[A-Za-z0-9_][A-Za-z0-9_.@/-]*$/.test(text) && !/^(true|false|null|yes|no|on|off)$/i.test(text)) return text
  return `'${text.replace(/'/g, "''")}'`
}

/** 收集某个插件行已有的 config 标量键（用于冲突检测）。 */
function existingConfigKeys(lines, range) {
  const { start, end } = range
  for (let i = start + 1; i < end; i += 1) {
    if (/^\s+config:\s*$/.test(lines[i])) {
      const configIndent = indentOf(lines[i])
      const keys = new Map()
      for (let j = i + 1; j < end; j += 1) {
        if (isBlank(lines[j])) continue
        const current = indentOf(lines[j])
        if (current <= configIndent) break
        if (current === configIndent + 2) {
          const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(lines[j].slice(current))
          if (match) keys.set(match[1], j)
        }
      }
      return { configIdx: i, configIndent, keys }
    }
  }
  return null
}

/**
 * 给某个预设插件注入 / 合并 config 键。
 * 只做插入；若上游已有同名键则抛错（拒绝静默覆盖上游值）。
 */
/** 找出某个组行内部 config 列表的区间与列表项。 */
export function groupItems(lines, groupId) {
  const { items, itemIndent } = pluginItems(lines)
  const range = pluginRange(lines, items, groupId)
  if (!range) throw new Error(`预设里找不到组 "${groupId}"`)
  let configIdx = -1
  let configIndent = 0
  for (let i = range.start + 1; i < range.end; i += 1) {
    if (/^\s+config:\s*$/.test(lines[i])) {
      configIdx = i
      configIndent = indentOf(lines[i])
      break
    }
  }
  if (configIdx < 0) throw new Error(`组 "${groupId}" 没有 config 列表，格式与预期不符`)
  const listIndent = configIndent + 2
  let listEnd = range.end
  for (let i = configIdx + 1; i < range.end; i += 1) {
    if (isBlank(lines[i])) continue
    if (indentOf(lines[i]) < listIndent) {
      listEnd = i
      break
    }
  }
  const listItems = []
  for (let i = configIdx + 1; i < listEnd; i += 1) {
    if (isBlank(lines[i])) continue
    if (indentOf(lines[i]) === listIndent && /^-\s/.test(lines[i].slice(listIndent))) listItems.push(i)
  }
  if (listItems.length === 0) throw new Error(`组 "${groupId}" 的 config 列表为空`)
  return { configIdx, configIndent, listIndent, listEnd, items: listItems, groupRange: range, topItemIndent: itemIndent }
}

/** group 为空时作用于预设顶层插件列表，否则作用于该组的 config 列表。 */
function scopeOf(lines, group) {
  if (!group) {
    const { items, itemIndent } = pluginItems(lines)
    return { items, itemIndent, end: lines.length }
  }
  const info = groupItems(lines, group)
  return { items: info.items, itemIndent: info.listIndent, end: info.listEnd }
}

function rangeOf(lines, scope, pluginId) {
  const index = scope.items.findIndex((lineIdx) => idOfItem(lines[lineIdx]) === pluginId)
  if (index < 0) return null
  const start = scope.items[index]
  const end = index + 1 < scope.items.length ? scope.items[index + 1] : scope.end
  return { start, end }
}

/**
 * 给预设插件注入 / 合并 config 键。group 指定时在该组的 config 列表里找插件
 * （例如 compaction 组的 compaction-basic —— 隔离域里的插件只能按组定位）。
 * 只做插入；若上游已有同名键则抛错，拒绝静默覆盖上游值。
 */
export function applyPluginConfig(lines, pluginId, config, { group } = {}) {
  const keys = Object.entries(config ?? {})
  const out = lines.slice()
  if (keys.length === 0) return out
  const scope = scopeOf(out, group)
  const range = rangeOf(out, scope, pluginId)
  if (!range) {
    throw new Error(`预设里找不到插件 "${pluginId}"${group ? `（组 ${group} 内）` : ''}；上游可能改了 id`)
  }
  const itemIndent = scope.itemIndent

  const existing = existingConfigKeys(out, range)
  if (existing) {
    const conflicts = keys.filter(([key]) => existing.keys.has(key)).map(([key]) => key)
    if (conflicts.length > 0) {
      throw new Error(
        `上游 ${pluginId} 已显式设置 ${conflicts.join(', ')}；为避免覆盖上游值，本次放弃写入（需人工合并）`,
      )
    }
    const insertAt = existing.configIdx + 1
    const pad = ' '.repeat(existing.configIndent + 2)
    out.splice(insertAt, 0, ...keys.map(([key, value]) => `${pad}${key}: ${yamlScalar(value)}`))
    return out
  }

  // 没有 config：紧跟 name: 行插入
  const nameIdx = out.findIndex((line, index) => index > range.start && index < range.end && /^\s+name:/.test(line))
  if (nameIdx < 0) throw new Error(`插件 ${pluginId} 缺少 name: 行，格式与预期不符`)
  const pad = ' '.repeat(itemIndent + 2)
  const keyPad = ' '.repeat(itemIndent + 4)
  out.splice(nameIdx + 1, 0, `${pad}config:`, ...keys.map(([key, value]) => `${keyPad}${key}: ${yamlScalar(value)}`))
  return out
}

/**
 * 往预设里新增一个插件行。group 指定时插入该组的 config 列表内部
 * （preset 内的隔离域是组的 realm，插在顶层拿不到组内服务）。
 */
export function applyPluginAdd(lines, entry) {
  const out = lines.slice()
  const { items, itemIndent } = pluginItems(out)
  const render = (pad) => {
    const rows = [`${pad}- id: ${entry.id}`, `${pad}  name: ${yamlScalar(entry.name)}`]
    const keys = Object.entries(entry.config ?? {})
    if (keys.length > 0) {
      rows.push(`${pad}  config:`)
      for (const [key, value] of keys) rows.push(`${pad}    ${key}: ${yamlScalar(value)}`)
    }
    return rows
  }

  if (!entry.group) {
    const last = items[items.length - 1]
    let end = out.length
    for (let i = last + 1; i < out.length; i += 1) {
      if (!isBlank(out[i]) && indentOf(out[i]) <= itemIndent) {
        end = i
        break
      }
    }
    out.splice(end, 0, ...render(' '.repeat(itemIndent)))
    return out
  }

  const groupInfo = groupItems(out, entry.group)
  out.splice(groupInfo.listEnd, 0, ...render(' '.repeat(groupInfo.listIndent)))
  return out
}

/**
 * 生成一个 preset 的覆盖声明行：上游原文 + 注入的改动。
 * 返回 { lines, added }，added 记录注入位置，便于自检“除注入外逐字节相同”。
 */
export function buildOverride(declarationLines, tweaks = {}) {
  let out = declarationLines.slice()
  const plugins = tweaks.plugins && typeof tweaks.plugins === 'object' ? tweaks.plugins : {}
  const adds = Array.isArray(tweaks.add) ? tweaks.add : []

  for (const [pluginId, spec] of Object.entries(plugins)) {
    const config = spec && typeof spec === 'object' && 'config' in spec ? spec.config : spec
    const group = spec && typeof spec === 'object' && typeof spec.group === 'string' ? spec.group : undefined
    out = applyPluginConfig(out, pluginId, config, { group })
  }
  for (const entry of adds) {
    if (!entry?.id || !entry?.name) throw new Error('add 条目必须有 id 与 name')
    out = applyPluginAdd(out, entry)
  }
  return out
}

/* ─────────────────────── managed block 拼接与解析 ─────────────────────── */

export function renderBlock({ presetId, upstreamSha, upstreamPath, declarationLines, note }) {
  const header = [
    `${MARK_BEGIN}${presetId} >>>`,
    '# 本段由 dsh-context-kit 生成，请勿手工编辑。',
    '# 它 = 上游声明原文（逐字节保留）+ 本插件注入的少量行，因此上游升级后重新 sync 即可继承全部改动。',
    `# 上游: ${upstreamPath}`,
    `# 上游 sha256: ${upstreamSha}`,
  ]
  if (note) header.push(`# ${note}`)
  return [...header, ...declarationLines, `${MARK_END}${presetId} <<<`]
}

/** 解析现有文件里的 managed block，返回区间与元数据。 */
export function parseManagedBlocks(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const blocks = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = MARK_BEGIN_RE.exec(lines[i])
    if (!match) continue
    const presetId = match[1].trim()
    let end = -1
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isEndMarkerFor(lines[j], presetId)) {
        end = j
        break
      }
    }
    if (end < 0) continue
    const body = lines.slice(i, end + 1)
    const shaLine = body.find((line) => /^#\s*上游 sha256:\s*(\S+)/.test(line))
    const pathLine = body.find((line) => /^#\s*上游:\s*(.+?)\s*$/.test(line))
    blocks.push({
      presetId,
      start: i,
      end,
      sha: shaLine ? /^#\s*上游 sha256:\s*(\S+)/.exec(shaLine)[1] : undefined,
      upstreamPath: pathLine ? /^#\s*上游:\s*(.+?)\s*$/.exec(pathLine)[1] : undefined,
      text: body.join('\n'),
    })
    i = end
  }
  return blocks
}

/** 找出 managed block 之外、与目标 preset 同 id 的顶层行（视为“外来覆盖”）。 */
export function findForeignRows(text, presetId) {
  const lines = String(text ?? '').split(/\r?\n/)
  const managed = parseManagedBlocks(text)
  const inside = new Set()
  for (const block of managed) for (let i = block.start; i <= block.end; i += 1) inside.add(i)
  const wanted = `preset-${presetId}`
  const hits = []
  for (let i = 0; i < lines.length; i += 1) {
    if (inside.has(i)) continue
    const match = /^-\s+id:\s*(\S+)\s*$/.exec(lines[i])
    if (match?.[1] === wanted) hits.push(i)
  }
  return hits
}

/**
 * 用一个或多个 managed block 替换文件里已有的 block 区段。
 * blocks 为空 = 删除全部 managed block（clear）。
 */
export function spliceBlocks(text, blocks) {
  const source = String(text ?? '')
  const lines = source.split(/\r?\n/)
  const existing = parseManagedBlocks(source)
  const kept = []
  let i = 0
  while (i < lines.length) {
    const block = existing.find((item) => item.start === i)
    if (block) {
      i = block.end + 1
      continue
    }
    kept.push(lines[i])
    i += 1
  }
  while (kept.length > 0 && isBlank(kept[kept.length - 1])) kept.pop()
  const rendered = blocks.flatMap((block) => ['', ...block])
  const out = [...kept, ...rendered]
  while (out.length > 0 && isBlank(out[out.length - 1])) out.pop()
  return `${out.join('\n')}\n`
}

/* ───────────────────────────── 结构与安全校验 ───────────────────────────── */

/** 轻量结构校验：不引 YAML 解析器，只查会让 Loader 直接失败的形态。 */
export function checkPatchShape(text) {
  const problems = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes('\t')) problems.push(`第 ${i + 1} 行含制表符`)
  }
  const blocks = parseManagedBlocks(text)
  for (const block of blocks) {
    if (block.end <= block.start) problems.push(`${block.presetId} 区段没有结束标记`)
    const body = lines.slice(block.start, block.end + 1)
    const ids = body.filter((line) => /^\s+-\s+id:/.test(line)).length
    if (ids === 0) problems.push(`${block.presetId} 区段里没有插件行`)
  }
  const starts = (text.match(/^# >>> (?:dsh-context-kit|dsh-preset-tuner): managed block:/gm) ?? []).length
  const ends = (text.match(/^# <<< (?:dsh-context-kit|dsh-preset-tuner): managed block:/gm) ?? []).length
  if (starts !== ends) problems.push(`标记不配对（begin ${starts} / end ${ends}）`)
  return problems
}

/** 备份 -> 写入。返回 { changed, backup, path }。 */
export function writePatchFile(profileDir, text, { keepBackups = 10 } = {}) {
  const file = join(profileDir, PATCH_FILE)
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (previous === text) return { changed: false, path: file, backup: null }

  const eol = previous.includes('\r\n') ? '\r\n' : '\n'
  const payload = eol === '\n' ? text : text.replace(/\r?\n/g, '\r\n')
  let backup = null
  if (previous) {
    const dir = join(profileDir, 'dsh-context-kit', 'backups')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backup = join(dir, `${PATCH_FILE}.${stamp}.bak`)
    copyFileSync(file, backup)
    const old = readdirSync(dir)
      .filter((name) => name.endsWith('.bak'))
      .sort()
    for (const name of old.slice(0, Math.max(0, old.length - keepBackups))) {
      try {
        unlinkSync(join(dir, name))
      } catch {}
    }
  }
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(file, payload, 'utf8')
  return { changed: true, path: file, backup }
}

/* ─────────────────────────── profile 目录定位 ─────────────────────────── */

/**
 * 定位 profile 目录。顺序：显式配置 → 环境变量 → 模块自身安装路径 →
 * ~/.dsh/profiles/<配置名或 desktop> → 唯一 profile 兜底。
 */
export function resolveProfileDir({ config = {}, moduleUrl, home = homedir(), env = process.env } = {}) {
  if (config.profileDir) return { dir: resolve(config.profileDir), via: 'config.profileDir' }
  if (env.DSH_PROFILE_DIR) return { dir: resolve(env.DSH_PROFILE_DIR), via: 'env.DSH_PROFILE_DIR' }

  if (moduleUrl) {
    const match = /[\\/]profiles[\\/]([^\\/]+)[\\/]/.exec(moduleUrl)
    if (match) {
      const base = env.DSH_HOME ? resolve(env.DSH_HOME) : join(home, '.dsh')
      const candidate = join(base, 'profiles', match[1])
      if (existsSync(candidate)) return { dir: candidate, via: 'module path' }
    }
  }

  const base = env.DSH_HOME ? resolve(env.DSH_HOME) : join(home, '.dsh')
  const preferred = join(base, 'profiles', config.profile ?? 'desktop')
  if (existsSync(preferred)) return { dir: preferred, via: `profiles/${config.profile ?? 'desktop'}` }

  const root = join(base, 'profiles')
  if (existsSync(root)) {
    const names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .map((entry) => entry.name)
    if (names.length === 1) return { dir: join(root, names[0]), via: '唯一 profile' }
    if (names.length > 1) {
      throw new Error(`找到多个 profile（${names.join(', ')}），请在插件配置里显式设置 profileDir`)
    }
  }
  throw new Error('找不到 DSH profile 目录，请在插件配置里设置 profileDir')
}

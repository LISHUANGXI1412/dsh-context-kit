// dsh-context-kit 的 Settings 面板（Web 客户端插件）。
// 通过 ctx.connection.rpc 调宿主 contextKit 服务：status / save / sync / preview / clear。
window.__ModuleLoader__.load({
  id: 'dsh-context-kit',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const EN = {
      label: 'Context',
      title: 'Context & Compaction',
      subtitle: 'Save tokens by compacting earlier, without freezing the preset.',
      threshold: 'Compact at',
      retain: 'Keep after compact',
      auto: 'Automatic compaction',
      save: 'Save',
      sync: 'Apply to profile',
      preview: 'Preview',
      clear: 'Remove override',
      refresh: 'Refresh',
      restart: 'Restart DSH to apply. Existing sessions pick up the new preset after restart.',
      saved: 'Saved. Apply + restart to take effect.',
      synced: 'Written to the profile patch.',
      unchanged: 'Already up to date; nothing written.',
      cleared: 'Override removed. Restart to fall back to upstream defaults.',
      drift: 'Upstream preset changed',
      upToDate: 'Upstream in sync',
      missing: 'Not generated yet',
      foreign: 'A hand-written override exists in your patch; remove it before applying.',
      ofWindow: 'of the context window',
      triggers: 'Compaction triggers at',
      keeps: 'then keeps about',
      profile: 'Profile',
      patch: 'Patch file',
      upstream: 'Upstream',
      busy: 'Working…',
      error: 'Error',
    }

    const ZH = {
      label: '上下文',
      title: '上下文与压缩',
      subtitle: '早点压缩来省 token，同时不冻结预设。',
      threshold: '压缩触发于',
      retain: '压缩后保留',
      auto: '启用自动压缩',
      save: '保存',
      sync: '写入 profile',
      preview: '预览',
      clear: '移除覆盖',
      refresh: '刷新',
      restart: '重启 DSH 后生效；已存在的会话也会在重启后使用新的预设版本。',
      saved: '已保存。写入并重启后生效。',
      synced: '已写入 profile 补丁。',
      unchanged: '已是最新，没有写入。',
      cleared: '已移除覆盖，重启后回到上游默认。',
      drift: '上游预设已变化',
      upToDate: '与上游一致',
      missing: '尚未生成',
      foreign: '补丁里存在手写覆盖，请先移除再写入。',
      ofWindow: '占上下文窗口',
      triggers: '压缩触发点',
      keeps: '压缩后约保留',
      profile: 'Profile',
      patch: '补丁文件',
      upstream: '上游',
      busy: '处理中…',
      error: '出错',
    }

    const CSS = `
      .ck_wrap { display: flex; flex-direction: column; gap: 14px; }
      .ck_head h2 { margin: 0 0 4px; font-size: 15px; }
      .ck_head p { margin: 0; opacity: .7; font-size: 12px; }
      .ck_card { border: 1px solid rgba(127,127,127,.25); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
      .ck_row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .ck_row label { min-width: 110px; font-size: 12px; opacity: .8; }
      .ck_row input[type=range] { flex: 1 1 160px; }
      .ck_val { font-variant-numeric: tabular-nums; min-width: 72px; text-align: right; font-size: 12px; }
      .ck_btns { display: flex; gap: 8px; flex-wrap: wrap; }
      .ck_btn { border: 1px solid rgba(127,127,127,.35); background: transparent; border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
      .ck_btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
      .ck_btn:disabled { opacity: .5; cursor: default; }
      .ck_meta { font-size: 11px; opacity: .65; word-break: break-all; }
      .ck_state { font-size: 12px; padding: 6px 8px; border-radius: 8px; background: rgba(127,127,127,.12); }
      .ck_warn { color: #d97706; }
      .ck_err { color: #dc2626; }
      .ck_pre { max-height: 220px; overflow: auto; font-size: 11px; background: rgba(127,127,127,.12); padding: 8px; border-radius: 8px; white-space: pre-wrap; }
    `

    function makeT(ctx) {
      try {
        ctx.locale.register('context-kit', { en: EN, zh: ZH })
      } catch {}
      let bound
      try {
        bound = ctx.locale.bind('context-kit')
      } catch {}
      return function t(key, fallback) {
        try {
          if (typeof bound === 'function') {
            const value = bound(key)
            if (typeof value === 'string' && value) return value
          } else if (bound && typeof bound[key] === 'string') {
            return bound[key]
          }
        } catch {}
        let id = 'en'
        try { id = ctx.locale.getLocale().id } catch {}
        const dict = id === 'zh' ? ZH : EN
        return dict[key] || fallback || key
      }
    }

    function makeApi(ctx) {
      function call(method, args) {
        return ctx.connection.rpc.call('/api', `contextKit/${method}`, { args: args || {} }, undefined).then(function (response) {
          if (response && response.ok) return response.value
          const message = response && response.error ? response.error.message : 'context kit remote call failed'
          const error = new Error(message)
          error.code = response && response.error ? response.error.code : 'REMOTE_FAILED'
          throw error
        })
      }
      return {
        status: function () { return call('status', {}) },
        save: function (input) {
          return call('save', {
            presetId: input.presetId,
            thresholdRatio: input.thresholdRatio,
            retainRatio: input.retainRatio,
            auto: input.auto,
            group: input.group,
          })
        },
        sync: function () { return call('sync', { force: false, mode: 'append' }) },
        preview: function () { return call('preview', {}) },
        clear: function () { return call('clear', {}) },
      }
    }

    const fmtK = function (tokens) {
      if (!Number.isFinite(tokens)) return '—'
      if (tokens >= 1024 * 1024) return (tokens / (1024 * 1024)).toFixed(1) + 'M'
      return Math.round(tokens / 1024) + 'K'
    }
    const pct = function (ratio) { return Math.round(Number(ratio) * 1000) / 10 + '%' }

    function Panel(props) {
      const t = props.t
      const api = props.api
      const [state, setState] = React.useState(null)
      const [threshold, setThreshold] = React.useState(0.5)
      const [retain, setRetain] = React.useState(0.16)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [error, setError] = React.useState('')
      const [pre, setPre] = React.useState('')

      const load = React.useCallback(function () {
        return api.status().then(function (next) {
          setState(next)
          if (next && next.knobs) {
            setThreshold(Number(next.knobs.thresholdRatio) || 0.5)
            setRetain(Number(next.knobs.retainRatio) || 0.16)
          }
        }).catch(function (cause) { setError(String(cause && cause.message ? cause.message : cause)) })
      }, [api])

      React.useEffect(function () { load() }, [load])

      const run = function (label, task) {
        setBusy(true)
        setError('')
        setMessage('')
        return task().then(function (result) {
          if (label) setMessage(label)
          return result
        }).catch(function (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }).then(function () { setBusy(false) })
      }

      const presetId = state && state.presets && state.presets.length ? state.presets[0] : 'cordis'
      const window2 = state && state.triggers ? state.triggers.contextWindow : 1048576
      const triggerTokens = Math.floor(window2 * threshold)
      const retainTokens = Math.floor(window2 * retain)

      const entry = state && state.entries ? state.entries[0] : null
      const stateText = !entry
        ? t('missing')
        : entry.drifted
          ? t('drift') + ' · ' + entry.previousSha + ' → ' + entry.upstreamSha
          : entry.previousSha
            ? t('upToDate') + ' · ' + entry.upstreamSha
            : t('missing')

      return h('div', { className: 'ck_wrap' },
        h('div', { className: 'ck_head' },
          h('h2', null, t('title')),
          h('p', null, t('subtitle'))),

        h('div', { className: 'ck_card' },
          h('div', { className: 'ck_row' },
            h('label', null, t('threshold')),
            h('input', {
              type: 'range', min: 0.2, max: 0.85, step: 0.01, value: threshold,
              disabled: busy,
              onChange: function (event) { setThreshold(Number(event.target.value)) },
            }),
            h('span', { className: 'ck_val' }, fmtK(triggerTokens)),
            h('span', { className: 'ck_meta' }, pct(threshold) + ' ' + t('ofWindow'))),
          h('div', { className: 'ck_row' },
            h('label', null, t('retain')),
            h('input', {
              type: 'range', min: 0.04, max: Math.max(0.05, threshold - 0.02), step: 0.01, value: retain,
              disabled: busy,
              onChange: function (event) { setRetain(Number(event.target.value)) },
            }),
            h('span', { className: 'ck_val' }, fmtK(retainTokens)),
            h('span', { className: 'ck_meta' }, pct(retain) + ' ' + t('ofWindow'))),
          h('div', { className: 'ck_meta' },
            t('triggers') + ' ' + fmtK(triggerTokens) + ' · ' + t('keeps') + ' ' + fmtK(retainTokens)),
          h('div', { className: 'ck_btns' },
            h('button', {
              className: 'ck_btn primary', type: 'button', disabled: busy,
              onClick: function () {
                return run(t('saved'), function () {
                  return api.save({ presetId: presetId, thresholdRatio: threshold, retainRatio: retain, auto: true, group: 'compaction' })
                    .then(load)
                })
              },
            }, t('save')),
            h('button', {
              className: 'ck_btn', type: 'button', disabled: busy,
              onClick: function () {
                return run('', function () {
                  return api.sync().then(function (result) {
                    setMessage(result && result.changed ? t('synced') : t('unchanged'))
                    return load()
                  })
                })
              },
            }, t('sync')),
            h('button', {
              className: 'ck_btn', type: 'button', disabled: busy,
              onClick: function () {
                return run('', function () {
                  return api.preview().then(function (result) { setPre(result && result.text ? result.text : '') })
                })
              },
            }, t('preview')),
            h('button', {
              className: 'ck_btn', type: 'button', disabled: busy,
              onClick: function () {
                return run(t('cleared'), function () { return api.clear().then(load) })
              },
            }, t('clear')),
            h('button', {
              className: 'ck_btn', type: 'button', disabled: busy,
              onClick: function () { return load() },
            }, t('refresh')))),

        state ? h('div', { className: 'ck_state' }, stateText) : null,
        state && state.foreign && state.foreign.length ? h('div', { className: 'ck_state ck_warn' }, t('foreign')) : null,
        message ? h('div', { className: 'ck_meta' }, message) : null,
        error ? h('div', { className: 'ck_meta ck_err' }, t('error') + ': ' + error) : null,
        state ? h('div', { className: 'ck_meta' }, t('profile') + ': ' + state.profileDir + ' · ' + t('patch') + ': ' + state.patchPath) : null,
        state ? h('div', { className: 'ck_meta' }, t('upstream') + ': ' + (state.sources || []).join(' | ')) : null,
        state && state.managed && state.managed.length
          ? h('div', { className: 'ck_meta' }, state.managed.map(function (block) { return block.presetId + '@' + block.sha }).join(', '))
          : null,
        h('div', { className: 'ck_meta' }, t('restart')),
        pre ? h('pre', { className: 'ck_pre' }, pre) : null)
    }

    return {
      inject: ['slots', 'connection', 'locale'],
      apply(ctx) {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-context-kit'
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(function () {
          return function () { style.remove() }
        })

        const t = makeT(ctx)
        const api = makeApi(ctx)
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'context-kit',
            order: 46,
            label: function () { return t('label', 'Context') },
            inject: function () { return { api: api, t: t } },
          }, Panel)
        })
      },
    }
  },
})

// dsh-context-kit 的 Settings 面板（Web 客户端插件）。
// 通过 ctx.connection.rpc 调宿主 contextKit 服务：status / save / sync / preview / clear / report。
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
      effectTitle: 'Measured effect',
      effectHint: "Reads this machine's session logs. Nothing leaves the device.",
      effectRun: 'Measure last 7 days',
      effectRunning: 'Reading session logs…',
      effectEmpty: 'Measuring… the first run decompresses recent sessions and may take a few seconds. Less than 7 days of history is fine — the window is capped at 7 days, not required.',
      effectSessions: 'sessions',
      effectSteps: 'steps',
      effectCompactions: 'compactions',
      effectHit: 'cache hit',
      effectMiss: 'cache miss',
      effectOut: 'output',
      effectMissShare: 'miss share of cost',
      effectContext: 'context (avg / peak)',
      effectCost: 'cost (hit-equivalents)',
      effectSavings: 'Estimated saving',
      effectSavingsNote: 'estimate: replays your real per-step growth against the shipped default; not a bill',
      effectRework: 'Rework signal',
      effectReworkNote: 'repeated identical calls — the first sign compaction went too deep',
      effectSkipped: 'skipped files',
      effectWindow: 'window',
      effectFiles: 'session logs read',
      effectAt: 'measured at',
      effectPolicies: 'observed policies',
      effectCurrent: 'current',
      effectCoverage: 'data under the current threshold',
      effectModelOnly: 'Too few steps ran under the current threshold — treat the estimate as a direction, not a result.',
    }

    const ZH = {
      label: '上下文',
      title: '上下文与压缩',
      subtitle: '早点压缩来省 token，同时不冻结预设。',
      threshold: '压缩触发于',
      retain: '压缩后保留',
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
      effectTitle: '实测效果',
      effectHint: '只读本机会话日志，数据不出设备。',
      effectRun: '统计最近 7 天',
      effectRunning: '正在读会话日志…',
      effectEmpty: '正在统计… 第一次要解压最近的会话，可能需要几秒。用不满 7 天也能统计 —— 7 天是窗口上限，不是前提。',
      effectSessions: '个会话',
      effectSteps: '步',
      effectCompactions: '次压缩',
      effectHit: '缓存命中',
      effectMiss: '未命中',
      effectOut: '输出',
      effectMissShare: '未命中占成本',
      effectContext: '上下文（均值 / 峰值）',
      effectCost: '成本（命中当量）',
      effectSavings: '估算节省',
      effectSavingsNote: '估算：用你的真实每步增量回放官方默认阈值，不等于账单',
      effectRework: '返工信号',
      effectReworkNote: '重复的相同调用 —— 压缩压过头的第一信号',
      effectSkipped: '跳过文件',
      effectWindow: '窗口',
      effectFiles: '个会话日志',
      effectAt: '统计时间',
      effectPolicies: '观测到的策略',
      effectCurrent: '当前',
      effectCoverage: '当前阈值下的实测',
      effectModelOnly: '当前阈值下实际跑过的步数还太少 —— 这个估算只能当方向，不能当结论。',
    }

    const CSS = [
      '.ck_wrap { display: flex; flex-direction: column; gap: 14px; }',
      '.ck_head h2 { margin: 0 0 4px; font-size: 15px; }',
      '.ck_head p { margin: 0; opacity: .7; font-size: 12px; }',
      '.ck_card { border: 1px solid rgba(127,127,127,.25); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }',
      '.ck_row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
      '.ck_row label { min-width: 110px; font-size: 12px; opacity: .8; }',
      '.ck_row input[type=range] { flex: 1 1 160px; }',
      '.ck_val { font-variant-numeric: tabular-nums; min-width: 72px; text-align: right; font-size: 12px; }',
      '.ck_btns { display: flex; gap: 8px; flex-wrap: wrap; }',
      '.ck_btn { border: 1px solid rgba(127,127,127,.35); background: transparent; border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 12px; }',
      '.ck_btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }',
      '.ck_btn:disabled { opacity: .5; cursor: default; }',
      '.ck_meta { font-size: 11px; opacity: .65; word-break: break-all; }',
      '.ck_state { font-size: 12px; padding: 6px 8px; border-radius: 8px; background: rgba(127,127,127,.12); }',
      '.ck_warn { color: #d97706; }',
      '.ck_err { color: #dc2626; }',
      '.ck_pre { max-height: 220px; overflow: auto; font-size: 11px; background: rgba(127,127,127,.12); padding: 8px; border-radius: 8px; white-space: pre-wrap; }',
    ].join('\n')

    const fmtK = (tokens) => {
      if (!Number.isFinite(tokens)) return '—'
      if (tokens >= 1024 * 1024) return (tokens / (1024 * 1024)).toFixed(1) + 'M'
      return Math.round(tokens / 1024) + 'K'
    }
    const fmtBig = (value) => {
      if (!Number.isFinite(value)) return '—'
      if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B'
      if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M'
      if (value >= 1e3) return Math.round(value / 1e3) + 'K'
      return String(Math.round(value))
    }
    const pct = (ratio) => Math.round(Number(ratio) * 1000) / 10 + '%'
    const meta = (value) => h('div', { className: 'ck_meta' }, value)

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
        try {
          id = ctx.locale.getLocale().id
        } catch {}
        const dict = id === 'zh' ? ZH : EN
        return dict[key] || fallback || key
      }
    }

    function makeApi(ctx) {
      function call(method, args) {
        return ctx.connection.rpc.call('/api', 'contextKit/' + method, { args: args || {} }, undefined).then(function (response) {
          if (response && response.ok) return response.value
          const message = response && response.error ? response.error.message : 'context kit remote call failed'
          const error = new Error(message)
          error.code = response && response.error ? response.error.code : 'REMOTE_FAILED'
          throw error
        })
      }
      return {
        status: () => call('status', {}),
        preview: () => call('preview', {}),
        clear: () => call('clear', {}),
        sync: () => call('sync', { force: false, mode: 'append' }),
        report: (days) => call('report', { days: days }),
        save: (input) =>
          call('save', {
            presetId: input.presetId,
            thresholdRatio: input.thresholdRatio,
            retainRatio: input.retainRatio,
            auto: input.auto,
            group: input.group,
          }),
      }
    }

    function EffectCard(props) {
      const t = props.t
      const report = props.report
      const rows = []
      if (report) {
        const total = report.totals
        rows.push(meta(total.sessions + ' ' + t('effectSessions') + ' · ' + total.steps + ' ' + t('effectSteps') + ' · ' + total.compactions + ' ' + t('effectCompactions')))
        if (report.policies && report.policies.length) {
          rows.push(meta(t('effectPolicies')))
          for (const policy of report.policies) {
            const label = policy.triggerTokens === null ? '—' : fmtK(policy.triggerTokens)
            rows.push(meta('  ' + label + ': ' + policy.totals.sessions + ' ' + t('effectSessions') + ' / ' + policy.totals.steps + ' ' + t('effectSteps') + (policy.isCurrent ? '  ← ' + t('effectCurrent') : '')))
          }
        }
        if (report.coverage) {
          rows.push(meta(t('effectCoverage') + ': ' + report.coverage.stepsUnderCurrent + ' ' + t('effectSteps') + ' (' + pct(report.coverage.sharePct / 100) + ')'))
        }
        rows.push(
          h('div', { className: 'ck_row' },
            meta(t('effectHit') + ' ' + fmtBig(total.hit)),
            meta(t('effectMiss') + ' ' + fmtBig(total.miss)),
            meta(t('effectOut') + ' ' + fmtBig(total.out))),
        )
        rows.push(
          h('div', { className: 'ck_row' },
            meta(t('effectMissShare') + ' ' + pct(total.missSharePct / 100)),
            meta(t('effectContext') + ' ' + fmtK(total.promptAvg) + ' / ' + fmtK(total.promptMax)),
            meta(t('effectCost') + ' ' + fmtBig(total.cost.total))),
        )
        if (report.savings) {
          rows.push(
            h('div', { className: 'ck_row' },
              h('span', { className: 'ck_val' }, '−' + report.savings.savedPct.toFixed(1) + '%'),
              meta(t('effectSavings') + ' · ' + t('effectSavingsNote'))),
          )
          if (report.coverage && report.coverage.isModelOnly) {
            rows.push(h('div', { className: 'ck_meta ck_warn' }, t('effectModelOnly')))
          }
        }
        rows.push(meta(t('effectRework') + ' ' + total.duplicates + ' / ' + total.distinctCalls + ' (' + pct(total.duplicatePct / 100) + ') · ' + t('effectReworkNote')))
        if (report.skipped && report.skipped.length) rows.push(h('div', { className: 'ck_meta ck_warn' }, t('effectSkipped') + ': ' + report.skipped.length))
        rows.push(meta(report.privacy))
      } else {
        rows.push(meta(t('effectEmpty')))
      }
      return h('div', { className: 'ck_card' },
        h('div', { className: 'ck_row' },
          h('label', null, t('effectTitle')),
          meta(t('effectHint')),
          h('button', { className: 'ck_btn', type: 'button', disabled: props.busy, onClick: props.onRun },
            props.busy ? t('effectRunning') : t('effectRun'))),
        ...rows)
    }

    function SliderRow(props) {
      return h('div', { className: 'ck_row' },
        h('label', null, props.label),
        h('input', {
          type: 'range',
          min: props.min,
          max: props.max,
          step: 0.01,
          value: props.value,
          disabled: props.disabled,
          onChange: function (event) { props.onChange(Number(event.target.value)) },
        }),
        h('span', { className: 'ck_val' }, fmtK(props.tokens)),
        h('span', { className: 'ck_meta' }, pct(props.value) + ' ' + props.ofWindow))
    }

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
      const [report, setReport] = React.useState(null)

      const load = React.useCallback(function () {
        return api.status().then(function (next) {
          setState(next)
          if (next && next.knobs) {
            setThreshold(Number(next.knobs.thresholdRatio) || 0.5)
            setRetain(Number(next.knobs.retainRatio) || 0.16)
          }
        }).catch(function (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        })
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
      const windowSize = state && state.triggers ? state.triggers.contextWindow : 1048576
      const triggerTokens = Math.floor(windowSize * threshold)
      const retainTokens = Math.floor(windowSize * retain)
      const entry = state && state.entries ? state.entries[0] : null
      const stateText = !entry
        ? t('missing')
        : entry.drifted
          ? t('drift') + ' · ' + entry.previousSha + ' → ' + entry.upstreamSha
          : entry.previousSha
            ? t('upToDate') + ' · ' + entry.upstreamSha
            : t('missing')

      const configCard = h('div', { className: 'ck_card' },
        h(SliderRow, {
          label: t('threshold'), min: 0.2, max: 0.85, value: threshold,
          tokens: triggerTokens, ofWindow: t('ofWindow'), disabled: busy,
          onChange: setThreshold,
        }),
        h(SliderRow, {
          label: t('retain'), min: 0.04, max: Math.max(0.05, threshold - 0.02), value: retain,
          tokens: retainTokens, ofWindow: t('ofWindow'), disabled: busy,
          onChange: setRetain,
        }),
        meta(t('triggers') + ' ' + fmtK(triggerTokens) + ' · ' + t('keeps') + ' ' + fmtK(retainTokens)),
        h('div', { className: 'ck_btns' },
          h('button', {
            className: 'ck_btn primary', type: 'button', disabled: busy,
            onClick: function () {
              return run(t('saved'), function () {
                return api.save({ presetId: presetId, thresholdRatio: threshold, retainRatio: retain, auto: true, group: 'compaction' }).then(load)
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
          }, t('refresh'))))

      const infoRows = []
      if (state) infoRows.push(h('div', { className: 'ck_state' }, stateText))
      if (state && state.foreign && state.foreign.length) infoRows.push(h('div', { className: 'ck_state ck_warn' }, t('foreign')))
      if (message) infoRows.push(meta(message))
      if (error) infoRows.push(h('div', { className: 'ck_meta ck_err' }, t('error') + ': ' + error))
      if (state) infoRows.push(meta(t('profile') + ': ' + state.profileDir + ' · ' + t('patch') + ': ' + state.patchPath))
      if (state) infoRows.push(meta(t('upstream') + ': ' + (state.sources || []).join(' | ')))
      if (state && state.managed && state.managed.length) {
        infoRows.push(meta(state.managed.map(function (block) { return block.presetId + '@' + block.sha }).join(', ')))
      }
      infoRows.push(meta(t('restart')))
      if (pre) infoRows.push(h('pre', { className: 'ck_pre' }, pre))

      return h('div', { className: 'ck_wrap' },
        h('div', { className: 'ck_head' },
          h('h2', null, t('title')),
          h('p', null, t('subtitle'))),
        configCard,
        h(EffectCard, {
          t: t,
          report: report,
          busy: busy,
          onRun: function () {
            return run('', function () {
              return api.report(7).then(function (next) { setReport(next) })
            })
          },
        }),
        ...infoRows)
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

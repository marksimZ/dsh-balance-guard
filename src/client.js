/**
 * Balance guard, browser half.
 *
 * This file IS the client artifact: the DSH client module table loads it
 * through `window.__ModuleLoader__.load({ id, factory })`, the factory receives
 * the page's shared `require`, and the whole plugin is therefore plain
 * CommonJS with no bundler step. `react` arrives from the shell's platform
 * seed; nothing else is imported.
 *
 * The Host half owns every number: tone, fill ratio, overflow, and the amounts
 * in the snapshot. This file only turns one snapshot into pixels — the bar, the
 * horizontal amount chip, the static warning dot, and the hover card. That is
 * deliberate: one copy of the product rules in `src/policy.js`, and no chance
 * of a stale threshold living in a cached bundle.
 *
 * Colour bands (decided by the Host): < 10 red, 10–30 orange, 30–50 green,
 * > 50 blue with a wave above the 50 scale mark.
 */

window.__ModuleLoader__.load({
  id: 'dsh-balance-guard',
  factory: (require) => {
    'use strict'

    const React = require('react')

    /** Host route serving the current snapshot. */
    const STATE_ROUTE = '/dsh-balance-guard/state'

    /** Style element carrying every rule this plugin owns. */
    const STYLE_ID = 'dsh-balance-guard/styles'

    /** Fallback cursor while there is no snapshot to read the cadence from. */
    const FIRST_POLL_MS = 2_000

    /** Hidden-tab poll floor; a background window does not need 1 Hz. */
    const HIDDEN_POLL_MS = 15_000

    /** Gradient stops per band. Blue is the "plenty" band; the wave sits above. */
    const PALETTE = {
      red: ['#ff5a5a', '#c81f3c'],
      orange: ['#ffb24a', '#e07810'],
      green: ['#4ce08a', '#12915c'],
      blue: ['#7cb0ff', '#2563eb'],
    }

    /** Wave ink: the light blue-violet pair the crest and body are drawn with. */
    const WAVE_CREST = '#cddcff'
    const WAVE_BODY = '#8fb0ff'

    const STYLES = `
.dsh-bg-root {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 0;
  pointer-events: none;
  z-index: 30;
}
.dsh-bg-bar {
  position: absolute;
  top: 84px;
  right: 12px;
  bottom: 26px;
  width: 16px;
  overflow: hidden;
  border-radius: 999px;
  pointer-events: auto;
  cursor: pointer;
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #ffffff) 45%, transparent);
  box-shadow: 0 1px 2px rgb(0 0 0 / 18%), inset 0 0 0 0.5px rgb(127 127 127 / 22%);
  transition: width 180ms ease, right 180ms ease;
}
.dsh-bg-root[data-open='true'] .dsh-bg-bar,
.dsh-bg-bar:hover {
  width: 22px;
  right: 9px;
}
.dsh-bg-bar:focus-visible {
  outline: 2px solid var(--dsw-alias-link, #6b8cff);
  outline-offset: 2px;
}
.dsh-bg-fill {
  position: absolute;
  inset: auto 0 0 0;
  transition: height 600ms cubic-bezier(.22, .61, .36, 1), background 400ms linear;
}
.dsh-bg-fill[data-tone='red'] { background: linear-gradient(to top, ${PALETTE.red[1]}, ${PALETTE.red[0]}); }
.dsh-bg-fill[data-tone='orange'] { background: linear-gradient(to top, ${PALETTE.orange[1]}, ${PALETTE.orange[0]}); }
.dsh-bg-fill[data-tone='green'] { background: linear-gradient(to top, ${PALETTE.green[1]}, ${PALETTE.green[0]}); }
.dsh-bg-fill[data-tone='blue'] { background: linear-gradient(to top, ${PALETTE.blue[1]}, ${PALETTE.blue[0]}); }
.dsh-bg-fill[data-tone='unknown'] { background: linear-gradient(to top, #8b8b8b, #c9c9c9); }
.dsh-bg-surface {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  overflow: hidden;
  pointer-events: none;
}
.dsh-bg-glow {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 90px;
  background: linear-gradient(to top, ${WAVE_BODY}, transparent);
  opacity: .38;
}
.dsh-bg-wave {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 200%;
  height: 100%;
  animation: dshbg-scroll 5.5s linear infinite;
}
.dsh-bg-wave--back {
  width: 300%;
  animation-duration: 8.5s;
  opacity: .55;
}
.dsh-bg-wave path { fill: ${WAVE_BODY}; }
.dsh-bg-wave--crest path {
  fill: none;
  stroke: ${WAVE_CREST};
  stroke-width: 2;
  opacity: .95;
}
@keyframes dshbg-scroll {
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
}
.dsh-bg-label {
  position: absolute;
  top: 50%;
  right: 34px;
  transform: translateY(-50%);
  pointer-events: auto;
  cursor: pointer;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  letter-spacing: .02em;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, #1b1b1b);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border-radius: 999px;
  padding: 4px 9px;
  box-shadow: var(--dsw-elevation-panel, 0 2px 8px rgb(0 0 0 / 18%));
  transition: right 180ms ease;
}
.dsh-bg-root[data-open='true'] .dsh-bg-label { right: 31px; }
.dsh-bg-root[data-tone='red'] .dsh-bg-label { color: #d92b2b; }
.dsh-bg-root[data-tone='orange'] .dsh-bg-label { color: #b45309; }
.dsh-bg-root[data-tone='green'] .dsh-bg-label { color: #0f7a4a; }
.dsh-bg-root[data-tone='blue'] .dsh-bg-label { color: #1d4ed8; }
.dsh-bg-root[data-tone='unknown'] .dsh-bg-label { color: var(--dsw-alias-label-secondary, #4a4a4a); }
.dsh-bg-marker {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 6px;
  border-radius: 999px;
  background: #e11d48;
  vertical-align: middle;
}
.dsh-bg-card {
  position: fixed;
  right: 76px;
  top: 50%;
  transform: translateY(-50%);
  min-width: 168px;
  max-width: 260px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 0;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  box-shadow: var(--dsw-elevation-prominent, 0 8px 28px rgb(0 0 0 / 22%));
  color: var(--dsw-alias-label-primary, #1b1b1b);
  font-size: 12px;
  line-height: 18px;
  pointer-events: auto;
}
.dsh-bg-card-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  color: var(--dsw-alias-label-secondary, #4a4a4a);
  margin-bottom: 4px;
}
.dsh-bg-card-value {
  font-size: 19px;
  line-height: 24px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, #1b1b1b);
}
.dsh-bg-card-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--dsw-alias-label-secondary, #4a4a4a);
  font-variant-numeric: tabular-nums;
}
.dsh-bg-card-row[data-emphasis='true'] {
  color: var(--dsw-alias-label-primary, #1b1b1b);
  font-weight: 600;
}
.dsh-bg-card-warning {
  margin-top: 4px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dsh-bg-card-warning[data-level='error'] { color: var(--dsw-alias-state-error-primary, #d92b2b); }
.dsh-bg-card-warning[data-level='warning'] { color: #b45309; }
.dsh-bg-card-note {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(127 127 127 / 30%));
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #5c5c5c);
}
.dsh-bg-card-note + .dsh-bg-card-note { margin-top: 2px; padding-top: 0; border-top: 0; }
.dsh-bg-card-note[data-error='true'] { color: var(--dsw-alias-state-error-primary, #d92b2b); }
.dsh-bg-card-actions {
  margin-top: 8px;
  display: flex;
  justify-content: flex-end;
}
.dsh-bg-link {
  color: var(--dsw-alias-link, #6b8cff);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
.dsh-bg-link:hover { text-decoration: underline; }
@media (max-width: 860px) {
  .dsh-bg-bar { right: 6px; width: 12px; }
  .dsh-bg-bar:hover { width: 16px; right: 4px; }
  .dsh-bg-label { right: 26px; }
  .dsh-bg-card { right: 64px; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-bg-bar,
  .dsh-bg-label,
  .dsh-bg-fill { transition: none; }
  .dsh-bg-wave { animation: none; }
}
`

    /** Install the stylesheet once per page. */
    function installStyles() {
      if (document.querySelector('style[data-dsh-plugin-css="' + STYLE_ID + '"]') !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.dshPlugin = 'dsh-balance-guard'
      tag.dataset.dshPluginCss = STYLE_ID
      tag.textContent = STYLES
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /** Clamp into `[0, 1]`, mapping junk to 0. */
    function fraction(value) {
      const parsed = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(parsed)) return 0
      return parsed < 0 ? 0 : parsed > 1 ? 1 : parsed
    }

    /** Two decimals; an absent value reads as a dash, never as 0.00. */
    function formatAmount(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—'
    }

    /** `¥1.20`, or `<¥0.01` for dust so a real cost never shows as zero. */
    function money(symbol, value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return symbol + '—'
      if (value > 0 && value < 0.01) return '<' + symbol + '0.01'
      return symbol + value.toFixed(2)
    }

    /** `¥0.90 – ¥2.30`. */
    function range(symbol, min, max) {
      const low = money(symbol, min)
      const high = money(symbol, max)
      return low === high ? low : low + ' – ' + high
    }

    /** Milliseconds in a compact relative form. */
    function relativeTime(from, now) {
      if (typeof from !== 'number' || from <= 0) return '尚未获取'
      const seconds = Math.max(0, Math.round((now - from) / 1000))
      if (seconds < 10) return '刚刚'
      if (seconds < 60) return seconds + ' 秒前'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes + ' 分钟前'
      return Math.round(minutes / 60) + ' 小时前'
    }

    /** The text under "估算依据". */
    function basisText(task) {
      if (task === null || typeof task !== 'object') return ''
      if (task.usageAvailable === false) return '用量数据不可用'
      const steps = typeof task.stepsExpected === 'number' ? task.stepsExpected : 0
      const hit = typeof task.cacheHit === 'number' ? Math.round(task.cacheHit * 100) : 0
      const hitSource = task.cacheHitSource === 'measured' ? '实测' : '默认'
      const period = task.peak === true ? '峰时价' : '谷时价'
      return steps + ' 步 · 缓存命中 ' + hit + '%（' + hitSource + '）· ' + period
    }

    /**
     * Project one Host snapshot onto everything the bar and card show.
     *
     * Pure and exported to the spec test: the rendering below is a direct map
     * of this object, so the product copy and the warning rules are testable
     * without a DOM.
     *
     * @param {any} snapshot
     * @param {number} [now]
     */
    function describe(snapshot, now = Date.now()) {
      const account = snapshot !== null && typeof snapshot === 'object' && snapshot.account !== null && typeof snapshot.account === 'object'
        ? snapshot.account
        : { state: 'loading', tone: 'unknown', ratio: 0, overflow: 0, symbol: '¥' }
      const task = snapshot !== null && typeof snapshot === 'object' && snapshot.task !== null && typeof snapshot.task === 'object'
        ? snapshot.task
        : null
      const symbol = typeof account.symbol === 'string' && account.symbol.length > 0 ? account.symbol : '¥'
      const state = typeof account.state === 'string' ? account.state : 'loading'
      const signedIn = state === 'signed-in'
      const known = signedIn && typeof account.total === 'number' && Number.isFinite(account.total)

      const chip = state === 'signed-out'
        ? '未登录账号'
        : state === 'unavailable'
          ? '余额不可用'
          : known ? symbol + formatAmount(account.total) : '读取中…'
      const value = known ? symbol + formatAmount(account.total) : chip

      const rows = []
      const notes = []
      let warning = null
      let link = null

      if (signedIn && task !== null) {
        if (task.kind === 'running') {
          rows.push({ label: '本任务已花', value: money(symbol, task.spentAmount), emphasis: false })
          rows.push({ label: '预计还需', value: range(symbol, task.remainingMin, task.remainingMax), emphasis: true })
          rows.push({ label: '估算依据', value: basisText(task), emphasis: false })
          if (task.insufficient === true) {
            warning = { level: 'error', text: '预计不足，缺口 ' + money(symbol, Math.max(0, Number(task.gap) || 0)) }
          } else if (task.risky === true) {
            const shortfall = (Number(task.remainingMax) || 0) - (Number(task.effectiveBalance) || 0)
            warning = { level: 'warning', text: '可能不足，最坏还差 ' + money(symbol, Math.max(0, shortfall)) }
          }
        } else {
          rows.push({ label: '下一任务预计', value: range(symbol, task.remainingMin, task.remainingMax), emphasis: true })
          rows.push({
            label: '取样',
            value: (Number(task.turnsSampled) || 1) + ' 轮',
            emphasis: false,
          })
          if (task.insufficient === true) warning = { level: 'warning', text: '下一任务可能跑不完' }
        }
        if (task.usageAvailable === false) rows.push({ label: '用量', value: '数据不可用', emphasis: false })
        rows.push({ label: '模型', value: (typeof task.model === 'string' && task.model.length > 0 ? task.model : '—') + (task.modelKnown === false ? '（未知模型）' : ''), emphasis: false })
        if (typeof task.subagents === 'number' && task.subagents > 0) {
          notes.push('另有 ' + task.subagents + ' 个子代理运行中，其消耗未计入预测')
        }
      }

      if (state === 'signed-out') notes.push('在 DSH 账号设置里登录后显示余额')
      if (state === 'unavailable') notes.push('未找到 DSH 账号服务，插件无法读取余额')

      if (account.error !== undefined) {
        notes.push('⚠ ' + account.error + '（' + relativeTime(account.errorAt, now) + '）')
      } else if (typeof account.fetchedAt === 'number' && account.fetchedAt > 0) {
        notes.push('更新于 ' + relativeTime(account.fetchedAt, now))
      }

      if (account.links !== null && typeof account.links === 'object') {
        const href = account.links.topUpUrl
        if (typeof href === 'string' && /^https?:\/\//i.test(href)) link = { href, label: '去充值' }
      }

      return {
        tone: typeof account.tone === 'string' ? account.tone : 'unknown',
        ratio: fraction(account.ratio),
        overflow: typeof account.overflow === 'number' && account.overflow > 0 ? account.overflow : 0,
        chip,
        value,
        marker: task !== null && task.insufficient === true,
        rows,
        warning,
        notes,
        link,
        state,
      }
    }

    /** The poll delay the snapshot asks for, floored while the tab is hidden. */
    function delayFor(snapshot) {
      if (typeof document !== 'undefined' && document.hidden === true) return Math.max(HIDDEN_POLL_MS, FIRST_POLL_MS)
      if (snapshot === null || typeof snapshot !== 'object') return FIRST_POLL_MS
      const config = snapshot.config !== null && typeof snapshot.config === 'object' ? snapshot.config : {}
      const running = snapshot.task !== null && typeof snapshot.task === 'object' && snapshot.task.kind === 'running'
      if (running) {
        const hint = Number(config.runningPollHintMs)
        return Number.isFinite(hint) && hint > 0 ? hint : FIRST_POLL_MS
      }
      const idle = Number(config.idlePollMs)
      return Number.isFinite(idle) && idle > 0 ? idle : FIRST_POLL_MS
    }

    /**
     * A sine surface spanning exactly two wavelengths, so a layer translated by
     * half its own width (`translateX(-50%)`) lands on the identical phase and
     * the loop is seamless.
     */
    function wavePath(period, height, amplitude, crestOnly) {
      const mid = height * 0.5
      const perCycle = 12
      const points = []
      for (let cycle = 0; cycle < 2; cycle += 1) {
        for (let index = 0; index <= perCycle; index += 1) {
          if (cycle > 0 && index === 0) continue
          const x = (cycle + index / perCycle) * period
          points.push('L ' + x.toFixed(2) + ' ' + (mid - amplitude * Math.sin((2 * Math.PI * index) / perCycle)).toFixed(2))
        }
      }
      const top = 'M ' + points[0].slice(2) + ' ' + points.slice(1).join(' ')
      return crestOnly ? top : top + ' L ' + (period * 2).toFixed(2) + ' ' + height + ' L 0 ' + height + ' Z'
    }

    /** Height in pixels the wave band occupies for one overflow amount. */
    function waveBandHeight(over) {
      return Math.round(Math.min(74, 22 + Math.sqrt(Math.max(0, over)) * 10))
    }

    /** One animated sine layer, stretched to the bar's width. */
    function Wave(props) {
      const height = 40
      const period = props.period
      return React.createElement('svg', {
        className: props.className,
        viewBox: '0 0 ' + (period * 2).toFixed(2) + ' ' + height,
        preserveAspectRatio: 'none',
        'aria-hidden': 'true',
      }, React.createElement('path', {
        d: wavePath(period, height, props.amplitude, props.crestOnly === true),
      }))
    }

    /** The bar, its chip, the static warning dot, and the hover card. */
    function BalanceGuard() {
      const [snapshot, setSnapshot] = React.useState(() => globalThis.__DSH_BALANCE_GUARD__ ?? null)
      const [open, setOpen] = React.useState(false)
      const [now, setNow] = React.useState(() => Date.now())
      const [fetchError, setFetchError] = React.useState(null)
      const snapshotRef = React.useRef(snapshot)
      snapshotRef.current = snapshot

      const load = React.useCallback(async () => {
        try {
          const params = new URLSearchParams()
          if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') params.set('locale', navigator.language)
          params.set('tz', String(-new Date().getTimezoneOffset() * 60))
          const boot = globalThis.__DSH_BOOT__
          if (boot !== null && typeof boot === 'object' && typeof boot.version === 'string') params.set('version', boot.version)
          const response = await fetch(STATE_ROUTE + '?' + params.toString(), { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const next = await response.json()
          if (next !== null && typeof next === 'object') {
            globalThis.__DSH_BALANCE_GUARD__ = next
            setSnapshot(next)
            setFetchError(null)
          }
        } catch (error) {
          setFetchError(String(error !== null && error !== undefined && error.message ? error.message : error))
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        let timer = 0
        const tick = () => {
          void load().finally(() => {
            if (!alive) return
            timer = setTimeout(tick, delayFor(snapshotRef.current))
          })
        }
        tick()
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [load])

      // The card prints relative times, so an open card needs a slow clock.
      React.useEffect(() => {
        if (!open) return undefined
        setNow(Date.now())
        const timer = setInterval(() => { setNow(Date.now()) }, 10_000)
        return () => { clearInterval(timer) }
      }, [open])

      const view = describe(snapshot, now)
      const symbol = snapshot !== null && typeof snapshot === 'object' && snapshot.account !== null && typeof snapshot.account === 'object' && typeof snapshot.account.symbol === 'string'
        ? snapshot.account.symbol
        : '¥'
      const wave = view.overflow > 0
        ? React.createElement('div', {
          className: 'dsh-bg-surface',
          style: { height: waveBandHeight(view.overflow) + 'px' },
        },
        React.createElement('div', { className: 'dsh-bg-glow' }),
        React.createElement(Wave, { className: 'dsh-bg-wave dsh-bg-wave--back', amplitude: 5, period: 30 }),
        React.createElement(Wave, { className: 'dsh-bg-wave', amplitude: 7, period: 20 }),
        React.createElement(Wave, { className: 'dsh-bg-wave dsh-bg-wave--crest', amplitude: 7, period: 20, crestOnly: true }))
        : null

      const activate = () => { void load() }
      const hover = {
        onMouseEnter: () => { setOpen(true); setNow(Date.now()) },
        onMouseLeave: () => { setOpen(false) },
        onFocus: () => { setOpen(true); setNow(Date.now()) },
        onBlur: () => { setOpen(false) },
      }
      const keys = {
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            activate()
          }
        },
      }

      const aria = view.state === 'signed-in'
        ? '账户余额 ' + view.value
        : view.chip

      const bar = React.createElement('div', {
        className: 'dsh-bg-root',
        'data-tone': view.tone,
        'data-open': open ? 'true' : undefined,
        ...hover,
      },
      React.createElement('div', {
        className: 'dsh-bg-bar',
        role: 'progressbar',
        tabIndex: 0,
        'aria-label': aria,
        'aria-valuemin': 0,
        'aria-valuemax': 50,
        'aria-valuenow': view.state === 'signed-in' && typeof snapshot.account.total === 'number'
          ? Math.min(snapshot.account.total, 50)
          : undefined,
        onClick: activate,
        ...keys,
      },
      React.createElement('div', {
        className: 'dsh-bg-fill',
        'data-tone': view.tone,
        style: { height: (view.ratio * 100).toFixed(2) + '%' },
      }),
      wave),
      React.createElement('div', {
        className: 'dsh-bg-label',
        onClick: activate,
        ...keys,
      },
      view.chip,
      view.marker === true
        ? React.createElement('span', {
          className: 'dsh-bg-marker',
          role: 'img',
          'aria-label': '预计余额不足',
        })
        : null))

      const card = open
        ? React.createElement('div', {
          className: 'dsh-bg-card',
          role: 'status',
          onMouseEnter: () => { setOpen(true) },
          onMouseLeave: () => { setOpen(false) },
          onClick: (event) => { event.stopPropagation() },
        },
        React.createElement('div', { className: 'dsh-bg-card-title' }, '账户余额'),
        React.createElement('div', { className: 'dsh-bg-card-value' }, view.value),
        view.rows.map(row => React.createElement('div', {
          className: 'dsh-bg-card-row',
          'data-emphasis': row.emphasis === true ? 'true' : undefined,
          key: row.label,
        },
        React.createElement('span', undefined, row.label),
        React.createElement('span', undefined, row.value))),
        view.warning !== null
          ? React.createElement('div', {
            className: 'dsh-bg-card-warning',
            'data-level': view.warning.level,
            key: 'warning',
          }, '⚠ ' + view.warning.text)
          : null,
        view.notes.map((note, index) => React.createElement('div', {
          className: 'dsh-bg-card-note',
          'data-error': note.startsWith('⚠') || note.startsWith('页面读取失败') ? 'true' : undefined,
          key: 'note-' + String(index),
        }, note)),
        fetchError !== null
          ? React.createElement('div', {
            className: 'dsh-bg-card-note',
            'data-error': 'true',
            key: 'fetch-error',
          }, '页面读取失败：' + fetchError)
          : null,
        view.link !== null
          ? React.createElement('div', { className: 'dsh-bg-card-actions' },
            React.createElement('a', {
              className: 'dsh-bg-link',
              href: view.link.href,
              target: '_blank',
              rel: 'noopener noreferrer',
              onClick: (event) => { event.stopPropagation() },
            }, view.link.label))
          : null,
        React.createElement('div', { className: 'dsh-bg-card-note', key: 'hint' }, '点击竖条立即刷新'))
        : null

      return React.createElement(React.Fragment, undefined, bar, card)
    }

    /**
     * Register the bar into the layout package's overlay list.
     * `ctx.slots.inject` waits for the declaration, reruns after a
     * redeclaration, and removes the contribution when this plugin unloads.
     */
    function apply(ctx) {
      ctx.effect(() => installStyles(), 'dsh-balance-guard: styles')
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'balance-guard',
        order: 51,
      }, BalanceGuard)), 'dsh-balance-guard: overlay registration')
    }

    return {
      name: 'dsh-balance-guard',
      inject: ['slots'],
      apply,
      // Test seam: the snapshot projection is the half a load-only smoke test
      // cannot see. Production loads never read the flag.
      ...globalThis.__DSH_BALANCE_GUARD_TEST__ === true
        ? {
          __internals: {
            describe,
            delayFor,
            formatAmount,
            money,
            range,
            relativeTime,
            basisText,
            wavePath,
            waveBandHeight,
            STYLE_ID,
          },
        }
        : {},
    }
  },
})

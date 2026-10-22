/**
 * Balance guard, browser half — v0.4 visual language.
 *
 * This file IS the client artifact: the DSH client module table loads it
 * through `window.__ModuleLoader__.load({ id, factory })`, the factory receives
 * the page's shared `require`, and the whole plugin is plain CommonJS with no
 * bundler step. `react` arrives from the shell's platform seed.
 *
 * The Host half owns every number and every threshold: tone, fill ratio,
 * overflow, amounts, warning level. This file only maps one snapshot onto the
 * shell's design language:
 *
 *   - a 4px rail pinned to the right edge, filled by the balance ratio;
 *   - a 20px chip (semantic dot + amount) that stays visible;
 *   - a 264px panel on hover (preview) or click (pinned).
 *
 * Every colour, radius, shadow and type size comes from the shipped `--dsw-*`
 * tokens; `scripts/visual-tokens.mjs` enforces that. The band colours are the
 * product rule, and they are the theme's own static palette entries.
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

    /** Retry delay when the first snapshot has not arrived yet. */
    const FIRST_POLL_MS = 2_000

    /** Hidden-tab poll floor; a background window does not need 1 Hz. */
    const HIDDEN_POLL_MS = 15_000

    /** Hover-close grace so the pointer can travel from rail to panel. */
    const CLOSE_GRACE_MS = 140

    const STYLES = `
.dsh-bg-root {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 0;
  pointer-events: none;
  z-index: 20;
  font-family: var(--dsw-font-family);
}
.dsh-bg-rail {
  position: absolute;
  top: 96px;
  bottom: 96px;
  right: 10px;
  width: 4px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l1);
  pointer-events: auto;
  cursor: pointer;
  transition: width 160ms ease, right 160ms ease;
}
.dsh-bg-rail:hover,
.dsh-bg-root[data-open='true'] .dsh-bg-rail {
  width: 6px;
  right: 9px;
}
.dsh-bg-rail:focus-visible {
  outline: 2px solid var(--dsw-alias-link);
  outline-offset: 3px;
}
.dsh-bg-fill {
  position: absolute;
  inset: auto 0 0 0;
  border-radius: 999px;
  transition: height 240ms ease;
}
.dsh-bg-root[data-tone='red'] .dsh-bg-fill { background: linear-gradient(to top, var(--dsw-static-red-600), var(--dsw-static-red-400)); }
.dsh-bg-root[data-tone='orange'] .dsh-bg-fill { background: linear-gradient(to top, var(--dsw-static-amber-500), var(--dsw-static-amber-400)); }
.dsh-bg-root[data-tone='green'] .dsh-bg-fill { background: linear-gradient(to top, var(--dsw-static-green-500), var(--dsw-static-green-400)); }
.dsh-bg-root[data-tone='blue'] .dsh-bg-fill { background: linear-gradient(to top, var(--dsw-static-deepseek-500), var(--dsw-static-deepseek-400)); }
.dsh-bg-root[data-tone='unknown'] .dsh-bg-fill { background: var(--dsw-static-neutral-bluish-400); }
.dsh-bg-chip {
  position: absolute;
  top: 50%;
  right: 22px;
  transform: translateY(-50%);
  height: 20px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-stroke), var(--dsw-elevation-panel);
  color: var(--dsw-alias-label-primary);
  font-size: 11px;
  line-height: 14px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: auto;
  cursor: pointer;
  transition: right 160ms ease;
}
.dsh-bg-root[data-open='true'] .dsh-bg-chip { right: 21px; }
.dsh-bg-chip:focus-visible {
  outline: 2px solid var(--dsw-alias-link);
  outline-offset: 2px;
}
.dsh-bg-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}
.dsh-bg-root[data-tone='red'] .dsh-bg-dot { background: var(--dsw-static-red-600); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-static-red-600) 16%, transparent); }
.dsh-bg-root[data-tone='orange'] .dsh-bg-dot { background: var(--dsw-static-amber-500); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-static-amber-500) 16%, transparent); }
.dsh-bg-root[data-tone='green'] .dsh-bg-dot { background: var(--dsw-static-green-500); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-static-green-500) 16%, transparent); }
.dsh-bg-root[data-tone='blue'] .dsh-bg-dot { background: var(--dsw-static-deepseek-500); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-static-deepseek-500) 16%, transparent); }
.dsh-bg-root[data-tone='unknown'] .dsh-bg-dot { background: var(--dsw-static-neutral-bluish-400); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-static-neutral-bluish-400) 16%, transparent); }
.dsh-bg-bang {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 2px;
  border-radius: 50%;
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-inverted);
  font-size: 11px;
  line-height: 1;
  font-weight: 600;
}
.dsh-bg-panel {
  position: fixed;
  right: 96px;
  top: 50%;
  transform: translateY(-50%);
  box-sizing: border-box;
  width: 264px;
  max-width: calc(100vw - 32px);
  padding: 14px 16px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-stroke), var(--dsw-elevation-panel);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
  pointer-events: auto;
}
.dsh-bg-panel[data-preview='true'] { pointer-events: none; }
.dsh-bg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  line-height: 14px;
  letter-spacing: .04em;
  color: var(--dsw-alias-label-secondary);
}
.dsh-bg-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--dsw-alias-label-tertiary);
  letter-spacing: 0;
}
.dsh-bg-hero {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.dsh-bg-meter {
  position: relative;
  height: 4px;
  margin: 8px 0 12px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l1);
  overflow: hidden;
}
.dsh-bg-meter-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  transition: width 240ms ease;
}
.dsh-bg-root[data-tone='red'] .dsh-bg-meter-fill { background: linear-gradient(to right, var(--dsw-static-red-600), var(--dsw-static-red-400)); }
.dsh-bg-root[data-tone='orange'] .dsh-bg-meter-fill { background: linear-gradient(to right, var(--dsw-static-amber-500), var(--dsw-static-amber-400)); }
.dsh-bg-root[data-tone='green'] .dsh-bg-meter-fill { background: linear-gradient(to right, var(--dsw-static-green-500), var(--dsw-static-green-400)); }
.dsh-bg-root[data-tone='blue'] .dsh-bg-meter-fill { background: linear-gradient(to right, var(--dsw-static-deepseek-500), var(--dsw-static-deepseek-400)); }
.dsh-bg-root[data-tone='unknown'] .dsh-bg-meter-fill { background: var(--dsw-static-neutral-bluish-400); }
.dsh-bg-scale {
  margin: -6px 0 10px;
  font-size: 11px;
  line-height: 14px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dsh-bg-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
}
.dsh-bg-col-label {
  font-size: 11px;
  line-height: 14px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-bg-col-value {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}
.dsh-bg-warning {
  margin-top: 10px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm);
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
}
.dsh-bg-warning[data-level='error'] {
  color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
}
.dsh-bg-warning[data-level='warning'] {
  color: var(--dsw-alias-state-warn-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
}
.dsh-bg-detail-toggle {
  margin-top: 10px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11px;
  line-height: 14px;
  cursor: pointer;
}
.dsh-bg-detail-toggle:hover { color: var(--dsw-alias-label-primary); }
.dsh-bg-detail-toggle:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 2px; border-radius: var(--dsw-radius-xs); }
.dsh-bg-detail {
  margin-top: 6px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-bg-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: .5px solid var(--dsw-alias-border-l2);
}
.dsh-bg-foot-note {
  min-width: 0;
  font-size: 11px;
  line-height: 14px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-bg-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.dsh-bg-btn {
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: none;
  color: var(--dsw-alias-link);
  font: inherit;
  font-size: 11px;
  line-height: 14px;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
.dsh-bg-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-bg-btn:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 1px; }
.dsh-bg-btn[disabled] { color: var(--dsw-alias-label-tertiary); cursor: default; background: none; }
.dsh-bg-skeleton {
  display: inline-block;
  width: 72px;
  height: 14px;
  border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-bg-skeleton);
}
@media (max-width: 960px) {
  .dsh-bg-chip { display: none; }
  .dsh-bg-rail { right: 6px; }
  .dsh-bg-panel { right: 12px; width: min(264px, calc(100vw - 24px)); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-bg-rail,
  .dsh-bg-chip,
  .dsh-bg-fill,
  .dsh-bg-meter-fill { transition: none; }
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

    /** The one-line estimate basis shown in the detail section. */
    function basisText(task) {
      if (task === null || typeof task !== 'object') return ''
      if (task.usageAvailable === false) return '用量数据不可用'
      const steps = typeof task.stepsExpected === 'number' ? task.stepsExpected : 0
      const hit = typeof task.cacheHit === 'number' ? Math.round(task.cacheHit * 100) : 0
      const hitSource = task.cacheHitSource === 'measured' ? '实测' : '默认'
      const period = task.peak === true ? '峰时价' : '谷时价'
      return steps + ' 步 · 缓存命中 ' + hit + '%（' + hitSource + '）· ' + period
    }

    /** The short status word next to the panel header. */
    function statusText(tone, insufficient) {
      if (insufficient === true) return '预计不足'
      if (tone === 'red') return '即将余额不足'
      if (tone === 'orange') return '建议充值'
      if (tone === 'green') return '余额正常'
      if (tone === 'blue') return '余额充足'
      return ''
    }

    /**
     * Project one Host snapshot onto the panel model.
     *
     * Pure and exported to the spec test. The rendering below is a direct map,
     * so copy, warning levels and the "what is shown when" rules are testable
     * without a DOM.
     *
     * @param {any} snapshot
     * @param {number} [now]
     * @param {string|null} [fetchError] last transport failure, if any
     */
    function describe(snapshot, now = Date.now(), fetchError = null) {
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
      const failed = typeof fetchError === 'string' && fetchError.length > 0
      const tone = typeof account.tone === 'string' ? account.tone : 'unknown'
      const insufficient = task !== null && task.insufficient === true

      const chip = state === 'signed-out'
        ? '未登录'
        : state === 'unavailable'
          ? '不可用'
          : known ? symbol + formatAmount(account.total) : failed ? '读取失败' : '读取中…'
      const hero = known ? symbol + formatAmount(account.total) : chip

      const columns = []
      const detail = []
      let warning = null
      let link = null

      if (signedIn && task !== null) {
        if (task.kind === 'running') {
          columns.push({ label: '本轮已花', value: money(symbol, task.spentAmount) })
          columns.push({ label: '预计还需', value: range(symbol, task.remainingMin, task.remainingMax) })
          if (task.insufficient === true) {
            warning = { level: 'error', text: '预计不足，缺口 ' + money(symbol, Math.max(0, Number(task.gap) || 0)) }
          } else if (task.risky === true) {
            const shortfall = (Number(task.remainingMax) || 0) - (Number(task.effectiveBalance) || 0)
            warning = { level: 'warning', text: '可能不足，最坏还差 ' + money(symbol, Math.max(0, shortfall)) }
          }
        } else {
          columns.push({ label: '下一任务预计', value: range(symbol, task.remainingMin, task.remainingMax) })
          columns.push({ label: '取样', value: (Number(task.turnsSampled) || 1) + ' 轮' })
          if (task.insufficient === true) warning = { level: 'warning', text: '下一任务可能跑不完' }
        }
        detail.push('估算依据：' + basisText(task))
        if (typeof task.model === 'string' && task.model.length > 0) {
          detail.push('模型：' + task.model + (task.modelKnown === false ? '（未知模型，按 deepseek-flash 估价）' : ''))
        }
        if (typeof task.subagents === 'number' && task.subagents > 0) {
          detail.push('另有 ' + task.subagents + ' 个子代理运行中，其消耗未计入预测')
        }
        if (task.usageAvailable === false) detail.push('用量数据不可用，本轮只显示余额')
      }

      if (state === 'signed-out') detail.push('在 DSH 账号设置里登录后显示余额')
      if (state === 'unavailable') detail.push('未找到 DSH 账号服务，插件无法读取余额')
      if (account.source === 'account') detail.push('余额来源：DSH 账号')
      if (account.error !== undefined) detail.push('⚠ ' + account.error + '（' + relativeTime(account.errorAt, now) + '）')

      if (account.links !== null && typeof account.links === 'object') {
        const href = account.links.topUpUrl
        if (typeof href === 'string' && /^https?:\/\//i.test(href)) link = { href, label: '去充值' }
      }

      const overflow = typeof account.overflow === 'number' && account.overflow > 0 ? account.overflow : 0
      const scaleLabel = overflow > 0
        ? '超刻度 ' + money(symbol, overflow) + ' · 50 为满刻度'
        : '50 为满刻度'

      let footnote = ''
      if (typeof account.fetchedAt === 'number' && account.fetchedAt > 0) {
        footnote = '更新于 ' + relativeTime(account.fetchedAt, now)
      }
      if (state === 'signed-out') footnote = '未登录账号'
      if (state === 'unavailable') footnote = '账号服务不可用'
      if (failed) footnote = '页面读取失败'

      return {
        tone,
        state,
        ratio: fraction(account.ratio),
        overflow,
        chip,
        hero,
        known,
        marker: insufficient,
        status: statusText(tone, insufficient),
        meter: known,
        scaleLabel: known ? scaleLabel : '',
        columns,
        warning,
        detail,
        footnote,
        link,
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

    /** The rail, the chip, and the preview/pinned panel. */
    function BalanceGuard() {
      const [snapshot, setSnapshot] = React.useState(() => globalThis.__DSH_BALANCE_GUARD__ ?? null)
      const [mode, setMode] = React.useState('idle') // idle | preview | pinned
      const [expanded, setExpanded] = React.useState(false)
      const [refreshing, setRefreshing] = React.useState(false)
      const [now, setNow] = React.useState(() => Date.now())
      const [fetchError, setFetchError] = React.useState(null)
      const snapshotRef = React.useRef(snapshot)
      const closeTimer = React.useRef(0)
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

      React.useEffect(() => {
        if (mode === 'idle') return undefined
        setNow(Date.now())
        const timer = setInterval(() => { setNow(Date.now()) }, 10_000)
        return () => { clearInterval(timer) }
      }, [mode])

      React.useEffect(() => {
        if (mode !== 'pinned') return undefined
        const onKey = (event) => { if (event.key === 'Escape') setMode('idle') }
        const onPointer = (event) => {
          const target = event.target
          if (target instanceof Element && target.closest('.dsh-bg-root, .dsh-bg-panel') !== null) return
          setMode('idle')
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onPointer, true)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onPointer, true)
        }
      }, [mode])

      const cancelClose = () => {
        if (closeTimer.current !== 0) {
          clearTimeout(closeTimer.current)
          closeTimer.current = 0
        }
      }
      const openPreview = () => {
        cancelClose()
        setMode(current => current === 'pinned' ? current : 'preview')
        setNow(Date.now())
      }
      const scheduleClose = () => {
        if (mode === 'pinned') return
        cancelClose()
        closeTimer.current = setTimeout(() => { setMode('idle') }, CLOSE_GRACE_MS)
      }
      const togglePinned = () => {
        cancelClose()
        setMode(current => current === 'pinned' ? 'idle' : 'pinned')
        setNow(Date.now())
      }
      const refresh = () => {
        setRefreshing(true)
        void load().finally(() => { setRefreshing(false) })
      }

      const view = describe(snapshot, now, fetchError)
      const open = mode !== 'idle'
      const pinned = mode === 'pinned'

      const rail = React.createElement('div', {
        className: 'dsh-bg-rail',
        role: 'progressbar',
        tabIndex: 0,
        'aria-label': view.known
          ? '账户余额 ' + view.hero + '，' + (view.status === '' ? '状态正常' : view.status)
          : view.chip,
        'aria-valuemin': 0,
        'aria-valuemax': 50,
        'aria-valuenow': view.known ? Math.min(Number(snapshot.account.total), 50) : undefined,
        onClick: togglePinned,
        onMouseEnter: openPreview,
        onMouseLeave: scheduleClose,
        onFocus: openPreview,
        onBlur: scheduleClose,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            togglePinned()
          }
        },
      }, React.createElement('div', {
        className: 'dsh-bg-fill',
        style: { height: (view.ratio * 100).toFixed(2) + '%' },
      }))

      const chip = React.createElement('div', {
        className: 'dsh-bg-chip',
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open ? 'true' : 'false',
        'aria-label': '账户余额 ' + view.hero,
        onClick: togglePinned,
        onMouseEnter: openPreview,
        onMouseLeave: scheduleClose,
        onFocus: openPreview,
        onBlur: scheduleClose,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            togglePinned()
          }
        },
      },
      React.createElement('span', { className: 'dsh-bg-dot', 'aria-hidden': 'true' }),
      React.createElement('span', undefined, view.chip),
      view.marker === true
        ? React.createElement('span', { className: 'dsh-bang', role: 'img', 'aria-label': '预计余额不足' }, '!')
        : null)

      const root = React.createElement('div', {
        className: 'dsh-bg-root',
        'data-tone': view.tone,
        'data-open': open ? 'true' : undefined,
      }, rail, chip)

      const panel = open
        ? React.createElement('div', {
          className: 'dsh-bg-panel',
          'data-preview': pinned ? undefined : 'true',
          role: pinned ? 'dialog' : 'status',
          'aria-label': '账户余额详情',
          onMouseEnter: cancelClose,
          onMouseLeave: scheduleClose,
          onClick: (event) => { event.stopPropagation() },
        },
        React.createElement('div', { className: 'dsh-bg-head' },
          React.createElement('span', undefined, '账户余额'),
          view.status === ''
            ? null
            : React.createElement('span', { className: 'dsh-bg-state' },
              React.createElement('span', { className: 'dsh-bg-dot', 'aria-hidden': 'true' }),
              view.status)),
        React.createElement('div', { className: 'dsh-bg-hero' },
          React.createElement('span', undefined, view.known ? view.hero : React.createElement('span', { className: 'dsh-bg-skeleton', 'aria-hidden': 'true' })),
          view.marker === true
            ? React.createElement('span', { className: 'dsh-bang', 'aria-hidden': 'true' }, '!')
            : null),
        view.meter
          ? React.createElement('div', {
            className: 'dsh-bg-meter',
            role: 'meter',
            'aria-valuemin': 0,
            'aria-valuemax': 50,
            'aria-valuenow': view.ratio * 50,
            'aria-label': '余额刻度',
          }, React.createElement('div', {
            className: 'dsh-bg-meter-fill',
            style: { width: (view.ratio * 100).toFixed(2) + '%' },
          }))
          : null,
        view.scaleLabel === ''
          ? null
          : React.createElement('div', { className: 'dsh-bg-scale' }, view.scaleLabel),
        view.columns.length === 0
          ? null
          : React.createElement('div', { className: 'dsh-bg-cols' },
            view.columns.map(column => React.createElement('div', { key: column.label },
              React.createElement('div', { className: 'dsh-bg-col-label' }, column.label),
              React.createElement('div', { className: 'dsh-bg-col-value' }, column.value)))),
        view.warning === null
          ? null
          : React.createElement('div', { className: 'dsh-bg-warning', 'data-level': view.warning.level }, '⚠ ' + view.warning.text),
        view.detail.length === 0
          ? null
          : React.createElement(React.Fragment, undefined,
            React.createElement('button', {
              type: 'button',
              className: 'dsh-bg-detail-toggle',
              'aria-expanded': expanded ? 'true' : 'false',
              onClick: () => { setExpanded(value => !value) },
            }, expanded ? '收起依据 ▴' : '估算依据 ▾'),
            expanded
              ? React.createElement('div', { className: 'dsh-bg-detail' },
                view.detail.map((line, index) => React.createElement('div', { key: 'd' + String(index) }, line)))
              : null),
        React.createElement('div', { className: 'dsh-bg-foot' },
          React.createElement('span', { className: 'dsh-bg-foot-note', title: view.footnote }, view.footnote),
          pinned
            ? React.createElement('span', { className: 'dsh-bg-actions' },
              React.createElement('button', {
                type: 'button',
                className: 'dsh-bg-btn',
                disabled: refreshing,
                onClick: refresh,
              }, refreshing ? '刷新中…' : '刷新'),
              view.link !== null
                ? React.createElement('a', {
                  className: 'dsh-bg-btn',
                  href: view.link.href,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                }, view.link.label)
                : null)
            : null))
        : null

      return React.createElement(React.Fragment, undefined, root, panel)
    }

    /**
     * Register the rail into the layout package's overlay list.
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
            statusText,
            STYLE_ID,
          },
        }
        : {},
    }
  },
})

/**
 * Client spec — the snapshot-to-pixels projection, pinned.
 *
 * Loads the real browser bundle through a stubbed `window.__ModuleLoader__`,
 * asks for its test seam, and asserts the v0.4 panel model: chip copy, status
 * word, columns, warning levels, the marker rule, detail lines and the poll
 * cadence. No DOM and no browser: the render path is a direct map of
 * `describe()`, so this is where the product copy is actually tested.
 *
 * Usage: node scripts/client-spec.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(HERE, '..')
const BUNDLE = join(PACKAGE_DIR, 'src', 'client.js')

let checks = 0
const failures = []

function check(label, actual, expected) {
  checks += 1
  if (!Object.is(actual, expected) && JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(label, condition) {
  checks += 1
  if (!condition) failures.push(`${label}: condition failed`)
}

function near(label, actual, expected, tolerance = 1e-9) {
  checks += 1
  if (!(Math.abs(actual - expected) <= tolerance)) failures.push(`${label}: expected ${expected}, got ${actual}`)
}

// --- load the bundle through the module-table contract -------------------
const registrations = []
globalThis.window = { __ModuleLoader__: { load: registration => registrations.push(registration) } }
globalThis.__DSH_BALANCE_GUARD_TEST__ = true
globalThis.document = { hidden: false }

await import(`${pathToFileURL(BUNDLE).href}?t=${Date.now()}`)
check('one bundle registration', registrations.length, 1)
check('bundle id', registrations[0].id, 'dsh-balance-guard')

const module = registrations[0].factory(name => {
  check('bundle imports react from the platform seed', name, 'react')
  return {
    createElement: () => ({}),
    Fragment: 'fragment',
    useState: () => [null, () => {}],
    useEffect: () => {},
    useCallback: callback => callback,
    useRef: value => ({ current: value }),
  }
})
check('module name', module.name, 'dsh-balance-guard')
check('injects the slot service', module.inject.includes('slots'), true)
check('apply is a function', typeof module.apply, 'function')
assert('test seam present', module.__internals !== undefined)

const { describe, delayFor, formatAmount, money, range, relativeTime, basisText, statusText } = module.__internals

// --- fixtures -----------------------------------------------------------
const NOW = 1_700_000_000_000
const LINKS = { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' }

const running = {
  updatedAt: NOW,
  account: {
    state: 'signed-in', currency: 'CNY', symbol: '¥',
    total: 12.34, normal: 10.34, bonus: 2,
    tone: 'orange', ratio: 12.34 / 50, overflow: 0,
    fetchedAt: NOW - 12_000, links: LINKS, source: 'account',
  },
  task: {
    kind: 'running', sessionId: 's1', title: 'demo', turn: 1,
    model: 'deepseek-flash', modelKnown: true, peak: true,
    stepsDone: 2, stepsExpected: 8, stepsSource: 'history',
    cacheHit: 0.95, cacheHitSource: 'measured',
    spentAmount: 0.32, remainingMin: 0.16, remainingExpected: 0.99, remainingMax: 3.35,
    requiredAmount: 3.19, gap: 2.09, effectiveBalance: 12.34,
    insufficient: true, risky: true, subagents: 1, usageAvailable: true,
  },
  config: { runningPollHintMs: 1_000, idlePollMs: 15_000, scaleLimit: 50 },
}

const runningView = describe(running, NOW)
check('running chip', runningView.chip, '¥12.34')
check('running hero', runningView.hero, '¥12.34')
check('running tone', runningView.tone, 'orange')
near('running ratio', runningView.ratio, 12.34 / 50)
check('running overflow', runningView.overflow, 0)
check('running marker', runningView.marker, true)
check('running status word', runningView.status, '预计不足')
check('running meter is shown', runningView.meter, true)
check('running scale label', runningView.scaleLabel, '50 为满刻度')
check('running columns', runningView.columns.map(column => column.label), ['本轮已花', '预计还需'])
check('spent column', runningView.columns[0].value, '¥0.32')
check('remaining column is a range', runningView.columns[1].value, '¥0.16 – ¥3.35')
check('warning level', runningView.warning.level, 'error')
check('warning text', runningView.warning.text, '预计不足，缺口 ¥2.09')
assert('basis detail present', runningView.detail.some(line => line.includes('8 步 · 缓存命中 95%（实测）· 峰时价')))
assert('model detail present', runningView.detail.some(line => line.includes('deepseek-flash')))
assert('subagent detail present', runningView.detail.some(line => line.includes('子代理')))
assert('source detail present', runningView.detail.some(line => line.includes('DSH 账号')))
check('footnote is relative freshness', runningView.footnote, '更新于 12 秒前')
check('top-up link href', runningView.link.href, LINKS.topUpUrl)
check('top-up link label', runningView.link.label, '去充值')

// Risky but not yet insufficient: amber copy, no marker.
const riskyView = describe({
  ...running,
  task: { ...running.task, insufficient: false, risky: true, effectiveBalance: 3.25, remainingMax: 3.35 },
}, NOW)
check('risky marker is off', riskyView.marker, false)
check('risky warning level', riskyView.warning.level, 'warning')
check('risky warning text', riskyView.warning.text, '可能不足，最坏还差 ¥0.10')

const comfortable = describe({
  ...running,
  task: { ...running.task, insufficient: false, risky: false, gap: undefined },
}, NOW)
check('comfortable warning', comfortable.warning, null)
check('comfortable marker', comfortable.marker, false)

// Idle: no live turn, next-task estimate only.
const idleView = describe({
  ...running,
  task: {
    kind: 'idle', sessionId: 's1', title: 'demo', model: 'deepseek-flash', modelKnown: true, peak: false,
    stepsDone: 0, stepsExpected: 6, stepsSource: 'history', cacheHit: 0.85, cacheHitSource: 'default',
    spentAmount: 0, remainingMin: 0.4, remainingExpected: 0.7, remainingMax: 1.1,
    insufficient: false, risky: false, subagents: 0, usageAvailable: true, turnsSampled: 3,
  },
}, NOW)
check('idle first column', idleView.columns[0].label, '下一任务预计')
check('idle range', idleView.columns[0].value, '¥0.40 – ¥1.10')
check('idle sample column', idleView.columns[1].value, '3 轮')
check('idle marker', idleView.marker, false)
check('idle warning', idleView.warning, null)

// Signed out: grey rail, no amount, no meter.
const signedOut = describe({
  updatedAt: NOW,
  account: { state: 'signed-out', currency: 'CNY', symbol: '¥', tone: 'unknown', ratio: 0, overflow: 0, fetchedAt: 0, links: LINKS },
  task: null,
  config: running.config,
}, NOW)
check('signed-out chip', signedOut.chip, '未登录')
check('signed-out hero', signedOut.hero, '未登录')
check('signed-out marker', signedOut.marker, false)
check('signed-out meter hidden', signedOut.meter, false)
check('signed-out footnote', signedOut.footnote, '未登录账号')
assert('signed-out explains itself', signedOut.detail.some(line => line.includes('登录')))

const unavailable = describe({
  updatedAt: NOW,
  account: { state: 'unavailable', currency: 'CNY', symbol: '¥', tone: 'unknown', ratio: 0, overflow: 0, fetchedAt: 0 },
  task: null,
  config: running.config,
}, NOW)
check('unavailable chip', unavailable.chip, '不可用')
assert('unavailable explains itself', unavailable.detail.some(line => line.includes('账号服务')))

const loading = describe(null, NOW)
check('loading chip', loading.chip, '读取中…')
check('loading tone', loading.tone, 'unknown')
check('loading marker', loading.marker, false)

// A dead transport must not read as an endless first load.
const deadTransport = describe(null, NOW, 'HTTP 500')
check('failed transport chip', deadTransport.chip, '读取失败')
check('failed transport footnote', deadTransport.footnote, '页面读取失败')

// Blue band: full rail, the overflow becomes copy instead of animation.
const blueView = describe({
  ...running,
  account: { ...running.account, total: 88, tone: 'blue', ratio: 1, overflow: 38 },
}, NOW)
check('blue tone', blueView.tone, 'blue')
check('blue ratio pinned to 1', blueView.ratio, 1)
check('blue overflow', blueView.overflow, 38)
check('blue scale label names the overflow', blueView.scaleLabel, '超刻度 ¥38.00 · 50 为满刻度')
check('blue status word', blueView.status, '预计不足')

// USD account keeps its own currency symbol.
const usdView = describe({
  ...running,
  account: { ...running.account, currency: 'USD', symbol: '$', total: 3.5 },
}, NOW)
check('usd chip', usdView.chip, '$3.50')
check('usd warning', usdView.warning.text, '预计不足，缺口 $2.09')

// Balance read failure keeps the last figure and says so.
const staleView = describe({
  ...running,
  account: { ...running.account, fetchedAt: NOW - 720_000, error: 'HTTP 500', errorAt: NOW - 60_000 },
}, NOW)
assert('stale detail carries the error', staleView.detail.some(line => line.includes('HTTP 500')))
check('stale chip keeps the amount', staleView.chip, '¥12.34')

// Missing usage data is reported instead of a fabricated projection.
const noUsage = describe({
  ...running,
  task: { ...running.task, usageAvailable: false, insufficient: false, risky: false },
}, NOW)
check('no-usage basis', noUsage.detail.some(line => line.includes('用量数据不可用')), true)

// --- formatting ---------------------------------------------------------
check('formatAmount two decimals', formatAmount(1.2), '1.20')
check('formatAmount missing', formatAmount(undefined), '—')
check('money dust', money('¥', 0.004), '<¥0.01')
check('money normal', money('¥', 1.2), '¥1.20')
check('money missing', money('¥', undefined), '¥—')
check('range collapses equal endpoints', range('¥', 1, 1), '¥1.00')
check('range spans endpoints', range('¥', 0.9, 2.3), '¥0.90 – ¥2.30')

check('relative fresh', relativeTime(NOW - 5_000, NOW), '刚刚')
check('relative seconds', relativeTime(NOW - 30_000, NOW), '30 秒前')
check('relative minutes', relativeTime(NOW - 120_000, NOW), '2 分钟前')
check('relative hours', relativeTime(NOW - 7_200_000, NOW), '2 小时前')
check('relative missing', relativeTime(0, NOW), '尚未获取')

check('basis measured peak', basisText({ stepsExpected: 8, cacheHit: 0.95, cacheHitSource: 'measured', peak: true }), '8 步 · 缓存命中 95%（实测）· 峰时价')
check('basis default off-peak', basisText({ stepsExpected: 6, cacheHit: 0.85, cacheHitSource: 'default', peak: false }), '6 步 · 缓存命中 85%（默认）· 谷时价')
check('basis no usage', basisText({ usageAvailable: false }), '用量数据不可用')

// --- status word --------------------------------------------------------
check('status red', statusText('red', false), '即将余额不足')
check('status orange', statusText('orange', false), '建议充值')
check('status green', statusText('green', false), '余额正常')
check('status blue', statusText('blue', false), '余额充足')
check('status insufficient wins', statusText('blue', true), '预计不足')
check('status unknown', statusText('unknown', false), '')

// --- cadence ------------------------------------------------------------
globalThis.document.hidden = false
check('running poll hint', delayFor(running), 1_000)
check('idle poll', delayFor({ ...running, task: { ...running.task, kind: 'idle' } }), 15_000)
check('first poll without a snapshot', delayFor(null), 2_000)
globalThis.document.hidden = true
check('hidden tab slows down', delayFor(running), 15_000)
globalThis.document.hidden = false

// --- stylesheet rules ---------------------------------------------------
const source = readFileSync(BUNDLE, 'utf8')
for (const tone of ['red', 'orange', 'green', 'blue']) {
  assert(`stylesheet has the ${tone} fill`, source.includes(`[data-tone='${tone}'] .dsh-bg-fill`))
  assert(`stylesheet has the ${tone} meter`, source.includes(`[data-tone='${tone}'] .dsh-bg-meter-fill`))
}
assert('stylesheet paints the rail', source.includes('.dsh-bg-rail'))
assert('stylesheet paints the chip', source.includes('.dsh-bg-chip'))
assert('stylesheet paints the warning badge', source.includes('.dsh-bg-bang'))
assert('stylesheet styles the actions', source.includes('.dsh-bg-btn'))
assert('stylesheet honours reduced motion', source.includes('prefers-reduced-motion'))
assert('stylesheet has no infinite animation', !/animation\s*:\s*[^;]*infinite/.test(source))
assert('value chip is never vertical', !/writing-mode\s*:\s*vertical/.test(source))

if (failures.length > 0) {
  console.error(`\n[client-spec] ${failures.length} of ${checks} checks failed:`)
  for (const failure of failures) console.error('  -', failure)
  process.exit(1)
}
console.log(`[client-spec] ${checks} checks passed`)

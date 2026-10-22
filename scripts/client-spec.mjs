/**
 * Client spec — the snapshot-to-pixels projection, pinned.
 *
 * Loads the real browser bundle through a stubbed `window.__ModuleLoader__`,
 * asks for its test seam, and asserts the copy, the warning levels, the marker
 * rule, the poll cadence and the wave geometry. No DOM and no browser: the
 * render path is a direct map of `describe()`, so this is where the product
 * copy is actually tested.
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

const { describe, delayFor, formatAmount, money, range, relativeTime, basisText, wavePath, waveBandHeight } = module.__internals

// --- fixtures -----------------------------------------------------------
const NOW = 1_700_000_000_000
const LINKS = { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' }

const running = {
  updatedAt: NOW,
  account: {
    state: 'signed-in', currency: 'CNY', symbol: '¥',
    total: 12.34, normal: 10.34, bonus: 2,
    tone: 'orange', ratio: 12.34 / 50, overflow: 0,
    fetchedAt: NOW - 12_000, links: LINKS,
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
check('running value', runningView.value, '¥12.34')
check('running tone', runningView.tone, 'orange')
near('running ratio', runningView.ratio, 12.34 / 50)
check('running overflow', runningView.overflow, 0)
check('running marker', runningView.marker, true)
check('running row labels', runningView.rows.map(row => row.label), ['本任务已花', '预计还需', '估算依据', '模型'])
check('spent row', runningView.rows[0].value, '¥0.32')
check('remaining row is a range', runningView.rows[1].value, '¥0.16 – ¥3.35')
check('basis names the measured cache hit', runningView.rows[2].value, '8 步 · 缓存命中 95%（实测）· 峰时价')
check('warning level', runningView.warning.level, 'error')
check('warning text', runningView.warning.text, '预计不足，缺口 ¥2.09')
assert('subagent note present', runningView.notes.some(note => note.includes('子代理')))
assert('freshness note present', runningView.notes.some(note => note.startsWith('更新于')))
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
check('idle first row', idleView.rows[0].label, '下一任务预计')
check('idle range', idleView.rows[0].value, '¥0.40 – ¥1.10')
check('idle sample row', idleView.rows[1].value, '3 轮')
check('idle marker', idleView.marker, false)
check('idle warning', idleView.warning, null)

// Signed out: grey bar, no amount, no prediction.
const signedOut = describe({
  updatedAt: NOW,
  account: { state: 'signed-out', currency: 'CNY', symbol: '¥', tone: 'unknown', ratio: 0, overflow: 0, fetchedAt: 0, links: LINKS },
  task: null,
  config: running.config,
}, NOW)
check('signed-out chip', signedOut.chip, '未登录账号')
check('signed-out value', signedOut.value, '未登录账号')
check('signed-out marker', signedOut.marker, false)
assert('signed-out explains itself', signedOut.notes.some(note => note.includes('登录')))

const unavailable = describe({
  updatedAt: NOW,
  account: { state: 'unavailable', currency: 'CNY', symbol: '¥', tone: 'unknown', ratio: 0, overflow: 0, fetchedAt: 0 },
  task: null,
  config: running.config,
}, NOW)
check('unavailable chip', unavailable.chip, '余额不可用')
assert('unavailable explains itself', unavailable.notes.some(note => note.includes('账号服务')))

const loading = describe(null, NOW)
check('loading chip', loading.chip, '读取中…')
check('loading tone', loading.tone, 'unknown')
check('loading marker', loading.marker, false)

// A dead transport must not read as an endless first load.
const deadTransport = describe(null, NOW, 'HTTP 500')
check('failed transport chip', deadTransport.chip, '读取失败')
check('failed transport value', deadTransport.value, '读取失败')

// Blue band: whole bar blue, wave above the scale.
const blueView = describe({
  ...running,
  account: { ...running.account, total: 88, tone: 'blue', ratio: 1, overflow: 38 },
}, NOW)
check('blue tone', blueView.tone, 'blue')
check('blue ratio pinned to 1', blueView.ratio, 1)
check('blue overflow', blueView.overflow, 38)

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
assert('stale note carries the error', staleView.notes.some(note => note.includes('HTTP 500')))
check('stale chip keeps the amount', staleView.chip, '¥12.34')

// The card names where the number came from.
const accountView = describe({ ...running, account: { ...running.account, source: 'account' } }, NOW)
assert('account source is named', accountView.notes.some(note => note.includes('DSH 账号')))

// Missing usage data is reported instead of a fabricated projection.
const noUsage = describe({
  ...running,
  task: { ...running.task, usageAvailable: false, insufficient: false, risky: false },
}, NOW)
check('no-usage basis', noUsage.rows[2].value, '用量数据不可用')
assert('no-usage row', noUsage.rows.some(row => row.label === '用量'))

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

// --- cadence ------------------------------------------------------------
globalThis.document.hidden = false
check('running poll hint', delayFor(running), 1_000)
check('idle poll', delayFor({ ...running, task: { ...running.task, kind: 'idle' } }), 15_000)
check('first poll without a snapshot', delayFor(null), 2_000)
globalThis.document.hidden = true
check('hidden tab slows down', delayFor(running), 15_000)
globalThis.document.hidden = false

// --- wave geometry ------------------------------------------------------
const wave = wavePath(20, 40, 7, false)
assert('wave starts at the left edge', wave.startsWith('M 0.00 20.00'))
assert('wave spans two whole periods', wave.includes('L 40.00 20.00'))
assert('wave closes its phase so the loop is seamless', wave.endsWith('Z'))
assert('wave has no NaN', !wave.includes('NaN'))
const crest = wavePath(20, 40, 7, true)
assert('crest is an open line', !crest.endsWith('Z'))
assert('crest ends on the same phase it started', crest.includes('L 40.00 20.00'))

check('wave height at zero overflow', waveBandHeight(0), 22)
check('wave height grows then clamps', waveBandHeight(300), 74)
assert('wave height is monotonic', waveBandHeight(10) <= waveBandHeight(40) && waveBandHeight(40) <= waveBandHeight(300))

// --- stylesheet rules ---------------------------------------------------
const source = readFileSync(BUNDLE, 'utf8')
for (const tone of ['red', 'orange', 'green', 'blue']) {
  assert(`stylesheet has the ${tone} fill`, source.includes(`.dsh-bg-fill[data-tone='${tone}']`))
}
assert('stylesheet paints the marker dot', source.includes('.dsh-bg-marker'))
assert('stylesheet styles the top-up link', source.includes('.dsh-bg-link'))
assert('stylesheet honours reduced motion', source.includes('prefers-reduced-motion'))
assert('value chip is never vertical', !/writing-mode\s*:\s*vertical/.test(source))

if (failures.length > 0) {
  console.error(`\n[client-spec] ${failures.length} of ${checks} checks failed:`)
  for (const failure of failures) console.error('  -', failure)
  process.exit(1)
}
console.log(`[client-spec] ${checks} checks passed`)

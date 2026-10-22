/**
 * Policy spec — the pure rules, pinned.
 *
 * Plain Node, no framework. Every assertion here is a product decision:
 * band boundaries, the peak/off-peak calendar, the official price catalog, the
 * estimator arithmetic (including the worked example in DESIGN.md §5.4) and
 * the shortfall judgment. If a threshold or a price changes, this file fails
 * until the change is intentional.
 *
 * Usage: node scripts/policy-spec.mjs
 */

import {
  DEFAULT_FX, MIN_RESERVE, PRICE_TABLE, SAFETY_RATIO, SCALE_LIMIT,
  addUsage, clamp, costOfUsage, emptyUsage, estimateTask, hitRatioOf, isPeak,
  judge, normalizeUsage, pickCurrency, priceFor, scaleOf, stepCostUsd,
  symbolOf, toDisplayCurrency, toneOf, usageDelta, walletSum,
} from '../src/policy.js'

let checks = 0
const failures = []

/** Assert one expected value. */
function check(label, actual, expected, tolerance) {
  checks += 1
  const ok = tolerance === undefined
    ? Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected)
    : Math.abs(actual - expected) <= tolerance
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** Assert a plain truthy condition. */
function assert(label, condition) {
  checks += 1
  if (!condition) failures.push(`${label}: condition failed`)
}

/** Assert two numbers within a tolerance. */
function near(label, actual, expected, tolerance = 1e-9) {
  check(label, actual, expected, tolerance)
}

// --- colour bands -------------------------------------------------------
check('tone 9.99', toneOf(9.99), 'red')
check('tone 10', toneOf(10), 'orange')
check('tone 29.99', toneOf(29.99), 'orange')
check('tone 30', toneOf(30), 'green')
check('tone 50', toneOf(50), 'green')
check('tone 50.01', toneOf(50.01), 'blue')
check('tone unknown', toneOf(Number.NaN), 'unknown')
check('tone undefined', toneOf(undefined), 'unknown')

const low = scaleOf(9)
near('scale 9 ratio', low.ratio, 9 / SCALE_LIMIT)
check('scale 9 overflow', low.overflow, 0)
const over = scaleOf(60)
check('scale 60 ratio', over.ratio, 1)
check('scale 60 overflow', over.overflow, 10)
check('scale 60 tone', over.tone, 'blue')

// --- peak / off-peak calendar ------------------------------------------
const monday = Date.UTC(2026, 9, 19, 2, 0, 0)
check('2026-10-19 is a Monday', new Date(Date.UTC(2026, 9, 19)).getUTCDay(), 1)
check('peak: Mon 02:00 UTC', isPeak(monday), true)
check('off-peak: Mon 05:00 UTC', isPeak(Date.UTC(2026, 9, 19, 5, 0, 0)), false)
check('off-peak: Mon 00:59 UTC', isPeak(Date.UTC(2026, 9, 19, 0, 59, 0)), false)
check('peak window start 01:00', isPeak(Date.UTC(2026, 9, 19, 1, 0, 0)), true)
check('peak window end 04:00 exclusive', isPeak(Date.UTC(2026, 9, 19, 4, 0, 0)), false)
check('peak window 06:00', isPeak(Date.UTC(2026, 9, 19, 6, 0, 0)), true)
check('peak window end 10:00 exclusive', isPeak(Date.UTC(2026, 9, 19, 10, 0, 0)), false)
check('off-peak: Saturday 02:00 UTC', isPeak(Date.UTC(2026, 9, 17, 2, 0, 0)), false)
check('off-peak: configured holiday', isPeak(monday, ['2026-10-19']), false)

// --- price catalog ------------------------------------------------------
near('flash peak cache hit', PRICE_TABLE['deepseek-flash'].peak.cacheHit, 0.006)
near('flash peak cache miss', PRICE_TABLE['deepseek-flash'].peak.cacheMiss, 0.3)
near('flash peak output', PRICE_TABLE['deepseek-flash'].peak.output, 1.2)
near('flash off-peak cache hit', PRICE_TABLE['deepseek-flash'].offPeak.cacheHit, 0.003)
near('pro peak cache miss', PRICE_TABLE['deepseek-v4-pro'].peak.cacheMiss, 1.32)
near('pro off-peak output', PRICE_TABLE['deepseek-v4-pro'].offPeak.output, 1.98)

const flashPeak = priceFor('deepseek-flash', true)
check('priceFor known model', flashPeak.known, true)
near('priceFor peak miss', flashPeak.cacheMiss, 0.3)
const unknownModel = priceFor('some-other-model', false)
check('priceFor unknown falls back', unknownModel.model, 'deepseek-flash')
check('priceFor unknown reports not known', unknownModel.known, false)
near('priceFor unknown uses off-peak row', unknownModel.cacheMiss, 0.15)

// --- usage buckets ------------------------------------------------------
const sample = { uncachedInputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0, outputTokens: 5 }
near('hit ratio measured', hitRatioOf(sample, 0.85), 0.9)
near('hit ratio fallback', hitRatioOf(emptyUsage(), 0.85), 0.85)
near('hit ratio clamps at 0.98', hitRatioOf({ ...emptyUsage(), cacheReadTokens: 1000, uncachedInputTokens: 1 }, 0.85), 0.98)

const delta = usageDelta({ uncachedInputTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 7 }, { uncachedInputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 2 })
near('usage delta uncached', delta.uncachedInputTokens, 20)
near('usage delta clamps negative', delta.cacheReadTokens, 0)
near('usage delta output', delta.outputTokens, 5)

near('addUsage output', addUsage(emptyUsage(), { uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 }).outputTokens, 4)
near('normalizeUsage rejects nonsense', normalizeUsage({ uncachedInputTokens: 'nope', outputTokens: -5 }).outputTokens, 0)
near('clamp NaN', clamp(Number.NaN, 0, 1), 0)

// --- billing arithmetic -------------------------------------------------
const millionEach = { uncachedInputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6, outputTokens: 1e6 }
near('cost of 1M each at flash peak', costOfUsage(millionEach, PRICE_TABLE['deepseek-flash'].peak), 0.006 + 0.3 + 0.3 + 1.2)

// stepCostUsd is the single-step building block; the k-th prompt grows by the
// configured per-step growth, and the output side stays flat.
const shape = { promptTokens: 350_000, growthTokens: 25_000, outputPerStep: 12_000, hit: 0.95, price: PRICE_TABLE['deepseek-flash'].peak }
near('step cost k=1', stepCostUsd({ ...shape, k: 1 }), 0.021645)
near('step cost k=2', stepCostUsd({ ...shape, k: 2 }), 0.0221625)

// --- DESIGN.md §5.4 worked example --------------------------------------
const peak = PRICE_TABLE['deepseek-flash'].peak
const example = estimateTask({
  usage: { uncachedInputTokens: 30_000, cacheReadTokens: 900_000, cacheWriteTokens: 0, outputTokens: 25_000 },
  baseline: emptyUsage(),
  price: peak,
  peakPrice: peak,
  promptTokens: 350_000,
  growthTokens: 25_000,
  outputPerStep: 12_000,
  cacheHit: 0.95,
  remainingSteps: 6,
})
near('example spent USD', example.spentUsd, 0.0444)
near('example remaining min USD', example.remainingMinUsd, 0.021645)
near('example remaining expected USD', example.remainingExpectedUsd, 0.1376325)
near('example remaining max USD', example.remainingMaxUsd, 0.465885)
near('example total expected USD', example.totalExpectedUsd, 0.1820325)
check('example steps', example.steps, 6)
check('example max steps', example.maxSteps, 12)

// The range must stay ordered for any sane input.
const rangeShape = {
  usage: { uncachedInputTokens: 1_000, cacheReadTokens: 2_000, cacheWriteTokens: 0, outputTokens: 500 },
  baseline: emptyUsage(),
  price: peak,
  peakPrice: peak,
  promptTokens: 100_000,
  growthTokens: 10_000,
  outputPerStep: 3_000,
  cacheHit: 0.8,
  remainingSteps: 4,
}
const ordered = estimateTask(rangeShape)
assert('min <= expected', ordered.remainingMinUsd <= ordered.remainingExpectedUsd)
assert('expected <= max', ordered.remainingExpectedUsd <= ordered.remainingMaxUsd)
const longer = estimateTask({ ...rangeShape, remainingSteps: 8 })
assert('more steps cost more', longer.remainingExpectedUsd > ordered.remainingExpectedUsd)
const moreOutput = estimateTask({ ...rangeShape, outputPerStep: 6_000 })
assert('more output costs more', moreOutput.remainingExpectedUsd > ordered.remainingExpectedUsd)
const worseHit = estimateTask({ ...rangeShape, cacheHit: 0.2 })
assert('worse cache hit costs more', worseHit.remainingExpectedUsd > ordered.remainingExpectedUsd)

// A step always costs something: min must never collapse to zero.
assert('min is positive', ordered.remainingMinUsd > 0)

// --- shortfall judgment -------------------------------------------------
const verdict = judge({ balance: 1.1, remainingExpected: 0.990954, remainingMax: 3.354372, safetyRatio: SAFETY_RATIO, minReserve: MIN_RESERVE })
near('required = expected*1.2 + 2', verdict.required, 0.990954 * 1.2 + 2)
assert('insufficient when balance is short', verdict.insufficient === true)
near('gap is positive', verdict.gap, verdict.required - 1.1)
assert('risky when worst case exceeds balance', verdict.risky === true)

const comfortable = judge({ balance: 10, remainingExpected: 1, remainingMax: 2 })
assert('comfortable balance is sufficient', comfortable.insufficient === false)
assert('comfortable balance is not risky', comfortable.risky === false)

const exact = judge({ balance: 1 * 1.2 + 2, remainingExpected: 1, remainingMax: 2 })
assert('equality still counts as insufficient', exact.insufficient === true)

const lagged = judge({ balance: 5, lag: 4, remainingExpected: 1, remainingMax: 2 })
near('lag subtracts from the balance', lagged.effectiveBalance, 1)
assert('lag can flip the verdict', lagged.insufficient === true)

// --- wallet projection --------------------------------------------------
const wallets = [{ currency: 'CNY', balance: '12.3' }, { currency: 'CNY', balance: '0.04' }, { currency: 'USD', balance: '9' }]
near('walletSum CNY', walletSum(wallets, 'CNY'), 12.34)
near('walletSum ignores other currencies', walletSum(wallets, 'USD'), 9)
near('walletSum tolerates malformed', walletSum([{ currency: 'CNY', balance: 'x' }], 'CNY'), 0)
check('pickCurrency prefers CNY', pickCurrency(wallets), 'CNY')
check('pickCurrency falls back to first', pickCurrency([{ currency: 'USD', balance: '1' }]), 'USD')
check('pickCurrency default', pickCurrency([]), 'CNY')
check('symbol CNY', symbolOf('CNY'), '¥')
check('symbol USD', symbolOf('USD'), '$')
near('toDisplayCurrency CNY', toDisplayCurrency(1, 'CNY', DEFAULT_FX), DEFAULT_FX)
near('toDisplayCurrency USD', toDisplayCurrency(1, 'USD', DEFAULT_FX), 1)

if (failures.length > 0) {
  console.error(`\n[policy-spec] ${failures.length} of ${checks} checks failed:`)
  for (const failure of failures) console.error('  -', failure)
  process.exit(1)
}
console.log(`[policy-spec] ${checks} checks passed`)

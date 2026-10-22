/**
 * Balance-guard policy — the one source of truth for everything a number
 * decides: the colour bands, the DeepSeek price catalog, peak/off-peak
 * classification, the task-cost estimator, and the "will this turn run out of
 * balance" judgment.
 *
 * It is pure ESM on purpose. The Host half imports it at runtime, this file is
 * what `scripts/policy-spec.mjs` loads with plain Node, and the browser half
 * receives only *computed* values (tone, ratio, amounts) so no threshold is
 * duplicated into the page. If a rule changes here, the bar follows.
 *
 * Prices: DeepSeek official list price, USD per 1M tokens, fetched 2026-10-17
 * from https://api-docs.deepseek.com/quick_start/pricing/ . Off-peak is half
 * of peak; peak runs Monday–Friday 01:00–04:00 and 06:00–10:00 UTC, excluding
 * Chinese public holidays. `scripts/policy-spec.mjs` pins these figures, so a
 * price edit is a deliberate two-file change instead of a silent drift.
 */

/** Bar scale in the account currency: the fill tops out here. */
export const SCALE_LIMIT = 50

/** Upper bound of the red band (exclusive). */
export const RED_LIMIT = 10

/** Upper bound of the orange band (exclusive). */
export const ORANGE_LIMIT = 30

/** Multiplier applied to the expected remaining cost before declaring a shortfall. */
export const SAFETY_RATIO = 0.2

/** Amount that must remain untouched even when the estimate says the task fits. */
export const MIN_RESERVE = 2

/** Default CNY per USD; the price catalog is quoted in USD. */
export const DEFAULT_FX = 7.2

/** Never project more than this many remaining steps. */
export const MAX_STEPS = 60

/** Model whose prices are used when the routed model is not in the catalog. */
export const FALLBACK_MODEL = 'deepseek-flash'

/** Peak windows in UTC hours, `[from, to)`. */
export const PEAK_UTC_WINDOWS = Object.freeze([Object.freeze([1, 4]), Object.freeze([6, 10])])

/**
 * Official list prices, USD per 1M tokens.
 * @type {Readonly<Record<string, { peak: { cacheHit: number, cacheMiss: number, output: number }, offPeak: { cacheHit: number, cacheMiss: number, output: number } }>>}
 */
export const PRICE_TABLE = Object.freeze({
  'deepseek-flash': Object.freeze({
    peak: Object.freeze({ cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }),
    offPeak: Object.freeze({ cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }),
  }),
  'deepseek-v4-pro': Object.freeze({
    peak: Object.freeze({ cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }),
    offPeak: Object.freeze({ cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 }),
  }),
})

/**
 * A four-bucket usage sample. The first three buckets are disjoint parts of
 * the prompt side; `outputTokens` includes reasoning tokens.
 * @typedef {{ uncachedInputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number }} UsageBuckets
 */

/** @returns {UsageBuckets} a fresh all-zero sample. */
export function emptyUsage() {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
}

/**
 * Coerce anything shaped like a usage sample into non-negative integers.
 * Unknown or malformed members read as zero rather than NaN.
 * @param {unknown} value
 * @returns {UsageBuckets}
 */
export function normalizeUsage(value) {
  const record = value !== null && typeof value === 'object' ? value : {}
  /** @param {unknown} candidate */
  const count = candidate => {
    const parsed = typeof candidate === 'number' ? candidate : Number(candidate)
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
  }
  return {
    uncachedInputTokens: count(record.uncachedInputTokens),
    cacheReadTokens: count(record.cacheReadTokens),
    cacheWriteTokens: count(record.cacheWriteTokens),
    outputTokens: count(record.outputTokens),
  }
}

/**
 * Per-bucket difference, never negative. A shrunken projection (unlikely but
 * cheap to survive) cannot make the bar report negative spend.
 * @param {UsageBuckets} current
 * @param {UsageBuckets} baseline
 * @returns {UsageBuckets}
 */
export function usageDelta(current, baseline) {
  const now = normalizeUsage(current)
  const then = normalizeUsage(baseline)
  return {
    uncachedInputTokens: Math.max(0, now.uncachedInputTokens - then.uncachedInputTokens),
    cacheReadTokens: Math.max(0, now.cacheReadTokens - then.cacheReadTokens),
    cacheWriteTokens: Math.max(0, now.cacheWriteTokens - then.cacheWriteTokens),
    outputTokens: Math.max(0, now.outputTokens - then.outputTokens),
  }
}

/**
 * Sum two usage samples.
 * @param {UsageBuckets} left
 * @param {UsageBuckets} right
 * @returns {UsageBuckets}
 */
export function addUsage(left, right) {
  const a = normalizeUsage(left)
  const b = normalizeUsage(right)
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}

/** Clamp a number into `[min, max]`, mapping NaN to `min`. */
export function clamp(value, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return min
  return parsed < min ? min : parsed > max ? max : parsed
}

/**
 * Measured cache-hit share of the prompt side.
 * @param {UsageBuckets} usage
 * @param {number} fallback used when the sample has no prompt tokens at all
 */
export function hitRatioOf(usage, fallback) {
  const sample = normalizeUsage(usage)
  const input = sample.cacheReadTokens + sample.cacheWriteTokens + sample.uncachedInputTokens
  if (input <= 0) return clamp(fallback, 0, 0.98)
  return clamp(sample.cacheReadTokens / input, 0, 0.98)
}

/**
 * The colour band for one balance. Boundaries are deliberate: 10 is orange,
 * 30 is green, 50 is still green — blue starts above the scale.
 * @param {number | undefined} total
 * @returns {'red' | 'orange' | 'green' | 'blue' | 'unknown'}
 */
export function toneOf(total) {
  if (typeof total !== 'number' || !Number.isFinite(total)) return 'unknown'
  if (total < RED_LIMIT) return 'red'
  if (total < ORANGE_LIMIT) return 'orange'
  if (total <= SCALE_LIMIT) return 'green'
  return 'blue'
}

/**
 * Everything the bar needs from one amount: tone, fill ratio, and the yuan
 * above the scale that becomes the wave.
 * @param {number | undefined} total
 */
export function scaleOf(total) {
  const known = typeof total === 'number' && Number.isFinite(total)
  return {
    tone: toneOf(total),
    ratio: known ? clamp(total / SCALE_LIMIT, 0, 1) : 0,
    overflow: known ? Math.max(0, total - SCALE_LIMIT) : 0,
    known,
  }
}

/**
 * Whether one instant falls in a peak window. `holidays` holds UTC dates
 * (`YYYY-MM-DD`) that DeepSeek bills at off-peak all day.
 * @param {number} momentMs
 * @param {readonly string[]} [holidays]
 */
export function isPeak(momentMs, holidays = []) {
  const moment = new Date(momentMs)
  const day = moment.getUTCDay()
  if (day === 0 || day === 6) return false
  const date = moment.toISOString().slice(0, 10)
  if (holidays.includes(date)) return false
  const hour = moment.getUTCHours()
  for (const [from, to] of PEAK_UTC_WINDOWS) if (hour >= from && hour < to) return true
  return false
}

/**
 * The price row for one routed model and period. Unknown models fall back to
 * `deepseek-flash` and report `known: false` so the card can say so.
 * @param {string | undefined} model
 * @param {boolean} peak
 */
export function priceFor(model, peak) {
  const name = typeof model === 'string' ? model : ''
  const entry = PRICE_TABLE[name]
  const price = (entry ?? PRICE_TABLE[FALLBACK_MODEL])[peak ? 'peak' : 'offPeak']
  return {
    model: entry === undefined ? FALLBACK_MODEL : name,
    requested: name,
    known: entry !== undefined,
    peak,
    cacheHit: price.cacheHit,
    cacheMiss: price.cacheMiss,
    output: price.output,
  }
}

/**
 * Billed cost of one usage sample in USD.
 * @param {UsageBuckets} usage
 * @param {{ cacheHit: number, cacheMiss: number, output: number }} price
 */
export function costOfUsage(usage, price) {
  const sample = normalizeUsage(usage)
  const hit = price.cacheHit
  const miss = price.cacheMiss
  return (
    sample.uncachedInputTokens * miss +
    sample.cacheReadTokens * hit +
    sample.cacheWriteTokens * miss +
    sample.outputTokens * price.output
  ) / 1e6
}

/**
 * Cost of the k-th future step in USD: its prompt is `promptTokens` grown by
 * `growthTokens` per step, its output is `outputPerStep`.
 * @param {{ promptTokens: number, growthTokens: number, outputPerStep: number, hit: number, price: { cacheHit: number, cacheMiss: number, output: number }, k: number }} input
 */
export function stepCostUsd(input) {
  const prompt = Math.max(0, input.promptTokens) + Math.max(0, input.k - 1) * Math.max(0, input.growthTokens)
  const hit = clamp(input.hit, 0, 0.98)
  const promptCostPerToken = hit * input.price.cacheHit + (1 - hit) * input.price.cacheMiss
  return (prompt * promptCostPerToken + Math.max(0, input.outputPerStep) * input.price.output) / 1e6
}

/**
 * Project the whole task: what it already spent plus a range for what is left.
 *
 * - `remainingMin` is one more step (a task can never finish for zero).
 * - `remainingExpected` walks `remainingSteps` steps at the measured cache-hit
 *   rate and current period price.
 * - `remainingMax` doubles the steps, drops the hit rate by 10 points, and
 *   uses peak prices — the conservative upper bound.
 *
 * @param {{
 *   usage: UsageBuckets,
 *   baseline: UsageBuckets,
 *   price: { cacheHit: number, cacheMiss: number, output: number },
 *   peakPrice: { cacheHit: number, cacheMiss: number, output: number },
 *   promptTokens: number,
 *   growthTokens: number,
 *   outputPerStep: number,
 *   cacheHit: number,
 *   remainingSteps: number,
 * }} input
 */
export function estimateTask(input) {
  const spentBuckets = usageDelta(input.usage, input.baseline)
  const spentUsd = costOfUsage(spentBuckets, input.price)
  const steps = Math.max(1, Math.min(MAX_STEPS, Math.round(input.remainingSteps) || 1))
  const maxSteps = Math.max(steps, Math.min(MAX_STEPS, steps * 2))
  const hit = clamp(input.cacheHit, 0, 0.98)
  const shape = {
    promptTokens: input.promptTokens,
    growthTokens: input.growthTokens,
    outputPerStep: input.outputPerStep,
  }

  let remainingExpectedUsd = 0
  for (let k = 1; k <= steps; k += 1) {
    remainingExpectedUsd += stepCostUsd({ ...shape, hit, price: input.price, k })
  }

  let remainingMaxUsd = 0
  const pessimisticHit = Math.max(0, hit - 0.1)
  for (let k = 1; k <= maxSteps; k += 1) {
    remainingMaxUsd += stepCostUsd({ ...shape, hit: pessimisticHit, price: input.peakPrice, k })
  }

  return {
    spentBuckets,
    spentUsd,
    remainingMinUsd: stepCostUsd({ ...shape, hit, price: input.price, k: 1 }),
    remainingExpectedUsd,
    remainingMaxUsd,
    totalExpectedUsd: spentUsd + remainingExpectedUsd,
    steps,
    maxSteps,
    cacheHit: hit,
  }
}

/**
 * The "can this task finish" verdict, in one currency.
 * `insufficient` includes equality: sitting exactly on the line still fails
 * later, so the boundary is not given the benefit of the doubt.
 *
 * @param {{ balance: number, lag?: number, remainingExpected: number, remainingMax: number, safetyRatio?: number, minReserve?: number }} input
 */
export function judge(input) {
  const safetyRatio = input.safetyRatio ?? SAFETY_RATIO
  const minReserve = input.minReserve ?? MIN_RESERVE
  const effective = input.balance - Math.max(0, input.lag ?? 0)
  const required = input.remainingExpected * (1 + safetyRatio) + minReserve
  return {
    effectiveBalance: effective,
    required,
    gap: required - effective,
    insufficient: effective <= required,
    risky: effective < input.remainingMax,
  }
}

/**
 * Sum every wallet of one currency; malformed balances count as zero.
 * @param {readonly { currency: string, balance: string }[]} wallets
 * @param {string} currency
 */
export function walletSum(wallets, currency) {
  let total = 0
  for (const wallet of wallets ?? []) {
    if (wallet === null || typeof wallet !== 'object') continue
    if (wallet.currency !== currency) continue
    const amount = Number.parseFloat(String(wallet.balance ?? ''))
    if (Number.isFinite(amount)) total += amount
  }
  return total
}

/**
 * The account currency to display: CNY when any wallet holds CNY, else the
 * first currency a wallet names, else CNY.
 * @param {...readonly { currency: string, balance: string }[]} groups
 */
export function pickCurrency(...groups) {
  for (const group of groups) {
    for (const wallet of group ?? []) if (wallet?.currency === 'CNY') return 'CNY'
  }
  for (const group of groups) {
    for (const wallet of group ?? []) if (typeof wallet?.currency === 'string' && wallet.currency.length > 0) return wallet.currency
  }
  return 'CNY'
}

/** Convert a USD amount into the display currency. */
export function toDisplayCurrency(usdAmount, currency, cnyPerUsd) {
  if (currency === 'USD') return usdAmount
  return usdAmount * (Number.isFinite(cnyPerUsd) && cnyPerUsd > 0 ? cnyPerUsd : DEFAULT_FX)
}

/** The currency symbol the card and chip print. */
export function symbolOf(currency) {
  return currency === 'USD' ? '$' : '¥'
}

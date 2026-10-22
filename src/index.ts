/**
 * Balance guard, Host half.
 *
 * Three things only the Host can do, so they all live here:
 *
 * 1. Read the DSH account balance through `ctx.deepseekAccount` (the account
 *    token never reaches the renderer).
 * 2. Fold each session's billed token usage per turn from `session/event`, so
 *    the current task's spend is provider-truth rather than an estimate.
 * 3. Turn that into a task-cost projection with `./policy.js` and publish a
 *    small read-only snapshot on `GET /dsh-balance-guard/state`, plus one
 *    index-injection row so the bar paints a real number on the first frame.
 *
 * The browser half never computes a threshold: tone, fill ratio, overflow and
 * every amount in the snapshot are already decided here. That keeps one copy
 * of the product rules (the pure module) and one place to test them.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_FX, MIN_RESERVE, SAFETY_RATIO, SCALE_LIMIT, clamp, costOfUsage,
  emptyUsage, estimateTask, hitRatioOf, isPeak, judge, normalizeUsage,
  pickCurrency, priceFor, scaleOf, symbolOf, toDisplayCurrency, usageDelta,
  walletSum,
} from './policy.js'

/** Cordis plugin name (the Loader row name). */
export const name = 'dsh-balance-guard'

/**
 * `webServer` is the only hard dependency: without a route there is no data
 * channel. The account service and the projection registry are optional so a
 * composition that omits one degrades to a grey bar instead of hanging the
 * fiber forever waiting for a service that will never arrive.
 */
export const inject = ['webServer']

/** The injection property the Client half reads before its first fetch. */
export const INJECTION_GLOBAL = '__DSH_BALANCE_GUARD__'

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/dsh-balance-guard'

/** Route the browser polls. */
const ROUTE_STATE = `${ROUTE_PREFIX}/state`

/** How many completed turns feed the idle "next task" estimate. */
const HISTORY_TURNS = 3

/** How many settled turns stay in the lag-compensation window. */
const RECENT_TURN_LIMIT = 20

/** Guard against unbounded session bookkeeping in a long-lived process. */
const SESSION_LIMIT = 64

/** Host-half configuration (every key optional). */
export interface Config {
  /** Multiplier over the expected remaining cost. @default 0.2 */
  readonly safetyRatio?: number
  /** Amount that must stay untouched, in the account currency. @default 2 */
  readonly minReserveCny?: number
  /** How long a balance reading is served before re-reading. @default 25000 */
  readonly balanceTtlMs?: number
  /** Background balance refresh cadence. @default 30000 */
  readonly balancePollMs?: number
  /** Per-request balance timeout handed to the account service. @default 30000 */
  readonly balanceTimeoutMs?: number
  /** Poll hint the browser uses while a turn runs. @default 1000 */
  readonly runningPollHintMs?: number
  /** Poll hint the browser uses while idle. @default 15000 */
  readonly idlePollMs?: number
  /** CNY per USD for the display currency. @default 7.2 */
  readonly cnyPerUsd?: number
  /** Remaining steps assumed when the session has no history. @default 8 */
  readonly assumedSteps?: number
  /** Output tokens per step assumed when the turn has no sample. @default 1200 */
  readonly assumedOutputTokens?: number
  /** Prompt growth per step assumed when the turn has no sample. @default 4000 */
  readonly assumedGrowthTokens?: number
  /** Cache-hit ratio assumed when the turn has no prompt sample. @default 0.85 */
  readonly assumedCacheHit?: number
  /** UTC dates (`YYYY-MM-DD`) DeepSeek bills at off-peak all day. @default [] */
  readonly holidays?: readonly string[]
  /** Subtract spend that landed after the balance reading. @default true */
  readonly balanceLagCompensation?: boolean
  /** Client version header used when the page cannot report one. @default '' */
  readonly clientVersion?: string
  /** Credential reference holding the provider key for the fallback. @default 'DEEPSEEK_API_KEY' */
  readonly credentialRef?: string
  /** Provider balance endpoint used by the fallback. @default 'https://api.deepseek.com/user/balance' */
  readonly endpoint?: string
  /** Timeout for one fallback request in milliseconds. @default 10000 */
  readonly timeoutMs?: number
  /** Fall back to the provider balance endpoint when no DSH account is signed in. @default true */
  readonly fallbackToApiKey?: boolean
}

/** Normalized configuration. */
export interface Settings {
  safetyRatio: number
  minReserveCny: number
  balanceTtlMs: number
  balancePollMs: number
  balanceTimeoutMs: number
  runningPollHintMs: number
  idlePollMs: number
  cnyPerUsd: number
  assumedSteps: number
  assumedOutputTokens: number
  assumedGrowthTokens: number
  assumedCacheHit: number
  holidays: string[]
  balanceLagCompensation: boolean
  clientVersion: string
  credentialRef: string
  endpoint: string
  timeoutMs: number
  fallbackToApiKey: boolean
}

/** Defaults documented in the README and mirrored by `cordis.patch.yml`. */
const DEFAULTS: Settings = {
  safetyRatio: SAFETY_RATIO,
  minReserveCny: MIN_RESERVE,
  balanceTtlMs: 25_000,
  balancePollMs: 30_000,
  balanceTimeoutMs: 30_000,
  runningPollHintMs: 1_000,
  idlePollMs: 15_000,
  cnyPerUsd: DEFAULT_FX,
  assumedSteps: 8,
  assumedOutputTokens: 1_200,
  assumedGrowthTokens: 4_000,
  assumedCacheHit: 0.85,
  holidays: [],
  balanceLagCompensation: true,
  clientVersion: '',
  credentialRef: 'DEEPSEEK_API_KEY',
  endpoint: 'https://api.deepseek.com/user/balance',
  timeoutMs: 10_000,
  fallbackToApiKey: true,
}

/** Where the "top up" / "usage" links point when no DSH account view exists. */
const DEFAULT_LINKS = {
  usageUrl: 'https://platform.deepseek.com/usage',
  topUpUrl: 'https://platform.deepseek.com/top_up',
}

/* ------------------------------------------------------------------ types */

interface Wallet {
  currency: string
  balance: string
}

interface AccountView {
  status: 'signed-out' | 'credential-stored'
  links?: { usageUrl?: string; topUpUrl?: string }
  attempt?: unknown
}

interface AccountBalance {
  status: 'ready' | 'failed'
  value?: readonly Wallet[]
  bonusWallets?: readonly Wallet[]
}

interface AccountClientMetadata {
  version: string
  locale: string
  timezoneOffsetSeconds: number
}

interface AccountService {
  getState(): AccountView
  getBalance(client: AccountClientMetadata): Promise<AccountBalance | null>
}

interface CredentialsService {
  resolve(reference: unknown): Promise<{ value?: unknown } | undefined>
}

/** Where the displayed balance came from. */
type BalanceSource = 'account' | 'api-key'

/** One normalized balance reading, whichever source produced it. */
interface BalanceReading {
  currency: string
  total: number
  normal?: number
  bonus?: number
  fetchedAt: number
  source: BalanceSource
}

interface FetchResponseLike {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

interface FetchLike {
  (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<FetchResponseLike>
}

interface ProjectionRegistry {
  stateOf(session: unknown, key: string): unknown
}

interface RequestLike {
  method?: string
  url?: string
}

interface ResponseLike {
  writeHead(status: number, headers: Record<string, string>): void
  end(body?: string): void
}

interface WebServerLike {
  register(route: { kind: 'exact'; path: string; handler: (req: RequestLike, res: ResponseLike) => void }): () => void
}

interface SessionLike {
  id?: unknown
  header?: { id?: unknown; parentSession?: unknown; origin?: unknown }
}

interface SessionEventLike {
  type?: string
  data?: Record<string, unknown>
}

interface UsageBuckets {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

interface TurnTrack {
  running: boolean
  turn: number
  baseline: UsageBuckets
  steps: number
  stepIds: Set<number>
  outputTokens: number
  promptHistory: number[]
  startedAt: number
  lastActivity: number
}

interface SettledTurn {
  turn: number
  steps: number
  costUsd: number
  at: number
  usage: UsageBuckets
}

interface SessionTrack {
  id: string
  session: unknown
  parent?: string
  title?: string
  model?: string
  turn?: TurnTrack
  lastTurn?: SettledTurn
  history: SettledTurn[]
  updatedAt: number
}

/** Account section of the wire snapshot. */
export interface AccountSnapshot {
  state: 'loading' | 'signed-in' | 'signed-out' | 'unavailable'
  currency: string
  symbol: string
  total?: number
  normal?: number
  bonus?: number
  tone: string
  ratio: number
  overflow: number
  fetchedAt: number
  error?: string
  errorAt?: number
  links?: { usageUrl?: string; topUpUrl?: string }
  /** Where the amount came from, so the card can name it. */
  source?: string
}

/** Task section of the wire snapshot; absent when nothing has run yet. */
export interface TaskSnapshot {
  kind: 'running' | 'idle'
  sessionId: string
  title?: string
  turn?: number
  model: string
  modelKnown: boolean
  peak: boolean
  stepsDone: number
  stepsExpected: number
  stepsSource: 'history' | 'default'
  cacheHit: number
  cacheHitSource: 'measured' | 'default'
  spentAmount: number
  remainingMin: number
  remainingExpected: number
  remainingMax: number
  requiredAmount?: number
  gap?: number
  effectiveBalance?: number
  insufficient: boolean
  risky: boolean
  subagents: number
  usageAvailable: boolean
  turnsSampled?: number
}

/** The whole wire snapshot. */
export interface GuardSnapshot {
  updatedAt: number
  account: AccountSnapshot
  task: TaskSnapshot | null
  config: {
    runningPollHintMs: number
    idlePollMs: number
    scaleLimit: number
  }
}

/* --------------------------------------------------------------- helpers */

/** Read a Cordis service without assuming `ctx.get` exists. */
function readService<T>(ctx: Context, serviceName: string): T | undefined {
  const candidate = ctx as unknown as { get?: (key: string) => unknown }
  if (typeof candidate.get === 'function') {
    try {
      const found = candidate.get(serviceName)
      if (found !== undefined) return found as T
    } catch {
      // Fall through to the direct property read.
    }
  }
  const direct = (ctx as unknown as Record<string, unknown>)[serviceName]
  return direct === undefined ? undefined : direct as T
}

/** Coerce a wire value into a finite number, else zero. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Coerce a wire value into a string, else the empty string. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Error text without assuming the thrown value is an `Error`. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Parse a provider money value without letting a malformed string become NaN. */
function parseMoney(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Normalize a partial row config against the defaults. */
function normalize(config: Config | undefined): Settings {
  const positive = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
  return {
    safetyRatio: clamp(config?.safetyRatio ?? DEFAULTS.safetyRatio, 0, 5),
    minReserveCny: Math.max(0, config?.minReserveCny ?? DEFAULTS.minReserveCny),
    balanceTtlMs: positive(config?.balanceTtlMs, DEFAULTS.balanceTtlMs),
    balancePollMs: positive(config?.balancePollMs, DEFAULTS.balancePollMs),
    balanceTimeoutMs: positive(config?.balanceTimeoutMs, DEFAULTS.balanceTimeoutMs),
    runningPollHintMs: positive(config?.runningPollHintMs, DEFAULTS.runningPollHintMs),
    idlePollMs: positive(config?.idlePollMs, DEFAULTS.idlePollMs),
    cnyPerUsd: positive(config?.cnyPerUsd, DEFAULTS.cnyPerUsd),
    assumedSteps: Math.round(positive(config?.assumedSteps, DEFAULTS.assumedSteps)),
    assumedOutputTokens: Math.round(positive(config?.assumedOutputTokens, DEFAULTS.assumedOutputTokens)),
    assumedGrowthTokens: Math.round(positive(config?.assumedGrowthTokens, DEFAULTS.assumedGrowthTokens)),
    assumedCacheHit: clamp(config?.assumedCacheHit ?? DEFAULTS.assumedCacheHit, 0, 1),
    holidays: Array.isArray(config?.holidays) ? config.holidays.filter(entry => typeof entry === 'string') : [],
    balanceLagCompensation: config?.balanceLagCompensation ?? DEFAULTS.balanceLagCompensation,
    clientVersion: text(config?.clientVersion),
    credentialRef: text(config?.credentialRef) || DEFAULTS.credentialRef,
    endpoint: text(config?.endpoint) || DEFAULTS.endpoint,
    timeoutMs: positive(config?.timeoutMs, DEFAULTS.timeoutMs),
    fallbackToApiKey: config?.fallbackToApiKey ?? DEFAULTS.fallbackToApiKey,
  }
}

/** The session id, wherever this DSH build put it. */
function sessionKey(session: unknown): string | undefined {
  const value = session as SessionLike | null | undefined
  const id = value?.id ?? value?.header?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** The parent session id for a delegated session. */
function sessionParent(session: unknown): string | undefined {
  const value = session as SessionLike | null | undefined
  const parent = value?.header?.parentSession
  return typeof parent === 'string' && parent.length > 0 ? parent : undefined
}

/* ------------------------------------------------------------------ apply */

/**
 * Mount the guard: balance reader, per-turn cost folding, snapshot route and
 * the first-paint injection row.
 * @param ctx - Host plugin context.
 * @param config - optional row configuration.
 */
export function apply(ctx: Context, config?: Config): void {
  const settings = normalize(config)
  let disposed = false

  const accountService = (): AccountService | undefined => readService<AccountService>(ctx, 'deepseekAccount')
  const projectionRegistry = (): ProjectionRegistry | undefined => readService<ProjectionRegistry>(ctx, 'sessionProjections')

  // Metadata only shapes the Platform client headers on a balance request; it
  // is refreshed from the page's query string because only the renderer knows
  // the live UI language and time zone.
  const metadata: AccountClientMetadata = {
    version: settings.clientVersion.length > 0 ? settings.clientVersion : '0.1.0',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }

  /* -------------------------------------------------------- account state */

  let accountView: AccountView | undefined
  let accountMissing = false
  let reading: BalanceReading | undefined
  let balanceError: { message: string; at: number } | undefined
  let balanceInFlight: Promise<void> | undefined
  let attempted = false
  let lastAttemptAt = 0

  const credentialsService = (): CredentialsService | undefined => readService<CredentialsService>(ctx, 'credentials')

  const fetchImpl = (): FetchLike | undefined => (globalThis as unknown as { fetch?: FetchLike }).fetch

  /** Resolve the provider key through the Harness credential seam. */
  const providerKey = async (): Promise<string | undefined> => {
    const credentials = credentialsService()
    if (credentials?.resolve === undefined) return undefined
    const resolved = await credentials.resolve(settings.credentialRef)
    const value = resolved?.value
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  /** The DSH-account reading; throws when the account reports a failure. */
  const readAccountBalance = async (account: AccountService): Promise<BalanceReading | undefined> => {
    const view = account.getState()
    accountView = view
    if (view.status !== 'credential-stored') return undefined
    const result = await account.getBalance(metadata)
    if (result === null || result === undefined || result.status !== 'ready') throw new Error('账号余额读取失败')
    const wallets = Array.isArray(result.value) ? result.value : []
    const bonusWallets = Array.isArray(result.bonusWallets) ? result.bonusWallets : []
    const currency = pickCurrency(wallets, bonusWallets)
    return {
      currency,
      total: walletSum(wallets, currency) + walletSum(bonusWallets, currency),
      normal: walletSum(wallets, currency),
      bonus: walletSum(bonusWallets, currency),
      fetchedAt: Date.now(),
      source: 'account',
    }
  }

  /** The provider `/user/balance` reading used when no DSH account is signed in. */
  const readApiKeyBalance = async (): Promise<BalanceReading | undefined> => {
    const fetchFn = fetchImpl()
    if (fetchFn === undefined) throw new Error('this Host has no fetch implementation')
    const key = await providerKey()
    if (key === undefined) throw new Error(`no credential: ${settings.credentialRef}`)
    const abort = new AbortController()
    const timer = setTimeout(() => { abort.abort() }, settings.timeoutMs)
    try {
      const response = await fetchFn(settings.endpoint, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: abort.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${settings.endpoint}`)
      const payload = (await response.json()) as Record<string, unknown>
      const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos as Record<string, unknown>[] : []
      const entry = infos.find(candidate => text(candidate?.currency) === 'CNY') ?? infos[0]
      if (entry === undefined) throw new Error('the provider returned no balance')
      const total = parseMoney(entry.total_balance)
      if (total === undefined) throw new Error('the provider returned a malformed balance')
      const granted = parseMoney(entry.granted_balance)
      const toppedUp = parseMoney(entry.topped_up_balance)
      return {
        currency: text(entry.currency) || 'CNY',
        total,
        ...(toppedUp === undefined ? {} : { normal: toppedUp }),
        ...(granted === undefined ? {} : { bonus: granted }),
        fetchedAt: Date.now(),
        source: 'api-key',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  const refreshBalance = (): Promise<void> => {
    if (balanceInFlight !== undefined) return balanceInFlight
    lastAttemptAt = Date.now()
    balanceInFlight = (async () => {
      let failure: string | undefined
      let next: BalanceReading | undefined
      try {
        const account = accountService()
        const credentials = credentialsService()
        const fallback = settings.fallbackToApiKey && credentials !== undefined
        if (account === undefined) {
          accountMissing = true
        } else {
          accountMissing = false
          try {
            next = await readAccountBalance(account)
          } catch (error) {
            failure = messageOf(error)
          }
        }
        if (next === undefined && fallback) {
          try {
            next = await readApiKeyBalance()
          } catch (error) {
            failure = failure ?? messageOf(error)
          }
        }
        attempted = true
        if (next !== undefined) {
          reading = next
          balanceError = undefined
        } else if (failure !== undefined) {
          balanceError = { message: failure, at: Date.now() }
          ctx.logger?.warn?.(`[${name}] balance read failed: ${failure}`)
        }
      } finally {
        balanceInFlight = undefined
      }
    })()
    return balanceInFlight
  }

  const ensureBalance = async (): Promise<void> => {
    if (Date.now() - lastAttemptAt < settings.balanceTtlMs) return
    await refreshBalance()
  }

  const displayCurrency = (): string => reading?.currency ?? 'CNY'

  const displayRate = (): number => (displayCurrency() === 'USD' ? 1 : settings.cnyPerUsd)

  /* ------------------------------------------------------- session folding */

  const sessions = new Map<string, SessionTrack>()
  const recentTurns: SettledTurn[] = []

  const projectionOf = <T>(session: unknown, key: string): T | undefined => {
    const registry = projectionRegistry()
    if (registry === undefined) return undefined
    try {
      return registry.stateOf(session, key) as T | undefined
    } catch {
      return undefined
    }
  }

  const readUsage = (session: unknown): UsageBuckets => normalizeUsage(projectionOf(session, 'tokenUsage'))

  const modelOf = (track: SessionTrack): string => {
    const selection = projectionOf<{ next?: { model?: string } | null; lastUsed?: { model?: string } | null }>(track.session, 'modelSelection')
    const model = text(selection?.next?.model) || text(selection?.lastUsed?.model)
    if (model.length > 0) track.model = model
    return track.model ?? ''
  }

  const titleOf = (track: SessionTrack): string | undefined => {
    const title = projectionOf<string | null>(track.session, 'title')
    if (typeof title === 'string' && title.length > 0) track.title = title
    return track.title
  }

  const trackFor = (session: unknown): SessionTrack | undefined => {
    const id = sessionKey(session)
    if (id === undefined) return undefined
    let track = sessions.get(id)
    if (track === undefined) {
      track = { id, session, history: [], updatedAt: Date.now() }
      sessions.set(id, track)
      pruneSessions()
    }
    track.session = session
    return track
  }

  const pruneSessions = (): void => {
    if (sessions.size <= SESSION_LIMIT) return
    const ordered = [...sessions.values()].sort((left, right) => left.updatedAt - right.updatedAt)
    for (const stale of ordered.slice(0, sessions.size - SESSION_LIMIT)) sessions.delete(stale.id)
  }

  const settleTurn = (track: SessionTrack, at: number): void => {
    const turn = track.turn
    if (turn === undefined || !turn.running) return
    turn.running = false
    const usage = usageDelta(readUsage(track.session), turn.baseline)
    const price = priceFor(modelOf(track), isPeak(at, settings.holidays))
    const costUsd = costOfUsage(usage, price)
    const settled: SettledTurn = {
      turn: turn.turn,
      steps: Math.max(1, turn.steps),
      costUsd,
      at,
      usage,
    }
    track.lastTurn = settled
    track.history.push(settled)
    while (track.history.length > 10) track.history.shift()
    recentTurns.push(settled)
    while (recentTurns.length > RECENT_TURN_LIMIT) recentTurns.shift()
    track.updatedAt = at
  }

  const onSessionEvent = (session: unknown, event: SessionEventLike): void => {
    if (disposed) return
    const track = trackFor(session)
    if (track === undefined) return
    const now = Date.now()
    track.updatedAt = now
    const type = text(event?.type)
    const data = (event?.data ?? {}) as Record<string, unknown>

    if (type === 'turn/start') {
      // A predecessor that never logged its own end still gets settled, so an
      // interrupted turn cannot leak its spend into the next one.
      settleTurn(track, now)
      track.turn = {
        running: true,
        turn: num(data.turn),
        baseline: readUsage(track.session),
        steps: 0,
        stepIds: new Set(),
        outputTokens: 0,
        promptHistory: [],
        startedAt: now,
        lastActivity: now,
      }
      return
    }

    const turn = track.turn
    if (turn === undefined || turn.turn !== num(data.turn)) return

    if (type === 'assistant/message') {
      const usage = data.usage as Record<string, unknown> | undefined
      turn.outputTokens += num(usage?.outputTokens)
      const pressure = projectionOf<{ projectedTokens?: number; pressureTokens?: number }>(track.session, 'contextPressure')
      const prompt = num(pressure?.projectedTokens) || num(pressure?.pressureTokens)
      if (prompt > 0) turn.promptHistory.push(prompt)
      turn.lastActivity = now
      return
    }

    if (type === 'step/start' || type === 'step/end') {
      const step = num(data.step)
      if (step > 0) turn.stepIds.add(step)
      turn.steps = turn.stepIds.size
      turn.lastActivity = now
      return
    }

    if (type === 'turn/end') settleTurn(track, now)
  }

  /* ----------------------------------------------------- snapshot assembly */

  const lagAmount = (): number => {
    if (!settings.balanceLagCompensation || reading === undefined) return 0
    const fetchedAt = reading.fetchedAt
    const usd = recentTurns
      .filter(entry => entry.at > fetchedAt)
      .reduce((sum, entry) => sum + entry.costUsd, 0)
    return toDisplayCurrency(usd, displayCurrency(), settings.cnyPerUsd)
  }

  const averageSteps = (history: readonly SettledTurn[]): number | undefined => {
    if (history.length < 2) return undefined
    const mean = history.reduce((sum, entry) => sum + Math.max(1, entry.steps), 0) / history.length
    return clamp(Math.round(mean), 1, 60)
  }

  const growthOf = (turn: TurnTrack): number => {
    const history = turn.promptHistory
    if (history.length < 2) return settings.assumedGrowthTokens
    const deltas: number[] = []
    for (let index = 1; index < history.length; index += 1) {
      const delta = history[index] - history[index - 1]
      if (delta > 0) deltas.push(delta)
    }
    if (deltas.length === 0) return settings.assumedGrowthTokens
    return deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length
  }

  const subagentCount = (): number => {
    let count = 0
    for (const track of sessions.values()) {
      if (track.parent !== undefined && track.turn?.running === true) count += 1
    }
    return count
  }

  const runningTask = (track: SessionTrack): TaskSnapshot => {
    const turn = track.turn as TurnTrack
    const usage = readUsage(track.session)
    const spent = usageDelta(usage, turn.baseline)
    const pressure = projectionOf<{ pressureTokens?: number; projectedTokens?: number }>(track.session, 'contextPressure')
    const breakdown = projectionOf<{ systemTokens?: number; toolsTokens?: number; messageTokens?: number }>(track.session, 'contextBreakdown')
    const promptTokens = num(pressure?.projectedTokens)
      || num(pressure?.pressureTokens)
      || (num(breakdown?.systemTokens) + num(breakdown?.toolsTokens) + num(breakdown?.messageTokens))
    const model = modelOf(track)
    const peak = isPeak(Date.now(), settings.holidays)
    const price = priceFor(model, peak)
    const peakPrice = priceFor(model, true)
    const outputPerStep = turn.steps > 0 ? turn.outputTokens / turn.steps : settings.assumedOutputTokens
    const promptSide = spent.cacheReadTokens + spent.cacheWriteTokens + spent.uncachedInputTokens
    const cacheHit = hitRatioOf(spent, settings.assumedCacheHit)
    const historySteps = averageSteps(track.history)
    const stepsExpected = historySteps ?? settings.assumedSteps
    const title = titleOf(track)
    const estimate = estimateTask({
      usage,
      baseline: turn.baseline,
      price,
      peakPrice,
      promptTokens,
      growthTokens: growthOf(turn),
      outputPerStep,
      cacheHit,
      remainingSteps: stepsExpected,
    })
    const rate = displayRate()
    const remainingMin = estimate.remainingMinUsd * rate
    const remainingExpected = estimate.remainingExpectedUsd * rate
    const remainingMax = estimate.remainingMaxUsd * rate
    const balanceAmount = reading?.total
    const verdict = balanceAmount === undefined ? undefined : judge({
      balance: balanceAmount,
      lag: lagAmount(),
      remainingExpected,
      remainingMax,
      safetyRatio: settings.safetyRatio,
      minReserve: settings.minReserveCny,
    })
    return {
      kind: 'running',
      sessionId: track.id,
      ...(title === undefined ? {} : { title }),
      turn: turn.turn,
      model: price.model,
      modelKnown: price.known,
      peak,
      stepsDone: turn.steps,
      stepsExpected,
      stepsSource: historySteps === undefined ? 'default' : 'history',
      cacheHit,
      cacheHitSource: promptSide > 0 ? 'measured' : 'default',
      spentAmount: estimate.spentUsd * rate,
      remainingMin,
      remainingExpected,
      remainingMax,
      ...(verdict === undefined ? {} : {
        requiredAmount: verdict.required,
        gap: verdict.gap,
        effectiveBalance: verdict.effectiveBalance,
      }),
      insufficient: verdict?.insufficient ?? false,
      risky: verdict?.risky ?? false,
      subagents: subagentCount(),
      usageAvailable: promptTokens > 0,
    }
  }

  const idleTask = (track: SessionTrack): TaskSnapshot => {
    const settled = track.history.slice(-HISTORY_TURNS)
    const costs = (settled.length > 0 ? settled : track.lastTurn === undefined ? [] : [track.lastTurn])
      .map(entry => entry.costUsd)
    const rate = displayRate()
    const min = Math.min(...costs) * rate
    const max = Math.max(...costs) * rate
    const expected = (costs.reduce((sum, cost) => sum + cost, 0) / Math.max(1, costs.length)) * rate
    const model = modelOf(track)
    const price = priceFor(model, isPeak(Date.now(), settings.holidays))
    const title = titleOf(track)
    const balanceAmount = reading?.total
    const verdict = balanceAmount === undefined ? undefined : judge({
      balance: balanceAmount,
      lag: lagAmount(),
      remainingExpected: expected,
      remainingMax: max,
      safetyRatio: settings.safetyRatio,
      minReserve: settings.minReserveCny,
    })
    return {
      kind: 'idle',
      sessionId: track.id,
      ...(title === undefined ? {} : { title }),
      model: price.model,
      modelKnown: price.known,
      peak: price.peak,
      stepsDone: 0,
      stepsExpected: averageSteps(track.history) ?? settings.assumedSteps,
      stepsSource: track.history.length >= 2 ? 'history' : 'default',
      cacheHit: settings.assumedCacheHit,
      cacheHitSource: 'default',
      spentAmount: 0,
      remainingMin: min,
      remainingExpected: expected,
      remainingMax: max,
      ...(verdict === undefined ? {} : {
        requiredAmount: verdict.required,
        gap: verdict.gap,
        effectiveBalance: verdict.effectiveBalance,
      }),
      insufficient: verdict?.insufficient ?? false,
      risky: verdict?.risky ?? false,
      subagents: subagentCount(),
      usageAvailable: true,
      turnsSampled: costs.length,
    }
  }

  const buildTask = (): TaskSnapshot | null => {
    const candidates = [...sessions.values()]
    const running = candidates
      .filter(track => track.turn?.running === true)
      .sort((left, right) => (right.turn?.lastActivity ?? 0) - (left.turn?.lastActivity ?? 0))[0]
    if (running !== undefined) return runningTask(running)
    const settled = candidates
      .filter(track => track.lastTurn !== undefined)
      .sort((left, right) => (right.lastTurn?.at ?? 0) - (left.lastTurn?.at ?? 0))[0]
    if (settled === undefined) return null
    return idleTask(settled)
  }

  const accountSnapshot = (): AccountSnapshot => {
    const scale = scaleOf(reading?.total)
    const state: AccountSnapshot['state'] = reading !== undefined
      ? 'signed-in'
      : !attempted
        ? 'loading'
        : accountMissing && !settings.fallbackToApiKey
          ? 'unavailable'
          : 'signed-out'
    const links = accountView?.links ?? DEFAULT_LINKS
    return {
      state,
      currency: displayCurrency(),
      symbol: symbolOf(displayCurrency()),
      ...(reading === undefined ? {} : {
        total: reading.total,
        ...(reading.normal === undefined ? {} : { normal: reading.normal }),
        ...(reading.bonus === undefined ? {} : { bonus: reading.bonus }),
        source: reading.source,
      }),
      tone: scale.tone,
      ratio: scale.ratio,
      overflow: scale.overflow,
      fetchedAt: reading?.fetchedAt ?? 0,
      ...(balanceError === undefined ? {} : { error: balanceError.message, errorAt: balanceError.at }),
      links,
    }
  }

  const snapshot = (): GuardSnapshot => ({
    updatedAt: Date.now(),
    account: accountSnapshot(),
    task: buildTask(),
    config: {
      runningPollHintMs: settings.runningPollHintMs,
      idlePollMs: settings.idlePollMs,
      scaleLimit: SCALE_LIMIT,
    },
  })

  /* ------------------------------------------------------------- surfaces */

  const applyClientQuery = (params: URLSearchParams): void => {
    const locale = params.get('locale')
    if (locale !== null && locale.length > 0) metadata.locale = locale
    const version = params.get('version')
    if (version !== null && version.length > 0) metadata.version = version
    const timezone = params.get('tz')
    if (timezone !== null) {
      const offset = Number(timezone)
      if (Number.isFinite(offset)) metadata.timezoneOffsetSeconds = Math.trunc(offset)
    }
  }

  const respond = (res: ResponseLike, status: number, payload: string, head: boolean): void => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(head ? undefined : payload)
  }

  const handleState = (req: RequestLike, res: ResponseLike): void => {
    void (async () => {
      const method = text(req.method).toUpperCase() || 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        respond(res, 405, JSON.stringify({ error: 'method not allowed' }), false)
        return
      }
      try {
        const url = new URL(text(req.url) || ROUTE_STATE, 'http://127.0.0.1')
        applyClientQuery(url.searchParams)
        await ensureBalance()
        respond(res, 200, JSON.stringify(snapshot()), method === 'HEAD')
      } catch (error) {
        respond(res, 500, JSON.stringify({ error: messageOf(error) }), false)
      }
    })()
  }

  ctx.effect(() => (ctx as unknown as { webServer: WebServerLike }).webServer.register({
    kind: 'exact',
    path: ROUTE_STATE,
    handler: handleState,
  }), `${name}: state route`)

  ctx.effect(() => ctx.on('session/event', onSessionEvent), `${name}: turn folding`)

  // Early paint: the same snapshot the route would return, embedded at index
  // render time. Skipped until the first balance attempt settles, so the bar
  // never paints a "loading" frame on a warm process.
  ctx.effect(() => ctx.on('webserver/index-inject', (table: unknown[]) => {
    if (disposed) return
    const value = snapshot()
    if (value.account.state === 'loading') return
    table.push({ kind: 'global', name: INJECTION_GLOBAL, value })
  }), `${name}: earliest snapshot injection`)

  ctx.effect(() => {
    const timer = setInterval(() => {
      if (disposed) return
      void refreshBalance().catch(() => undefined)
    }, settings.balancePollMs)
    void refreshBalance().catch(() => undefined)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, `${name}: balance cadence`)
}

/**
 * Host smoke — mount `apply` on a mock Host context and drive the real
 * `/dsh-balance-guard/state` route through the states that matter:
 *
 *   signed in → running turn → short balance → settled turn → signed out
 *
 * It exercises what a browser cannot see: the account service projection, the
 * per-turn folding over `session/event`, the balance TTL, the price period and
 * the judgment in the snapshot. No Web server, no account token, no network.
 *
 * Usage: node --experimental-strip-types scripts/host-smoke.mjs
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(resolve(HERE, '..'), 'src', 'index.ts')

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

function near(label, actual, expected, tolerance = 1e-6) {
  checks += 1
  if (!(Math.abs(actual - expected) <= tolerance)) failures.push(`${label}: expected ${expected}, got ${actual}`)
}

const sleep = milliseconds => new Promise(settle => setTimeout(settle, milliseconds))

/**
 * A Host context stand-in exposing exactly the seams the plugin uses:
 * optional services through `get`, events, effects and one route.
 */
function mockContext(services) {
  const routes = []
  const listeners = new Map()
  const warnings = []
  return {
    routes,
    warnings,
    get(name) {
      return services[name]
    },
    effect(body) {
      const dispose = body()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    logger: { warn: text => { warnings.push(String(text)) } },
  }
}

/** Drive one route through a minimal IncomingMessage/ServerResponse pair. */
function respond(handler, method = 'GET', url = '/dsh-balance-guard/state') {
  return new Promise((settle, fail) => {
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(body) {
        settle({ status: this.status, headers: this.headers, body: body ?? '' })
      },
    }
    try {
      handler({ method, url }, res)
    } catch (error) {
      fail(error)
    }
  })
}

// --- mock services ------------------------------------------------------
const account = {
  signedIn: true,
  balance: {
    status: 'ready',
    value: [{ currency: 'CNY', balance: '12.3400000000' }],
    bonusWallets: [{ currency: 'CNY', balance: '2.0000000000' }],
  },
  getState() {
    return {
      status: this.signedIn ? 'credential-stored' : 'signed-out',
      links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
      attempt: null,
    }
  },
  async getBalance() {
    return this.signedIn ? this.balance : null
  },
}

const session = { id: 'session-1', header: {}, projections: {} }
const projections = {
  stateOf(target, key) {
    return target?.projections?.[key]
  },
}

/** Provider key seam; flipping `value` simulates a missing credential. */
const credentials = {
  value: 'sk-test',
  async resolve() {
    return this.value === undefined ? undefined : { value: this.value }
  },
}

/** Stand-in for the provider `/user/balance` endpoint the fallback calls. */
const fetchCalls = []
globalThis.fetch = async (input, init) => {
  fetchCalls.push({ input, init })
  return {
    ok: true,
    status: 200,
    json: async () => ({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '7.5000000000',
        granted_balance: '0.5000000000',
        topped_up_balance: '7.0000000000',
      }],
    }),
  }
}

const module = await import(pathToFileURL(ENTRY).href)
check('host module name', module.name, 'dsh-balance-guard')
check('injection global name', module.INJECTION_GLOBAL, '__DSH_BALANCE_GUARD__')

const ctx = mockContext({ deepseekAccount: account, sessionProjections: projections, credentials })
module.apply(ctx, { balanceTtlMs: 5, balancePollMs: 60_000, cnyPerUsd: 7.2 })
await sleep(30)

check('one route registered', ctx.routes.length, 1)
check('route path', ctx.routes[0].path, '/dsh-balance-guard/state')

const first = await respond(ctx.routes[0].handler)
check('first read status', first.status, 200)
const firstSnapshot = JSON.parse(first.body)
check('account state', firstSnapshot.account.state, 'signed-in')
near('balance total is normal + bonus', firstSnapshot.account.total, 14.34)
near('normal wallet', firstSnapshot.account.normal, 12.34)
near('bonus wallet', firstSnapshot.account.bonus, 2)
check('balance currency', firstSnapshot.account.currency, 'CNY')
check('14.34 sits in the orange band', firstSnapshot.account.tone, 'orange')
near('fill ratio', firstSnapshot.account.ratio, 14.34 / 50)
check('no task before any turn', firstSnapshot.task, null)
check('top-up link forwarded', firstSnapshot.account.links.topUpUrl, 'https://platform.deepseek.com/top_up')
check('poll hints forwarded', firstSnapshot.config.runningPollHintMs, 1_000)

// The index-injection row carries the same snapshot for first paint.
const table = []
ctx.emit('webserver/index-inject', table)
check('one injection row', table.length, 1)
check('injection row name', table[0].name, '__DSH_BALANCE_GUARD__')
check('injection row is global', table[0].kind, 'global')
assert('injection row carries a snapshot', table[0].value?.account?.state === 'signed-in')

// --- a running turn -----------------------------------------------------
session.projections = {
  tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  contextPressure: { projectedTokens: 350_000 },
  modelSelection: { lastUsed: { model: 'deepseek-flash' }, next: { model: 'deepseek-flash' } },
  title: 'demo task',
}
ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })

session.projections = {
  ...session.projections,
  tokenUsage: { uncachedInputTokens: 30_000, cacheReadTokens: 900_000, cacheWriteTokens: 0, outputTokens: 25_000 },
}
ctx.emit('session/event', session, { type: 'assistant/message', data: { turn: 1, step: 1, usage: { outputTokens: 12_000 } } })
ctx.emit('session/event', session, { type: 'step/end', data: { turn: 1, step: 1 } })

const running = JSON.parse((await respond(ctx.routes[0].handler)).body)
const task = running.task
check('running task kind', task.kind, 'running')
check('running task session', task.sessionId, 'session-1')
check('running task title', task.title, 'demo task')
check('running task model', task.model, 'deepseek-flash')
check('running task model known', task.modelKnown, true)
check('steps done', task.stepsDone, 1)
check('steps expected falls back to the default', task.stepsExpected, 8)
check('steps source', task.stepsSource, 'default')
near('measured cache hit', task.cacheHit, 900_000 / 930_000)
check('cache hit source', task.cacheHitSource, 'measured')
assert('spent is positive', task.spentAmount > 0)
assert('remaining min is positive', task.remainingMin > 0)
assert('min <= expected', task.remainingMin <= task.remainingExpected)
assert('expected <= max', task.remainingExpected <= task.remainingMax)
check('usage is available', task.usageAvailable, true)
check('no marker while the balance is comfortable', task.insufficient, false)

// --- short balance flips the verdict ------------------------------------
account.balance = {
  status: 'ready',
  value: [{ currency: 'CNY', balance: '1.1000000000' }],
  bonusWallets: [],
}
await sleep(30)
const short = JSON.parse((await respond(ctx.routes[0].handler)).body)
near('short balance total', short.account.total, 1.1)
check('short balance is red', short.account.tone, 'red')
check('short balance is insufficient', short.task.insufficient, true)
assert('gap is reported', typeof short.task.gap === 'number' && short.task.gap > 0)
near('required = expected*1.2 + 2', short.task.requiredAmount, short.task.remainingExpected * 1.2 + 2)

// --- the turn settles into an idle estimate -----------------------------
ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
const idle = JSON.parse((await respond(ctx.routes[0].handler)).body)
check('idle task kind', idle.task.kind, 'idle')
check('idle samples one turn', idle.task.turnsSampled, 1)
assert('idle range is ordered', idle.task.remainingMin <= idle.task.remainingExpected && idle.task.remainingExpected <= idle.task.remainingMax)

// --- signed out falls back to the provider balance ----------------------
account.signedIn = false
await sleep(30)
const fallback = JSON.parse((await respond(ctx.routes[0].handler)).body)
check('fallback still has a balance', fallback.account.state, 'signed-in')
check('fallback source is the API key', fallback.account.source, 'api-key')
near('fallback total', fallback.account.total, 7.5)
near('fallback topped-up part', fallback.account.normal, 7)
near('fallback granted part', fallback.account.bonus, 0.5)
check('7.50 sits in the red band', fallback.account.tone, 'red')
check('fallback called the configured endpoint', fetchCalls.length >= 1, true)
check('fallback sent the bearer key', fetchCalls[fetchCalls.length - 1].init.headers.authorization, 'Bearer sk-test')
check('fallback keeps a top-up link', fallback.account.links.topUpUrl, 'https://platform.deepseek.com/top_up')

// --- a credential that disappears keeps the last reading, labelled -----
// Removing the key must not blank a figure the user just saw; the error note
// is what tells them the number is now unverified.
credentials.value = undefined
await sleep(30)
const stale = JSON.parse((await respond(ctx.routes[0].handler)).body)
check('stale reading is still shown', stale.account.state, 'signed-in')
near('stale reading keeps its amount', stale.account.total, 7.5)
check('stale reading keeps its band', stale.account.tone, 'red')
check('stale reading keeps its source', stale.account.source, 'api-key')
assert(
  'stale reading explains the credential failure',
  typeof stale.account.error === 'string' && stale.account.error.includes('credential'),
)

// --- a fresh mount with no signed-in account and no key -----------------
const bareCtx = mockContext({ deepseekAccount: account, sessionProjections: projections })
module.apply(bareCtx, { balanceTtlMs: 5, balancePollMs: 60_000 })
await sleep(30)
const bare = JSON.parse((await respond(bareCtx.routes[0].handler)).body)
check('signed-out state', bare.account.state, 'signed-out')
check('signed-out hides the amount', bare.account.total, undefined)
check('signed-out tone', bare.account.tone, 'unknown')
check('signed-out has no verdict', bare.task?.insufficient ?? false, false)

// --- protocol edges -----------------------------------------------------
const post = await respond(ctx.routes[0].handler, 'POST')
check('POST is refused', post.status, 405)
const head = await respond(ctx.routes[0].handler, 'HEAD')
check('HEAD is accepted', head.status, 200)
check('HEAD has no body', head.body, '')

// The wire snapshot carries aggregates only: no prompt, no message content.
for (const forbidden of ['uncachedInputTokens', 'cacheReadTokens', 'messages', 'content"', 'prompt"']) {
  assert(`wire snapshot omits ${forbidden}`, !first.body.includes(forbidden))
}
check('the missing credential is logged', ctx.warnings.some(text => text.includes('credential')), true)

if (failures.length > 0) {
  console.error(`\n[host-smoke] ${failures.length} of ${checks} checks failed:`)
  for (const failure of failures) console.error('  -', failure)
  process.exit(1)
}
console.log(`[host-smoke] ${checks} checks passed`)
process.exit(0)

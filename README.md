# dsh-balance-guard

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that pins your
**DeepSeek account balance** to the right edge of the GUI as a colour-banded vertical bar, and
**projects what the current task will cost** before the balance runs out.

Nothing else changes hands: the balance comes from the DSH account you are already signed into,
the API key is never read, and no message content leaves the Host.

```
                                                       ┌──┐
                                       ¥12.34  ●       │░░│ ← balance chip (horizontal) + warning dot
                                                       │▓▓│
                                       ┌─────────────┐ │▓▓│
                                       │ 账户余额     │ │▓▓│
                                       │ ¥12.34      │ └──┘
                                       │ 本任务已花   │
                                       │ ¥0.42       │  ← hover card
                                       │ 预计还需     │
                                       │ ¥0.90 – 2.30│
                                       │ ⚠ 预计不足…  │
                                       │      去充值 →│
                                       └─────────────┘
```

| Balance (account currency) | Band | Meaning |
|---|---|---|
| `< 10` | **red** | about to run dry |
| `10 – 30` | **orange** | top up soon |
| `30 – 50` | **green** | fine |
| `> 50` | **blue**, plus a light blue-violet wave above the 50 mark | plenty |

The bar keeps its scale at 50; `> 50` fills it and draws the overflow as a moving wave
(disabled under `prefers-reduced-motion: reduce`).

## 中文速览

- 在界面最右侧贴边显示一根**账户余额竖条**，颜色：`<10` 红、`10–30` 橙、`30–50` 绿、`>50` 蓝
  （超出 50 的部分画成浅蓝紫波纹）。
- 数字是横向的金额胶囊（`¥12.34`），贴着竖条左侧；鼠标悬停竖条或胶囊弹出卡片。
- 卡片里给出**本轮任务已经花了多少、预计还要花多少（区间）**；预计余额不够跑完时，
  胶囊上出现一个**静态红点**，卡片里一行红字说明缺口（不弹窗、不发声、竖条不变色）。
- 余额来自你已登录的 **DSH 账号**（平台登录态），不读 API Key；API Key 和账号令牌都不进浏览器。
- 以 50 元为满刻度；卡片里还有「去充值」入口、模型、峰谷价、缓存命中率、数据新鲜度。

## What it predicts

「当前任务」= **the running turn of the current root session** (`turn/start` → `turn/end`).

- **Already spent** is provider truth: the four billed buckets of the turn
  (`uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`) read as a delta
  against the cumulative `tokenUsage` session projection, priced by the current model and period.
- **Still to come** is projected per step: the next prompt size comes from the provider-anchored
  `contextPressure.projectedTokens`, output and prompt growth come from this turn's samples
  (falling back to configured defaults), and the cache-hit ratio is measured from the turn so far.
- **How many steps are left** is the mean steps-per-turn of this session's completed turns
  (default 8 when there is no history). The card reports a **minimum / expected / maximum**:
  one more step, the expected remaining steps, and twice the expected steps with a 10-point-worse
  cache hit and peak prices.
- **Verdict**: `required = expectedRemaining × 1.2 + reserve`, compared against the balance minus
  spend that landed *after* the balance reading (Platform balance lags by minutes). Balance at or
  below the line is "insufficient".

When no turn is running, the same card estimates the **next** task from the last three turns
instead of pretending to know the future.

## Requirements

- A DSH client with the DeepSeek account signed in (Desktop client or `dsh web` with the account
  service composed). Signed out, the plugin degrades to a grey "未登录账号" bar.
- Node 20+ only for the test/install scripts; the plugin itself has **no build step**.

## Install

The plugin is not published to npm; it loads straight from a checkout.

```sh
git clone https://github.com/marksimZ/dsh-balance-guard.git dsh-balance-guard
```

Then either pass the overlay for one run:

```sh
dsh web --patch /absolute/path/to/dsh-balance-guard/cordis.patch.yml
```

…or make it permanent by appending the row to a profile's own patch layer, which reloads live
(no restart, just reload the page). The installer picks `desktop` when that profile exists and
`web` otherwise:

```sh
node scripts/install.mjs            # writes $DSH_HOME/profiles/<profile>/cordis.patch.yml
node scripts/install.mjs --dry-run  # show the exact result first
node scripts/install.mjs --profile web
```

> **`cordis.patch.yml` ships a machine-specific absolute path.** Edit that line (or let
> `install.mjs` write it) to point at wherever you cloned this repository.

Verify the running GUI actually serves it:

```sh
node scripts/verify-deployed.mjs --url http://127.0.0.1:52259
```

## Configuration

Every key is optional; defaults live in `cordis.patch.yml`.

| Key | Default | Meaning |
|---|---|---|
| `safetyRatio` | `0.2` | Multiplier over the expected remaining cost |
| `minReserveCny` | `2` | Amount that must stay untouched (account-currency units) |
| `balanceTtlMs` | `25000` | How long a balance reading is served |
| `balancePollMs` | `30000` | Background balance refresh cadence |
| `balanceTimeoutMs` | `30000` | Timeout for one balance read |
| `runningPollHintMs` | `1000` | Browser poll hint while a turn runs |
| `idlePollMs` | `15000` | Browser poll cadence while idle |
| `cnyPerUsd` | `7.2` | CNY per USD for the USD-quoted price catalog |
| `assumedSteps` | `8` | Remaining steps when the session has no history |
| `assumedOutputTokens` | `1200` | Output tokens per step without a sample |
| `assumedGrowthTokens` | `4000` | Prompt growth per step without a sample |
| `assumedCacheHit` | `0.85` | Cache-hit ratio without a prompt sample |
| `holidays` | `[]` | UTC dates DeepSeek bills at off-peak all day |
| `balanceLagCompensation` | `true` | Subtract spend that landed after the reading |
| `clientVersion` | `""` | Client version used when the page cannot report one |

Prices live in [`src/policy.js`](src/policy.js) as `PRICE_TABLE` (USD per 1M tokens, peak and
off-peak rows for `deepseek-flash` and `deepseek-v4-pro`), with the fetch date and source URL in
the file header. Peak is Monday–Friday `01:00–04:00` and `06:00–10:00` UTC, excluding the dates
listed in `holidays`; everything else is off-peak. Changing a price is a two-file change:
`policy.js` plus the value pinned in `scripts/policy-spec.mjs`.

## Architecture

Two halves, one plugin.

```text
Host half (src/index.ts)
  ctx.deepseekAccount.getState() / getBalance(metadata)   → the balance, token stays Host-side
  ctx.on('session/event')                                 → per-turn billed-token folding
  ctx.sessionProjections.stateOf(...)                     → tokenUsage / contextPressure / modelSelection
  src/policy.js                                           → bands, prices, estimator, verdict (pure)
  ├─ GET /dsh-balance-guard/state                         → same-origin read-only JSON
  └─ globalThis.__DSH_BALANCE_GUARD__                     → index injection for first paint

Browser half (src/client.js)
  window.__ModuleLoader__.load({ id, factory })           → the whole transport contract
  require('react')                                        → the shell's platform seed
  ctx.slots.inject('shell.overlay')                       → the fixed bar, chip, dot and card
```

**Why a Host half?** The account token never reaches the renderer; per-turn billing lives in the
Host's session log; and the `shell.overlay` entry does not receive `useProjection`, so the page
cannot read session projections by itself.

**Why an HTTP route instead of `@Remote`?** Remote methods are generated from Host decorations by
the Typert build pipeline. A plugin outside the Harness build must describe its own wire protocol,
so it publishes on `ctx.webServer` with an exact named route — deliberately *not* under `/api`,
which belongs to the Connection plugin and authenticates. Only aggregates cross the wire: no
tokens, no message text. The shipped Web composition binds loopback only.

**Why is every threshold on the Host?** So the product rules exist once (in `policy.js`), are
tested once with plain Node, and a cached browser bundle can never disagree with the Host.

## Tests

Plain Node, no test framework:

```sh
npm test          # policy spec + client spec + bundle smoke + theme tokens
npm run test:host # mounts the Host half on a mock context and drives the real route
npm run verify    # read-only probe of a running GUI
```

| Script | What it pins |
|---|---|
| `scripts/policy-spec.mjs` | band boundaries (`9.99` red, `10` orange, `30` green, `50` green, `50.01` blue), the peak/off-peak calendar, the official price table, the estimator arithmetic (including the worked example in `DESIGN.md`), the `×1.2 + reserve` verdict and wallet projection |
| `scripts/client-spec.mjs` | the snapshot → pixels projection: chip copy, marker rule, warning levels, range formatting, poll cadence, wave closure |
| `scripts/client-smoke.mjs` | the bundle registers through `__ModuleLoader__`, `require('react')`, installs one stylesheet and mounts into `shell.overlay` |
| `scripts/host-smoke.mjs` | signed in → running turn → short balance → settled turn → signed out, over the real route |
| `scripts/theme-tokens.mjs` | every `var(--dsw-*)` is declared by the shipped theme; the chip is horizontal; the four tones, marker and top-up link survive |
| `scripts/verify-deployed.mjs` | the running GUI serves the bundle **and** the state route |

`theme-tokens` exists because a missing custom property fails silently: the declaration is dropped
and the hardcoded fallback paints, which reads as a design choice rather than a bug. The previous
balance plugin shipped exactly that.

## Limitations

- **The projection is not a bill.** Remaining steps, cache-hit ratio and tool-output size are
  estimates; the min/expected/max range is the honest error bar.
- **Platform balance lags** by tens of seconds to minutes. The guard subtracts measured spend that
  landed after the reading, but that compensation is itself measured.
- **Holidays are offline.** Without a `holidays` list, weekday peak windows are priced as peak
  (a conservative over-estimate).
- **Sub-agents are not in the projection.** Their spend is real and shows up in the balance; the
  card only notes that they are running.
- **One task at a time.** With several sessions running, the Host tracks the most recently active
  running turn; the card names the session title.
- **Prices may change.** The catalog carries a fetch date; a price change is one constant plus one
  test.
- **USD accounts** display in USD; the price catalog is converted with `cnyPerUsd` only for CNY
  accounts.

## License

MIT — see [LICENSE](LICENSE).

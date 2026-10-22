# 余额护栏（dsh-balance-guard）设计方案

> 一个 DSH 客户端（Desktop / Web GUI）插件：常驻右侧贴边的账户余额竖条 + 悬停卡片，
> 实时显示 **DSH 账号余额**，并在「当前这一轮任务预计花不完」时给出预测与提醒。
>
> 本文是**待评审的设计**，不是实现。所有已确认的产品决策都记录在 §0；
> 未确认的细节集中在 §13，不会由实现方自行决定。

---

## 0. 已确认的产品决策

| # | 问题 | 决策 |
|---|---|---|
| 1 | 余额数据源 | **只用 DSH 账号余额**（`ctx.deepseekAccount`，平台登录态）。不读 API Key、不调 `/user/balance` |
| 2 | 位置形态 | **贴边悬浮竖条 + 横向金额胶囊**（`shell.overlay`），始终可见，不占布局 |
| 3 | 「当前任务」边界 | **当前根会话的当前一轮**（`turn/start` → `turn/end`） |
| 4 | 预测口径 | **结构化估算**：已花（实测计费 token）+ 剩余步数估算，输出 **最小值 / 预期 / 最大值** 区间 |
| 5 | 价格与币种 | 内置 DeepSeek 官方价目表（**峰谷价，美元/百万 token**）+ **可配置汇率**折算人民币 |
| 6 | 提醒方式 | **悬停卡片里一行醒目说明** + **胶囊上一个静态小标记**（无动画 / 无 toast / 无弹窗 / 无声音） |
| 7 | 安全余量 | 预计剩余成本 **× 1.2**，且要求余额至少保留 **¥2** |
| 8 | 刷新节奏 | **余额 30 秒**；**用量逐步实时**（运行中 1 秒轮询，空闲 15 秒） |
| 9 | > 50 元的蓝色 | **整条变蓝**，超出 50 的部分仍画蓝色波纹 |
| 10 | 代码基线 | **新建独立插件包**；`dsh-balance-bar` 保留在仓库但**不启用**（两根条会重叠） |
| 11 | 检查时机 | 运行中实时检查 **+** 空闲时用「上一轮花费」预估下一轮 |
| 12 | 统计口径 | 只算当前根会话的这一轮；子代理消耗**不进预测**（卡片里单独提示） |
| 13 | 价目维护 | 配置文件 / 具名常量，不做设置页、不联网拉取 |
| 14 | 未登录状态 | 显示**灰色「未登录账号」条**，不隐藏插件 |

---

## 1. 产品形态

### 1.1 布局

沿用现有 `dsh-balance-bar` 已验证过的形态（`shell.overlay` 根级列表插槽）：

```
                                                        ┌──┐
                                        ¥12.34  ●       │░░│ ← 16px 竖条，贴右边 12px
                                                        │▓▓│
                                                        │▓▓│
                                        ┌───────────┐   │▓▓│
                                        │ 账户余额   │   │▓▓│
                                        │ ¥12.34    │   │▓▓│
                                        │ 本任务已花 │   └──┘
                                        │ ¥0.42     │
                                        │ 预计还需   │   ← 悬停/聚焦时弹出的卡片
                                        │ ¥0.90–2.30│      （竖条左侧 76px）
                                        │ ⚠ 预计不足 │
                                        └───────────┘
```

- 竖条：`position: fixed; right: 12px; top: 84px; bottom: 26px; width: 16px`，悬停/卡片打开时
  加宽到 22px。`pointer-events` 只开在条和胶囊上，不挡 GUI 任何控件。
- 胶囊：横向 `¥12.34`，贴在竖条左侧（`right: 34px`）。**数字永远横排**，不做竖排。
- 标记：预测不足时胶囊右端出现一个 6px 静态圆点（红色），无动画。
- 卡片：只在悬停 / 键盘聚焦时出现，`pointer-events: none`（纯展示）。
- 层级 `z-index: 30`，在 `shell.overlay` 内，不抢主面板。

> 备注：DSH 的 slot 目录里还有 `rightbar` / `rightbar.session` 这类真正的右侧栏座位。
> 如果你之后改主意，想让余额成为右侧栏里的一个固定面板而不是贴边条，接入点就是那里；
> 本方案按已确认的「贴边悬浮竖条」实现。

### 1.2 余额色带（本次与旧插件的差异）

| 余额（账号币种，默认 CNY） | 色调 | 语义 | 竖条填充 |
|---|---|---|---|
| `< 10` | **红** `#ff5a5a → #c81f3c` | 即将余额不足 | 按比例 |
| `10 ≤ x < 30` | **橙** `#ffb24a → #e07810` | 建议充值 | 按比例 |
| `30 ≤ x ≤ 50` | **绿** `#4ce08a → #12915c` | 正常 | 按比例 |
| `x > 50` | **蓝** `#7cb0ff → #2563eb` | 余额充足 | 满格 + 超出部分蓝色波纹 |

- 边界规则：`10.00` 是橙、`30.00` 是绿、`50.00` 仍是绿、`50.01` 起变蓝。
- 刻度上限 `SCALE_LIMIT = 50`：`x > 50` 时填充 100%，剩余金额用持续流动的浅蓝紫波纹
  （`#cddcff` 波峰 / `#8fb0ff` 水体，沿用现有实现，尊重 `prefers-reduced-motion`）。
- 蓝带只表示「> 50 元」，与预测是否充足**无关**：预测不足只由标记 + 卡片表达，
  条的颜色始终只反映余额档位（这是 §0-#6 的约束）。

### 1.3 卡片内容

运行中（有 active turn）：

```
账户余额                       ¥12.34
──────────────────────────────────────
本任务已花                     ¥0.42
预计还需                ¥0.90 – ¥2.30
⚠ 预计不足，缺口 ¥0.65
──────────────────────────────────────
估算依据    8 步 · 缓存命中 95%（实测）· 峰时价
模型        deepseek-flash
更新于      12 秒前
点击竖条立即刷新
```

空闲（无 active turn）时，「本任务」三行换成：

```
下一任务预计           ¥0.40 – ¥1.10
（按本会话最近 3 轮均值）
```

状态行优先级（只显示最严重的一条）：

1. `未登录账号`：卡片显示「在 DSH 账号设置里登录后显示余额」，不显示任何预测。
2. 余额读取失败：保留上次成功读数，提示「更新失败 · 12 分钟前」。
3. `⚠ 预计不足，缺口 ¥X`：红字。
4. `⚠ 预计可能不足`：最大估值为上限仍可能超支时（黄字）。
5. 子代理提示：「另有子代理运行中，其消耗未计入预测」（灰字）。
6. 模型未知：「未知模型，按 deepseek-flash 估价」（灰字）。

### 1.4 状态矩阵

| 账号 | 用量数据 | 竖条 | 胶囊 | 标记 | 卡片 |
|---|---|---|---|---|---|
| 已登录 | 可用（运行中） | 色带 + 实时比例 | `¥x.xx` | 按预测 | 完整预测 |
| 已登录 | 可用（空闲） | 色带 | `¥x.xx` | 按预估值 | 下一任务预估 |
| 已登录 | 不可用（投影缺失） | 色带 | `¥x.xx` | 无 | 只显示余额 + 「用量数据不可用」 |
| 已登录 | 余额读取失败 | 上次色带 | `¥x.xx` | 无 | 余额 + 失败说明 |
| 未登录 | — | 灰 `#8b8b8b → #c9c9c9` | `未登录账号` | 无 | 登录指引 |
| 账号服务缺失 | — | 灰 | `余额不可用` | 无 | 说明插件需要 DSH 账号 |

读数为 0 / 无数据时显示 `读取中…`，不显示 `¥0.00`（避免误读成没钱）。

---

## 2. 架构

### 2.1 两半分工

```
Host 半（src/index.ts，Node/TS）
  ctx.inject(['deepseekAccount'])         → 账号态 + 余额（令牌只在 Host）
  ctx.sessionProjections.stateOf(...)     → tokenUsage / contextPressure / modelSelection
  ctx.on('session/event', ...)            → turn/start、assistant/message.usage、turn/end
  ├─ GET /dsh-balance-guard/state         → 浏览器轮询的只读 JSON 快照
  └─ globalThis.__DSH_BALANCE_GUARD__     → index 注入，首帧就有真实数字

浏览器半（src/client.js，单文件，无构建）
  window.__ModuleLoader__.load({ id, factory })
  ctx.slots.inject('shell.overlay')       → 竖条 + 胶囊 + 静态标记 + 悬停卡片
  fetch('/dsh-balance-guard/state')       → 运行中 1s / 空闲 15s / 点击立即
```

**为什么必须有 Host 半？** 三件事浏览器做不了：

1. DSH 账号令牌只在 Host（`ctx.deepseekAccount` 的 `getBalance` 要发 Platform 请求）；
2. 每轮计费 token 的折叠（`session/event` 的 `assistant/message.usage`）是 Host 侧的会话日志；
3. `shell.overlay` 的注入面**不含** `useProjection`，浏览器拿不到会话投影，只能向 Host 要。

**服务依赖策略（不能让 fiber 挂起等一个缺席的服务）**：

| 服务 | 依赖方式 | 缺席时 |
|---|---|---|
| `webServer` | 必需（`inject`） | 插件不激活（没有路由就没有数据通路） |
| `deepseekAccount` | 可选（`ctx.get('deepseekAccount')`） | 灰色「余额不可用」条 |
| `sessionProjections` | 可选（`ctx.get('sessionProjections')`） | 只显示余额，不显示预测 |
| `webServer.register` / `index-inject` | 必需的既有 seam | 同 `webServer` |

Cordis 的 `inject` 数组是「必需依赖，缺席就等待」，所以可选服务一律走 `ctx.get()` / `ctx.inject([...])`，
否则一个没有账号服务的 Web 组合会让整个插件永远不加载。

**为什么用自建 HTTP 路由而不是 `@Remote`？** Remote 方法由 Typert 构建流水线从 Host 装饰器生成，
插件不在 Harness 构建内，必须自带线协议；路由走 `ctx.webServer.register({kind:'exact'})`，
前缀 `/dsh-balance-guard`，**不放在 `/api` 下**（那是 Connection 插件认证的载体）。
路由只回聚合数字，不含对话内容、不含令牌；shipped Web 组合只绑回环地址。

### 2.2 数据流

```
                    ┌────────────────────────────── Host ──────────────────────────────┐
session/event ─────▶│ turn 折叠器（每会话）：本 turn 的 4 桶 token、步数、output、模型     │
turn/start/end      │      ↓                                                           │
tokenUsage 投影 ───▶│ 成本估算器（policy.js 纯函数）→ 已花 / 剩余区间 / 不足判定        │
contextPressure ───▶│      ↑                                                           │
modelSelection ────▶│ 价目表 + 汇率 + 峰谷判定                                          │
deepseekAccount ───▶│ 余额轮询（30s，缓存 25s，失败保留上次）                            │
                    └──────────────────────────────┬───────────────────────────────────┘
                                                   │ JSON（只读、同源、无令牌）
                                        ┌──────────▼──────────┐
                                        │ 浏览器：竖条/胶囊/卡片 │
                                        └─────────────────────┘
```

时钟、价格、峰谷、阈值**全部在 Host 判定**，浏览器只负责「快照 → 像素」。
这样阈值只有一份实现（可被 node 直接单测），也避免浏览器缓存里的旧规则与 Host 打架。

---

## 3. 数据源与接口（已核对 DSH 0.1.5-rc.2 实现）

### 3.1 余额：`ctx.deepseekAccount`

| 能力 | 签名 / 说明 |
|---|---|
| `getState()` | 账号态（已登录 / 未登录），不进 Platform |
| `getBalance(client)` | `AccountClientMetadata { version, locale, timezoneOffsetSeconds }` → 余额或 `null` |
| `watch(signal)` | 账号态变化流（登录/退登/切号） |
| `signOut` / 登录入口 | 不调用；插件只读，登录仍由 DSH 账号设置页负责 |

- 余额来源：Platform `GET /api/v0/users/get_user_summary`，Host 只投影
  `normal_wallets` / `bonus_wallets` 的 `currency` + `balance` 字符串。
- 币种：`CNY` / `USD` 二选一；币种随账号钱包，插件不换算账号币种，只按账号币种显示。
- 超时：余额请求默认 30s（`balanceTimeoutMs`）；超时返回失败，**不清零、不伪造 0**。
- 「已花余额」拆分：`normal`（充值余额）+ `bonus`（赠金余额），卡片可各显示一行（可选）。
- **元数据从哪来**：客户端首次轮询时把 `locale`（`ctx.locale` 或 `navigator.language`）、
  `version`（`window.__DSH_BOOT__` 的版本，取不到用配置值）、`tz`（`-new Date().getTimezoneOffset()*60`）
  作为查询参数带上；Host 缓存最近一份用于 `getBalance`。这些值只影响 Platform 的客户端请求头，
  不参与鉴权。

### 3.2 用量：`ctx.sessionProjections`

| 投影 | 形状 | 用途 |
|---|---|---|
| `tokenUsage` | `{ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`，**整份会话日志的累计值** | 本 turn 已花：`turnStartBaseline` 之后的增量 |
| `contextPressure` | `{ pressureTokens?, projectedTokens?, contextWindow? }` | `projectedTokens` = 下一次请求的 prompt 大小（provider 锚定），用来估未来每步成本 |
| `modelSelection` | 当前 provider / model | 选价目表行（跨模型切换即时生效） |
| `title` | 会话标题 | 卡片里区分多会话 |

### 3.3 会话事件：`ctx.on('session/event', (session, event) => …)`

```
turn/start        { turn }                                   → 重置本 turn 折叠器，记 baseline
step/start        { turn, step }
assistant/message { turn, step, usage?, interrupted? }       → 计费 token 累加（重试算多次）
step/end          { turn, step }
turn/end          { turn, reason }                           → 冻结本轮结算值，留作空闲预估
```

`assistant/message.usage` 是 provider 真实计费口径；`tokenUsage` 投影的最终样本会替换同一次尝试的
流式估算（`llm/retry-started` 结束替换范围），所以**用投影的增量而不是自己数事件**，
重试/流式才不会重复计费。turn 折叠器只负责「记下 turn 开始时的累计值」。

### 3.4 余额滞后补偿

平台余额通常滞后数十秒到数分钟才反映刚发生的消耗。若直接拿余额比预测，会出现
「余额看起来够、其实已经开始扣」的乐观误判。处理：

```
effectiveBalance = balance − Σ(本次读数 fetchedAt 之后已结算的 turn 成本)
```

即：用余额读取时间之后的实测成本做减法（只减、只增安全）。该补偿可配置关闭（§9）。

---

## 4. 价格模型

### 4.1 官方价目表（默认值，来源见文末）

单位：**美元 / 1M tokens**。DeepSeek 峰谷同价模型，峰时 = 谷时 × 2：

| 模型 | 时段 | 输入·缓存命中 | 输入·未命中 | 输出 |
|---|---|---|---|---|
| `deepseek-flash` | 谷时 | 0.003 | 0.15 | 0.60 |
| `deepseek-flash` | 峰时 | 0.006 | 0.30 | 1.20 |
| `deepseek-v4-pro` | 谷时 | 0.022 | 0.66 | 1.98 |
| `deepseek-v4-pro` | 峰时 | 0.044 | 1.32 | 3.96 |

- **峰时窗口**：UTC `01:00–04:00` 与 `06:00–10:00`，周一至周五，排除中国法定节假日；
  其余时间（含周末、节假日全天）为谷时。
- **节假日**：离线拿不到官方日历，配置项 `holidays`（`YYYY-MM-DD` 列表，默认空）。
  未配置时，工作日峰时窗口一律按**峰时**计价（保守，宁可高估成本）。
- **缓存写入**：DeepSeek 不单独收缓存写入费；`cacheWriteTokens` 按未命中价计（对非 DeepSeek
  路由也成立的方向性假设）。
- **未知模型**：回落到 `deepseek-flash` 价目，卡片标注「未知模型，按 deepseek-flash 估价」。
- **价格漂移**：价目表集中在 `src/policy.js` 的 `PRICE_TABLE`，文件头写明抓取日期与来源 URL；
  测试里钉死当前数值，改价必须同时改测试（防止静默漂移）。

### 4.2 汇率

```
cnyPerUsd = 7.2   // 配置项，默认 7.2；官方价目表是美元，账号余额多为人民币
```

所有金额先用美元算，再乘汇率转人民币。若账号钱包币种是 `USD`，跳过换算直接显示美元。
价目表也可整表覆盖成人民币（配置项 `priceTableOverride`），避免极端汇率假设影响判断。

### 4.3 计费粒度与取整

- 内部一律用「美元浮点」计算，展示时 `¥` 保留 2 位；`< ¥0.01` 显示 `<¥0.01`。
- 估算区间展示保留 2 位；不足判定用未取整值，避免 `0.004` 被显示成 `0.00` 后误判。

---

## 5. 任务成本预测算法

全部是 `src/policy.js` 里的纯函数，输入是数字、输出是数字，无 IO，可被 node 直接单测。

### 5.1 输入

| 符号 | 含义 | 来源 |
|---|---|---|
| `spent` | 本 turn 已花（4 桶） | `tokenUsage` 增量 |
| `P0` | 下一次请求的 prompt tokens | `contextPressure.projectedTokens`；缺失时用 `pressureTokens`，再缺失用 `contextBreakdown` 三项和 + 步均增长 |
| `G` | 每步 prompt 增长 | 本 turn 实测 `ΔP/步`；不足 2 步时用配置 `assumedGrowthTokens` |
| `O` | 每步输出 tokens（含推理） | 本 turn 已完成步的 `outputTokens / steps`；无则配置 `assumedOutputTokens` |
| `H` | 缓存命中率 | 本 turn 实测 `cacheRead / (cacheRead+cacheWrite+uncached)`，clamp `[0, 0.98]`；无则配置 `assumedCacheHit` |
| `N` | 预计剩余步数 | 本会话已完成 turn 的步数均值（最近 10 轮）；不足 2 轮时配置 `assumedSteps` |
| `peak` | 当前是否峰时 | §4.1 |

### 5.2 公式

单步成本（美元）：

```
promptCost(p) = p × [H × hitPrice + (1 − H) × missPrice] / 1e6
outputCost(o) = o × outPrice / 1e6
stepCost(k)   = promptCost(P0 + (k−1) × G) + outputCost(O)      // k = 1..N
```

已花（美元）：

```
spentUsd = (uncached × missPrice + cacheRead × hitPrice
          + cacheWrite × missPrice + output × outPrice) / 1e6
```

剩余区间：

```
remainingMin      = stepCost(1)                       // 只算下一步
remainingExpected = Σ k=1..N   stepCost(k)            // N = 预计剩余步数
remainingMax      = Σ k=1..2N  stepCost(k)            // 步数翻倍
                   其中 max 用更差的假设：H' = max(0, H − 0.1)，若当前谷时则按峰时价
```

换算人民币后：

```
spentCny      = spentUsd × fx
remainingCny  = remainingXxxUsd × fx
totalExpected = spentCny + remainingExpectedCny
```

### 5.3 区间语义

- **min**：立刻结束也要再跑一步（不能为 0，否则「余额够一步」永远显示充足）。
- **expected**：按本会话历史步数均值走完。
- **max**：步数翻倍 + 缓存命中下降 10pp + 若在谷时按峰时价（跨峰谷的保守上界）。

区间宽度本身就是诚实的置信度表达：步数无历史（用默认 8）时卡片加注「步数按默认值估算」。

### 5.4 算例（可写成测试用例）

`deepseek-flash`，峰时，`fx = 7.2`，本 turn 已 2 步：
`uncached = 30k, cacheRead = 900k, output = 25k`，`P0 = 350k`，`G = 25k`，`O = 12k`，
`H = 0.95`，`N = 6`：

```
spentUsd = (30k×0.30 + 900k×0.006 + 25k×1.20) / 1e6 = 0.0444 USD  → ¥0.32
stepCost(1) = 350k×0.0207/1e6 + 12k×1.2/1e6 = 0.0216 USD
stepCost(2..6) ≈ 0.0222 … 0.0242                    Σ ≈ 0.1376 USD → ¥0.99
remainingMin = ¥0.16   remainingExpected = ¥0.99
remainingMax（12 步 · 命中 0.85 · 峰时）≈ 0.4659 USD → ¥3.35
required = 0.99×1.2 + 2 = ¥3.19
若 effectiveBalance = ¥1.10 → gap = ¥2.09，判定「预计不足」
```

### 5.5 空闲时的预估

没有 active turn 时，用会话最近 3 轮 `turn` 的总成本均值（含区间：取 min/max）作为
「下一任务预计」。刚结束的轮次权重最高。会话从未跑过任何轮次时，显示
「暂无历史，无法预估」而不是编一个数。

---

## 6. 不足判定与提醒

### 6.1 判定

```
requiredCny  = remainingExpectedCny × (1 + SAFETY_RATIO) + MIN_RESERVE_CNY   // 1.2, 2
insufficient = effectiveBalanceCny <= requiredCny      // 等于也判不足，不留边界灰度
gapCny       = requiredCny − effectiveBalanceCny
```

- 只比较**剩余成本**，不把已花再加一遍（已花已经从余额里扣掉了）。
- 两个级别（卡片文案）：
  - `insufficient`（红）：连预期都撑不到 → 「预计不足，缺口 ¥X」+ 胶囊红点；
  - `risky`（黄）：`effectiveBalance < remainingMaxCny` 但撑得到预期 → 「可能不足，最坏情况还差 ¥X」，
    不出现胶囊圆点（避免频繁误报）。

### 6.2 视觉与可访问性

- 胶囊标记：6px 静态圆点，`aria-label="预计余额不足"`；不闪烁、不呼吸（§0-#6）。
- 卡片警告行：`role="status"`，颜色用 `--dsw-alias-state-error-primary` / 琥珀语义 token。
- 竖条：`role="progressbar"`，`aria-valuemin=0 / max=50 / now=min(total,50)`，
  `aria-label="账户余额 ¥x.xx，本任务预计还需 ¥a – ¥b"`。
- 键盘可达：竖条 `tabIndex=0`，Enter/Space 立即刷新；焦点即展开卡片。
- 减少动效：`prefers-reduced-motion: reduce` 时关闭波纹动画与所有过渡。

---

## 7. 刷新与实时性

| 触发 | 行为 |
|---|---|
| 页面加载 | 先用 `__DSH_BALANCE_GUARD__` 首帧快照绘制，再拉一次 `/state` |
| 运行中（有 active turn） | 浏览器每 **1s** 拉 `/state`；Host 只做内存折叠，不请求 Platform |
| 空闲 | 浏览器每 **15s** 拉一次（拾取「上一轮结算」变化） |
| 余额 | Host 每 **30s**（`balancePollMs`）调一次 `getBalance`；读数缓存 25s，路由命中可提前刷新 |
| 点击竖条 / 打开卡片 | 立即拉 `/state`（余额缓存过期才真正请求 Platform） |
| 账号态变化 | `watch()` 触发 → 清空余额缓存并重拉 |
| turn 起止 | Host 立即更新快照；浏览器下一次 1s 轮询即可看到 |

- 1s 轮询是**纯内存**读取，不会给 Platform 带来压力；余额仍受 30s 节流。
- 页面隐藏（`document.hidden`）时降频到 15s，避免后台浪费。

---

## 8. 生命周期、安装与「随客户端启动」

- **加载方式**：DSH Loader 行（`cordis.patch.yml`），指向 `src/index.ts` 的绝对 `file://` URL；
  浏览器半由 client-module 扫描器按 `package.json` 的 `dsh.client` 声明自动服务，**无构建步骤**。
- **随客户端启动**：`scripts/install.mjs` 把这一行写进 `$DSH_HOME/profiles/web/cordis.patch.yml`；
  Web profile 的补丁层是 `patchReload: live`，写入后刷新页面即生效，**下次启动自动加载**。
  无需 `pnpm add`、无 `node_modules` 条目。
- **首帧**：Host 在 `webserver/index-inject` 里注入 `__DSH_BALANCE_GUARD__`（最近一次快照），
  条不会先闪一帧空条。
- **卸载**：删除 patch 行 → fiber 卸载 → 路由注销、样式与 DOM 随 effect 回收；不留残影。
- **与旧插件共存**：两个都装会叠两根条。旧插件保留在仓库、不启用；README 里明确二选一。

---

## 9. 配置项（`cordis.patch.yml` 的 `config`）

| Key | 默认 | 说明 |
|---|---|---|
| `safetyRatio` | `0.2` | 安全系数（§6.1） |
| `minReserveCny` | `2` | 最低保留额（以账号币种单位计；USD 账号即 $2，更保守） |
| `balanceTtlMs` | `25000` | 余额读数缓存 |
| `balancePollMs` | `30000` | 余额轮询周期 |
| `balanceTimeoutMs` | `30000` | 单次 `getBalance` 超时 |
| `runningPollHintMs` | `1000` | 给客户端的轮询建议值（快照里下发） |
| `idlePollMs` | `15000` | 空闲轮询 |
| `cnyPerUsd` | `7.2` | 汇率 |
| `assumedSteps` | `8` | 无历史时的剩余步数 |
| `assumedOutputTokens` | `1200` | 无历史时每步输出 |
| `assumedGrowthTokens` | `4000` | 无历史时每步 prompt 增长 |
| `assumedCacheHit` | `0.85` | 无历史时缓存命中率 |
| `holidays` | `[]` | 中国法定节假日（`YYYY-MM-DD`），影响峰谷判定 |
| `balanceLagCompensation` | `true` | 余额滞后补偿（§3.4） |
| `clientVersion` | `''` | 客户端上报版本缺失时的兜底值 |

---

## 10. 文件结构与测试

```
dsh-balance-guard/
  package.json            # type: module, main: src/index.ts, dsh.client.platform: web
  cordis.patch.yml        # Loader 行（绝对 file:// URL + 上面的 config）
  src/
    policy.js             # 纯函数：色带、价目、峰谷、成本估算、不足判定（唯一真源）
    index.ts              # Host：账号轮询、turn 折叠、快照组装、路由、首帧注入
    client.js             # 浏览器：竖条/胶囊/标记/卡片 + 轮询 + 样式
  scripts/
    policy-spec.mjs       # 色带边界、峰谷、估价公式、算例复现、区间单调性
    client-spec.mjs       # 快照 → 像素：比例/超出/色调/格式化/标记显隐
    client-smoke.mjs      # 用 stub 的 __ModuleLoader__ 加载整个 bundle
    host-smoke.mjs        # mock ctx + 假 account + 假 session 事件，驱动真实路由
    theme-tokens.mjs      # 每个 var(--dsw-*) 都必须在 ui-theme 里声明
    install.mjs           # 写 profile patch（幂等，可 --dry-run）
    verify-deployed.mjs   # 只读探针：真实 GUI 是否在服务这个 bundle
  README.md
  DESIGN.md
```

测试要覆盖的关键断言：

1. **色带边界**：`9.99→红`、`10→橙`、`29.99→橙`、`30→绿`、`50→绿`、`50.01→蓝`。
2. **峰谷**：UTC 周一 02:00 峰时、周一 05:00 谷时、周六 02:00 谷时、配置节假日后谷时。
3. **估价**：§5.4 算例逐项复现（容差 1e-9）；`min ≤ expected ≤ max`；步数/输出翻倍时成本单调增。
4. **不足判定**：`required = remaining × 1.2 + 2`；余额刚好相等时判「不足」（不留边界灰度）。
5. **余额滞后补偿**：读数之后发生的成本被减掉；关闭开关后不再减。
6. **快照投影**：Host 只向外发聚合数字（断言 JSON 里没有 prompt/消息文本字段）。
7. **主题令牌**：所有 `--dsw-*` 引用在真实主题里有声明（旧插件曾因此把卡片画成半透明灰）。
8. **部署探针**：真实 GUI 的 boot graph 里有 `dsh-balance-guard`，且 bundle 含关键标记。

验收标准：

- 登录状态下启动客户端 → 3 秒内竖条出现并显示正确金额；断网/超时保留上次读数。
- 运行一轮任务时，卡片「本任务已花」随步骤增长（≤1.5s 延迟），「预计还需」给出区间。
- 余额低于判定线 → 胶囊出现红点 + 卡片红字缺口，且不弹窗、不发声、条色不变。
- 未登录 → 灰色「未登录账号」条，不显示任何金额。
- 卸载 patch 行后刷新 → 条与卡片完全消失，无残留样式/路由。

---

## 11. 风险与限制（如实写进 README）

1. **预测不是账单**。剩余步数、缓存命中率、tool 输出大小都是估计；区间宽度就是误差范围。
   契约是「提前给量级 + 风险提示」，不是「精确到分」。
2. **余额滞后**：Platform 余额更新有延迟，已用「读数后成本补偿」缓解，但补偿本身也是实测值。
3. **峰谷与节假日**：节假日不在线可得，默认按峰时算（保守高估）；配置节假日后更准。
4. **子代理不计入**（§0-#12）：并行子代理会真实扣费，卡片只提示、不并入预测，存在低估。
5. **多会话**：宿主只暴露「最近活跃的根会话那一轮」；同时跑多个会话时数字会切到最近活跃者，
   卡片用会话标题标明。
6. **价格漂移**：官方明确可能调价；价目表带抓取日期，改价是改一个常量 + 一条测试。
7. **账号服务缺失**：非 Desktop / 未组合账号服务的环境降级成灰色条，不报错、不消失。
8. **币种**：账号钱包为 USD 时直接显示美元；不做跨币种汇率显示（避免双重换算误差）。
9. **路由暴露**：只读聚合数字、同源、无令牌；shipped Web 组合只绑回环，不接受外部访问。

---

## 12. 实施里程碑

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| M1 | `policy.js` + `policy-spec` | 色带/峰谷/估价/判定全部用例通过 |
| M2 | Host 半 + `host-smoke` | mock ctx 下路由返回完整快照；假账号/假事件驱动正常 |
| M3 | 浏览器半 + `client-spec` / `client-smoke` / `theme-tokens` | 五态矩阵渲染正确；无未解析主题令牌 |
| M4 | 安装脚本、`verify-deployed`、README | 真实 GUI 探针通过：启动即有余额、预测随任务更新 |

---

## 13. 仍待你确认（不影响 M1 开工）

1. **插件名**：建议 `dsh-balance-guard`（目录同名）；想叫 `dsh-balance-guard-bar` / 中文名「余额护栏」也可。
2. **卡片是否给「去充值」入口**：v1 不加（纯展示）；如果要，需要接 Platform 充值页的重定向，
   属于额外范围。
3. **是否发布**：仅在本地 profile 启用，还是也推到 GitHub 仓库（旧插件 README 里有一个仓库地址）？
4. **币种显示**：账号钱包为 USD 时按美元显示（本方案）；是否仍强制折算成人民币显示？

---

## 附：价格与接口来源

- DeepSeek 官方价目表（抓取于 2026-10-17，峰谷价与削价规则）：
  <https://api-docs.deepseek.com/quick_start/pricing/>
- DSH 账号服务（`ctx.deepseekAccount`）：余额来自 Platform `get_user_summary` 的
  `normal_wallets` / `bonus_wallets`；`AccountClientMetadata` 仅用于客户端请求头。
- DSH 用量投影（`tokenUsage` / `contextPressure` / `modelSelection`）：由 `dsh-token-meter`
  在 `ctx.sessionProjections` 注册，客户端经 `useProjection` 读取；`shell.overlay` 不注入该 hook，
  因此本插件走自建路由。

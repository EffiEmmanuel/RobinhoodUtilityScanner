# PRD — UtilityScout Autonomous Trading & Learning Extension

**Version:** 1.0
**Status:** Build-ready add-on PRD
**Purpose:** Extend the existing UtilityScout discovery/research system with autonomous trade planning, execution, position management, portfolio risk controls, full trade journaling, outcome tracking, and a learning/backtesting layer.
**Primary Stack:** TypeScript, Node.js, PostgreSQL, Prisma, Redis/BullMQ, viem, Docker
**Target Chain:** Robinhood Chain
**Execution Model:** Dedicated bot wallet + approved on-chain swap execution provider
**Default Trading Mode:** `SHADOW`
**Important:** This PRD is an extension of the existing UtilityScout PRD, not a replacement.

---

# 1. Product Summary

UtilityScout already discovers and researches utility-focused tokens. This extension turns qualified candidates into managed trade opportunities.

The target workflow is:

```text
TOKEN DISCOVERED
      ↓
UTILITY / QUALITY RESEARCH
      ↓
QUALIFIED CANDIDATE
      ↓
MARKET + CHART ANALYSIS
      ↓
TRADE PLAN
      ↓
TARGET ENTRY SET
      ↓
WAIT FOR ENTRY
      ↓
REVALIDATE BEFORE BUY
      ↓
POSITION SIZE
      ↓
AUTONOMOUS BUY
      ↓
LIVE POSITION MONITORING
      ↓
TAKE PROFIT / RISK EXIT
      ↓
TRADE CLOSED
      ↓
FULL OUTCOME STORED
      ↓
POSTMORTEM + LEARNING
      ↓
BACKTEST STRATEGY IMPROVEMENTS
```

The system must record **every candidate, every trade decision, every execution, and every outcome**, including skipped and rejected opportunities, so later strategy improvements are based on real historical evidence.

---

# 2. Core Product Principles

1. AI must never be the only component deciding whether to buy or sell.
2. Final trade actions must pass deterministic risk and execution rules.
3. Never risk the entire portfolio automatically.
4. Use a dedicated bot wallet with intentionally limited funds.
5. Never expose a wallet private key to an LLM.
6. Every decision must be auditable later.
7. Store missed and rejected opportunities, not only executed trades.
8. Build paper/shadow trading before enabling live trading.
9. Strategy changes must be versioned, backtested, shadow-tested, and explicitly promoted.
10. Never allow the system to autonomously rewrite its own production trading rules.

---

# 3. Goals

The extension should:

- Generate structured trade plans for qualified tokens.
- Determine whether a token should be bought now, waited on, watched, or rejected.
- Read structured candle and market data rather than relying primarily on screenshots.
- Set a target market-cap/price entry zone.
- Wait 24/7 for the target entry.
- Revalidate the token before buying.
- Dynamically size positions based on account balance, risk, liquidity, project quality, and confidence.
- Execute buys autonomously in live mode.
- Monitor positions continuously.
- Support partial profit-taking.
- Support early exits when risk deteriorates.
- Support trailing exits and time-based exits.
- Maintain reserve capital.
- Track portfolio milestones and send congratulations emails.
- Store every trade and skipped candidate for later analysis.
- Track MFE/MAE, peak multiple, drawdown, and time-to-target.
- Support strategy versioning and backtesting.
- Eventually support tabular ML models trained on the private historical dataset.

---

# 4. Non-Goals

V1 must not:

- Use leverage, margin, or borrowed money.
- Trade with 100% of wallet equity.
- Automate a Fomo web account UI.
- Auto-transfer more money from another wallet.
- Allow arbitrary token approvals.
- Allow arbitrary contract interactions.
- Let AI change wallet limits.
- Let AI bypass stop/circuit-breaker logic.
- Let AI directly handle the private key.
- Trade tokens that failed the existing UtilityScout research pipeline.
- Trade multiple chains in V1.
- Guarantee any fixed return such as 2x or 2.5x.

---

# 5. Trading Modes

The system must support:

```text
DISABLED
PAPER
SHADOW
LIVE
```

## DISABLED
Research continues, trading extension does nothing.

## PAPER
Simulate entries and exits using historical/live prices. No signing.

## SHADOW
Run the complete real-time decision pipeline as if live, including target entries and exits, but never sign transactions.

## LIVE
Allow wallet signing and real trade execution after all checks pass.

Environment:

```env
TRADING_MODE=SHADOW
```

The application must **default to SHADOW** if trading mode is unset.

`LIVE` must require an explicit valid config and should fail closed if any required secret or risk config is missing.

---

# 6. High-Level Architecture

```text
Existing UtilityScout
        ↓
        ▼
Qualified Token Candidate
        ↓
        ▼
Trade Candidate Service
        ↓
        ▼
Market Data + Technical Engine
        ↓
        ▼
AI Market Interpretation
        ↓
        ▼
Deterministic Trade Plan Validator
        ↓
        ▼
Pending Entry Monitor
        ↓
        ▼
Entry Triggered
        ↓
        ▼
Final Revalidation
        ↓
        ▼
Risk + Position Sizing Engine
        ↓
        ▼
Execution Preflight
        ↓
        ▼
Execution Provider
        ↓
        ▼
Bot Wallet
        ↓
        ▼
Position Manager
        ↓
        ├── profit targets
        ├── trailing exit
        ├── risk exit
        ├── time exit
        └── manual emergency exit
        ↓
        ▼
Trade Outcome
        ↓
        ▼
Postmortem + Analytics + Backtesting
```

---

# 7. Execution Architecture

Do not use Playwright to log into Fomo and click trade buttons.

Use:

```text
Dedicated Bot Wallet
      ↓
Robinhood Chain
      ↓
Execution Provider Adapter
      ↓
DEX / Router
```

Recommended provider abstraction:

```ts
interface ExecutionProvider {
  getQuote(input: QuoteRequest): Promise<QuoteResult>;
  simulateSwap(input: SwapRequest): Promise<SimulationResult>;
  executeSwap(input: SwapRequest): Promise<SwapResult>;
  getTransaction(hash: `0x${string}`): Promise<TransactionResult>;
}
```

Potential implementations:

```text
PaperExecutionProvider
UniswapExecutionProvider
DirectRouterExecutionProvider
```

Business logic must not depend on a provider-specific response shape.

---

# 8. Trade Lifecycle State Machine

Trade candidates and trades must use explicit states.

## Candidate States

```text
QUALIFIED
PLANNING
WAITING_FOR_ENTRY
WATCH_ONLY
REJECTED
EXPIRED
MISSED_ENTRY
TRADED
```

## Trade States

```text
ENTRY_PENDING
ENTRY_REVALIDATING
ENTRY_APPROVED
ENTRY_SUBMITTED
OPEN
PARTIALLY_EXITED
EXIT_PENDING
EXIT_SUBMITTED
CLOSED
CANCELLED
FAILED
```

Invalid transitions must be rejected.

Example:

```text
WAITING_FOR_ENTRY
      ↓
ENTRY_REVALIDATING
      ↓
ENTRY_APPROVED
      ↓
ENTRY_SUBMITTED
      ↓
OPEN
      ↓
PARTIALLY_EXITED
      ↓
CLOSED
```

---

# 9. Candidate Eligibility

A token may only become a trade candidate if it already passed UtilityScout's research layer.

Required minimum inputs:

- `finalProjectScore`
- `researchConfidence`
- `contractSafetyScore`
- `liquidityScore`
- `marketScore`
- `hardReject`
- token age
- market cap
- liquidity
- pair address
- current sellability
- project links and research evidence

Configurable gates:

```env
MIN_TRADE_QUALITY_SCORE=80
MIN_TRADE_RESEARCH_CONFIDENCE=65
MIN_TRADE_CONTRACT_SCORE=75
MIN_TRADE_LIQUIDITY_USD=15000
```

Hard rule:

```text
hardReject == true → NEVER TRADE
```

---

# 10. Market Data Engine

Use structured market data whenever possible.

Collect:

- OHLCV candles
- current price
- current market cap
- FDV
- liquidity
- pair age
- buy/sell count
- buy/sell volume
- 5m / 1h / 6h / 24h volume
- price change
- liquidity change
- holder count where available
- quote depth / expected price impact

Recommended candle intervals:

```text
1m
5m
15m
1h
```

Store candles or normalized snapshots in the DB for later replay/backtesting.

---

# 11. Technical Feature Engine

Initial features:

```text
EMA 9
EMA 20
EMA 50
VWAP
RSI 14
ATR
recent swing high
recent swing low
support zones
resistance zones
volume moving average
volume acceleration
buy/sell ratio
distance from VWAP
distance from recent high
distance from recent low
drawdown from recent high
market-cap velocity
liquidity / market-cap ratio
```

Do not add dozens of indicators in V1.

---

# 12. Market Regime Classification

Classify candidates into:

```text
EARLY_DISCOVERY
BREAKOUT
PULLBACK
RETEST
CONSOLIDATION
TRENDING_UP
TRENDING_DOWN
PARABOLIC
DISTRIBUTION
LOW_LIQUIDITY
CHOPPY
UNKNOWN
```

This may combine deterministic rules and AI interpretation.

AI output must be validated with Zod.

---

# 13. Support / Resistance Detection

V1 may use:

- pivot highs/lows
- breakout levels
- previous consolidation
- recent high-volume zones
- VWAP
- EMA structure
- local swing structure

Example output:

```json
{
  "currentMarketCap": 184000,
  "primarySupportMin": 146000,
  "primarySupportMax": 154000,
  "secondarySupport": 128000,
  "primaryResistance": 212000,
  "state": "EXTENDED_ABOVE_SUPPORT"
}
```

---

# 14. Trade Plan Generator

Every candidate must result in one of:

```text
BUY_NOW
WAIT_FOR_ENTRY
WATCH_ONLY
REJECT_TRADE
```

Example:

```json
{
  "action": "WAIT_FOR_ENTRY",
  "entryStyle": "PULLBACK_ENTRY",
  "currentMarketCap": 184000,
  "targetEntryMarketCapMin": 148000,
  "targetEntryMarketCapMax": 155000,
  "doNotChaseAboveMarketCap": 172000,
  "technicalInvalidationMarketCap": 126000,
  "firstProfitTargetMultiple": 2.0,
  "secondaryProfitTargetMultiple": 2.5,
  "maxHoldingMinutes": 1440,
  "riskScore": 28,
  "confidence": 78,
  "reasoning": [
    "Project quality is high",
    "Current price is extended above nearby support",
    "Target zone aligns with breakout retest",
    "Liquidity remains acceptable"
  ]
}
```

---

# 15. Entry Styles

Support:

```text
MARKET_ENTRY
PULLBACK_ENTRY
BREAKOUT_RETEST_ENTRY
```

## MARKET_ENTRY
Use only when the asset is not materially overextended.

## PULLBACK_ENTRY
Preferred for strong projects where current price is extended.

## BREAKOUT_RETEST_ENTRY
Wait for a breakout and successful retest before entry.

---

# 16. Pending Entry Monitor

For `WAIT_FOR_ENTRY` plans, persist a pending entry and monitor 24/7.

Monitor:

- price
- market cap
- liquidity
- volume
- buy/sell pressure
- contract risk
- deployer activity where available
- sellability
- plan expiration

Default plan TTL:

```env
DEFAULT_ENTRY_PLAN_TTL_MINUTES=360
```

Expired plans must be re-analyzed before reuse.

---

# 17. Final Revalidation Before Buy

When the target entry is reached, **do not buy immediately**.

Run final checks:

- token is still sellable
- contract risk has not worsened
- liquidity has not collapsed
- major holder/deployer dumping not detected
- buy/sell conditions are not catastrophic
- website/social presence has not disappeared unexpectedly
- target was reached through a plausible pullback, not a collapse
- fresh quote exists
- slippage is acceptable
- price impact is acceptable
- wallet gas is sufficient
- portfolio risk limits still allow the trade

Result:

```text
APPROVED
DEFER
REJECTED
```

---

# 18. Catastrophic Drop Detection

A price reaching support because the project is collapsing must not trigger a buy.

Potential rejection combinations:

```text
sharp price drop
+
liquidity collapse
```

or:

```text
sell volume massively exceeds buy volume
```

or:

```text
deployer / whale dump detected
```

or:

```text
sell quote significantly worsens/disappears
```

Result:

```text
DO NOT BUY
```

---

# 19. Dedicated Bot Wallet

Use a separate trading wallet.

```text
Main Funds
   ↓
   └── manual transfer
           ↓
      Bot Wallet
```

The bot wallet should hold only the amount intentionally exposed to automated trading.

Never allow the trading system to automatically pull extra funds from the user's main wallet.

---

# 20. Wallet Security Requirements

- Never log the private key.
- Never store private key in PostgreSQL.
- Never expose private key through an API response.
- Never send private key to AI.
- Never put signer logic in the dashboard/frontend.
- Never let research/browser jobs access signing secrets.
- Signing logic should be isolated in the execution service.
- Verify Robinhood Chain ID before every signing operation.
- Prefer a secret manager/KMS for production later.

V1 environment:

```env
BOT_WALLET_PRIVATE_KEY=
```

---

# 21. Position Sizing

Do not use leverage.

The requested behavior should be implemented as **dynamic position sizing**.

Inputs:

- total account equity
- reserve capital
- deployable capital
- quality score
- research confidence
- trade risk score
- liquidity
- current portfolio exposure
- number of open positions
- strategy version

Concept:

```text
position =
base allocation
× quality multiplier
× confidence multiplier
× risk multiplier
× liquidity multiplier
```

Then apply hard caps.

---

# 22. Capital Buckets

Represent portfolio capital as:

```text
TOTAL EQUITY
     ↓
     ├── RESERVE CAPITAL
     │
     └── DEPLOYABLE CAPITAL
             ↓
             ├── AVAILABLE
             └── OPEN POSITIONS
```

Suggested configurable defaults:

```env
MIN_RESERVE_PERCENT=50
MAX_TOTAL_DEPLOYED_PERCENT=50
MAX_SINGLE_POSITION_PERCENT=25
MAX_OPEN_POSITIONS=2
```

These are product defaults and must remain configurable.

---

# 23. Small Account Logic

The system must explicitly support accounts such as `$20`.

Before entering:

```text
estimated gas cost / planned position
```

If gas/fees are too large relative to the trade:

```text
SKIP
```

Config:

```env
MAX_GAS_COST_PERCENT_OF_POSITION=5
```

---

# 24. Risk Buckets

Candidate risk:

```text
LOW
MEDIUM
HIGH
REJECT
```

Example policy:

```text
LOW     → larger permitted allocation
MEDIUM  → normal allocation
HIGH    → small allocation or watch only
REJECT  → no trade
```

The deterministic risk engine makes the final sizing decision.

---

# 25. Account Circuit Breakers

Required limits:

```env
MAX_DAILY_REALIZED_LOSS_PERCENT=20
MAX_CONSECUTIVE_LOSSES=3
MAX_OPEN_POSITIONS=2
MAX_TOTAL_DEPLOYED_PERCENT=50
MAX_SINGLE_POSITION_PERCENT=25
MIN_RESERVE_PERCENT=50
```

When triggered:

```text
PAUSE NEW ENTRIES
```

Open positions must continue to be monitored and exited according to safety rules.

AI may not override a circuit breaker.

---

# 26. Global Kill Switch

Must exist.

Environment:

```env
TRADING_ENABLED=false
```

DB/system setting:

```text
globalTradingPause = true
```

Every BUY must check the kill switch immediately before transaction creation/signing.

Exits should remain possible while paused.

---

# 27. Transaction Preflight

Before any live transaction:

```text
mode == LIVE?
trading enabled?
global pause false?
correct chain?
correct token?
correct wallet recipient?
router allowlisted?
quote fresh?
amount within position limit?
total exposure within limit?
reserve maintained?
gas sufficient?
slippage acceptable?
price impact acceptable?
simulation successful?
circuit breakers clear?
nonce lock acquired?
```

Any failure:

```text
DO NOT SIGN
```

---

# 28. Router / Approval Safety

- Maintain an allowlist of execution routers.
- Never approve unknown spender addresses.
- Prefer exact/limited token approvals.
- Do not automatically grant unlimited approvals unless explicitly configured and audited.
- Persist all approvals in the trade ledger.

Example:

```env
ALLOWED_ROUTER_ADDRESSES=0x...,0x...
```

---

# 29. Slippage and Price Impact

Config:

```env
DEFAULT_MAX_BUY_SLIPPAGE_BPS=300
DEFAULT_MAX_SELL_SLIPPAGE_BPS=500
EMERGENCY_MAX_SELL_SLIPPAGE_BPS=1000
MAX_BUY_PRICE_IMPACT_PERCENT=3
```

Do not automatically widen slippage because a swap failed.

If liquidity cannot support the trade within configured safety limits:

```text
SKIP / EXIT USING EMERGENCY POLICY
```

---

# 30. Gas Management

Monitor native ETH balance.

```env
MIN_GAS_BALANCE_ETH=
```

If gas balance falls below threshold:

- pause new entries
- keep exit capability if possible
- send an operator email

---

# 31. Nonce and Transaction Safety

Requirements:

- one distributed nonce lock per wallet
- persist transaction intent before broadcast
- track nonce
- recover pending transactions after restart
- prevent duplicate execution with idempotency keys
- never rely on in-memory state

Idempotency key example:

```text
tradeId:BUY:1
tradeId:SELL:1
tradeId:SELL:2
```

---

# 32. Transaction State

Execution states:

```text
CREATED
QUOTED
SIMULATED
SUBMITTED
CONFIRMED
FAILED
DROPPED
REPLACED
```

A trade is not open until the buy transaction is confirmed.

Store:

- tx hash
- block number
- gas used
- gas cost
- actual token received
- actual execution price
- slippage
- price impact
- quote
- receipt

---

# 33. Position Monitoring

Default:

```env
POSITION_MONITOR_INTERVAL_SECONDS=10
```

Monitor:

- current price
- current market cap
- liquidity
- token amount
- unrealized PnL
- realized PnL
- MFE
- MAE
- volume
- buy/sell pressure
- support/invalidation
- sell quote availability
- deployer/holder risk where available

---

# 34. Exit Types

Support:

```text
RISK_EXIT
INVALIDATION_EXIT
PARTIAL_PROFIT
PROFIT_TARGET
TRAILING_EXIT
TIME_EXIT
MANUAL_EXIT
EMERGENCY_EXIT
```

Do not use only a fixed 2.5x target.

---

# 35. Initial Profit-Taking Template

Configurable example:

```text
At 2.0x:
sell enough to recover part/all initial capital

Remaining position:
continue toward 2.5x+
or use trailing exit
```

Example config:

```json
{
  "profitSteps": [
    {
      "multiple": 2.0,
      "sellPercentOfRemaining": 50
    },
    {
      "multiple": 2.5,
      "sellPercentOfRemaining": 30
    }
  ],
  "trailRemaining": true
}
```

Actual defaults must remain configurable and strategy-versioned.

---

# 36. Partial Exits

Support multiple sell executions for one trade.

Example:

```text
BUY
SELL 50%
SELL 30%
SELL REMAINDER
```

Do not model a trade as one buy + one sell only.

---

# 37. Early Risk Exit

Potential triggers:

- liquidity removal
- major deployer sell
- whale concentration worsening
- contract safety deteriorates
- sellability deteriorates
- support/invalidation breaks
- extreme sell pressure
- volume collapse
- abnormal slippage
- hard maximum loss
- maximum holding period
- other strategy-specific rules

The AI may explain context, but risk rules remain deterministic.

---

# 38. Stop / Invalidation Logic

Support:

```text
technical invalidation
maximum tolerated loss
catastrophic loss
```

Example:

```json
{
  "technicalInvalidationMarketCap": 126000,
  "maxLossPercent": 25,
  "catastrophicLossPercent": 40
}
```

No universal fixed stop should be hard-coded across all strategies.

---

# 39. Trailing Exit

Example:

```text
activate after 1.6x
trail 20% below observed peak
```

Config:

```json
{
  "activationMultiple": 1.6,
  "trailPercent": 20
}
```

Liquidity/risk deterioration can override a normal trailing strategy.

---

# 40. Time-Based Exit

Each strategy should define a max holding period.

Example:

```text
6h
24h
48h
```

At expiry:

```text
EXIT
or
REASSESS using explicit strategy rule
```

No open position may become orphaned.

---

# 41. Sellability Watch

Periodically request a sell quote for open positions.

If quote availability disappears:

- mark severity `CRITICAL`
- persist incident
- send alert
- attempt configured emergency exit behavior where possible

---

# 42. Trade Notifications

## Candidate Plan

Subject:

```text
Trade Plan — TOKEN — Waiting for $150K MC
```

Include:

- project score
- research confidence
- current MC
- target entry zone
- do-not-chase level
- expected position size
- invalidation
- profit plan
- risks
- links

## Entry

```text
Entry Executed — TOKEN
```

Include:

- amount invested
- actual entry price
- actual entry MC
- token amount
- slippage
- transaction hash

## Partial Profit

```text
Partial Profit — TOKEN — 2.0x
```

## Closed Trade

```text
Trade Closed — TOKEN — +$X / Yx
```

Include:

- realized PnL
- multiple
- holding duration
- exit reason
- MFE
- MAE

---

# 43. Portfolio Milestone Emails

Configurable milestones:

```text
$50
$100
$200
$500
$1,000
$2,000
$5,000
```

Trigger once when realized/account equity crosses a milestone according to portfolio accounting rules.

Do not repeatedly fire if equity crosses below/above the same threshold.

Example:

```text
UtilityScout Milestone — Portfolio Hit $100
```

Include:

- starting balance
- current equity
- realized PnL
- closed trades
- win/loss count
- best trade
- reserve capital
- current deployed capital
- next milestone

---

# 44. Portfolio Accounting

Track separately:

```text
cash/native balance
open position cost basis
mark-to-market value
realized PnL
unrealized PnL
gas costs
total equity
reserve
deployable capital
```

Never use a single ambiguous `balance` value.

---

# 45. Ledger

Every financial event becomes a ledger entry.

Types:

```text
DEPOSIT
WITHDRAWAL
BUY
SELL
GAS
APPROVAL_GAS
REALIZED_PNL
MANUAL_ADJUSTMENT
```

External transfers into/out of the wallet must not silently become PnL.

---

# 46. Database Models

Add the following models to the existing Prisma schema.

## TradeCandidate

```prisma
model TradeCandidate {
  id                  String   @id @default(cuid())
  tokenId             String
  researchRunId       String?

  status              TradeCandidateStatus

  qualityScore        Float?
  researchConfidence  Float?
  marketRiskScore     Float?
  technicalScore      Float?

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  plans               TradePlan[]
  decisions           TradeDecisionSnapshot[]
  outcome             CandidateOutcome?
}

enum TradeCandidateStatus {
  QUALIFIED
  PLANNING
  WAITING
  TRADED
  WATCH_ONLY
  REJECTED
  EXPIRED
  MISSED
}
```

---

# 47. TradePlan

```prisma
model TradePlan {
  id                       String   @id @default(cuid())
  candidateId              String

  strategyVersionId        String

  action                   TradePlanAction
  entryStyle               String?

  currentMarketCap         Decimal?
  targetEntryMcapMin       Decimal?
  targetEntryMcapMax       Decimal?
  doNotChaseAboveMcap      Decimal?
  invalidationMcap         Decimal?

  estimatedPositionUsd     Decimal?
  riskScore                Float?
  confidence               Float?

  planData                 Json

  expiresAt                DateTime?
  createdAt                DateTime @default(now())
  updatedAt                DateTime @updatedAt
}

enum TradePlanAction {
  BUY_NOW
  WAIT_FOR_ENTRY
  WATCH_ONLY
  REJECT_TRADE
}
```

---

# 48. PendingEntry

```prisma
model PendingEntry {
  id                 String   @id @default(cuid())
  tradePlanId        String

  status             PendingEntryStatus

  targetMcapMin      Decimal?
  targetMcapMax      Decimal?

  lastCheckedAt      DateTime?
  triggeredAt        DateTime?
  expiresAt          DateTime?

  createdAt          DateTime @default(now())
}

enum PendingEntryStatus {
  ACTIVE
  TRIGGERED
  REVALIDATING
  APPROVED
  REJECTED
  EXPIRED
  CANCELLED
}
```

---

# 49. Trade

```prisma
model Trade {
  id                  String   @id @default(cuid())

  tokenId             String
  candidateId         String?
  tradePlanId         String?
  strategyVersionId   String

  mode                TradingMode
  status              TradeStatus

  positionSizeUsd     Decimal
  entryTokenAmount    Decimal?

  plannedEntryMcap    Decimal?
  actualEntryMcap     Decimal?
  entryPriceUsd       Decimal?

  openedAt            DateTime?
  closedAt            DateTime?

  initialQualityScore Float?
  initialRiskScore    Float?
  initialConfidence   Float?

  realizedPnlUsd      Decimal?
  realizedMultiple    Float?

  mfePercent          Float?
  maePercent          Float?

  exitReason          String?

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  executions          TradeExecution[]
  snapshots           PositionSnapshot[]
  exitSignals         ExitSignal[]
  postmortem          TradePostmortem?
}

enum TradingMode {
  PAPER
  SHADOW
  LIVE
}

enum TradeStatus {
  ENTRY_PENDING
  ENTRY_SUBMITTED
  OPEN
  PARTIALLY_EXITED
  EXIT_PENDING
  EXIT_SUBMITTED
  CLOSED
  CANCELLED
  FAILED
}
```

---

# 50. TradeExecution

```prisma
model TradeExecution {
  id                  String   @id @default(cuid())
  tradeId             String

  type                ExecutionType
  status              ExecutionStatus

  txHash              String?
  blockNumber         BigInt?

  tokenAmount         Decimal?
  usdValue            Decimal?

  expectedPrice       Decimal?
  actualPrice         Decimal?

  slippagePercent     Float?
  priceImpactPercent  Float?

  gasUsed             Decimal?
  gasCostNative       Decimal?
  gasCostUsd          Decimal?

  provider            String?

  submittedAt         DateTime?
  confirmedAt         DateTime?

  rawQuote            Json?
  rawReceipt          Json?

  createdAt           DateTime @default(now())
}

enum ExecutionType {
  BUY
  SELL
  APPROVAL
}

enum ExecutionStatus {
  CREATED
  QUOTED
  SIMULATED
  SUBMITTED
  CONFIRMED
  FAILED
  DROPPED
  REPLACED
}
```

---

# 51. PositionSnapshot

```prisma
model PositionSnapshot {
  id                    String   @id @default(cuid())
  tradeId               String

  priceUsd              Decimal?
  marketCapUsd          Decimal?
  liquidityUsd          Decimal?

  tokenAmountRemaining  Decimal?

  unrealizedPnlUsd      Decimal?
  unrealizedPnlPercent  Float?

  maxFavorablePercent   Float?
  maxAdversePercent     Float?

  volume5m              Decimal?
  buySellRatio5m        Float?

  riskScore             Float?
  technicalState        String?

  capturedAt            DateTime @default(now())
}
```

---

# 52. TradeDecisionSnapshot

This model is essential.

```prisma
model TradeDecisionSnapshot {
  id                  String   @id @default(cuid())

  candidateId         String?
  tradeId             String?

  decision            TradeDecision
  stage               String

  strategyVersionId   String

  marketState         Json
  projectState        Json
  technicalState      Json
  portfolioState      Json

  modelName           String?
  modelVersion        String?
  promptVersion       String?

  aiAnalysis          Json?
  deterministicRules  Json
  finalReasons        Json

  createdAt           DateTime @default(now())
}

enum TradeDecision {
  BUY
  WAIT
  SKIP
  HOLD
  PARTIAL_SELL
  SELL
  CANCEL
}
```

Every important decision must create one of these records.

---

# 53. ExitSignal

```prisma
model ExitSignal {
  id             String   @id @default(cuid())
  tradeId        String

  type           String
  severity       String

  triggered      Boolean
  evidence       Json

  createdAt      DateTime @default(now())
}
```

---

# 54. TradePostmortem

```prisma
model TradePostmortem {
  id                  String   @id @default(cuid())
  tradeId             String   @unique

  result              String

  entryQuality        Float?
  exitQuality         Float?

  realizedMultiple    Float?
  mfeMultiple         Float?
  maePercent          Float?

  timeToPeakMinutes   Int?
  holdingMinutes      Int?

  whatWorked          Json
  whatFailed          Json
  missedOpportunity   Json?
  lessons             Json?

  aiSummary           String?

  createdAt           DateTime @default(now())
}
```

---

# 55. CandidateOutcome

Track every candidate, not only traded candidates.

```prisma
model CandidateOutcome {
  id                     String   @id @default(cuid())
  candidateId            String   @unique

  traded                 Boolean

  marketCapAtDetection   Decimal?
  marketCapAtPlan        Decimal?

  maxMarketCap15m        Decimal?
  maxMarketCap1h         Decimal?
  maxMarketCap6h         Decimal?
  maxMarketCap24h        Decimal?
  maxMarketCap48h        Decimal?

  minMarketCap15m        Decimal?
  minMarketCap1h         Decimal?
  minMarketCap6h         Decimal?
  minMarketCap24h        Decimal?
  minMarketCap48h        Decimal?

  maxMultiple24h         Float?
  maxMultiple48h         Float?
  maxDrawdown24h         Float?

  hit125x                Boolean?
  hit150x                Boolean?
  hit200x                Boolean?
  hit250x                Boolean?

  timeTo150xMinutes      Int?
  timeTo200xMinutes      Int?
  timeTo250xMinutes      Int?

  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt
}
```

---

# 56. StrategyVersion

```prisma
model StrategyVersion {
  id                 String   @id @default(cuid())

  name               String
  version            String

  status             StrategyStatus

  configuration      Json
  scoringWeights     Json
  entryRules         Json
  sizingRules        Json
  exitRules          Json

  parentVersionId    String?

  createdAt          DateTime @default(now())
  promotedAt         DateTime?
}

enum StrategyStatus {
  DRAFT
  BACKTEST
  SHADOW
  PRODUCTION
  RETIRED
}
```

---

# 57. PortfolioSnapshot

```prisma
model PortfolioSnapshot {
  id                    String   @id @default(cuid())

  walletAddress         String

  cashValueUsd          Decimal?
  openPositionValueUsd  Decimal?
  totalEquityUsd         Decimal?

  realizedPnlUsd        Decimal?
  unrealizedPnlUsd      Decimal?

  reserveUsd            Decimal?
  deployableUsd         Decimal?

  capturedAt            DateTime @default(now())
}
```

---

# 58. LedgerEntry

```prisma
model LedgerEntry {
  id              String   @id @default(cuid())

  type            LedgerEntryType

  tradeId         String?
  executionId     String?

  amountUsd       Decimal?
  amountNative    Decimal?

  txHash          String?
  notes           String?

  occurredAt      DateTime
  createdAt       DateTime @default(now())
}

enum LedgerEntryType {
  DEPOSIT
  WITHDRAWAL
  BUY
  SELL
  GAS
  APPROVAL_GAS
  REALIZED_PNL
  MANUAL_ADJUSTMENT
}
```

---

# 59. PortfolioMilestone

```prisma
model PortfolioMilestone {
  id               String   @id @default(cuid())

  targetUsd         Decimal
  reached           Boolean  @default(false)

  reachedAt         DateTime?
  equityAtReach     Decimal?

  notificationSent Boolean  @default(false)

  createdAt         DateTime @default(now())
}
```

---

# 60. Learning Architecture

The system does **not** learn by relying on LLM conversation memory.

Learning must come from:

```text
structured historical features
+
candidate outcomes
+
trade outcomes
+
postmortems
+
statistical analysis
+
backtesting
```

---

# 61. Store All Candidate Decisions

Required categories:

```text
TRADED
SKIPPED
REJECTED
WAITED
MISSED_ENTRY
EXPIRED
```

Why:

A token rejected at a score of 62 that later goes 10x is useful data.

A token scored 95 that later collapses is useful data.

The system must learn from both.

---

# 62. Machine-Learning Feature Dataset

Each candidate should eventually become one row of structured features.

## Project Features

```text
utility score
website score
social score
contract score
branding score
team score
research confidence
project category
estimated project age
```

## Market Features

```text
market cap
liquidity
liquidity/mcap
token age
volume 5m
volume 1h
buy/sell ratio
transaction count
price change
```

## Technical Features

```text
RSI
VWAP distance
EMA relationships
ATR
distance from high
distance from support
distance from resistance
drawdown from local peak
market regime
volume acceleration
```

## Chain / Holder Features

```text
holder count
top holder %
top 10 %
deployer balance
mint capability
proxy
owner controls
```

## Trade Features

```text
planned entry MC
actual entry MC
distance from detection price
position size %
risk score
strategy version
```

---

# 63. Outcome Labels

Every candidate should be labeled with:

```text
hit 1.25x?
hit 1.5x?
hit 2x?
hit 2.5x?

time to each target

MFE
MAE

max return 1h
max return 6h
max return 24h
max return 48h

max drawdown
liquidity event
rug / critical failure
```

---

# 64. MFE / MAE

Calculate:

```text
MFE = Maximum Favorable Excursion
MAE = Maximum Adverse Excursion
```

Example:

```text
entry value = $10
lowest value = $8.70 → MAE = -13%
highest value = $28 → MFE = +180%
```

Use these metrics to improve exits and loss tolerances later.

---

# 65. Future Prediction Layer

Once enough data exists, train separate tabular models.

Potential outputs:

```json
{
  "probability125x": 0.84,
  "probability150x": 0.73,
  "probability200x": 0.61,
  "probability250x": 0.39,
  "probability30PercentDrawdown": 0.22,
  "expectedMFE": 1.88,
  "expectedMAE": -0.17
}
```

Candidate algorithms:

```text
Logistic Regression
Random Forest
XGBoost
LightGBM
```

Do not begin with deep learning.

---

# 66. Data Thresholds Before ML

Suggested:

```text
< 50 candidates:
analytics only

50–200:
exploratory simple models

200–1000:
validated supervised models

1000+:
stronger model/strategy experiments
```

Candidates, not only executed trades, count toward the dataset.

---

# 67. Strategy Versioning

Every trade and decision must store:

```text
strategyVersionId
```

Never silently modify production rules.

Example:

```text
v1.0
v1.1
v1.2
v2.0
```

---

# 68. Strategy Promotion

Required workflow:

```text
New strategy proposal
      ↓
Historical backtest
      ↓
Compare to current production strategy
      ↓
Shadow mode
      ↓
Minimum observation period
      ↓
Evaluation
      ↓
Explicit promotion
```

Never allow an LLM to auto-promote a strategy.

---

# 69. Backtesting

Backtest:

```text
historical candidate features
+
historical candles/snapshots
+
strategy configuration
```

Output:

- total trades
- win rate
- average return
- median return
- max drawdown
- profit factor
- expectancy
- average holding time
- 2x hit rate
- 2.5x hit rate
- MFE
- MAE
- missed opportunities
- false positives

---

# 70. Prevent Lookahead Bias

Backtests must use only information available at the simulated decision time.

Never use:

- future candles
- future market cap
- future holder counts
- future social activity
- future project updates

to make an earlier decision.

---

# 71. Learning Reports

Generate periodic reports with hypotheses such as:

```text
High-quality utility tokens with liquidity/mcap above X performed better.

Waiting for >25% pullback caused too many missed entries.

Tokens with social history shorter than one day had higher failure rates.

Taking partial profit at 2x improved realized returns.

Successful trades rarely exceeded a particular MAE.
```

These are recommendations for future strategy versions, not automatic changes.

---

# 72. AI Postmortems

After each trade, AI may evaluate:

- original thesis
- entry quality
- market path
- exit quality
- risks
- what worked
- what failed

Output must be structured and stored.

AI lessons cannot directly alter production strategy.

---

# 73. Decision Auditability

For every action, the system must be able to reconstruct:

```text
What data existed?
What did AI say?
What rules passed?
What rules failed?
What strategy version was active?
Why was the action allowed?
What was signed?
What actually happened on-chain?
```

If this cannot be reconstructed, the feature is incomplete.

---

# 74. Risk Engine Interface

Create a dedicated module:

```ts
interface RiskEngine {
  evaluateCandidate(input: CandidateRiskInput): CandidateRiskResult;
  validateEntry(input: EntryRiskInput): EntryRiskResult;
  calculatePositionSize(input: PositionSizingInput): PositionSizingResult;
  validatePosition(input: PositionRiskInput): PositionRiskResult;
  validateExit(input: ExitRiskInput): ExitRiskResult;
}
```

Do not scatter risk logic throughout workers.

---

# 75. Workers / Queues

Suggested logical queues:

```text
trade-planning
pending-entry-monitor
entry-revalidation
trade-execution
position-monitor
exit-evaluation
exit-execution
portfolio-accounting
portfolio-reconciliation
candidate-outcomes
trade-postmortem
learning-analytics
notifications
```

Physical queues may be consolidated initially.

Priorities:

```text
1. emergency/risk exit
2. tx recovery
3. normal exit
4. entry revalidation
5. new entry
6. trade planning
7. analytics
```

---

# 76. Crash / Restart Recovery

After restart:

1. Resolve pending transactions.
2. Reconcile transaction states.
3. Reload open positions.
4. Resume position monitoring.
5. Reload active pending entries.
6. Resume entry monitoring.
7. Reconcile wallet balances.
8. Resume candidate outcome tracking.

No critical state may exist only in memory.

---

# 77. Portfolio Reconciliation

Periodically compare:

```text
DB expected wallet state
vs
actual on-chain balances
```

If mismatch exceeds threshold:

- pause new entries
- alert operator
- preserve exit capability

---

# 78. API Endpoints

Suggested:

```text
GET  /trading/status
POST /trading/pause
POST /trading/resume

GET  /trade-candidates
GET  /trade-candidates/:id

GET  /trade-plans
GET  /trade-plans/:id

GET  /pending-entries
POST /pending-entries/:id/cancel

GET  /positions
GET  /positions/:id
POST /positions/:id/exit

GET  /trades
GET  /trades/:id

GET  /portfolio
GET  /portfolio/history

GET  /ledger

GET  /strategies
GET  /strategies/:id
POST /strategies/:id/promote

GET  /learning/reports
GET  /learning/candidate-outcomes
```

Authentication required.

---

# 79. Dashboard Additions

## Trading Overview

Show:

- current trading mode
- wallet address
- total equity
- reserve
- deployable capital
- open positions
- pending entries
- realized PnL
- unrealized PnL
- gas spent
- current strategy version

## Candidates

Columns:

```text
Token
Project Score
Confidence
Current MC
Target Entry
Risk
Status
```

## Open Positions

```text
Entry
Current
PnL
MFE
MAE
Targets
Exit State
```

## Trade History

Show all executions and outcome metrics.

## Strategy

Show:

- current production version
- draft/shadow versions
- backtest results
- strategy comparison

## Learning

Show:

- missed winners
- false positives
- strongest features
- rejected tokens that later ran
- high-score tokens that failed
- entry/exit efficiency

---

# 80. Email / Alert Failures

Operator alerts for:

- RPC unavailable
- execution provider unavailable
- wallet gas low
- DB/Redis failure
- position monitor stale
- pending tx stuck
- portfolio mismatch
- circuit breaker triggered
- kill switch triggered
- invalid production strategy config

---

# 81. Health / Watchdog

Track:

```text
lastPositionMonitorAt
lastPendingEntryMonitorAt
lastPortfolioReconcileAt
lastRPCSuccessAt
lastExecutionProviderSuccessAt
```

Alert when stale.

---

# 82. AI Role

AI may:

- interpret market regime
- explain support/retest structure
- summarize project risk
- synthesize research
- propose trade-plan context
- create postmortems
- suggest hypotheses for strategy changes

AI must not solely control:

- private keys
- signing
- maximum position size
- reserve rules
- daily-loss limit
- slippage limit
- router allowlist
- kill switch
- nonce management
- strategy promotion
- transaction recovery

---

# 83. AI Output Validation

Example:

```ts
const TradeAnalysisSchema = z.object({
  marketRegime: z.enum([
    "EARLY_DISCOVERY",
    "BREAKOUT",
    "PULLBACK",
    "RETEST",
    "CONSOLIDATION",
    "TRENDING_UP",
    "TRENDING_DOWN",
    "PARABOLIC",
    "DISTRIBUTION",
    "LOW_LIQUIDITY",
    "CHOPPY",
    "UNKNOWN"
  ]),
  recommendedAction: z.enum([
    "BUY_NOW",
    "WAIT_FOR_ENTRY",
    "WATCH_ONLY",
    "REJECT_TRADE"
  ]),
  riskScore: z.number().min(0).max(100),
  confidence: z.number().min(0).max(100),
  reasoning: z.array(z.string()).max(10)
});
```

Do not use free-form LLM text as a transaction trigger.

---

# 84. Example AI Market Prompt

```text
Given the supplied structured market data, candles, technical features,
project research, and current liquidity:

1. classify current market regime
2. determine whether price is extended
3. identify plausible support/retest zones
4. identify qualitative risks
5. recommend BUY_NOW, WAIT_FOR_ENTRY, WATCH_ONLY, or REJECT_TRADE
6. explain the recommendation

Do not determine the final position size.
Do not bypass deterministic risk rules.
Return structured JSON only.
```

---

# 85. Performance Metrics

Track:

```text
net realized PnL
gross PnL
gas spend
win rate
average winner
average loser
profit factor
expectancy
max portfolio drawdown
average holding time
2x hit rate
2.5x hit rate
MFE
MAE
entry efficiency
exit efficiency
```

---

# 86. Entry Efficiency

Measure actual entry relative to the best realistic price available after the original signal.

This helps identify:

- chasing
- waiting too long
- missing high-quality breakouts
- overly deep pullback targets

---

# 87. Exit Efficiency

Compare realized exit against MFE.

Example:

```text
MFE = +180%
realized = +70%
```

This becomes input into future exit-strategy experiments.

---

# 88. Paper / Shadow Fill Model

Do not simulate perfect fills.

Estimate:

- slippage
- spread
- price impact
- gas
- liquidity constraints

Paper/shadow results should be reasonably close to what live execution could have achieved.

---

# 89. Mandatory Testing Before Live

Minimum:

```text
2 weeks of shadow mode
or
100 qualified candidates
```

Review:

- false positive trades
- missed entries
- target-entry quality
- slippage assumptions
- exit quality
- risk exits
- portfolio drawdowns
- candidate outcomes

---

# 90. Live Rollout

Recommended:

```text
Stage 1 → SHADOW
Stage 2 → LIVE with tiny balance + max 1 position
Stage 3 → LIVE with normal configured small-account limits
```

Never deploy directly from development into unrestricted live mode.

---

# 91. Suggested Package Structure

```text
packages/
├── trading-domain/
│   ├── candidate/
│   ├── plan/
│   ├── trade/
│   ├── execution/
│   └── state-machines/
│
├── market-analysis/
│   ├── candles/
│   ├── indicators/
│   ├── support-resistance/
│   └── regimes/
│
├── risk-engine/
│   ├── portfolio/
│   ├── position-sizing/
│   ├── circuit-breakers/
│   └── preflight/
│
├── execution/
│   ├── providers/
│   ├── signer/
│   ├── nonce/
│   ├── transactions/
│   └── reconciliation/
│
├── portfolio/
│   ├── accounting/
│   ├── ledger/
│   ├── snapshots/
│   └── milestones/
│
├── position-manager/
│   ├── monitor/
│   ├── pnl/
│   ├── mfe-mae/
│   └── exits/
│
├── strategy/
│   ├── versions/
│   ├── backtest/
│   └── promotion/
│
└── learning/
    ├── candidate-outcomes/
    ├── features/
    ├── postmortems/
    ├── analytics/
    └── ml/
```

---

# 92. Suggested Workers

```text
apps/worker/src/workers/
├── trade-planning.worker.ts
├── pending-entry.worker.ts
├── entry-revalidation.worker.ts
├── execution.worker.ts
├── position-monitor.worker.ts
├── exit-evaluation.worker.ts
├── exit-execution.worker.ts
├── portfolio-reconcile.worker.ts
├── candidate-outcomes.worker.ts
├── trade-postmortem.worker.ts
└── learning-analytics.worker.ts
```

---

# 93. Configuration Example

```env
TRADING_MODE=SHADOW
TRADING_ENABLED=true

BOT_WALLET_PRIVATE_KEY=
RH_RPC_URL=

EXECUTION_PROVIDER=uniswap

MIN_TRADE_QUALITY_SCORE=80
MIN_TRADE_RESEARCH_CONFIDENCE=65
MIN_TRADE_CONTRACT_SCORE=75
MIN_TRADE_LIQUIDITY_USD=15000

MAX_OPEN_POSITIONS=2
MIN_RESERVE_PERCENT=50
MAX_TOTAL_DEPLOYED_PERCENT=50
MAX_SINGLE_POSITION_PERCENT=25

MAX_DAILY_REALIZED_LOSS_PERCENT=20
MAX_CONSECUTIVE_LOSSES=3

DEFAULT_ENTRY_PLAN_TTL_MINUTES=360
POSITION_MONITOR_INTERVAL_SECONDS=10

DEFAULT_MAX_BUY_SLIPPAGE_BPS=300
DEFAULT_MAX_SELL_SLIPPAGE_BPS=500
EMERGENCY_MAX_SELL_SLIPPAGE_BPS=1000
MAX_BUY_PRICE_IMPACT_PERCENT=3

MAX_GAS_COST_PERCENT_OF_POSITION=5
MIN_GAS_BALANCE_ETH=

DEFAULT_MAX_HOLD_MINUTES=1440
```

---

# 94. Build Phases for Claude Code

## Phase 1 — Trading Domain

Build:

- Prisma models
- migrations
- enums
- repositories
- state machines

Acceptance:

- all entities persist
- invalid transitions fail

## Phase 2 — Market / Technical Engine

Build:

- candle ingestion
- normalized technical indicators
- support/resistance
- market regime
- market snapshots

Acceptance:

- each candidate has structured technical features

## Phase 3 — Trade Planning

Build:

- candidate generator
- AI trade-analysis adapter
- structured plan schema
- deterministic plan validation

Acceptance:

- every candidate becomes BUY / WAIT / WATCH / REJECT

## Phase 4 — Pending Entry Monitor

Build:

- target entry ranges
- expiration
- entry trigger
- revalidation queue

Acceptance:

- target entry triggers revalidation, never an immediate blind buy

## Phase 5 — Risk Engine

Build:

- reserve
- exposure limits
- position sizing
- gas rules
- circuit breakers
- preflight

Acceptance:

- final sizing is deterministic

## Phase 6 — Paper Execution

Build:

- paper quote
- buy/sell simulation
- realistic slippage/gas
- execution persistence

Acceptance:

- complete trade lifecycle works without a wallet

## Phase 7 — Live Execution

Build:

- viem signer
- provider adapter
- chain validation
- router allowlist
- nonce locks
- transaction intent
- simulation
- send/confirm/recovery

Acceptance:

- controlled test swap completes and reconciles

## Phase 8 — Position Manager

Build:

- live snapshots
- PnL
- MFE/MAE
- sellability checks
- risk monitoring

Acceptance:

- open position survives service restart

## Phase 9 — Exit Engine

Build:

- partial profit
- target exit
- trailing exit
- invalidation exit
- risk exit
- time exit
- manual exit

Acceptance:

- each exit path is auditable

## Phase 10 — Portfolio Accounting

Build:

- ledger
- portfolio snapshots
- reserve/deployable
- wallet reconciliation

## Phase 11 — Notifications

Build:

- plan email
- entry email
- partial-profit email
- closed-trade email
- milestone emails
- system-failure alerts

## Phase 12 — Candidate Outcome Tracking

Build:

- 15m / 1h / 6h / 24h / 48h outcomes
- 1.25x / 1.5x / 2x / 2.5x hits
- rejected/skipped outcomes

## Phase 13 — Postmortems

Build:

- quantitative stats
- AI qualitative review
- lessons storage

## Phase 14 — Strategy Versioning

Build:

- draft / backtest / shadow / production states
- strategy configs
- comparison UI/API

## Phase 15 — Backtesting

Build:

- historical replay
- no-lookahead enforcement
- strategy metrics

## Phase 16 — Learning Analytics

Build:

- feature correlations
- missed winners
- false positives
- entry/exit efficiency
- strategy reports

## Phase 17 — Predictive ML

Only after enough candidates exist.

Build:

- feature dataset exporter
- time-based train/validation split
- basic tabular classifier/regressor
- probability calibration
- model registry

---

# 95. Claude Code Implementation Rules

Claude Code must follow these:

1. Do not rewrite existing discovery/research modules unless necessary.
2. Trading must be a separate domain.
3. Build PAPER/SHADOW before LIVE.
4. Never combine wallet signing with AI code.
5. Never send signing secrets to AI.
6. Persist every decision.
7. Persist transaction intent before broadcast.
8. All jobs must be idempotent.
9. All state machines must be explicit.
10. Do not use in-memory state as the source of truth.
11. Do not silently widen slippage.
12. Do not silently ignore a failed safety check.
13. LIVE must fail closed on invalid config.
14. Strategy changes require a new version.
15. Never auto-promote strategies.
16. Never auto-transfer more capital into the bot wallet.
17. Exits must still function when new entries are paused.
18. Use Zod for all AI/provider outputs.
19. Add unit tests for all risk/accounting logic.
20. Add integration tests for execution and reconciliation.

---

# 96. Definition of Done

The extension is complete when:

- [ ] DISABLED/PAPER/SHADOW/LIVE modes exist
- [ ] defaults to SHADOW
- [ ] dedicated bot wallet works
- [ ] trade candidates persist
- [ ] chart/technical features persist
- [ ] trade plans persist
- [ ] pending entries are monitored
- [ ] target entry triggers revalidation
- [ ] deterministic risk engine exists
- [ ] position sizing works
- [ ] reserve rules work
- [ ] account circuit breakers work
- [ ] global kill switch works
- [ ] paper execution works
- [ ] live execution provider works
- [ ] router allowlist exists
- [ ] transaction preflight exists
- [ ] nonce safety exists
- [ ] tx recovery exists
- [ ] position monitoring works
- [ ] partial exits work
- [ ] target exits work
- [ ] trailing exits work
- [ ] risk exits work
- [ ] time exits work
- [ ] PnL accounting works
- [ ] gas accounting works
- [ ] MFE/MAE tracking works
- [ ] portfolio reconciliation works
- [ ] milestone emails work
- [ ] skipped/rejected candidate outcomes are tracked
- [ ] trade postmortems work
- [ ] strategy versioning works
- [ ] backtesting exists
- [ ] lookahead bias is prevented
- [ ] learning analytics work
- [ ] all actions are auditable
- [ ] service can restart without losing trade state
- [ ] shadow testing completed before meaningful live capital

---

# 97. Final Product Experience

Example trade-plan email:

```text
RH TRADE PLAN

Project: Navier-Stokes
Ticker: NAVIER

Project Score: 91/100
Research Confidence: 84/100
Market Risk: 24/100

Current Market Cap:
$184K

Current Structure:
Overextended after breakout.

Target Entry:
$148K–$155K MC

Do Not Chase Above:
$172K MC

Estimated Position:
$7.50

Technical Invalidation:
$126K MC

Profit Plan:
• first partial target per strategy
• secondary target around configured 2.5x objective
• trailing exit for remaining position
• earlier risk exit if thesis deteriorates

Status:
WAITING FOR ENTRY
```

Then:

```text
NAVIER ENTRY EXECUTED

Entry MC: $152K
Position: $7.50
Slippage: 1.2%
```

Then:

```text
NAVIER PARTIAL PROFIT

Position reached configured first target.
Partial-profit rule executed.
```

Then:

```text
NAVIER CLOSED

Realized Multiple: 2.36x
Realized Profit: $...
Holding Time: 2h 18m

MFE: +171%
MAE: -11%

Exit Reason:
Trailing risk exit
```

Every stage must exist in the database for later analysis.

---

# 98. Long-Term Intelligence Goal

The durable advantage should become the private historical dataset:

```text
Every token discovered
+
Every research score
+
Every chart state
+
Every proposed entry
+
Every skipped trade
+
Every actual entry
+
Every exit
+
Every MFE/MAE
+
Every market outcome
+
Every strategy version
```

Over time the system should become capable of answering:

```text
Which utility-token characteristics correlate with 2x moves?

Which market-cap ranges provide the best entries?

How much do successful trades usually retrace first?

Which signals predict large drawdowns?

Which tokens should be bought immediately versus waited on?

Which position sizes perform best for each risk bucket?

Which exit strategy produces the best realized return?

Which signals looked useful but have no actual predictive value?
```

---

# 99. Final Engineering Principle

```text
RESEARCH FIRST
      ↓
PLAN BEFORE TRADING
      ↓
WAIT FOR GOOD ENTRIES
      ↓
REVALIDATE
      ↓
SIZE RISK
      ↓
EXECUTE SAFELY
      ↓
MONITOR CONTINUOUSLY
      ↓
TAKE PROFITS SYSTEMATICALLY
      ↓
EXIT WHEN THESIS BREAKS
      ↓
STORE EVERYTHING
      ↓
MEASURE OUTCOMES
      ↓
BACKTEST IMPROVEMENTS
      ↓
PROMOTE STRATEGIES CAREFULLY
```

That is the required architecture for the UtilityScout autonomous trading and learning extension.

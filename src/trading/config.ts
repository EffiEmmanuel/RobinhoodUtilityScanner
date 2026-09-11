import "dotenv/config";

function str(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optStr(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v.toLowerCase() === "true" || v === "1";
}

type TradingMode = "DISABLED" | "PAPER" | "SHADOW" | "LIVE";

function tradingMode(): TradingMode {
  const raw = (optStr("TRADING_MODE") ?? "SHADOW").toUpperCase();
  if (raw !== "DISABLED" && raw !== "PAPER" && raw !== "SHADOW" && raw !== "LIVE") {
    throw new Error(`Invalid TRADING_MODE "${raw}" — expected DISABLED, PAPER, SHADOW, or LIVE`);
  }
  if (raw === "LIVE") {
    // §5: "LIVE must require an explicit valid config and should fail closed
    // if any required secret or risk config is missing." Checked here, at
    // startup, rather than discovered mid-trade the first time a buy is attempted.
    const missing: string[] = [];
    if (!process.env.BOT_WALLET_PRIVATE_KEY) missing.push("BOT_WALLET_PRIVATE_KEY");
    if (!process.env.RH_RPC_URL) missing.push("RH_RPC_URL");
    if (missing.length > 0) {
      throw new Error(`TRADING_MODE=LIVE requires ${missing.join(", ")} to be set — refusing to start with real trading enabled and incomplete config.`);
    }
  }
  return raw as TradingMode;
}

export const tradingConfig = {
  mode: tradingMode(),
  tradingEnabled: bool("TRADING_ENABLED", true), // global kill switch, checked before every entry

  // Candidate eligibility gates (§9) — layered on top of the base research
  // pipeline's own watchlist/alert thresholds (config.watchlistThreshold etc).
  minTradeQualityScore: num("MIN_TRADE_QUALITY_SCORE", 80),
  minTradeResearchConfidence: num("MIN_TRADE_RESEARCH_CONFIDENCE", 65),
  minTradeContractScore: num("MIN_TRADE_CONTRACT_SCORE", 75),
  minTradeLiquidityUsd: num("MIN_TRADE_LIQUIDITY_USD", 15000),
  // User directive 2026-09-11: PEG ($51K detection mcap -> ~4x) and TFLY
  // ($195K -> 2x+) both delivered real, fast multiples tonight; RWA and
  // STONKBROKER, both already $20-30M at entry, did not — "tens of thousands
  // and a few hundred thousand is way better chance of making good profit."
  // NOT an entry gate, though — a large-mcap token with real momentum is
  // still tradeable, just with a modest fast-flip target instead of holding
  // for the big multiple a low-mcap token has room for (unless the project
  // itself is genuinely strong — see ExitRules.fastFlip.veryGoodQualityScoreThreshold,
  // which exempts a "very good project" from this regardless of entry mcap).
  // Consumed by positionManager.ts's resolveExitRules, not riskEngine.ts.
  fastFlipAboveMarketCapUsd: num("FAST_FLIP_ABOVE_MARKET_CAP_USD", 2_000_000),

  // Capital buckets (§22) — all against the PAPER starting balance below.
  minReservePercent: num("MIN_RESERVE_PERCENT", 50),
  maxTotalDeployedPercent: num("MAX_TOTAL_DEPLOYED_PERCENT", 50),
  maxSinglePositionPercent: num("MAX_SINGLE_POSITION_PERCENT", 25),
  // User directive 2026-09-11: this cap was blocking new entries outright
  // ("max open positions reached (2/2)") while capital was still available
  // under maxTotalDeployedPercent/maxSinglePositionPercent above — those two
  // already bound total real risk (how much capital can ever be deployed at
  // once, and how much any single position can be), so a separate hard count
  // limit was redundant risk control, not the only one. 0 (or below) means no
  // count cap at all — see checkCircuitBreakers in portfolio.ts.
  maxOpenPositions: num("MAX_OPEN_POSITIONS", 2),

  // Circuit breakers (§25).
  maxDailyRealizedLossPercent: num("MAX_DAILY_REALIZED_LOSS_PERCENT", 20),
  maxConsecutiveLosses: num("MAX_CONSECUTIVE_LOSSES", 3),

  // Entry lifecycle.
  defaultEntryPlanTtlMinutes: num("DEFAULT_ENTRY_PLAN_TTL_MINUTES", 360),
  // Hard cap on how deep a pullback the AI's WAIT_FOR_ENTRY plan is allowed to
  // demand before entering (planning.ts clamps targetEntryMcapMax to this).
  // Nothing deterministic previously bounded this — confirmed live: the AI
  // proposed a 42% pullback requirement on a token that had already moved
  // +217% in 5 minutes, on a chain where fast movers tend to keep running or
  // collapse outright rather than gently mean-revert. An unbounded target
  // risks never triggering at all before the plan expires, which is not a
  // "safe" outcome for a system whose whole point is entering trades.
  // Now only the FALLBACK cap (planning.ts prefers the token's real observed
  // support level once there's enough history to trust one — see
  // clampPullbackTarget) for a brand-new candidate with too little history to
  // know a real support level yet.
  maxPullbackWaitPercent: num("MAX_PULLBACK_WAIT_PERCENT", 20),
  // Sanity backstop applied regardless of data source, including when a real
  // observed support level is used — that data could itself be a brief noise
  // wick, never trust it past this no matter what.
  maxPullbackExtremeFloorPercent: num("MAX_PULLBACK_EXTREME_FLOOR_PERCENT", 60),

  // User directive 2026-09-11, evidence: Flypad breached its AI-stated
  // technicalInvalidationMcap and was cancelled/exited on that single touch
  // — then ran 3x from that exact dip. "Once a token bonds, it usually tips
  // a bit — that should be normal." The AI's invalidation level is a single
  // point estimate with no allowance for the routine post-launch/post-
  // bonding-curve-graduation wick this chain's tokens commonly show right
  // after going live on a real AMM pool. Two tiers instead of one: the AI's
  // stated level is now the SOFT floor (tracked, not acted on alone) — only
  // a breach this many percent FURTHER below it counts as the setup
  // actually being broken. Applied identically in entryMonitor.ts's
  // invalidationBreached (pre-buy) and positionManager.ts's
  // INVALIDATION_EXIT (open-position exit) — both derive the same
  // tolerance-adjusted hard floor from plan.invalidationMcap rather than
  // using it directly.
  invalidationTolerancePercent: num("INVALIDATION_TOLERANCE_PERCENT", 20),

  // Tightened from 20s — deliberately not literally 1s: DexScreener's public
  // API has no confirmed rate-limit headroom for that at 24/7 scale, and this
  // is still the cheap, free, deterministic layer, not an AI call. Raise or
  // lower once real behavior against the live API is observed.
  positionMonitorIntervalSeconds: num("POSITION_MONITOR_INTERVAL_SECONDS", 5),
  // Only ever slept on when entryMonitorLoop found zero ACTIVE pending
  // entries system-wide (processPendingEntries returns "idle") — any actual
  // queued entry is re-checked with no artificial delay regardless of this
  // value. That's a lighter load than positionMonitorIntervalSeconds's
  // steady per-open-trade 5s cadence above, which the same DexScreener-safety
  // reasoning already vetted — no reason for a freshly-armed BUY_NOW/
  // WAIT_FOR_ENTRY plan to sit for up to 20s before its first check when the
  // system is otherwise idle.
  pendingEntryMonitorIntervalSeconds: num("PENDING_ENTRY_MONITOR_INTERVAL_SECONDS", 5),

  // A WAIT_FOR_ENTRY plan's target zone/risk score was previously frozen at
  // whatever the AI saw once, at plan-creation time — confirmed live: a plan
  // created against a token at its all-time-high stayed unchanged while that
  // token swung between $100K-$380K mcap for over an hour. Re-run the trade
  // analysis (fresh market/technical data, a new plan+pending entry replacing
  // the stale one) whenever either condition is met, whichever comes first.
  // A backstop only, not the primary replan trigger — entryMonitor.ts
  // replans IMMEDIATELY when price actually breaches the plan's own
  // invalidation floor or do-not-chase ceiling (the setup genuinely changed).
  // Confirmed live: a short fixed timer (3 min) as the *primary* trigger
  // backfired on a choppy/range-bound token — each replan recalculated the
  // target relative to whatever price was at that moment, so the zone kept
  // resetting before the real price ever got a chance to reach it (16
  // replans in 45 minutes, zero entries, on a token oscillating within a
  // range the whole time). This value now only catches a plan that's gone
  // stale without ever technically breaking either boundary.
  pendingPlanReviewIntervalMinutes: num("PENDING_PLAN_REVIEW_INTERVAL_MINUTES", 20),
  pendingPlanReplanOnDriftPercent: num("PENDING_PLAN_REPLAN_ON_DRIFT_PERCENT", 25),

  // User directive 2026-09-11: confirmed live, roost was in a confirmed
  // PARABOLIC regime (2,397% 1h change, 325% 5m, 83-86% buy ratio) and the AI
  // still recommended WAIT_FOR_ENTRY — its own reasoning cited "very low"
  // data confidence (only 2 historical snapshots, since the token was ~30s
  // old) as the reason to wait, even though the *direction* of the move
  // wasn't ambiguous at all, just its history. The prompt already pushes
  // toward BUY_NOW here (see prompts.ts) but that's still probabilistic —
  // roost ran 5-7x waiting for a pullback that never came. This is a hard,
  // deterministic override of the AI's own WAIT_FOR_ENTRY call specifically
  // for this narrow, extreme case — the one place in this codebase where
  // deterministic code upgrades rather than downgrades the AI's
  // recommendation (see planning.ts's isExtremeMomentum/planCandidate).
  // Gated on real two-sided volume (config.momentumOverrideMinHourlyTxns),
  // not just a price change, so a single wash-traded print can't trigger it.
  extremeMomentumOverride1hPriceChangePercent: num("EXTREME_MOMENTUM_OVERRIDE_1H_PRICE_CHANGE_PERCENT", 500),
  extremeMomentumOverrideMinBuyRatio1h: num("EXTREME_MOMENTUM_OVERRIDE_MIN_BUY_RATIO_1H", 0.7),

  // Active position management (§trading/positionStrategy.ts) — the AI
  // reviews an open position's strategy periodically (not on every cheap
  // monitor tick), proposing partial-profit/exit/re-entry-target decisions
  // that deterministic code then enforces or executes. Hard caps here bound
  // it regardless of what the AI recommends.
  // Tightened from 5: this is an AI call (Gemini), shared rate-limit budget
  // with classification/research/planning — going much faster (e.g. seconds)
  // risks exhausting that budget and breaking the rest of the pipeline. The
  // deterministic exit checks (stop-loss/profit-target/trailing/time) run
  // every positionMonitorIntervalSeconds (5s) regardless of this value — this
  // setting only controls how often the smarter contextual layer refreshes.
  positionStrategyReviewIntervalMinutes: num("POSITION_STRATEGY_REVIEW_INTERVAL_MINUTES", 2),
  // Raised from 1: the AI strategy review (positionStrategy.ts) already
  // implements exactly a buy-the-dip/sell-the-resistance cycle via repeated
  // TAKE_PARTIAL_PROFIT + SET_REENTRY_TARGET decisions — capping it at one
  // re-entry turned that into a single-shot instead of the ongoing cycle it
  // was designed for. Each re-entry is still capped at
  // maxReentryPercentOfOriginal of the ORIGINAL position (not compounding),
  // and every one still passes the same entry-risk gate a fresh trade would.
  maxReentriesPerTrade: num("MAX_REENTRIES_PER_TRADE", 5),
  maxReentryPercentOfOriginal: num("MAX_REENTRY_PERCENT_OF_ORIGINAL", 50),

  // Slippage / price-impact ceilings, used by the paper fill model (§29/§88)
  // even though nothing is actually routed on-chain in this build.
  defaultMaxBuySlippageBps: num("DEFAULT_MAX_BUY_SLIPPAGE_BPS", 300),
  defaultMaxSellSlippageBps: num("DEFAULT_MAX_SELL_SLIPPAGE_BPS", 500),
  emergencyMaxSellSlippageBps: num("EMERGENCY_MAX_SELL_SLIPPAGE_BPS", 1000),
  maxBuyPriceImpactPercent: num("MAX_BUY_PRICE_IMPACT_PERCENT", 3),

  // Small-account gas-ratio check (§23) — Robinhood Chain is a cheap L2, so
  // this is a small flat simulated cost, not a real gas oracle call.
  maxGasCostPercentOfPosition: num("MAX_GAS_COST_PERCENT_OF_POSITION", 5),
  paperAssumedGasCostUsd: num("PAPER_ASSUMED_GAS_COST_USD", 0.05),

  defaultMaxHoldMinutes: num("DEFAULT_MAX_HOLD_MINUTES", 1440),

  // LIVE-only (§30/§80) — ignored entirely in PAPER/SHADOW.
  minGasBalanceEth: num("MIN_GAS_BALANCE_ETH", 0.002),

  // Paper/shadow portfolio (§88) — there is no real wallet balance to read,
  // so the simulated ledger starts here.
  paperStartingBalanceUsd: num("PAPER_STARTING_BALANCE_USD", 1000),
};

export type { TradingMode };

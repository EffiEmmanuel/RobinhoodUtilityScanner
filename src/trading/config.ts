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

  // Capital buckets (§22) — all against the PAPER starting balance below.
  minReservePercent: num("MIN_RESERVE_PERCENT", 50),
  maxTotalDeployedPercent: num("MAX_TOTAL_DEPLOYED_PERCENT", 50),
  maxSinglePositionPercent: num("MAX_SINGLE_POSITION_PERCENT", 25),
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
  maxPullbackWaitPercent: num("MAX_PULLBACK_WAIT_PERCENT", 20),
  // Tightened from 20s — deliberately not literally 1s: DexScreener's public
  // API has no confirmed rate-limit headroom for that at 24/7 scale, and this
  // is still the cheap, free, deterministic layer, not an AI call. Raise or
  // lower once real behavior against the live API is observed.
  positionMonitorIntervalSeconds: num("POSITION_MONITOR_INTERVAL_SECONDS", 5),
  pendingEntryMonitorIntervalSeconds: num("PENDING_ENTRY_MONITOR_INTERVAL_SECONDS", 20),

  // Active position management (§trading/positionStrategy.ts) — the AI
  // reviews an open position's strategy periodically (not on every cheap
  // monitor tick), proposing partial-profit/exit/re-entry-target decisions
  // that deterministic code then enforces or executes. Hard caps here bound
  // it regardless of what the AI recommends.
  positionStrategyReviewIntervalMinutes: num("POSITION_STRATEGY_REVIEW_INTERVAL_MINUTES", 5),
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

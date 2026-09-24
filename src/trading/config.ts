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

function bigint(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  try {
    return BigInt(v);
  } catch {
    throw new Error(`Env var ${name} must be an integer, got "${v}"`);
  }
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
  // Momentum/tactical candidates are probe-sized in LIVE mode and still pass
  // quote, slippage, sell-path, and holder checks right before entry. Let
  // those final execution checks decide whether a small trade fits the pool
  // instead of permanently rejecting every fast mover that briefly dips below
  // the general/verified liquidity floor.
  momentumTacticalMinLiquidityUsd: num("MOMENTUM_TACTICAL_MIN_LIQUIDITY_USD", 5000),
  utilityOnlyTradingEnabled: bool("UTILITY_ONLY_TRADING_ENABLED", true),
  minTradeUtilityScore: num("MIN_TRADE_UTILITY_SCORE", 70),
  minTradeCredibilityScore: num("MIN_TRADE_CREDIBILITY_SCORE", 50),
  minTradeWebsiteScore: num("MIN_TRADE_WEBSITE_SCORE", 45),
  requireProductForTrade: bool("REQUIRE_PRODUCT_FOR_TRADE", true),
  allowUnknownProductPredatesToken: bool("ALLOW_UNKNOWN_PRODUCT_PREDATES_TOKEN", true),
  // User directive 2026-09-22: "why are we not investing in projects early" —
  // productPredatesToken=="NO" (the product launched alongside or after the
  // token) was a hard reject on top of everything else in utilityGate.ts,
  // and it's structurally anti-"early": a genuine crypto-native utility
  // project's token often launches WITH its product, not years after, which
  // this treated identically to a bolted-on vaporware token. The other
  // checks here (utilityClass != MEME, requireProductForTrade, the utility/
  // credibility/website score floors) already guard against actual
  // vaporware without this one. Default true keeps prior behavior on a fresh
  // checkout; loosened to false live via Railway env, not the code default.
  blockTokenFirstProducts: bool("BLOCK_TOKEN_FIRST_PRODUCTS", true),
  honeypotBytecodeCheckEnabled: bool("HONEYPOT_BYTECODE_CHECK_ENABLED", true),
  // "Verified project" is deliberately stricter than "tradeable." Momentum
  // can make a token worth a tactical scalp, but it must not masquerade as a
  // researched project worthy of larger sizing and runner exits.
  verifiedProjectMinQualityScore: num("VERIFIED_PROJECT_MIN_QUALITY_SCORE", 88),
  verifiedProjectMinResearchConfidence: num("VERIFIED_PROJECT_MIN_RESEARCH_CONFIDENCE", 75),
  verifiedProjectMinContractScore: num("VERIFIED_PROJECT_MIN_CONTRACT_SCORE", 85),
  verifiedProjectMinUtilityScore: num("VERIFIED_PROJECT_MIN_UTILITY_SCORE", 75),
  verifiedProjectMinCredibilityScore: num("VERIFIED_PROJECT_MIN_CREDIBILITY_SCORE", 65),
  verifiedProjectMinWebsiteScore: num("VERIFIED_PROJECT_MIN_WEBSITE_SCORE", 65),
  verifiedProjectMinLiquidityMultiple: num("VERIFIED_PROJECT_MIN_LIQUIDITY_MULTIPLE", 1.5),
  // Raised 2026-09-18 from a 0.2 "small probe" multiplier: that sizing dated
  // to when MOMENTUM_TACTICAL could still mean "momentum-qualified but
  // possibly meme/no-utility" (the old momentum-override bypass). Post
  // utility-gate-closure, every MOMENTUM_TACTICAL candidate already cleared
  // the same utility gate as VERIFIED_PROJECT — it just didn't hit the
  // highest score tier — so it no longer deserves probe-only treatment, just
  // a modest discount versus the fully-verified lane.
  tacticalLaneSizeMultiplier: num("TACTICAL_LANE_SIZE_MULTIPLIER", 0.75),
  // Hard probe-dollar ceiling for this lane, disabled by default as of
  // 2026-09-18 (0 = no cap, see riskEngine.ts's sizing) for the same reason
  // as tacticalLaneSizeMultiplier above — sizing for this lane now runs
  // through the normal formula plus that multiplier and the usual
  // single-position-percent cap, same as VERIFIED_PROJECT, rather than a
  // fixed few-dollar ceiling meant for an unproven/possibly-meme lane.
  tacticalLiveMaxPositionUsd: num("TACTICAL_LIVE_MAX_POSITION_USD", 0),
  // Second, higher ceiling for candidates that clear evaluateHighConvictionSetup
  // (conservativeMode.ts) — already computed pre-entry, so this costs nothing
  // extra. Still a hardcoded ceiling, not an unbounded "size by AI confidence"
  // formula: the probe-tier cap above stays the default for everything else.
  tacticalLiveMaxPositionUsdHighConviction: num("TACTICAL_LIVE_MAX_POSITION_USD_HIGH_CONVICTION", 10),
  // Reopened 2026-09-20 (user directive): "let's trade memecoins THAT HAVE A
  // REAL AND GOOD NARRATIVE behind them, not just any memecoin... you must
  // check the tweet, see if it is a VERY GOOD and preferably VIRAL meme /
  // concept before investing a penny in it." This is a deliberate, separate
  // decision from the 2026-09-18 utility-only pivot, not a reversal of it —
  // the utility gate (utilityGate.ts) is untouched and still the only path
  // for non-memecoin tokens. What changed here is narrower and stricter than
  // the pre-2026-09-18 version of this lane: back then a token could reach
  // this lane on dex/market momentum alone (see the old, since-removed
  // canBypassUtilityGateForMomentum / classify.ts momentum override — the
  // exact "chase the trend regardless of what it is" pattern the losses were
  // traced to). Now narrativeRequireAiNarrativeQuality below makes an actual
  // AI read of real tweet text a hard, unwaivable gate — no verified narrative
  // content, no trade, regardless of how strong the dex/market numbers look.
  narrativeTradingEnabled: bool("NARRATIVE_TRADING_ENABLED", true),
  // Hard gate (evaluateNarrativeQuality in narratives.ts): an AI must read
  // real sample tweet text about the meta and confirm it's a genuinely good,
  // organically viral concept — not just high tweet/account counts, which a
  // bot-scanner network can produce for free. No X data at all (no bearer
  // token, search error, or zero tweets found) fails this closed: "you must
  // check the tweet... before investing a penny" means no verification, no
  // trade, never a silent pass-through. Kill switch only for an incident;
  // this is the entire point of reopening this lane, not optional tuning.
  narrativeRequireAiNarrativeQuality: bool("NARRATIVE_REQUIRE_AI_NARRATIVE_QUALITY", true),
  narrativeMinAiViralityScore: num("NARRATIVE_MIN_AI_VIRALITY_SCORE", 60),
  // Guide heuristic (Spyzer memecoin guide, "MC vs Volume" section): healthy
  // organic trading turns over a meaningful fraction of market cap; a token
  // trading far below that is a bundling/low-float red flag — few wallets
  // holding most of the supply, barely trading it among themselves. The
  // guide's own bar (80%) is calibrated for a token's first hour on a bonding
  // curve; this checks 24h volume against CURRENT mcap for an already-
  // trending meta's candidates (which can be hours-to-days old, not
  // minutes), so the bar is deliberately much lower — this is a supplementary
  // red-flag signal alongside the volume/liquidity and buy-ratio checks
  // above, not a replacement for either.
  narrativeMinVolumeToMcapRatio24h: num("NARRATIVE_MIN_VOLUME_TO_MCAP_RATIO_24H", 0.15),
  narrativePollIntervalSeconds: num("NARRATIVE_POLL_INTERVAL_SECONDS", 180),
  narrativeMaxMetasPerPoll: num("NARRATIVE_MAX_METAS_PER_POLL", 8),
  narrativeMaxPairsPerMeta: num("NARRATIVE_MAX_PAIRS_PER_META", 8),
  narrativeMaxXSearchesPerPoll: num("NARRATIVE_MAX_X_SEARCHES_PER_POLL", 3),
  narrativeMinScore: num("NARRATIVE_MIN_SCORE", 68),
  narrativeMinLiquidityUsd: num("NARRATIVE_MIN_LIQUIDITY_USD", 8000),
  narrativeMinHourlyTxns: num("NARRATIVE_MIN_HOURLY_TXNS", 20),
  narrativeMinBuyRatio1h: num("NARRATIVE_MIN_BUY_RATIO_1H", 0.5),
  narrativeMaxBuyRatio1h: num("NARRATIVE_MAX_BUY_RATIO_1H", 0.88),
  narrativeMaxVolumeToLiquidity1h: num("NARRATIVE_MAX_VOLUME_TO_LIQUIDITY_1H", 10),
  narrativeMinMetaVolumeUsd: num("NARRATIVE_MIN_META_VOLUME_USD", 1_000_000),
  narrativeMinMetaLiquidityUsd: num("NARRATIVE_MIN_META_LIQUIDITY_USD", 250_000),
  narrativeMinTokenCount: num("NARRATIVE_MIN_TOKEN_COUNT", 3),
  narrativeLaneSizeMultiplier: num("NARRATIVE_LANE_SIZE_MULTIPLIER", 0.15),
  // See tacticalLiveMaxPositionUsd's comment — same gas-floor-alignment reasoning.
  narrativeLiveMaxPositionUsd: num("NARRATIVE_LIVE_MAX_POSITION_USD", 3.5),
  // See tacticalLiveMaxPositionUsdHighConviction — same idea for the narrative lane.
  narrativeLiveMaxPositionUsdHighConviction: num("NARRATIVE_LIVE_MAX_POSITION_USD_HIGH_CONVICTION", 10),
  // Bounded nudge applied by the CohortStats "similar past projects" lookup in
  // calculatePositionSize — never enough on its own to cross a tier ceiling.
  cohortSizeMultiplierMax: num("COHORT_SIZE_MULTIPLIER_MAX", 1.25),
  cohortSizeMultiplierMin: num("COHORT_SIZE_MULTIPLIER_MIN", 0.75),
  cohortSizeMultiplierMinSampleSize: num("COHORT_SIZE_MULTIPLIER_MIN_SAMPLE_SIZE", 20),

  // Chart-vision gate on TRAILING_EXIT only (positionManager.ts) — never on
  // RISK_EXIT/INVALIDATION_EXIT, which return before this gate ever runs.
  // User directive 2026-09-16: don't panic-sell a retracement inside an
  // intact uptrend; read the actual chart instead of price % alone.
  chartVisionGateEnabled: bool("CHART_VISION_GATE_ENABLED", true),
  chartVisionModel: str("CHART_VISION_MODEL", "gemini-flash-lite-latest"),
  // Rendered from this trade's own PositionSnapshot history (chartVisionGate.ts) —
  // below this many snapshots there's too little price/volume shape to
  // classify meaningfully, so the gate fails open instead of rendering a
  // near-empty chart. A screenshot-of-DexScreener approach was tried first
  // and dropped: measured live 2026-09-16 at ~9-11s per screenshot (and
  // sometimes still not loaded by then), and GeckoTerminal's free OHLCV API
  // (considered as a faster alternative) doesn't index Robinhood Chain at
  // all. Self-rendering needs no external fetch and is exactly as fresh as
  // the trigger itself.
  chartRenderMinSnapshots: num("CHART_RENDER_MIN_SNAPSHOTS", 5),
  // Only defer the exit when the model is this sure it's a retracement, not a
  // reversal — anything less confident falls through to today's behavior.
  chartVisionMinConfidenceToDefer: num("CHART_VISION_MIN_CONFIDENCE_TO_DEFER", 0.65),
  // Caps how many consecutive ticks a single trade's trailing exit can be
  // deferred — a wrong read can delay an exit, never suppress it indefinitely.
  chartVisionMaxConsecutiveDefers: num("CHART_VISION_MAX_CONSECUTIVE_DEFERS", 2),
  // narrativeVolumeExitAfterMinutes/MinTxns5mToHold/MinBuyRatio5mToHold kept:
  // still read by positionManager.ts's NARRATIVE_TACTICAL branch, which is
  // dormant while narrativeTradingEnabled=false but not deleted code.
  // The matching *MaxLossPercent/*CatastrophicLossPercent/
  // *TrailingActivationMultiple/*TrailingPercent/*MaxHoldMinutes caps for
  // both the narrative and tactical lanes were removed 2026-09-18: they
  // existed to force a tighter, faster-exit profile on those lanes because a
  // trade landing there used to mean "speculative/momentum/possibly meme."
  // That's no longer possible post-utility-gate-closure (see
  // positionManager.ts's resolveExitRules), so those tighter caps no longer
  // apply to anything — every trade reaching either lane already cleared the
  // same utility gate as VERIFIED_PROJECT and gets the same patient handling.
  narrativeVolumeExitAfterMinutes: num("NARRATIVE_VOLUME_EXIT_AFTER_MINUTES", 8),
  narrativeMinTxns5mToHold: num("NARRATIVE_MIN_TXNS_5M_TO_HOLD", 3),
  narrativeMinBuyRatio5mToHold: num("NARRATIVE_MIN_BUY_RATIO_5M_TO_HOLD", 0.42),
  // Raised 2026-09-18: this is now the primary (only reliably populated)
  // trading lane under the utility-only pivot — see tacticalLaneSizeMultiplier
  // below for the other lane's matching change.
  verifiedLaneSizeMultiplier: num("VERIFIED_LANE_SIZE_MULTIPLIER", 1.5),
  moonbagRetainPercent: num("MOONBAG_RETAIN_PERCENT", 15),
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
  // The entry-sizing mirror of the exit-side logic above: a REWARD, not a
  // penalty — a strong candidate found at or below sizeBoostSweetSpotMcapUsd
  // gets sized up toward maxMcapSizeBoostMultiple, tapering back to 1x
  // (no boost, never a penalty — that's what fastFlip above already handles
  // on the exit side) by sizeBoostTaperOffMcapUsd. Deliberately the same
  // $2M taper-off ceiling as fastFlipAboveMarketCapUsd so the two don't
  // disagree about where "large" starts. Consumed by riskEngine.ts's
  // calculatePositionSize.
  sizeBoostSweetSpotMcapUsd: num("SIZE_BOOST_SWEET_SPOT_MARKET_CAP_USD", 200_000),
  sizeBoostTaperOffMcapUsd: num("SIZE_BOOST_TAPER_OFF_MARKET_CAP_USD", 2_000_000),
  maxMcapSizeBoostMultiple: num("MAX_MCAP_SIZE_BOOST_MULTIPLE", 1.5),

  // Capital buckets (§22) — all against the PAPER starting balance below.
  minReservePercent: num("MIN_RESERVE_PERCENT", 50),
  maxTotalDeployedPercent: num("MAX_TOTAL_DEPLOYED_PERCENT", 50),
  // User directive 2026-09-17: real equity is ~$23 — "in the 10s literally" —
  // where fixed costs (gas) dominate any trade sized off a flat cap tuned for
  // a much bigger account. maxSinglePositionPercent below (currently 30 in
  // production — already bumped once from this file's 25 default) now
  // tapers UP from that steady-state value toward
  // smallAccountMaxSinglePositionPercent (40%) at/below smallAccountEquityUsd,
  // and back down to steady-state by largeAccountEquityUsd (see
  // calculatePositionSize's lerp on this, same tapering shape as the mcap
  // sweet-spot boost above) — bigger bets while capital is this thin,
  // automatically de-risking back to today's normal as the account actually
  // grows, with no manual re-tuning needed at each milestone.
  smallAccountEquityUsd: num("SMALL_ACCOUNT_EQUITY_USD", 50),
  largeAccountEquityUsd: num("LARGE_ACCOUNT_EQUITY_USD", 300),
  smallAccountMaxSinglePositionPercent: num("SMALL_ACCOUNT_MAX_SINGLE_POSITION_PERCENT", 40),
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

  // Conservative mode (user directive 2026-09-11). When one of the two LOSS
  // breakers above trips, new entries no longer stop outright: the bot keeps
  // detecting, planning and sniping, but only buys a candidate that also
  // clears a strict high-conviction gate at trigger time (see
  // conservativeMode.ts). Exits are unchanged. The other breakers (kill
  // switch, gas, max open positions) still pause entries completely.
  //
  // Thresholds come from the 2026-09-11 loss review
  // (docs/trade-reviews/2026-09-11.md): 15 live trades plus 24h outcomes for
  // 340 candidates. Across those candidates the market-structure part of the
  // gate (age, liquidity, txns, buy ratio, volume/liquidity, price change)
  // raised the chance of a 1.5x from 39% to 45% and cut the chance of a -50%
  // fall within 24h from 54% to 5% — n=20, small, so re-check as data grows.
  // It would have blocked all 15 of that day's trades.
  conservativeModeEnabled: bool("CONSERVATIVE_MODE_ENABLED", true),
  // Conservative mode keeps trading, so past either of these entries pause
  // completely again, exactly as they did before this mode existed.
  conservativeHardStopDailyLossPercent: num("CONSERVATIVE_HARD_STOP_DAILY_LOSS_PERCENT", 35),
  conservativeHardStopConsecutiveLosses: num("CONSERVATIVE_HARD_STOP_CONSECUTIVE_LOSSES", 5),
  //
  // User directive 2026-09-12: raised across the board. A tripped LOSS
  // breaker was hard-disabling this mode entirely (full pause) for several
  // hours tonight, during which discovery/research/planning kept running —
  // and kept spending real AI and X API credits — on candidates that could
  // never be traded. "Why are we paying for research we can't act on" is a
  // real cost with no offsetting benefit; a much stricter version of this
  // gate at least lets the pipeline's own output occasionally pay for
  // itself on genuinely rare, excellent setups, rather than blocking
  // everything indiscriminately. Re-checked against the fuller dataset this
  // covers now (491 candidates across ~3.3 days, up from 340/15 trades):
  // this tightened bundle passes only ~1-1.5 candidates/day (O1BOT, PRISM,
  // PROLOGUE, LAURA, WALL3 in that window), all with max24h between
  // 1.4x-2.7x and zero drawdown worse than -19% — genuinely rare, but
  // n=4-5 is small; re-check as more data comes in under the new bar,
  // same caveat the original thresholds carried.
  //
  // Candidates under an hour old fell 50%+ within 24h 74-85% of the time, vs
  // 16% for tokens over a day old. All nine of 2026-09-11's trades that went
  // to near zero were under 30 minutes old at entry. Not raised further this
  // pass — the backtest above found no additional benefit past 60 min.
  conservativeMinTokenAgeMinutes: num("CONSERVATIVE_MIN_TOKEN_AGE_MINUTES", 60),
  conservativeMinLiquidityUsd: num("CONSERVATIVE_MIN_LIQUIDITY_USD", 60_000),
  conservativeMinHourlyTxns: num("CONSERVATIVE_MIN_HOURLY_TXNS", 50),
  // Buy ratio mattered most of everything tested: moving the floor from 52%
  // to 55% took the -50%-fall rate from 12% to 5%. Around 50% is churn, not
  // accumulation (BLACKHOLE, FFSTR, OPAI); well above 80% is usually bots
  // ahead of a dump. Narrowed further 2026-09-12 for the same reason.
  conservativeMinBuyRatio1h: num("CONSERVATIVE_MIN_BUY_RATIO_1H", 0.57),
  conservativeMaxBuyRatio1h: num("CONSERVATIVE_MAX_BUY_RATIO_1H", 0.78),
  // An hour's volume far above the pool's liquidity is wash/churn trading —
  // PONSFLY traded 27x its liquidity in an hour, OPAI 40x.
  conservativeMaxVolumeToLiquidity1h: num("CONSERVATIVE_MAX_VOLUME_TO_LIQUIDITY_1H", 4),
  conservativeMinPriceChange1hPercent: num("CONSERVATIVE_MIN_PRICE_CHANGE_1H_PERCENT", -25),
  // Lowered hard from 500%: THREE was already +7,553% on the hour when it
  // triggered and it was a chase, not a discovery — this bundle isn't meant
  // to catch a token mid-parabola at all, chasing is what evaluateChaseGuard
  // (below) and the discovery pipeline's own momentum override are for.
  conservativeMaxPriceChange1hPercent: num("CONSERVATIVE_MAX_PRICE_CHANGE_1H_PERCENT", 350),
  conservativeMinPriceChange5mPercent: num("CONSERVATIVE_MIN_PRICE_CHANGE_5M_PERCENT", -15),
  conservativeMaxPriceChange5mPercent: num("CONSERVATIVE_MAX_PRICE_CHANGE_5M_PERCENT", 25),
  // Measured on OUR OWN MarketSnapshot history, not DexScreener's 5m change,
  // which lags on this chain: BLACKHOLE's reported 5m change was -9% while our
  // snapshots showed a +46% run-up in 3 minutes. The four trades that chased a
  // 37-54% run-up (BLACKHOLE, PONSIBLE, THREE, MARRONA) lost $9.90 between
  // them; every winner was bought after a 0-8% run-up.
  //
  // User directive 2026-09-12: these three (window/snapshots/run-up) also
  // gate conservativeMode.ts's evaluateChaseGuard, which entryMonitor.ts runs
  // for normal WAIT_FOR_ENTRY plans and all conservative-mode entries. Normal
  // BUY_NOW bypasses this one guard because the planner has explicitly chosen
  // to enter a live move immediately; sell-path, honeypot, real-demand,
  // slippage/impact, quote, holder and portfolio checks still run. Only the
  // window/snapshot-count are actually shared, though: the run-up bar itself
  // is conservativeStrictMaxRunUpPercent below, deliberately a SEPARATE,
  // stricter number, so raising conservative mode's own bar can never quietly
  // tighten normal mode's already-tuned chase guard too.
  // conservativeMaxRecentDrawdownPercent stays conservative-mode-only.
  conservativeRecentWindowMinutes: num("CONSERVATIVE_RECENT_WINDOW_MINUTES", 10),
  conservativeMinRecentSnapshots: num("CONSERVATIVE_MIN_RECENT_SNAPSHOTS", 3),
  // Normal mode's always-on chase guard (entryMonitor.ts) — unchanged 2026-09-12.
  conservativeMaxRecentRunUpPercent: num("CONSERVATIVE_MAX_RECENT_RUN_UP_PERCENT", 30),
  // Conservative-mode-only, stricter than the shared value above — see the
  // note on conservativeRecentWindowMinutes.
  conservativeStrictMaxRunUpPercent: num("CONSERVATIVE_STRICT_MAX_RUN_UP_PERCENT", 25),
  conservativeMaxRecentDrawdownPercent: num("CONSERVATIVE_MAX_RECENT_DRAWDOWN_PERCENT", 18),
  // The AI plan's own risk score; at or above this the entry is held back.
  // Candidates whose plan scored 85+ fell 50%+ within 24h 68% of the time.
  // Lowered hard 2026-09-12 to only accept a plan the AI itself assessed as
  // low-to-moderate risk, not merely "under the old, much higher bar."
  conservativeMaxPlanRiskScore: num("CONSERVATIVE_MAX_PLAN_RISK_SCORE", 70),
  // How far below DexScreener's price the on-chain quote may come in before
  // the data is treated as stale — see conservativeMode.ts's
  // evaluateQuoteAgreement. Conservative-mode-only value; normal mode uses
  // normalMaxQuoteDiscountPercent below, looser on purpose.
  conservativeMaxQuoteDiscountPercent: num("CONSERVATIVE_MAX_QUOTE_DISCOUNT_PERCENT", 10),
  // User directive 2026-09-12: the same stale-quote check, applied to every
  // entry, not just conservative mode — but looser here, because TUMBLE (the
  // day's best trade, +$4.87) filled 25% below DexScreener's displayed price
  // during a genuine dip and shouldn't be blocked outside conservative mode.
  normalMaxQuoteDiscountPercent: num("NORMAL_MAX_QUOTE_DISCOUNT_PERCENT", 30),
  // User directive 2026-09-13: "the narrative has to be good AND we have to
  // leverage the volume — nobody is your friend in this market." Before this,
  // only conservative mode's evaluateHighConvictionSetup ever checked real
  // buy-side activity (conservativeMin/MaxBuyRatio1h etc, tuned against the
  // 2026-09-11/12 loss reviews) — normal mode bought on narrative/quality/
  // confidence alone regardless of whether real trading demand backed it.
  // conservativeMode.ts's evaluateRealDemand now runs this loosened version
  // in EVERY mode. These are a starting heuristic with no trade data of their
  // own yet (deliberately wider than the tuned conservative numbers so this
  // doesn't just re-implement conservative mode everywhere) — revisit once
  // outcomes accrue at this bar, same as every other threshold in this file.
  normalMinHourlyTxns: num("NORMAL_MIN_HOURLY_TXNS", 15),
  normalMinBuyRatio1h: num("NORMAL_MIN_BUY_RATIO_1H", 0.5),
  normalMaxBuyRatio1h: num("NORMAL_MAX_BUY_RATIO_1H", 0.85),
  normalMaxVolumeToLiquidity1h: num("NORMAL_MAX_VOLUME_TO_LIQUIDITY_1H", 8),
  // User directive 2026-09-13: "how do we know if someone is going to rug the
  // project with a few sells" — holderScoreStub in scoring/index.ts has never
  // actually measured this (no holder-distribution data source existed; it
  // always returns a fixed neutral 50). holderConcentration.ts now reads real
  // Transfer-log history via RPC at entry time and blocks a buy when a
  // handful of wallets hold enough of supply to tank price on their own. No
  // trade data backs these starting numbers yet — revisit as outcomes come in.
  holderCheckEnabled: bool("HOLDER_CHECK_ENABLED", true),
  maxTop1HolderPercent: num("MAX_TOP1_HOLDER_PERCENT", 15),
  maxTop10HolderPercent: num("MAX_TOP10_HOLDER_PERCENT", 50),
  minHolderCountForEntry: num("MIN_HOLDER_COUNT_FOR_ENTRY", 15),
  // User directive 2026-09-12: riskEngine.ts's validatePosition no longer
  // fires "extreme sell pressure" below this many total 5m buys+sells.
  // Confirmed live 2026-09-11: PERPSHOOD was sold on "extreme sell pressure
  // (buy ratio 0%)" from a 5-minute window with 0 buys and 0 sells — the 0%
  // ratio was buySellRatio5m's own divide-by-zero guard reading as total
  // capitulation, not real sell pressure. It went on to reach 1.68x.
  minTxns5mForSellPressureExit: num("MIN_TXNS_5M_FOR_SELL_PRESSURE_EXIT", 5),
  // User directive 2026-09-11 — "profit lockbox": skim this fraction of
  // every POSITIVE realized gain into a reserve the sizing formula can never
  // redeploy (see portfolio.ts's CASH_MOVEMENT_TYPES and
  // positionManager.ts's executeSell). Never applied to a loss — only
  // realized gains get skimmed. 0 disables it entirely.
  profitLockboxPercent: num("PROFIT_LOCKBOX_PERCENT", 25),

  // Learning/outcome labels. Raw max multiples are kept, but these thresholds
  // decide whether a peak counts as realistically tradable for the "feasible"
  // labels used by diagnostics and learning summaries.
  outcomeFeasibleSellQuoteEnabled: bool("OUTCOME_FEASIBLE_SELL_QUOTE_ENABLED", true),
  outcomeFeasibleProbeUsd: num("OUTCOME_FEASIBLE_PROBE_USD", 10),
  outcomeFeasibleMinLiquidityUsd: num("OUTCOME_FEASIBLE_MIN_LIQUIDITY_USD", 15_000),
  outcomeFeasibleMinLiquidityToMcapRatio: num("OUTCOME_FEASIBLE_MIN_LIQUIDITY_TO_MCAP_RATIO", 0.04),
  outcomeFeasibleMaxSellImpactPercent: num("OUTCOME_FEASIBLE_MAX_SELL_IMPACT_PERCENT", 10),

  // Entry lifecycle.
  defaultEntryPlanTtlMinutes: num("DEFAULT_ENTRY_PLAN_TTL_MINUTES", 360),
  // Swap logs can be much denser than Initialize logs, so keep each
  // eth_getLogs range small enough to avoid provider response-size limits
  // while still covering a fresh token's whole life in a handful of calls.
  swapHistoryScanChunkBlocks: bigint("SWAP_HISTORY_SCAN_CHUNK_BLOCKS", 20_000n),
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
  //
  // User directive 2026-09-17: confirmed live, AGRIPPA cleared MOMENTUM_TACTICAL
  // (277+ txns/1h, real liquidity) and ran +384% in an hour, but the AI kept
  // re-anchoring a new pullback target every time price broke its own
  // doNotChaseAboveMcap ceiling (3 replans, each still WAIT_FOR_ENTRY/
  // PULLBACK_ENTRY) instead of ever recommending MARKET_ENTRY — it never got
  // near the old 500%/70% bar (peaked 384% with a ~48-50% buy ratio, roughly
  // balanced buy/sell) so this override never fired. Token went on to ~4x
  // from where the bot would have entered. Loosened both bars to catch more
  // of this pattern — but same day, BTC/CLIP/BLACKHOLE/MARRONA/WORMHOLEX all
  // reversed hard chasing extended, balanced-ratio pumps that looked similar
  // at entry time, so the buy-ratio floor stays meaningfully above 50%
  // (not just "more buys than sells") rather than being dropped to match
  // AGRIPPA exactly.
  extremeMomentumOverride1hPriceChangePercent: num("EXTREME_MOMENTUM_OVERRIDE_1H_PRICE_CHANGE_PERCENT", 300),
  extremeMomentumOverrideMinBuyRatio1h: num("EXTREME_MOMENTUM_OVERRIDE_MIN_BUY_RATIO_1H", 0.58),

  // Active position management (§trading/positionStrategy.ts) — the AI
  // reviews an open position's strategy periodically, proposing partial-
  // profit/exit/re-entry-target decisions that deterministic code then
  // enforces or executes. Hard caps here bound it regardless of what the AI
  // recommends.
  //
  // User directive 2026-09-22: no more fixed profit-taking multiples —
  // evaluateExits's old PROFIT_TARGET step ladder is gone, so this review is
  // now the ONLY thing that ever decides to take profit on a live position
  // (RISK_EXIT/INVALIDATION_EXIT/TRAILING_EXIT/TIME_EXIT still run every
  // tick, unchanged, as loss protection). Seconds, not minutes, so it can
  // actually react "as the chart progresses" rather than checking in every
  // couple of minutes. Previously capped at 2 minutes specifically to protect
  // the shared Gemini rate-limit budget from classification/research/
  // planning — that budget is now an unbounded multi-key rotation pool (see
  // config.ts's geminiApiKeys) instead of a fixed 3 keys, which is what makes
  // going this much faster reasonable. Position count is small (circuit
  // breakers cap it around 2 open at a time), so worst case is a handful of
  // extra calls per interval, not an unbounded fan-out. Tune down further if
  // quota pressure shows up again.
  positionStrategyReviewIntervalSeconds: num("POSITION_STRATEGY_REVIEW_INTERVAL_SECONDS", 30),
  // User directive 2026-09-22: "we can even DCA if the narrative or utility
  // project is very good" — re-entry (DCA) budget is now tiered by
  // positionManager.ts's resolveProjectTier, the same GOOD_PROJECT/BASE/
  // FAST_FLIP classification used for the extended-hold decision. A trade
  // has to actually earn the full DCA budget, not get it by default. Every
  // re-entry is still capped at the tier's *PercentOfOriginal of the
  // ORIGINAL position (not compounding), and every one still passes the
  // same entry-risk gate a fresh trade would, regardless of tier.
  //
  // GOOD_PROJECT: unchanged from the old blanket defaults (raised from 1
  // re-entry originally because the AI strategy review already implements
  // exactly a buy-the-dip/sell-the-resistance cycle via repeated
  // TAKE_PARTIAL_PROFIT + SET_REENTRY_TARGET decisions) — now the tier a
  // trade has to earn (fastFlip-eligibility cleared + confirmed X
  // community) rather than what every trade got by default.
  maxReentriesPerTradeGoodProject: num("MAX_REENTRIES_PER_TRADE_GOOD_PROJECT", 5),
  maxReentryPercentOfOriginalGoodProject: num("MAX_REENTRY_PERCENT_OF_ORIGINAL_GOOD_PROJECT", 50),
  // BASE: decent research scores but no confirmed strong X community —
  // some flexibility, well short of full DCA privileges.
  maxReentriesPerTradeBase: num("MAX_REENTRIES_PER_TRADE_BASE", 2),
  maxReentryPercentOfOriginalBase: num("MAX_REENTRY_PERCENT_OF_ORIGINAL_BASE", 25),
  // FAST_FLIP: low-quality or an unproven large-mcap entry — don't average
  // down into a thesis that hasn't earned any patience to begin with.
  maxReentriesPerTradeFastFlip: num("MAX_REENTRIES_PER_TRADE_FAST_FLIP", 0),
  maxReentryPercentOfOriginalFastFlip: num("MAX_REENTRY_PERCENT_OF_ORIGINAL_FAST_FLIP", 0),

  // Slippage / price-impact ceilings, used by the paper fill model (§29/§88)
  // even though nothing is actually routed on-chain in this build.
  defaultMaxBuySlippageBps: num("DEFAULT_MAX_BUY_SLIPPAGE_BPS", 300),
  defaultMaxSellSlippageBps: num("DEFAULT_MAX_SELL_SLIPPAGE_BPS", 500),
  emergencyMaxSellSlippageBps: num("EMERGENCY_MAX_SELL_SLIPPAGE_BPS", 1000),
  maxBuyPriceImpactPercent: num("MAX_BUY_PRICE_IMPACT_PERCENT", 3),
  // Tactical LIVE entries are capped to tiny probe sizes. A $1-$2.50 scout
  // entry on a 5x runner should tolerate a worse fill than a normal-sized
  // position, as long as the quote is not suspiciously broken and exits still
  // simulate. MULTI/Maltese was rejected at 7.25% impact on a probe-sized
  // BUY_NOW trigger, then kept running; these caps are deliberately below the
  // suspicious-quote threshold in executionFacade.ts.
  tacticalProbeMaxBuySlippageBps: num("TACTICAL_PROBE_MAX_BUY_SLIPPAGE_BPS", 1000),
  tacticalProbeMaxBuyPriceImpactPercent: num("TACTICAL_PROBE_MAX_BUY_PRICE_IMPACT_PERCENT", 10),
  // Confirmed live 2026-09-11: OPAI sat at +322% unrealized while every exit
  // was rejected by the slippage guard and retried every few seconds,
  // indefinitely — its only venue was an 18%-fee pool, so the estimate could
  // never come in under defaultMaxSellSlippageBps no matter how long we
  // waited. A guard that can never be satisfied isn't protecting the
  // position, it's trapping it. After this long continuously blocked, the
  // exit is retried as an emergency one (validateExit already lets an
  // emergency through "to avoid an orphaned position"), on the reasoning
  // that a bad fill beats an unsellable bag. 0 disables escalation.
  stuckExitEscalateAfterMinutes: num("STUCK_EXIT_ESCALATE_AFTER_MINUTES", 5),

  // Execution-failure alerting (see executionAlerts.ts). Both bugs that
  // trapped every open position on 2026-09-11 retried silently in the logs
  // for hours and were only caught by a human noticing the bags weren't
  // moving — these exist so the next one announces itself instead.
  // A failing SELL is tracked per token by DURATION, because it retries the
  // same position every couple of seconds and the danger is how long the
  // position stays un-exitable. Set to 15 rather than something twitchy:
  // stuckExitEscalateAfterMinutes (5) gets its chance to rescue the exit
  // first, so an alert here means even escalation didn't work.
  sellFailureAlertAfterMinutes: num("SELL_FAILURE_ALERT_AFTER_MINUTES", 15),
  // User directive 2026-09-13 (SL/"Stonks Launch"): openTrade's post-buy
  // canWalletTransferToken probe catches most honeypots the instant a buy
  // confirms, but a token can also be genuinely sellable at entry and get
  // blacklisted/rug-pulled afterward — that still retries forever with no
  // give-up path. Longer than the alert above on purpose: the alert exists
  // so a human can look, this exists so the bot stops burning RPC calls and
  // holding a position slot if nobody does. 0 disables (retry forever).
  sellGiveUpAfterMinutes: num("SELL_GIVE_UP_AFTER_MINUTES", 60),
  // Entry-side counterpart, user directive 2026-09-22: a manual buy-and-hold
  // PendingEntry has no expiresAt by design (see entryMonitor.ts's
  // sellPathUnavailableSince doc comment) — this is the ONLY thing that ever
  // gives up on one, and only for the specific "no sell path" DEFER reason,
  // never for "waiting on deployable capital" or other transient DEFER
  // causes. Longer than sellGiveUpAfterMinutes on purpose: an entry-side
  // pool can plausibly be behind a real, temporary anti-bot/launch-cooldown
  // hook, which a position we're already holding never would be — give that
  // more room before concluding it's permanently broken/a honeypot.
  manualBuyAndHoldSellPathGiveUpMinutes: num("MANUAL_BUY_AND_HOLD_SELL_PATH_GIVE_UP_MINUTES", 240),
  // User directive 2026-09-24, after DESKS ran 3-4x while its manual buy was
  // permanently REJECTED by a single non-transient execution crash (a code
  // bug in Solana signing, not anything about the token): "it should have
  // never been rejected." A manual buy-and-hold is an explicit human "buy
  // this" — one failed attempt must not kill it. Each non-transient failure
  // now retries on the normal infra cooldown (PENDING_ENTRY_INFRA_COOLDOWN_MS,
  // 60s) up to this many times before giving up, so a bug fixed by a
  // redeploy inside the window still gets the buy through. Bounded because a
  // failing EVM swap can spend gas on every attempt, which is why automatic
  // entries still reject on the first non-transient failure.
  manualBuyAndHoldMaxExecutionFailures: num("MANUAL_BUY_AND_HOLD_MAX_EXECUTION_FAILURES", 30),
  // User directive 2026-09-24, after MUSETOWN (researched with $0.69 in its
  // brand-new pool, permanently rejected, then ran 63x): "we can still invest
  // in these kinds of tokens even if the pool just opened, instead of
  // rejecting them outright." A candidate that clears every gate except pool
  // depth waits — re-checked against fresh market data every
  // liquidityWaitRetryMinutes, planned the moment liquidity reaches
  // MIN_TRADE_LIQUIDITY_USD — and is only given up on after
  // liquidityWaitMaxHours with no liquidity ever arriving. Each re-check is a
  // DexScreener poll, no AI call.
  liquidityWaitRetryMinutes: num("LIQUIDITY_WAIT_RETRY_MINUTES", 2),
  liquidityWaitMaxHours: num("LIQUIDITY_WAIT_MAX_HOURS", 24),
  // A failing BUY doesn't retry the same candidate, so duration is
  // meaningless — what matters is the rate across all tokens. Several
  // failures in a short window means something systemic (RPC, gas, routing)
  // rather than one bad token.
  buyFailureAlertCount: num("BUY_FAILURE_ALERT_COUNT", 4),
  buyFailureAlertWindowMinutes: num("BUY_FAILURE_ALERT_WINDOW_MINUTES", 15),
  // Per-token (sells) / global (buys) quiet period after an alert, so one
  // ongoing problem is one email rather than a repeating one.
  executionAlertCooldownMinutes: num("EXECUTION_ALERT_COOLDOWN_MINUTES", 360),

  // Small-account gas-ratio check (§23) — Robinhood Chain is a cheap L2, so
  // this is a small flat simulated cost, not a real gas oracle call.
  //
  // User directive 2026-09-17: real equity is ~$23, and gasViableFloorUsd
  // (riskEngine.ts) = paperAssumedGasCostUsd*100/this — at the old 5% cap
  // that floor was exactly $1.00, confirmed live on RECORD/CYCLE/XBOW/SCAN,
  // which paid ~4-5% of their entire position to gas alone before the trade
  // even had a chance. Tightened to 1.5%, raising the floor to ~$3.33 —
  // still a hard reject above this ratio (line ~285), just a saner minimum
  // trade size for an account this small.
  maxGasCostPercentOfPosition: num("MAX_GAS_COST_PERCENT_OF_POSITION", 1.5),
  paperAssumedGasCostUsd: num("PAPER_ASSUMED_GAS_COST_USD", 0.05),

  defaultMaxHoldMinutes: num("DEFAULT_MAX_HOLD_MINUTES", 1440),
  // User directive 2026-09-22, raised 2026-09-23 ("hold good utility tokens
  // for as long as possible, not just 48 hours max"): a genuinely strong
  // project (clears the fastFlip bar AND has a confirmed real X community —
  // see ExitRules.goodProject's doc comment in strategy.ts) gets no
  // meaningful cap before the underwater-only TIME_EXIT would force-close
  // it, vs. the usual 24h base/60min fastFlip profiles. A year, not
  // Infinity — JSON (and the DB-stored StrategyVersion.exitRules it lands
  // in) can't represent Infinity, and positionStrategy.ts's
  // formatExitRulesState treats anything >= a year as "no real cap" for
  // display rather than printing an absurd hour count. Only used as the
  // code-default seed StrategyVersion's value; the live strategy's own
  // exitRules.goodProject.maxHoldMinutes (versioned, DB-held) is what
  // actually governs production once a version carrying it exists.
  goodProjectMaxHoldMinutes: num("GOOD_PROJECT_MAX_HOLD_MINUTES", 60 * 24 * 365),

  // LIVE-only (§30/§80) — ignored entirely in PAPER/SHADOW.
  minGasBalanceEth: num("MIN_GAS_BALANCE_ETH", 0.002),
  // Solana counterpart, checked only when solanaTradingEnabled — Solana fees
  // are much smaller than EVM gas, but priority fees on a congested slot and
  // multiple compute-budget/token-account instructions per swap can still add
  // up; this floor is a rough safety margin, not a precise fee estimate.
  minGasBalanceSol: num("MIN_GAS_BALANCE_SOL", 0.02),

  // Paper/shadow portfolio (§88) — there is no real wallet balance to read,
  // so the simulated ledger starts here.
  paperStartingBalanceUsd: num("PAPER_STARTING_BALANCE_USD", 1000),
};

export type { TradingMode };

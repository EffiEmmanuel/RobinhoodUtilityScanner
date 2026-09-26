import { db } from "../db";
import { logger } from "../logger";
import { TradeStatus, LedgerEntryType } from "../generated/prisma";
import type { Trade } from "../generated/prisma";
import type { MarketPair } from "../dex/types";
import { pollCandidateMarket, computeTechnicalFeatures } from "./marketAnalysis";
import { validatePosition, validateExit, estimatedSwapGasUsd } from "./riskEngine";
import { executeSellFill, getLiveWalletTokenBalance, getSellEstimate, isSellable, gasLedgerNote, closeTokenAccountAfterFullExit, type FillResult } from "./executionFacade";
import { recordLedgerEntry, recordPortfolioSnapshot } from "./portfolio";
import { getActiveStrategyVersion, type ExitRules, type ProjectTier } from "./strategy";
import { sendPartialProfitEmail, sendTradeClosedEmail } from "./notifications";
import { generatePostmortem } from "./postmortem";
import { checkPortfolioMilestones } from "./milestones";
import { tradingConfig } from "./config";
import { shouldRunStrategyReview, runPositionStrategyReview, applyReentryTarget, checkAndExecutePendingReentry } from "./positionStrategy";
import { recordSellFailure, recordSellSuccess, getSellFailureMinutes } from "./executionAlerts";
import { normalizeTradeLane } from "./tradeLane";
import { recordExecutionQuality } from "./executionQuality";
import type { PositionStrategyDecision } from "../ai/schemas";
import { evaluateChartVisionGate, resetChartVisionDeferStreak } from "./chartVisionGate";
import { sellRealizedPnlUsd, tradeRealizedPnl } from "./pnl";

// When an exit first started being refused by the slippage guard, per trade —
// drives tradingConfig.stuckExitEscalateAfterMinutes. In memory on purpose:
// the only thing lost on a restart is the elapsed clock, which restarts
// rather than escalating something prematurely, and a position that's
// genuinely unsellable will re-accumulate the time within minutes anyway.
const exitBlockedSince = new Map<string, number>();

// reconcileExternalWalletExit's zero-balance read must be confirmed on a
// second, independently-fetched tick before it force-closes a position — a
// single lagging/load-balanced RPC read of 0 right after a fresh buy would
// otherwise permanently write off a genuinely open live position. Cleared
// the moment any tick sees a real balance.
const zeroWalletBalanceFirstSeenAt = new Map<string, number>();

function markExitBlocked(tradeId: string): void {
  if (!exitBlockedSince.has(tradeId)) exitBlockedSince.set(tradeId, Date.now());
}

function clearExitBlocked(tradeId: string): void {
  exitBlockedSince.delete(tradeId);
}

function blockedExitAgeMinutes(tradeId: string): number {
  const since = exitBlockedSince.get(tradeId);
  return since === undefined ? 0 : (Date.now() - since) / 60_000;
}

interface ExitDecision {
  // PROFIT_TARGET (the old fixed-multiple step ladder) was removed 2026-09-22
  // — user directive: no more strict multiples, profit-taking is decided
  // by the AI strategy review (PARTIAL_PROFIT/AI_STRATEGY_EXIT). A strategy
  // version with exitRules.costRecovery (v1.9+) also emits PARTIAL_PROFIT
  // from evaluateExits, once, for its cost-recovery sell.
  type: "RISK_EXIT" | "INVALIDATION_EXIT" | "PARTIAL_PROFIT" | "TRAILING_EXIT" | "TIME_EXIT" | "AI_STRATEGY_EXIT";
  sellPercentOfRemaining: number; // 100 = full exit
  reason: string;
  isEmergency: boolean;
  // Set only for TRAILING_EXIT — feeds the chart-vision gate in
  // monitorOneTrade so it doesn't have to recompute peak/retrace itself.
  peakMultiple?: number;
  retracePercent?: number;
}

/** Single sequential loop over all open trades — deliberately not parallelized
 * (unlike the base research pipeline's worker pool) since these operations
 * move simulated money and correctness matters more than throughput at the
 * position counts a circuit breaker allows anyway (max ~2 open by default). */
export async function runPositionMonitorTick(): Promise<void> {
  const openTrades = await db.trade.findMany({
    where: { status: { in: [TradeStatus.OPEN, TradeStatus.PARTIALLY_EXITED] } },
    include: { token: false },
  });
  // Stop-confirmation timers of trades no longer open.
  for (const id of stopBreachSince.keys()) if (!openTrades.some((t) => t.id === id)) stopBreachSince.delete(id);
  for (const trade of openTrades) {
    try {
      await monitorOneTrade(trade);
    } catch (err) {
      logger.error({ tradeId: trade.id, err: String(err) }, "position monitor failed for trade");
    }
  }
  if (openTrades.length > 0) await recordPortfolioSnapshot();
}

async function monitorOneTrade(trade: Trade): Promise<void> {
  const token = await db.token.findUniqueOrThrow({ where: { id: trade.tokenId } });
  const plan = trade.tradePlanId ? await db.tradePlan.findUnique({ where: { id: trade.tradePlanId } }) : null;
  const strategy = await getActiveStrategyVersion();
  const { exitRules, tier, manualHold } = await resolveExitRules(trade, strategy.exitRules as unknown as ExitRules);

  // Same fix as entryMonitor.ts: an open position is checked every tick here,
  // but Token.lastSeenAt otherwise only reflects the base discovery poll's
  // cadence — misleading on the dashboard for a token we're actively holding.
  await db.token.update({ where: { id: trade.tokenId }, data: { lastSeenAt: new Date() } }).catch(() => {});

  const tokenAmounts = await getPositionTokenAmounts(trade);
  const remainingTokens = tokenAmounts.remainingTokens;
  if (remainingTokens <= 0) {
    // Legitimate case: prior partial sells summed to the full position but
    // the last one never got flagged as a full exit — close now. But if
    // there's no SELL execution at all, "0 remaining" means the BUY fill
    // itself recorded 0 tokens (a bad balance read, not a real 0-token buy —
    // see executeBuyFill's retry/throw guard) and closing here would credit a
    // fabricated 100% loss for a sell that never happened while real tokens
    // sit untouched in the wallet (confirmed live 2026-09-11, trade
    // cmtw8ki67000r1ymz88bfg13o). Surface it instead of papering over it.
    const sellCount = await db.tradeExecution.count({ where: { tradeId: trade.id, type: "SELL" } });
    if (sellCount === 0) {
      logger.error({ tradeId: trade.id }, "position shows 0 remaining tokens but no sell was ever executed — likely a bad entry fill; needs manual reconciliation, not auto-closing");
      return;
    }
    await closeTrade(trade, "fully exited via partial sells");
    return;
  }

  if (await reconcileExternalWalletExit(trade, token.address, token.chain, remainingTokens)) return;

  const market = await pollCandidateMarket(trade.tokenId, token.chain, token.address);
  const pair = market.primaryPair;

  // Deterministic, cheap, runs every tick regardless of the AI review cadence
  // below: executes a previously AI-proposed re-entry buy only if (and once)
  // price has actually fallen to that target — the AI never buys directly.
  await checkAndExecutePendingReentry(trade, token, pair, tier, manualHold).catch((err) =>
    logger.error({ tradeId: trade.id, err: String(err) }, "pending re-entry check failed — will retry next tick")
  );

  // User directive 2026-09-12: price this position off a real on-chain sell
  // quote for its actual remaining size, not DexScreener's spot price — see
  // executionFacade.ts's getSellEstimate doc comment for why (Sheared showed
  // +329% unrealized off pair.priceUsd while it was already collapsing).
  // getSellEstimate returns priceUsd: 0 in every failure branch (no quote, no
  // ETH rate) and PAPER/SHADOW's paper quote can legitimately be a real 0
  // only when priceUsd/liquidity are themselves 0 — either way, > 0 is the
  // right test for "this mark is usable," never trust a bare 0 as a fill.
  const markQuote = pair ? await getSellEstimate(token.address, remainingTokens, pair, token.chain).catch(() => undefined) : undefined;
  const priceUsd = markQuote && markQuote.priceUsd > 0 ? markQuote.priceUsd : (pair?.priceUsd ?? trade.entryPriceUsd ?? 0);
  const entryPriceUsd = trade.entryPriceUsd ?? 0;
  const currentMultiple = entryPriceUsd > 0 ? priceUsd / entryPriceUsd : 1;
  const unrealizedPnlPercent = (currentMultiple - 1) * 100;
  const stopBaseline = await stopBaselinePriceUsd(trade, priceUsd);
  const stopPnlPercent = stopBaseline > 0 ? (priceUsd / stopBaseline - 1) * 100 : unrealizedPnlPercent;
  const stopBreach = nextStopBreach({ exitRules, stopPnlPercent, manualHold, sinceMs: stopBreachSince.get(trade.id), nowMs: Date.now() });
  if (stopBreach.sinceMs === undefined) stopBreachSince.delete(trade.id);
  else stopBreachSince.set(trade.id, stopBreach.sinceMs);
  const unrealizedPnlUsd = remainingTokens * priceUsd - remainingTokens * entryPriceUsd;

  const newMfe = Math.max(trade.mfePercent ?? unrealizedPnlPercent, unrealizedPnlPercent);
  const newMae = Math.min(trade.maePercent ?? unrealizedPnlPercent, unrealizedPnlPercent);
  await db.trade.update({ where: { id: trade.id }, data: { mfePercent: newMfe, maePercent: newMae } });

  const buySellRatio5m =
    pair?.buys5m !== undefined || pair?.sells5m !== undefined
      ? (pair.buys5m ?? 0) / Math.max((pair.buys5m ?? 0) + (pair.sells5m ?? 0), 1)
      : undefined;
  // Raw trade count behind the ratio above — riskEngine.ts's validatePosition
  // needs this to tell a real dump from a silent window read as 100% sellers.
  const totalTxns5m = pair?.buys5m !== undefined || pair?.sells5m !== undefined ? (pair.buys5m ?? 0) + (pair.sells5m ?? 0) : undefined;

  // Continuous, free, deterministic technical read — computed every tick
  // regardless of whether an AI strategy review runs this cycle, so the
  // stored PositionSnapshot history is always complete for later analysis.
  const technical = await computeTechnicalFeatures(trade.tokenId, pair, token.address, token.chain);

  await db.positionSnapshot.create({
    data: {
      tradeId: trade.id,
      priceUsd,
      marketCapUsd: pair?.marketCapUsd,
      liquidityUsd: pair?.liquidityUsd,
      tokenAmountRemaining: remainingTokens,
      unrealizedPnlUsd,
      unrealizedPnlPercent,
      maxFavorablePercent: newMfe,
      maxAdversePercent: newMae,
      volume5m: pair?.volume5m,
      buySellRatio5m,
      technicalState: JSON.stringify(technical),
    },
  });

  // Counts prior partial-profit sells for this trade — PARTIAL_PROFIT is the
  // AI review's own type (applyAiStrategyDecision); PROFIT_TARGET is kept in
  // this count only for trades that took steps under the old fixed-multiple
  // ladder before it was removed 2026-09-22, so a trade straddling that
  // change still reports an accurate count to the AI.
  const partialSellsCount = await db.exitSignal.count({ where: { tradeId: trade.id, type: { in: ["PARTIAL_PROFIT", "PROFIT_TARGET"] } } });
  // v1.9+ only: whether the cost-recovery sell has already given back
  // everything this position cost (see ExitRules.costRecovery).
  const costRecovered = exitRules.costRecovery !== undefined && tokenAmounts.realizedProceedsUsd >= tokenAmounts.costBasisUsd;

  // Short-interval (not every tick, but close to it — see config's
  // positionStrategyReviewIntervalSeconds) AI strategy review. Under a
  // strategy without exitRules.costRecovery (up to v1.8) this is the ONLY
  // mechanism that ever takes profit on a live position — the deterministic
  // exits below are safety-only (stop-loss/catastrophic/invalidation/
  // trailing/time), so a HOLD or a review failure just means no profit gets
  // banked this tick, not that some fallback ladder takes over. With
  // costRecovery (v1.9+), evaluateExits also makes the one cost-recovery sell.
  if (shouldRunStrategyReview(trade)) {
    let aiDecision: PositionStrategyDecision | null = null;
    try {
      aiDecision = await runPositionStrategyReview({
        trade,
        token,
        plan,
        pair,
        remainingTokens,
        totalBoughtTokens: tokenAmounts.totalBoughtTokens,
        currentMultiple,
        unrealizedPnlPercent,
        partialSellsCount,
        tier,
        exitRules,
        costRecovered,
      });
    } catch (err) {
      logger.error({ tradeId: trade.id, err: String(err) }, "strategy review threw unexpectedly — deterministic exits still run this tick");
    }
    if (aiDecision) {
      const acted = await applyAiStrategyDecision(trade, token.address, token.chain, pair, remainingTokens, tokenAmounts.totalBoughtTokens, aiDecision, tier, {
        manualHold,
        currentMultiple,
        runnerProtected: costRecovered && currentMultiple >= 1,
      });
      if (acted) return; // a sell already executed this tick — let the next tick re-evaluate fresh
    }
  }

  const decision = evaluateExits({
    trade,
    plan,
    exitRules,
    currentMcap: pair?.marketCapUsd,
    currentMultiple,
    unrealizedPnlPercent,
    liquidityUsd: pair?.liquidityUsd ?? 0,
    buySellRatio5m,
    totalTxns5m,
    sellQuoteAvailable: await isSellable(token.address, pair, token.chain, remainingTokens),
    remainingTokens,
    totalBoughtTokens: tokenAmounts.totalBoughtTokens,
    manualHold,
    stopPnlPercent,
    stopBreachSeconds: stopBreach.seconds,
    costBasisUsd: tokenAmounts.costBasisUsd,
    realizedProceedsUsd: tokenAmounts.realizedProceedsUsd,
    estimatedSellGasUsd: estimatedSwapGasUsd(token.chain),
  });

  if (!decision) return;
  if (!pair) {
    logger.warn({ tradeId: trade.id }, "exit triggered but no market data to fill against — will retry next tick");
    return;
  }

  // Chart-vision gate — only the soft, retracement-driven trailing exit is
  // eligible. RISK_EXIT/INVALIDATION_EXIT (the hard stop-loss/catastrophic
  // paths) are returned by evaluateExits before the TRAILING_EXIT branch ever
  // runs, so a decision only reaches this check once those have already NOT
  // fired this tick — structurally unreachable by this gate. TIME_EXIT is
  // deliberately left ungated (never delay a hold-time exit waiting on a
  // vision call). PARTIAL_PROFIT/AI_STRATEGY_EXIT never reach evaluateExits
  // at all — they're executed directly from the AI strategy review above,
  // which already looked at this same chart before deciding.
  //
  // Renders the chart from this trade's own PositionSnapshot history (see
  // chartVisionGate.ts's doc comment) rather than screenshotting a
  // third-party page — a DB query + in-process render, not a browser, so the
  // added latency here is the vision call itself (typically low single-digit
  // seconds), not the ~9-11s a live DexScreener screenshot measured at.
  // runPositionMonitorTick's loop over open trades is still sequential by
  // design (see its own doc comment), so this still delays — never skips —
  // other open trades' checks later in the same tick; just a much smaller,
  // bounded delay than the screenshot approach carried.
  if (tradingConfig.chartVisionGateEnabled && decision.type === "TRAILING_EXIT" && !decision.isEmergency) {
    const gate = await evaluateChartVisionGate({
      tradeId: trade.id,
      symbol: token.symbol,
      retracePercent: decision.retracePercent ?? 0,
      peakMultiple: decision.peakMultiple ?? 1,
    }).catch((err) => {
      logger.warn({ tradeId: trade.id, err: String(err) }, "chart vision gate threw unexpectedly — trailing exit proceeds unchanged");
      return { defer: false, reason: "gate threw" } as const;
    });
    if (gate.defer) {
      await db.exitSignal.create({
        data: { tradeId: trade.id, type: "TRAILING_EXIT", severity: "INFO", triggered: false, evidence: { vetoedBy: "chartVisionGate", ...gate } },
      });
      logger.info({ tradeId: trade.id, reason: gate.reason }, "trailing exit deferred by chart vision gate");
      return;
    }
  } else {
    resetChartVisionDeferStreak(trade.id);
  }

  await executeSell(trade, token.address, remainingTokens, decision, pair, token.chain);
}

/**
 * Applies an AI strategy decision that requires action right now. HOLD and
 * SET_REENTRY_TARGET never sell — SET_REENTRY_TARGET only stores a future
 * buy trigger (see applyReentryTarget/checkAndExecutePendingReentry).
 * Returns true only when a sell was actually executed this tick.
 */
async function applyAiStrategyDecision(
  trade: Trade,
  tokenAddress: string,
  tokenChain: string,
  pair: MarketPair | undefined,
  remainingTokens: number,
  totalBoughtTokens: number,
  decision: PositionStrategyDecision,
  tier: ProjectTier,
  hold: { manualHold: boolean; currentMultiple: number; runnerProtected: boolean }
): Promise<boolean> {
  if (decision.action === "SET_REENTRY_TARGET") {
    await applyReentryTarget(trade, decision, tier);
    return false;
  }
  if (decision.action === "HOLD") return false;
  // v1.9+ (ExitRules.costRecovery): once cost is back, what's left is only
  // ever sold by its trailing stop or a loss stop, never while it's in profit.
  if (hold.runnerProtected) {
    logger.info(
      { tradeId: trade.id, action: decision.action, currentMultiple: hold.currentMultiple },
      "AI strategy proposed selling the runner left after cost recovery while it's in profit — its trailing stop decides instead"
    );
    return false;
  }
  // A manual buy-and-hold is held through drawdowns (resolveExitRules): the
  // AI review may bank profit on it, never sell it underwater.
  if (hold.manualHold && hold.currentMultiple < 1) {
    logger.info(
      { tradeId: trade.id, action: decision.action, currentMultiple: hold.currentMultiple },
      "AI strategy proposed selling a manual buy-and-hold position at a loss — holding instead"
    );
    return false;
  }

  if (!pair) {
    logger.warn({ tradeId: trade.id, action: decision.action }, "AI strategy proposed an exit but no market data to fill against — will retry next review");
    return false;
  }

  const exitDecision: ExitDecision =
    decision.action === "EXIT_NOW"
      ? { type: "AI_STRATEGY_EXIT", sellPercentOfRemaining: 100, reason: `AI strategy: ${decision.reasoning}`, isEmergency: false }
      : {
          type: "PARTIAL_PROFIT",
          sellPercentOfRemaining: Math.min(decision.sellPercentOfRemaining ?? 25, 100),
          reason: `AI strategy: ${decision.reasoning}`,
          isEmergency: false,
        };

  const runnerAwareDecision = applyVerifiedRunnerGuard({ trade, decision: exitDecision, remainingTokens, totalBoughtTokens });
  if (!runnerAwareDecision) return false;

  await executeSell(trade, tokenAddress, remainingTokens, runnerAwareDecision, pair, tokenChain);
  return true;
}

/**
 * Substitutes the strategy's fastFlip profile (earlier profit-taking, a
 * closer trailing stop, a short max hold) whenever either condition on
 * ExitRules.fastFlip's doc comment applies — a large entry market cap on a
 * project that isn't (yet) proven strong enough to justify holding for the
 * bigger move, or a comparatively low quality score. Falls through to the
 * base profile unchanged whenever fastFlip isn't configured on the active
 * strategy, or the candidate/its qualityScore can't be found (never blocks
 * monitoring over a missing optional signal).
 *
 * User directive 2026-09-18: tradeLane alone no longer forces the fastFlip
 * profile. MOMENTUM_TACTICAL/NARRATIVE_TACTICAL used to imply "speculative,
 * momentum-only, possibly meme" — that's no longer possible, since every
 * trade reaching this point (any lane) already cleared the utility-only gate
 * (see utilityGate.ts) with no bypass. A trade landing in MOMENTUM_TACTICAL
 * now means only "a genuine utility candidate that didn't clear the highest
 * verified-project score bar," not "a risky momentum play" — it deserves the
 * same patient, long-hold treatment as VERIFIED_PROJECT unless its own
 * qualityScore or entry mcap independently signals caution below.
 *
 * User directive 2026-09-22, raised 2026-09-23: a third tier above that,
 * GOOD_PROJECT — cleared fastFlip's own bar AND has a confirmed real X
 * community (ResearchRun.socialScore, populated identically for utility-
 * and narrative-lane research — see ExitRules.goodProject's doc comment in
 * strategy.ts) — unlocks essentially uncapped patience (vs 24h base/60min
 * fastFlip) before the underwater-only TIME_EXIT would force-close it, and
 * the full DCA/re-entry budget in positionStrategy.ts (this function's tier
 * return value is what that reads).
 */
/**
 * Where the loss stops measure from. A position is marked at its real
 * on-chain sell quote (net of the pool fee and price impact) against a fill
 * price that already paid the buy side, so it reads as a loss of the whole
 * round-trip cost from its very first mark. Confirmed 2026-09-24 across 47
 * price-stopped trades: the median first mark, 3-10s after entry, was
 * -5.5%, and many were -6% to -10%. The 15% max-loss stop was firing on a
 * ~10% market dip. GOMO, FOMOBAG and PONSI were stopped that way and later
 * peaked at 8-9x. So the stops measure from the first mark instead: never
 * above the entry price, and never more than MAX_ROUND_TRIP_COST below it,
 * so a real crash in the first seconds can't be absorbed into the baseline.
 * P&L, MFE and every reported number still use the entry price.
 */
export function stopBaseline(entryPriceUsd: number, firstMarkPriceUsd: number | undefined): number {
  if (!(entryPriceUsd > 0)) return entryPriceUsd;
  if (!(firstMarkPriceUsd !== undefined && firstMarkPriceUsd > 0)) return entryPriceUsd;
  return Math.max(Math.min(entryPriceUsd, firstMarkPriceUsd), entryPriceUsd * (1 - MAX_ROUND_TRIP_COST));
}
const MAX_ROUND_TRIP_COST = 0.12;

/**
 * The stop-confirmation timer (ExitRules.stopConfirm): when the mark first
 * went past the max-loss line (the shallower one, so it also covers the
 * catastrophic line) and how long it has stayed there. A mark back above
 * the line clears it. Pure: live keeps `since` per trade in memory
 * (stopBreachSince), the paper engine per paper position, and a replay per
 * tick — so a restart just re-arms the timer, erring toward holding a
 * little longer.
 */
export function nextStopBreach(input: {
  exitRules: ExitRules;
  stopPnlPercent: number;
  manualHold?: boolean;
  sinceMs: number | undefined;
  nowMs: number;
}): { sinceMs: number | undefined; seconds: number } {
  const { exitRules } = input;
  if (!exitRules.stopConfirm || input.manualHold || input.stopPnlPercent > -exitRules.maxLossPercent) return { sinceMs: undefined, seconds: 0 };
  const sinceMs = input.sinceMs ?? input.nowMs;
  return { sinceMs, seconds: (input.nowMs - sinceMs) / 1000 };
}
const stopBreachSince = new Map<string, number>();
const STOP_BASELINE_WINDOW_MS = 60_000;
const stopBaselineByTrade = new Map<string, number>();

async function stopBaselinePriceUsd(trade: Trade, markPriceUsd: number): Promise<number> {
  const cached = stopBaselineByTrade.get(trade.id);
  if (cached !== undefined) return cached;
  const openedAtMs = trade.openedAt?.getTime() ?? 0;
  let firstMark: number | undefined;
  if (Date.now() - openedAtMs <= STOP_BASELINE_WINDOW_MS) {
    firstMark = markPriceUsd;
  } else {
    // Restarted since entry: use the first mark recorded then, if it was
    // taken within the window; otherwise fall back to the entry price.
    const first = await db.positionSnapshot.findFirst({
      where: { tradeId: trade.id, capturedAt: { lte: new Date(openedAtMs + STOP_BASELINE_WINDOW_MS) } },
      orderBy: { capturedAt: "asc" },
      select: { priceUsd: true },
    });
    firstMark = first?.priceUsd ?? undefined;
  }
  const baseline = stopBaseline(trade.entryPriceUsd ?? 0, firstMark);
  stopBaselineByTrade.set(trade.id, baseline);
  return baseline;
}

async function resolveExitRules(trade: Trade, baseExitRules: ExitRules): Promise<{ exitRules: ExitRules; tier: ProjectTier; manualHold: boolean }> {
  const candidate = trade.candidateId
    ? await db.tradeCandidate.findUnique({
        where: { id: trade.candidateId },
        select: { qualityScore: true, researchRunId: true, qualificationPath: true },
      })
    : null;
  // User directive 2026-09-24, after WageFlow: a token the user submitted
  // by hand to buy and hold is held through drawdowns. It was bought at a
  // $62K mcap, sold 2 minutes later on the -35.6% catastrophic stop at
  // ~$41K during a normal launch wick, then ran to $150K. Only the exits
  // that mean the token itself is broken still fire (evaluateExits).
  const manualHold = candidate?.qualificationPath === "MANUAL_BUY_AND_HOLD";
  const resolved = await resolveTier(trade, baseExitRules, candidate);
  // Manual holds keep their own exit behavior; the v1.9 cost-recovery shape
  // is for the bot's own entries.
  if (manualHold && resolved.exitRules.costRecovery) {
    const { costRecovery: _unused, ...withoutCostRecovery } = resolved.exitRules;
    return { ...resolved, exitRules: withoutCostRecovery, manualHold };
  }
  return { ...resolved, manualHold };
}

/** The FAST_FLIP tier's exit profile: whichever of fastFlip's overrides the
 * strategy sets (v1.9 sets only maxHoldMinutes), over the base profile. */
export function applyFastFlipProfile(baseExitRules: ExitRules): ExitRules {
  const { fastFlip } = baseExitRules;
  if (!fastFlip) return baseExitRules;
  return {
    ...baseExitRules,
    profitSteps: fastFlip.profitSteps ?? baseExitRules.profitSteps,
    trailingActivationMultiple: fastFlip.trailingActivationMultiple ?? baseExitRules.trailingActivationMultiple,
    trailingPercent: fastFlip.trailingPercent ?? baseExitRules.trailingPercent,
    maxHoldMinutes: fastFlip.maxHoldMinutes,
  };
}

async function resolveTier(
  trade: Trade,
  baseExitRules: ExitRules,
  candidate: { qualityScore: number | null; researchRunId: string | null } | null
): Promise<{ exitRules: ExitRules; tier: ProjectTier }> {
  const { fastFlip, goodProject } = baseExitRules;
  const qualityScore = candidate?.qualityScore ?? undefined;

  if (fastFlip) {
    const isLowQuality = qualityScore !== undefined && qualityScore < fastFlip.qualityScoreThreshold;
    const isLargeEntryNotYetProven =
      trade.actualEntryMcap != null &&
      trade.actualEntryMcap > fastFlip.largeMcapUsd &&
      (qualityScore === undefined || qualityScore < fastFlip.veryGoodQualityScoreThreshold);

    if (isLowQuality || isLargeEntryNotYetProven) {
      return { tier: "FAST_FLIP", exitRules: applyFastFlipProfile(baseExitRules) };
    }
  }

  if (goodProject && candidate?.researchRunId) {
    const run = await db.researchRun.findUnique({ where: { id: candidate.researchRunId }, select: { socialScore: true } });
    // Fails closed to BASE on a missing/null score — never assume a strong
    // community without a real signal for it, same principle as the
    // narrative-quality gate's "no verification, no trade."
    if (run?.socialScore != null && run.socialScore >= goodProject.minSocialScoreToQualify) {
      return { tier: "GOOD_PROJECT", exitRules: { ...baseExitRules, maxHoldMinutes: goodProject.maxHoldMinutes } };
    }
  }

  return { tier: "BASE", exitRules: baseExitRules };
}

/**
 * Aggregates every BUY (the original entry plus any re-entries executed by
 * checkAndExecutePendingReentry) minus every SELL, rather than trusting the
 * scalar entryTokenAmount alone — that field only ever reflects the original
 * fill, so it silently under-counts a position once a re-entry buy adds to it.
 */
async function getPositionTokenAmounts(
  trade: Trade
): Promise<{ totalBoughtTokens: number; remainingTokens: number; costBasisUsd: number; realizedProceedsUsd: number }> {
  const [buys, sells] = await Promise.all([
    db.tradeExecution.aggregate({ where: { tradeId: trade.id, type: "BUY" }, _sum: { tokenAmount: true, usdValue: true, gasCostUsd: true } }),
    db.tradeExecution.aggregate({ where: { tradeId: trade.id, type: "SELL" }, _sum: { tokenAmount: true, usdValue: true, gasCostUsd: true } }),
  ]);
  const totalBought = buys._sum.tokenAmount ?? trade.entryTokenAmount ?? 0;
  return {
    totalBoughtTokens: totalBought,
    remainingTokens: totalBought - (sells._sum.tokenAmount ?? 0),
    // Everything spent getting in, and everything sells have returned so
    // far, both net of gas — what ExitRules.costRecovery measures.
    costBasisUsd: (buys._sum.usdValue ?? trade.positionSizeUsd) + (buys._sum.gasCostUsd ?? 0),
    realizedProceedsUsd: (sells._sum.usdValue ?? 0) - (sells._sum.gasCostUsd ?? 0),
  };
}

/**
 * The v1.9 cost-recovery sell (ExitRules.costRecovery): the percent of the
 * remaining position that returns everything the position still owes —
 * what it cost less what sells have already returned — plus this sell's own
 * gas, with bufferPercent on top for the fill coming in under the mark.
 * The mark is a sell quote for the whole remaining size, so a smaller sale
 * usually fills a little better. At 2x with nothing sold yet this is ~53%.
 */
export function costRecoverySellPercent(input: {
  costBasisUsd: number;
  realizedProceedsUsd: number;
  remainingValueUsd: number;
  estimatedSellGasUsd: number;
  bufferPercent: number;
}): number {
  const outstandingUsd = input.costBasisUsd - input.realizedProceedsUsd;
  if (outstandingUsd <= 0) return 0;
  if (!(input.remainingValueUsd > 0)) return 100;
  const neededUsd = (outstandingUsd + input.estimatedSellGasUsd) * (1 + input.bufferPercent / 100);
  return Math.min(100, (neededUsd / input.remainingValueUsd) * 100);
}

export function evaluateExits(ctx: {
  trade: Trade;
  plan: { invalidationMcap: number | null } | null;
  exitRules: ExitRules;
  currentMcap: number | undefined;
  currentMultiple: number;
  unrealizedPnlPercent: number;
  liquidityUsd: number;
  buySellRatio5m: number | undefined;
  totalTxns5m: number | undefined;
  sellQuoteAvailable: boolean;
  remainingTokens: number;
  totalBoughtTokens: number;
  // Manual buy-and-hold (resolveExitRules): no price-driven exit may sell
  // it at a loss — only an unsellable token or pulled liquidity, plus the
  // trailing stop, which only arms once the position is well in profit.
  manualHold?: boolean;
  // The loss the stops judge: the move since the first mark after entry
  // (stopBaselinePriceUsd), which leaves out our own round-trip cost.
  // Falls back to unrealizedPnlPercent.
  stopPnlPercent?: number;
  // Read only under exitRules.costRecovery: what the position has cost
  // (buys plus their gas) and what sells have returned (net of their gas),
  // and the estimated gas of one more sell. Without them the cost is
  // trade.positionSizeUsd, and cost counts as recovered once any of the
  // position has been sold — right for a replay whose only partial sell is
  // the cost-recovery one.
  costBasisUsd?: number;
  realizedProceedsUsd?: number;
  estimatedSellGasUsd?: number;
  // Read only under exitRules.stopConfirm: how long the mark has stayed past
  // the max-loss line (nextStopBreach); 0 or undefined when it isn't now.
  stopBreachSeconds?: number;
}): ExitDecision | null {
  const { trade, plan, exitRules } = ctx;
  // Stops that wait for confirmation (ExitRules.stopConfirm) are taken out
  // of validatePosition here and checked below, after invalidation.
  const stopConfirm = ctx.manualHold ? undefined : exitRules.stopConfirm;

  // Priority 1: emergency/risk exit (§75).
  const positionRisk = validatePosition({
    liquidityUsd: ctx.liquidityUsd,
    liquidityAtEntryUsd: trade.entryLiquidityUsd ?? ctx.liquidityUsd, // falls back to current (no-op check) only for trades opened before entryLiquidityUsd existed
    unrealizedPnlPercent: ctx.stopPnlPercent ?? ctx.unrealizedPnlPercent,
    maxLossPercent: stopConfirm ? Number.POSITIVE_INFINITY : exitRules.maxLossPercent,
    catastrophicLossPercent: stopConfirm?.appliesTo === "both" ? Number.POSITIVE_INFINITY : exitRules.catastrophicLossPercent,
    buySellRatio5m: ctx.buySellRatio5m,
    totalTxns5m: ctx.totalTxns5m,
    sellQuoteAvailable: ctx.sellQuoteAvailable,
    holdThroughDrawdowns: ctx.manualHold,
  });
  if (positionRisk.riskExitTriggered && positionRisk.severity === "CRITICAL") {
    return { type: "RISK_EXIT", sellPercentOfRemaining: 100, reason: positionRisk.reasons.join("; "), isEmergency: true };
  }

  const tradeLane = normalizeTradeLane(trade.tradeLane);
  const holdingMinutes = trade.openedAt ? (Date.now() - trade.openedAt.getTime()) / 60_000 : 0;
  if (!ctx.manualHold && tradeLane === "NARRATIVE_TACTICAL" && holdingMinutes >= tradingConfig.narrativeVolumeExitAfterMinutes) {
    if ((ctx.totalTxns5m ?? 0) < tradingConfig.narrativeMinTxns5mToHold) {
      return {
        type: "RISK_EXIT",
        sellPercentOfRemaining: 100,
        reason: `narrative volume faded: ${ctx.totalTxns5m ?? 0} txns/5m < ${tradingConfig.narrativeMinTxns5mToHold} after ${Math.round(holdingMinutes)}m`,
        isEmergency: false,
      };
    }
    if (ctx.buySellRatio5m !== undefined && ctx.buySellRatio5m < tradingConfig.narrativeMinBuyRatio5mToHold) {
      return {
        type: "RISK_EXIT",
        sellPercentOfRemaining: 100,
        reason: `narrative buy pressure faded: buy ratio ${(ctx.buySellRatio5m * 100).toFixed(0)}% < ${Math.round(tradingConfig.narrativeMinBuyRatio5mToHold * 100)}%`,
        isEmergency: false,
      };
    }
  }

  // Priority 2: technical invalidation. Tolerance-adjusted, not the AI's
  // stated level directly — see tradingConfig.invalidationTolerancePercent
  // (a normal post-launch wick isn't the same thing as the setup actually
  // breaking; this exit was firing on exactly that kind of dip before).
  const invalidationFloor = plan?.invalidationMcap ? plan.invalidationMcap * (1 - tradingConfig.invalidationTolerancePercent / 100) : undefined;
  // Desk review D3, confirmed live 2026-09-11: this and the WARNING-severity
  // RISK_EXIT below both realize a LOSS the moment they fire — same as the
  // CRITICAL RISK_EXIT above, which was already isEmergency: true — but both
  // used to queue behind defaultMaxSellSlippageBps (500bps) like a routine
  // profit-taking sell, and only escalated to emergency after
  // stuckExitEscalateAfterMinutes (5 min) of being blocked. THREE, PONSIBLE
  // and FFSTR all slipped 4-9 points past their stated stop this way. A stop
  // is not a discretionary trim; it should never wait in that queue at all —
  // TRAILING_EXIT/PARTIAL_PROFIT/AI_STRATEGY_EXIT stay non-emergency since
  // those are genuinely discretionary.
  if (!ctx.manualHold && invalidationFloor !== undefined && ctx.currentMcap !== undefined && ctx.currentMcap <= invalidationFloor) {
    return {
      type: "INVALIDATION_EXIT",
      sellPercentOfRemaining: 100,
      reason: `market cap fell to tolerance-adjusted invalidation floor ($${Math.round(invalidationFloor).toLocaleString()}, AI level was $${Math.round(plan!.invalidationMcap!).toLocaleString()})`,
      isEmergency: true,
    };
  }
  if (positionRisk.riskExitTriggered) {
    return { type: "RISK_EXIT", sellPercentOfRemaining: 100, reason: positionRisk.reasons.join("; "), isEmergency: true };
  }
  if (stopConfirm) {
    const lossPercent = ctx.stopPnlPercent ?? ctx.unrealizedPnlPercent;
    const heldSeconds = ctx.stopBreachSeconds ?? 0;
    if (lossPercent <= -exitRules.maxLossPercent && heldSeconds >= stopConfirm.seconds) {
      const line = lossPercent <= -exitRules.catastrophicLossPercent && stopConfirm.appliesTo === "both" ? "catastrophic" : "max-loss";
      return {
        type: "RISK_EXIT",
        sellPercentOfRemaining: 100,
        reason: `loss ${lossPercent.toFixed(1)}% stayed past the ${line} stop for ${Math.round(heldSeconds)}s (confirmation ${stopConfirm.seconds}s)`,
        isEmergency: true,
      };
    }
  }

  // v1.9+ (exitRules.costRecovery): the one deterministic profit-take. At
  // triggerMultiple, sell just enough to get back what the position cost;
  // from then on the rest is a runner under its own wide trail below.
  const costRecovery = ctx.manualHold ? undefined : exitRules.costRecovery;
  const costBasisUsd = ctx.costBasisUsd ?? trade.positionSizeUsd;
  const costRecovered =
    costRecovery !== undefined &&
    (ctx.realizedProceedsUsd !== undefined
      ? ctx.realizedProceedsUsd >= costBasisUsd
      : ctx.remainingTokens < ctx.totalBoughtTokens * (1 - 1e-9));
  if (costRecovery && !costRecovered && ctx.currentMultiple >= costRecovery.triggerMultiple) {
    const entryPriceUsd = trade.entryPriceUsd ?? (ctx.totalBoughtTokens > 0 ? trade.positionSizeUsd / ctx.totalBoughtTokens : 0);
    const realizedProceedsUsd = ctx.realizedProceedsUsd ?? 0;
    const sellPercent = costRecoverySellPercent({
      costBasisUsd,
      realizedProceedsUsd,
      remainingValueUsd: ctx.remainingTokens * entryPriceUsd * ctx.currentMultiple,
      estimatedSellGasUsd: ctx.estimatedSellGasUsd ?? 0,
      bufferPercent: costRecovery.sellCostBufferPercent,
    });
    return applyVerifiedRunnerGuard({
      trade,
      remainingTokens: ctx.remainingTokens,
      totalBoughtTokens: ctx.totalBoughtTokens,
      decision: {
        type: "PARTIAL_PROFIT",
        sellPercentOfRemaining: sellPercent,
        reason: `reached ${ctx.currentMultiple.toFixed(2)}x: selling ${sellPercent.toFixed(0)}% to get back the $${(costBasisUsd - realizedProceedsUsd).toFixed(2)} this position cost; the rest rides with a ${costRecovery.moonbagTrailingPercent}% trail from its peak`,
        isEmergency: false,
      },
    });
  }

  // Priority 3: trailing exit — loss/gain protection only, never a profit
  // target. User directive 2026-09-22 removed the old staged fixed-multiple
  // profit-taking ladder that used to sit here (PROFIT_TARGET) — deciding
  // if/when/how much profit to take is now exclusively the AI strategy
  // review's call (see positionStrategy.ts, dispatched earlier in
  // monitorOneTrade with its own chart read). This trailing stop still runs
  // unconditionally as a backstop: armed once the position's PEAK (never the
  // current tick's multiple) has ever crossed trailingActivationMultiple, and
  // stays armed from then on. Desk review D5, confirmed live 2026-09-11:
  // QUORUM peaked at 2.93x, then gapped straight to ~1.1x between two 5s
  // monitor ticks (a real move, not a missed tick — see the desk review's D4
  // on monitor cadence) — the old `ctx.currentMultiple >= activation` gate
  // only looked at THIS tick's reading, so a position already well past
  // activation but currently reading below it skipped the trail entirely and
  // rode the same collapse down to a -36% catastrophic stop instead of
  // banking anything from its 2.93x peak. trade.mfePercent already records
  // the true best-ever multiple regardless of what currentMultiple reads now.
  //
  // Once a cost-recovery sell has given back the position's cost, what's
  // left trails from the peak at costRecovery.moonbagTrailingPercent instead,
  // armed from that moment on.
  const peakMultiple = 1 + (trade.mfePercent ?? 0) / 100;
  const runnerTrail = costRecovered ? costRecovery : undefined;
  const trailingActivationMultiple = runnerTrail ? 0 : exitRules.trailingActivationMultiple;
  const trailingPercent = runnerTrail ? runnerTrail.moonbagTrailingPercent : exitRules.trailingPercent;
  if (peakMultiple >= trailingActivationMultiple) {
    const retracePercent = ((peakMultiple - ctx.currentMultiple) / peakMultiple) * 100;
    if (retracePercent >= trailingPercent) {
      return applyVerifiedRunnerGuard({
        trade,
        remainingTokens: ctx.remainingTokens,
        totalBoughtTokens: ctx.totalBoughtTokens,
        decision: {
          type: "TRAILING_EXIT",
          sellPercentOfRemaining: 100,
          reason: `${runnerTrail ? "runner " : ""}retraced ${retracePercent.toFixed(1)}% from peak ${peakMultiple.toFixed(2)}x (trail ${trailingPercent}%)`,
          isEmergency: false,
          peakMultiple,
          retracePercent,
        },
      });
    }
  }

  // Priority 4: max hold time — checked last, after the trailing exit, and
  // routed through the same verified-runner guard it uses. Otherwise a
  // VERIFIED_PROJECT position with an armed trailing stop would get fully
  // liquidated the instant it hits maxHoldMinutes instead of retaining
  // moonbagRetainPercent like every other discretionary exit does for that
  // lane.
  //
  // User directive 2026-09-18: utility-token theses are long holds by design
  // — a genuine winner must never get force-closed just because a clock ran
  // out while the trailing exit (priority 3 above) or the AI strategy review
  // haven't acted. This is now a stagnant-loser cutoff, not a universal timer:
  // it only ever fires while the position is currently underwater (currentMultiple < 1),
  // freeing up capital tied up in a thesis that hasn't played out rather than
  // capping the upside of one that's working.
  if (!ctx.manualHold && holdingMinutes >= exitRules.maxHoldMinutes && ctx.currentMultiple < 1) {
    return applyVerifiedRunnerGuard({
      trade,
      remainingTokens: ctx.remainingTokens,
      totalBoughtTokens: ctx.totalBoughtTokens,
      decision: {
        type: "TIME_EXIT",
        sellPercentOfRemaining: 100,
        reason: `max hold reached while underwater (${ctx.currentMultiple.toFixed(2)}x): ${Math.round(holdingMinutes)}m >= ${exitRules.maxHoldMinutes}m`,
        isEmergency: false,
      },
    });
  }

  return null;
}

async function reconcileExternalWalletExit(trade: Trade, tokenAddress: string, chain: string, remainingTokens: number): Promise<boolean> {
  let walletTokens: number | undefined;
  try {
    walletTokens = await getLiveWalletTokenBalance(tokenAddress, chain);
  } catch (err) {
    logger.warn({ tradeId: trade.id, tokenAddress, err: String(err) }, "could not reconcile live wallet token balance — continuing with normal position monitoring");
    return false;
  }
  if (walletTokens === undefined) return false;

  const negligibleDust = Math.max(remainingTokens * 0.000001, 1e-12);
  if (walletTokens > negligibleDust) {
    zeroWalletBalanceFirstSeenAt.delete(trade.id);
    return false;
  }

  const firstSeenAt = zeroWalletBalanceFirstSeenAt.get(trade.id);
  if (firstSeenAt === undefined) {
    zeroWalletBalanceFirstSeenAt.set(trade.id, Date.now());
    logger.warn(
      { tradeId: trade.id, tokenAddress, dbRemainingTokens: remainingTokens, walletTokens },
      "live wallet balance read as zero for an open position — awaiting a second confirming read before treating it as an external exit"
    );
    return false;
  }
  // A single lagging RPC node can read 0 right after a fresh buy; require the
  // zero reading to hold across at least one full monitor interval, from an
  // independently-fetched balance, before trusting it.
  if (Date.now() - firstSeenAt < tradingConfig.positionMonitorIntervalSeconds * 1000) return false;

  logger.error(
    { tradeId: trade.id, tokenAddress, dbRemainingTokens: remainingTokens, walletTokens },
    "open trade has no tokens left in the live wallet on two confirming reads — closing as an external/manual wallet exit with unknown proceeds"
  );
  zeroWalletBalanceFirstSeenAt.delete(trade.id);
  await closeTrade(trade, "external/manual wallet exit detected: bot wallet token balance is zero", { realizedPnlUnknown: true });
  recordSellSuccess(tokenAddress);
  clearExitBlocked(trade.id);
  return true;
}

function applyVerifiedRunnerGuard(input: {
  trade: Trade;
  decision: ExitDecision;
  remainingTokens: number;
  totalBoughtTokens: number;
}): ExitDecision | null {
  const { trade, decision, remainingTokens, totalBoughtTokens } = input;
  if (decision.isEmergency || normalizeTradeLane(trade.tradeLane) !== "VERIFIED_PROJECT") return decision;
  if (remainingTokens <= 0 || totalBoughtTokens <= 0 || tradingConfig.moonbagRetainPercent <= 0) return decision;

  const targetRunnerTokens = totalBoughtTokens * (tradingConfig.moonbagRetainPercent / 100);
  const requestedSellTokens = remainingTokens * (decision.sellPercentOfRemaining / 100);
  const remainingAfterRequestedSell = remainingTokens - requestedSellTokens;
  if (remainingAfterRequestedSell >= targetRunnerTokens) return decision;

  const maxSellTokens = Math.max(0, remainingTokens - targetRunnerTokens);
  if (maxSellTokens <= 1e-12) return null;

  const adjustedSellPercent = (maxSellTokens / remainingTokens) * 100;
  return {
    ...decision,
    sellPercentOfRemaining: adjustedSellPercent,
    reason: `${decision.reason}; adjusted to retain ${tradingConfig.moonbagRetainPercent}% verified-project runner`,
  };
}

async function executeSell(
  trade: Trade,
  tokenAddress: string,
  remainingTokens: number,
  decision: ExitDecision,
  pair: MarketPair,
  chain: string
): Promise<void> {
  const sellTokens = remainingTokens * (decision.sellPercentOfRemaining / 100);
  const isFullExit = decision.sellPercentOfRemaining >= 100 || sellTokens >= remainingTokens - 1e-9;

  // A pre-trade estimate only, to gate on slippage before ever executing —
  // mirrors the same estimate-then-execute split used for buys (§17).
  const preEstimate = await getSellEstimate(tokenAddress, sellTokens, pair, chain);
  const stuckForMinutes = blockedExitAgeMinutes(trade.id);
  const escalate =
    tradingConfig.stuckExitEscalateAfterMinutes > 0 && stuckForMinutes >= tradingConfig.stuckExitEscalateAfterMinutes;
  const exitCheck = validateExit({
    isEmergency: decision.isEmergency || escalate,
    estimatedSlippageBps: preEstimate.estimatedSlippageBps,
  });
  if (!exitCheck.approved) {
    markExitBlocked(trade.id);
    logger.warn(
      { tradeId: trade.id, reasons: exitCheck.reasons, blockedForMinutes: Math.round(stuckForMinutes) },
      "exit rejected by slippage guard — will retry next tick"
    );
    recordSellFailure({
      tokenAddress,
      tokenLabel: pair.baseTokenSymbol ?? pair.baseTokenName ?? tokenAddress.slice(0, 10),
      error: exitCheck.reasons.join("; "),
      positionValueUsd: remainingTokens * (pair.priceUsd ?? 0),
      unrealizedPnlPercent: trade.entryPriceUsd ? ((pair.priceUsd ?? 0) / trade.entryPriceUsd - 1) * 100 : undefined,
    });
    return;
  }
  if (escalate && !decision.isEmergency) {
    logger.warn(
      { tradeId: trade.id, blockedForMinutes: Math.round(stuckForMinutes), estimatedSlippageBps: preEstimate.estimatedSlippageBps },
      "exit has been blocked by the slippage guard too long — escalating to an emergency exit rather than leaving the position unsellable"
    );
  }
  clearExitBlocked(trade.id);

  let fill: FillResult;
  try {
    fill = await executeSellFill(tokenAddress, sellTokens, pair, chain, { fullExit: isFullExit });
  } catch (err) {
    logger.error({ tradeId: trade.id, err: String(err) }, "sell execution failed — will retry next tick");
    void recordExecutionQuality({
      tokenAddress,
      pair,
      direction: "SELL",
      success: false,
      error: String(err),
    });
    recordSellFailure({
      tokenAddress,
      tokenLabel: pair.baseTokenSymbol ?? pair.baseTokenName ?? tokenAddress.slice(0, 10),
      error: String(err),
      positionValueUsd: remainingTokens * (pair.priceUsd ?? 0),
      unrealizedPnlPercent: trade.entryPriceUsd ? ((pair.priceUsd ?? 0) / trade.entryPriceUsd - 1) * 100 : undefined,
    });
    // User directive 2026-09-13 (SL/"Stonks Launch"): openTrade's post-buy
    // probe now catches most honeypots the instant a buy confirms, but a
    // token can also get blacklisted/rug-pulled AFTER a genuinely sellable
    // entry — that has no probe to catch it, only this same retry loop.
    // Past sellGiveUpAfterMinutes of continuous failure, stop paying RPC
    // calls to retry a sell that's had an hour to work and hasn't — write it
    // off the same way the instant-probe case does, so it can't hold a
    // position slot indefinitely.
    if (tradingConfig.sellGiveUpAfterMinutes > 0 && getSellFailureMinutes(tokenAddress) >= tradingConfig.sellGiveUpAfterMinutes) {
      await closeTrade(trade, `given up after failing to sell continuously for over ${tradingConfig.sellGiveUpAfterMinutes} minutes (last error: ${String(err)})`);
      recordSellSuccess(tokenAddress); // clears the failure streak — nothing left retrying this token
    }
    return;
  }
  recordSellSuccess(tokenAddress);

  // fill.tokenAmount is what the fill ACTUALLY sold, which can be slightly
  // less than the sellTokens we asked for — executeSellFill clamps the
  // request to the wallet's real on-chain balance (see the float-precision
  // note there). Every number below has to come from the real amount, or
  // the leftover drift compounds into the next sell's remaining-position
  // math.
  const soldTokens = fill.tokenAmount;
  const proceedsUsd = soldTokens * fill.priceUsd;
  const buyTotals = await db.tradeExecution.aggregate({
    where: { tradeId: trade.id, type: "BUY" },
    _sum: { tokenAmount: true, usdValue: true, gasCostUsd: true },
  });
  const totalBoughtTokens = buyTotals._sum.tokenAmount ?? trade.entryTokenAmount ?? soldTokens;
  const totalBuyUsd = buyTotals._sum.usdValue ?? trade.positionSizeUsd;
  const realizedPnlThisSell = sellRealizedPnlUsd({
    proceedsUsd,
    soldTokens,
    totalBoughtTokens,
    totalBuyUsd,
    totalBuyGasUsd: buyTotals._sum.gasCostUsd ?? 0,
    sellGasUsd: fill.gasCostUsd,
  });

  const sellExecution = await db.tradeExecution.create({
    data: {
      tradeId: trade.id,
      type: "SELL",
      status: "CONFIRMED",
      txHash: fill.txHash,
      tokenAmount: soldTokens,
      usdValue: proceedsUsd,
      actualPrice: fill.priceUsd,
      slippagePercent: fill.estimatedSlippageBps / 100,
      priceImpactPercent: fill.estimatedPriceImpactPercent,
      gasCostUsd: fill.gasCostUsd,
      provider: fill.provider,
      rawReceipt: fill.receipt ? { ...fill.receipt } : undefined,
      submittedAt: new Date(),
      confirmedAt: new Date(),
    },
  });
  await db.exitSignal.create({
    data: { tradeId: trade.id, type: decision.type, severity: decision.isEmergency ? "CRITICAL" : "INFO", triggered: true, evidence: { reason: decision.reason, sellPercent: decision.sellPercentOfRemaining } },
  });
  await recordLedgerEntry({ type: LedgerEntryType.SELL, tradeId: trade.id, amountUsd: proceedsUsd, notes: `${fill.provider} sell — ${decision.reason}${fill.txHash ? ` (${fill.txHash})` : ""}` });
  await recordLedgerEntry({ type: LedgerEntryType.GAS, tradeId: trade.id, amountUsd: -fill.gasCostUsd, notes: gasLedgerNote(fill) });

  // Confirmed live 2026-09-11: this was previously only recorded on a full
  // exit — a trade closed via several partial sells never had ANY of its
  // realized PnL land in the ledger until (if ever) the final closing sell
  // happened to be a full exit itself. That meant checkCircuitBreakers'
  // daily-realized-loss sum (which reads exactly this ledger type) could
  // silently miss real losses taken via partial exits, and profitLockbox
  // below had nothing to skim from on a partial. Record it on every sell,
  // full or partial, using that sell's own realized PnL.
  await recordLedgerEntry({ type: LedgerEntryType.REALIZED_PNL, tradeId: trade.id, amountUsd: realizedPnlThisSell, notes: decision.reason });

  // Profit lockbox (user directive 2026-09-11): only a gain gets skimmed,
  // never a loss — this is strictly a "bank some of what we made," not a
  // loss-recovery mechanism. See CASH_MOVEMENT_TYPES in portfolio.ts for how
  // this actually removes the skimmed amount from what sizing can redeploy.
  if (realizedPnlThisSell > 0 && tradingConfig.profitLockboxPercent > 0) {
    const lockboxAmount = realizedPnlThisSell * (tradingConfig.profitLockboxPercent / 100);
    await recordLedgerEntry({
      type: LedgerEntryType.PROFIT_RESERVE,
      tradeId: trade.id,
      amountUsd: -lockboxAmount,
      notes: `locked ${tradingConfig.profitLockboxPercent}% of this sell's $${realizedPnlThisSell.toFixed(2)} realized gain`,
    });
  }

  if (isFullExit) {
    // Solana: reclaim the emptied token account's rent. Only after the sell
    // is on record, so a crash or a stuck close can't lose the sell itself;
    // booked onto that sell the way approvalGas.ts books approval gas onto a
    // buy, so closeTrade's P&L below includes it.
    const accountClose = fill.provider === "live" ? await closeTokenAccountAfterFullExit(tokenAddress, pair, chain) : undefined;
    if (accountClose) {
      await db.tradeExecution.update({
        where: { id: sellExecution.id },
        data: { gasCostUsd: { increment: accountClose.gasCostUsd }, rawReceipt: { ...fill.receipt, ...accountClose.receipt } },
      });
      if (accountClose.gasCostUsd !== 0) {
        await recordLedgerEntry({ type: LedgerEntryType.GAS, tradeId: trade.id, amountUsd: -accountClose.gasCostUsd, notes: gasLedgerNote({ provider: "live", receipt: accountClose.receipt }) });
      }
    }
    await closeTrade(trade, decision.reason);
  } else {
    await db.trade.update({ where: { id: trade.id }, data: { status: TradeStatus.PARTIALLY_EXITED } });
    // Fire-and-forget, not awaited — see the matching note in
    // entryMonitor.ts's openTrade: a slow SMTP send must never be able to
    // hold up the position-monitor tick.
    void sendPartialProfitEmail({ tradeId: trade.id, tokenId: trade.tokenId, multiple: 1 + (trade.mfePercent ?? 0) / 100, sellPercent: decision.sellPercentOfRemaining, mode: trade.mode }).catch(
      (err) => logger.error({ tradeId: trade.id, err: String(err) }, "failed to send partial profit email")
    );
    await checkPortfolioMilestones().catch((err) => logger.error({ err: String(err) }, "milestone check failed after partial exit"));
    logger.info({ tradeId: trade.id, decision: decision.type, sellTokens, provider: fill.provider }, "partial exit executed");
  }
}

async function closeTrade(trade: Trade, exitReason: string, options: { realizedPnlUnknown?: boolean } = {}): Promise<void> {
  const executions = await db.tradeExecution.findMany({ where: { tradeId: trade.id } });
  const totalBuyUsd = executions.filter((e) => e.type === "BUY").reduce((s, e) => s + (e.usdValue ?? 0), 0);
  const totalSellUsd = executions.filter((e) => e.type === "SELL").reduce((s, e) => s + (e.usdValue ?? 0), 0);
  const totalGasUsd = executions.reduce((s, e) => s + (e.gasCostUsd ?? 0), 0);
  const pnl = tradeRealizedPnl({ totalBuyUsd, totalSellUsd, totalGasUsd });
  const realizedPnlUsd = options.realizedPnlUnknown ? null : pnl.realizedPnlUsd;
  const realizedMultiple = options.realizedPnlUnknown ? null : pnl.realizedMultiple;

  // Confirmed live 2026-09-17 (QUORUM +49% net, CLIP +105% net): exitReason
  // only ever describes what triggered the LAST sell. When staged
  // profit-taking has already banked real gains, that last sell is often just
  // a small leftover moonbag catching a catastrophic-loss safety exit — the
  // label reads as a big loss while the trade closed net profitable. Only
  // possible when more than one sell happened (a single-sell trade can't post
  // a loss-sounding trigger and still close net positive).
  const sellCount = executions.filter((e) => e.type === "SELL").length;
  const closedNetProfitable = realizedMultiple !== null && realizedMultiple !== undefined && realizedMultiple >= 1;
  const reasonReadsAsLoss = /loss|catastrophic/i.test(exitReason);
  const finalExitReason =
    closedNetProfitable && reasonReadsAsLoss && sellCount > 1
      ? `${exitReason} on remaining position (overall trade still closed +${((realizedMultiple! - 1) * 100).toFixed(0)}% — earlier profit-taking banked the gain first)`
      : exitReason;

  const updated = await db.trade.update({
    where: { id: trade.id },
    data: { status: TradeStatus.CLOSED, closedAt: new Date(), realizedPnlUsd, realizedMultiple, exitReason: finalExitReason },
  });

  if (options.realizedPnlUnknown) {
    await recordLedgerEntry({
      type: LedgerEntryType.MANUAL_ADJUSTMENT,
      tradeId: trade.id,
      amountUsd: 0,
      notes: "external/manual wallet exit detected; proceeds and realized PnL were not observed by the bot",
    });
  } else if (realizedPnlUsd !== null) {
    // The dashboard's combined total sums REALIZED_PNL ledger rows while its
    // per-chain cards sum Trade.realizedPnlUsd (portfolio.ts). Confirmed
    // 2026-09-24 that the two had drifted ~$16 apart. Close out any gap here,
    // so a pre-approval's gas confirming after the last sell, or rounding
    // across partial sells, can never split them again.
    const booked = await db.ledgerEntry.aggregate({ where: { tradeId: trade.id, type: LedgerEntryType.REALIZED_PNL }, _sum: { amountUsd: true } });
    const drift = realizedPnlUsd - (booked._sum.amountUsd ?? 0);
    if (Math.abs(drift) > 1e-9) {
      await recordLedgerEntry({ type: LedgerEntryType.REALIZED_PNL, tradeId: trade.id, amountUsd: drift, notes: "close-out: ledger brought in line with the trade's realized P&L" });
    }
  }

  logger.info({ tradeId: trade.id, realizedPnlUsd, realizedMultiple, exitReason: finalExitReason }, "trade closed");

  // Fire-and-forget, not awaited — see the matching note in
  // entryMonitor.ts's openTrade: a slow SMTP send must never be able to hold
  // up the position-monitor tick.
  const token = await db.token.findUnique({ where: { id: trade.tokenId } });
  void sendTradeClosedEmail({ token, trade: updated }).catch((err) => logger.error({ tradeId: trade.id, err: String(err) }, "failed to send closed-trade email"));
  await generatePostmortem(updated.id).catch((err) => logger.error({ tradeId: trade.id, err: String(err) }, "postmortem generation failed"));
  await checkPortfolioMilestones().catch((err) => logger.error({ err: String(err) }, "milestone check failed"));
}

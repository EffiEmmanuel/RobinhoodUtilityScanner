import { db } from "../db";
import { logger } from "../logger";
import { TradeStatus, LedgerEntryType } from "../generated/prisma";
import type { Trade } from "../generated/prisma";
import type { MarketPair } from "../dex/types";
import { pollCandidateMarket, computeTechnicalFeatures } from "./marketAnalysis";
import { validatePosition, validateExit } from "./riskEngine";
import { executeSellFill, getSellEstimate, isSellable, type FillResult } from "./executionFacade";
import { recordLedgerEntry, recordPortfolioSnapshot } from "./portfolio";
import { getActiveStrategyVersion, type ExitRules } from "./strategy";
import { sendPartialProfitEmail, sendTradeClosedEmail } from "./notifications";
import { generatePostmortem } from "./postmortem";
import { checkPortfolioMilestones } from "./milestones";
import { tradingConfig } from "./config";
import { shouldRunStrategyReview, runPositionStrategyReview, applyReentryTarget, checkAndExecutePendingReentry } from "./positionStrategy";
import type { PositionStrategyDecision } from "../ai/schemas";

// When an exit first started being refused by the slippage guard, per trade —
// drives tradingConfig.stuckExitEscalateAfterMinutes. In memory on purpose:
// the only thing lost on a restart is the elapsed clock, which restarts
// rather than escalating something prematurely, and a position that's
// genuinely unsellable will re-accumulate the time within minutes anyway.
const exitBlockedSince = new Map<string, number>();

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
  type: "RISK_EXIT" | "INVALIDATION_EXIT" | "PARTIAL_PROFIT" | "PROFIT_TARGET" | "TRAILING_EXIT" | "TIME_EXIT" | "AI_STRATEGY_EXIT";
  sellPercentOfRemaining: number; // 100 = full exit
  reason: string;
  isEmergency: boolean;
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
  const exitRules = await resolveExitRules(trade, strategy.exitRules as unknown as ExitRules);

  const market = await pollCandidateMarket(trade.tokenId, token.chain, token.address);
  const pair = market.primaryPair;

  // Same fix as entryMonitor.ts: an open position is checked every tick here,
  // but Token.lastSeenAt otherwise only reflects the base discovery poll's
  // cadence — misleading on the dashboard for a token we're actively holding.
  await db.token.update({ where: { id: trade.tokenId }, data: { lastSeenAt: new Date() } }).catch(() => {});

  // Deterministic, cheap, runs every tick regardless of the AI review cadence
  // below: executes a previously AI-proposed re-entry buy only if (and once)
  // price has actually fallen to that target — the AI never buys directly.
  await checkAndExecutePendingReentry(trade, token, pair).catch((err) =>
    logger.error({ tradeId: trade.id, err: String(err) }, "pending re-entry check failed — will retry next tick")
  );

  const remainingTokens = await getRemainingTokenAmount(trade);
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

  const priceUsd = pair?.priceUsd ?? trade.entryPriceUsd ?? 0;
  const entryPriceUsd = trade.entryPriceUsd ?? 0;
  const currentMultiple = entryPriceUsd > 0 ? priceUsd / entryPriceUsd : 1;
  const unrealizedPnlPercent = (currentMultiple - 1) * 100;
  const unrealizedPnlUsd = remainingTokens * priceUsd - remainingTokens * entryPriceUsd;

  const newMfe = Math.max(trade.mfePercent ?? unrealizedPnlPercent, unrealizedPnlPercent);
  const newMae = Math.min(trade.maePercent ?? unrealizedPnlPercent, unrealizedPnlPercent);
  await db.trade.update({ where: { id: trade.id }, data: { mfePercent: newMfe, maePercent: newMae } });

  const buySellRatio5m =
    pair?.buys5m !== undefined || pair?.sells5m !== undefined
      ? (pair.buys5m ?? 0) / Math.max((pair.buys5m ?? 0) + (pair.sells5m ?? 0), 1)
      : undefined;

  // Continuous, free, deterministic technical read — computed every tick
  // regardless of whether an AI strategy review runs this cycle, so the
  // stored PositionSnapshot history is always complete for later analysis.
  const technical = await computeTechnicalFeatures(trade.tokenId, pair);

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

  const profitStepsTaken = await db.exitSignal.count({ where: { tradeId: trade.id, type: "PROFIT_TARGET" } });

  // Periodic AI strategy review (not every tick) — proposes a partial-profit,
  // full-exit, or re-entry-target recommendation. Deterministic code below is
  // what actually executes anything; a HOLD or a review failure just falls
  // through to the same profit-step/trailing/time exits as before this
  // feature existed.
  if (shouldRunStrategyReview(trade)) {
    let aiDecision: PositionStrategyDecision | null = null;
    try {
      aiDecision = await runPositionStrategyReview({
        trade,
        token,
        plan,
        pair,
        remainingTokens,
        currentMultiple,
        unrealizedPnlPercent,
        profitStepsTaken,
      });
    } catch (err) {
      logger.error({ tradeId: trade.id, err: String(err) }, "strategy review threw unexpectedly — deterministic exits still run this tick");
    }
    if (aiDecision) {
      const acted = await applyAiStrategyDecision(trade, token.address, pair, remainingTokens, aiDecision);
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
    sellQuoteAvailable: await isSellable(token.address, pair, remainingTokens),
    profitStepsTaken,
  });

  if (!decision) return;
  if (!pair) {
    logger.warn({ tradeId: trade.id }, "exit triggered but no market data to fill against — will retry next tick");
    return;
  }

  await executeSell(trade, token.address, remainingTokens, decision, pair);
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
  pair: MarketPair | undefined,
  remainingTokens: number,
  decision: PositionStrategyDecision
): Promise<boolean> {
  if (decision.action === "SET_REENTRY_TARGET") {
    await applyReentryTarget(trade, decision);
    return false;
  }
  if (decision.action === "HOLD") return false;

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

  await executeSell(trade, tokenAddress, remainingTokens, exitDecision, pair);
  return true;
}

/**
 * Substitutes the strategy's fastFlip profile (earlier profit-taking, a
 * closer trailing stop, a short max hold) whenever either condition on
 * ExitRules.fastFlip's doc comment applies — a speculative, momentum-only
 * entry, or a large entry market cap on a project that isn't (yet) proven
 * strong enough to justify holding for the bigger move. Falls through to the
 * base profile unchanged whenever fastFlip isn't configured on the active
 * strategy, or the candidate/its qualityScore can't be found (never blocks
 * monitoring over a missing optional signal).
 */
async function resolveExitRules(trade: Trade, baseExitRules: ExitRules): Promise<ExitRules> {
  const { fastFlip } = baseExitRules;
  if (!fastFlip) return baseExitRules;

  const candidate = trade.candidateId
    ? await db.tradeCandidate.findUnique({ where: { id: trade.candidateId }, select: { qualityScore: true } })
    : null;
  const qualityScore = candidate?.qualityScore ?? undefined;

  const isSpeculative = qualityScore !== undefined && qualityScore < fastFlip.qualityScoreThreshold;
  const isLargeEntryNotYetProven =
    trade.actualEntryMcap != null &&
    trade.actualEntryMcap > fastFlip.largeMcapUsd &&
    (qualityScore === undefined || qualityScore < fastFlip.veryGoodQualityScoreThreshold);

  if (!isSpeculative && !isLargeEntryNotYetProven) return baseExitRules;

  return {
    ...baseExitRules,
    profitSteps: fastFlip.profitSteps,
    trailingActivationMultiple: fastFlip.trailingActivationMultiple,
    trailingPercent: fastFlip.trailingPercent,
    maxHoldMinutes: fastFlip.maxHoldMinutes,
  };
}

/**
 * Aggregates every BUY (the original entry plus any re-entries executed by
 * checkAndExecutePendingReentry) minus every SELL, rather than trusting the
 * scalar entryTokenAmount alone — that field only ever reflects the original
 * fill, so it silently under-counts a position once a re-entry buy adds to it.
 */
async function getRemainingTokenAmount(trade: Trade): Promise<number> {
  const [buys, sells] = await Promise.all([
    db.tradeExecution.aggregate({ where: { tradeId: trade.id, type: "BUY" }, _sum: { tokenAmount: true } }),
    db.tradeExecution.aggregate({ where: { tradeId: trade.id, type: "SELL" }, _sum: { tokenAmount: true } }),
  ]);
  const totalBought = buys._sum.tokenAmount ?? trade.entryTokenAmount ?? 0;
  return totalBought - (sells._sum.tokenAmount ?? 0);
}

function evaluateExits(ctx: {
  trade: Trade;
  plan: { invalidationMcap: number | null } | null;
  exitRules: ExitRules;
  currentMcap: number | undefined;
  currentMultiple: number;
  unrealizedPnlPercent: number;
  liquidityUsd: number;
  buySellRatio5m: number | undefined;
  sellQuoteAvailable: boolean;
  profitStepsTaken: number;
}): ExitDecision | null {
  const { trade, plan, exitRules } = ctx;

  // Priority 1: emergency/risk exit (§75).
  const positionRisk = validatePosition({
    liquidityUsd: ctx.liquidityUsd,
    liquidityAtEntryUsd: trade.entryLiquidityUsd ?? ctx.liquidityUsd, // falls back to current (no-op check) only for trades opened before entryLiquidityUsd existed
    unrealizedPnlPercent: ctx.unrealizedPnlPercent,
    maxLossPercent: exitRules.maxLossPercent,
    catastrophicLossPercent: exitRules.catastrophicLossPercent,
    buySellRatio5m: ctx.buySellRatio5m,
    sellQuoteAvailable: ctx.sellQuoteAvailable,
  });
  if (positionRisk.riskExitTriggered && positionRisk.severity === "CRITICAL") {
    return { type: "RISK_EXIT", sellPercentOfRemaining: 100, reason: positionRisk.reasons.join("; "), isEmergency: true };
  }

  // Priority 2: technical invalidation. Tolerance-adjusted, not the AI's
  // stated level directly — see tradingConfig.invalidationTolerancePercent
  // (a normal post-launch wick isn't the same thing as the setup actually
  // breaking; this exit was firing on exactly that kind of dip before).
  const invalidationFloor = plan?.invalidationMcap ? plan.invalidationMcap * (1 - tradingConfig.invalidationTolerancePercent / 100) : undefined;
  if (invalidationFloor !== undefined && ctx.currentMcap !== undefined && ctx.currentMcap <= invalidationFloor) {
    return {
      type: "INVALIDATION_EXIT",
      sellPercentOfRemaining: 100,
      reason: `market cap fell to tolerance-adjusted invalidation floor ($${Math.round(invalidationFloor).toLocaleString()}, AI level was $${Math.round(plan!.invalidationMcap!).toLocaleString()})`,
      isEmergency: false,
    };
  }
  if (positionRisk.riskExitTriggered) {
    return { type: "RISK_EXIT", sellPercentOfRemaining: 100, reason: positionRisk.reasons.join("; "), isEmergency: false };
  }

  // Priority 3: staged profit-taking (§35/§36) — only the next step not yet
  // taken, in ascending order. ctx.profitStepsTaken counts prior PROFIT_TARGET
  // ExitSignal rows for this trade (see monitorOneTrade).
  const nextStep = exitRules.profitSteps[ctx.profitStepsTaken];
  if (nextStep && ctx.currentMultiple >= nextStep.multiple) {
    return {
      type: "PROFIT_TARGET",
      sellPercentOfRemaining: nextStep.sellPercentOfRemaining,
      reason: `reached ${nextStep.multiple}x profit target (step ${ctx.profitStepsTaken + 1}/${exitRules.profitSteps.length})`,
      isEmergency: false,
    };
  }

  // Priority 4: trailing exit, once activated.
  if (ctx.currentMultiple >= exitRules.trailingActivationMultiple) {
    const peakMultiple = 1 + (trade.mfePercent ?? 0) / 100;
    const retracePercent = ((peakMultiple - ctx.currentMultiple) / peakMultiple) * 100;
    if (retracePercent >= exitRules.trailingPercent) {
      return {
        type: "TRAILING_EXIT",
        sellPercentOfRemaining: 100,
        reason: `retraced ${retracePercent.toFixed(1)}% from peak ${peakMultiple.toFixed(2)}x (trail ${exitRules.trailingPercent}%)`,
        isEmergency: false,
      };
    }
  }

  // Priority 5: time exit.
  const holdMinutes = trade.openedAt ? (Date.now() - trade.openedAt.getTime()) / 60_000 : 0;
  if (holdMinutes >= exitRules.maxHoldMinutes) {
    return { type: "TIME_EXIT", sellPercentOfRemaining: 100, reason: `held ${Math.round(holdMinutes)} minutes, exceeds ${exitRules.maxHoldMinutes}min max`, isEmergency: false };
  }

  return null;
}

async function executeSell(
  trade: Trade,
  tokenAddress: string,
  remainingTokens: number,
  decision: ExitDecision,
  pair: MarketPair
): Promise<void> {
  const sellTokens = remainingTokens * (decision.sellPercentOfRemaining / 100);

  // A pre-trade estimate only, to gate on slippage before ever executing —
  // mirrors the same estimate-then-execute split used for buys (§17).
  const preEstimate = await getSellEstimate(tokenAddress, sellTokens, pair);
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
    fill = await executeSellFill(tokenAddress, sellTokens, pair);
  } catch (err) {
    logger.error({ tradeId: trade.id, err: String(err) }, "sell execution failed — will retry next tick");
    return;
  }

  // fill.tokenAmount is what the fill ACTUALLY sold, which can be slightly
  // less than the sellTokens we asked for — executeSellFill clamps the
  // request to the wallet's real on-chain balance (see the float-precision
  // note there). Every number below has to come from the real amount, or
  // the leftover drift compounds into the next sell's remaining-position
  // math.
  const soldTokens = fill.tokenAmount;
  const proceedsUsd = soldTokens * fill.priceUsd;
  const costBasisForSoldTokens = trade.positionSizeUsd * (soldTokens / (trade.entryTokenAmount ?? soldTokens));
  const realizedPnlThisSell = proceedsUsd - costBasisForSoldTokens;

  await db.tradeExecution.create({
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
      submittedAt: new Date(),
      confirmedAt: new Date(),
    },
  });
  await db.exitSignal.create({
    data: { tradeId: trade.id, type: decision.type, severity: decision.isEmergency ? "CRITICAL" : "INFO", triggered: true, evidence: { reason: decision.reason, sellPercent: decision.sellPercentOfRemaining } },
  });
  await recordLedgerEntry({ type: LedgerEntryType.SELL, tradeId: trade.id, amountUsd: proceedsUsd, notes: `${fill.provider} sell — ${decision.reason}${fill.txHash ? ` (${fill.txHash})` : ""}` });
  await recordLedgerEntry({ type: LedgerEntryType.GAS, tradeId: trade.id, amountUsd: -fill.gasCostUsd, notes: fill.provider === "live" ? "real gas" : "simulated gas" });

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

  const isFullExit = decision.sellPercentOfRemaining >= 100 || sellTokens >= remainingTokens - 1e-9;
  if (isFullExit) {
    await closeTrade(trade, decision.reason);
  } else {
    await db.trade.update({ where: { id: trade.id }, data: { status: TradeStatus.PARTIALLY_EXITED } });
    await sendPartialProfitEmail({ tradeId: trade.id, tokenId: trade.tokenId, multiple: 1 + (trade.mfePercent ?? 0) / 100, sellPercent: decision.sellPercentOfRemaining, mode: trade.mode }).catch(
      (err) => logger.error({ tradeId: trade.id, err: String(err) }, "failed to send partial profit email")
    );
    logger.info({ tradeId: trade.id, decision: decision.type, sellTokens, provider: fill.provider }, "partial exit executed");
  }
}

async function closeTrade(trade: Trade, exitReason: string): Promise<void> {
  const executions = await db.tradeExecution.findMany({ where: { tradeId: trade.id } });
  const totalBuyUsd = executions.filter((e) => e.type === "BUY").reduce((s, e) => s + (e.usdValue ?? 0), 0);
  const totalSellUsd = executions.filter((e) => e.type === "SELL").reduce((s, e) => s + (e.usdValue ?? 0), 0);
  const realizedPnlUsd = totalSellUsd - totalBuyUsd;
  const realizedMultiple = totalBuyUsd > 0 ? totalSellUsd / totalBuyUsd : undefined;

  const updated = await db.trade.update({
    where: { id: trade.id },
    data: { status: TradeStatus.CLOSED, closedAt: new Date(), realizedPnlUsd, realizedMultiple, exitReason },
  });

  logger.info({ tradeId: trade.id, realizedPnlUsd, realizedMultiple, exitReason }, "trade closed");

  const token = await db.token.findUnique({ where: { id: trade.tokenId } });
  await sendTradeClosedEmail({ token, trade: updated }).catch((err) => logger.error({ tradeId: trade.id, err: String(err) }, "failed to send closed-trade email"));
  await generatePostmortem(updated.id).catch((err) => logger.error({ tradeId: trade.id, err: String(err) }, "postmortem generation failed"));
  await checkPortfolioMilestones().catch((err) => logger.error({ err: String(err) }, "milestone check failed"));
}

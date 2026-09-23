import { db } from "../db";
import { logger } from "../logger";
import { config } from "../config";
import type { Trade, Token, TradePlan } from "../generated/prisma";
import type { MarketPair } from "../dex/types";
import { tradingConfig } from "./config";
import { callStructured } from "../ai/provider";
import { PositionStrategySchema, POSITION_STRATEGY_JSON_SCHEMA, type PositionStrategyDecision } from "../ai/schemas";
import { POSITION_STRATEGY_SYSTEM, buildPositionStrategyPrompt } from "../ai/prompts";
import { computeTechnicalFeatures, formatTechnicalFeaturesForPrompt, type TechnicalFeatures } from "./marketAnalysis";
import { getActiveStrategyVersion, type ExitRules, type ProjectTier } from "./strategy";
import { validateEntry } from "./riskEngine";
import { recordLedgerEntry, checkCircuitBreakers, getPortfolioState } from "./portfolio";
import { executeBuyFill, getBuyEstimate, isSellable, type FillResult } from "./executionFacade";
import { LedgerEntryType } from "../generated/prisma";
import { renderPositionChart } from "./chartVisionGate";

/**
 * The "smart" half of active management: a short-interval (not per-tick, but
 * close to it) AI check-in on an already-open trade, using real-time
 * technical data (support/resistance, volume trend, momentum) AND — once
 * there's enough PositionSnapshot history — an actual rendered chart of this
 * position's own price/volume path, that the deterministic exit rules in
 * positionManager.ts never see.
 *
 * User directive 2026-09-22: this is now the ONLY mechanism that ever takes
 * profit on a live position — positionManager.ts's old fixed-multiple
 * PROFIT_TARGET step ladder was removed. The deterministic layer still
 * enforces every hard *safety* limit regardless of what this review
 * recommends — stop-loss, catastrophic-loss, technical invalidation, the
 * trailing stop protecting an already-reached peak, re-entry size/count
 * caps, circuit breakers, slippage — none of those take profit early, they
 * only bound downside, so a review failure or a HOLD just means no profit
 * gets banked this tick, not that the position is unprotected.
 */

export function shouldRunStrategyReview(trade: Trade): boolean {
  if (!trade.lastStrategyReviewAt) return true;
  const elapsedSeconds = (Date.now() - trade.lastStrategyReviewAt.getTime()) / 1000;
  return elapsedSeconds >= tradingConfig.positionStrategyReviewIntervalSeconds;
}

function formatPositionState(input: {
  currentMultiple: number;
  unrealizedPnlPercent: number;
  mfePercent: number | null;
  maePercent: number | null;
  holdMinutes: number;
  partialSellsCount: number;
  remainingTokens: number;
  totalBoughtTokens: number;
}): string {
  const percentOfOriginalRemaining = input.totalBoughtTokens > 0 ? (input.remainingTokens / input.totalBoughtTokens) * 100 : 100;
  return [
    `Current: ${input.currentMultiple.toFixed(2)}x entry (${input.unrealizedPnlPercent >= 0 ? "+" : ""}${input.unrealizedPnlPercent.toFixed(1)}%)`,
    `Best so far: +${(input.mfePercent ?? 0).toFixed(1)}% | Worst so far: ${(input.maePercent ?? 0).toFixed(1)}%`,
    `Held for: ${Math.round(input.holdMinutes)} minutes`,
    `Partial profit sells so far: ${input.partialSellsCount} — ${percentOfOriginalRemaining.toFixed(0)}% of the original position still held`,
  ].join("\n");
}

// User directive 2026-09-22 (§goodProject) + 2026-09-23 ("hold good utility
// tokens for as long as possible, not just 48 hours max"): the GOOD_PROJECT
// tier's maxHoldMinutes uses the same "no real ceiling" sentinel this
// codebase already uses elsewhere (manualSubmit.ts's targetMcapMax) rather
// than Infinity, which isn't valid JSON and can't round-trip through the
// DB-stored StrategyVersion.exitRules. A year is an arbitrary but generous
// cutoff for "don't bother printing an absurd hour count" — the underlying
// value can be far larger than this and still mean "no real cap."
const NO_REAL_HOLD_CAP_MINUTES = 60 * 24 * 365;

function formatExitRulesState(exitRules: ExitRules, currentMultiple: number): string {
  const holdCapText =
    exitRules.maxHoldMinutes >= NO_REAL_HOLD_CAP_MINUTES
      ? "no real cap — hold as long as the thesis holds"
      : `${(exitRules.maxHoldMinutes / 60).toFixed(0)}h`;
  return [
    "No fixed profit-taking multiples exist — deciding if/when/how much profit to take is entirely your call, from the chart and data below.",
    `Trailing stop (loss protection only, not a target): once this position's peak-ever multiple crosses ${exitRules.trailingActivationMultiple}x, a ${exitRules.trailingPercent}% retrace from that peak force-sells everything regardless of your view${currentMultiple >= exitRules.trailingActivationMultiple ? " (ACTIVE now)" : " (not yet active)"} — treat this as a backstop, not a cue to hold until it fires.`,
    `Hard stop: ${exitRules.maxLossPercent}% loss | Catastrophic/emergency stop: ${exitRules.catastrophicLossPercent}% loss.`,
    `Max-hold time-exit: ${holdCapText}, but ONLY while this position is currently underwater (below entry price) — it never force-closes a position that's up, no matter how long it's been held.`,
  ].join("\n");
}

// User directive 2026-09-22: DCA budget is earned, not a blanket default —
// GOOD_PROJECT (cleared fastFlip's bar + a confirmed real X community, see
// strategy.ts's ExitRules.goodProject) gets the full budget; BASE gets a
// modest allowance; FAST_FLIP (low quality or an unproven large entry) gets
// none. See positionManager.ts's resolveExitRules for how the tier itself
// is decided.
function reentryBudgetFor(tier: ProjectTier): { maxReentries: number; maxPercentOfOriginal: number } {
  switch (tier) {
    case "GOOD_PROJECT":
      return { maxReentries: tradingConfig.maxReentriesPerTradeGoodProject, maxPercentOfOriginal: tradingConfig.maxReentryPercentOfOriginalGoodProject };
    case "BASE":
      return { maxReentries: tradingConfig.maxReentriesPerTradeBase, maxPercentOfOriginal: tradingConfig.maxReentryPercentOfOriginalBase };
    case "FAST_FLIP":
      return { maxReentries: tradingConfig.maxReentriesPerTradeFastFlip, maxPercentOfOriginal: tradingConfig.maxReentryPercentOfOriginalFastFlip };
  }
}

function formatReentryState(trade: Trade, tier: ProjectTier): string {
  const { maxReentries, maxPercentOfOriginal } = reentryBudgetFor(tier);
  const remaining = maxReentries - trade.reentryCount;
  if (remaining <= 0) {
    return `No re-entry budget for this trade (tier ${tier}: ${trade.reentryCount}/${maxReentries} used) — do not propose SET_REENTRY_TARGET.${tier !== "GOOD_PROJECT" ? " This trade hasn't earned full DCA privileges (needs cleared fastFlip eligibility plus a confirmed strong X community)." : ""}`;
  }
  const pending = trade.pendingReentryTargetMcap
    ? `A re-entry target is already pending: $${Math.round(trade.pendingReentryTargetMcap).toLocaleString()} mcap, expires ${trade.pendingReentryExpiresAt?.toISOString() ?? "unknown"}. Only replace it if your new view has genuinely changed.`
    : "No re-entry target currently pending.";
  return `${remaining} of ${maxReentries} re-entries still available for this trade (tier: ${tier}). Any re-entry size you propose is capped at ${maxPercentOfOriginal}% of the original position regardless of what you suggest. ${pending}`;
}

async function fetchResearchSummary(trade: Trade): Promise<string> {
  if (!trade.candidateId) return "No linked research candidate for this trade.";
  const candidate = await db.tradeCandidate.findUnique({ where: { id: trade.candidateId } });
  if (!candidate?.researchRunId) return "No completed research run linked to this trade's candidate.";
  const run = await db.researchRun.findUnique({ where: { id: candidate.researchRunId } });
  if (!run) return "Research run not found.";
  return [
    `Quality score at entry: ${run.finalScore ?? "unknown"}/100 (confidence ${run.confidence ?? "unknown"}%)`,
    `Summary: ${run.summary ?? "(none recorded)"}`,
    `Positives noted: ${(run.positives as string[] | null)?.join("; ") || "(none)"}`,
    `Risks noted: ${(run.risks as string[] | null)?.join("; ") || "(none)"}`,
  ].join("\n");
}

export async function runPositionStrategyReview(input: {
  trade: Trade;
  token: Token;
  plan: TradePlan | null;
  pair: MarketPair | undefined;
  remainingTokens: number;
  totalBoughtTokens: number;
  currentMultiple: number;
  unrealizedPnlPercent: number;
  partialSellsCount: number;
  tier: ProjectTier;
}): Promise<PositionStrategyDecision | null> {
  const { trade, token, pair } = input;

  const strategy = await getActiveStrategyVersion();
  const exitRules = strategy.exitRules as unknown as ExitRules;
  const technical: TechnicalFeatures = await computeTechnicalFeatures(trade.tokenId, pair, token.address, token.chain);
  const researchSummary = await fetchResearchSummary(trade);
  const holdMinutes = trade.openedAt ? (Date.now() - trade.openedAt.getTime()) / 60_000 : 0;
  // The whole point of dropping the fixed profit-step ladder in favor of this
  // review is to actually look at the chart — reuse chartVisionGate.ts's
  // self-rendered PositionSnapshot chart (no external fetch, same data this
  // trade has been writing every tick since it opened) rather than building a
  // second rendering path. Undefined when there's not yet enough history;
  // the prompt says so explicitly rather than silently reasoning off nothing.
  const chartImage = await renderPositionChart(trade.id);

  let decision: PositionStrategyDecision;
  try {
    decision = await callStructured({
      model: config.researchModel,
      system: POSITION_STRATEGY_SYSTEM,
      prompt: buildPositionStrategyPrompt({
        token: { name: token.name, symbol: token.symbol, address: token.address, chain: token.chain },
        researchSummary,
        positionState: formatPositionState({
          currentMultiple: input.currentMultiple,
          unrealizedPnlPercent: input.unrealizedPnlPercent,
          mfePercent: trade.mfePercent,
          maePercent: trade.maePercent,
          holdMinutes,
          partialSellsCount: input.partialSellsCount,
          remainingTokens: input.remainingTokens,
          totalBoughtTokens: input.totalBoughtTokens,
        }),
        exitRulesState: formatExitRulesState(exitRules, input.currentMultiple),
        reentryState: formatReentryState(trade, input.tier),
        technical: formatTechnicalFeaturesForPrompt(technical),
        chartAttached: chartImage !== undefined,
      }),
      schema: PositionStrategySchema,
      jsonSchema: POSITION_STRATEGY_JSON_SCHEMA,
      toolName: "submit_position_strategy",
      images: chartImage ? [chartImage] : undefined,
      maxTokens: 1500,
    });
  } catch (err) {
    // Fail safe: this is now the only profit-taking mechanism, so a failed
    // call means no profit gets banked THIS tick — never block or crash
    // position monitoring over it, and never fall back to a fixed multiple.
    // The deterministic safety net (stop-loss/catastrophic/invalidation/
    // trailing-stop) still runs every tick regardless and is what protects
    // this position if the AI stays down for a while.
    logger.warn({ tradeId: trade.id, err: String(err) }, "position strategy review failed — safety-only deterministic exits continue unaffected, no profit-taking this tick");
    return null;
  }

  await db.trade.update({ where: { id: trade.id }, data: { lastStrategyReviewAt: new Date() } });
  const decisionEnum =
    decision.action === "EXIT_NOW" ? "SELL" : decision.action === "TAKE_PARTIAL_PROFIT" ? "PARTIAL_SELL" : decision.action === "SET_REENTRY_TARGET" ? "WAIT" : "HOLD";
  await db.tradeDecisionSnapshot.create({
    data: {
      tradeId: trade.id,
      decision: decisionEnum,
      stage: "position_monitor",
      strategyVersionId: strategy.id,
      marketState: (pair ?? {}) as unknown as object,
      projectState: {},
      technicalState: technical as unknown as object,
      portfolioState: {},
      modelName: config.researchModel,
      aiAnalysis: decision as unknown as object,
      deterministicRules: { tier: input.tier, ...reentryBudgetFor(input.tier) },
      finalReasons: [decision.reasoning],
    },
  });

  logger.info(
    { tradeId: trade.id, action: decision.action, confidence: decision.confidence, reasoning: decision.reasoning },
    "position strategy review complete"
  );

  return decision;
}

/**
 * Applies a SET_REENTRY_TARGET recommendation — stores the target, never
 * buys anything itself. The actual buy only happens later, deterministically,
 * in checkAndExecutePendingReentry once (and if) price really reaches it.
 */
export async function applyReentryTarget(trade: Trade, decision: PositionStrategyDecision, tier: ProjectTier): Promise<void> {
  if (decision.action !== "SET_REENTRY_TARGET" || !decision.reentryTargetMarketCapUsd) return;
  const { maxReentries, maxPercentOfOriginal } = reentryBudgetFor(tier);
  if (trade.reentryCount >= maxReentries) {
    logger.info({ tradeId: trade.id, tier }, "AI proposed a re-entry target but this trade's re-entry budget is already used (or this tier gets none) — ignoring");
    return;
  }
  const cappedPercent = Math.min(decision.reentrySizePercentOfOriginal ?? 50, maxPercentOfOriginal);
  const reentryUsd = trade.positionSizeUsd * (cappedPercent / 100);
  const validForMinutes = decision.reentryValidForMinutes ?? 60;

  await db.trade.update({
    where: { id: trade.id },
    data: {
      pendingReentryTargetMcap: decision.reentryTargetMarketCapUsd,
      pendingReentryUsd: reentryUsd,
      pendingReentryExpiresAt: new Date(Date.now() + validForMinutes * 60_000),
      pendingReentryReason: decision.reasoning,
    },
  });
  logger.info(
    { tradeId: trade.id, targetMcap: decision.reentryTargetMarketCapUsd, reentryUsd, validForMinutes },
    "set a pending re-entry target for this trade"
  );
}

/**
 * The deterministic half — runs every cheap monitor tick, no AI involved.
 * Only actually buys if price has really reached the target the AI proposed
 * earlier, and only after the same entry-risk gate a fresh trade would face.
 */
export async function checkAndExecutePendingReentry(trade: Trade, token: Token, pair: MarketPair | undefined, tier: ProjectTier): Promise<void> {
  if (!trade.pendingReentryTargetMcap || !trade.pendingReentryUsd) return;

  if (trade.pendingReentryExpiresAt && trade.pendingReentryExpiresAt.getTime() < Date.now()) {
    await db.trade.update({
      where: { id: trade.id },
      data: { pendingReentryTargetMcap: null, pendingReentryUsd: null, pendingReentryExpiresAt: null, pendingReentryReason: null },
    });
    logger.info({ tradeId: trade.id }, "pending re-entry target expired without price reaching it");
    return;
  }

  const currentMcap = pair?.marketCapUsd;
  if (currentMcap === undefined || currentMcap > trade.pendingReentryTargetMcap) return; // hasn't dipped to the target yet

  // Re-checked at execution time, not just when the target was set — the
  // tier is re-derived fresh from resolveExitRules every tick, so this is
  // the same budget applyReentryTarget capped the target at, just re-read
  // here for its own hard-cap purpose rather than trusted stale.
  if (trade.reentryCount >= reentryBudgetFor(tier).maxReentries) return; // budget used up between setting and now
  if (!pair) return;

  // A fresh quote before every real buy, exactly like a first entry — never
  // trust the price/mcap in `pair` alone to imply slippage is acceptable.
  const [circuitBreakers, portfolio, sellQuoteAvailable, buyEstimate] = await Promise.all([
    checkCircuitBreakers(),
    getPortfolioState(),
    isSellable(token.address, pair, token.chain, undefined),
    getBuyEstimate(token.address, trade.pendingReentryUsd, pair, token.chain),
  ]);
  // A re-entry adds to a position without facing the high-conviction gate a
  // fresh conservative-mode entry has to clear, so it waits until the loss
  // breakers reset.
  const conservative = circuitBreakers.mode === "CONSERVATIVE";
  const entryCheck = validateEntry({
    circuitBreakersPaused: circuitBreakers.paused || conservative,
    circuitBreakerReasons: conservative ? [...circuitBreakers.reasons, "re-entries are off in conservative mode"] : circuitBreakers.reasons,
    currentLiquidityUsd: pair.liquidityUsd ?? 0,
    liquidityAtPlanUsd: pair.liquidityUsd ?? 0,
    sellQuoteAvailable,
    buySellRatio1h: pair.buys1h !== undefined || pair.sells1h !== undefined ? (pair.buys1h ?? 0) / Math.max((pair.buys1h ?? 0) + (pair.sells1h ?? 0), 1) : undefined,
    priceChange5mPercent: pair.priceChange5m,
    estimatedSlippageBps: buyEstimate.estimatedSlippageBps,
    estimatedPriceImpactPercent: buyEstimate.estimatedPriceImpactPercent,
    positionSizeUsd: trade.pendingReentryUsd,
    // A re-entry still has to fit the same deployable-capital bucket a fresh
    // trade would — the tier's maxPercentOfOriginal cap (reentryBudgetFor)
    // bounds this trade's own size, not the portfolio's overall exposure.
    availableToDeployUsd: portfolio.availableToDeployUsd,
  });

  if (entryCheck.decision !== "APPROVED") {
    logger.info({ tradeId: trade.id, decision: entryCheck.decision, reasons: entryCheck.reasons }, "pending re-entry target reached but blocked by entry-risk checks — will retry next tick");
    return;
  }

  let fill: FillResult;
  try {
    fill = await executeBuyFill(token.address, trade.pendingReentryUsd, pair, token.chain);
  } catch (err) {
    logger.error({ tradeId: trade.id, err: String(err) }, "re-entry buy execution failed — will retry next tick");
    return;
  }

  await db.tradeExecution.create({
    data: {
      tradeId: trade.id,
      type: "BUY",
      status: "CONFIRMED",
      txHash: fill.txHash,
      tokenAmount: fill.tokenAmount,
      usdValue: trade.pendingReentryUsd,
      actualPrice: fill.priceUsd,
      slippagePercent: fill.estimatedSlippageBps / 100,
      priceImpactPercent: fill.estimatedPriceImpactPercent,
      gasCostUsd: fill.gasCostUsd,
      provider: fill.provider,
      submittedAt: new Date(),
      confirmedAt: new Date(),
    },
  });
  await recordLedgerEntry({ type: LedgerEntryType.BUY, tradeId: trade.id, amountUsd: -trade.pendingReentryUsd, notes: `${fill.provider} re-entry — ${trade.pendingReentryReason ?? "AI-proposed dip buy"}` });
  await recordLedgerEntry({ type: LedgerEntryType.GAS, tradeId: trade.id, amountUsd: -fill.gasCostUsd, notes: fill.provider === "live" ? "real gas" : "simulated gas" });

  await db.trade.update({
    where: { id: trade.id },
    data: {
      reentryCount: { increment: 1 },
      pendingReentryTargetMcap: null,
      pendingReentryUsd: null,
      pendingReentryExpiresAt: null,
      pendingReentryReason: null,
    },
  });

  logger.info({ tradeId: trade.id, usdSpent: trade.pendingReentryUsd, tokenAmount: fill.tokenAmount, provider: fill.provider }, "re-entry buy executed — price reached the AI-proposed target");
}

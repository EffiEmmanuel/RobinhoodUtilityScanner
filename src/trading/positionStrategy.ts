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
import { getActiveStrategyVersion, type ExitRules } from "./strategy";
import { validateEntry } from "./riskEngine";
import { recordLedgerEntry, checkCircuitBreakers, getPortfolioState } from "./portfolio";
import { executeBuyFill, getBuyEstimate, isSellable, type FillResult } from "./executionFacade";
import { LedgerEntryType } from "../generated/prisma";

/**
 * The "smart" half of active management: a periodic (not per-tick) AI
 * check-in on an already-open trade, using real-time technical data
 * (support/resistance, volume trend, momentum) that the deterministic exit
 * rules in positionManager.ts never see. The AI proposes; the deterministic
 * layer still enforces every hard limit — re-entry size cap, re-entry count
 * cap, circuit breakers, slippage — exactly as it does for a fresh entry.
 */

export function shouldRunStrategyReview(trade: Trade): boolean {
  if (!trade.lastStrategyReviewAt) return true;
  const elapsedMinutes = (Date.now() - trade.lastStrategyReviewAt.getTime()) / 60_000;
  return elapsedMinutes >= tradingConfig.positionStrategyReviewIntervalMinutes;
}

function formatPositionState(input: {
  currentMultiple: number;
  unrealizedPnlPercent: number;
  mfePercent: number | null;
  maePercent: number | null;
  holdMinutes: number;
  profitStepsTaken: number;
  profitStepsTotal: number;
}): string {
  return [
    `Current: ${input.currentMultiple.toFixed(2)}x entry (${input.unrealizedPnlPercent >= 0 ? "+" : ""}${input.unrealizedPnlPercent.toFixed(1)}%)`,
    `Best so far: +${(input.mfePercent ?? 0).toFixed(1)}% | Worst so far: ${(input.maePercent ?? 0).toFixed(1)}%`,
    `Held for: ${Math.round(input.holdMinutes)} minutes`,
    `Profit steps already taken: ${input.profitStepsTaken}/${input.profitStepsTotal}`,
  ].join("\n");
}

function formatExitRulesState(exitRules: ExitRules, currentMultiple: number): string {
  return [
    `Profit-step targets: ${exitRules.profitSteps.map((s) => `${s.multiple}x (sell ${s.sellPercentOfRemaining}% of what's left)`).join(", ")}`,
    `Trailing stop: activates at ${exitRules.trailingActivationMultiple}x, then exits on a ${exitRules.trailingPercent}% retrace from peak${currentMultiple >= exitRules.trailingActivationMultiple ? " (ACTIVE now)" : " (not yet active)"}`,
    `Hard stop: ${exitRules.maxLossPercent}% loss | Catastrophic/emergency stop: ${exitRules.catastrophicLossPercent}% loss`,
    "No time-based max-hold exit is active; hold until profit, risk, invalidation, trailing, or strategy evidence says to exit.",
  ].join("\n");
}

function formatReentryState(trade: Trade): string {
  const remaining = tradingConfig.maxReentriesPerTrade - trade.reentryCount;
  if (remaining <= 0) {
    return `No re-entry budget left for this trade (${trade.reentryCount}/${tradingConfig.maxReentriesPerTrade} already used) — do not propose SET_REENTRY_TARGET.`;
  }
  const pending = trade.pendingReentryTargetMcap
    ? `A re-entry target is already pending: $${Math.round(trade.pendingReentryTargetMcap).toLocaleString()} mcap, expires ${trade.pendingReentryExpiresAt?.toISOString() ?? "unknown"}. Only replace it if your new view has genuinely changed.`
    : "No re-entry target currently pending.";
  return `${remaining} of ${tradingConfig.maxReentriesPerTrade} re-entries still available for this trade. Any re-entry size you propose is capped at ${tradingConfig.maxReentryPercentOfOriginal}% of the original position regardless of what you suggest. ${pending}`;
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
  currentMultiple: number;
  unrealizedPnlPercent: number;
  profitStepsTaken: number;
}): Promise<PositionStrategyDecision | null> {
  const { trade, token, pair } = input;

  const strategy = await getActiveStrategyVersion();
  const exitRules = strategy.exitRules as unknown as ExitRules;
  const technical: TechnicalFeatures = await computeTechnicalFeatures(trade.tokenId, pair, token.address);
  const researchSummary = await fetchResearchSummary(trade);
  const holdMinutes = trade.openedAt ? (Date.now() - trade.openedAt.getTime()) / 60_000 : 0;

  let decision: PositionStrategyDecision;
  try {
    decision = await callStructured({
      model: config.researchModel,
      system: POSITION_STRATEGY_SYSTEM,
      prompt: buildPositionStrategyPrompt({
        token: { name: token.name, symbol: token.symbol, address: token.address },
        researchSummary,
        positionState: formatPositionState({
          currentMultiple: input.currentMultiple,
          unrealizedPnlPercent: input.unrealizedPnlPercent,
          mfePercent: trade.mfePercent,
          maePercent: trade.maePercent,
          holdMinutes,
          profitStepsTaken: input.profitStepsTaken,
          profitStepsTotal: exitRules.profitSteps.length,
        }),
        exitRulesState: formatExitRulesState(exitRules, input.currentMultiple),
        reentryState: formatReentryState(trade),
        technical: formatTechnicalFeaturesForPrompt(technical),
      }),
      schema: PositionStrategySchema,
      jsonSchema: POSITION_STRATEGY_JSON_SCHEMA,
      toolName: "submit_position_strategy",
      maxTokens: 1500,
    });
  } catch (err) {
    // Fail safe: no strategy call succeeding just means the deterministic
    // exit rules keep running unmodified this tick, same as before this
    // feature existed — never block or crash position monitoring over it.
    logger.warn({ tradeId: trade.id, err: String(err) }, "position strategy review failed — deterministic exit rules continue unaffected");
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
      deterministicRules: { maxReentryPercentOfOriginal: tradingConfig.maxReentryPercentOfOriginal, maxReentriesPerTrade: tradingConfig.maxReentriesPerTrade },
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
export async function applyReentryTarget(trade: Trade, decision: PositionStrategyDecision): Promise<void> {
  if (decision.action !== "SET_REENTRY_TARGET" || !decision.reentryTargetMarketCapUsd) return;
  if (trade.reentryCount >= tradingConfig.maxReentriesPerTrade) {
    logger.info({ tradeId: trade.id }, "AI proposed a re-entry target but this trade's re-entry budget is already used — ignoring");
    return;
  }
  const cappedPercent = Math.min(decision.reentrySizePercentOfOriginal ?? 50, tradingConfig.maxReentryPercentOfOriginal);
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
export async function checkAndExecutePendingReentry(trade: Trade, token: Token, pair: MarketPair | undefined): Promise<void> {
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

  if (trade.reentryCount >= tradingConfig.maxReentriesPerTrade) return; // budget used up between setting and now
  if (!pair) return;

  // A fresh quote before every real buy, exactly like a first entry — never
  // trust the price/mcap in `pair` alone to imply slippage is acceptable.
  const [circuitBreakers, portfolio, sellQuoteAvailable, buyEstimate] = await Promise.all([
    checkCircuitBreakers(),
    getPortfolioState(),
    isSellable(token.address, pair, undefined),
    getBuyEstimate(token.address, trade.pendingReentryUsd, pair),
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
    // trade would — the maxReentryPercentOfOriginal cap bounds this trade's
    // own size, not the portfolio's overall exposure.
    availableToDeployUsd: portfolio.availableToDeployUsd,
  });

  if (entryCheck.decision !== "APPROVED") {
    logger.info({ tradeId: trade.id, decision: entryCheck.decision, reasons: entryCheck.reasons }, "pending re-entry target reached but blocked by entry-risk checks — will retry next tick");
    return;
  }

  let fill: FillResult;
  try {
    fill = await executeBuyFill(token.address, trade.pendingReentryUsd, pair);
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

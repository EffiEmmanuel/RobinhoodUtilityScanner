import { db } from "../db";
import { config } from "../config";
import { logger } from "../logger";
import { callStructured } from "../ai/provider";
import { TradeAnalysisSchema, TRADE_ANALYSIS_JSON_SCHEMA } from "./schemas";
import { TRADE_ANALYSIS_SYSTEM, buildTradeAnalysisPrompt } from "./prompts";
import { pollCandidateMarket, computeTechnicalFeatures, formatTechnicalFeaturesForPrompt } from "./marketAnalysis";
import { evaluateCandidate } from "./riskEngine";
import { getActiveStrategyVersion } from "./strategy";
import { tradingConfig } from "./config";
import { TradeCandidateStatus, TradePlanAction, PendingEntryStatus, TradeDecision } from "../generated/prisma";
import { sendTradePlanEmail } from "./notifications";

/**
 * §14: turns a QUALIFIED candidate into BUY_NOW / WAIT_FOR_ENTRY / WATCH_ONLY
 * / REJECT_TRADE. The AI proposes market interpretation and a target zone;
 * this function re-runs the deterministic eligibility gate against FRESH
 * market data (liquidity can have moved since candidate creation) and can
 * downgrade whatever the AI recommends, but never upgrade a REJECT_TRADE.
 *
 * Also called repeatedly by entryMonitor.ts to REPLAN an already-WAITING
 * candidate (fresh target zone/risk score) — the email below only fires the
 * first time a candidate enters the watching panel, not on every replan.
 */
export async function planCandidate(candidateId: string): Promise<void> {
  const candidate = await db.tradeCandidate.findUniqueOrThrow({
    where: { id: candidateId },
    include: { token: true },
  });
  const isFirstPlan = candidate.status !== TradeCandidateStatus.WAITING;
  const run = candidate.researchRunId
    ? await db.researchRun.findUnique({ where: { id: candidate.researchRunId } })
    : null;
  if (!run) {
    logger.error({ candidateId }, "planCandidate: no research run found — rejecting");
    await db.tradeCandidate.update({ where: { id: candidateId }, data: { status: TradeCandidateStatus.REJECTED } });
    return;
  }

  const strategy = await getActiveStrategyVersion();
  const market = await pollCandidateMarket(candidate.tokenId, candidate.token.chain, candidate.token.address);
  const technical = await computeTechnicalFeatures(candidate.tokenId, market.primaryPair);

  const liquidityUsd = market.primaryPair?.liquidityUsd ?? 0;
  const freshEval = evaluateCandidate({
    qualityScore: candidate.qualityScore ?? 0,
    researchConfidence: candidate.researchConfidence ?? 0,
    contractScore: run.contractScore ?? 0,
    liquidityUsd,
    hardReject: run.hardReject,
  });

  if (!freshEval.eligible) {
    await recordDecision(candidate.id, null, TradeDecision.SKIP, "planning", strategy.id, {
      market: summarizeMarket(market.primaryPair?.marketCapUsd, liquidityUsd),
      project: { qualityScore: candidate.qualityScore, researchConfidence: candidate.researchConfidence },
      technical,
      reasons: freshEval.reasons,
    });
    await db.tradeCandidate.update({ where: { id: candidateId }, data: { status: TradeCandidateStatus.REJECTED } });
    logger.info({ candidateId, reasons: freshEval.reasons }, "candidate rejected at planning (liquidity/quality moved since qualification)");
    return;
  }

  let analysis;
  try {
    analysis = await callStructured({
      model: config.researchModel,
      system: TRADE_ANALYSIS_SYSTEM,
      prompt: buildTradeAnalysisPrompt({
        token: candidate.token,
        projectSummary: run.summary ?? "(no summary available)",
        qualityScore: candidate.qualityScore ?? 0,
        researchConfidence: candidate.researchConfidence ?? 0,
        marketText: summarizeMarket(market.primaryPair?.marketCapUsd, liquidityUsd, market.primaryPair?.priceUsd),
        technicalText: formatTechnicalFeaturesForPrompt(technical),
      }),
      schema: TradeAnalysisSchema,
      jsonSchema: TRADE_ANALYSIS_JSON_SCHEMA,
      toolName: "submit_trade_analysis",
      maxTokens: 2000,
    });
  } catch (err) {
    logger.error({ candidateId, err: String(err) }, "trade analysis AI call failed — reverting candidate to QUALIFIED for retry");
    await db.tradeCandidate.update({ where: { id: candidateId }, data: { status: TradeCandidateStatus.QUALIFIED } });
    return;
  }

  const action = analysis.recommendedAction;
  const currentMcap = market.primaryPair?.marketCapUsd;
  const clampedZone = clampPullbackTarget(currentMcap, analysis.targetEntryMcapMin, analysis.targetEntryMcapMax, technical);

  const plan = await db.tradePlan.create({
    data: {
      candidateId: candidate.id,
      strategyVersionId: strategy.id,
      action,
      entryStyle: analysis.entryStyle,
      currentMarketCap: currentMcap,
      targetEntryMcapMin: clampedZone.min,
      targetEntryMcapMax: clampedZone.max,
      doNotChaseAboveMcap: analysis.doNotChaseAboveMcap,
      invalidationMcap: analysis.technicalInvalidationMcap,
      riskScore: analysis.riskScore,
      confidence: analysis.confidence,
      planData: { analysis, freshEval, liquidityUsd, pullbackClamped: clampedZone.clamped } as unknown as object,
      expiresAt: new Date(Date.now() + strategyTtlMs(strategy)),
    },
  });

  await recordDecision(
    candidate.id,
    null,
    action === TradePlanAction.BUY_NOW || action === TradePlanAction.WAIT_FOR_ENTRY ? TradeDecision.WAIT : TradeDecision.SKIP,
    "planning",
    strategy.id,
    {
      market: summarizeMarket(market.primaryPair?.marketCapUsd, liquidityUsd),
      project: { qualityScore: candidate.qualityScore, researchConfidence: candidate.researchConfidence },
      technical,
      aiAnalysis: analysis,
      reasons: analysis.reasoning,
    }
  );

  if (action === TradePlanAction.BUY_NOW || action === TradePlanAction.WAIT_FOR_ENTRY) {
    await db.pendingEntry.create({
      data: {
        tradePlanId: plan.id,
        status: PendingEntryStatus.ACTIVE,
        // BUY_NOW: trigger immediately by targeting a window around current mcap.
        // WAIT_FOR_ENTRY: the CLAMPED zone, not the AI's raw proposal — see
        // clampPullbackTarget below.
        targetMcapMin: action === TradePlanAction.BUY_NOW ? (currentMcap ?? 0) * 0.9 : clampedZone.min,
        targetMcapMax: action === TradePlanAction.BUY_NOW ? (currentMcap ?? 0) * 1.1 : clampedZone.max,
        expiresAt: plan.expiresAt,
      },
    });
    await db.tradeCandidate.update({ where: { id: candidateId }, data: { status: TradeCandidateStatus.WAITING } });
    if (isFirstPlan) {
      await sendTradePlanEmail({
        token: candidate.token,
        action,
        currentMcap,
        targetMin: clampedZone.min,
        targetMax: clampedZone.max,
        doNotChaseAboveMcap: analysis.doNotChaseAboveMcap,
        invalidationMcap: analysis.technicalInvalidationMcap,
        qualityScore: candidate.qualityScore,
        researchConfidence: candidate.researchConfidence,
        riskScore: analysis.riskScore,
        confidence: analysis.confidence,
        reasoning: analysis.reasoning,
      }).catch((err) => logger.error({ candidateId, err: String(err) }, "failed to send trade plan email"));
    }
  } else if (action === TradePlanAction.WATCH_ONLY) {
    await db.tradeCandidate.update({ where: { id: candidateId }, data: { status: TradeCandidateStatus.WATCH_ONLY } });
  } else {
    await db.tradeCandidate.update({ where: { id: candidateId }, data: { status: TradeCandidateStatus.REJECTED } });
  }

  logger.info({ candidateId, planId: plan.id, action, regime: analysis.marketRegime }, "trade plan generated");
}

/**
 * Deterministic backstop on the AI's proposed WAIT_FOR_ENTRY zone — nothing
 * previously bounded how deep a pullback it could demand. Confirmed live: a
 * 42% pullback requirement on a token that had already moved +217% in 5
 * minutes, with no cap, and the plan expired having never triggered.
 *
 * The fix is NOT a flat percentage below current price — the user correctly
 * called that out as vague ("just say buy at 10% from analysis"). Instead,
 * this prefers the token's own REAL observed support level
 * (technical.swingLowMcap, from our own snapshot history — see
 * marketAnalysis.ts) once there's enough history to trust it (MEDIUM/HIGH
 * confidence). A flat percentage is only the fallback for a brand-new
 * candidate with too little history to know a real support level yet, and a
 * wide sanity backstop always applies regardless of data source, in case a
 * brief noise wick got captured as the "low."
 */
function clampPullbackTarget(
  currentMcap: number | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
  technical: { swingLowMcap?: number; confidence: string }
): { min: number | undefined; max: number | undefined; clamped: boolean; reason?: string } {
  if (!currentMcap || min === null || min === undefined || max === null || max === undefined) {
    return { min: min ?? undefined, max: max ?? undefined, clamped: false };
  }

  const hasRealSupport =
    technical.swingLowMcap !== undefined &&
    (technical.confidence === "MEDIUM" || technical.confidence === "HIGH") &&
    technical.swingLowMcap < currentMcap;
  // A small buffer above the raw observed low — demanding the exact
  // historical bottom tick is its own kind of unrealistic.
  const supportBasedMax = hasRealSupport ? technical.swingLowMcap! * 1.03 : undefined;
  const percentBasedMax = currentMcap * (1 - tradingConfig.maxPullbackWaitPercent / 100);
  // Sanity backstop regardless of data source — real support data could
  // itself be a noise wick; never trust it past this, no matter what.
  const extremeFloorMax = currentMcap * (1 - tradingConfig.maxPullbackExtremeFloorPercent / 100);

  const shallowestAllowedMax = Math.max(supportBasedMax ?? percentBasedMax, extremeFloorMax);
  if (max >= shallowestAllowedMax) {
    return { min, max, clamped: false };
  }
  const zoneWidth = Math.max(0, max - min);
  return {
    min: shallowestAllowedMax - zoneWidth,
    max: shallowestAllowedMax,
    clamped: true,
    reason: hasRealSupport ? "anchored to observed support" : "percentage cap (insufficient support history)",
  };
}

function strategyTtlMs(strategy: { configuration: unknown }): number {
  const strategyConfig = strategy.configuration as { defaultEntryPlanTtlMinutes?: number };
  return (strategyConfig.defaultEntryPlanTtlMinutes ?? tradingConfig.defaultEntryPlanTtlMinutes) * 60_000;
}

function summarizeMarket(mcap: number | undefined, liquidity: number, price?: number): string {
  const parts = [
    mcap !== undefined ? `Market cap: $${Math.round(mcap).toLocaleString()}` : "Market cap: unknown",
    `Liquidity: $${Math.round(liquidity).toLocaleString()}`,
    price !== undefined ? `Price: $${price}` : undefined,
  ].filter(Boolean);
  return parts.join("\n");
}

async function recordDecision(
  candidateId: string,
  tradeId: string | null,
  decision: TradeDecision,
  stage: string,
  strategyVersionId: string,
  data: { market: unknown; project: unknown; technical: unknown; aiAnalysis?: unknown; reasons: unknown }
) {
  await db.tradeDecisionSnapshot.create({
    data: {
      candidateId,
      tradeId: tradeId ?? undefined,
      decision,
      stage,
      strategyVersionId,
      marketState: data.market as object,
      projectState: data.project as object,
      technicalState: data.technical as object,
      portfolioState: {},
      aiAnalysis: (data.aiAnalysis ?? undefined) as object | undefined,
      deterministicRules: { reasons: data.reasons } as object,
      finalReasons: data.reasons as object,
      modelName: data.aiAnalysis ? config.researchModel : undefined,
    },
  });
}

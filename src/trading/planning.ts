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
import { classifyTradeLane } from "./tradeLane";
import { canBypassUtilityGateForMomentum, evaluateUtilityOnlyGate, utilityGateInputFromRawResearch } from "./utilityGate";
import { TradeCandidateStatus, TradePlanAction, PendingEntryStatus, TradeDecision } from "../generated/prisma";
import { sendTradePlanEmail } from "./notifications";
import type { MarketPair } from "../dex/types";
import { formatWalletSignalsForPrompt, getWalletSignalsForToken } from "../walletTracking/signals";

const MOMENTUM_PLANNING_DATA_RETRY_MINUTES = 2;

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
  const technical = await computeTechnicalFeatures(candidate.tokenId, market.primaryPair, candidate.token.address);
  const walletSignals = await getWalletSignalsForToken(candidate.tokenId, candidate.token.address);

  const liquidityUsd = market.primaryPair?.liquidityUsd ?? 0;
  const hourlyTxns = (market.primaryPair?.buys1h ?? 0) + (market.primaryPair?.sells1h ?? 0);
  const freshEval = evaluateCandidate({
    qualityScore: candidate.qualityScore ?? 0,
    researchConfidence: candidate.researchConfidence ?? 0,
    contractScore: run.contractScore ?? 0,
    liquidityUsd,
    hourlyTxns,
    hardReject: run.hardReject,
  });
  const utilityGate = evaluateUtilityOnlyGate(
    utilityGateInputFromRawResearch(run.rawResearch, {
      utilityScore: run.utilityScore,
      credibilityScore: run.credibilityScore,
      websiteScore: run.websiteScore,
    })
  );
  const qualificationPath =
    candidate.qualificationPath === "NARRATIVE_META"
      ? "NARRATIVE_META"
      : freshEval.reasons[0]?.startsWith("momentum override:")
        ? "MOMENTUM_OVERRIDE"
        : (candidate.qualificationPath ?? "NORMAL");
  const utilityBypassedForMomentum = canBypassUtilityGateForMomentum({ qualificationPath, evaluation: freshEval });
  const tradeEligibilityEvaluation =
    utilityGate.passed || utilityBypassedForMomentum
      ? freshEval
      : { eligible: false, riskBucket: "REJECT" as const, reasons: utilityGate.reasons };
  const lane = classifyTradeLane({
    evaluation: tradeEligibilityEvaluation,
    qualificationPath,
    qualityScore: candidate.qualityScore,
    researchConfidence: candidate.researchConfidence,
    contractScore: run.contractScore,
    utilityScore: run.utilityScore,
    credibilityScore: run.credibilityScore,
    websiteScore: run.websiteScore,
    liquidityUsd,
  });

  const utilityBypassReason = utilityBypassedForMomentum
    ? [
        qualificationPath === "NARRATIVE_META"
          ? "narrative tactical override: utility/product gate bypassed for a tradeable trending-meta setup"
          : "momentum tactical override: utility/product gate bypassed for a tradeable high-activity setup",
      ]
    : [];

  if (!freshEval.eligible || (!utilityGate.passed && !utilityBypassedForMomentum)) {
    if (shouldRetryPlanningForTransientMomentumMarket({ qualificationPath, evaluation: freshEval, pair: market.primaryPair })) {
      const retryAfter = new Date(Date.now() + MOMENTUM_PLANNING_DATA_RETRY_MINUTES * 60_000);
      const reasons = [
        `planning retry: momentum candidate has missing/zero fresh market liquidity; retrying after ${retryAfter.toISOString()} instead of rejecting`,
        ...freshEval.reasons,
        ...utilityGate.reasons,
      ];
      await recordDecision(candidate.id, null, TradeDecision.WAIT, "planning_retry", strategy.id, {
        market: summarizeMarket(market.primaryPair?.marketCapUsd, liquidityUsd),
        project: { qualityScore: candidate.qualityScore, researchConfidence: candidate.researchConfidence, tradeLane: lane.tradeLane, laneReasons: lane.reasons },
        technical,
        walletSignals,
        reasons,
        deterministic: { retryAfter: retryAfter.toISOString(), retryMinutes: MOMENTUM_PLANNING_DATA_RETRY_MINUTES, qualificationPath, tradeLane: lane.tradeLane },
      });
      await db.tradeCandidate.update({ where: { id: candidateId }, data: { status: TradeCandidateStatus.QUALIFIED, qualificationPath, tradeLane: lane.tradeLane } });
      logger.warn({ candidateId, retryAfter: retryAfter.toISOString(), reasons: freshEval.reasons }, "momentum candidate planning deferred because fresh market data looked transiently unavailable");
      return;
    }

    await recordDecision(candidate.id, null, TradeDecision.SKIP, "planning", strategy.id, {
      market: summarizeMarket(market.primaryPair?.marketCapUsd, liquidityUsd),
      project: { qualityScore: candidate.qualityScore, researchConfidence: candidate.researchConfidence, tradeLane: lane.tradeLane, laneReasons: lane.reasons },
      technical,
      walletSignals,
      reasons: [...freshEval.reasons, ...utilityGate.reasons],
    });
    await db.tradeCandidate.update({ where: { id: candidateId }, data: { status: TradeCandidateStatus.REJECTED, qualificationPath, tradeLane: lane.tradeLane } });
    logger.info({ candidateId, reasons: [...freshEval.reasons, ...utilityGate.reasons] }, "candidate rejected at planning (eligibility/utility moved since qualification)");
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
        tradeLane: lane.tradeLane,
        laneReasons: lane.reasons,
        marketText: summarizeMarket(market.primaryPair?.marketCapUsd, liquidityUsd, market.primaryPair?.priceUsd),
        technicalText: formatTechnicalFeaturesForPrompt(technical),
        walletSignalsText: formatWalletSignalsForPrompt(walletSignals),
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

  let action = analysis.recommendedAction;
  let entryStyle = analysis.entryStyle;
  const currentMcap = market.primaryPair?.marketCapUsd;
  let clampedZone = clampPullbackTarget(currentMcap, analysis.targetEntryMcapMin, analysis.targetEntryMcapMax, technical);

  // The one deterministic UPGRADE in this codebase — everywhere else,
  // deterministic code only ever downgrades or rejects what the AI
  // recommends (§84). Confirmed live 2026-09-11: roost was in a confirmed
  // PARABOLIC regime (2,397% 1h change, 83-86% buy ratio) and the AI still
  // recommended WAIT_FOR_ENTRY, reasoning that data confidence was "very
  // low" — true, but only because the token was ~30s old, not because the
  // move's direction was actually in question. It ran 5-7x waiting for a
  // pullback that never came. User directive: when the move is this
  // unambiguous, don't wait on it. Narrow and gated on real two-sided
  // volume (not just a price change a single wash trade could produce) so
  // it only ever fires on exactly this pattern.
  const extremeMomentumOverride = action === TradePlanAction.WAIT_FOR_ENTRY && isExtremeMomentum(market.primaryPair);
  if (extremeMomentumOverride) {
    logger.warn(
      {
        candidateId: candidate.id,
        priceChange1h: market.primaryPair?.priceChange1h,
        buys1h: market.primaryPair?.buys1h,
        sells1h: market.primaryPair?.sells1h,
        aiReasoning: analysis.reasoning,
      },
      "deterministic extreme-momentum override: AI recommended WAIT_FOR_ENTRY but the move is unambiguous — forcing BUY_NOW"
    );
    action = TradePlanAction.BUY_NOW;
    entryStyle = "MARKET_ENTRY";
    // The AI's target zone was computed for a pullback below current price —
    // meaningless once we're forcing an immediate entry instead. Same ±10%
    // window BUY_NOW gets everywhere else (see the pendingEntry.create below).
    clampedZone = { min: (currentMcap ?? 0) * 0.9, max: (currentMcap ?? 0) * 1.1, clamped: false };
  }

  // User directive 2026-09-11, evidence: Stream's real price path on a
  // WAIT_FOR_ENTRY plan with a $64,000-$66,000 zone was 66,307 -> 60,012 ->
  // 57,554 -> 63,324 -> 68,687 -> 82,462 — DexScreener's own update cadence
  // on a token moving this fast meant no sampled price ever landed inside
  // that narrow 2K-wide window; it undershot well below the zone (a BETTER
  // price than planned) and rocketed back up through it without a snapshot
  // ever catching it, then breached doNotChaseAboveMcap before the entry was
  // next checked — a real 2x missed entirely. The zone's lower bound
  // rejected a price that was cheaper than intended, not one that was a bad
  // entry; invalidationMcap (with its own tolerance, see
  // INVALIDATION_TOLERANCE_PERCENT) is what should decide "too cheap to
  // still be a good entry," not this separate, much narrower floor. Widen
  // the floor down to the tolerance-adjusted invalidation level whenever
  // that's lower than the AI's own proposed minimum, so undershooting the
  // target on the way down is a better fill, not a miss.
  if (analysis.technicalInvalidationMcap != null && clampedZone.min !== undefined) {
    const invalidationFloor = analysis.technicalInvalidationMcap * (1 - tradingConfig.invalidationTolerancePercent / 100);
    clampedZone = { ...clampedZone, min: Math.min(clampedZone.min, invalidationFloor) };
  }

  const plan = await db.tradePlan.create({
    data: {
      candidateId: candidate.id,
      strategyVersionId: strategy.id,
      action,
      entryStyle,
      currentMarketCap: currentMcap,
      targetEntryMcapMin: clampedZone.min,
      targetEntryMcapMax: clampedZone.max,
      doNotChaseAboveMcap: analysis.doNotChaseAboveMcap,
      invalidationMcap: analysis.technicalInvalidationMcap,
      riskScore: analysis.riskScore,
      confidence: analysis.confidence,
      planData: { analysis, freshEval, tradeLane: lane.tradeLane, laneReasons: lane.reasons, utilityGate: utilityGate.reasons, utilityBypassedForMomentum, walletSignals, liquidityUsd, pullbackClamped: clampedZone.clamped, extremeMomentumOverride } as unknown as object,
      expiresAt: new Date(Date.now() + strategyTtlMs(strategy)),
    },
  });
  await db.tradeCandidate.update({ where: { id: candidateId }, data: { qualificationPath, tradeLane: lane.tradeLane } });

  await recordDecision(
    candidate.id,
    null,
    action === TradePlanAction.BUY_NOW || action === TradePlanAction.WAIT_FOR_ENTRY ? TradeDecision.WAIT : TradeDecision.SKIP,
    "planning",
    strategy.id,
    {
      market: summarizeMarket(market.primaryPair?.marketCapUsd, liquidityUsd),
      project: { qualityScore: candidate.qualityScore, researchConfidence: candidate.researchConfidence, tradeLane: lane.tradeLane, laneReasons: lane.reasons },
      technical,
      aiAnalysis: analysis,
      walletSignals,
      reasons: [...freshEval.reasons, ...utilityGate.reasons, ...utilityBypassReason, ...lane.reasons, analysis.reasoning],
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
      // Fire-and-forget, not awaited — see the matching note in
      // entryMonitor.ts's openTrade: a slow SMTP send must never be able to
      // hold up the planning loop moving on to the next candidate.
      void sendTradePlanEmail({
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
 * Gates planCandidate's extreme-momentum override (see above). Requires real,
 * already-observed two-sided volume — config.momentumOverrideMinHourlyTxns,
 * the same floor classify.ts/research.ts/riskEngine.ts already use for their
 * own momentum overrides — so a single wash-traded print can't trigger this
 * on its own; both the price move AND the buy pressure behind it have to be
 * extreme and real.
 */
function isExtremeMomentum(pair: MarketPair | undefined): boolean {
  if (!pair) return false;
  const hourlyTxns = (pair.buys1h ?? 0) + (pair.sells1h ?? 0);
  if (hourlyTxns < config.momentumOverrideMinHourlyTxns) return false;
  if ((pair.priceChange1h ?? 0) < tradingConfig.extremeMomentumOverride1hPriceChangePercent) return false;
  const buyRatio1h = (pair.buys1h ?? 0) / Math.max(hourlyTxns, 1);
  return buyRatio1h >= tradingConfig.extremeMomentumOverrideMinBuyRatio1h;
}

export function shouldRetryPlanningForTransientMomentumMarket(input: {
  qualificationPath: string | null | undefined;
  evaluation: { eligible: boolean; reasons: string[] };
  pair: Pick<MarketPair, "liquidityUsd"> | undefined;
}): boolean {
  if (input.evaluation.eligible) return false;
  if (input.qualificationPath !== "MOMENTUM_OVERRIDE") return false;

  const liquidity = input.pair?.liquidityUsd;
  const freshMarketUnavailable = !input.pair || liquidity === undefined || liquidity <= 0;
  if (!freshMarketUnavailable) return false;

  return input.evaluation.reasons.some((reason) => reason.startsWith("liquidityUsd "));
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
  technical: { swingLowMcap?: number; confidence: string; supportResistanceSource?: string }
): { min: number | undefined; max: number | undefined; clamped: boolean; reason?: string } {
  if (!currentMcap || min === null || min === undefined || max === null || max === undefined) {
    return { min: min ?? undefined, max: max ?? undefined, clamped: false };
  }

  const hasRealSupport =
    technical.swingLowMcap !== undefined &&
    technical.swingLowMcap < currentMcap &&
    (technical.supportResistanceSource === "ONCHAIN_HISTORY" || technical.confidence === "MEDIUM" || technical.confidence === "HIGH");
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
  data: { market: unknown; project: unknown; technical: unknown; aiAnalysis?: unknown; walletSignals?: unknown; reasons: unknown; deterministic?: unknown }
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
      deterministicRules: { reasons: data.reasons, walletSignals: data.walletSignals, ...((data.deterministic as object | undefined) ?? {}) } as object,
      finalReasons: data.reasons as object,
      modelName: data.aiAnalysis ? config.researchModel : undefined,
    },
  });
}

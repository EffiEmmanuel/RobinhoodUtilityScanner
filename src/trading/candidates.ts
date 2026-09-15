import { db } from "../db";
import { logger } from "../logger";
import { TokenStatus, TradeCandidateStatus, TradeDecision } from "../generated/prisma";
import { evaluateCandidate } from "./riskEngine";
import { getActiveStrategyVersion } from "./strategy";
import { classifyTradeLane } from "./tradeLane";
import { canBypassUtilityGateForMomentum, evaluateUtilityOnlyGate, utilityGateInputFromRawResearch } from "./utilityGate";

const MOMENTUM_UTILITY_REJECT_RECOVERY_LOOKBACK_MS = 12 * 60 * 60 * 1000;
const MOMENTUM_UTILITY_REJECT_RECOVERY_LIMIT = 50;

/**
 * A token becomes a trade candidate once it clears the base research
 * pipeline's own bar (ALERTED or WATCHLISTED — never a REJECTED token; §9's
 * hard rule). Every such token gets a TradeCandidate row — even ones the
 * trading-specific gates (MIN_TRADE_QUALITY_SCORE etc.) immediately reject —
 * because §61/§66 want every candidate decision in the learning dataset, not
 * only the ones that went on to trade.
 *
 * Normally that's a ONE-shot: `tradeCandidates: none` excludes a token
 * forever once it has any candidate at all, which is deliberate — this loop
 * runs continuously, and re-litigating the same stale research/score every
 * tick for every settled token would spend real AI/X API budget on nothing
 * (this is exactly why the pipeline was built one-shot). The exception is
 * manualReevaluationRequestedAt (user directive 2026-09-13, manualSubmit.ts):
 * a human explicitly resubmitting a CA is a deliberate, one-off act, not an
 * automated sweep, so it's allowed to produce exactly one more candidate —
 * gated on the flag being newer than the token's existing latest candidate,
 * so it can never fire twice for the same resubmission. Cleared back to null
 * right after, so nothing here loops on its own.
 */
export async function generateTradeCandidates(): Promise<number> {
  const eligibleTokens = await db.token.findMany({
    where: {
      status: { in: [TokenStatus.ALERTED, TokenStatus.WATCHLISTED] },
      OR: [{ tradeCandidates: { none: {} } }, { manualReevaluationRequestedAt: { not: null } }],
    },
    include: {
      researchRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      tradeCandidates: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  let created = 0;
  for (const token of eligibleTokens) {
    const latestCandidate = token.tradeCandidates[0];
    const reevaluationRequested = token.manualReevaluationRequestedAt !== null;
    if (latestCandidate && (!reevaluationRequested || token.manualReevaluationRequestedAt! <= latestCandidate.createdAt)) {
      continue; // has a candidate already and no (new-enough) manual re-evaluation request
    }

    const run = token.researchRuns[0];
    if (!run || run.finalScore === null || run.confidence === null) continue;

    const candidate = await db.tradeCandidate.create({
      data: {
        tokenId: token.id,
        researchRunId: run.id,
        qualityScore: run.finalScore,
        researchConfidence: run.confidence,
        marketRiskScore: run.liquidityScore !== null ? 100 - run.liquidityScore : null,
        status: TradeCandidateStatus.QUALIFIED,
      },
    });
    created++;

    if (reevaluationRequested) {
      // One-shot per resubmission — clear it now so this token isn't picked
      // up again next tick without another deliberate manual resubmission.
      await db.token.update({ where: { id: token.id }, data: { manualReevaluationRequestedAt: null } });
    }

    const primaryPair = (
      run.rawResearch as { market?: { primaryPair?: { liquidityUsd?: number; buys1h?: number; sells1h?: number } } } | null
    )?.market?.primaryPair;

    const evaluation = evaluateCandidate({
      qualityScore: run.finalScore,
      researchConfidence: run.confidence,
      contractScore: run.contractScore ?? 0,
      liquidityUsd: primaryPair?.liquidityUsd ?? 0,
      hourlyTxns: (primaryPair?.buys1h ?? 0) + (primaryPair?.sells1h ?? 0),
      hardReject: run.hardReject,
    });
    const utilityGate = evaluateUtilityOnlyGate(
      utilityGateInputFromRawResearch(run.rawResearch, {
        utilityScore: run.utilityScore,
        credibilityScore: run.credibilityScore,
        websiteScore: run.websiteScore,
      })
    );
    const qualificationPath = evaluation.reasons[0]?.startsWith("momentum override:") ? "MOMENTUM_OVERRIDE" : "NORMAL";
    const utilityBypassedForMomentum = canBypassUtilityGateForMomentum({ qualificationPath, evaluation });
    const tradeEligibilityEvaluation =
      utilityGate.passed || utilityBypassedForMomentum
        ? evaluation
        : { eligible: false, riskBucket: "REJECT" as const, reasons: utilityGate.reasons };
    const lane = classifyTradeLane({
      evaluation: tradeEligibilityEvaluation,
      qualificationPath,
      qualityScore: run.finalScore,
      researchConfidence: run.confidence,
      contractScore: run.contractScore,
      utilityScore: run.utilityScore,
      credibilityScore: run.credibilityScore,
      websiteScore: run.websiteScore,
      liquidityUsd: primaryPair?.liquidityUsd ?? 0,
    });

    const strategy = await getActiveStrategyVersion();
    const bypassedUtilityReasons = utilityBypassedForMomentum
      ? [
          "momentum tactical override: utility/product gate bypassed for a tradeable high-activity setup",
        ]
      : utilityGate.reasons;
    const finalReasons = [
      ...evaluation.reasons,
      ...bypassedUtilityReasons,
      ...lane.reasons,
    ];
    await db.tradeDecisionSnapshot.create({
      data: {
        candidateId: candidate.id,
        decision: evaluation.eligible && (utilityGate.passed || utilityBypassedForMomentum) ? TradeDecision.WAIT : TradeDecision.SKIP,
        stage: "candidate_eligibility",
        strategyVersionId: strategy.id,
        marketState: {},
        projectState: { qualityScore: run.finalScore, researchConfidence: run.confidence, contractScore: run.contractScore, utilityGate: utilityGate.reasons },
        technicalState: {},
        portfolioState: {},
        deterministicRules: { riskBucket: evaluation.riskBucket, qualificationPath, tradeLane: lane.tradeLane, laneReasons: lane.reasons, utilityGate: utilityGate.reasons, utilityBypassedForMomentum, reasons: evaluation.reasons },
        finalReasons,
      },
    });

    if (!evaluation.eligible || (!utilityGate.passed && !utilityBypassedForMomentum)) {
      await db.tradeCandidate.update({ where: { id: candidate.id }, data: { status: TradeCandidateStatus.REJECTED, qualificationPath, tradeLane: lane.tradeLane } });
    } else {
      // "Learn which entry pathway actually pays" (user directive
      // 2026-09-11) — tag HOW this candidate cleared the gate so
      // learning.ts can later break outcome rates down by path instead of
      // only by raw quality/confidence numbers.
      await db.tradeCandidate.update({ where: { id: candidate.id }, data: { qualificationPath, tradeLane: lane.tradeLane } });
    }

    logger.info(
      { tokenId: token.id, candidateId: candidate.id, eligible: evaluation.eligible, riskBucket: evaluation.riskBucket, qualificationPath, tradeLane: lane.tradeLane },
      "trade candidate created"
    );
  }
  return created;
}

export async function recoverRecentMomentumUtilityRejects(): Promise<number> {
  const since = new Date(Date.now() - MOMENTUM_UTILITY_REJECT_RECOVERY_LOOKBACK_MS);
  const candidates = await db.tradeCandidate.findMany({
    where: {
      status: TradeCandidateStatus.REJECTED,
      qualificationPath: "MOMENTUM_OVERRIDE",
      createdAt: { gte: since },
      plans: { none: {} },
    },
    orderBy: { createdAt: "desc" },
    take: MOMENTUM_UTILITY_REJECT_RECOVERY_LIMIT,
    select: {
      id: true,
      decisions: {
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          decision: true,
          stage: true,
          deterministicRules: true,
          finalReasons: true,
        },
      },
    },
  });

  const recoverableIds = candidates
    .filter((candidate) => candidate.decisions.some(wasMomentumUtilityBlockedDecision))
    .map((candidate) => candidate.id);

  if (recoverableIds.length === 0) return 0;

  const result = await db.tradeCandidate.updateMany({
    where: { id: { in: recoverableIds }, status: TradeCandidateStatus.REJECTED },
    data: { status: TradeCandidateStatus.QUALIFIED },
  });

  if (result.count > 0) {
    logger.warn(
      { count: result.count, lookbackHours: MOMENTUM_UTILITY_REJECT_RECOVERY_LOOKBACK_MS / 3_600_000 },
      "requeued recent momentum candidates that were blocked by the old utility-only gate"
    );
  }
  return result.count;
}

function wasMomentumUtilityBlockedDecision(decision: {
  decision: TradeDecision;
  stage: string;
  deterministicRules: unknown;
  finalReasons: unknown;
}): boolean {
  if (decision.decision !== TradeDecision.SKIP) return false;
  if (decision.stage !== "candidate_eligibility" && decision.stage !== "planning") return false;

  const text = JSON.stringify({
    deterministicRules: decision.deterministicRules,
    finalReasons: decision.finalReasons,
  }).toLowerCase();

  return (
    text.includes("momentum override:") &&
    !text.includes("momentum tactical override") &&
    (text.includes("utility class is meme") ||
      text.includes("utility class is unknown") ||
      text.includes("research did not verify a real product/app exists") ||
      text.includes("utilityscore") ||
      text.includes("productpredatestoken"))
  );
}

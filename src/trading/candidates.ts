import { db } from "../db";
import { logger } from "../logger";
import { TokenStatus, TradeCandidateStatus, TradeDecision } from "../generated/prisma";
import { evaluateCandidate } from "./riskEngine";
import { getActiveStrategyVersion } from "./strategy";

/**
 * A token becomes a trade candidate once (and only once) it clears the base
 * research pipeline's own bar (ALERTED or WATCHLISTED — never a REJECTED
 * token; §9's hard rule). Every such token gets a TradeCandidate row — even
 * ones the trading-specific gates (MIN_TRADE_QUALITY_SCORE etc.) immediately
 * reject — because §61/§66 want every candidate decision in the learning
 * dataset, not only the ones that went on to trade.
 */
export async function generateTradeCandidates(): Promise<number> {
  const eligibleTokens = await db.token.findMany({
    where: {
      status: { in: [TokenStatus.ALERTED, TokenStatus.WATCHLISTED] },
      tradeCandidates: { none: {} },
    },
    include: { researchRuns: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  let created = 0;
  for (const token of eligibleTokens) {
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

    const strategy = await getActiveStrategyVersion();
    await db.tradeDecisionSnapshot.create({
      data: {
        candidateId: candidate.id,
        decision: evaluation.eligible ? TradeDecision.WAIT : TradeDecision.SKIP,
        stage: "candidate_eligibility",
        strategyVersionId: strategy.id,
        marketState: {},
        projectState: { qualityScore: run.finalScore, researchConfidence: run.confidence, contractScore: run.contractScore },
        technicalState: {},
        portfolioState: {},
        deterministicRules: { riskBucket: evaluation.riskBucket, reasons: evaluation.reasons },
        finalReasons: evaluation.reasons,
      },
    });

    if (!evaluation.eligible) {
      await db.tradeCandidate.update({ where: { id: candidate.id }, data: { status: TradeCandidateStatus.REJECTED } });
    }

    logger.info(
      { tokenId: token.id, candidateId: candidate.id, eligible: evaluation.eligible, riskBucket: evaluation.riskBucket },
      "trade candidate created"
    );
  }
  return created;
}

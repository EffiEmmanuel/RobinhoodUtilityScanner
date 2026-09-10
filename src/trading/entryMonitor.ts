import { db } from "../db";
import { logger } from "../logger";
import {
  PendingEntryStatus,
  TradeCandidateStatus,
  TradeStatus,
  TradeDecision,
  ExecutionType,
  ExecutionStatus,
  LedgerEntryType,
  TradingMode,
} from "../generated/prisma";
import type { PendingEntry } from "../generated/prisma";
import type { MarketPair } from "../dex/types";
import { pollCandidateMarket } from "./marketAnalysis";
import { validateEntry, calculatePositionSize, type RiskBucket } from "./riskEngine";
import { checkCircuitBreakers, getPortfolioState, recordLedgerEntry } from "./portfolio";
import { getBuyEstimate, executeBuyFill, isSellable, type FillResult } from "./executionFacade";
import { getActiveStrategyVersion, type SizingRules } from "./strategy";
import { tradingConfig } from "./config";
import { sendTradeEntryEmail } from "./notifications";

async function claim(id: string, from: PendingEntryStatus, to: PendingEntryStatus): Promise<boolean> {
  const result = await db.pendingEntry.updateMany({ where: { id, status: from }, data: { status: to } });
  return result.count === 1;
}

/** Startup recovery: a crash mid-revalidation leaves entries stuck forever otherwise. */
export async function recoverStuckPendingEntries(): Promise<void> {
  const result = await db.pendingEntry.updateMany({
    where: { status: PendingEntryStatus.REVALIDATING },
    data: { status: PendingEntryStatus.ACTIVE },
  });
  if (result.count > 0) logger.info({ count: result.count }, "recovered pending entries stuck from a previous run");
}

/** Processes one ACTIVE pending entry. Returns true if it did any work. */
export async function processPendingEntries(): Promise<boolean> {
  const candidate = await db.pendingEntry.findFirst({
    where: { status: PendingEntryStatus.ACTIVE },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return false;
  if (!(await claim(candidate.id, PendingEntryStatus.ACTIVE, PendingEntryStatus.REVALIDATING))) return true; // lost the race, still counts as "did work" this tick

  try {
    await evaluateOnePendingEntry(candidate);
  } catch (err) {
    logger.error({ pendingEntryId: candidate.id, err: String(err) }, "pending entry evaluation failed");
    await db.pendingEntry.update({ where: { id: candidate.id }, data: { status: PendingEntryStatus.ACTIVE } });
  }
  return true;
}

async function evaluateOnePendingEntry(entry: PendingEntry): Promise<void> {
  const plan = await db.tradePlan.findUniqueOrThrow({
    where: { id: entry.tradePlanId },
    include: { candidate: { include: { token: true } } },
  });
  const candidate = plan.candidate;

  if (entry.expiresAt && entry.expiresAt < new Date()) {
    // §15/§8: if price ran away past the ceiling and never pulled back, this
    // was a MISSED entry, not merely an EXPIRED one that never got close.
    const market = await pollCandidateMarket(candidate.tokenId, candidate.token.chain, candidate.token.address);
    const mcap = market.primaryPair?.marketCapUsd;
    const missed = plan.doNotChaseAboveMcap !== null && mcap !== undefined && mcap > plan.doNotChaseAboveMcap;
    await db.pendingEntry.update({ where: { id: entry.id }, data: { status: PendingEntryStatus.EXPIRED, lastCheckedAt: new Date() } });
    await db.tradeCandidate.update({
      where: { id: candidate.id },
      data: { status: missed ? TradeCandidateStatus.MISSED : TradeCandidateStatus.EXPIRED },
    });
    logger.info({ pendingEntryId: entry.id, candidateId: candidate.id, missed }, "pending entry expired");
    return;
  }

  const market = await pollCandidateMarket(candidate.tokenId, candidate.token.chain, candidate.token.address);
  const pair = market.primaryPair;
  const mcap = pair?.marketCapUsd;

  const inZone =
    mcap !== undefined &&
    entry.targetMcapMin !== null &&
    entry.targetMcapMax !== null &&
    mcap >= entry.targetMcapMin &&
    mcap <= entry.targetMcapMax;

  if (!inZone) {
    await db.pendingEntry.update({ where: { id: entry.id }, data: { status: PendingEntryStatus.ACTIVE, lastCheckedAt: new Date() } });
    return;
  }

  await db.pendingEntry.update({ where: { id: entry.id }, data: { triggeredAt: new Date(), lastCheckedAt: new Date() } });
  logger.info({ pendingEntryId: entry.id, candidateId: candidate.id, mcap }, "pending entry triggered — revalidating");

  const circuitBreakers = await checkCircuitBreakers();
  const portfolio = await getPortfolioState();

  if (!pair) {
    await rejectEntry(entry, candidate.id, ["pool disappeared — no market data available at trigger time"]);
    return;
  }

  const planData = plan.planData as { freshEval?: { riskBucket: RiskBucket }; liquidityUsd?: number };
  const riskBucket: RiskBucket = planData.freshEval?.riskBucket ?? "MEDIUM";
  const strategy = await getActiveStrategyVersion();
  const sizing = calculatePositionSize({
    portfolio,
    sizingRules: strategy.sizingRules as unknown as SizingRules,
    qualityScore: candidate.qualityScore ?? 0,
    confidence: plan.confidence ?? 0,
    riskBucket,
    liquidityUsd: pair.liquidityUsd ?? 0,
  });

  if (!sizing.approved) {
    await rejectEntry(entry, candidate.id, sizing.reasons);
    return;
  }

  const quote = await getBuyEstimate(candidate.token.address, sizing.positionSizeUsd, pair);
  const entryResult = validateEntry({
    circuitBreakersPaused: circuitBreakers.paused,
    circuitBreakerReasons: circuitBreakers.reasons,
    currentLiquidityUsd: pair.liquidityUsd ?? 0,
    liquidityAtPlanUsd: planData.liquidityUsd ?? pair.liquidityUsd ?? 0,
    sellQuoteAvailable: await isSellable(candidate.token.address, pair, quote.tokenAmount),
    buySellRatio1h: pair.buys1h !== undefined || pair.sells1h !== undefined
      ? (pair.buys1h ?? 0) / Math.max((pair.buys1h ?? 0) + (pair.sells1h ?? 0), 1)
      : undefined,
    priceChange5mPercent: pair.priceChange5m,
    estimatedSlippageBps: quote.estimatedSlippageBps,
    estimatedPriceImpactPercent: quote.estimatedPriceImpactPercent,
    positionSizeUsd: sizing.positionSizeUsd,
    availableToDeployUsd: portfolio.availableToDeployUsd,
  });

  if (entryResult.decision === "DEFER") {
    await db.pendingEntry.update({ where: { id: entry.id }, data: { status: PendingEntryStatus.ACTIVE } });
    logger.info({ pendingEntryId: entry.id, reasons: entryResult.reasons }, "entry deferred (will retry)");
    return;
  }
  if (entryResult.decision === "REJECTED") {
    await rejectEntry(entry, candidate.id, entryResult.reasons);
    return;
  }

  await openTrade({
    candidateId: candidate.id,
    tradePlanId: plan.id,
    strategyVersionId: plan.strategyVersionId,
    tokenId: candidate.tokenId,
    tokenAddress: candidate.token.address,
    positionSizeUsd: sizing.positionSizeUsd,
    plannedEntryMcap: plan.currentMarketCap ?? undefined,
    actualEntryMcap: mcap,
    pair,
    reasons: entryResult.reasons,
  });
  await db.pendingEntry.update({ where: { id: entry.id }, data: { status: PendingEntryStatus.APPROVED } });
  await db.tradeCandidate.update({ where: { id: candidate.id }, data: { status: TradeCandidateStatus.TRADED } });
}

async function rejectEntry(entry: PendingEntry, candidateId: string, reasons: string[]): Promise<void> {
  await db.pendingEntry.update({ where: { id: entry.id }, data: { status: PendingEntryStatus.REJECTED } });
  await db.tradeCandidate.update({ where: { id: candidateId }, data: { status: TradeCandidateStatus.REJECTED } });
  logger.info({ pendingEntryId: entry.id, candidateId, reasons }, "entry rejected at revalidation");
}

async function openTrade(input: {
  candidateId: string;
  tradePlanId: string;
  strategyVersionId: string;
  tokenId: string;
  tokenAddress: string;
  positionSizeUsd: number;
  plannedEntryMcap: number | undefined;
  actualEntryMcap: number | undefined;
  pair: MarketPair;
  reasons: string[];
}): Promise<void> {
  const mode: TradingMode = tradingConfig.mode === "LIVE" ? TradingMode.LIVE : tradingConfig.mode === "SHADOW" ? TradingMode.SHADOW : TradingMode.PAPER;

  // The actual fill happens here — a real on-chain swap in LIVE mode, a
  // simulated one otherwise. Nothing is persisted as a Trade until this
  // resolves, so a failed live swap never creates a phantom open position.
  let fill: FillResult;
  try {
    fill = await executeBuyFill(input.tokenAddress, input.positionSizeUsd, input.pair);
  } catch (err) {
    logger.error({ tokenAddress: input.tokenAddress, err: String(err) }, "buy execution failed — candidate reverted to REJECTED, no trade created");
    await db.tradeCandidate.update({ where: { id: input.candidateId }, data: { status: TradeCandidateStatus.REJECTED } });
    throw err;
  }

  const trade = await db.trade.create({
    data: {
      tokenId: input.tokenId,
      candidateId: input.candidateId,
      tradePlanId: input.tradePlanId,
      strategyVersionId: input.strategyVersionId,
      mode,
      status: TradeStatus.OPEN,
      positionSizeUsd: input.positionSizeUsd,
      entryTokenAmount: fill.tokenAmount,
      plannedEntryMcap: input.plannedEntryMcap,
      actualEntryMcap: input.actualEntryMcap,
      entryPriceUsd: fill.priceUsd,
      entryLiquidityUsd: input.pair.liquidityUsd,
      openedAt: new Date(),
    },
  });

  await db.tradeExecution.create({
    data: {
      tradeId: trade.id,
      type: ExecutionType.BUY,
      status: ExecutionStatus.CONFIRMED,
      txHash: fill.txHash,
      tokenAmount: fill.tokenAmount,
      usdValue: input.positionSizeUsd,
      actualPrice: fill.priceUsd,
      slippagePercent: fill.estimatedSlippageBps / 100,
      priceImpactPercent: fill.estimatedPriceImpactPercent,
      gasCostUsd: fill.gasCostUsd,
      provider: fill.provider,
      submittedAt: new Date(),
      confirmedAt: new Date(),
    },
  });

  await recordLedgerEntry({ type: LedgerEntryType.BUY, tradeId: trade.id, amountUsd: -input.positionSizeUsd, notes: `${fill.provider} buy${fill.txHash ? ` (${fill.txHash})` : ""}` });
  await recordLedgerEntry({ type: LedgerEntryType.GAS, tradeId: trade.id, amountUsd: -fill.gasCostUsd, notes: fill.provider === "live" ? "real gas" : "simulated gas" });

  await db.tradeDecisionSnapshot.create({
    data: {
      candidateId: input.candidateId,
      tradeId: trade.id,
      decision: TradeDecision.BUY,
      stage: "entry_revalidation",
      strategyVersionId: input.strategyVersionId,
      marketState: { actualEntryMcap: input.actualEntryMcap },
      projectState: {},
      technicalState: {},
      portfolioState: {},
      deterministicRules: { reasons: input.reasons },
      finalReasons: input.reasons,
    },
  });

  const token = await db.token.findUnique({ where: { id: input.tokenId } });
  await sendTradeEntryEmail({ token, trade, quote: fill }).catch((err) =>
    logger.error({ tradeId: trade.id, err: String(err) }, "failed to send trade entry email")
  );

  logger.info({ tradeId: trade.id, positionSizeUsd: input.positionSizeUsd, mode, provider: fill.provider, txHash: fill.txHash }, "trade opened");
}

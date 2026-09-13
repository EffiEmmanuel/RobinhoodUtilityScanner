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
  TradePlanAction,
} from "../generated/prisma";
import type { PendingEntry } from "../generated/prisma";
import type { MarketPair } from "../dex/types";
import { pollCandidateMarket, getRecentMcapRange, getRecentMcapTicks } from "./marketAnalysis";
import { validateEntry, calculatePositionSize, type RiskBucket } from "./riskEngine";
import { normalizeTradeLane, type TradeLane } from "./tradeLane";
import { checkCircuitBreakers, getPortfolioState, recordLedgerEntry } from "./portfolio";
import { getBuyEstimate, executeBuyFill, isSellable, canWalletTransferToken, type FillResult } from "./executionFacade";
import { getActiveStrategyVersion, type SizingRules } from "./strategy";
import { tradingConfig } from "./config";
import { sendTradeEntryEmail, sendTradeClosedEmail } from "./notifications";
import { planCandidate } from "./planning";
import { recordBuyFailure, recordBuySuccess } from "./executionAlerts";
import {
  estimateTokenAgeMinutes,
  evaluateChaseGuard,
  evaluateHighConvictionSetup,
  evaluateQuoteAgreement,
  evaluateRealDemand,
  hasPriceStabilized,
  type ConvictionResult,
} from "./conservativeMode";
import { getHolderSnapshot, evaluateHolderConcentration } from "./holderConcentration";
import { getPublicClient } from "./live/wallet";

async function claim(id: string, from: PendingEntryStatus, to: PendingEntryStatus): Promise<boolean> {
  // Also stamps lastCheckedAt at claim time (not just on completion) so a
  // row that never makes it back out of REVALIDATING still carries a
  // reliable "since when" timestamp — see recoverStalledRevalidatingEntries,
  // which has no other way to tell a healthy in-flight claim from a
  // genuinely stuck one (PendingEntry has no updatedAt column).
  const result = await db.pendingEntry.updateMany({ where: { id, status: from }, data: { status: to, lastCheckedAt: new Date() } });
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

// Confirmed live 2026-09-11 (reported by a peer session working the same
// deployment): SCHIFFY and QUOTIENT both got claimed into REVALIDATING and
// stayed there 15-18+ minutes — well past PENDING_ENTRY_EVALUATION_TIMEOUT_MS
// below — invisible to every ACTIVE-status query in this file, i.e.
// permanently stranded until the next process restart's
// recoverStuckPendingEntries() above. The timeout wrapper only protects the
// *evaluation*; if the recovery write in its own catch block (or the
// original hang) outlives a restart-free window, nothing else ever retries
// releasing that specific row. This is the same recovery, just run
// periodically during normal operation instead of only at boot, and gated on
// age (via the claim-time lastCheckedAt stamp above) so it can never yank a
// row that's merely mid-flight within a normal evaluation.
const STUCK_REVALIDATING_THRESHOLD_MS = 5 * 60_000;

export async function recoverStalledRevalidatingEntries(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_REVALIDATING_THRESHOLD_MS);
  const result = await db.pendingEntry.updateMany({
    where: { status: PendingEntryStatus.REVALIDATING, lastCheckedAt: { lt: cutoff } },
    data: { status: PendingEntryStatus.ACTIVE },
  });
  if (result.count > 0) {
    logger.warn({ count: result.count }, "recovered pending entries stalled in REVALIDATING past the evaluation timeout — its own recovery must have also failed");
  }
}

// Confirmed live 2026-09-11: with 17-37 ACTIVE pending entries queued at
// once (candidate generation running continuously while planning/entry
// checks were still one-row-per-tick), a token created at the back of the
// queue wasn't reaching its first-ever check for 15-20+ minutes — long
// enough for a fast mover to blow straight through its target zone (and
// even its do-not-chase ceiling) without ever being looked at. SEXFLY (a
// BUY_NOW plan, meaning it was already priced in-zone the instant it was
// created) sat unchecked long enough to go on to 2x with zero evaluation
// ever having run. The zone-check itself is cheap and has no cross-token
// dependency (independent DexScreener polls, independent AI replan calls
// when stale) — evaluating a batch of the oldest N ACTIVE rows concurrently
// instead of one-at-a-time directly fixes the throughput/queue-size
// mismatch that caused this, without changing what any single evaluation
// does. Only the final capital-committing step (openTrade) is serialized
// below via a mutex — see attemptEntryExecution — so concurrent triggers
// can't jointly race past maxOpenPositions/available capital.
const PENDING_ENTRY_BATCH_SIZE = 8;

// User directive 2026-09-11, proactive follow-up to the batch-concurrency
// fix above: raw FIFO throughput helps, but under real load the entries that
// matter most (already-triggered-and-deferred, or BUY_NOW — meant to fire
// close to immediately) shouldn't have to wait behind a pile of ordinary
// WAIT_FOR_ENTRY rows just because those happen to be older. Pulling a wider
// pool than the batch and sorting it by urgency (cheap — no extra network
// call, just the plan's own action + whether it already triggered once)
// means a time-sensitive entry gets picked first even when the backlog is
// large, instead of only benefiting once the backlog has fully drained.
// Bounded rather than unbounded so this stays a cheap, single indexed query
// no matter how large the backlog ever grows.
const CANDIDATE_POOL_SIZE = 40;

function entryPriorityRank(entry: { triggeredAt: Date | null; tradePlan: { action: TradePlanAction } }): number {
  if (entry.triggeredAt) return 0; // already in-zone once and deferred (e.g. circuit breaker) — most urgent to recheck
  if (entry.tradePlan.action === TradePlanAction.BUY_NOW) return 1; // meant to fire close to immediately
  return 2; // ordinary WAIT_FOR_ENTRY — FIFO within this bucket (Array.prototype.sort is stable)
}

export type PendingEntryTickResult = "idle" | "replanned" | "checked";

// Confirmed live 2026-09-11: a pending entry (SCHIFFY) got claimed
// (ACTIVE -> REVALIDATING) and evaluateOnePendingEntry never returned and
// never threw — no timeout anywhere in its call chain (market fetch, AI
// replan call, RPC quote) actually unbounded despite each individually
// looking bounded. Since this whole function is single-threaded per tick
// (processPendingEntries always claims exactly one row), that one hang
// blocked EVERY pending entry behind it — including live BUY_NOW plans —
// for 15+ minutes straight with the row stuck in REVALIDATING, invisible to
// the ACTIVE query the rest of this file uses to find work. This doesn't
// cancel the underlying hang (nothing here threads an AbortController into
// whatever's actually stuck), but it guarantees the loop — and the row —
// aren't held hostage by it indefinitely: the row gets released back to
// ACTIVE and processing moves on, same recovery path as any other error.
const PENDING_ENTRY_EVALUATION_TIMEOUT_MS = 90_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Claims and evaluates up to PENDING_ENTRY_BATCH_SIZE of the highest-priority
 * ACTIVE pending entries concurrently — see the comments on that constant,
 * CANDIDATE_POOL_SIZE, and entryPriorityRank above. A freshly-replanned entry
 * is a brand-new row (createdAt = now) with no triggeredAt yet, so within its
 * priority bucket it still sorts to the back and won't be re-picked until
 * everything ahead of it has had a turn — the old single-item "replanned ->
 * cooldown" throttle is no longer needed for that reason. One item's
 * timeout/error is isolated via allSettled and can't block the rest of the
 * batch.
 */
export async function processPendingEntries(): Promise<PendingEntryTickResult> {
  const pool = await db.pendingEntry.findMany({
    where: { status: PendingEntryStatus.ACTIVE },
    orderBy: { createdAt: "asc" },
    take: CANDIDATE_POOL_SIZE,
    include: { tradePlan: { select: { action: true } } },
  });
  if (pool.length === 0) return "idle";
  if (pool.length === CANDIDATE_POOL_SIZE) {
    logger.warn({ poolSize: CANDIDATE_POOL_SIZE }, "pending-entry queue backlog at or above the priority-sort pool size — throughput may still be falling behind candidate generation");
  }

  const batch = pool
    .slice()
    .sort((a, b) => entryPriorityRank(a) - entryPriorityRank(b))
    .slice(0, PENDING_ENTRY_BATCH_SIZE);

  const results = await Promise.allSettled(batch.map((candidate) => processOnePendingEntry(candidate)));
  const anyReplanned = results.some((r) => r.status === "fulfilled" && r.value === "replanned");
  return anyReplanned ? "replanned" : "checked";
}

async function processOnePendingEntry(candidate: PendingEntry): Promise<"replanned" | "checked"> {
  if (!(await claim(candidate.id, PendingEntryStatus.ACTIVE, PendingEntryStatus.REVALIDATING))) return "checked"; // lost the race, still counts as "did work" this tick

  try {
    const replanned = await withTimeout(evaluateOnePendingEntry(candidate), PENDING_ENTRY_EVALUATION_TIMEOUT_MS, "pending entry evaluation");
    return replanned ? "replanned" : "checked";
  } catch (err) {
    logger.error({ pendingEntryId: candidate.id, err: String(err) }, "pending entry evaluation failed");
    // Confirmed live 2026-09-12: this used to reset straight to ACTIVE, with
    // no way to know whether the timed-out evaluation had already bought
    // before it timed out (that run keeps executing in the background —
    // withTimeout races it, it doesn't cancel it). A hung trade-entry email
    // outran the 90s timeout on CraftPad's BUY_NOW plan; openTrade() had
    // already spent real money and was still finishing up when this handler
    // put the pending entry back to ACTIVE, and the very next 5s tick bought
    // it again on the same already-crashing token. Fire-and-forget emails
    // fix the immediate cause, but this checks for the trade directly too,
    // so any OTHER slow step that someday outruns the timeout can't repeat
    // it: if a Trade already exists for this plan, the buy went through —
    // mark the entry APPROVED (what its own success path would have set)
    // instead of reopening it to a second buy.
    const alreadyBought = await db.trade.findFirst({ where: { tradePlanId: candidate.tradePlanId }, select: { id: true } });
    if (alreadyBought) {
      logger.warn(
        { pendingEntryId: candidate.id, tradeId: alreadyBought.id },
        "the timed-out evaluation had already opened a trade before it timed out — marking approved instead of reactivating, to avoid buying it again"
      );
      await db.pendingEntry.update({ where: { id: candidate.id }, data: { status: PendingEntryStatus.APPROVED } });
    } else {
      await db.pendingEntry.update({ where: { id: candidate.id }, data: { status: PendingEntryStatus.ACTIVE } });
    }
    return "checked";
  }
}

// Zone-checking above is fully concurrent (independent market polls per
// token), but two entries that both reach their zone within the same batch
// must not both read a pre-buy portfolio/circuit-breaker snapshot and jointly
// commit past maxOpenPositions or available capital — see
// attemptEntryExecution. A simple FIFO promise chain is enough here (single
// process, same pattern wallet.ts's sendQueue uses for nonce safety): only
// ever one entry's trigger-through-openTrade sequence runs at a time,
// regardless of how many are evaluated concurrently above it.
let buyDecisionQueue: Promise<void> = Promise.resolve();

function serializeBuyDecision<T>(fn: () => Promise<T>): Promise<T> {
  const run = buyDecisionQueue.then(fn, fn);
  buyDecisionQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Returns true if this tick replanned (cancelled + regenerated) the candidate's plan. */
async function evaluateOnePendingEntry(entry: PendingEntry): Promise<boolean> {
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
    return false;
  }

  const market = await pollCandidateMarket(candidate.tokenId, candidate.token.chain, candidate.token.address);
  const pair = market.primaryPair;
  const mcap = pair?.marketCapUsd;

  // Token.lastSeenAt (@updatedAt) otherwise only reflects the base discovery
  // poll's own cadence, not this loop's — a token with an active pending
  // entry gets checked continuously here, but the dashboard's "last updated"
  // timestamp on the token stayed frozen at whenever it last appeared in
  // DexScreener's "latest profiles" feed, which can be a poor, misleading
  // proxy for "we're actively watching this" once it's in the trading funnel.
  await db.token.update({ where: { id: candidate.tokenId }, data: { lastSeenAt: new Date() } }).catch(() => {});

  // Stale-plan check: a WAIT_FOR_ENTRY target zone and risk score were
  // otherwise frozen at whatever the AI saw once, at plan-creation time.
  // Confirmed live two different ways: (1) a plan stayed unchanged while its
  // token swung $100K-$380K mcap for over an hour, and (2) replanning purely
  // on a short fixed timer (an earlier version of this check) caused a
  // *different* problem on a choppy/range-bound token — a fresh 3-minute
  // replan recalculates its target relative to whatever price is "now", so
  // the zone kept resetting its own reference point before the real price
  // ever got a chance to test it, confirmed live over 16 replans in 45
  // minutes that never triggered on a token oscillating $10M-$15M mcap the
  // whole time. So: replan IMMEDIATELY when the setup itself has actually
  // broken (price crossed the plan's own invalidation floor or do-not-chase
  // ceiling — meaning the original read is now wrong, not just old), and
  // otherwise only as an infrequent backstop for genuinely stale data. A
  // valid, not-yet-broken zone gets time to actually be reached.
  const planAgeMinutes = (Date.now() - plan.createdAt.getTime()) / 60_000;
  const priceDriftPercent =
    mcap !== undefined && plan.currentMarketCap ? (Math.abs(mcap - plan.currentMarketCap) / plan.currentMarketCap) * 100 : 0;
  // Tolerance-adjusted, not the AI's stated level directly — see
  // tradingConfig.invalidationTolerancePercent for why (a normal post-launch
  // wick isn't the same thing as the setup actually breaking).
  const invalidationFloor =
    plan.invalidationMcap !== null ? plan.invalidationMcap * (1 - tradingConfig.invalidationTolerancePercent / 100) : null;
  const invalidationBreached = invalidationFloor !== null && mcap !== undefined && mcap <= invalidationFloor;
  const ceilingBreached = plan.doNotChaseAboveMcap !== null && mcap !== undefined && mcap > plan.doNotChaseAboveMcap;
  if (
    invalidationBreached ||
    ceilingBreached ||
    planAgeMinutes >= tradingConfig.pendingPlanReviewIntervalMinutes ||
    priceDriftPercent >= tradingConfig.pendingPlanReplanOnDriftPercent
  ) {
    await db.pendingEntry.update({ where: { id: entry.id }, data: { status: PendingEntryStatus.CANCELLED, lastCheckedAt: new Date() } });
    const reason = invalidationBreached
      ? "invalidation breached"
      : ceilingBreached
        ? "do-not-chase ceiling breached"
        : planAgeMinutes >= tradingConfig.pendingPlanReviewIntervalMinutes
          ? "plan age backstop"
          : "price drift";
    logger.info(
      { pendingEntryId: entry.id, candidateId: candidate.id, reason, planAgeMinutes: Math.round(planAgeMinutes), priceDriftPercent: Math.round(priceDriftPercent) },
      "trade plan replanned with fresh market data"
    );
    try {
      await planCandidate(candidate.id);
    } catch (err) {
      logger.error({ candidateId: candidate.id, err: String(err) }, "re-plan failed — candidate has no active pending entry until the next planning pass picks it up");
    }
    return true;
  }

  const inZone =
    mcap !== undefined &&
    entry.targetMcapMin !== null &&
    entry.targetMcapMax !== null &&
    mcap >= entry.targetMcapMin &&
    mcap <= entry.targetMcapMax;

  if (!inZone) {
    await db.pendingEntry.update({ where: { id: entry.id }, data: { status: PendingEntryStatus.ACTIVE, lastCheckedAt: new Date() } });
    return false;
  }

  // A WAIT_FOR_ENTRY zone means "wait for a pullback" — reaching it while
  // price is still actively falling isn't a pullback, it's the middle of the
  // drop. BUY_NOW's zone is a synthetic ±10% band meant to fire near-
  // instantly (see planCandidate), so this only applies to a genuine wait.
  // User directive 2026-09-12: PONSFLY, Sheared and FFSTR all triggered this
  // way and went on to 0.01x-0.14x of entry within hours.
  if (plan.action === TradePlanAction.WAIT_FOR_ENTRY && !hasPriceStabilized(await getRecentMcapTicks(candidate.tokenId))) {
    await db.pendingEntry.update({ where: { id: entry.id }, data: { status: PendingEntryStatus.ACTIVE, lastCheckedAt: new Date() } });
    logger.info({ pendingEntryId: entry.id, candidateId: candidate.id, mcap }, "pullback zone reached but price is still falling — waiting for it to stabilize");
    return false;
  }

  // Everything from here on touches shared capital/position-count state, so
  // it's serialized process-wide (see serializeBuyDecision) — the cheap zone
  // check above stays fully concurrent across a batch, only the actual
  // commit decision is mutually exclusive.
  await serializeBuyDecision(async () => {
    // The AI's risk score no longer hard-blocks entry here — confirmed live it
    // blocked every single trigger this system ever had (including one that
    // went on to 2x right after). It now scales position size instead, in
    // calculatePositionSize below (entryRiskScore), same treatment as quality/
    // confidence/liquidity.
    await db.pendingEntry.update({ where: { id: entry.id }, data: { triggeredAt: new Date(), lastCheckedAt: new Date() } });
    logger.info({ pendingEntryId: entry.id, candidateId: candidate.id, mcap }, "pending entry triggered — revalidating");

    const circuitBreakers = await checkCircuitBreakers();
    const portfolio = await getPortfolioState();

    if (!pair) {
      await rejectEntry(entry, candidate.id, ["pool disappeared — no market data available at trigger time"]);
      return;
    }

    const planData = plan.planData as { freshEval?: { riskBucket: RiskBucket }; tradeLane?: string; liquidityUsd?: number; analysis?: { marketRegime?: string } };
    const tradeLane = normalizeTradeLane(planData.tradeLane ?? candidate.tradeLane);
    const conservative = circuitBreakers.mode === "CONSERVATIVE";

    // Chase guard — every mode, not just conservative (user directive
    // 2026-09-12): blocks buying a token that's already run up hard in our
    // OWN recent snapshot history, not DexScreener's lagging 5m change. A
    // miss defers rather than rejects — a run-up can cool off while the plan
    // is still live, whereas a rejected candidate is never planned again.
    const recentRange = await getRecentMcapRange(candidate.tokenId, tradingConfig.conservativeRecentWindowMinutes, mcap);
    const chase = evaluateChaseGuard(recentRange, {
      windowMinutes: tradingConfig.conservativeRecentWindowMinutes,
      minSnapshots: tradingConfig.conservativeMinRecentSnapshots,
      maxRunUpPercent: tradingConfig.conservativeMaxRecentRunUpPercent,
    });
    if (!chase.passed) {
      await deferForConviction(entry, candidate.id, chase, conservative);
      return;
    }

    // Real trading demand — every mode, not just conservative (user
    // directive 2026-09-13). Looser outside conservative mode; see
    // conservativeMode.ts's evaluateRealDemand.
    const demand = evaluateRealDemand(
      { buys1h: pair.buys1h, sells1h: pair.sells1h, volume1hUsd: pair.volume1h, liquidityUsd: pair.liquidityUsd },
      conservative
        ? {
            minHourlyTxns: tradingConfig.conservativeMinHourlyTxns,
            minBuyRatio1h: tradingConfig.conservativeMinBuyRatio1h,
            maxBuyRatio1h: tradingConfig.conservativeMaxBuyRatio1h,
            maxVolumeToLiquidity1h: tradingConfig.conservativeMaxVolumeToLiquidity1h,
          }
        : {
            minHourlyTxns: tradingConfig.normalMinHourlyTxns,
            minBuyRatio1h: tradingConfig.normalMinBuyRatio1h,
            maxBuyRatio1h: tradingConfig.normalMaxBuyRatio1h,
            maxVolumeToLiquidity1h: tradingConfig.normalMaxVolumeToLiquidity1h,
          }
    );
    if (!demand.passed) {
      await deferForConviction(entry, candidate.id, demand, conservative);
      return;
    }

    // Conservative mode: a loss breaker tripped, so this entry only goes ahead
    // on a high-conviction setup on top of the chase guard above.
    if (conservative) {
      const conviction = evaluateHighConvictionSetup({
        tokenAgeMinutes: estimateTokenAgeMinutes(candidate.token.firstSeenAt, pair.pairCreatedAt),
        liquidityUsd: pair.liquidityUsd,
        buys1h: pair.buys1h,
        sells1h: pair.sells1h,
        volume1hUsd: pair.volume1h,
        priceChange5mPercent: pair.priceChange5m,
        priceChange1hPercent: pair.priceChange1h,
        recent: recentRange,
        marketRegime: planData.analysis?.marketRegime,
        planRiskScore: plan.riskScore,
      });
      if (!conviction.passed) {
        await deferForConviction(entry, candidate.id, conviction, conservative);
        return;
      }
    }

    const riskBucket: RiskBucket = planData.freshEval?.riskBucket ?? "MEDIUM";
    const strategy = await getActiveStrategyVersion();
    const sizing = calculatePositionSize({
      portfolio,
      sizingRules: strategy.sizingRules as unknown as SizingRules,
      qualityScore: candidate.qualityScore ?? 0,
      confidence: plan.confidence ?? 0,
      riskBucket,
      liquidityUsd: pair.liquidityUsd ?? 0,
      entryRiskScore: plan.riskScore,
      currentMcapUsd: mcap,
      tradeLane,
    });

    if (!sizing.approved) {
      await rejectEntry(entry, candidate.id, sizing.reasons);
      return;
    }

    // Shrink to fit the pool's real on-chain depth instead of rejecting
    // outright (user directive 2026-09-12, after SIDEBET ran ~2x while we
    // chased it, finally triggered, then got REJECTED forever purely because
    // the size calculatePositionSize picked from quality/confidence/equity%
    // was too big for this specific pool — CME/SEXFLY/TRACE lost the same
    // way before it). The pool being thin relative to OUR size isn't a
    // reason to walk away from a confirmed real move; it's a reason to buy
    // less of it. Floor matches calculatePositionSize's own gas-viability
    // floor — never sized below what's worth paying gas for.
    let positionSizeUsd = sizing.positionSizeUsd;
    let quote = await getBuyEstimate(candidate.token.address, positionSizeUsd, pair);
    const sizeFloorUsd = (tradingConfig.paperAssumedGasCostUsd * 100) / tradingConfig.maxGasCostPercentOfPosition;
    let resized = false;
    while (
      (quote.estimatedSlippageBps > tradingConfig.defaultMaxBuySlippageBps ||
        quote.estimatedPriceImpactPercent > tradingConfig.maxBuyPriceImpactPercent) &&
      positionSizeUsd > sizeFloorUsd
    ) {
      positionSizeUsd = Math.max(positionSizeUsd / 2, sizeFloorUsd);
      quote = await getBuyEstimate(candidate.token.address, positionSizeUsd, pair);
      resized = true;
    }
    if (resized) {
      logger.info(
        { pendingEntryId: entry.id, candidateId: candidate.id, from: sizing.positionSizeUsd, to: positionSizeUsd, estimatedPriceImpactPercent: quote.estimatedPriceImpactPercent },
        "position size shrunk to fit real on-chain liquidity depth"
      );
    }

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
      positionSizeUsd,
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

    // Stale-quote guard — every mode, checked last because it needs the real
    // quote above. Looser outside conservative mode (30% vs 10%): TUMBLE's
    // real dip filled 25% below DexScreener's displayed price and was the
    // day's best trade, so normal mode shouldn't block that (user directive
    // 2026-09-12).
    const maxQuoteDiscountPercent = conservative ? tradingConfig.conservativeMaxQuoteDiscountPercent : tradingConfig.normalMaxQuoteDiscountPercent;
    const agreement = evaluateQuoteAgreement(
      { spotPriceUsd: pair.priceUsd, positionSizeUsd, quotedTokenAmount: quote.tokenAmount },
      maxQuoteDiscountPercent
    );
    if (!agreement.passed) {
      await deferForConviction(entry, candidate.id, agreement, conservative);
      return;
    }

    // Holder concentration — every mode (user directive 2026-09-13: "how do
    // we know if someone is going to rug the project with a few sells").
    // Checked last, right before commit: it's a real RPC log scan, not a
    // cheap in-memory check like the others above.
    if (tradingConfig.holderCheckEnabled) {
      const holderSnapshot = await getHolderSnapshot(getPublicClient(), candidate.token.address as `0x${string}`).catch((err) => {
        logger.warn({ pendingEntryId: entry.id, candidateId: candidate.id, err: String(err) }, "holder concentration check failed to read on-chain data");
        return undefined;
      });
      const holders = evaluateHolderConcentration(holderSnapshot, {
        maxTop1HolderPercent: tradingConfig.maxTop1HolderPercent,
        maxTop10HolderPercent: tradingConfig.maxTop10HolderPercent,
        minHolderCount: tradingConfig.minHolderCountForEntry,
      });
      if (!holders.passed) {
        await deferForConviction(entry, candidate.id, holders, conservative);
        return;
      }
    }
    lastConvictionFailures.delete(entry.id);

    await openTrade({
      candidateId: candidate.id,
      tradePlanId: plan.id,
      strategyVersionId: plan.strategyVersionId,
      tokenId: candidate.tokenId,
      tokenAddress: candidate.token.address,
      positionSizeUsd,
      plannedEntryMcap: plan.currentMarketCap ?? undefined,
      actualEntryMcap: mcap,
      tradeLane,
      pair,
      reasons: conservative ? [...entryResult.reasons, "conservative mode: passed the high-conviction gate"] : entryResult.reasons,
    });
    await db.pendingEntry.update({ where: { id: entry.id }, data: { status: PendingEntryStatus.APPROVED } });
    await db.tradeCandidate.update({ where: { id: candidate.id }, data: { status: TradeCandidateStatus.TRADED } });
  });
  return false;
}

async function rejectEntry(entry: PendingEntry, candidateId: string, reasons: string[]): Promise<void> {
  await db.pendingEntry.update({ where: { id: entry.id }, data: { status: PendingEntryStatus.REJECTED } });
  await db.tradeCandidate.update({ where: { id: candidateId }, data: { status: TradeCandidateStatus.REJECTED } });
  // User directive 2026-09-11: a revalidation-stage rejection (slippage,
  // price impact, liquidity collapse, sizing, sell-path checks — everything
  // validateEntry/calculatePositionSize can reject on) was previously only
  // ever logged, never persisted — the dashboard's "why was this rejected"
  // had no queryable answer, only Railway logs. Confirmed live repeatedly
  // tonight (CME, SEXFLY, TRACE) that this is the single most common
  // follow-up question once a token's status shows REJECTED. Recorded the
  // same way a BUY decision already is in openTrade below.
  const strategy = await getActiveStrategyVersion();
  await db.tradeDecisionSnapshot.create({
    data: {
      candidateId,
      decision: TradeDecision.SKIP,
      stage: "entry_revalidation",
      strategyVersionId: strategy.id,
      marketState: {},
      projectState: {},
      technicalState: {},
      portfolioState: {},
      deterministicRules: { reasons },
      finalReasons: reasons,
    },
  });
  logger.info({ pendingEntryId: entry.id, candidateId, reasons }, "entry rejected at revalidation");
}

// Which checks last held each deferred entry back. A deferred entry is
// re-checked every few seconds, so a decision row (what the dashboard shows
// as "why is this still waiting") is written only when that set changes, not
// on every tick. Cleared wholesale past a size bound — the only cost of that
// is one repeated row.
const lastConvictionFailures = new Map<string, string>();

async function deferForConviction(entry: PendingEntry, candidateId: string, result: ConvictionResult, conservative: boolean): Promise<void> {
  await db.pendingEntry.update({ where: { id: entry.id }, data: { status: PendingEntryStatus.ACTIVE } });
  const key = result.failedChecks.join(",");
  if (lastConvictionFailures.get(entry.id) === key) return;
  if (lastConvictionFailures.size >= 1000) lastConvictionFailures.clear();
  lastConvictionFailures.set(entry.id, key);

  // Same checks (chase guard, stale-quote guard) fire in every mode now —
  // the stage/log just say which gate was actually active when they did.
  const stage = conservative ? "conservative_gate" : "entry_guard";
  const strategy = await getActiveStrategyVersion();
  await db.tradeDecisionSnapshot.create({
    data: {
      candidateId,
      decision: TradeDecision.WAIT,
      stage,
      strategyVersionId: strategy.id,
      marketState: {},
      projectState: {},
      technicalState: {},
      portfolioState: {},
      deterministicRules: { failedChecks: result.failedChecks, reasons: result.reasons },
      finalReasons: result.reasons,
    },
  });
  logger.info(
    { pendingEntryId: entry.id, candidateId, reasons: result.reasons },
    conservative ? "conservative mode: entry held back — not a high-conviction setup yet" : "entry held back — not ready yet"
  );
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
  tradeLane: TradeLane;
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
    recordBuyFailure({
      tokenAddress: input.tokenAddress,
      tokenLabel: input.pair.baseTokenSymbol ?? input.pair.baseTokenName ?? input.tokenAddress.slice(0, 10),
      error: String(err),
    });
    await db.tradeCandidate.update({ where: { id: input.candidateId }, data: { status: TradeCandidateStatus.REJECTED } });
    throw err;
  }
  recordBuySuccess();

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
      tradeLane: input.tradeLane,
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

  // Confirmed live 2026-09-13 (SL/"Stonks Launch"): isSellable() above only
  // proves the POOL's quoter works — pure curve math, no wallet involved —
  // and SL's quoted fine every time while the wallet couldn't move a single
  // wei of it, via any route, to any address. Undetectable before this buy
  // (there was no balance to test transferring), but free to check the
  // instant it confirms — one eth_call, no gas. Catching it here means one
  // bad buy costs exactly what it cost and nothing more, instead of sitting
  // OPEN and retrying a doomed sell forever (see positionManager.ts's own
  // give-up path for a stuck position that only reveals itself after this
  // check already passed).
  if (fill.provider === "live" && !(await canWalletTransferToken(input.tokenAddress, fill.tokenAmount))) {
    const closed = await db.trade.update({
      where: { id: trade.id },
      data: {
        status: TradeStatus.CLOSED,
        closedAt: new Date(),
        realizedPnlUsd: -input.positionSizeUsd,
        realizedMultiple: 0,
        exitReason: "written off immediately — wallet cannot transfer this token at all (honeypot blocks real sells, only the quoter works)",
      },
    });
    logger.error({ tradeId: trade.id, tokenAddress: input.tokenAddress, lossUsd: input.positionSizeUsd }, "bought into an unsellable token — written off immediately rather than left to retry forever");
    const tokenRow = await db.token.findUnique({ where: { id: input.tokenId } });
    void sendTradeClosedEmail({ token: tokenRow, trade: closed }).catch((err) =>
      logger.error({ tradeId: trade.id, err: String(err) }, "failed to send honeypot write-off email")
    );
    return;
  }

  await db.tradeDecisionSnapshot.create({
    data: {
      candidateId: input.candidateId,
      tradeId: trade.id,
      decision: TradeDecision.BUY,
      stage: "entry_revalidation",
      strategyVersionId: input.strategyVersionId,
      marketState: { actualEntryMcap: input.actualEntryMcap },
      projectState: { tradeLane: input.tradeLane },
      technicalState: {},
      portfolioState: {},
      deterministicRules: { tradeLane: input.tradeLane, reasons: input.reasons },
      finalReasons: input.reasons,
    },
  });

  // Confirmed live 2026-09-12: CraftPad bought TWICE within 2 minutes, on the
  // same candidate/plan, for -$5.24 combined. Root cause: this was `await`ed
  // before "trade opened" logged and this function returned — when Gmail SMTP
  // hung for ~2 minutes on "Connection timeout", the whole evaluation outran
  // PENDING_ENTRY_EVALUATION_TIMEOUT_MS (90s), whose recovery path has no way
  // to know a real buy already went through and reset the pending entry back
  // to ACTIVE — which the next 5s tick then re-triggered into a second buy on
  // the same, already-crashing token. A confirmation email must never be able
  // to hold up the function that just spent real money, so this — like every
  // other trading-loop notification — is now fire-and-forget.
  const token = await db.token.findUnique({ where: { id: input.tokenId } });
  void sendTradeEntryEmail({ token, trade, quote: fill }).catch((err) =>
    logger.error({ tradeId: trade.id, err: String(err) }, "failed to send trade entry email")
  );

  logger.info({ tradeId: trade.id, positionSizeUsd: input.positionSizeUsd, mode, provider: fill.provider, txHash: fill.txHash }, "trade opened");
}

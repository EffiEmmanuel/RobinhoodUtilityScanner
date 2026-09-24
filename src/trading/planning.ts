import { db } from "../db";
import { config } from "../config";
import { logger } from "../logger";
import { callStructured } from "../ai/provider";
import { TradeAnalysisSchema, TRADE_ANALYSIS_JSON_SCHEMA } from "./schemas";
import { TRADE_ANALYSIS_SYSTEM, buildTradeAnalysisPrompt } from "./prompts";
import { pollCandidateMarket, computeTechnicalFeatures, formatTechnicalFeaturesForPrompt } from "./marketAnalysis";
import { evaluateCandidate, entryMarketFilter, isBondingCurvePair, failedOnlyOnMarketAccess, type CandidateRiskResult } from "./riskEngine";
import { getActiveStrategyVersion } from "./strategy";
import { getBuyEstimate, isSellable } from "./executionFacade";
import { isLiveModeReady, warmRoutes } from "./live/liveExecutionProvider";
import { tradingConfig } from "./config";
import { classifyTradeLane } from "./tradeLane";
import { evaluateUtilityOnlyGate, utilityGateInputFromRawResearch } from "./utilityGate";
import { TradeCandidateStatus, TradePlanAction, PendingEntryStatus, TradeDecision } from "../generated/prisma";
import { sendTradePlanEmail } from "./notifications";
import type { MarketPair } from "../dex/types";
import { formatWalletSignalsForPrompt, getWalletSignalsForToken } from "../walletTracking/signals";

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
  // Warm every trade route to this token now, while nothing is racing, so a
  // later entry only has to re-quote (see live/liveExecutionProvider.ts).
  if (candidate.token.chain !== "solana" && isLiveModeReady()) {
    void warmRoutes(candidate.token.address as `0x${string}`).catch((err) =>
      logger.debug({ candidateId, err: String(err) }, "route warm-up failed — the entry will discover routes itself")
    );
  }
  const market = await pollCandidateMarket(candidate.tokenId, candidate.token.chain, candidate.token.address);
  const technical = await computeTechnicalFeatures(candidate.tokenId, market.primaryPair, candidate.token.address, candidate.token.chain);
  const walletSignals = await getWalletSignalsForToken(candidate.tokenId, candidate.token.address);

  const liquidityUsd = market.primaryPair?.liquidityUsd ?? 0;
  const onBondingCurve = isBondingCurvePair(market.primaryPair);
  // Checked on every first plan, not only for thin pools: a token can show
  // plenty of liquidity and still have no route that executes (BITS,
  // 2026-09-24: $30K pool whose hook rejects outside swaps) — better caught
  // here, as a wait, than after an AI plan and at entry. Replans only check
  // thin pools, as before; a watched candidate is revalidated at entry.
  // undefined = not checked / couldn't check, which never counts against it.
  const executableAtMinimumSize =
    !onBondingCurve && market.primaryPair && (isFirstPlan || liquidityUsd < tradingConfig.minTradeLiquidityUsd)
      ? await canExecuteMinimumPosition(candidate.token.address, market.primaryPair, candidate.token.chain)
      : undefined;
  const freshEval = evaluateCandidate({
    qualityScore: candidate.qualityScore ?? 0,
    researchConfidence: candidate.researchConfidence ?? 0,
    contractScore: run.contractScore ?? 0,
    liquidityUsd,
    hardReject: run.hardReject,
    chain: candidate.token.chain,
    onBondingCurve,
    executableAtMinimumSize,
  });
  const utilityGate = evaluateUtilityOnlyGate(
    utilityGateInputFromRawResearch(run.rawResearch, {
      utilityScore: run.utilityScore,
      credibilityScore: run.credibilityScore,
      websiteScore: run.websiteScore,
    })
  );
  // User directive 2026-09-18: utility-only, no exceptions — retired the
  // momentum/narrative bypass (canBypassUtilityGateForMomentum) that used to
  // let a candidate trade despite failing the utility gate. A candidate whose
  // qualificationPath is still MOMENTUM_OVERRIDE/NARRATIVE_META from before
  // this change (queued under the old rules) now gets no special treatment —
  // it's re-evaluated as NORMAL, same as everything else.
  const qualificationPath = "NORMAL";
  const tradeEligibilityEvaluation = utilityGate.passed
    ? freshEval
    : { eligible: false, riskBucket: "REJECT" as const, reasons: utilityGate.reasons, failedChecks: [] };
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

  const planningUtilityReasons = utilityGate.reasons;

  if (!freshEval.eligible || !utilityGate.passed) {
    const now = new Date();
    const liquidityWait = liquidityWaitDecision({
      evaluation: freshEval,
      utilityGatePassed: utilityGate.passed,
      isFirstPlan,
      candidateCreatedAt: candidate.createdAt,
      now,
    });
    if (liquidityWait === "WAIT") {
      const retryAfter = new Date(now.getTime() + tradingConfig.liquidityWaitRetryMinutes * 60_000);
      // One row per candidate, updated in place — a pool that stays thin for
      // hours would otherwise write a new decision row every retry.
      const deterministicRules = {
        retryAfter: retryAfter.toISOString(),
        retryMinutes: tradingConfig.liquidityWaitRetryMinutes,
        waitingForLiquiditySince: candidate.createdAt.toISOString(),
        liquidityUsd,
        qualificationPath,
        tradeLane: lane.tradeLane,
      };
      const existingWait = await db.tradeDecisionSnapshot.findFirst({
        where: { candidateId: candidate.id, stage: "planning_retry" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (existingWait) {
        await db.tradeDecisionSnapshot.update({ where: { id: existingWait.id }, data: { deterministicRules } });
      } else {
        await recordDecision(candidate.id, null, TradeDecision.WAIT, "planning_retry", strategy.id, {
          market: summarizeMarket(market.primaryPair?.marketCapUsd, liquidityUsd),
          project: { qualityScore: candidate.qualityScore, researchConfidence: candidate.researchConfidence, tradeLane: lane.tradeLane, laneReasons: lane.reasons },
          technical,
          walletSignals,
          reasons: [
            `${
              freshEval.failedChecks.includes("execution")
                ? "no route executes our minimum position yet"
                : `pool too thin to enter yet ($${Math.round(liquidityUsd)} < $${tradingConfig.minTradeLiquidityUsd})`
            } — waiting, re-checking every ${tradingConfig.liquidityWaitRetryMinutes} min for up to ${tradingConfig.liquidityWaitMaxHours}h`,
            ...freshEval.reasons,
          ],
          deterministic: deterministicRules,
        });
        logger.info({ candidateId, liquidityUsd, retryMinutes: tradingConfig.liquidityWaitRetryMinutes }, "candidate is waiting for pool liquidity instead of being rejected");
      }
      await db.tradeCandidate.update({ where: { id: candidateId }, data: { status: TradeCandidateStatus.QUALIFIED, qualificationPath, tradeLane: lane.tradeLane } });
      return;
    }

    const rejectReasons = [
      ...(liquidityWait === "GIVE_UP"
        ? [
            freshEval.failedChecks.includes("execution")
              ? `no route ever executed our minimum position within ${tradingConfig.liquidityWaitMaxHours}h of qualifying`
              : `liquidity never reached $${tradingConfig.minTradeLiquidityUsd} within ${tradingConfig.liquidityWaitMaxHours}h of qualifying`,
          ]
        : []),
      ...freshEval.reasons,
      ...utilityGate.reasons,
    ];
    await recordDecision(candidate.id, null, TradeDecision.SKIP, "planning", strategy.id, {
      market: summarizeMarket(market.primaryPair?.marketCapUsd, liquidityUsd),
      project: { qualityScore: candidate.qualityScore, researchConfidence: candidate.researchConfidence, tradeLane: lane.tradeLane, laneReasons: lane.reasons },
      technical,
      walletSignals,
      reasons: rejectReasons,
    });
    await db.tradeCandidate.update({ where: { id: candidateId }, data: { status: TradeCandidateStatus.REJECTED, qualificationPath, tradeLane: lane.tradeLane } });
    logger.info({ candidateId, reasons: rejectReasons }, "candidate rejected at planning (eligibility/utility moved since qualification)");
    return;
  }

  // Market conditions that almost never led to a sellable 2x (see
  // entryMarketFilter). First plan only: a watched candidate already passed it.
  const marketFilterReasons = isFirstPlan
    ? entryMarketFilter({
        chain: candidate.token.chain,
        marketCapUsd: market.primaryPair?.marketCapUsd,
        liquidityUsd: market.primaryPair?.liquidityUsd,
        priceChange1hPercent: market.primaryPair?.priceChange1h,
        onBondingCurve,
      })
    : [];
  if (marketFilterReasons.length > 0) {
    await recordDecision(candidate.id, null, TradeDecision.SKIP, "planning", strategy.id, {
      market: summarizeMarket(market.primaryPair?.marketCapUsd, liquidityUsd),
      project: { qualityScore: candidate.qualityScore, researchConfidence: candidate.researchConfidence, tradeLane: lane.tradeLane, laneReasons: lane.reasons },
      technical,
      walletSignals,
      reasons: marketFilterReasons,
    });
    await db.tradeCandidate.update({ where: { id: candidateId }, data: { status: TradeCandidateStatus.REJECTED, qualificationPath, tradeLane: lane.tradeLane } });
    logger.info({ candidateId, reasons: marketFilterReasons }, "candidate rejected at planning by the entry market filter");
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
        marketText: summarizeMarket(market.primaryPair?.marketCapUsd, liquidityUsd, market.primaryPair?.priceUsd, executableAtMinimumSize),
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

  const tacticalScoutOverride = tacticalScoutActionForWatchOnly({
    action,
    tradeLane: lane.tradeLane,
    currentMcap,
    targetEntryMcapMin: clampedZone.min,
    targetEntryMcapMax: clampedZone.max,
    pair: market.primaryPair,
  });
  if (tacticalScoutOverride) {
    logger.warn(
      {
        candidateId: candidate.id,
        fromAction: action,
        toAction: tacticalScoutOverride,
        currentMcap,
        targetEntryMcapMin: clampedZone.min,
        targetEntryMcapMax: clampedZone.max,
        buys1h: market.primaryPair?.buys1h,
        sells1h: market.primaryPair?.sells1h,
        liquidityUsd,
        aiReasoning: analysis.reasoning,
      },
      "deterministic tactical scout override: AI chose WATCH_ONLY for a tradeable momentum setup with an actionable zone"
    );
    action = tacticalScoutOverride;
    entryStyle = tacticalScoutOverride === TradePlanAction.BUY_NOW ? "MARKET_ENTRY" : "PULLBACK_ENTRY";
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
      planData: { analysis, freshEval, tradeLane: lane.tradeLane, laneReasons: lane.reasons, utilityGate: utilityGate.reasons, walletSignals, liquidityUsd, pullbackClamped: clampedZone.clamped, extremeMomentumOverride } as unknown as object,
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
      reasons: [...freshEval.reasons, ...planningUtilityReasons, ...lane.reasons, analysis.reasoning],
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

/**
 * User directive 2026-09-24: "we can still invest in these kinds of tokens
 * even if the pool just opened." What actually matters for our position
 * sizes is whether the smallest position we'd ever take (the gas-viable
 * floor entryMonitor.ts sizes down to) can be bought within the
 * price-impact/slippage limits and sold back — a live on-chain quote, not
 * DexScreener's reported liquidity, which only sees the ETH-quoted pool we
 * execute through and badly understates depth on Robinhood Chain (MUSETOWN:
 * $550 reported at a $290K mcap). Any quote failure counts as "not yet" —
 * the candidate keeps waiting via liquidityWaitDecision, never rejects on it.
 */
async function canExecuteMinimumPosition(tokenAddress: string, pair: MarketPair, chain: string): Promise<boolean | undefined> {
  const minimumPositionUsd = (tradingConfig.paperAssumedGasCostUsd * 100) / tradingConfig.maxGasCostPercentOfPosition;
  try {
    const quote = await getBuyEstimate(tokenAddress, minimumPositionUsd, pair, chain);
    if (quote.estimatedPriceImpactPercent > tradingConfig.maxBuyPriceImpactPercent) return false;
    if (quote.estimatedSlippageBps > tradingConfig.defaultMaxBuySlippageBps) return false;
    return await isSellable(tokenAddress, pair, chain, quote.tokenAmount);
  } catch (err) {
    // Couldn't check (RPC/discovery trouble) is not "doesn't execute".
    logger.debug({ tokenAddress, chain, err: String(err) }, "minimum-position executability check failed — unknown, not held against the candidate");
    return undefined;
  }
}

/**
 * Whether a candidate held back only by pool depth should keep waiting for
 * liquidity (WAIT), has waited long enough (GIVE_UP), or doesn't qualify for
 * waiting at all (NOT_APPLICABLE — anything else failed too). Only a first
 * plan waits: a WAITING candidate whose liquidity collapses on a replan is a
 * rug signal and still rejects.
 */
export function liquidityWaitDecision(input: {
  evaluation: CandidateRiskResult;
  utilityGatePassed: boolean;
  isFirstPlan: boolean;
  candidateCreatedAt: Date;
  now: Date;
}): "WAIT" | "GIVE_UP" | "NOT_APPLICABLE" {
  if (!input.isFirstPlan || !input.utilityGatePassed || !failedOnlyOnMarketAccess(input.evaluation)) return "NOT_APPLICABLE";
  const waitedMs = input.now.getTime() - input.candidateCreatedAt.getTime();
  return waitedMs >= tradingConfig.liquidityWaitMaxHours * 3_600_000 ? "GIVE_UP" : "WAIT";
}

/**
 * Rescues a WATCH_ONLY verdict into an actionable BUY_NOW/WAIT_FOR_ENTRY for
 * a fast-moving, already-utility-qualified MOMENTUM_TACTICAL candidate the
 * AI got too cautious about, given real two-sided volume backing the move.
 *
 * User directive 2026-09-22: "we can still take advantage of momentum and
 * volume pumps... especially for good projects and not just utility PER SE."
 * Found (not previously known) that this had been silently dead since the
 * 2026-09-18 utility-only pivot: it required `qualificationPath ===
 * "MOMENTUM_OVERRIDE"`, but planCandidate hardcodes qualificationPath to
 * "NORMAL" for every candidate now (that pivot retired the bypass path this
 * used to gate on) — so this function could never fire, silently, for four
 * days. Fixed by dropping that dead check; tradeLane === "MOMENTUM_TACTICAL"
 * alone is the right gate now, same redefinition resolveExitRules in
 * positionManager.ts already applies: post-pivot, that lane only ever means
 * "a genuine utility candidate that didn't clear the verified-project bar,"
 * not "a risky momentum play" — so rescuing it on confirmed momentum is
 * exactly "taking advantage of a pump for a good project," not reopening
 * the bypass. Chain-agnostic (no chain check anywhere in this file) — applies
 * identically to Robinhood Chain and Solana candidates.
 */
export function tacticalScoutActionForWatchOnly(input: {
  action: TradePlanAction;
  tradeLane: string | null | undefined;
  currentMcap: number | undefined;
  targetEntryMcapMin: number | undefined;
  targetEntryMcapMax: number | undefined;
  pair: Pick<MarketPair, "liquidityUsd" | "volume1h" | "buys1h" | "sells1h"> | undefined;
}): TradePlanAction | undefined {
  if (input.action !== TradePlanAction.WATCH_ONLY) return undefined;
  if (input.tradeLane !== "MOMENTUM_TACTICAL") return undefined;
  if (!input.pair || input.currentMcap === undefined) return undefined;
  if (input.targetEntryMcapMin === undefined || input.targetEntryMcapMax === undefined) return undefined;

  const hourlyTxns = (input.pair.buys1h ?? 0) + (input.pair.sells1h ?? 0);
  if (hourlyTxns < config.momentumOverrideMinHourlyTxns) return undefined;
  if ((input.pair.liquidityUsd ?? 0) < tradingConfig.momentumTacticalMinLiquidityUsd) return undefined;

  const buyRatio = hourlyTxns > 0 ? (input.pair.buys1h ?? 0) / hourlyTxns : 0;
  if (buyRatio < tradingConfig.normalMinBuyRatio1h || buyRatio > tradingConfig.normalMaxBuyRatio1h) return undefined;

  const liquidityUsd = input.pair.liquidityUsd ?? 0;
  if (input.pair.volume1h !== undefined && liquidityUsd > 0 && input.pair.volume1h / liquidityUsd > tradingConfig.normalMaxVolumeToLiquidity1h) {
    return undefined;
  }

  if (input.currentMcap >= input.targetEntryMcapMin && input.currentMcap <= input.targetEntryMcapMax) {
    return TradePlanAction.BUY_NOW;
  }
  if (input.currentMcap > input.targetEntryMcapMax) {
    return TradePlanAction.WAIT_FOR_ENTRY;
  }
  return undefined;
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

function summarizeMarket(mcap: number | undefined, liquidity: number, price?: number, executableAtMinimumSize?: boolean): string {
  const parts = [
    mcap !== undefined ? `Market cap: $${Math.round(mcap).toLocaleString()}` : "Market cap: unknown",
    `Liquidity: $${Math.round(liquidity).toLocaleString()}`,
    executableAtMinimumSize
      ? "Note: that liquidity figure is DexScreener's reading of the one pool we execute through, and badly understates real depth on this chain — a live on-chain quote just confirmed our position size buys within the price-impact limit and can be sold back, so don't treat the low figure as thin liquidity."
      : undefined,
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

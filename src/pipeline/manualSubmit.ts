import { isAddress, getAddress } from "viem";
import { db } from "../db";
import { config } from "../config";
import { logger } from "../logger";
import { getPublicClient } from "../trading/live/wallet";
import { getTokenNameSymbol } from "../trading/live/tokenUtils";
import { researchMarket } from "../research/market";
import { TokenStatus, TradeCandidateStatus, TradePlanAction, PendingEntryStatus, TradeDecision, TradeStatus } from "../generated/prisma";
import type { Token } from "../generated/prisma";
import { getActiveStrategyVersion } from "../trading/strategy";

// A human pasting a CA in has already vouched for it, so a manual submission
// re-queues even a token the automated pipeline already fully evaluated and
// settled on (WATCHLISTED, ALERTED, REJECTED, ...) — user directive
// 2026-09-13: "tokens move at different times," a token that dipped and got
// passed over can regain momentum later, and there's no reason a human
// deliberately asking to re-check one specific address should ever be turned
// away just because it already has a result. Only genuinely in-flight work
// is left alone (the two sets below) — re-queuing something mid-evaluation
// right now would race with itself.
const IN_FLIGHT_TOKEN_STATUSES = new Set<TokenStatus>([TokenStatus.CLASSIFYING, TokenStatus.RESEARCH_QUEUED, TokenStatus.RESEARCHING]);
// A settled Token status (WATCHLISTED/ALERTED) can still have an in-flight
// TradeCandidate underneath it — QUALIFIED/PLANNING/WAITING all mean the
// candidate hasn't resolved yet — so this checks that too, not just the
// token's own status.
const IN_FLIGHT_CANDIDATE_STATUSES = new Set<TradeCandidateStatus>([TradeCandidateStatus.QUALIFIED, TradeCandidateStatus.PLANNING, TradeCandidateStatus.WAITING]);
const ACTIVE_TRADE_STATUSES = new Set<TradeStatus>([
  TradeStatus.ENTRY_PENDING,
  TradeStatus.ENTRY_SUBMITTED,
  TradeStatus.OPEN,
  TradeStatus.PARTIALLY_EXITED,
  TradeStatus.EXIT_PENDING,
  TradeStatus.EXIT_SUBMITTED,
]);

/** Pulls a 0x address out of raw input — accepts a bare address or something
 * like a pasted DexScreener/explorer URL with the address in the path.
 * Lowercased (not EIP-55 checksummed) to match discover.ts/onchainDiscovery.ts
 * — our own dedup constraint is a case-sensitive string compare, so a mixed
 * check-summed address here would silently create a duplicate row instead of
 * finding the real one. */
function extractAddress(input: string): `0x${string}` {
  const trimmed = input.trim();
  if (isAddress(trimmed)) return getAddress(trimmed).toLowerCase() as `0x${string}`;
  const match = trimmed.match(/0x[a-fA-F0-9]{40}/);
  if (match && isAddress(match[0])) return getAddress(match[0]).toLowerCase() as `0x${string}`;
  throw new Error(`"${input}" doesn't contain a valid contract address`);
}

/**
 * Manual override for the human-in-the-loop path: a user-supplied CA skips
 * discovery and the cheap pre-AI filter entirely (see cheapFilter.ts — that
 * filter exists to protect the AI budget from the auto-discovery firehose,
 * which doesn't apply when a human deliberately hands us one address) and
 * drops straight into DETECTED. From there the existing worker loop
 * (pipeline/orchestrator.ts) picks it up for the exact same classify ->
 * research -> score -> alert/watchlist -> trade-candidate -> entry pipeline
 * as anything auto-discovered — this function only ever gets a token *into*
 * that pipeline, it never trades or scores anything itself. That keeps
 * trading/api.ts's "no manual execution trigger" rule intact: the AI still
 * decides entry and whether to trade at all.
 */
export interface ManualSubmitResult {
  token: Token;
  // Tells the caller (the dashboard) whether this submission actually
  // triggered new work or just handed back a token that's genuinely
  // in-flight right now — without this, "mid-evaluation" and "freshly
  // queued" would render identically as "Queued X — status: Y".
  action: "CREATED" | "REQUEUED" | "ALREADY_IN_PROGRESS" | "BUY_AND_HOLD_WAITING";
}

function mergeManualProfile(rawProfile: unknown, submittedAt: string, buyAndHold: boolean): object {
  const base = rawProfile && typeof rawProfile === "object" && !Array.isArray(rawProfile) ? rawProfile as Record<string, unknown> : {};
  return { ...base, manual: true, submittedAt, manualBuyAndHold: buyAndHold || base.manualBuyAndHold === true };
}

async function queueManualBuyAndHold(token: Token): Promise<void> {
  const strategy = await getActiveStrategyVersion();
  const now = new Date();
  const candidate = await db.tradeCandidate.create({
    data: {
      tokenId: token.id,
      status: TradeCandidateStatus.WAITING,
      qualityScore: 50,
      researchConfidence: 50,
      qualificationPath: "MANUAL_BUY_AND_HOLD",
      tradeLane: "MOMENTUM_TACTICAL",
    },
  });
  const plan = await db.tradePlan.create({
    data: {
      candidateId: candidate.id,
      strategyVersionId: strategy.id,
      action: TradePlanAction.BUY_NOW,
      entryStyle: "MARKET_ENTRY",
      targetEntryMcapMin: 0,
      targetEntryMcapMax: Number.MAX_SAFE_INTEGER,
      riskScore: 100,
      confidence: 50,
      planData: {
        manualBuyAndHold: true,
        lossStopsDisabled: true,
        submittedAt: now.toISOString(),
        freshEval: { eligible: true, riskBucket: "HIGH", reasons: ["manual buy-and-hold override requested by the user"] },
        tradeLane: "MOMENTUM_TACTICAL",
        analysis: {
          marketRegime: "UNKNOWN",
          isExtended: false,
          recommendedAction: "BUY_NOW",
          entryStyle: "MARKET_ENTRY",
          riskScore: 100,
          confidence: 50,
          reasoning: ["Manual buy-and-hold override: wait for the normal entry monitor to validate and open the position."],
        },
      } as unknown as object,
    },
  });
  await db.pendingEntry.create({
    data: {
      tradePlanId: plan.id,
      status: PendingEntryStatus.ACTIVE,
      targetMcapMin: 0,
      targetMcapMax: Number.MAX_SAFE_INTEGER,
    },
  });
  await db.tradeDecisionSnapshot.create({
    data: {
      candidateId: candidate.id,
      decision: TradeDecision.WAIT,
      stage: "manual_buy_and_hold",
      strategyVersionId: strategy.id,
      marketState: {},
      projectState: { tokenAddress: token.address },
      technicalState: {},
      portfolioState: {},
      deterministicRules: { manualBuyAndHold: true, lossStopsDisabled: true },
      finalReasons: [
        "User requested manual buy-and-hold before evaluation.",
        "Queued directly as a pending entry; entry monitor still runs the normal pre-buy checks.",
      ],
    },
  });
}

export async function submitManualToken(rawAddress: string, options: { buyAndHold?: boolean } = {}): Promise<ManualSubmitResult> {
  const address = extractAddress(rawAddress);
  const buyAndHold = options.buyAndHold === true;

  const existing = await db.token.findUnique({
    where: { chain_address: { chain: config.targetChainId, address } },
    include: {
      tradeCandidates: { orderBy: { createdAt: "desc" }, take: 1 },
      trades: { where: { status: { in: Array.from(ACTIVE_TRADE_STATUSES) } }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  if (existing) {
    const latestCandidate = existing.tradeCandidates[0];
    const candidateInFlight = latestCandidate !== undefined && IN_FLIGHT_CANDIDATE_STATUSES.has(latestCandidate.status);
    const activeTrade = existing.trades[0] !== undefined;
    if (candidateInFlight || activeTrade || (!buyAndHold && IN_FLIGHT_TOKEN_STATUSES.has(existing.status))) {
      return { token: existing, action: "ALREADY_IN_PROGRESS" };
    }
    const reset = await db.token.update({
      where: { id: existing.id },
      data: {
        status: buyAndHold ? existing.status : TokenStatus.DETECTED,
        lastSeenAt: new Date(),
        manualReevaluationRequestedAt: buyAndHold ? null : new Date(),
        rawProfile: mergeManualProfile(existing.rawProfile, new Date().toISOString(), buyAndHold),
      },
    });
    if (buyAndHold) {
      await queueManualBuyAndHold(reset);
      logger.warn({ tokenId: reset.id, address }, "manual buy-and-hold submission queued directly as a pending entry");
      return { token: reset, action: "BUY_AND_HOLD_WAITING" };
    }
    logger.info({ tokenId: reset.id, address, previousStatus: existing.status }, "manual submission: re-queued a token for a fresh look");
    return { token: reset, action: "REQUEUED" };
  }

  let name: string | undefined;
  let symbol: string | undefined;
  try {
    const info = await getTokenNameSymbol(getPublicClient(), address);
    name = info.name;
    symbol = info.symbol;
  } catch (err) {
    logger.warn({ address, err: String(err) }, "manual submission: could not read token name/symbol");
  }

  // A manually-submitted CA otherwise skips DexScreener entirely, so the
  // classifier saw no icon/header/description regardless of what DexScreener
  // actually shows for the token — same fallback source discover.ts uses.
  const market = await researchMarket(config.targetChainId, address);

  const created = await db.token.create({
    data: {
      chain: config.targetChainId,
      address,
      name,
      symbol,
      iconUrl: market.primaryPair?.imageUrl,
      headerUrl: market.primaryPair?.headerUrl,
      status: TokenStatus.DETECTED,
      rawProfile: mergeManualProfile(null, new Date().toISOString(), buyAndHold),
    },
  });

  if (buyAndHold) {
    await queueManualBuyAndHold(created);
    logger.warn({ tokenId: created.id, address }, "manual buy-and-hold submission queued directly as a pending entry");
    return { token: created, action: "BUY_AND_HOLD_WAITING" };
  }

  logger.info({ tokenId: created.id, address }, "manually submitted token queued for AI evaluation");
  return { token: created, action: "CREATED" };
}

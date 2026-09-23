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

// Base58, no 0/O/I/l — matches Solana's alphabet and typical pubkey length.
const SOLANA_ADDRESS_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

/** Pulls a contract/mint address out of raw input — accepts a bare address or
 * something like a pasted DexScreener/explorer URL with the address in the
 * path. Chain is inferred from the address's own format (0x-prefixed hex vs.
 * base58), same distinction DexScreener itself uses, so no explicit chain
 * selector is needed from the caller. EVM addresses are lowercased (not
 * EIP-55 checksummed) to match discover.ts/onchainDiscovery.ts — our own
 * dedup constraint is a case-sensitive string compare, so a mixed
 * check-summed address here would silently create a duplicate row instead of
 * finding the real one. Solana addresses are case-sensitive and must not be
 * touched. Solana is only recognized once ENABLED_CHAINS actually includes
 * it — until then this behaves exactly as before. */
function extractAddress(input: string): { chain: string; address: string } {
  const trimmed = input.trim();
  if (isAddress(trimmed)) return { chain: config.targetChainId, address: getAddress(trimmed).toLowerCase() };
  const evmMatch = trimmed.match(/0x[a-fA-F0-9]{40}/);
  if (evmMatch && isAddress(evmMatch[0])) return { chain: config.targetChainId, address: getAddress(evmMatch[0]).toLowerCase() };
  if (config.enabledChains.includes("solana")) {
    const solanaMatch = trimmed.match(SOLANA_ADDRESS_RE);
    if (solanaMatch) return { chain: "solana", address: solanaMatch[0] };
  }
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

// User directive 2026-09-23: "are you stupid?? now it buys only $1.66 all
// the time for all entries" — traced to these placeholder scores, not the
// gas-viable floor. calculatePositionSize's fixed multiplier stack for a
// manual submission was riskBucket=HIGH (0.5x) * qualityScore=50 (0.95x) *
// confidence=50 (0.9x) * entryRiskScore=100, i.e. the WORST possible
// reading (0.5x) * lane=0.75x — a combined ~0.16x on top of the base
// allocation, before liquidity/mcap even get a say. That's not "unknown, be
// cautious" — riskBucket HIGH and entryRiskScore 100 are the single worst
// value each scale allows, applied to every manual pick regardless of how
// good it actually is. A human choosing to buy-and-hold a specific token is
// closer to a MEDIUM-conviction, not-yet-independently-researched pick than
// to "the worst candidate this system has ever seen" — sized accordingly
// now (riskBucket MEDIUM = 1.0x, quality/confidence 70, entryRiskScore 45
// ~1.0x) rather than reflexively worst-cased. Liquidity/market-cap still
// vary this per token exactly as before; this only fixes the constant part
// that was flooring every manual trade to the same tiny number regardless
// of the token.
async function queueManualBuyAndHold(token: Token): Promise<void> {
  const strategy = await getActiveStrategyVersion();
  const now = new Date();
  const candidate = await db.tradeCandidate.create({
    data: {
      tokenId: token.id,
      status: TradeCandidateStatus.WAITING,
      qualityScore: 70,
      researchConfidence: 70,
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
      riskScore: 45,
      confidence: 70,
      planData: {
        manualBuyAndHold: true,
        submittedAt: now.toISOString(),
        freshEval: { eligible: true, riskBucket: "MEDIUM", reasons: ["manual buy-and-hold override requested by the user"] },
        tradeLane: "MOMENTUM_TACTICAL",
        analysis: {
          marketRegime: "UNKNOWN",
          isExtended: false,
          recommendedAction: "BUY_NOW",
          entryStyle: "MARKET_ENTRY",
          riskScore: 45,
          confidence: 70,
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
      deterministicRules: { manualBuyAndHold: true, forcedIntoWaiting: true },
      finalReasons: [
        "User requested manual buy-and-hold before evaluation.",
        "Queued directly as a pending entry; once opened, normal exit rules apply.",
      ],
    },
  });
}

export async function submitManualToken(rawAddress: string, options: { buyAndHold?: boolean } = {}): Promise<ManualSubmitResult> {
  const { chain, address } = extractAddress(rawAddress);
  const buyAndHold = options.buyAndHold === true;

  const existing = await db.token.findUnique({
    where: { chain_address: { chain, address } },
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
  // getTokenNameSymbol reads via viem/EVM RPC — no Solana equivalent yet
  // (see src/trading/live/tokenUtils.ts). Left undefined for Solana for now;
  // researchMarket below still supplies icon/header for classification, and
  // the classifier itself sources a name from DexScreener metadata too.
  if (chain === config.targetChainId) {
    try {
      const info = await getTokenNameSymbol(getPublicClient(), address as `0x${string}`);
      name = info.name;
      symbol = info.symbol;
    } catch (err) {
      logger.warn({ address, err: String(err) }, "manual submission: could not read token name/symbol");
    }
  }

  // A manually-submitted CA otherwise skips DexScreener entirely, so the
  // classifier saw no icon/header/description regardless of what DexScreener
  // actually shows for the token — same fallback source discover.ts uses.
  const market = await researchMarket(chain, address);

  const created = await db.token.create({
    data: {
      chain,
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

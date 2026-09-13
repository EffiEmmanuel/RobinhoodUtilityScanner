import { isAddress, getAddress } from "viem";
import { db } from "../db";
import { config } from "../config";
import { logger } from "../logger";
import { getPublicClient } from "../trading/live/wallet";
import { getTokenNameSymbol } from "../trading/live/tokenUtils";
import { researchMarket } from "../research/market";
import { TokenStatus, TradeCandidateStatus } from "../generated/prisma";
import type { Token } from "../generated/prisma";

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
  action: "CREATED" | "REQUEUED" | "ALREADY_IN_PROGRESS";
}

export async function submitManualToken(rawAddress: string): Promise<ManualSubmitResult> {
  const address = extractAddress(rawAddress);

  const existing = await db.token.findUnique({
    where: { chain_address: { chain: config.targetChainId, address } },
    include: { tradeCandidates: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  if (existing) {
    const latestCandidate = existing.tradeCandidates[0];
    const candidateInFlight = latestCandidate !== undefined && IN_FLIGHT_CANDIDATE_STATUSES.has(latestCandidate.status);
    if (IN_FLIGHT_TOKEN_STATUSES.has(existing.status) || candidateInFlight) {
      return { token: existing, action: "ALREADY_IN_PROGRESS" };
    }
    const reset = await db.token.update({
      where: { id: existing.id },
      data: { status: TokenStatus.DETECTED, lastSeenAt: new Date(), manualReevaluationRequestedAt: new Date() },
    });
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
      rawProfile: { manual: true, submittedAt: new Date().toISOString() },
    },
  });

  logger.info({ tokenId: created.id, address }, "manually submitted token queued for AI evaluation");
  return { token: created, action: "CREATED" };
}

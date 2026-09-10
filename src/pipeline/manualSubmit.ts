import { isAddress, getAddress } from "viem";
import { db } from "../db";
import { config } from "../config";
import { logger } from "../logger";
import { getPublicClient } from "../trading/live/wallet";
import { getTokenNameSymbol } from "../trading/live/tokenUtils";
import { TokenStatus } from "../generated/prisma";
import type { Token } from "../generated/prisma";

// A human pasting a CA in has already vouched for it, so a manual submission
// re-queues even a token the automated pipeline previously gave up on.
// Anything else (already mid-pipeline, or already scored) is left alone.
const REPROCESSABLE_STATUSES = new Set<TokenStatus>([TokenStatus.REJECTED, TokenStatus.FAILED]);

/** Pulls a 0x address out of raw input — accepts a bare address or something
 * like a pasted DexScreener/explorer URL with the address in the path. */
function extractAddress(input: string): `0x${string}` {
  const trimmed = input.trim();
  if (isAddress(trimmed)) return getAddress(trimmed);
  const match = trimmed.match(/0x[a-fA-F0-9]{40}/);
  if (match && isAddress(match[0])) return getAddress(match[0]);
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
export async function submitManualToken(rawAddress: string): Promise<Token> {
  const address = extractAddress(rawAddress);

  const existing = await db.token.findUnique({
    where: { chain_address: { chain: config.targetChainId, address } },
  });

  if (existing) {
    if (!REPROCESSABLE_STATUSES.has(existing.status)) {
      return existing; // already in flight or already evaluated — nothing to do
    }
    const reset = await db.token.update({
      where: { id: existing.id },
      data: { status: TokenStatus.DETECTED, lastSeenAt: new Date() },
    });
    logger.info({ tokenId: reset.id, address }, "manual submission: re-queued a previously rejected/failed token");
    return reset;
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

  const created = await db.token.create({
    data: {
      chain: config.targetChainId,
      address,
      name,
      symbol,
      status: TokenStatus.DETECTED,
      rawProfile: { manual: true, submittedAt: new Date().toISOString() },
    },
  });

  logger.info({ tokenId: created.id, address }, "manually submitted token queued for AI evaluation");
  return created;
}

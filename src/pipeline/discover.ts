import { fetchLatestTokenProfiles } from "../dex/client";
import { researchMarket } from "../research/market";
import { config } from "../config";
import { db } from "../db";
import { logger } from "../logger";
import { cheapFilter } from "./cheapFilter";
import { TokenStatus } from "../generated/prisma";
import { getPublicClient } from "../trading/live/wallet";
import { getAdjustedTotalSupply } from "../trading/live/tokenUtils";

/**
 * FR-001/FR-002/FR-003/FR-004: poll DexScreener, keep only the target chain,
 * upsert into Token (dedup key: chain+address), and run the cheap filter.
 * Passing tokens are left in DETECTED status for the worker loop to classify;
 * failing tokens go straight to REJECTED without ever touching the AI layer.
 */
export async function runDiscoveryPoll(): Promise<{ seen: number; created: number }> {
  try {
    await expireStaleAwaitingProfile();
  } catch (err) {
    logger.error({ err: String(err) }, "failed to expire stale AWAITING_DEX_PROFILE tokens");
  }

  let profiles;
  try {
    profiles = await fetchLatestTokenProfiles();
  } catch (err) {
    logger.error({ err: String(err) }, "discovery poll failed to fetch DexScreener profiles");
    return { seen: 0, created: 0 };
  }

  const onChain = profiles.filter((p) => p.chainId === config.targetChainId);
  let created = 0;

  for (const rawProfile of onChain) {
    // Ethereum addresses are case-insensitive (EIP-55 checksum casing is a
    // display convention, not a distinct address) but our unique constraint
    // is a plain case-sensitive string compare — normalizing here is what
    // makes the dedup check across this path and onchainDiscovery.ts's
    // (which gets checksummed casing from viem) actually catch the same
    // real contract, instead of creating a second row and re-spending AI
    // calls on a token we already have.
    const profile = { ...rawProfile, tokenAddress: rawProfile.tokenAddress.toLowerCase() };
    const existing = await db.token.findUnique({
      where: { chain_address: { chain: profile.chainId, address: profile.tokenAddress } },
    });

    if (existing && existing.status !== TokenStatus.AWAITING_DEX_PROFILE) {
      await db.token.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date() },
      });
      continue;
    }

    // DexScreener token-profiles don't include name/symbol — only the
    // pair/market endpoint does (via baseToken). Look it up once, up front,
    // since the cheap filter and classifier both need a real name to work with.
    const market = await researchMarket(profile.chainId, profile.tokenAddress);
    const name = market.primaryPair?.baseTokenName;
    const symbol = market.primaryPair?.baseTokenSymbol;

    let adjustedTotalSupply: number | undefined;
    try {
      adjustedTotalSupply = await getAdjustedTotalSupply(getPublicClient(), profile.tokenAddress as `0x${string}`);
    } catch (err) {
      logger.warn({ address: profile.tokenAddress, err: String(err) }, "discovery: could not read token total supply");
    }

    const filter = cheapFilter(profile, name, adjustedTotalSupply);
    const data = {
      name,
      symbol,
      iconUrl: profile.icon,
      headerUrl: profile.header,
      description: profile.description,
      rawProfile: profile as unknown as object,
      status: filter.passed ? TokenStatus.DETECTED : TokenStatus.REJECTED,
    };

    if (existing) {
      // Was sitting in AWAITING_DEX_PROFILE from onchainDiscovery.ts — a real
      // DexScreener profile just showed up for it, so this is exactly the
      // signal that promotes it into AI review (or rejects it, same as any
      // other profile that fails the cheap filter) instead of another
      // unrelated on-chain clone quietly claiming the row via a race.
      await db.token.update({ where: { id: existing.id }, data });
      logger.info(
        { address: profile.tokenAddress, passed: filter.passed, reasons: filter.reasons },
        "on-chain-discovered token confirmed by a real DexScreener profile"
      );
    } else {
      await db.token.create({ data: { chain: profile.chainId, address: profile.tokenAddress, ...data } });
      created++;
      logger.info(
        { address: profile.tokenAddress, passed: filter.passed, reasons: filter.reasons },
        "discovered new Robinhood Chain token"
      );
    }
  }

  return { seen: onChain.length, created };
}

/**
 * A token that never gets a real DexScreener profile within this window is
 * treated as exactly what it almost always is at this volume: an on-chain
 * copycat/clone nobody bothered to promote. Rejecting it here means it never
 * costs a classification call — the whole point of the AWAITING_DEX_PROFILE
 * gate (see onchainDiscovery.ts). Cheap enough to run every discovery poll.
 */
export async function expireStaleAwaitingProfile(): Promise<number> {
  const cutoff = new Date(Date.now() - config.awaitingDexProfileExpiryHours * 3_600_000);
  const result = await db.token.updateMany({
    where: { status: TokenStatus.AWAITING_DEX_PROFILE, firstSeenAt: { lt: cutoff } },
    data: { status: TokenStatus.REJECTED },
  });
  if (result.count > 0) {
    logger.info({ count: result.count, expiryHours: config.awaitingDexProfileExpiryHours }, "expired stale AWAITING_DEX_PROFILE tokens with no real profile");
  }
  return result.count;
}

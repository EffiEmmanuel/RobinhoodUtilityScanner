import { fetchLatestTokenProfiles } from "../dex/client";
import { researchMarket } from "../research/market";
import { config } from "../config";
import { db } from "../db";
import { logger } from "../logger";
import { cheapFilter } from "./cheapFilter";
import { TokenStatus } from "../generated/prisma";

/**
 * FR-001/FR-002/FR-003/FR-004: poll DexScreener, keep only the target chain,
 * upsert into Token (dedup key: chain+address), and run the cheap filter.
 * Passing tokens are left in DETECTED status for the worker loop to classify;
 * failing tokens go straight to REJECTED without ever touching the AI layer.
 */
export async function runDiscoveryPoll(): Promise<{ seen: number; created: number }> {
  let profiles;
  try {
    profiles = await fetchLatestTokenProfiles();
  } catch (err) {
    logger.error({ err: String(err) }, "discovery poll failed to fetch DexScreener profiles");
    return { seen: 0, created: 0 };
  }

  const onChain = profiles.filter((p) => p.chainId === config.targetChainId);
  let created = 0;

  for (const profile of onChain) {
    const existing = await db.token.findUnique({
      where: { chain_address: { chain: profile.chainId, address: profile.tokenAddress } },
    });

    if (existing) {
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

    const filter = cheapFilter(profile, name);

    await db.token.create({
      data: {
        chain: profile.chainId,
        address: profile.tokenAddress,
        name,
        symbol,
        iconUrl: profile.icon,
        headerUrl: profile.header,
        description: profile.description,
        rawProfile: profile as unknown as object,
        status: filter.passed ? TokenStatus.DETECTED : TokenStatus.REJECTED,
      },
    });
    created++;

    logger.info(
      { address: profile.tokenAddress, passed: filter.passed, reasons: filter.reasons },
      "discovered new Robinhood Chain token"
    );
  }

  return { seen: onChain.length, created };
}

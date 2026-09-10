import { fetchLatestTokenProfiles } from "../dex/client";
import { researchMarket } from "../research/market";
import { config } from "../config";
import { db } from "../db";
import { logger } from "../logger";
import { cheapFilter } from "./cheapFilter";
import { TokenStatus } from "../generated/prisma";
import { getPublicClient } from "../trading/live/wallet";
import { getAdjustedTotalSupply } from "../trading/live/tokenUtils";
import { searchXForContractAddress } from "../research/xSearch";

// A much lower bar than the full promotion threshold — just "has any real
// trading happened at all", to decide whether a token is even worth
// spending a metered X API call on. Most on-chain clones never clear this.
const MIN_LIQUIDITY_USD_WORTH_AN_X_CHECK = 1000;

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

/**
 * The aggressive complement to waiting on a submitted profile: a token that
 * never gets one but is already trading with real liquidity and a real
 * transaction count almost certainly has organic interest behind it — that's
 * public DexScreener market data, free regardless of profile status, so
 * there's no reason to let it sit until it either gets a profile or expires.
 * A brief minimum age first (awaitingProfileMinAgeMinutes) avoids mistaking a
 * deployer's own seed liquidity/self-trades for real activity.
 */
export async function promoteActiveAwaitingProfile(): Promise<{ checked: number; promoted: number; xChecked: number }> {
  const cutoff = new Date(Date.now() - config.awaitingProfileMinAgeMinutes * 60_000);
  const candidates = await db.token.findMany({
    where: { status: TokenStatus.AWAITING_DEX_PROFILE, firstSeenAt: { lte: cutoff } },
    // Least-recently-checked first (lastSeenAt doubles as "last time this
    // sweep actually looked at it" — see the touch-on-every-check below),
    // not firstSeenAt. A backlog bigger than one sweep's cap still rotates
    // fairly this way instead of a fixed subset at the front of the queue
    // permanently starving everything behind it until the 24h expiry.
    orderBy: { lastSeenAt: "asc" },
    take: 100, // bounds cost per sweep regardless of backlog size
  });

  let promoted = 0;
  let xChecked = 0;
  // Collected instead of X-searched immediately, so the (small, metered)
  // X budget goes to whichever candidates look most promising this sweep,
  // not just whichever happened to be claimed first.
  const xCandidates: { token: (typeof candidates)[number]; liquidityUsd: number }[] = [];

  for (const token of candidates) {
    let market;
    try {
      market = await researchMarket(token.chain, token.address);
    } catch (err) {
      logger.warn({ tokenId: token.id, address: token.address, err: String(err) }, "activity check: could not fetch market data");
      continue; // leave lastSeenAt untouched so a fetch failure gets retried sooner, not pushed to the back of the queue
    }
    const pair = market.primaryPair;
    if (!pair) continue;

    const hourlyTxns = (pair.buys1h ?? 0) + (pair.sells1h ?? 0);
    const liquidityUsd = pair.liquidityUsd ?? 0;
    if (liquidityUsd >= config.awaitingProfileMinLiquidityUsd && hourlyTxns >= config.awaitingProfileMinHourlyTxns) {
      await db.token.update({ where: { id: token.id }, data: { status: TokenStatus.DETECTED } });
      promoted++;
      logger.info(
        { tokenId: token.id, address: token.address, liquidityUsd, hourlyTxns },
        "promoted AWAITING_DEX_PROFILE token to AI review on real trading activity — no profile ever submitted"
      );
    } else if (liquidityUsd >= MIN_LIQUIDITY_USD_WORTH_AN_X_CHECK && !token.xCheckedAt && config.xBearerToken) {
      xCandidates.push({ token, liquidityUsd });
    } else {
      // Checked this sweep, still not active enough to promote or X-check —
      // touch lastSeenAt so it's provably "just checked, still waiting" (not
      // stuck/ignored) and rotates to the back of the next sweep's queue.
      await db.token.update({ where: { id: token.id }, data: { lastSeenAt: new Date() } });
    }
  }

  // Highest liquidity first — that's the limited budget going to whichever
  // waiting tokens look most likely to actually be worth it.
  xCandidates.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  for (const { token } of xCandidates.slice(0, config.xSearchMaxPerSweep)) {
    const result = await searchXForContractAddress(token.address);
    xChecked++;
    await db.token.update({
      where: { id: token.id },
      data: { xCheckedAt: new Date(), xFindings: result as unknown as object },
    });

    // Deliberately promotes on any real mention, not just ones clearing an
    // engagement bar: a hardcoded threshold can't tell a genuinely new,
    // quiet project apart from bought/fake engagement any better than it can
    // tell a real one from bot noise. That nuanced call belongs to the
    // research AI, which gets the full account/engagement evidence via
    // formatXFindingsForPrompt — this gate's only job is deciding whether a
    // token is worth that AI's attention at all.
    if (result.found) {
      await db.token.update({ where: { id: token.id }, data: { status: TokenStatus.DETECTED } });
      promoted++;
      logger.info(
        { tokenId: token.id, address: token.address, tweetCount: result.tweetCount, totalEngagement: result.totalEngagement, accounts: result.accounts.map((a) => a.username) },
        "promoted AWAITING_DEX_PROFILE token to AI review — real X activity found for this exact contract address"
      );
    } else {
      logger.info({ tokenId: token.id, address: token.address, error: result.error }, "X search found no activity for this exact contract address — not promoted");
    }
  }

  if (candidates.length > 0) {
    logger.info({ checked: candidates.length, promoted, xChecked }, "checked AWAITING_DEX_PROFILE tokens for organic activity");
  }
  return { checked: candidates.length, promoted, xChecked };
}

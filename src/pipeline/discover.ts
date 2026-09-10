import { fetchLatestTokenProfiles } from "../dex/client";
import { researchMarket } from "../research/market";
import { config } from "../config";
import { db } from "../db";
import { logger } from "../logger";
import { cheapFilter } from "./cheapFilter";
import { TokenStatus, Prisma } from "../generated/prisma";
import type { Token } from "../generated/prisma";
import { getPublicClient } from "../trading/live/wallet";
import { getAdjustedTotalSupply } from "../trading/live/tokenUtils";
import { searchXForContractAddress } from "../research/xSearch";
import type { DiscoveredTokenProfile } from "../dex/types";

/**
 * A REJECTED token's DexScreener profile can change after the fact — a
 * project adds a real icon, description, or website/social link days after
 * launch. discover.ts only ever sees a token again when DexScreener's own
 * "latest updated profiles" feed surfaces it (that's the poll this function
 * feeds), so this only needs to compare against what we already stored, not
 * poll anything extra. Only additions count — a field disappearing isn't
 * "new signal" worth spending another classification call on.
 */
function diffTokenProfile(
  existing: Pick<Token, "iconUrl" | "headerUrl" | "description" | "rawProfile">,
  profile: DiscoveredTokenProfile
): string[] {
  const changed: string[] = [];
  if (!existing.iconUrl && profile.icon) changed.push("icon");
  if (!existing.headerUrl && profile.header) changed.push("header");
  if (!existing.description && profile.description) changed.push("description");
  const prevLinks = ((existing.rawProfile as { links?: { url: string }[] } | null)?.links ?? []).map((l) => l.url).sort();
  const newLinks = (profile.links ?? []).map((l) => l.url).sort();
  if (newLinks.length > prevLinks.length) changed.push("links");
  return changed;
}

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

    // Only a REJECTED token gets re-examined on a profile change — anything
    // mid-pipeline or already WATCHLISTED/ALERTED has its own lifecycle and
    // shouldn't be disturbed by a routine poll just because it happens to
    // reappear in DexScreener's "latest updated" feed.
    const changedFields =
      existing && existing.status === TokenStatus.REJECTED ? diffTokenProfile(existing, profile) : [];

    if (existing && existing.status !== TokenStatus.AWAITING_DEX_PROFILE && changedFields.length === 0) {
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
      // profile.icon/header come from the narrow token-profiles "submitted
      // profile" feed, which most legitimate tokens never populate. Fall back
      // to the pair/market endpoint's info.imageUrl/header (market.primaryPair)
      // — what DexScreener's own token page actually renders an icon from for
      // virtually any pair — instead of treating "no submitted profile" as "no
      // image" (see FR-005/FR-007 classification, which otherwise wrongly
      // scores real projects as having no visual assets).
      iconUrl: profile.icon ?? market.primaryPair?.imageUrl,
      headerUrl: profile.header ?? market.primaryPair?.headerUrl,
      description: profile.description,
      rawProfile: profile as unknown as object,
      status: filter.passed ? TokenStatus.DETECTED : TokenStatus.REJECTED,
      cheapFilterReasons: filter.passed ? Prisma.JsonNull : (filter.reasons as unknown as object),
    };

    if (existing) {
      // Was sitting in AWAITING_DEX_PROFILE from onchainDiscovery.ts — a real
      // DexScreener profile just showed up for it, so this is exactly the
      // signal that promotes it into AI review (or rejects it, same as any
      // other profile that fails the cheap filter) instead of another
      // unrelated on-chain clone quietly claiming the row via a race.
      await db.token.update({ where: { id: existing.id }, data });
      if (changedFields.length > 0) {
        await db.profileUpdate.create({
          data: {
            tokenId: existing.id,
            changedFields: changedFields as unknown as object,
            previousProfile: existing.rawProfile ?? Prisma.JsonNull,
            newProfile: profile as unknown as object,
          },
        });
        logger.info(
          { tokenId: existing.id, address: profile.tokenAddress, changedFields, passed: filter.passed },
          "previously-rejected token's DexScreener profile changed — requeued into the AI pipeline"
        );
      } else {
        logger.info(
          { address: profile.tokenAddress, passed: filter.passed, reasons: filter.reasons },
          "on-chain-discovered token confirmed by a real DexScreener profile"
        );
      }
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
    // The real bug this was missing: DexScreener renders a real icon/header/
    // website/social presence on a token's page (via the pair endpoint's
    // `info` field) for virtually any pair, entirely independent of the
    // narrow "submitted a token-profile" product this whole AWAITING state
    // exists to wait for (see discover.ts's main-loop comment on `info.*`).
    // A token can sit here forever with $0 activity yet a fully real,
    // browsable DexScreener page — confirmed live (Sonera and hundreds of
    // others). This checks the actual signal instead of only a liquidity/
    // volume proxy for it.
    const hasRealProfile = Boolean(pair.imageUrl || pair.headerUrl || pair.websites.length > 0 || pair.socials.length > 0);
    const hasRealActivity = liquidityUsd >= config.awaitingProfileMinLiquidityUsd && hourlyTxns >= config.awaitingProfileMinHourlyTxns;
    if (hasRealProfile || hasRealActivity) {
      // Populate the same profile fields discover.ts's main loop and
      // manualSubmit.ts already fall back to — without this, a token
      // promoted here still reaches classification blind (icon/header/
      // description null), the exact bug already fixed for the other two
      // discovery paths but missed here.
      await db.token.update({
        where: { id: token.id },
        data: {
          status: TokenStatus.DETECTED,
          iconUrl: pair.imageUrl,
          headerUrl: pair.headerUrl,
          rawProfile: {
            source: "token-pairs-info-fallback",
            chainId: token.chain,
            tokenAddress: token.address,
            icon: pair.imageUrl,
            header: pair.headerUrl,
            links: [
              ...pair.websites.map((url) => ({ type: "website", url })),
              ...pair.socials.map((s) => ({ type: s.type, url: s.url })),
            ],
          } as unknown as object,
        },
      });
      promoted++;
      logger.info(
        { tokenId: token.id, address: token.address, liquidityUsd, hourlyTxns, hasRealProfile, hasRealActivity },
        `promoted AWAITING_DEX_PROFILE token to AI review on ${hasRealProfile ? "a real DexScreener profile" : "real trading activity"}`
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

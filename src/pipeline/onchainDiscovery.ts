import { getPublicClient } from "../trading/live/wallet";
import { UNISWAP_V4_ADDRESSES, NATIVE_ETH_CURRENCY, POOL_MANAGER_ABI } from "../trading/live/contracts";
import { getTokenNameSymbol, getAdjustedTotalSupply } from "../trading/live/tokenUtils";
import { config } from "../config";
import { db } from "../db";
import { logger } from "../logger";
import { cheapFilterOnchain } from "./cheapFilter";
import { TokenStatus } from "../generated/prisma";
import { fetchMarketForToken } from "../dex/client";

/**
 * Watches PoolManager's own Initialize events directly on-chain — far faster
 * than waiting on DexScreener to index a new pair, but confirmed live to be
 * mostly copycat/spam noise (a single trending name had 11 bare on-chain
 * clones to 1 real, DexScreener-profiled project). A token found this way
 * does NOT go to AI: it lands in AWAITING_DEX_PROFILE and only becomes
 * eligible for classification once discover.ts's DexScreener poll confirms
 * a real profile for the same address (see enrichAwaitingProfile there) — the
 * quality bar itself is unchanged, this only gates *when* AI ever gets
 * involved. Anything that never gets a DexScreener profile within
 * config.awaitingDexProfileExpiryHours is swept to REJECTED by
 * expireStaleAwaitingProfile() instead of sitting in limbo forever.
 */
let lastProcessedBlock: bigint | undefined;

export async function runOnchainDiscoveryPoll(): Promise<{ scanned: number; created: number }> {
  const client = getPublicClient();
  const latest = await client.getBlockNumber();

  if (lastProcessedBlock === undefined) {
    // No historical backfill on first run — DexScreener discovery already
    // covers catch-up for anything created before this process started.
    lastProcessedBlock = latest > 0n ? latest - 1n : 0n;
    return { scanned: 0, created: 0 };
  }
  if (latest <= lastProcessedBlock) return { scanned: 0, created: 0 };

  const fromBlock = lastProcessedBlock + 1n;
  const toBlock = latest;

  const logs = await client.getLogs({
    address: UNISWAP_V4_ADDRESSES.poolManager as `0x${string}`,
    event: POOL_MANAGER_ABI[0],
    args: { currency0: NATIVE_ETH_CURRENCY },
    fromBlock,
    toBlock,
  });
  lastProcessedBlock = toBlock;

  let created = 0;
  const seenThisBatch = new Set<string>();

  for (const log of logs) {
    const rawAddress = (log.args as { currency1?: `0x${string}` }).currency1;
    if (!rawAddress) continue;
    // Normalized once, used everywhere below — RPC calls are case-insensitive
    // regardless, but our own DB uniqueness isn't, and viem returns this
    // EIP-55 checksummed while DexScreener returns it lowercase. Without this,
    // the same real contract can end up as two separate rows (confirmed live:
    // 67 duplicate tokens from exactly this casing mismatch), each re-paying
    // for its own classification/research.
    const tokenAddress = rawAddress.toLowerCase() as `0x${string}`;
    if (seenThisBatch.has(tokenAddress)) continue;
    seenThisBatch.add(tokenAddress);

    const existing = await db.token.findUnique({
      where: { chain_address: { chain: config.targetChainId, address: tokenAddress } },
    });
    if (existing) continue; // already known — from DexScreener or an earlier on-chain hit

    let name: string | undefined;
    let symbol: string | undefined;
    try {
      const info = await getTokenNameSymbol(client, tokenAddress);
      name = info.name;
      symbol = info.symbol;
    } catch (err) {
      logger.warn({ tokenAddress, err: String(err) }, "on-chain discovery: could not read token name/symbol");
    }

    // A deterministic, pre-AI meme-coin signal (§ cheapFilter's
    // MEME_SUPPLY_THRESHOLD) — cuts obvious joke-supply tokens before they
    // ever cost a classification call, which is most of them at this volume.
    let adjustedTotalSupply: number | undefined;
    try {
      adjustedTotalSupply = await getAdjustedTotalSupply(client, tokenAddress);
    } catch (err) {
      logger.warn({ tokenAddress, err: String(err) }, "on-chain discovery: could not read token total supply");
    }

    const filter = cheapFilterOnchain(tokenAddress, name, adjustedTotalSupply);

    // Query DexScreener directly for every qualifying token, immediately —
    // not just Uniswap's own on-chain event. A real, indexed DexScreener pair
    // (icon/header/website/social via the pair endpoint's `info` field) is
    // often available within seconds of pool creation for a genuine project,
    // entirely independent of the separate "submitted profile" product the
    // AWAITING_DEX_PROFILE wait was built around. Confirmed live: hundreds of
    // tokens sat parked 20+ minutes to 24 hours despite DexScreener already
    // showing a real profile the moment they were checked manually. Checking
    // here — once, at discovery — is what actually gets a legitimate token to
    // the AI pipeline promptly instead of only via the later periodic sweep
    // (promoteActiveAwaitingProfile, which still exists as the fallback for
    // tokens DexScreener genuinely hasn't indexed yet).
    let status: TokenStatus = filter.passed ? TokenStatus.AWAITING_DEX_PROFILE : TokenStatus.REJECTED;
    let iconUrl: string | undefined;
    let headerUrl: string | undefined;
    let rawProfile: object | undefined;

    if (filter.passed) {
      try {
        const market = await fetchMarketForToken(config.targetChainId, tokenAddress);
        const pair = market.primaryPair;
        const hasRealProfile = Boolean(pair?.imageUrl || pair?.headerUrl || (pair?.websites.length ?? 0) > 0 || (pair?.socials.length ?? 0) > 0);
        if (pair && hasRealProfile) {
          status = TokenStatus.DETECTED;
          iconUrl = pair.imageUrl;
          headerUrl = pair.headerUrl;
          rawProfile = {
            source: "token-pairs-info-fallback-immediate",
            chainId: config.targetChainId,
            tokenAddress,
            icon: pair.imageUrl,
            header: pair.headerUrl,
            links: [
              ...pair.websites.map((url) => ({ type: "website", url })),
              ...pair.socials.map((s) => ({ type: s.type, url: s.url })),
            ],
          };
        }
      } catch (err) {
        logger.warn({ tokenAddress, err: String(err) }, "on-chain discovery: immediate DexScreener check failed — falling back to AWAITING_DEX_PROFILE");
      }
    }

    try {
      await db.token.create({
        data: {
          chain: config.targetChainId,
          address: tokenAddress,
          name,
          symbol,
          status,
          iconUrl,
          headerUrl,
          rawProfile,
          cheapFilterReasons: filter.passed ? undefined : (filter.reasons as unknown as object),
        },
      });
      created++;
    } catch (err) {
      // P2002 unique-constraint race against the DexScreener discovery loop
      // creating the same (chain, address) row at nearly the same instant —
      // harmless, whichever path won is fine.
      if ((err as { code?: string })?.code !== "P2002") throw err;
      continue;
    }

    logger.info(
      { address: tokenAddress, source: "onchain", passed: filter.passed, reasons: filter.reasons },
      "discovered new Robinhood Chain token via on-chain pool creation"
    );
  }

  return { scanned: logs.length, created };
}

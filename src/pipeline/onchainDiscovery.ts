import { getPublicClient } from "../trading/live/wallet";
import { UNISWAP_V4_ADDRESSES, NATIVE_ETH_CURRENCY, POOL_MANAGER_ABI } from "../trading/live/contracts";
import { getTokenNameSymbol, getAdjustedTotalSupply } from "../trading/live/tokenUtils";
import { config } from "../config";
import { db } from "../db";
import { logger } from "../logger";
import { cheapFilterOnchain } from "./cheapFilter";
import { TokenStatus } from "../generated/prisma";

/**
 * Watches PoolManager's own Initialize events directly on-chain instead of
 * waiting on DexScreener to index a new pair — the same mechanism
 * poolDiscovery.ts uses to find a specific token's pool, run continuously
 * for every new ETH-paired pool instead. This exists purely to shrink the
 * detection-to-research latency: it does NOT relax the quality bar anywhere
 * downstream — a token found this way goes through the exact same
 * cheap-filter/classify/research/candidate pipeline as one found via
 * DexScreener, just starting sooner. DexScreener discovery keeps running
 * unchanged as a second, independent path (and the natural catch-up for
 * anything this misses, e.g. during a restart gap).
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
    const tokenAddress = (log.args as { currency1?: `0x${string}` }).currency1;
    if (!tokenAddress) continue;
    const key = tokenAddress.toLowerCase();
    if (seenThisBatch.has(key)) continue;
    seenThisBatch.add(key);

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

    try {
      await db.token.create({
        data: {
          chain: config.targetChainId,
          address: tokenAddress,
          name,
          symbol,
          status: filter.passed ? TokenStatus.DETECTED : TokenStatus.REJECTED,
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

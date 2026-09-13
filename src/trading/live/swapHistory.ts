import { getAddress, type PublicClient } from "viem";
import { logger } from "../../logger";
import { tradingConfig } from "../config";
import { getEthPriceUsd } from "../portfolio";
import { UNISWAP_V4_ADDRESSES, POOL_MANAGER_ABI } from "./contracts";
import { discoverPool, LOG_SCAN_MAX_CHUNKS } from "./poolDiscovery";
import { getAdjustedTotalSupply, getTokenDecimals } from "./tokenUtils";

export interface SwapHistorySummary {
  poolId: `0x${string}`;
  dataPoints: number;
  swingHighMcap?: number;
  swingLowMcap?: number;
  supportLevels?: { mcap: number; touches: number }[];
  resistanceLevels?: { mcap: number; touches: number }[];
  earliestBlock: bigint;
  latestScannedBlock: bigint;
  stale: boolean;
}

interface CachedSwapHistory {
  poolId: `0x${string}`;
  tokenDecimals: number;
  dataPoints: number;
  swingHighPriceInEth?: number;
  swingLowPriceInEth?: number;
  earliestBlock: bigint;
  latestScannedBlock: bigint;
}

interface SwapLog {
  blockNumber: bigint | null;
  logIndex: number | null;
  args?: {
    sqrtPriceX96?: unknown;
  };
}

const swapHistoryCache = new Map<`0x${string}`, CachedSwapHistory>();

// price of the token (currency1) in ETH (currency0), decimals-adjusted
function sqrtPriceX96ToTokenPriceInEth(sqrtPriceX96: bigint, tokenDecimals: number): number {
  const Q96 = 2 ** 96;
  const raw = (Number(sqrtPriceX96) / Q96) ** 2;
  return raw * 10 ** (tokenDecimals - 18); // currency0 (ETH) is always 18 decimals
}

export async function getOnChainSwapHistory(
  client: PublicClient,
  tokenAddress: `0x${string}`,
  currentMcap: number | undefined,
  currentPriceUsd: number | undefined,
  options: { allowHighFeePools?: boolean } = {}
): Promise<SwapHistorySummary | undefined> {
  const token = getAddress(tokenAddress);
  const pool = await discoverPool(client, token, options);
  if (!pool) return undefined;

  let cached = swapHistoryCache.get(pool.poolId);
  let stale = false;

  if (!cached) {
    const [tokenDecimals, latestBlock] = await Promise.all([getTokenDecimals(client, token), client.getBlockNumber()]);
    const scan =
      pool.initializedAtBlock !== undefined
        ? await scanSwapLogsForward(client, pool.poolId, pool.initializedAtBlock, latestBlock)
        : await scanSwapLogsBackward(client, pool.poolId, latestBlock);

    cached = buildCachedHistory(pool.poolId, tokenDecimals, scan.logs, scan.earliestBlock, scan.latestScannedBlock);
    swapHistoryCache.set(pool.poolId, cached);
  } else {
    const latestBlock = await client.getBlockNumber();
    if (latestBlock > cached.latestScannedBlock) {
      try {
        const scan = await scanSwapLogsForward(client, cached.poolId, cached.latestScannedBlock + 1n, latestBlock);
        mergeLogsIntoCache(cached, scan.logs, scan.latestScannedBlock);
      } catch (err) {
        stale = true;
        logger.warn({ poolId: cached.poolId, err: String(err) }, "incremental swap-history refresh failed — returning cached support/resistance");
      }
    }
  }

  if (cached.dataPoints === 0) return undefined;

  const ethUsdRate = await getEthPriceUsd();
  if (ethUsdRate === undefined) throw new Error("cannot convert swap history to USD market caps: ETH/USD rate is unavailable");

  const mcapPerUsdPrice = await resolveMcapPerUsdPrice(client, token, currentMcap, currentPriceUsd);
  if (mcapPerUsdPrice === undefined) {
    throw new Error("cannot convert swap history to market caps: no current mcap/price multiplier and totalSupply fallback failed");
  }

  const toMcap = (priceInEth: number | undefined) => (priceInEth === undefined ? undefined : priceInEth * ethUsdRate * mcapPerUsdPrice);
  return {
    poolId: cached.poolId,
    dataPoints: cached.dataPoints,
    swingHighMcap: cached.dataPoints >= 2 ? toMcap(cached.swingHighPriceInEth) : undefined,
    swingLowMcap: cached.dataPoints >= 2 ? toMcap(cached.swingLowPriceInEth) : undefined,
    earliestBlock: cached.earliestBlock,
    latestScannedBlock: cached.latestScannedBlock,
    stale,
  };
}

async function resolveMcapPerUsdPrice(
  client: PublicClient,
  token: `0x${string}`,
  currentMcap: number | undefined,
  currentPriceUsd: number | undefined
): Promise<number | undefined> {
  if (currentMcap !== undefined && currentMcap > 0 && currentPriceUsd !== undefined && currentPriceUsd > 0) {
    return currentMcap / currentPriceUsd;
  }
  return getAdjustedTotalSupply(client, token);
}

async function scanSwapLogsForward(
  client: PublicClient,
  poolId: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint
): Promise<{ logs: SwapLog[]; earliestBlock: bigint; latestScannedBlock: bigint }> {
  if (fromBlock > toBlock) return { logs: [], earliestBlock: fromBlock, latestScannedBlock: toBlock };

  const logs: SwapLog[] = [];
  let cursor = fromBlock;
  let chunks = 0;
  while (cursor <= toBlock && chunks < LOG_SCAN_MAX_CHUNKS) {
    const chunkTo = cursor + tradingConfig.swapHistoryScanChunkBlocks > toBlock ? toBlock : cursor + tradingConfig.swapHistoryScanChunkBlocks;
    const chunkLogs = await client.getLogs({
      address: UNISWAP_V4_ADDRESSES.poolManager as `0x${string}`,
      event: POOL_MANAGER_ABI[1],
      args: { id: poolId },
      fromBlock: cursor,
      toBlock: chunkTo,
    });
    logs.push(...(chunkLogs as unknown as SwapLog[]));
    cursor = chunkTo + 1n;
    chunks++;
  }

  if (cursor <= toBlock) {
    throw new Error(`swap-history scan exceeded ${LOG_SCAN_MAX_CHUNKS} chunks before reaching latest block`);
  }
  return { logs: sortLogs(logs), earliestBlock: fromBlock, latestScannedBlock: toBlock };
}

async function scanSwapLogsBackward(
  client: PublicClient,
  poolId: `0x${string}`,
  latestBlock: bigint
): Promise<{ logs: SwapLog[]; earliestBlock: bigint; latestScannedBlock: bigint }> {
  const logs: SwapLog[] = [];
  let toBlock = latestBlock;
  let earliestBlock = latestBlock;

  for (let chunk = 0; chunk < LOG_SCAN_MAX_CHUNKS; chunk++) {
    const fromBlock = toBlock > tradingConfig.swapHistoryScanChunkBlocks ? toBlock - tradingConfig.swapHistoryScanChunkBlocks : 0n;
    const chunkLogs = await client.getLogs({
      address: UNISWAP_V4_ADDRESSES.poolManager as `0x${string}`,
      event: POOL_MANAGER_ABI[1],
      args: { id: poolId },
      fromBlock,
      toBlock,
    });
    if (chunkLogs.length === 0) {
      earliestBlock = fromBlock;
      break;
    }
    logs.push(...(chunkLogs as unknown as SwapLog[]));
    earliestBlock = fromBlock;
    if (fromBlock === 0n) break;
    toBlock = fromBlock - 1n;
  }

  return { logs: sortLogs(logs), earliestBlock, latestScannedBlock: latestBlock };
}

function buildCachedHistory(
  poolId: `0x${string}`,
  tokenDecimals: number,
  logs: SwapLog[],
  earliestBlock: bigint,
  latestScannedBlock: bigint
): CachedSwapHistory {
  const cached: CachedSwapHistory = {
    poolId,
    tokenDecimals,
    dataPoints: 0,
    earliestBlock,
    latestScannedBlock,
  };
  mergeLogsIntoCache(cached, logs, latestScannedBlock);
  return cached;
}

function mergeLogsIntoCache(cached: CachedSwapHistory, logs: SwapLog[], latestScannedBlock: bigint): void {
  for (const log of logs) {
    const sqrtPriceX96 = log.args?.sqrtPriceX96;
    if (typeof sqrtPriceX96 !== "bigint") continue;
    const priceInEth = sqrtPriceX96ToTokenPriceInEth(sqrtPriceX96, cached.tokenDecimals);
    if (!Number.isFinite(priceInEth) || priceInEth <= 0) continue;
    cached.dataPoints++;
    cached.swingHighPriceInEth = cached.swingHighPriceInEth === undefined ? priceInEth : Math.max(cached.swingHighPriceInEth, priceInEth);
    cached.swingLowPriceInEth = cached.swingLowPriceInEth === undefined ? priceInEth : Math.min(cached.swingLowPriceInEth, priceInEth);
  }
  cached.latestScannedBlock = latestScannedBlock;
}

function sortLogs(logs: SwapLog[]): SwapLog[] {
  return logs.sort((a, b) => {
    const aBlock = a.blockNumber ?? 0n;
    const bBlock = b.blockNumber ?? 0n;
    if (aBlock !== bBlock) return aBlock < bBlock ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });
}

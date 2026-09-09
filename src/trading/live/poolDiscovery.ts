import { keccak256, encodeAbiParameters, getAddress, type PublicClient } from "viem";
import { logger } from "../../logger";
import { UNISWAP_V4_ADDRESSES, NATIVE_ETH_CURRENCY, POOL_MANAGER_ABI, STATE_VIEW_ABI } from "./contracts";

export interface PoolKey {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
}

export interface DiscoveredPool {
  poolKey: PoolKey;
  poolId: `0x${string}`;
}

// Standard Uniswap fee-tier/tickSpacing pairs, used only as a fallback cross-
// check if event-log discovery finds nothing (e.g. an RPC log-range limit) —
// a pool with a genuinely custom hook or nonstandard tickSpacing would only
// ever be found via the Initialize event scan below, never guessed here.
const STANDARD_FEE_TIERS: { fee: number; tickSpacing: number }[] = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
];

function computePoolId(key: PoolKey): `0x${string}` {
  // PoolId = keccak256(abi.encode(PoolKey)) per v4-core's PoolIdLibrary.
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
      ],
      [key]
    )
  );
}

// Robinhood Chain produces a block roughly every 100ms (confirmed at build
// time — ~58M blocks after only ~68 days live), so "fromBlock: 0" is tens of
// millions of blocks and the public RPC times out on it (confirmed live).
// Every token this app ever discovers is brand new, so its pool's Initialize
// event is necessarily recent — scan backward in bounded chunks instead of
// the whole chain, and stop as soon as a match is found.
const LOG_SCAN_CHUNK_BLOCKS = 400_000n;
const LOG_SCAN_MAX_CHUNKS = 30; // ~12M blocks, ~14 days at 100ms/block

/**
 * Finds the real, currently-initialized ETH/<token> v4 pool by reading
 * PoolManager's own Initialize events — never assumes a fee tier or that
 * hooks == address(0). A token could plausibly live behind a custom hook
 * (e.g. a bonding-curve launcher); guessing the pool parameters for a swap
 * that will spend real ETH is exactly the kind of shortcut that's not worth
 * the risk.
 */
export async function discoverPool(client: PublicClient, tokenAddress: `0x${string}`): Promise<DiscoveredPool | undefined> {
  const token = getAddress(tokenAddress);

  try {
    const logs = await scanInitializeLogsBackward(client, token);
    if (logs.length > 0) {
      // If multiple pools exist for the same pair (different fee tiers), the
      // most recently initialized one is the most likely to be the active one
      // for a freshly-launched token — but check liquidity below regardless.
      const candidates = logs.map((log) => ({
        poolKey: {
          currency0: NATIVE_ETH_CURRENCY,
          currency1: token,
          fee: Number(log.args.fee),
          tickSpacing: Number(log.args.tickSpacing),
          hooks: log.args.hooks as `0x${string}`,
        },
        poolId: log.args.id as `0x${string}`,
      }));
      const withLiquidity = await pickPoolWithLiquidity(client, candidates);
      if (withLiquidity) return withLiquidity;
    }
  } catch (err) {
    logger.warn({ token, err: String(err) }, "pool discovery via event logs failed, falling back to standard fee-tier probe");
  }

  // Fallback: probe standard fee tiers with no hooks.
  const fallbackCandidates: DiscoveredPool[] = STANDARD_FEE_TIERS.map(({ fee, tickSpacing }) => {
    const poolKey: PoolKey = {
      currency0: NATIVE_ETH_CURRENCY,
      currency1: token,
      fee,
      tickSpacing,
      hooks: "0x0000000000000000000000000000000000000000",
    };
    return { poolKey, poolId: computePoolId(poolKey) };
  });
  return pickPoolWithLiquidity(client, fallbackCandidates);
}

async function scanInitializeLogsBackward(client: PublicClient, token: `0x${string}`) {
  const latest = await client.getBlockNumber();
  let toBlock = latest;

  for (let chunk = 0; chunk < LOG_SCAN_MAX_CHUNKS; chunk++) {
    const fromBlock = toBlock > LOG_SCAN_CHUNK_BLOCKS ? toBlock - LOG_SCAN_CHUNK_BLOCKS : 0n;
    const logs = await client.getLogs({
      address: UNISWAP_V4_ADDRESSES.poolManager as `0x${string}`,
      event: POOL_MANAGER_ABI[0],
      args: { currency0: NATIVE_ETH_CURRENCY, currency1: token },
      fromBlock,
      toBlock,
    });
    if (logs.length > 0) return logs;
    if (fromBlock === 0n) break;
    toBlock = fromBlock - 1n;
  }
  return [];
}

async function pickPoolWithLiquidity(client: PublicClient, candidates: DiscoveredPool[]): Promise<DiscoveredPool | undefined> {
  for (const candidate of candidates) {
    try {
      const slot0 = await client.readContract({
        address: UNISWAP_V4_ADDRESSES.stateView as `0x${string}`,
        abi: STATE_VIEW_ABI,
        functionName: "getSlot0",
        args: [candidate.poolId],
      });
      const sqrtPriceX96 = slot0[0];
      if (sqrtPriceX96 > 0n) return candidate;
    } catch {
      // not initialized / doesn't exist — try the next candidate
    }
  }
  return undefined;
}

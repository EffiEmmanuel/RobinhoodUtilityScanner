import type { PublicClient } from "viem";
import { UNISWAP_V4_ADDRESSES } from "./live/contracts";
import type { ConvictionResult } from "./conservativeMode";

/**
 * Real holder-distribution check — user directive 2026-09-13: "how do we
 * know if someone is going to rug the project with a few sells." Before this,
 * scoring/index.ts's holderScoreStub always returned a fixed neutral 50 (no
 * indexer was wired up); nothing anywhere ever looked at who actually holds a
 * token before buying it.
 *
 * There's no third-party indexer for this chain yet (the Blockscout instance
 * at robinhoodchain.blockscout.com sits behind a Cloudflare bot challenge
 * that blocks plain server-to-server requests), so this reads ground truth
 * directly: scan the token's own ERC20 Transfer log backward from the latest
 * block (same chunked-backward-scan shape as poolDiscovery.ts's Initialize
 * scan) to reconstruct every address's balance, then rank holders by size.
 * Reasonable for what this is actually used for — a token we're about to buy
 * is at most hours old, so its full transfer history is small.
 *
 * On Uniswap v4 there is no per-pair contract holding pooled tokens the way
 * v2 has — all liquidity for every pool lives in the singleton PoolManager's
 * own accounting — so PoolManager is excluded from the holder ranking like
 * the zero/dead addresses are: it isn't a "holder" that can decide to dump on
 * the market, removing it entirely is a separate, already-known risk (LP
 * removal) that this check does not cover.
 */

const TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
} as const;

const TOTAL_SUPPLY_ABI = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";

const EXCLUDED_FROM_HOLDER_RANKING = new Set(
  [ZERO_ADDRESS, DEAD_ADDRESS, UNISWAP_V4_ADDRESSES.poolManager].map((a) => a.toLowerCase())
);

// Same cadence as poolDiscovery.ts's LOG_SCAN_CHUNK_BLOCKS/MAX_CHUNKS
// (~100ms blocks on this chain) — a token we're about to buy is at most
// hours old, so this reaches the genesis Transfer (mint) within one or two
// chunks in practice; the 30-chunk ceiling (~14 days) is only a backstop.
const LOG_SCAN_CHUNK_BLOCKS = 400_000n;
const LOG_SCAN_MAX_CHUNKS = 30;

export interface HolderSnapshot {
  totalSupply: bigint;
  top1Percent: number;
  top10Percent: number;
  holderCount: number; // distinct non-excluded addresses with a positive balance
  logScanComplete: boolean; // false if LOG_SCAN_MAX_CHUNKS was hit before reaching genesis
}

function percentOfSupply(raw: bigint, totalSupply: bigint): number {
  if (totalSupply <= 0n) return 0;
  return Number((raw * 1_000_000n) / totalSupply) / 10_000;
}

/** Undefined only on an infra failure (RPC couldn't be read at all) — a
 * genuinely concentrated token still gets a real snapshot with a low
 * holderCount, it just fails evaluateHolderConcentration's checks instead. */
export async function getHolderSnapshot(client: PublicClient, tokenAddress: `0x${string}`): Promise<HolderSnapshot | undefined> {
  const latest = await client.getBlockNumber();
  const balances = new Map<string, bigint>();
  let toBlock = latest;
  let logScanComplete = false;

  for (let chunk = 0; chunk < LOG_SCAN_MAX_CHUNKS; chunk++) {
    const fromBlock = toBlock > LOG_SCAN_CHUNK_BLOCKS ? toBlock - LOG_SCAN_CHUNK_BLOCKS : 0n;
    const logs = await client.getLogs({ address: tokenAddress, event: TRANSFER_EVENT, fromBlock, toBlock });
    for (const log of logs) {
      const { from, to, value } = log.args as { from: `0x${string}`; to: `0x${string}`; value: bigint };
      const fromKey = from.toLowerCase();
      const toKey = to.toLowerCase();
      balances.set(fromKey, (balances.get(fromKey) ?? 0n) - value);
      balances.set(toKey, (balances.get(toKey) ?? 0n) + value);
    }
    if (fromBlock === 0n) {
      logScanComplete = true;
      break;
    }
    toBlock = fromBlock - 1n;
  }

  const totalSupply = await client.readContract({ address: tokenAddress, abi: TOTAL_SUPPLY_ABI, functionName: "totalSupply" });
  if (totalSupply <= 0n) return undefined;

  const ranked = [...balances.entries()]
    .filter(([addr, bal]) => bal > 0n && !EXCLUDED_FROM_HOLDER_RANKING.has(addr))
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));

  const top1 = ranked.slice(0, 1).reduce((sum, [, bal]) => sum + bal, 0n);
  const top10 = ranked.slice(0, 10).reduce((sum, [, bal]) => sum + bal, 0n);

  return {
    totalSupply,
    top1Percent: percentOfSupply(top1, totalSupply),
    top10Percent: percentOfSupply(top10, totalSupply),
    holderCount: ranked.length,
    logScanComplete,
  };
}

export interface HolderConcentrationThresholds {
  maxTop1HolderPercent: number;
  maxTop10HolderPercent: number;
  minHolderCount: number;
}

export function evaluateHolderConcentration(
  snapshot: HolderSnapshot | undefined,
  thresholds: HolderConcentrationThresholds
): ConvictionResult {
  if (!snapshot) {
    return { passed: false, failedChecks: ["holderData"], reasons: ["couldn't read holder/transfer data on-chain"] };
  }

  const failedChecks: string[] = [];
  const reasons: string[] = [];

  if (snapshot.holderCount < thresholds.minHolderCount) {
    failedChecks.push("holderCount");
    reasons.push(`only ${snapshot.holderCount} distinct holders (< ${thresholds.minHolderCount})`);
  }
  if (snapshot.top1Percent > thresholds.maxTop1HolderPercent) {
    failedChecks.push("top1Holder");
    reasons.push(`top holder owns ${snapshot.top1Percent.toFixed(1)}% of supply (> ${thresholds.maxTop1HolderPercent}%) — a single sell could tank price`);
  }
  if (snapshot.top10Percent > thresholds.maxTop10HolderPercent) {
    failedChecks.push("top10Holders");
    reasons.push(`top 10 holders own ${snapshot.top10Percent.toFixed(1)}% of supply (> ${thresholds.maxTop10HolderPercent}%)`);
  }

  return { passed: failedChecks.length === 0, failedChecks, reasons };
}

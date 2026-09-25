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

// ~100ms blocks on this chain: 400K blocks is ~11h, and the 12M-block
// ceiling (~14 days) is only a backstop — the scan stops as soon as it has
// seen the token's whole minted supply (see getHolderSnapshot).
const LOG_SCAN_MAX_SPAN_BLOCKS = 400_000n;
const LOG_SCAN_MAX_BLOCKS = 12_000_000n;
// RPCs cap a single getLogs call, and not in the same way: the official
// rpc.mainnet.chain.robinhood.com takes 4M-block ranges but answers at most
// 10,000 logs ("logs matched by query exceeds limit of 10000", checked
// 2026-09-25), while dRPC's free plan caps the range at 10,000 blocks. A
// busy token overflowed either in one 400K-block call, which failed the
// whole snapshot, so a busy token could never pass the holder check. Now a
// range- or size-type error halves the span, down to this floor (~100s of
// blocks), and the span grows back while results stay light.
const LOG_SCAN_MIN_SPAN_BLOCKS = 1_000n;
const LIGHT_RESULT_LOGS = 2_500;
// Hard ceiling on getLogs calls for one snapshot, so a pathological token
// can't burn the RPC budget.
const LOG_SCAN_MAX_CALLS = 120;

// Error text the RPCs use when a single getLogs call asks for too much —
// too wide a block range (a fixed cap: never worth trying that wide again)
// or too many logs (depends on how busy that stretch was). Deliberately not
// "Too Many Requests" (a 429 is a rate limit: splitting would only make
// more calls) or a network failure.
const BLOCK_RANGE_ERROR = /block range|ranges? over|range (is )?too (large|big|wide)|max(imum)? (block )?range/i;
const LOG_COUNT_ERROR = /exceeds? (the )?limit|more than \d+ (results|logs)|too many (logs|results)|response size|query timeout|query returned more/i;

function errorText(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const x = e as { message?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown };
    parts.push(String(x.details ?? ""), String(x.shortMessage ?? ""), String(x.message ?? ""));
    e = x.cause;
  }
  return parts.join(" ");
}

/** Why a failed getLogs call might succeed over a smaller range, if it
 * might: "range" (the RPC's block-range cap) or "size" (too many logs). */
export function logQueryLimitKind(err: unknown): "range" | "size" | undefined {
  const text = errorText(err);
  if (/too many requests|\b429\b/i.test(text)) return undefined;
  if (BLOCK_RANGE_ERROR.test(text)) return "range";
  if (LOG_COUNT_ERROR.test(text)) return "size";
  return undefined;
}

export interface HolderSnapshot {
  totalSupply: bigint;
  top1Percent: number;
  top10Percent: number;
  holderCount: number; // distinct non-excluded addresses with a positive balance
  // True once the scan reached the token's whole minted supply (or block 0);
  // false if it stopped at the LOG_SCAN_MAX_BLOCKS backstop first.
  logScanComplete: boolean;
  // EVM log scan only: how many getLogs calls the snapshot took.
  getLogsCalls?: number;
}

// Exported for solanaHolderConcentration.ts, which produces the same
// HolderSnapshot shape from a completely different data source (SPL RPC
// methods, not an ERC20 Transfer-log scan) but shares this percentage math.
export function percentOfSupply(raw: bigint, totalSupply: bigint): number {
  if (totalSupply <= 0n) return 0;
  return Number((raw * 1_000_000n) / totalSupply) / 10_000;
}

/**
 * Rebuilds every holder's balance from the token's Transfer log, scanning
 * backward from the latest block. Stops once the zero address has minted the
 * whole current supply (every transfer since then is in hand), or at block
 * 0 / the LOG_SCAN_MAX_BLOCKS backstop. Throws when the RPC can't be read
 * even after splitting ranges down to the floor — the caller treats that as
 * "holder data unavailable (RPC)" and fails closed. Undefined for a token
 * reporting no supply. A genuinely concentrated token still gets a real
 * snapshot; it just fails evaluateHolderConcentration's checks.
 */
export async function getHolderSnapshot(client: PublicClient, tokenAddress: `0x${string}`): Promise<HolderSnapshot | undefined> {
  const [latest, totalSupply] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({ address: tokenAddress, abi: TOTAL_SUPPLY_ABI, functionName: "totalSupply" }),
  ]);
  if (totalSupply <= 0n) return undefined;

  const balances = new Map<string, bigint>();
  const floor = latest > LOG_SCAN_MAX_BLOCKS ? latest - LOG_SCAN_MAX_BLOCKS : 0n;
  let toBlock = latest;
  let span = LOG_SCAN_MAX_SPAN_BLOCKS;
  // Lowered for good by a block-range cap; a log-count cap only halves the
  // current span, which grows back once results are light again.
  let spanCeiling = LOG_SCAN_MAX_SPAN_BLOCKS;
  let calls = 0;
  let logScanComplete = false;

  for (;;) {
    const fromBlock = toBlock - floor + 1n > span ? toBlock - span + 1n : floor;
    if (calls >= LOG_SCAN_MAX_CALLS) throw new Error(`holder log scan gave up after ${calls} getLogs calls`);
    calls++;
    let logs;
    try {
      logs = await client.getLogs({ address: tokenAddress, event: TRANSFER_EVENT, fromBlock, toBlock });
    } catch (err) {
      const limit = logQueryLimitKind(err);
      if (limit && span > LOG_SCAN_MIN_SPAN_BLOCKS) {
        span = span / 2n > LOG_SCAN_MIN_SPAN_BLOCKS ? span / 2n : LOG_SCAN_MIN_SPAN_BLOCKS;
        if (limit === "range") spanCeiling = span;
        continue;
      }
      throw err;
    }
    for (const log of logs) {
      const { from, to, value } = log.args as { from: `0x${string}`; to: `0x${string}`; value: bigint };
      const fromKey = from.toLowerCase();
      const toKey = to.toLowerCase();
      balances.set(fromKey, (balances.get(fromKey) ?? 0n) - value);
      balances.set(toKey, (balances.get(toKey) ?? 0n) + value);
    }
    // Scanning backward, the zero address nets -(minted) + (burned); it
    // reaches -totalSupply exactly when every mint since launch is in hand.
    if ((balances.get(ZERO_ADDRESS) ?? 0n) <= -totalSupply || fromBlock === 0n) {
      logScanComplete = true;
      break;
    }
    if (fromBlock <= floor) break;
    toBlock = fromBlock - 1n;
    if (logs.length < LIGHT_RESULT_LOGS && span < spanCeiling) {
      span = span * 2n < spanCeiling ? span * 2n : spanCeiling;
    }
  }

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
    getLogsCalls: calls,
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
    return { passed: false, failedChecks: ["holderData"], reasons: ["holder data unavailable (RPC)"] };
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

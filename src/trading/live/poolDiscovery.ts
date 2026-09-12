import { keccak256, encodeAbiParameters, getAddress, type PublicClient } from "viem";
import { logger } from "../../logger";
import { UNISWAP_V4_ADDRESSES, NATIVE_ETH_CURRENCY, POOL_MANAGER_ABI, STATE_VIEW_ABI, MAX_REASONABLE_POOL_FEE } from "./contracts";

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
  // In-range liquidity (StateView.getLiquidity) at selection time — carried
  // through to the quote layer purely for diagnostics: when a quote's price
  // impact is nonsensical, this is what tells us whether we landed on a real
  // pool with too little depth for the trade size, versus something else
  // entirely (see executionFacade.ts's price-impact logging).
  liquidity: bigint;
}

type PoolCandidate = Omit<DiscoveredPool, "liquidity">;

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
export interface DiscoverPoolOptions {
  /**
   * Let a pool past MAX_REASONABLE_POOL_FEE be used anyway. Confirmed live
   * 2026-09-11: OPAI's only real venue was an 18%-fee pool behind a custom
   * hook, so refusing it stranded a position sitting at +322% — every exit
   * attempt was rejected and retried forever while the gain stayed
   * unbankable. Refusing to BUY into a fee trap is right; refusing to SELL
   * out of one is not, because by then the fee is a sunk cost and 18% is
   * strictly better than never exiting at all. Exits pass true; entries
   * never do.
   */
  allowHighFeePools?: boolean;
}

// A token's pool key (currency0/1/fee/tickSpacing/hooks) and poolId never
// change once found — only its liquidity does — so the expensive part of
// discovery (scanning up to 12M blocks of Initialize events, or probing 4
// standard fee tiers) only ever needs to happen once per token per process.
// Confirmed live 2026-09-11: every buy/sell/isSellable call independently
// re-ran full discovery, each costing several RPC round-trips before a single
// price could even be read — the dominant cost in both execution latency and
// RPC load, worse than the position-monitor tick interval itself for a token
// held across many ticks. Keyed on tokenAddress+allowHighFeePools since an
// entry (never allows a high-fee pool) and an exit (does) can legitimately
// resolve to different pools for the same token. Never invalidated: a v4
// pool's key is immutable once initialized, and a process restart naturally
// clears this (in-memory only, nothing persisted).
const poolKeyCache = new Map<string, PoolCandidate>();

function cacheKey(token: `0x${string}`, allowHighFeePools: boolean): string {
  return `${token.toLowerCase()}:${allowHighFeePools}`;
}

export async function discoverPool(
  client: PublicClient,
  tokenAddress: `0x${string}`,
  options: DiscoverPoolOptions = {}
): Promise<DiscoveredPool | undefined> {
  const token = getAddress(tokenAddress);
  const cached = poolKeyCache.get(cacheKey(token, options.allowHighFeePools ?? false));
  if (cached) {
    // Liquidity is never cached — always re-read fresh (this is usually why
    // discoverPool is being called at all: to price against current depth).
    // A cache-hit skips the log scan and fee-tier probe only.
    try {
      const liquidity = await client.readContract({
        address: UNISWAP_V4_ADDRESSES.stateView as `0x${string}`,
        abi: STATE_VIEW_ABI,
        functionName: "getLiquidity",
        args: [cached.poolId],
      });
      return { ...cached, liquidity };
    } catch (err) {
      logger.warn({ token, err: String(err) }, "cached pool's liquidity read failed — falling back to full discovery this once");
      // Falls through to full discovery below rather than returning stale/no
      // liquidity — an infra hiccup here shouldn't evict a good cache entry
      // (nothing removes it), just skip using it for this one call.
    }
  }

  let logScanFailed = false;

  try {
    const logs = await scanInitializeLogsBackward(client, token);
    if (logs.length > 0) {
      // If multiple pools exist for the same pair (different fee tiers), the
      // most recently initialized one is the most likely to be the active one
      // for a freshly-launched token — but check liquidity below regardless.
      const candidates: PoolCandidate[] = logs.map((log) => ({
        poolKey: {
          currency0: NATIVE_ETH_CURRENCY,
          currency1: token,
          fee: Number(log.args.fee),
          tickSpacing: Number(log.args.tickSpacing),
          hooks: log.args.hooks as `0x${string}`,
        },
        poolId: log.args.id as `0x${string}`,
      }));
      const withLiquidity = await pickPoolWithLiquidity(client, candidates, options);
      if (withLiquidity) {
        poolKeyCache.set(cacheKey(token, options.allowHighFeePools ?? false), { poolKey: withLiquidity.poolKey, poolId: withLiquidity.poolId });
        return withLiquidity;
      }
    }
  } catch (err) {
    logScanFailed = true;
    logger.warn({ token, err: String(err) }, "pool discovery via event logs failed, falling back to standard fee-tier probe");
  }

  // Fallback: probe standard fee tiers with no hooks.
  const fallbackCandidates: PoolCandidate[] = STANDARD_FEE_TIERS.map(({ fee, tickSpacing }) => {
    const poolKey: PoolKey = {
      currency0: NATIVE_ETH_CURRENCY,
      currency1: token,
      fee,
      tickSpacing,
      hooks: "0x0000000000000000000000000000000000000000",
    };
    return { poolKey, poolId: computePoolId(poolKey) };
  });
  const fallbackResult = await pickPoolWithLiquidity(client, fallbackCandidates, options);
  if (fallbackResult) {
    poolKeyCache.set(cacheKey(token, options.allowHighFeePools ?? false), { poolKey: fallbackResult.poolKey, poolId: fallbackResult.poolId });
    return fallbackResult;
  }

  // Confirmed live 2026-09-11: the event-log scan above is the ONLY mechanism
  // that can ever find a pool behind a custom hook or nonstandard fee tier
  // (e.g. a bonding-curve launcher) — the fallback above can only ever
  // confirm the 4 vanilla fee tiers, never rule out a custom one. When the
  // log scan fails for an infrastructure reason (RPC lacks eth_getLogs/
  // archive access, a provider outage, a Cloudflare challenge on the
  // fallback RPC — all three observed live against this exact deployment)
  // and the vanilla probe also comes up empty, that is NOT proof the token
  // has no tradeable pool — it's proof we couldn't check the one place that
  // would show it. Every trade-entry trigger sampled live during this outage
  // was silently swallowed into "no pool found" -> isSellable() false ->
  // validateEntry's hard "no sell path available — possible honeypot"
  // REJECTED, permanently killing the candidate on an RPC hiccup that had
  // nothing to do with the token. Throwing here instead lets it propagate to
  // entryMonitor.ts's/positionManager.ts's existing per-item retry handling
  // (the row goes back to ACTIVE / gets retried next tick), the same
  // recovery path every other transient infra failure in this codebase
  // already gets — never a silent, permanent false rejection.
  if (logScanFailed) {
    throw new Error(
      `pool discovery inconclusive for ${token}: event-log scan failed (RPC/infra error) and no standard fee-tier pool was found — this does not confirm the token has no tradeable pool, only that it couldn't be checked`
    );
  }
  return undefined;
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

/**
 * Despite the name this used to only check "is initialized" (sqrtPriceX96 >
 * 0), returning the first such candidate regardless of how much real
 * liquidity it actually held — fine when a token has exactly one pool, but a
 * real risk when several exist (a near-empty or fee-trap pool initialized
 * incidentally alongside the token's real, deep pool). Now reads real
 * liquidity via StateView.getLiquidity and picks the deepest one among all
 * initialized candidates, and refuses any pool whose LP fee is high enough to
 * itself be predatory (see MAX_REASONABLE_POOL_FEE) even if it's the only
 * candidate found — an extreme fee is a red flag regardless of liquidity
 * depth, not something a caller's own price-impact math should have to
 * rediscover from a cryptic four-digit percentage.
 *
 * An uninitialized pool answers cleanly (sqrtPriceX96 == 0, confirmed live —
 * StateView doesn't revert for an unknown poolId), so anything that actually
 * throws here is a real RPC/network failure, never "this candidate doesn't
 * exist." Confirmed live 2026-09-11: the old catch-and-continue treated both
 * identically, so when the RPC couldn't serve these reads at all, every
 * candidate silently came back "not this one" and the caller read a clean
 * "no pool" instead of the truth ("couldn't check"). Track real errors
 * separately and throw if nothing was confirmed AND at least one candidate
 * genuinely errored — never let an infra failure masquerade as a clean
 * on-chain negative.
 */
async function pickPoolWithLiquidity(
  client: PublicClient,
  candidates: PoolCandidate[],
  options: DiscoverPoolOptions = {}
): Promise<DiscoveredPool | undefined> {
  let best: { candidate: PoolCandidate; liquidity: bigint } | undefined;
  const errors: unknown[] = [];

  for (const candidate of candidates) {
    if (candidate.poolKey.fee > MAX_REASONABLE_POOL_FEE) {
      if (!options.allowHighFeePools) {
        logger.warn(
          { poolId: candidate.poolId, feeBps: candidate.poolKey.fee / 100 },
          "skipping pool with predatory LP fee (>5%) — refusing to trade through it regardless of liquidity"
        );
        continue;
      }
      logger.warn(
        { poolId: candidate.poolId, feeBps: candidate.poolKey.fee / 100 },
        "using a predatory-fee pool because this is an EXIT — the fee is sunk by now and paying it beats being unable to sell at all"
      );
    }
    try {
      const [slot0, liquidity] = await Promise.all([
        client.readContract({
          address: UNISWAP_V4_ADDRESSES.stateView as `0x${string}`,
          abi: STATE_VIEW_ABI,
          functionName: "getSlot0",
          args: [candidate.poolId],
        }),
        client.readContract({
          address: UNISWAP_V4_ADDRESSES.stateView as `0x${string}`,
          abi: STATE_VIEW_ABI,
          functionName: "getLiquidity",
          args: [candidate.poolId],
        }),
      ]);
      const sqrtPriceX96 = slot0[0];
      if (sqrtPriceX96 > 0n && (!best || liquidity > best.liquidity)) {
        best = { candidate, liquidity };
      }
    } catch (err) {
      errors.push(err);
    }
  }
  if (best) return { ...best.candidate, liquidity: best.liquidity };
  if (errors.length > 0) {
    throw new Error(
      `pool-liquidity check failed for ${errors.length}/${candidates.length} candidate(s), none of the rest confirmed a pool — cannot conclude no pool exists: ${String(errors[0])}`
    );
  }
  return undefined;
}

import { encodeAbiParameters, getAddress, keccak256, type PublicClient } from "viem";
import { logger } from "../../logger";
import { fetchMarketForToken } from "../../dex/client";
import {
  UNISWAP_V4_ADDRESSES,
  NATIVE_ETH_CURRENCY,
  ROBINHOOD_WETH,
  POSITION_MANAGER_POOL_KEYS_ABI,
  POOL_MANAGER_ABI,
  STATE_VIEW_ABI,
  V4_QUOTER_ABI,
  MAX_REASONABLE_POOL_FEE,
  DYNAMIC_FEE_FLAG,
  UNISWAP_LEGACY_ADDRESSES,
  LEGACY_POOL_ABI,
  QUOTER_V2_ABI,
  V2_ROUTER_QUOTE_ABI,
  V2_FACTORY_ABI,
  V3_FACTORY_ABI,
  V3_STANDARD_FEE_TIERS,
  isRouterAllowed,
} from "./contracts";
import { discoverPool, isPoolDiscoveryInconclusiveError, type PoolKey } from "./poolDiscovery";
import type { PathKey } from "./swapEncoding";

/**
 * User directive 2026-09-24: "we should be able to buy ANY TOKEN, whether
 * tokenized paired or ETH paired ... effectively AND FAST." Until now every
 * trade was a single hop through a native-ETH/token v4 pool, but 41% of
 * Robinhood Chain tokens researched the week before had their main
 * liquidity somewhere else — paired against a tokenized stock (MUSETOWN's
 * real market was a META pool with $48K while its ETH pool had $550), USDG,
 * or WETH. This finds every route from native ETH to a token through at most
 * one intermediate "hub" currency, all in Uniswap v4, quotes them all in
 * parallel, and trades through whichever actually returns the most.
 */

export interface RoutePool {
  poolKey: PoolKey;
  poolId: `0x${string}`;
}

export interface SwapRoute {
  // ETH-side first: pools[0] touches native ETH, the last pool touches the token.
  pools: RoutePool[];
  // Currencies strictly between consecutive pools, in ETH -> token order
  // (empty for a direct route).
  hubs: `0x${string}`[];
  // The ETH side is WETH, wrapped on the way in and unwrapped on the way out
  // by the router — Robinhood Chain has no native-ETH/WETH v4 pool, so this is
  // the only way into a WETH-paired pool.
  viaWeth?: boolean;
}

/**
 * A Uniswap v2 or v3 WETH/token pool, traded through SwapRouter02 (the
 * Universal Routers on this chain can't do v2/v3 — see contracts.ts). The ETH
 * side is always WETH, wrapped/unwrapped by the router.
 */
export interface LegacyRoute {
  venue: "v2" | "v3";
  pool: `0x${string}`;
  fee?: number; // v3 only
}

export type AnyRoute = SwapRoute | LegacyRoute;

export function isLegacyRoute(route: AnyRoute): route is LegacyRoute {
  return "venue" in route;
}

export interface RouteQuote {
  route: AnyRoute;
  amountOut: bigint;
  gasEstimateUnits: bigint;
}

const POOL_KEY_TUPLE = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

export function computePoolId(key: PoolKey): `0x${string}` {
  return keccak256(encodeAbiParameters([POOL_KEY_TUPLE], [key]));
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function poolHasCurrency(key: PoolKey, currency: string): boolean {
  return same(key.currency0, currency) || same(key.currency1, currency);
}

export function otherCurrency(key: PoolKey, currency: string): `0x${string}` {
  return same(key.currency0, currency) ? key.currency1 : key.currency0;
}

/** A static LP fee high enough to be a trap. Dynamic-fee pools are judged by their live quote instead. */
export function isPredatoryFee(key: PoolKey): boolean {
  if ((key.fee & DYNAMIC_FEE_FLAG) !== 0) return false;
  return key.fee > MAX_REASONABLE_POOL_FEE;
}

export function zeroForOneFor(key: PoolKey, currencyIn: string): boolean {
  return same(key.currency0, currencyIn);
}

/** The currencies a trade passes through, in the order it passes through them. */
export function currencySequence(route: SwapRoute, token: `0x${string}`, isBuy: boolean): `0x${string}`[] {
  const buyOrder: `0x${string}`[] = [route.viaWeth ? ROBINHOOD_WETH : NATIVE_ETH_CURRENCY, ...route.hubs, token];
  return isBuy ? buyOrder : buyOrder.slice().reverse();
}

/** V4 PathKey[] for SWAP_EXACT_IN / quoteExactInput, plus the currencies at either end. */
export function pathFor(
  route: SwapRoute,
  token: `0x${string}`,
  isBuy: boolean
): { currencyIn: `0x${string}`; currencyOut: `0x${string}`; path: PathKey[] } {
  const sequence = currencySequence(route, token, isBuy);
  const pools = isBuy ? route.pools : route.pools.slice().reverse();
  const path = pools.map((pool, i) => ({
    intermediateCurrency: sequence[i + 1],
    fee: pool.poolKey.fee,
    tickSpacing: pool.poolKey.tickSpacing,
    hooks: pool.poolKey.hooks,
    hookData: "0x" as `0x${string}`,
  }));
  return { currencyIn: sequence[0], currencyOut: sequence[sequence.length - 1], path };
}

export function routeLabel(route: AnyRoute, hubSymbols: Map<string, string> = new Map()): string {
  if (isLegacyRoute(route)) {
    return `ETH(wrap)→WETH→token [${route.venue}${route.fee !== undefined ? ` ${route.fee / 10_000}%` : ""}]`;
  }
  return [route.viaWeth ? "ETH(wrap)→WETH" : "ETH", ...route.hubs.map((h) => hubSymbols.get(h.toLowerCase()) ?? `${h.slice(0, 6)}…`), "token"].join("→");
}

/** The pool that holds the token itself — the one whose depth actually limits the trade. */
export function tokenSidePool(route: SwapRoute): RoutePool {
  return route.pools[route.pools.length - 1];
}

// --- chain reads ------------------------------------------------------------

// A pool's key is immutable once initialized, so a resolved key is cached for
// the life of the process; a pool that couldn't be resolved at all is only
// retried after UNRESOLVABLE_POOL_RETRY_MS.
const poolKeyById = new Map<string, PoolKey>();
const unresolvablePoolUntil = new Map<string, number>();
const UNRESOLVABLE_POOL_RETRY_MS = 10 * 60_000;

// Launchpad pools — confirmed 2026-09-24 to be the main pool of many new
// tokens (musemrkt/META $54K, QPULL/WETH $166K, ICU/SPY $141K) — add their
// liquidity without the PositionManager, so poolKeys() knows nothing about
// them. Their Initialize event does, and a token we're trading is new, so
// scan newest-first, several block ranges at a time.
const POOL_ID_SCAN_CHUNK_BLOCKS = 400_000n;
const POOL_ID_SCAN_MAX_CHUNKS = 30; // same ~14-day horizon as poolDiscovery.ts
const POOL_ID_SCAN_PARALLEL = 6;

function keyFromInitializeLog(logs: { args: { currency0?: `0x${string}`; currency1?: `0x${string}`; fee?: number; tickSpacing?: number; hooks?: `0x${string}` } }[]): PoolKey | undefined {
  const args = logs[0]?.args;
  if (!args?.currency0 || !args.currency1 || !args.hooks || args.fee === undefined || args.tickSpacing === undefined) return undefined;
  return { currency0: args.currency0, currency1: args.currency1, fee: Number(args.fee), tickSpacing: Number(args.tickSpacing), hooks: args.hooks };
}

/**
 * Block number closest to a unix timestamp — a guess from ~100ms blocks,
 * then a couple of secant corrections against real block timestamps.
 */
async function estimateBlockAt(client: PublicClient, targetSec: number): Promise<bigint> {
  const latest = await client.getBlock();
  const latestNumber = latest.number ?? 0n;
  const latestSec = Number(latest.timestamp);
  if (targetSec >= latestSec) return latestNumber;
  let guess = latestNumber - BigInt(Math.round((latestSec - targetSec) / 0.1));
  for (let i = 0; i < 3; i++) {
    if (guess < 0n) guess = 0n;
    const block = await client.getBlock({ blockNumber: guess });
    const blockSec = Number(block.timestamp);
    if (Math.abs(blockSec - targetSec) < 600 || guess === latestNumber) return guess;
    const secPerBlock = (latestSec - blockSec) / Math.max(1, Number(latestNumber - guess));
    guess += BigInt(Math.round((targetSec - blockSec) / Math.max(secPerBlock, 0.01)));
  }
  return guess < 0n ? 0n : guess;
}

// DexScreener's pairCreatedAt on this chain reads ~1h ahead (see
// conservativeMode.ts's PAIR_CREATED_AT_SKEW_MINUTES), so the window is
// centred an hour earlier and wide enough to absorb both that and the
// block-time estimate.
const CREATED_AT_SKEW_SEC = 3600;
const CREATED_AT_WINDOW_BLOCKS = 180_000n;

/** Targeted Initialize lookup for a pool of any age, around its known creation time. */
async function keyNearCreationTime(client: PublicClient, poolId: `0x${string}`, createdAt: Date): Promise<PoolKey | undefined> {
  const center = await estimateBlockAt(client, Math.floor(createdAt.getTime() / 1000) - CREATED_AT_SKEW_SEC);
  const windows = [0n, 1n, -1n].map((shift) => {
    const mid = center + shift * 2n * CREATED_AT_WINDOW_BLOCKS;
    return { fromBlock: mid > CREATED_AT_WINDOW_BLOCKS ? mid - CREATED_AT_WINDOW_BLOCKS : 0n, toBlock: mid + CREATED_AT_WINDOW_BLOCKS };
  });
  for (const window of windows) {
    const logs = await client.getLogs({ address: UNISWAP_V4_ADDRESSES.poolManager as `0x${string}`, event: POOL_MANAGER_ABI[0], args: { id: poolId }, ...window });
    const key = keyFromInitializeLog(logs);
    if (key) return key;
  }
  return undefined;
}

async function keyFromInitializeEvent(client: PublicClient, poolId: `0x${string}`): Promise<PoolKey | undefined> {
  const latest = await client.getBlockNumber();
  for (let first = 0; first < POOL_ID_SCAN_MAX_CHUNKS; first += POOL_ID_SCAN_PARALLEL) {
    const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
    for (let i = first; i < Math.min(first + POOL_ID_SCAN_PARALLEL, POOL_ID_SCAN_MAX_CHUNKS); i++) {
      const toBlock = latest - BigInt(i) * POOL_ID_SCAN_CHUNK_BLOCKS;
      if (toBlock < 0n) break;
      ranges.push({ fromBlock: toBlock > POOL_ID_SCAN_CHUNK_BLOCKS ? toBlock - POOL_ID_SCAN_CHUNK_BLOCKS + 1n : 0n, toBlock });
    }
    if (ranges.length === 0) break;
    const batches = await Promise.all(
      ranges.map((range) =>
        client.getLogs({ address: UNISWAP_V4_ADDRESSES.poolManager as `0x${string}`, event: POOL_MANAGER_ABI[0], args: { id: poolId }, ...range })
      )
    );
    for (const logs of batches) {
      const key = keyFromInitializeLog(logs);
      if (key) return key;
    }
    if (ranges[ranges.length - 1].fromBlock === 0n) break;
  }
  return undefined;
}

async function resolvePoolKey(client: PublicClient, poolId: `0x${string}`, createdAt?: Date): Promise<PoolKey | undefined> {
  const id = poolId.toLowerCase();
  const cached = poolKeyById.get(id);
  if (cached) return cached;
  if ((unresolvablePoolUntil.get(id) ?? 0) > Date.now()) return undefined;

  const [currency0, currency1, fee, tickSpacing, hooks] = await client.readContract({
    address: UNISWAP_V4_ADDRESSES.positionManager as `0x${string}`,
    abi: POSITION_MANAGER_POOL_KEYS_ABI,
    functionName: "poolKeys",
    args: [poolId.slice(0, 52) as `0x${string}`],
  });
  let key: PoolKey | undefined = { currency0, currency1, fee, tickSpacing, hooks };
  // An unknown pool comes back all-zero; a truncated-id collision would come
  // back as some other pool. Re-hashing rules out both.
  if (!same(computePoolId(key), poolId)) {
    key = createdAt ? await keyNearCreationTime(client, poolId, createdAt) : undefined;
    key ??= await keyFromInitializeEvent(client, poolId);
    if (key && !same(computePoolId(key), poolId)) key = undefined;
  }
  if (!key) {
    unresolvablePoolUntil.set(id, Date.now() + UNRESOLVABLE_POOL_RETRY_MS);
    return undefined;
  }
  poolKeyById.set(id, key);
  return key;
}

interface TokenPool {
  pool: RoutePool;
  counter: `0x${string}`;
  liquidityUsd: number;
}

const TOKEN_POOLS_TTL_MS = 60_000;
const HUB_LEG_TTL_MS = 10 * 60_000;
// Deepest few of a token's listed pools — a long tail of dust pools only
// costs RPC calls and quote time, it never wins a best-route comparison.
const MAX_POOLS_PER_TOKEN = 5;

const tokenPoolsCache = new Map<string, { at: number; pools: TokenPool[] }>();
const hubLegCache = new Map<string, { at: number; legs: RoutePool[] }>();
const hubSymbols = new Map<string, string>();

/** A currency's v4 pools as DexScreener lists them (pairAddress is the 32-byte poolId for v4), keys resolved on-chain. */
// One DexScreener read per currency serves both the v4 and the v2/v3 pool
// listings (and concurrent callers share the in-flight request).
const MARKET_TTL_MS = 60_000;
const marketCache = new Map<string, { at: number; market: Promise<Awaited<ReturnType<typeof fetchMarketForToken>>> }>();

function cachedMarket(currency: `0x${string}`) {
  const key = currency.toLowerCase();
  const hit = marketCache.get(key);
  if (hit && Date.now() - hit.at < MARKET_TTL_MS) return hit.market;
  const market = fetchMarketForToken("robinhood", currency);
  marketCache.set(key, { at: Date.now(), market });
  market.catch(() => marketCache.delete(key));
  return market;
}

async function listV4Pools(client: PublicClient, currency: `0x${string}`): Promise<TokenPool[]> {
  const market = await cachedMarket(currency);
  const v4Pairs = market.pairs
    .filter((p) => p.pairAddress?.length === 66)
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
    .slice(0, MAX_POOLS_PER_TOKEN);
  for (const p of market.pairs) {
    if (p.quoteTokenAddress && p.quoteSymbol) hubSymbols.set(p.quoteTokenAddress.toLowerCase(), p.quoteSymbol);
  }
  const resolved = await Promise.allSettled(v4Pairs.map((p) => resolvePoolKey(client, p.pairAddress as `0x${string}`, p.pairCreatedAt)));
  const pools: TokenPool[] = [];
  resolved.forEach((r, i) => {
    if (r.status !== "fulfilled" || !r.value || !poolHasCurrency(r.value, currency)) return;
    pools.push({
      pool: { poolKey: r.value, poolId: v4Pairs[i].pairAddress as `0x${string}` },
      counter: otherCurrency(r.value, currency),
      liquidityUsd: v4Pairs[i].liquidityUsd ?? 0,
    });
  });
  return pools;
}

async function tokenPools(client: PublicClient, token: `0x${string}`): Promise<TokenPool[]> {
  const key = token.toLowerCase();
  const cached = tokenPoolsCache.get(key);
  if (cached && Date.now() - cached.at < TOKEN_POOLS_TTL_MS) return cached.pools;
  const pools = await listV4Pools(client, token);
  tokenPoolsCache.set(key, { at: Date.now(), pools });
  return pools;
}

/**
 * The deepest native-ETH pool for a hub currency (META, USDG, …) — the first
 * leg of a two-hop route. On-chain discovery first: hubs are big, old tokens
 * with far more than the 30 pools DexScreener lists per token, and confirmed
 * 2026-09-24 that USDG's ETH pool (0.01% tier) wasn't among its listed 30.
 */
// Neither source alone reliably names the best leg: on-chain discovery ranks
// by raw in-range liquidity, which isn't comparable across fee tiers
// (confirmed: it picked a 5%-fee GOOGL pool whose quote reverts), and
// DexScreener's list can miss the pool entirely (USDG). Offer a few from
// both and let the live quotes decide.
const MAX_LEGS_PER_HUB = 3;

async function hubLegs(client: PublicClient, hub: `0x${string}`): Promise<RoutePool[]> {
  const key = hub.toLowerCase();
  const cached = hubLegCache.get(key);
  if (cached && Date.now() - cached.at < HUB_LEG_TTL_MS) return cached.legs;
  const legs: RoutePool[] = [];
  const addLeg = (leg: RoutePool) => {
    if (!isPredatoryFee(leg.poolKey) && !legs.some((l) => same(l.poolId, leg.poolId))) legs.push(leg);
  };
  const [onChain, listed] = await Promise.allSettled([discoverPool(client, hub), listV4Pools(client, hub)]);
  if (onChain.status === "fulfilled" && onChain.value) addLeg({ poolKey: onChain.value.poolKey, poolId: onChain.value.poolId });
  if (listed.status === "fulfilled") {
    listed.value
      .filter((p) => same(p.counter, NATIVE_ETH_CURRENCY))
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
      .forEach((p) => addLeg(p.pool));
  }
  const top = legs.slice(0, MAX_LEGS_PER_HUB);
  hubLegCache.set(key, { at: Date.now(), legs: top });
  return top;
}

// The legacy Initialize-log scan for a direct ETH pool walks up to 30 chunks
// sequentially — ~30s for a token that simply has no ETH pool (measured
// 2026-09-24), and it used to re-run on every single quote. A miss is
// remembered briefly (an ETH pool can still appear later — MUSETOWN's opened
// 7h after research), and when DexScreener already listed routes the scan
// only gets a short grace period; it keeps running and fills
// poolDiscovery.ts's own cache for the next quote either way.
const DIRECT_MISS_RETRY_MS = 5 * 60_000;
const DIRECT_DISCOVERY_GRACE_MS = 1_500;
const directMissUntil = new Map<string, number>();

async function directPool(client: PublicClient, token: `0x${string}`, options: { allowHighFeePools?: boolean }): Promise<RoutePool | undefined> {
  const key = `${token.toLowerCase()}:${options.allowHighFeePools ?? false}`;
  if ((directMissUntil.get(key) ?? 0) > Date.now()) return undefined;
  const pool = await discoverPool(client, token, options);
  if (!pool) {
    directMissUntil.set(key, Date.now() + DIRECT_MISS_RETRY_MS);
    return undefined;
  }
  return { poolKey: pool.poolKey, poolId: pool.poolId };
}

const TIMED_OUT = Symbol("timed out");
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return Promise.race([promise, new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), ms))]);
}

/**
 * Every route from native ETH to `token` worth quoting: direct ETH pools
 * (the log-scan discovery that has always run, which also finds pools too
 * new for DexScreener, plus any listed ones) and ETH → hub → token through
 * each other currency the token trades against. Fee-trap pools are only
 * allowed when the caller says so (exits — see DiscoverPoolOptions).
 *
 * Throws PoolDiscoveryInconclusiveError only when nothing could be found AND
 * direct discovery failed for an infra reason — "couldn't check" must never
 * read as "no route" (see poolDiscovery.ts).
 */
export async function candidateRoutes(
  client: PublicClient,
  tokenAddress: `0x${string}`,
  options: { allowHighFeePools?: boolean } = {}
): Promise<SwapRoute[]> {
  const token = getAddress(tokenAddress);
  const allowFeeTraps = options.allowHighFeePools ?? false;

  const directPromise = directPool(client, token, options);
  // Never let a slow/failed scan surface as an unhandled rejection when it
  // loses the grace-period race below.
  directPromise.catch(() => undefined);
  const [listedResult] = await Promise.allSettled([tokenPools(client, token)]);
  const listedAny = listedResult.status === "fulfilled" && listedResult.value.length > 0;
  const directResult: PromiseSettledResult<RoutePool | undefined> = await (async () => {
    try {
      const value = listedAny ? await within(directPromise, DIRECT_DISCOVERY_GRACE_MS) : await directPromise;
      return { status: "fulfilled" as const, value: value === TIMED_OUT ? undefined : value };
    } catch (reason) {
      return { status: "rejected" as const, reason };
    }
  })();

  const routes: SwapRoute[] = [];
  const seen = new Set<string>();
  const add = (route: SwapRoute) => {
    const id = `${route.viaWeth ? "weth:" : ""}${route.pools.map((p) => p.poolId.toLowerCase()).join(">")}`;
    if (seen.has(id)) return;
    if (!allowFeeTraps && route.pools.some((p) => isPredatoryFee(p.poolKey))) return;
    seen.add(id);
    routes.push(route);
  };

  if (directResult.status === "fulfilled" && directResult.value) {
    add({ pools: [directResult.value], hubs: [] });
  }

  const listed = listedResult.status === "fulfilled" ? listedResult.value : [];
  if (listedResult.status === "rejected") {
    logger.warn({ token, err: String(listedResult.reason) }, "listing a token's v4 pools failed — quoting direct-ETH routes only");
  }
  for (const p of listed) {
    if (same(p.counter, NATIVE_ETH_CURRENCY)) add({ pools: [p.pool], hubs: [] });
    else if (same(p.counter, ROBINHOOD_WETH)) add({ pools: [p.pool], hubs: [], viaWeth: true });
  }
  const hubPools = listed.filter((p) => !same(p.counter, NATIVE_ETH_CURRENCY) && !same(p.counter, ROBINHOOD_WETH));
  const legsPerHub = await Promise.allSettled(hubPools.map((p) => hubLegs(client, p.counter)));
  legsPerHub.forEach((legs, i) => {
    if (legs.status !== "fulfilled") return;
    for (const leg of legs.value) add({ pools: [leg, hubPools[i].pool], hubs: [hubPools[i].counter] });
  });

  if (routes.length === 0 && directResult.status === "rejected" && isPoolDiscoveryInconclusiveError(directResult.reason)) {
    throw directResult.reason;
  }
  return routes;
}

// A pool's factory and fee never change — classified once per process.
const legacyPoolKind = new Map<string, { venue: "v2" | "v3"; fee?: number } | null>();
const MAX_LEGACY_POOLS_PER_TOKEN = 3;

async function classifyLegacyPool(client: PublicClient, pool: `0x${string}`): Promise<{ venue: "v2" | "v3"; fee?: number } | null> {
  const key = pool.toLowerCase();
  if (legacyPoolKind.has(key)) return legacyPoolKind.get(key) ?? null;
  const factory = (await client.readContract({ address: pool, abi: LEGACY_POOL_ABI, functionName: "factory" })).toLowerCase();
  let kind: { venue: "v2" | "v3"; fee?: number } | null = null;
  if (factory === UNISWAP_LEGACY_ADDRESSES.v3Factory) {
    kind = { venue: "v3", fee: await client.readContract({ address: pool, abi: LEGACY_POOL_ABI, functionName: "fee" }) };
  } else if (factory === UNISWAP_LEGACY_ADDRESSES.v2Factory) {
    kind = { venue: "v2" };
  }
  legacyPoolKind.set(key, kind);
  return kind;
}

// Straight from Uniswap's own v2/v3 factories — independent of DexScreener,
// which confirmed 2026-09-24 drops quiet pools entirely (DEED, PAWSINU: live
// v2 pools, zero listed pairs). That matters most for an open position whose
// pool stops being listed: it still has to be sellable.
const ON_CHAIN_LEGACY_TTL_MS = 10 * 60_000;
const onChainLegacyCache = new Map<string, { at: number; routes: LegacyRoute[] }>();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function onChainLegacyRoutes(client: PublicClient, token: `0x${string}`): Promise<LegacyRoute[]> {
  const key = token.toLowerCase();
  const cached = onChainLegacyCache.get(key);
  if (cached && Date.now() - cached.at < ON_CHAIN_LEGACY_TTL_MS) return cached.routes;
  const [v2, ...v3] = await Promise.allSettled([
    client.readContract({ address: UNISWAP_LEGACY_ADDRESSES.v2Factory as `0x${string}`, abi: V2_FACTORY_ABI, functionName: "getPair", args: [token, ROBINHOOD_WETH] }),
    ...V3_STANDARD_FEE_TIERS.map((fee) =>
      client.readContract({ address: UNISWAP_LEGACY_ADDRESSES.v3Factory as `0x${string}`, abi: V3_FACTORY_ABI, functionName: "getPool", args: [token, ROBINHOOD_WETH, fee] })
    ),
  ]);
  const routes: LegacyRoute[] = [];
  if (v2.status === "fulfilled" && !same(v2.value, ZERO_ADDRESS)) routes.push({ venue: "v2", pool: v2.value });
  v3.forEach((r, i) => {
    if (r.status === "fulfilled" && !same(r.value, ZERO_ADDRESS)) routes.push({ venue: "v3", pool: r.value, fee: V3_STANDARD_FEE_TIERS[i] });
  });
  onChainLegacyCache.set(key, { at: Date.now(), routes });
  return routes;
}

/**
 * The token's Uniswap v2/v3 WETH pools — only when SwapRouter02 is in the
 * router allowlist, so a route is never chosen that signing would refuse.
 */
async function legacyRoutes(client: PublicClient, token: `0x${string}`): Promise<LegacyRoute[]> {
  if (!isRouterAllowed(UNISWAP_LEGACY_ADDRESSES.swapRouter02)) return [];
  const [listed, onChain] = await Promise.allSettled([listedLegacyRoutes(client, token), onChainLegacyRoutes(client, token)]);
  const routes: LegacyRoute[] = [];
  for (const r of [...(listed.status === "fulfilled" ? listed.value : []), ...(onChain.status === "fulfilled" ? onChain.value : [])]) {
    if (!routes.some((existing) => same(existing.pool, r.pool))) routes.push(r);
  }
  return routes;
}

async function listedLegacyRoutes(client: PublicClient, token: `0x${string}`): Promise<LegacyRoute[]> {
  const market = await cachedMarket(token);
  const pairs = market.pairs
    .filter(
      (p) =>
        p.pairAddress?.length === 42 &&
        ((same(p.baseTokenAddress ?? "", token) && same(p.quoteTokenAddress ?? "", ROBINHOOD_WETH)) ||
          (same(p.quoteTokenAddress ?? "", token) && same(p.baseTokenAddress ?? "", ROBINHOOD_WETH)))
    )
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
    .slice(0, MAX_LEGACY_POOLS_PER_TOKEN);
  const kinds = await Promise.allSettled(pairs.map((p) => classifyLegacyPool(client, p.pairAddress as `0x${string}`)));
  const routes: LegacyRoute[] = [];
  kinds.forEach((k, i) => {
    if (k.status === "fulfilled" && k.value) routes.push({ ...k.value, pool: pairs[i].pairAddress as `0x${string}` });
  });
  return routes;
}

export async function quoteLegacyRoute(client: PublicClient, route: LegacyRoute, token: `0x${string}`, isBuy: boolean, amountIn: bigint): Promise<RouteQuote> {
  const [tokenIn, tokenOut] = isBuy ? [ROBINHOOD_WETH, token] : [token, ROBINHOOD_WETH];
  if (route.venue === "v3") {
    const { result } = await client.simulateContract({
      address: UNISWAP_LEGACY_ADDRESSES.quoterV2 as `0x${string}`,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, fee: route.fee ?? 0, sqrtPriceLimitX96: 0n }],
    });
    return { route, amountOut: result[0], gasEstimateUnits: result[3] };
  }
  const amounts = await client.readContract({
    address: UNISWAP_LEGACY_ADDRESSES.v2Router02 as `0x${string}`,
    abi: V2_ROUTER_QUOTE_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, [tokenIn, tokenOut]],
  });
  return { route, amountOut: amounts[amounts.length - 1], gasEstimateUnits: 0n };
}

export async function quoteRoute(
  client: PublicClient,
  route: SwapRoute,
  token: `0x${string}`,
  isBuy: boolean,
  amountIn: bigint
): Promise<RouteQuote> {
  const { currencyIn, path } = pathFor(route, token, isBuy);
  if (route.pools.length === 1) {
    const { poolKey } = route.pools[0];
    const { result } = await client.simulateContract({
      address: UNISWAP_V4_ADDRESSES.quoter as `0x${string}`,
      abi: V4_QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey, zeroForOne: zeroForOneFor(poolKey, currencyIn), exactAmount: amountIn, hookData: "0x" }],
    });
    return { route, amountOut: result[0], gasEstimateUnits: result[1] };
  }
  const { result } = await client.simulateContract({
    address: UNISWAP_V4_ADDRESSES.quoter as `0x${string}`,
    abi: V4_QUOTER_ABI,
    functionName: "quoteExactInput",
    args: [{ exactCurrency: currencyIn, path, exactAmount: amountIn }],
  });
  return { route, amountOut: result[0], gasEstimateUnits: result[1] };
}

/** Quotes every candidate route in parallel and returns the one that pays out the most. */
export async function bestRouteQuote(
  client: PublicClient,
  tokenAddress: `0x${string}`,
  isBuy: boolean,
  amountIn: bigint,
  options: { allowHighFeePools?: boolean } = {}
): Promise<RouteQuote | undefined> {
  const token = getAddress(tokenAddress);
  const [v4Result, legacyResult] = await Promise.allSettled([candidateRoutes(client, token, options), legacyRoutes(client, token)]);
  const v4Routes = v4Result.status === "fulfilled" ? v4Result.value : [];
  const legacy = legacyResult.status === "fulfilled" ? legacyResult.value : [];
  if (legacyResult.status === "rejected") {
    logger.warn({ token, err: String(legacyResult.reason).slice(0, 200) }, "listing v2/v3 routes failed — quoting v4 routes only");
  }
  if (v4Routes.length === 0 && legacy.length === 0) {
    // "Couldn't check" must never read as "no route" — see candidateRoutes.
    if (v4Result.status === "rejected") throw v4Result.reason;
    return undefined;
  }

  const quotes = await Promise.allSettled([
    ...v4Routes.map((route) => quoteRoute(client, route, token, isBuy, amountIn)),
    ...legacy.map((route) => quoteLegacyRoute(client, route, token, isBuy, amountIn)),
  ]);
  let best: RouteQuote | undefined;
  for (const q of quotes) {
    if (q.status === "fulfilled" && q.value.amountOut > 0n && (!best || q.value.amountOut > best.amountOut)) best = q.value;
  }
  const candidates = v4Routes.length + legacy.length;
  if (!best) {
    const firstError = quotes.find((q): q is PromiseRejectedResult => q.status === "rejected");
    logger.warn({ token, routes: candidates, err: firstError ? String(firstError.reason).slice(0, 240) : undefined }, "no candidate route produced a quote");
    return undefined;
  }
  if (isLegacyRoute(best.route) || best.route.pools.length > 1 || best.route.viaWeth) {
    logger.info({ token, route: routeLabel(best.route, hubSymbols), candidates, direction: isBuy ? "buy" : "sell" }, "best route is not a direct ETH pool");
  }
  return best;
}

/** Current in-range liquidity of a pool — diagnostics only (see LiveQuote.poolLiquidity). */
export async function readPoolLiquidity(client: PublicClient, poolId: `0x${string}`): Promise<bigint> {
  return client.readContract({
    address: UNISWAP_V4_ADDRESSES.stateView as `0x${string}`,
    abi: STATE_VIEW_ABI,
    functionName: "getLiquidity",
    args: [poolId],
  });
}

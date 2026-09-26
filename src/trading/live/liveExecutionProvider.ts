import { encodeAbiParameters, encodeFunctionData } from "viem";
import { logger } from "../../logger";
import { tradingConfig } from "../config";
import {
  UNISWAP_V4_ADDRESSES,
  UNISWAP_LEGACY_ADDRESSES,
  UNIVERSAL_ROUTER_COMMANDS,
  UNIVERSAL_ROUTER_EXECUTE_ABI,
  ROUTER_RECIPIENT,
  ROBINHOOD_WETH,
  ROBINHOOD_USDG,
  ROBINHOOD_USDG_DECIMALS,
  SWAP_ROUTER_02_ABI,
  NATIVE_ETH_CURRENCY,
} from "./contracts";
import { discoverPool, type PoolKey } from "./poolDiscovery";
import { bestRouteQuote, computePoolId, quoteRoute, rankedRouteQuotes, isLegacyRoute, pathFor, routeLabel, tokenSidePool, v2PathFor, v3PathFor, zeroForOneFor, type AnyRoute, type LegacyRoute, type SwapRoute } from "./routing";
import { encodeV4Swap, encodeV4SwapExactIn, encodeV4SwapExactInSingle, type V4SwapSpec } from "./swapEncoding";
import { ensureSellApprovals, ensureSwapRouter02Approval } from "./permit2Approvals";
import { getPublicClient, getWalletAddress, signAndSendTransaction, isWalletConfigured } from "./wallet";

const SWAP_DEADLINE_SECONDS = 300; // 5 minutes — matches the plan/entry revalidation cadence

export interface LiveQuote {
  route: AnyRoute;
  routeLabel: string;
  // The pool holding the token itself (the last hop of a buy) — diagnostics.
  // A v2/v3 pool has an address instead of a v4 PoolKey.
  poolKey?: PoolKey;
  poolId: `0x${string}`;
  poolLiquidity?: bigint;
  amountOut: bigint;
  gasEstimateUnits: bigint;
}

/**
 * Best real on-chain quote across every route from native ETH to the token
 * (see routing.ts) — `eth_call`-simulated via V4Quoter, never a state change.
 */
export async function getLiveQuotes(
  tokenAddress: `0x${string}`,
  isBuy: boolean,
  amountIn: bigint,
  options: { allowHighFeePools?: boolean } = {}
): Promise<LiveQuote[]> {
  const ranked = await rankedRouteQuotes(getPublicClient(), tokenAddress, isBuy, amountIn, options);
  if (ranked.length === 0) logger.warn({ tokenAddress }, "no live route found for this token — cannot quote");
  return ranked.map((q) => {
    const base = { route: q.route, routeLabel: routeLabel(q.route), amountOut: q.amountOut, gasEstimateUnits: q.gasEstimateUnits };
    if (isLegacyRoute(q.route)) return { ...base, poolId: q.route.pool };
    const pool = tokenSidePool(q.route);
    return { ...base, poolKey: pool.poolKey, poolId: pool.poolId };
  });
}

export async function getLiveQuote(
  tokenAddress: `0x${string}`,
  isBuy: boolean,
  amountIn: bigint,
  options: { allowHighFeePools?: boolean } = {}
): Promise<LiveQuote | undefined> {
  return (await getLiveQuotes(tokenAddress, isBuy, amountIn, options))[0];
}

export interface LiveSwapResult {
  txHash: `0x${string}`;
  amountIn: bigint;
  amountOutMinimum: bigint;
  approvalTxHashes: string[];
  routeLabel: string;
  venue: "v4" | "v2" | "v3";
}

export function routerCommands(...commands: number[]): `0x${string}` {
  return `0x${commands.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** The (commands, inputs) pair for one Universal Router execute() that trades `route`. */
export function buildRouterPlan(
  route: SwapRoute,
  token: `0x${string}`,
  isBuy: boolean,
  amountIn: bigint,
  amountOutMinimum: bigint
): { commands: `0x${string}`; inputs: `0x${string}`[] } {
  const { currencyIn, currencyOut, path } = pathFor(route, token, isBuy);
  const swap: V4SwapSpec =
    route.pools.length === 1
      ? { kind: "single", poolKey: route.pools[0].poolKey, zeroForOne: zeroForOneFor(route.pools[0].poolKey, currencyIn) }
      : { kind: "multi", path };

  if (!route.viaWeth) {
    // Direct routes keep the single-hop encoding that has been trading live
    // since day one; only multi-hop routes use SWAP_EXACT_IN.
    const swapInput =
      swap.kind === "single"
        ? encodeV4SwapExactInSingle({ poolKey: swap.poolKey, zeroForOne: swap.zeroForOne, amountIn, amountOutMinimum, settleCurrency: currencyIn, takeCurrency: currencyOut })
        : encodeV4SwapExactIn({ currencyIn, path, amountIn, amountOutMinimum, currencyOut });
    return { commands: routerCommands(UNIVERSAL_ROUTER_COMMANDS.V4_SWAP), inputs: [swapInput] };
  }

  const recipientAndAmount = (recipient: `0x${string}`, amount: bigint) =>
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [recipient, amount]);
  if (isBuy) {
    // msg.value -> WETH held by the router -> the v4 swap pays with it.
    return {
      commands: routerCommands(UNIVERSAL_ROUTER_COMMANDS.WRAP_ETH, UNIVERSAL_ROUTER_COMMANDS.V4_SWAP),
      inputs: [
        recipientAndAmount(ROUTER_RECIPIENT.ADDRESS_THIS, amountIn),
        encodeV4Swap({ swap, currencyIn, currencyOut, amountIn, amountOutMinimum, settleFrom: "router", takeTo: "user" }),
      ],
    };
  }
  // Token (via Permit2) -> WETH left with the router -> unwrapped to ETH for
  // the wallet, which is where the slippage floor is enforced.
  return {
    commands: routerCommands(UNIVERSAL_ROUTER_COMMANDS.V4_SWAP, UNIVERSAL_ROUTER_COMMANDS.UNWRAP_WETH),
    inputs: [
      encodeV4Swap({ swap, currencyIn, currencyOut, amountIn, amountOutMinimum, settleFrom: "user", takeTo: "router" }),
      recipientAndAmount(ROUTER_RECIPIENT.MSG_SENDER, amountOutMinimum),
    ],
  };
}

function buildExecuteCalldata(route: SwapRoute, token: `0x${string}`, isBuy: boolean, amountIn: bigint, amountOutMinimum: bigint) {
  const { commands, inputs } = buildRouterPlan(route, token, isBuy, amountIn, amountOutMinimum);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS);
  return encodeFunctionData({ abi: UNIVERSAL_ROUTER_EXECUTE_ABI, functionName: "execute", args: [commands, inputs, deadline] });
}

/**
 * SwapRouter02 multicall for a v2/v3 WETH pool. Buys pay with msg.value
 * (the router wraps it) and deliver the token straight to the wallet; sells
 * pull the token (ERC20 approval), leave the WETH with the router, and
 * unwrap it to the wallet — the slippage floor is enforced on the swap and
 * again on the unwrap.
 */
export function buildLegacyCalldata(
  route: LegacyRoute,
  token: `0x${string}`,
  isBuy: boolean,
  amountIn: bigint,
  amountOutMinimum: bigint,
  wallet: `0x${string}`
): `0x${string}` {
  const [tokenIn, tokenOut] = isBuy ? [ROBINHOOD_WETH, token] : [token, ROBINHOOD_WETH];
  const recipient = isBuy ? wallet : ROUTER_RECIPIENT.ADDRESS_THIS;
  const swap =
    route.venue === "v3" && route.hub
      ? encodeFunctionData({
          abi: SWAP_ROUTER_02_ABI,
          functionName: "exactInput",
          args: [{ path: v3PathFor(route, token, isBuy), recipient, amountIn, amountOutMinimum }],
        })
      : route.venue === "v3"
      ? encodeFunctionData({
          abi: SWAP_ROUTER_02_ABI,
          functionName: "exactInputSingle",
          args: [{ tokenIn, tokenOut, fee: route.fee ?? 0, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }],
        })
      : encodeFunctionData({ abi: SWAP_ROUTER_02_ABI, functionName: "swapExactTokensForTokens", args: [amountIn, amountOutMinimum, v2PathFor(route, token, isBuy), recipient] });
  const calls = isBuy ? [swap] : [swap, encodeFunctionData({ abi: SWAP_ROUTER_02_ABI, functionName: "unwrapWETH9", args: [amountOutMinimum, wallet] })];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS);
  return encodeFunctionData({ abi: SWAP_ROUTER_02_ABI, functionName: "multicall", args: [deadline, calls] });
}

/** Which router to send to and the exact calldata, for whichever kind of route won. */
function transactionFor(route: AnyRoute, token: `0x${string}`, isBuy: boolean, amountIn: bigint, amountOutMinimum: bigint) {
  if (isLegacyRoute(route)) {
    return {
      to: UNISWAP_LEGACY_ADDRESSES.swapRouter02 as `0x${string}`,
      data: buildLegacyCalldata(route, token, isBuy, amountIn, amountOutMinimum, getWalletAddress()),
      venue: route.venue,
    };
  }
  return {
    to: UNISWAP_V4_ADDRESSES.universalRouter as `0x${string}`,
    data: buildExecuteCalldata(route, token, isBuy, amountIn, amountOutMinimum),
    venue: "v4" as const,
  };
}

/**
 * §27 transaction preflight's "simulation successful?" check — an `eth_call`
 * dry-run of the EXACT calldata that would be sent, before it's ever signed.
 * A revert here means DO NOT SIGN, full stop.
 */
async function simulateExecute(to: `0x${string}`, data: `0x${string}`, value: bigint): Promise<{ ok: boolean; error?: string }> {
  const client = getPublicClient();
  try {
    await client.call({ to, data, value, account: getWalletAddress() });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// How many ranked routes to try before giving up on a trade.
const MAX_ROUTE_ATTEMPTS = 3;

/**
 * The best-paying route whose exact transaction also simulates cleanly
 * through the real router, trying up to MAX_ROUTE_ATTEMPTS in payout order.
 * `prepare` runs before each simulation (sells: the approval that route's
 * router needs).
 */
async function firstExecutableRoute(
  quotes: LiveQuote[],
  token: `0x${string}`,
  isBuy: boolean,
  amountIn: bigint,
  maxSlippageBps: number,
  prepare?: (quote: LiveQuote) => Promise<void>
): Promise<{ quote: LiveQuote; tx: ReturnType<typeof transactionFor>; amountOutMinimum: bigint } | { failures: string[] }> {
  const failures: string[] = [];
  for (const [i, quote] of quotes.slice(0, MAX_ROUTE_ATTEMPTS).entries()) {
    const amountOutMinimum = (quote.amountOut * BigInt(10_000 - maxSlippageBps)) / 10_000n;
    const tx = transactionFor(quote.route, token, isBuy, amountIn, amountOutMinimum);
    await prepare?.(quote);
    const sim = await simulateExecute(tx.to, tx.data, isBuy ? amountIn : 0n);
    if (sim.ok) {
      if (i > 0) logger.warn({ token, route: quote.routeLabel, skipped: failures }, "better-quoted route failed simulation — using the next-best one");
      return { quote, tx, amountOutMinimum };
    }
    failures.push(`${quote.routeLabel}: ${String(sim.error).replace(/\s+/g, " ").slice(0, 200)}`);
  }
  return { failures };
}

/**
 * Everything executeLiveBuy does short of signing: best-route quote, the
 * exact calldata a buy would send, and an eth_call of it from the bot's
 * wallet through the real router (hooks, fees and all). Never sends anything.
 */
export async function dryRunLiveBuy(
  tokenAddress: `0x${string}`,
  amountInWei: bigint,
  maxSlippageBps: number
): Promise<{ ok: boolean; routeLabel?: string; amountOut?: bigint; error?: string }> {
  const quotes = await getLiveQuotes(tokenAddress, true, amountInWei);
  if (quotes.length === 0) return { ok: false, error: "no route" };
  const picked = await firstExecutableRoute(quotes, tokenAddress, true, amountInWei, maxSlippageBps);
  if ("failures" in picked) return { ok: false, routeLabel: quotes[0].routeLabel, amountOut: quotes[0].amountOut, error: picked.failures.join(" | ") };
  return { ok: true, routeLabel: picked.quote.routeLabel, amountOut: picked.quote.amountOut };
}

/** Buy: pay with native ETH (msg.value), no token approval needed. */
export async function executeLiveBuy(tokenAddress: `0x${string}`, amountInWei: bigint, maxSlippageBps: number): Promise<LiveSwapResult> {
  if (!isWalletConfigured()) throw new Error("BOT_WALLET_PRIVATE_KEY is not set — cannot execute a live buy");
  const quotes = await getLiveQuotes(tokenAddress, true, amountInWei);
  if (quotes.length === 0) throw new Error(`no live quote available for ${tokenAddress}`);

  const picked = await firstExecutableRoute(quotes, tokenAddress, true, amountInWei, maxSlippageBps);
  if ("failures" in picked) throw new Error(`buy simulation reverted on every route, refusing to sign: ${picked.failures.join(" | ")}`);

  const { quote, tx, amountOutMinimum } = picked;
  const txHash = await signAndSendTransaction({ to: tx.to, data: tx.data, value: amountInWei, purpose: "swap" });
  return { txHash, amountIn: amountInWei, amountOutMinimum, approvalTxHashes: [], routeLabel: quote.routeLabel, venue: tx.venue };
}

/** Sell: pay with the token (approvals topped up only if actually insufficient). */
export async function executeLiveSell(tokenAddress: `0x${string}`, tokenAmount: bigint, maxSlippageBps: number): Promise<LiveSwapResult> {
  if (!isWalletConfigured()) throw new Error("BOT_WALLET_PRIVATE_KEY is not set — cannot execute a live sell");
  // Exits may route through a predatory-fee pool when it's the only
  // venue — see DiscoverPoolOptions.allowHighFeePools. Entries never do.
  const quotes = await getLiveQuotes(tokenAddress, false, tokenAmount, { allowHighFeePools: true });
  if (quotes.length === 0) throw new Error(`no live quote available for ${tokenAddress}`);

  // v2/v3 (SwapRouter02) pulls the token with a plain ERC20 approval; v4
  // (Universal Router) pulls it through Permit2 — whichever the route being
  // tried needs has to be in place before it can simulate.
  const approvalTxHashes: string[] = [];
  const picked = await firstExecutableRoute(quotes, tokenAddress, false, tokenAmount, maxSlippageBps, async (quote) => {
    approvalTxHashes.push(
      ...(isLegacyRoute(quote.route) ? await ensureSwapRouter02Approval(tokenAddress, tokenAmount) : await ensureSellApprovals(tokenAddress, tokenAmount))
    );
  });
  if ("failures" in picked) throw new Error(`sell simulation reverted on every route, refusing to sign: ${picked.failures.join(" | ")}`);

  const { quote, tx, amountOutMinimum } = picked;
  const txHash = await signAndSendTransaction({ to: tx.to, data: tx.data, value: 0n, purpose: "swap" });
  return { txHash, amountIn: tokenAmount, amountOutMinimum, approvalTxHashes, routeLabel: quote.routeLabel, venue: tx.venue };
}

/**
 * Resolves and caches every route to a token (pool keys, hub legs, v2/v3
 * pools, and misses) ahead of an entry — the slow, one-off part of routing —
 * so the entry itself only has to re-quote (measured 2026-09-24: ~0.6-1.6s
 * warm vs 4-17s cold). Quote-only: never sends anything, never records an
 * execution-quality row.
 */
export async function warmRoutes(tokenAddress: `0x${string}`): Promise<void> {
  await bestRouteQuote(getPublicClient(), tokenAddress, true, ROUTE_WARMUP_AMOUNT_WEI);
}
const ROUTE_WARMUP_AMOUNT_WEI = 1_000_000_000_000_000n; // 0.001 ETH

/**
 * ETH/USD on Robinhood Chain itself: what 0.01 ETH buys in the chain's
 * native-ETH/USDG v4 pools (USDG is Paxos' $1 stablecoin), quoted in
 * ~200ms. Confirmed live 2026-09-24 that the DexScreener-pair method in
 * portfolio.ts couldn't be relied on: its calls share DexScreener's
 * one-request-per-second queue with research and never got a slot within
 * their 3s budget, so the portfolio showed no EVM cash at all.
 *
 * Quoted against pinned pools (ETH_USD_REFERENCE_POOLS), not a fresh pool
 * discovery: that scanned PoolManager's Initialize logs, which the RPC
 * rate-limited after every restart in production (2026-09-25), leaving no
 * rate and no EVM cash in equity; and there are 556 native-ETH/USDG pools,
 * mostly spam, of which discovery only weighed the newest few. The median
 * of the pinned pools that quote plausibly, so one drained or pushed pool
 * can't set the rate. Undefined when none does.
 */
export async function quoteEthPriceUsd(): Promise<number | undefined> {
  const client = getPublicClient();
  const rates = await Promise.all(
    ETH_USD_REFERENCE_POOLS.map(async (poolKey) => {
      try {
        const route: SwapRoute = { pools: [{ poolKey, poolId: computePoolId(poolKey) }], hubs: [] };
        const quote = await quoteRoute(client, route, ROBINHOOD_USDG, true, ETH_PRICE_QUOTE_WEI);
        return Number(quote.amountOut) / 10 ** ROBINHOOD_USDG_DECIMALS / (Number(ETH_PRICE_QUOTE_WEI) / 1e18);
      } catch (err) {
        logger.debug({ poolId: computePoolId(poolKey), err: String(err) }, "ETH/USD reference pool quote failed");
        return undefined;
      }
    })
  );
  return medianPlausibleEthRate(rates);
}

/** The median of the rates inside ETH_PRICE_PLAUSIBLE_USD. */
export function medianPlausibleEthRate(rates: (number | undefined)[]): number | undefined {
  const ok = rates
    .filter((r): r is number => r !== undefined && r >= ETH_PRICE_PLAUSIBLE_USD.min && r <= ETH_PRICE_PLAUSIBLE_USD.max)
    .sort((a, b) => a - b);
  if (ok.length === 0) return undefined;
  const mid = Math.floor(ok.length / 2);
  return ok.length % 2 ? ok[mid] : (ok[mid - 1] + ok[mid]) / 2;
}

// The three deepest native-ETH/USDG v4 pools by active liquidity, found by
// scanning every Initialize event for the pair on the public RPC and
// quoting the top candidates (2026-09-25): 1 ETH sold for $2,676.82,
// $2,676.41 and $2,674.97 respectively. A pool key never changes once
// initialized; if these ever stop quoting, the DexScreener fallback in
// portfolio.ts still applies.
export const ETH_USD_REFERENCE_POOLS: PoolKey[] = [
  // Dynamic-fee pool behind hook 0x06a8…, initialized at block 41,259,014.
  // Deepest by far: no visible price impact at 1 ETH.
  { currency0: NATIVE_ETH_CURRENCY, currency1: ROBINHOOD_USDG, fee: 0x800000, tickSpacing: 10, hooks: "0x06a889870C8f83640D6816319f72e2aA579b6080" },
  // Hookless 0.01% pool, block 1,146,712.
  { currency0: NATIVE_ETH_CURRENCY, currency1: ROBINHOOD_USDG, fee: 100, tickSpacing: 1, hooks: "0x0000000000000000000000000000000000000000" },
  // Hookless 0.046% pool, block 4,429,344.
  { currency0: NATIVE_ETH_CURRENCY, currency1: ROBINHOOD_USDG, fee: 460, tickSpacing: 9, hooks: "0x0000000000000000000000000000000000000000" },
];
const ETH_PRICE_QUOTE_WEI = 10_000_000_000_000_000n; // 0.01 ETH
// Wide on purpose: only catches a drained or broken pool, never a real move.
const ETH_PRICE_PLAUSIBLE_USD = { min: 100, max: 100_000 };

export async function getWalletGasBalanceEth(): Promise<number> {
  const client = getPublicClient();
  const balance = await client.getBalance({ address: getWalletAddress() });
  return Number(balance) / 1e18;
}

export function isLiveModeReady(): boolean {
  return tradingConfig.mode === "LIVE" && isWalletConfigured();
}

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
  SWAP_ROUTER_02_ABI,
} from "./contracts";
import type { PoolKey } from "./poolDiscovery";
import { bestRouteQuote, isLegacyRoute, pathFor, routeLabel, tokenSidePool, zeroForOneFor, type AnyRoute, type LegacyRoute, type SwapRoute } from "./routing";
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
export async function getLiveQuote(
  tokenAddress: `0x${string}`,
  isBuy: boolean,
  amountIn: bigint,
  options: { allowHighFeePools?: boolean } = {}
): Promise<LiveQuote | undefined> {
  const client = getPublicClient();
  const best = await bestRouteQuote(client, tokenAddress, isBuy, amountIn, options);
  if (!best) {
    logger.warn({ tokenAddress }, "no live V4 route found for this token — cannot quote");
    return undefined;
  }
  const base = { route: best.route, routeLabel: routeLabel(best.route), amountOut: best.amountOut, gasEstimateUnits: best.gasEstimateUnits };
  if (isLegacyRoute(best.route)) return { ...base, poolId: best.route.pool };
  const pool = tokenSidePool(best.route);
  return { ...base, poolKey: pool.poolKey, poolId: pool.poolId };
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
    route.venue === "v3"
      ? encodeFunctionData({
          abi: SWAP_ROUTER_02_ABI,
          functionName: "exactInputSingle",
          args: [{ tokenIn, tokenOut, fee: route.fee ?? 0, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }],
        })
      : encodeFunctionData({ abi: SWAP_ROUTER_02_ABI, functionName: "swapExactTokensForTokens", args: [amountIn, amountOutMinimum, [tokenIn, tokenOut], recipient] });
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
  const quote = await getLiveQuote(tokenAddress, true, amountInWei);
  if (!quote) return { ok: false, error: "no route" };
  const amountOutMinimum = (quote.amountOut * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  const tx = transactionFor(quote.route, tokenAddress, true, amountInWei, amountOutMinimum);
  const sim = await simulateExecute(tx.to, tx.data, amountInWei);
  return { ok: sim.ok, routeLabel: quote.routeLabel, amountOut: quote.amountOut, error: sim.error };
}

/** Buy: pay with native ETH (msg.value), no token approval needed. */
export async function executeLiveBuy(tokenAddress: `0x${string}`, amountInWei: bigint, maxSlippageBps: number): Promise<LiveSwapResult> {
  if (!isWalletConfigured()) throw new Error("BOT_WALLET_PRIVATE_KEY is not set — cannot execute a live buy");
  const quote = await getLiveQuote(tokenAddress, true, amountInWei);
  if (!quote) throw new Error(`no live quote available for ${tokenAddress}`);

  const amountOutMinimum = (quote.amountOut * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  const tx = transactionFor(quote.route, tokenAddress, true, amountInWei, amountOutMinimum);

  const sim = await simulateExecute(tx.to, tx.data, amountInWei);
  if (!sim.ok) throw new Error(`buy simulation reverted (route ${quote.routeLabel}), refusing to sign: ${sim.error}`);

  const txHash = await signAndSendTransaction({ to: tx.to, data: tx.data, value: amountInWei, purpose: "swap" });
  return { txHash, amountIn: amountInWei, amountOutMinimum, approvalTxHashes: [], routeLabel: quote.routeLabel, venue: tx.venue };
}

/** Sell: pay with the token (approvals topped up only if actually insufficient). */
export async function executeLiveSell(tokenAddress: `0x${string}`, tokenAmount: bigint, maxSlippageBps: number): Promise<LiveSwapResult> {
  if (!isWalletConfigured()) throw new Error("BOT_WALLET_PRIVATE_KEY is not set — cannot execute a live sell");
  // Exits may route through a predatory-fee pool when it's the only
  // venue — see DiscoverPoolOptions.allowHighFeePools. Entries never do.
  const quote = await getLiveQuote(tokenAddress, false, tokenAmount, { allowHighFeePools: true });
  if (!quote) throw new Error(`no live quote available for ${tokenAddress}`);

  // v2/v3 (SwapRouter02) pulls the token with a plain ERC20 approval; v4
  // (Universal Router) pulls it through Permit2.
  const approvalTxHashes = isLegacyRoute(quote.route)
    ? await ensureSwapRouter02Approval(tokenAddress, tokenAmount)
    : await ensureSellApprovals(tokenAddress, tokenAmount);

  const amountOutMinimum = (quote.amountOut * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  const tx = transactionFor(quote.route, tokenAddress, false, tokenAmount, amountOutMinimum);

  const sim = await simulateExecute(tx.to, tx.data, 0n);
  if (!sim.ok) throw new Error(`sell simulation reverted (route ${quote.routeLabel}), refusing to sign: ${sim.error}`);

  const txHash = await signAndSendTransaction({ to: tx.to, data: tx.data, value: 0n, purpose: "swap" });
  return { txHash, amountIn: tokenAmount, amountOutMinimum, approvalTxHashes, routeLabel: quote.routeLabel, venue: tx.venue };
}

export async function getWalletGasBalanceEth(): Promise<number> {
  const client = getPublicClient();
  const balance = await client.getBalance({ address: getWalletAddress() });
  return Number(balance) / 1e18;
}

export function isLiveModeReady(): boolean {
  return tradingConfig.mode === "LIVE" && isWalletConfigured();
}

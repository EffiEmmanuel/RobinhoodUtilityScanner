import { encodeFunctionData } from "viem";
import { logger } from "../../logger";
import { tradingConfig } from "../config";
import { UNISWAP_V4_ADDRESSES, UNIVERSAL_ROUTER_COMMANDS, UNIVERSAL_ROUTER_EXECUTE_ABI } from "./contracts";
import type { PoolKey } from "./poolDiscovery";
import { bestRouteQuote, pathFor, routeLabel, tokenSidePool, zeroForOneFor, type SwapRoute } from "./routing";
import { encodeV4SwapExactIn, encodeV4SwapExactInSingle } from "./swapEncoding";
import { ensureSellApprovals } from "./permit2Approvals";
import { getPublicClient, getWalletAddress, signAndSendTransaction, isWalletConfigured } from "./wallet";

const SWAP_DEADLINE_SECONDS = 300; // 5 minutes — matches the plan/entry revalidation cadence

export interface LiveQuote {
  route: SwapRoute;
  routeLabel: string;
  // The pool holding the token itself (the last hop of a buy) — diagnostics.
  poolKey: PoolKey;
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
  const pool = tokenSidePool(best.route);
  return {
    route: best.route,
    routeLabel: routeLabel(best.route),
    poolKey: pool.poolKey,
    poolId: pool.poolId,
    amountOut: best.amountOut,
    gasEstimateUnits: best.gasEstimateUnits,
  };
}

export interface LiveSwapResult {
  txHash: `0x${string}`;
  amountIn: bigint;
  amountOutMinimum: bigint;
  approvalTxHashes: string[];
  routeLabel: string;
}

function buildExecuteCalldata(route: SwapRoute, token: `0x${string}`, isBuy: boolean, amountIn: bigint, amountOutMinimum: bigint) {
  const { currencyIn, currencyOut, path } = pathFor(route, token, isBuy);
  // Direct routes keep the single-hop encoding that has been trading live
  // since day one; only multi-hop routes use SWAP_EXACT_IN.
  const swapInput =
    route.pools.length === 1
      ? encodeV4SwapExactInSingle({
          poolKey: route.pools[0].poolKey,
          zeroForOne: zeroForOneFor(route.pools[0].poolKey, currencyIn),
          amountIn,
          amountOutMinimum,
          settleCurrency: currencyIn,
          takeCurrency: currencyOut,
        })
      : encodeV4SwapExactIn({ currencyIn, path, amountIn, amountOutMinimum, currencyOut });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS);
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_EXECUTE_ABI,
    functionName: "execute",
    args: [`0x${UNIVERSAL_ROUTER_COMMANDS.V4_SWAP.toString(16).padStart(2, "0")}`, [swapInput], deadline],
  });
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
  const data = buildExecuteCalldata(quote.route, tokenAddress, true, amountInWei, amountOutMinimum);
  const sim = await simulateExecute(UNISWAP_V4_ADDRESSES.universalRouter as `0x${string}`, data, amountInWei);
  return { ok: sim.ok, routeLabel: quote.routeLabel, amountOut: quote.amountOut, error: sim.error };
}

/** Buy: pay with native ETH (msg.value), no token approval needed. */
export async function executeLiveBuy(tokenAddress: `0x${string}`, amountInWei: bigint, maxSlippageBps: number): Promise<LiveSwapResult> {
  if (!isWalletConfigured()) throw new Error("BOT_WALLET_PRIVATE_KEY is not set — cannot execute a live buy");
  const quote = await getLiveQuote(tokenAddress, true, amountInWei);
  if (!quote) throw new Error(`no live quote available for ${tokenAddress}`);

  const amountOutMinimum = (quote.amountOut * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  const data = buildExecuteCalldata(quote.route, tokenAddress, true, amountInWei, amountOutMinimum);

  const sim = await simulateExecute(UNISWAP_V4_ADDRESSES.universalRouter as `0x${string}`, data, amountInWei);
  if (!sim.ok) throw new Error(`buy simulation reverted (route ${quote.routeLabel}), refusing to sign: ${sim.error}`);

  const txHash = await signAndSendTransaction({ to: UNISWAP_V4_ADDRESSES.universalRouter as `0x${string}`, data, value: amountInWei, purpose: "swap" });
  return { txHash, amountIn: amountInWei, amountOutMinimum, approvalTxHashes: [], routeLabel: quote.routeLabel };
}

/** Sell: pay with the token via Permit2 (approvals topped up only if actually insufficient). */
export async function executeLiveSell(tokenAddress: `0x${string}`, tokenAmount: bigint, maxSlippageBps: number): Promise<LiveSwapResult> {
  if (!isWalletConfigured()) throw new Error("BOT_WALLET_PRIVATE_KEY is not set — cannot execute a live sell");
  // Exits may route through a predatory-fee pool when it's the only
  // venue — see DiscoverPoolOptions.allowHighFeePools. Entries never do.
  const quote = await getLiveQuote(tokenAddress, false, tokenAmount, { allowHighFeePools: true });
  if (!quote) throw new Error(`no live quote available for ${tokenAddress}`);

  const approvalTxHashes = await ensureSellApprovals(tokenAddress, tokenAmount);

  const amountOutMinimum = (quote.amountOut * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  const data = buildExecuteCalldata(quote.route, tokenAddress, false, tokenAmount, amountOutMinimum);

  const sim = await simulateExecute(UNISWAP_V4_ADDRESSES.universalRouter as `0x${string}`, data, 0n);
  if (!sim.ok) throw new Error(`sell simulation reverted (route ${quote.routeLabel}), refusing to sign: ${sim.error}`);

  const txHash = await signAndSendTransaction({ to: UNISWAP_V4_ADDRESSES.universalRouter as `0x${string}`, data, value: 0n, purpose: "swap" });
  return { txHash, amountIn: tokenAmount, amountOutMinimum, approvalTxHashes, routeLabel: quote.routeLabel };
}

export async function getWalletGasBalanceEth(): Promise<number> {
  const client = getPublicClient();
  const balance = await client.getBalance({ address: getWalletAddress() });
  return Number(balance) / 1e18;
}

export function isLiveModeReady(): boolean {
  return tradingConfig.mode === "LIVE" && isWalletConfigured();
}

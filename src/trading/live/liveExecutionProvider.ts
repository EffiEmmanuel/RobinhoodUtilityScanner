import { encodeFunctionData } from "viem";
import { logger } from "../../logger";
import { tradingConfig } from "../config";
import {
  UNISWAP_V4_ADDRESSES,
  NATIVE_ETH_CURRENCY,
  UNIVERSAL_ROUTER_COMMANDS,
  UNIVERSAL_ROUTER_EXECUTE_ABI,
} from "./contracts";
import { discoverPool, type PoolKey } from "./poolDiscovery";
import { encodeV4SwapExactInSingle } from "./swapEncoding";
import { ensureSellApprovals } from "./permit2Approvals";
import { getPublicClient, getWalletAddress, signAndSendTransaction, isWalletConfigured } from "./wallet";

const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const SWAP_DEADLINE_SECONDS = 300; // 5 minutes — matches the plan/entry revalidation cadence

export interface LiveQuote {
  poolKey: PoolKey;
  poolId: `0x${string}`;
  poolLiquidity: bigint;
  amountOut: bigint;
  gasEstimateUnits: bigint;
}

/** Real on-chain quote via V4Quoter — `eth_call`-simulated, never a state change. */
export async function getLiveQuote(tokenAddress: `0x${string}`, isBuy: boolean, amountIn: bigint): Promise<LiveQuote | undefined> {
  const client = getPublicClient();
  const pool = await discoverPool(client, tokenAddress);
  if (!pool) {
    logger.warn({ tokenAddress }, "no live V4 pool found for this token — cannot quote");
    return undefined;
  }
  try {
    const { result } = await client.simulateContract({
      address: UNISWAP_V4_ADDRESSES.quoter as `0x${string}`,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: pool.poolKey, zeroForOne: isBuy, exactAmount: amountIn, hookData: "0x" }],
    });
    return { poolKey: pool.poolKey, poolId: pool.poolId, poolLiquidity: pool.liquidity, amountOut: result[0], gasEstimateUnits: result[1] };
  } catch (err) {
    logger.warn({ tokenAddress, err: String(err) }, "live quote failed");
    return undefined;
  }
}

export interface LiveSwapResult {
  txHash: `0x${string}`;
  amountIn: bigint;
  amountOutMinimum: bigint;
  approvalTxHashes: string[];
}

function buildExecuteCalldata(poolKey: PoolKey, zeroForOne: boolean, amountIn: bigint, amountOutMinimum: bigint, settleCurrency: `0x${string}`, takeCurrency: `0x${string}`) {
  const swapInput = encodeV4SwapExactInSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum, settleCurrency, takeCurrency });
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

/** Buy: pay with native ETH (msg.value), no token approval needed. */
export async function executeLiveBuy(tokenAddress: `0x${string}`, amountInWei: bigint, maxSlippageBps: number): Promise<LiveSwapResult> {
  if (!isWalletConfigured()) throw new Error("BOT_WALLET_PRIVATE_KEY is not set — cannot execute a live buy");
  const quote = await getLiveQuote(tokenAddress, true, amountInWei);
  if (!quote) throw new Error(`no live quote available for ${tokenAddress}`);

  const amountOutMinimum = (quote.amountOut * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  const data = buildExecuteCalldata(quote.poolKey, true, amountInWei, amountOutMinimum, NATIVE_ETH_CURRENCY, tokenAddress);

  const sim = await simulateExecute(UNISWAP_V4_ADDRESSES.universalRouter as `0x${string}`, data, amountInWei);
  if (!sim.ok) throw new Error(`buy simulation reverted, refusing to sign: ${sim.error}`);

  const txHash = await signAndSendTransaction({ to: UNISWAP_V4_ADDRESSES.universalRouter as `0x${string}`, data, value: amountInWei, purpose: "swap" });
  return { txHash, amountIn: amountInWei, amountOutMinimum, approvalTxHashes: [] };
}

/** Sell: pay with the token via Permit2 (approvals topped up only if actually insufficient). */
export async function executeLiveSell(tokenAddress: `0x${string}`, tokenAmount: bigint, maxSlippageBps: number): Promise<LiveSwapResult> {
  if (!isWalletConfigured()) throw new Error("BOT_WALLET_PRIVATE_KEY is not set — cannot execute a live sell");
  const quote = await getLiveQuote(tokenAddress, false, tokenAmount);
  if (!quote) throw new Error(`no live quote available for ${tokenAddress}`);

  const approvalTxHashes = await ensureSellApprovals(tokenAddress, tokenAmount);

  const amountOutMinimum = (quote.amountOut * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  const data = buildExecuteCalldata(quote.poolKey, false, tokenAmount, amountOutMinimum, tokenAddress, NATIVE_ETH_CURRENCY);

  const sim = await simulateExecute(UNISWAP_V4_ADDRESSES.universalRouter as `0x${string}`, data, 0n);
  if (!sim.ok) throw new Error(`sell simulation reverted, refusing to sign: ${sim.error}`);

  const txHash = await signAndSendTransaction({ to: UNISWAP_V4_ADDRESSES.universalRouter as `0x${string}`, data, value: 0n, purpose: "swap" });
  return { txHash, amountIn: tokenAmount, amountOutMinimum, approvalTxHashes };
}

export async function getWalletGasBalanceEth(): Promise<number> {
  const client = getPublicClient();
  const balance = await client.getBalance({ address: getWalletAddress() });
  return Number(balance) / 1e18;
}

export function isLiveModeReady(): boolean {
  return tradingConfig.mode === "LIVE" && isWalletConfigured();
}

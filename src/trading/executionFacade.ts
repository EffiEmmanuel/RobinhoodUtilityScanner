import { parseEther, formatUnits } from "viem";
import { logger } from "../logger";
import type { MarketPair } from "../dex/types";
import { tradingConfig } from "./config";
import { getPaperQuote, getPaperSellQuote, isSellQuoteAvailable as isPaperSellQuoteAvailable, type PaperQuote } from "./execution";
import { isLiveModeReady, executeLiveBuy, executeLiveSell, getLiveQuote } from "./live/liveExecutionProvider";
import { getPublicClient, getWalletAddress } from "./live/wallet";
import { getTokenDecimals, getTokenBalance } from "./live/tokenUtils";

/**
 * The one seam entryMonitor.ts and positionManager.ts call through — neither
 * of them know or care whether a fill is simulated or real. Swapping modes
 * (SHADOW <-> LIVE) never requires touching the trading-loop logic, only this
 * file and config.
 */
export interface FillResult extends PaperQuote {
  provider: "paper" | "live";
  txHash?: `0x${string}`;
  approvalTxHashes?: string[];
}

function deriveEthPriceUsd(pair: Pick<MarketPair, "priceUsd" | "priceNative">): number | undefined {
  if (!pair.priceUsd || !pair.priceNative || pair.priceNative === 0) return undefined;
  return pair.priceUsd / pair.priceNative;
}

/**
 * Quote-only — never executes anything, even in LIVE mode (a real on-chain
 * `eth_call` simulation via the Quoter, not a transaction). This is what
 * entry/exit revalidation checks slippage/price-impact against *before*
 * deciding whether to actually call executeBuyFill/executeSellFill (§17: a
 * fresh quote must exist and be acceptable before a real buy is ever signed).
 */
export async function getBuyEstimate(tokenAddress: string, positionSizeUsd: number, pair: MarketPair): Promise<Pick<PaperQuote, "estimatedSlippageBps" | "estimatedPriceImpactPercent" | "tokenAmount">> {
  if (!isLiveModeReady()) return getPaperQuote(positionSizeUsd, pair);

  const ethPriceUsd = deriveEthPriceUsd(pair);
  if (!ethPriceUsd) return { estimatedSlippageBps: Number.MAX_SAFE_INTEGER, estimatedPriceImpactPercent: 100, tokenAmount: 0 };
  const amountInWei = parseEther((positionSizeUsd / ethPriceUsd).toFixed(18));
  const quote = await getLiveQuote(tokenAddress as `0x${string}`, true, amountInWei);
  if (!quote) return { estimatedSlippageBps: Number.MAX_SAFE_INTEGER, estimatedPriceImpactPercent: 100, tokenAmount: 0 };

  const decimals = await getTokenDecimals(getPublicClient(), tokenAddress as `0x${string}`);
  const tokenOut = Number(formatUnits(quote.amountOut, decimals));
  const effectivePriceUsd = tokenOut > 0 ? positionSizeUsd / tokenOut : Infinity;
  const spotPriceUsd = pair.priceUsd ?? effectivePriceUsd;
  const priceImpactPercent = spotPriceUsd > 0 ? Math.max(0, ((effectivePriceUsd - spotPriceUsd) / spotPriceUsd) * 100) : 0;
  return { estimatedSlippageBps: Math.round(priceImpactPercent * 100), estimatedPriceImpactPercent: priceImpactPercent, tokenAmount: tokenOut };
}

export async function executeBuyFill(tokenAddress: string, positionSizeUsd: number, pair: MarketPair): Promise<FillResult> {
  if (!isLiveModeReady()) {
    return { ...getPaperQuote(positionSizeUsd, pair), provider: "paper" };
  }

  const ethPriceUsd = deriveEthPriceUsd(pair);
  if (!ethPriceUsd) throw new Error("cannot determine ETH/USD price for live buy sizing (missing priceNative)");
  const ethAmount = positionSizeUsd / ethPriceUsd;
  const amountInWei = parseEther(ethAmount.toFixed(18));

  const client = getPublicClient();
  const wallet = getWalletAddress();
  const token = tokenAddress as `0x${string}`;
  const balanceBefore = await getTokenBalance(client, token, wallet);

  const result = await executeLiveBuy(token, amountInWei, tradingConfig.defaultMaxBuySlippageBps);
  const receipt = await client.waitForTransactionReceipt({ hash: result.txHash });
  if (receipt.status !== "success") throw new Error(`live buy transaction reverted on-chain: ${result.txHash}`);

  const balanceAfter = await getTokenBalance(client, token, wallet);
  const decimals = await getTokenDecimals(client, token);
  const tokenAmount = Number(formatUnits(balanceAfter - balanceBefore, decimals));
  const gasCostEth = Number(formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18));
  const gasCostUsd = gasCostEth * ethPriceUsd;

  logger.info({ tokenAddress, txHash: result.txHash, tokenAmount, gasCostUsd }, "live buy confirmed");

  return {
    priceUsd: tokenAmount > 0 ? positionSizeUsd / tokenAmount : 0,
    tokenAmount,
    estimatedSlippageBps: 0, // realized, not estimated — the real fill already happened
    estimatedPriceImpactPercent: 0,
    gasCostUsd,
    provider: "live",
    txHash: result.txHash,
    approvalTxHashes: result.approvalTxHashes,
  };
}

/** Sell-side counterpart to getBuyEstimate — quote-only, never executes. */
export async function getSellEstimate(tokenAddress: string, tokenAmount: number, pair: MarketPair): Promise<Pick<PaperQuote, "estimatedSlippageBps" | "estimatedPriceImpactPercent">> {
  if (!isLiveModeReady()) return getPaperSellQuote(tokenAmount, pair);

  const client = getPublicClient();
  const token = tokenAddress as `0x${string}`;
  const decimals = await getTokenDecimals(client, token);
  const tokenAmountRaw = BigInt(Math.floor(tokenAmount * 10 ** decimals));
  const quote = await getLiveQuote(token, false, tokenAmountRaw);
  if (!quote) return { estimatedSlippageBps: Number.MAX_SAFE_INTEGER, estimatedPriceImpactPercent: 100 };

  const ethPriceUsd = deriveEthPriceUsd(pair);
  if (!ethPriceUsd) return { estimatedSlippageBps: Number.MAX_SAFE_INTEGER, estimatedPriceImpactPercent: 100 };
  const proceedsUsd = Number(formatUnits(quote.amountOut, 18)) * ethPriceUsd;
  const effectivePriceUsd = tokenAmount > 0 ? proceedsUsd / tokenAmount : 0;
  const spotPriceUsd = pair.priceUsd ?? effectivePriceUsd;
  const priceImpactPercent = spotPriceUsd > 0 ? Math.max(0, ((spotPriceUsd - effectivePriceUsd) / spotPriceUsd) * 100) : 0;
  return { estimatedSlippageBps: Math.round(priceImpactPercent * 100), estimatedPriceImpactPercent: priceImpactPercent };
}

export async function executeSellFill(tokenAddress: string, tokenAmount: number, pair: MarketPair): Promise<FillResult> {
  if (!isLiveModeReady()) {
    return { ...getPaperSellQuote(tokenAmount, pair), provider: "paper" };
  }

  const ethPriceUsd = deriveEthPriceUsd(pair);
  if (!ethPriceUsd) throw new Error("cannot determine ETH/USD price for live sell sizing (missing priceNative)");

  const client = getPublicClient();
  const wallet = getWalletAddress();
  const token = tokenAddress as `0x${string}`;
  const decimals = await getTokenDecimals(client, token);
  const tokenAmountRaw = BigInt(Math.floor(tokenAmount * 10 ** decimals));

  const ethBalanceBefore = await client.getBalance({ address: wallet });
  const result = await executeLiveSell(token, tokenAmountRaw, tradingConfig.defaultMaxSellSlippageBps);
  const receipt = await client.waitForTransactionReceipt({ hash: result.txHash });
  if (receipt.status !== "success") throw new Error(`live sell transaction reverted on-chain: ${result.txHash}`);

  const ethBalanceAfter = await client.getBalance({ address: wallet });
  const gasCostWei = receipt.gasUsed * receipt.effectiveGasPrice;
  // ETH received = balance delta plus what was spent on gas (gas already left the balance too)
  const ethReceivedWei = ethBalanceAfter - ethBalanceBefore + gasCostWei;
  const ethReceived = Number(formatUnits(ethReceivedWei, 18));
  const gasCostUsd = Number(formatUnits(gasCostWei, 18)) * ethPriceUsd;
  const proceedsUsd = ethReceived * ethPriceUsd;

  logger.info({ tokenAddress, txHash: result.txHash, proceedsUsd, gasCostUsd }, "live sell confirmed");

  return {
    priceUsd: tokenAmount > 0 ? proceedsUsd / tokenAmount : 0,
    tokenAmount,
    estimatedSlippageBps: 0,
    estimatedPriceImpactPercent: 0,
    gasCostUsd,
    provider: "live",
    txHash: result.txHash,
    approvalTxHashes: result.approvalTxHashes,
  };
}

/**
 * A honeypot check as much as a liquidity check: many honeypot contracts
 * happily quote a sell for a trivial dust amount while reverting on anything
 * a real position would actually hold (the classic "works in the tester,
 * fails for real buyers" pattern) — so simulate selling something close to
 * the real position size whenever the caller has one, not 1 wei. Callers
 * without a size yet (nothing built on this token so far) still get the
 * dust-amount fallback, which is still strictly better than no check.
 */
export async function isSellable(tokenAddress: string, pair: MarketPair | undefined, realisticTokenAmount?: number): Promise<boolean> {
  if (!isLiveModeReady()) return isPaperSellQuoteAvailable(pair);
  if (!pair) return false;
  let amountToSimulate = 1n;
  if (realisticTokenAmount && realisticTokenAmount > 0) {
    try {
      const decimals = await getTokenDecimals(getPublicClient(), tokenAddress as `0x${string}`);
      amountToSimulate = BigInt(Math.floor(realisticTokenAmount * 10 ** decimals));
    } catch {
      amountToSimulate = 1n; // decimals lookup failed — fall back to the dust check rather than skip it
    }
  }
  const quote = await getLiveQuote(tokenAddress as `0x${string}`, false, amountToSimulate);
  return quote !== undefined;
}

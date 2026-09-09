import type { MarketPair } from "../dex/types";
import { tradingConfig } from "./config";

/**
 * §7/§88 — paper execution only. No wallet, no signer, no router in this
 * codebase. Fills are simulated using a standard constant-product AMM price-
 * impact approximation against the pool's real, current DexScreener liquidity
 * — deliberately not a real on-chain quote (see README for why: avoids taking
 * a dependency on a specific router's SDK before live execution is actually
 * being built). Treat these numbers as "roughly the right order of magnitude
 * for a thin pool," not a precise prediction of a real fill.
 */

export interface PaperQuote {
  priceUsd: number;
  estimatedSlippageBps: number;
  estimatedPriceImpactPercent: number;
  tokenAmount: number;
  gasCostUsd: number;
}

const SLIPPAGE_BUFFER_BPS = 10; // latency/multi-block execution risk buffer

/** Constant-product price impact: buying `usdValue` against a pool whose
 * reserve on the quote side is approximated as half of total pool liquidity. */
function priceImpactPercent(usdValue: number, liquidityUsd: number): number {
  const reserve = Math.max(liquidityUsd / 2, 1);
  return (usdValue / (reserve + usdValue)) * 100;
}

export function getPaperQuote(usdValue: number, pair: Pick<MarketPair, "priceUsd" | "liquidityUsd">): PaperQuote {
  const liquidityUsd = pair.liquidityUsd ?? 0;
  const priceUsd = pair.priceUsd ?? 0;
  const impact = priceImpactPercent(usdValue, liquidityUsd);
  const effectivePriceUsd = priceUsd * (1 + impact / 100);
  const tokenAmount = effectivePriceUsd > 0 ? usdValue / effectivePriceUsd : 0;

  return {
    priceUsd: effectivePriceUsd,
    estimatedSlippageBps: Math.round(impact * 100) + SLIPPAGE_BUFFER_BPS,
    estimatedPriceImpactPercent: impact,
    tokenAmount,
    gasCostUsd: tradingConfig.paperAssumedGasCostUsd,
  };
}

/** Sell side: proceeds shrink with impact instead of the buy price growing. */
export function getPaperSellQuote(
  tokenAmount: number,
  pair: Pick<MarketPair, "priceUsd" | "liquidityUsd">
): PaperQuote {
  const liquidityUsd = pair.liquidityUsd ?? 0;
  const priceUsd = pair.priceUsd ?? 0;
  const notionalUsd = tokenAmount * priceUsd;
  const impact = priceImpactPercent(notionalUsd, liquidityUsd);
  const effectivePriceUsd = priceUsd * (1 - impact / 100);

  return {
    priceUsd: effectivePriceUsd,
    estimatedSlippageBps: Math.round(impact * 100) + SLIPPAGE_BUFFER_BPS,
    estimatedPriceImpactPercent: impact,
    tokenAmount,
    gasCostUsd: tradingConfig.paperAssumedGasCostUsd,
  };
}

/** A pool with ~0 liquidity or that has vanished from DexScreener entirely is
 * treated as having no sell path — the closest honest proxy we have for
 * "is this sellable" without a real router simulate-call. */
export function isSellQuoteAvailable(pair: MarketPair | undefined): boolean {
  if (!pair) return false;
  return (pair.liquidityUsd ?? 0) > 50; // a near-zero pool is not meaningfully sellable
}

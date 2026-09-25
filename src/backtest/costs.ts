/**
 * Fill model. A fill is the reference (candle) price moved against us by a
 * calibrated per-chain slippage (pool fee, spread, latency: everything our
 * real fills showed beyond price impact) plus constant-product price impact
 * for our size against the pool's liquidity at that moment.
 */

export interface ChainCostModel {
  entrySlippagePct: number; // buy fill premium over the reference price, before modeled impact
  exitSlippagePct: number; // sell fill discount under the reference price, before modeled impact
  gasBuyUsd: number; // per swap
  gasSellUsd: number; // per swap (every partial sell pays it again)
}

export type CostModel = Record<string, ChainCostModel>;

// Placeholders until `calibrate` measures them from our own fills.
export const DEFAULT_COSTS: CostModel = {
  robinhood: { entrySlippagePct: 3, exitSlippagePct: 3, gasBuyUsd: 0.05, gasSellUsd: 0.035 },
  solana: { entrySlippagePct: 2, exitSlippagePct: 2, gasBuyUsd: 0.01, gasSellUsd: 0.014 },
};

export function chainCosts(model: CostModel, chain: string): ChainCostModel {
  return model[chain] ?? model.robinhood ?? DEFAULT_COSTS.robinhood;
}

/**
 * Exact constant-product math on the quote reserve R = liquidityUsd / 2
 * (pessimistic for v3/v4 pools, whose in-range depth is usually deeper).
 * Buying $x pays an average of (1 + x/R) times the pre-trade price. Selling
 * tokens worth $x at the pre-trade price returns x / (1 + x/R).
 */
// Unknown liquidity (pump.fun curves report none) models no impact; a pool
// known to hold nothing is unfillable.
export function buyImpactPct(sizeUsd: number, liquidityUsd: number | undefined): number {
  if (!(sizeUsd > 0) || liquidityUsd === undefined) return 0;
  if (!(liquidityUsd > 0)) return 100;
  return (sizeUsd / (liquidityUsd / 2)) * 100;
}

export function sellImpactPct(valueUsd: number, liquidityUsd: number | undefined): number {
  if (!(valueUsd > 0) || liquidityUsd === undefined) return 0;
  if (!(liquidityUsd > 0)) return 100;
  const r = valueUsd / (liquidityUsd / 2);
  return (1 - 1 / (1 + r)) * 100;
}

export function buyFillPrice(mid: number, sizeUsd: number, liquidityUsd: number | undefined, costs: ChainCostModel): number {
  return mid * (1 + (costs.entrySlippagePct + buyImpactPct(sizeUsd, liquidityUsd)) / 100);
}

export function sellFillPrice(mid: number, valueUsd: number, liquidityUsd: number | undefined, costs: ChainCostModel): number {
  const pct = costs.exitSlippagePct + sellImpactPct(valueUsd, liquidityUsd);
  return mid * Math.max(0, 1 - pct / 100);
}

/**
 * A full-range pool's USD liquidity scales with the square root of price
 * (the quote reserve is sqrt(k * P)). Without per-candle liquidity data this
 * is how the replay tracks depth, and it's what live's "liquidity dropped
 * more than 50% since entry" exit sees on a price-only collapse: it trips
 * once price falls ~75%.
 */
export function liquidityAt(liquidityAtEntry: number | undefined, entryMid: number, mid: number): number | undefined {
  if (!(liquidityAtEntry && liquidityAtEntry > 0) || !(entryMid > 0) || !(mid >= 0)) return liquidityAtEntry;
  return liquidityAtEntry * Math.sqrt(mid / entryMid);
}

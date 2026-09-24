// Realized P&L is booked net of gas (user directive 2026-09-24: the dashboard
// is the source of truth and must match the wallet). At $1-5 position sizes a
// buy, a sell and a Permit2 approval together are often several percent of
// the trade, so a gross figure overstated every trade. Gas lives on the
// TradeExecution rows (gasCostUsd, approvals included — see
// executionFacade.ts and approvalGas.ts), so these only ever read execution
// totals.

/** One sell's realized P&L: proceeds, minus the sold tokens' share of every
 * buy's cost and gas, minus this sell's own gas. Summed over a full exit this
 * equals tradeRealizedPnl below. */
export function sellRealizedPnlUsd(input: {
  proceedsUsd: number;
  soldTokens: number;
  totalBoughtTokens: number;
  totalBuyUsd: number;
  totalBuyGasUsd: number;
  sellGasUsd: number;
}): number {
  // No recorded buy to attribute cost to — same fallback as before gas was
  // included: treat the proceeds as the cost basis, so only the gas is lost.
  if (input.totalBoughtTokens <= 0) return -input.sellGasUsd;
  const share = input.soldTokens / input.totalBoughtTokens;
  return input.proceedsUsd - share * (input.totalBuyUsd + input.totalBuyGasUsd) - input.sellGasUsd;
}

/** Whole-trade realized P&L at close. The multiple is net of gas too, so a
 * trade that only broke even before gas reads as a loss. */
export function tradeRealizedPnl(input: { totalBuyUsd: number; totalSellUsd: number; totalGasUsd: number }): {
  realizedPnlUsd: number;
  realizedMultiple: number | undefined;
} {
  const realizedPnlUsd = input.totalSellUsd - input.totalBuyUsd - input.totalGasUsd;
  return {
    realizedPnlUsd,
    realizedMultiple: input.totalBuyUsd > 0 ? (input.totalBuyUsd + realizedPnlUsd) / input.totalBuyUsd : undefined,
  };
}

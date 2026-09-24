import { describe, it, expect } from "vitest";
import { sellRealizedPnlUsd, tradeRealizedPnl } from "./pnl";

describe("sellRealizedPnlUsd", () => {
  it("charges the sold share of buy cost and buy gas, plus the sell's own gas", () => {
    const pnl = sellRealizedPnlUsd({ proceedsUsd: 3, soldTokens: 50, totalBoughtTokens: 100, totalBuyUsd: 4, totalBuyGasUsd: 0.2, sellGasUsd: 0.05 });
    expect(pnl).toBeCloseTo(3 - 0.5 * 4.2 - 0.05, 12);
  });

  it("sums over a full exit to exactly the whole-trade figure", () => {
    const buy = { totalBoughtTokens: 1000, totalBuyUsd: 3.33, totalBuyGasUsd: 0.04 };
    const sells = [
      { proceedsUsd: 5.54, soldTokens: 500, sellGasUsd: 0.01 },
      { proceedsUsd: 4.27, soldTokens: 500, sellGasUsd: 0.02 },
    ];
    const perSell = sells.reduce((s, x) => s + sellRealizedPnlUsd({ ...buy, ...x }), 0);
    const whole = tradeRealizedPnl({ totalBuyUsd: 3.33, totalSellUsd: 5.54 + 4.27, totalGasUsd: 0.04 + 0.01 + 0.02 });
    expect(perSell).toBeCloseTo(whole.realizedPnlUsd, 12);
  });

  it("loses only the gas when there is no recorded buy to attribute cost to", () => {
    expect(sellRealizedPnlUsd({ proceedsUsd: 2, soldTokens: 10, totalBoughtTokens: 0, totalBuyUsd: 0, totalBuyGasUsd: 0, sellGasUsd: 0.03 })).toBe(-0.03);
  });
});

describe("tradeRealizedPnl", () => {
  it("nets gas out of both the P&L and the multiple", () => {
    const { realizedPnlUsd, realizedMultiple } = tradeRealizedPnl({ totalBuyUsd: 1, totalSellUsd: 1.01, totalGasUsd: 0.03 });
    expect(realizedPnlUsd).toBeCloseTo(-0.02, 12);
    expect(realizedMultiple).toBeCloseTo(0.98, 12);
  });

  it("has no multiple without a buy cost", () => {
    expect(tradeRealizedPnl({ totalBuyUsd: 0, totalSellUsd: 1, totalGasUsd: 0 }).realizedMultiple).toBeUndefined();
  });
});

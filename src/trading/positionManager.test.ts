import { describe, expect, it } from "vitest";
import type { Trade } from "../generated/prisma";
import { evaluateExits, stopBaseline } from "./positionManager";
import type { ExitRules } from "./strategy";

const exitRules: ExitRules = {
  profitSteps: [{ multiple: 2, sellPercentOfRemaining: 50 }],
  trailRemaining: true,
  trailingActivationMultiple: 1.6,
  trailingPercent: 20,
  maxLossPercent: 25,
  catastrophicLossPercent: 40,
  maxHoldMinutes: 30,
};

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: "trade-1",
    tokenId: "token-1",
    candidateId: null,
    tradePlanId: null,
    strategyVersionId: "strategy-1",
    mode: "LIVE",
    status: "OPEN",
    positionSizeUsd: 10,
    entryTokenAmount: 100,
    plannedEntryMcap: null,
    actualEntryMcap: 100_000,
    entryPriceUsd: 0.1,
    entryLiquidityUsd: 25_000,
    openedAt: new Date(Date.now() - 31 * 60_000),
    closedAt: null,
    initialQualityScore: null,
    initialRiskScore: null,
    initialConfidence: null,
    tradeLane: "MOMENTUM_TACTICAL",
    realizedPnlUsd: null,
    realizedMultiple: null,
    mfePercent: 0,
    maePercent: 0,
    exitReason: null,
    reentryCount: 0,
    pendingReentryTargetMcap: null,
    pendingReentryUsd: null,
    pendingReentryExpiresAt: null,
    pendingReentryReason: null,
    lastStrategyReviewAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Trade;
}

describe("evaluateExits", () => {
  // User directive 2026-09-22: no more fixed profit-taking multiples —
  // evaluateExits must never return a profit-taking decision on its own,
  // even when currentMultiple clears a level an old exitRules.profitSteps
  // config still (harmlessly) carries. Deciding if/when/how much profit to
  // take is now exclusively positionStrategy.ts's AI review's call.
  it("does not take profit at a fixed multiple, even when currentMultiple clears exitRules.profitSteps", () => {
    const result = evaluateExits({
      trade: trade(), // mfePercent: 0 — trailing exit isn't armed (needs 1.6x peak)
      plan: null,
      exitRules, // profitSteps: [{ multiple: 2, sellPercentOfRemaining: 50 }]
      currentMcap: 250_000,
      currentMultiple: 2.5, // well past the old 2x step
      unrealizedPnlPercent: 150,
      liquidityUsd: 25_000,
      buySellRatio5m: 0.55,
      totalTxns5m: 8,
      sellQuoteAvailable: true,
      remainingTokens: 100,
      totalBoughtTokens: 100,
    });

    expect(result).toBeNull();
  });

  // User directive 2026-09-18: utility-token theses are long holds — max hold
  // time now only ever force-closes a position that's underwater
  // (currentMultiple < 1) when the clock runs out, freeing up capital tied to
  // a thesis that hasn't played out. A winning position must never be
  // force-closed just because time passed; see the next test.
  it("exits once max hold time is reached while underwater", () => {
    const result = evaluateExits({
      trade: trade(),
      plan: null,
      exitRules,
      currentMcap: 90_000,
      currentMultiple: 0.9,
      unrealizedPnlPercent: -10,
      liquidityUsd: 25_000,
      buySellRatio5m: 0.55,
      totalTxns5m: 8,
      sellQuoteAvailable: true,
      remainingTokens: 100,
      totalBoughtTokens: 100,
    });

    expect(result).toMatchObject({ type: "TIME_EXIT", sellPercentOfRemaining: 100, isEmergency: false });
  });

  it("does not time-exit a breakeven-or-better position, no matter how long it's held", () => {
    const result = evaluateExits({
      trade: trade(),
      plan: null,
      exitRules,
      currentMcap: 100_000,
      currentMultiple: 1,
      unrealizedPnlPercent: 0,
      liquidityUsd: 25_000,
      buySellRatio5m: 0.55,
      totalTxns5m: 8,
      sellQuoteAvailable: true,
      remainingTokens: 100,
      totalBoughtTokens: 100,
    });

    expect(result).toBeNull();
  });

  it("does not time-exit before max hold time", () => {
    const result = evaluateExits({
      trade: trade({ openedAt: new Date(Date.now() - 10 * 60_000) }),
      plan: null,
      exitRules,
      currentMcap: 100_000,
      currentMultiple: 1,
      unrealizedPnlPercent: 0,
      liquidityUsd: 25_000,
      buySellRatio5m: 0.55,
      totalTxns5m: 8,
      sellQuoteAvailable: true,
      remainingTokens: 100,
      totalBoughtTokens: 100,
    });

    expect(result).toBeNull();
  });

  it("carries peakMultiple/retracePercent on a TRAILING_EXIT decision, for the chart-vision gate in monitorOneTrade to read", () => {
    const result = evaluateExits({
      trade: trade({ mfePercent: 100, openedAt: new Date(Date.now() - 5 * 60_000) }), // peak 2x
      plan: null,
      exitRules,
      currentMcap: 150_000,
      currentMultiple: 1.5, // retraced 25% from the 2x peak, >= the 20% trail
      unrealizedPnlPercent: 50,
      liquidityUsd: 25_000,
      buySellRatio5m: 0.55,
      totalTxns5m: 8,
      sellQuoteAvailable: true,
      remainingTokens: 100,
      totalBoughtTokens: 100,
    });

    expect(result).toMatchObject({ type: "TRAILING_EXIT", peakMultiple: 2 });
    expect(result?.retracePercent).toBeCloseTo(25, 5);
  });

  it("returns RISK_EXIT before ever reaching the trailing-exit branch, structurally unreachable by the chart-vision gate", () => {
    // Same peak/retrace shape as the TRAILING_EXIT case above, but also
    // catastrophically underwater — validatePosition's CRITICAL check must
    // win, and the decision it returns must carry no peakMultiple/
    // retracePercent (those are only ever set in the TRAILING_EXIT branch),
    // which is what lets monitorOneTrade gate strictly on decision.type.
    const result = evaluateExits({
      trade: trade({ mfePercent: 100, openedAt: new Date(Date.now() - 5 * 60_000) }),
      plan: null,
      exitRules,
      currentMcap: 50_000,
      currentMultiple: 0.5,
      unrealizedPnlPercent: -50, // beyond catastrophicLossPercent (40)
      liquidityUsd: 25_000,
      buySellRatio5m: 0.55,
      totalTxns5m: 8,
      sellQuoteAvailable: true,
      remainingTokens: 100,
      totalBoughtTokens: 100,
    });

    expect(result).toMatchObject({ type: "RISK_EXIT", isEmergency: true });
    expect(result?.peakMultiple).toBeUndefined();
    expect(result?.retracePercent).toBeUndefined();
  });

  describe("manual buy-and-hold", () => {
    // WageFlow, 2026-09-24: bought by hand at a $62K mcap, sold 2 minutes
    // later on the -35.6% catastrophic stop, then ran to $150K.
    const underwater = {
      plan: { invalidationMcap: 80_000 },
      exitRules,
      currentMcap: 40_000,
      currentMultiple: 0.64,
      unrealizedPnlPercent: -36,
      liquidityUsd: 25_000,
      buySellRatio5m: 0.1,
      totalTxns5m: 40,
      sellQuoteAvailable: true,
      remainingTokens: 100,
      totalBoughtTokens: 100,
      manualHold: true,
    };

    it("holds through a launch drawdown that would trip every price-based exit", () => {
      // -36% is past maxLossPercent (25), below the plan's invalidation
      // floor, under heavy sell pressure, and past maxHoldMinutes while
      // underwater; -60% is past catastrophicLossPercent (40) as well.
      expect(evaluateExits({ ...underwater, trade: trade() })).toBeNull();
      expect(evaluateExits({ ...underwater, trade: trade(), unrealizedPnlPercent: -60, currentMultiple: 0.4 })).toBeNull();
    });

    it("still exits when the token itself breaks", () => {
      expect(evaluateExits({ ...underwater, trade: trade(), sellQuoteAvailable: false })).toMatchObject({ type: "RISK_EXIT", isEmergency: true });
      expect(evaluateExits({ ...underwater, trade: trade(), liquidityUsd: 10_000 })).toMatchObject({ type: "RISK_EXIT", isEmergency: true });
    });

    it("keeps the trailing stop once the position has been well in profit", () => {
      const result = evaluateExits({
        ...underwater,
        trade: trade({ mfePercent: 200 }), // peaked at 3x
        currentMcap: 200_000,
        currentMultiple: 2,
        unrealizedPnlPercent: 100,
      });
      expect(result).toMatchObject({ type: "TRAILING_EXIT" });
    });

    it("leaves the same drawdown to the normal exits for a trade that isn't a manual hold", () => {
      expect(evaluateExits({ ...underwater, trade: trade(), manualHold: false })).toMatchObject({ isEmergency: true });
    });
  });
});

describe("stopBaseline", () => {
  it("measures stops from the first mark, which already carries the round-trip cost", () => {
    expect(stopBaseline(1, 0.945)).toBeCloseTo(0.945);
  });

  it("never measures from above the entry price", () => {
    expect(stopBaseline(1, 1.3)).toBe(1);
  });

  it("never lets a crash in the first seconds pass for trading cost", () => {
    expect(stopBaseline(1, 0.6)).toBeCloseTo(0.88);
  });

  it("falls back to the entry price without a usable first mark", () => {
    expect(stopBaseline(1, undefined)).toBe(1);
    expect(stopBaseline(1, 0)).toBe(1);
  });
});

describe("evaluateExits loss stops", () => {
  const base = {
    trade: trade({ openedAt: new Date(Date.now() - 5 * 60_000) }), // inside maxHoldMinutes
    plan: null,
    exitRules, // maxLossPercent 25, catastrophicLossPercent 40
    currentMcap: 70_000,
    liquidityUsd: 25_000,
    buySellRatio5m: 0.55,
    totalTxns5m: 8,
    sellQuoteAvailable: true,
    remainingTokens: 100,
    totalBoughtTokens: 100,
  };

  it("judges the loss stops by the move since the first mark, not the fee-inclusive entry", () => {
    // -28% against the fill, but the first mark was already -8%: a ~22% market move.
    expect(evaluateExits({ ...base, currentMultiple: 0.72, unrealizedPnlPercent: -28, stopPnlPercent: -21.7 })).toBeNull();
    expect(evaluateExits({ ...base, currentMultiple: 0.72, unrealizedPnlPercent: -28 })).toMatchObject({ type: "RISK_EXIT" });
  });

  it("still fires once the market move itself passes the stop", () => {
    expect(evaluateExits({ ...base, currentMultiple: 0.5, unrealizedPnlPercent: -50, stopPnlPercent: -45.6 })).toMatchObject({
      type: "RISK_EXIT",
      isEmergency: true,
    });
  });
});

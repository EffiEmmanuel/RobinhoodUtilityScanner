import { describe, expect, it } from "vitest";
import type { Trade } from "../generated/prisma";
import { evaluateExits } from "./positionManager";
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
      profitStepsTaken: 0,
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
      profitStepsTaken: 0,
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
      profitStepsTaken: 0,
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
      profitStepsTaken: 0,
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
      profitStepsTaken: 0,
      remainingTokens: 100,
      totalBoughtTokens: 100,
    });

    expect(result).toMatchObject({ type: "RISK_EXIT", isEmergency: true });
    expect(result?.peakMultiple).toBeUndefined();
    expect(result?.retracePercent).toBeUndefined();
  });
});

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
  it("exits once max hold time is reached", () => {
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

    expect(result).toMatchObject({ type: "TIME_EXIT", sellPercentOfRemaining: 100, isEmergency: false });
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
});

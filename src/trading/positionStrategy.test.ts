import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tradeUpdate = vi.fn().mockResolvedValue(undefined);
const boughtUsd = { value: 1 as number | null };
vi.mock("../db", () => ({
  db: {
    trade: { update: (...args: unknown[]) => tradeUpdate(...args) },
    tradeExecution: { aggregate: vi.fn(async () => ({ _sum: { usdValue: boughtUsd.value } })) },
  },
}));
const getBuyEstimate = vi.fn().mockRejectedValue(new Error("stop here"));
vi.mock("./executionFacade", () => ({
  getBuyEstimate: (...args: unknown[]) => getBuyEstimate(...args),
  isSellable: vi.fn().mockResolvedValue(true),
  executeBuyFill: vi.fn(),
  gasLedgerNote: vi.fn(() => "real gas"),
}));
// $20 in the Solana wallet (the 40% bracket, an $8 limit), $5 on Robinhood.
const portfolioState = {
  totalEquityUsd: 25,
  availableToDeployUsd: 100,
  chains: { solana: { equityUsd: 20, cashUsd: 20 }, robinhood: { equityUsd: 5, cashUsd: 5 } },
};
vi.mock("./portfolio", () => ({
  checkCircuitBreakers: vi.fn().mockResolvedValue({ chains: {} }),
  getPortfolioState: vi.fn(async () => portfolioState),
  recordLedgerEntry: vi.fn(),
}));
vi.mock("./chartVisionGate", () => ({ renderPositionChart: vi.fn() }));

import { checkAndExecutePendingReentry, formatExitRulesState, reentryWithinLimitUsd } from "./positionStrategy";
import type { ExitRules } from "./strategy";
import { tradingConfig } from "./config";
import type { Trade, Token } from "../generated/prisma";
import type { MarketPair } from "../dex/types";

const original = {
  maxGasCostPercentOfPosition: tradingConfig.maxGasCostPercentOfPosition,
  solanaSwapFeeUsd: tradingConfig.solanaSwapFeeUsd,
};

function trade(pendingReentryUsd: number): Trade {
  return {
    id: "t1",
    reentryCount: 0,
    pendingReentryTargetMcap: 100_000,
    pendingReentryUsd,
    pendingReentryExpiresAt: new Date(Date.now() + 60_000),
    pendingReentryReason: "dip",
  } as unknown as Trade;
}

const token = { address: "So11111111111111111111111111111111111111112", chain: "solana" } as unknown as Token;
const pair = { marketCapUsd: 90_000, liquidityUsd: 50_000 } as unknown as MarketPair;

describe("checkAndExecutePendingReentry gas floor", () => {
  beforeEach(() => {
    tradingConfig.maxGasCostPercentOfPosition = 1.5;
    tradingConfig.solanaSwapFeeUsd = 0.01; // floor ~$0.67
    tradeUpdate.mockClear();
    getBuyEstimate.mockClear();
    boughtUsd.value = 1;
  });
  afterEach(() => {
    Object.assign(tradingConfig, original);
  });

  it("drops a re-entry too small to be worth its gas, without quoting it", async () => {
    await checkAndExecutePendingReentry(trade(0.26), token, pair, "BASE", false);
    expect(getBuyEstimate).not.toHaveBeenCalled();
    expect(tradeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pendingReentryUsd: null, pendingReentryTargetMcap: null }) })
    );
  });

  it("goes on to quote a re-entry above the floor", async () => {
    await expect(checkAndExecutePendingReentry(trade(1), token, pair, "BASE", false)).rejects.toThrow("stop here");
    expect(getBuyEstimate).toHaveBeenCalledTimes(1);
    expect(tradeUpdate).not.toHaveBeenCalled();
  });

  it("clamps a re-entry to the headroom left under the position's bracket limit", async () => {
    boughtUsd.value = 6; // $6 already in against an $8 limit
    await expect(checkAndExecutePendingReentry(trade(3), token, pair, "BASE", false)).rejects.toThrow("stop here");
    expect(getBuyEstimate).toHaveBeenCalledWith(token.address, 2, pair, "solana");
  });

  it("drops a re-entry when the headroom left is below the gas floor", async () => {
    boughtUsd.value = 7.5; // $0.50 of headroom, under the ~$0.67 floor
    await checkAndExecutePendingReentry(trade(3), token, pair, "BASE", false);
    expect(getBuyEstimate).not.toHaveBeenCalled();
    expect(tradeUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pendingReentryUsd: null }) }));
  });

  it("holds a manual buy-and-hold to its own limit on total equity", async () => {
    // The small-account percent of $25 total; $6 already in.
    boughtUsd.value = 6;
    await expect(checkAndExecutePendingReentry(trade(5), token, pair, "GOOD_PROJECT", true)).rejects.toThrow("stop here");
    const expected = Math.min(5, 25 * (tradingConfig.smallAccountMaxSinglePositionPercent / 100) - 6);
    expect(getBuyEstimate).toHaveBeenCalledWith(token.address, expected, pair, "solana");
  });
});

describe("reentryWithinLimitUsd", () => {
  it("passes a re-entry that fits and clamps one that doesn't", () => {
    expect(reentryWithinLimitUsd({ pendingUsd: 1, costBasisUsd: 5, limitUsd: 8 })).toEqual({ headroomUsd: 3, reentryUsd: 1 });
    expect(reentryWithinLimitUsd({ pendingUsd: 5, costBasisUsd: 5, limitUsd: 8 })).toEqual({ headroomUsd: 3, reentryUsd: 3 });
  });

  it("leaves nothing once the position is at or over its limit (the bracket stepped down)", () => {
    expect(reentryWithinLimitUsd({ pendingUsd: 2, costBasisUsd: 9, limitUsd: 8 })).toEqual({ headroomUsd: 0, reentryUsd: 0 });
  });
});

describe("formatExitRulesState", () => {
  const v18: ExitRules = {
    profitSteps: [],
    trailRemaining: true,
    trailingActivationMultiple: 1.6,
    trailingPercent: 20,
    maxLossPercent: 15,
    catastrophicLossPercent: 25,
    maxHoldMinutes: 1440,
  };
  const v19: ExitRules = { ...v18, costRecovery: { triggerMultiple: 2, sellCostBufferPercent: 3, moonbagTrailingPercent: 45 } };

  it("leaves profit-taking to the AI when the strategy has no cost recovery", () => {
    expect(formatExitRulesState(v18, 1.5)).toContain("No fixed profit-taking multiples exist");
  });

  it("tells the AI about the automatic sell at 2x before it happens", () => {
    const text = formatExitRulesState(v19, 1.5, false);
    expect(text).toContain("When this position first reaches 2x");
    expect(text).toContain("Trailing stop (loss protection only");
  });

  it("tells the AI its sells are ignored on the runner, and drops the base trail", () => {
    const text = formatExitRulesState(v19, 2.5, true);
    expect(text).toContain("45% retrace from its peak");
    expect(text).toContain("any sell you propose now is ignored");
    expect(text).not.toContain("Trailing stop (loss protection only");
  });
});

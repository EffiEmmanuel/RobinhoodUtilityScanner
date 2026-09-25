import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tradeUpdate = vi.fn().mockResolvedValue(undefined);
vi.mock("../db", () => ({ db: { trade: { update: (...args: unknown[]) => tradeUpdate(...args) } } }));
const getBuyEstimate = vi.fn().mockRejectedValue(new Error("stop here"));
vi.mock("./executionFacade", () => ({
  getBuyEstimate: (...args: unknown[]) => getBuyEstimate(...args),
  isSellable: vi.fn().mockResolvedValue(true),
  executeBuyFill: vi.fn(),
  gasLedgerNote: vi.fn(() => "real gas"),
}));
vi.mock("./portfolio", () => ({
  checkCircuitBreakers: vi.fn().mockResolvedValue({ chains: {} }),
  getPortfolioState: vi.fn().mockResolvedValue({}),
  recordLedgerEntry: vi.fn(),
}));
vi.mock("./chartVisionGate", () => ({ renderPositionChart: vi.fn() }));

import { checkAndExecutePendingReentry } from "./positionStrategy";
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
  });
  afterEach(() => {
    Object.assign(tradingConfig, original);
  });

  it("drops a re-entry too small to be worth its gas, without quoting it", async () => {
    await checkAndExecutePendingReentry(trade(0.26), token, pair, "BASE");
    expect(getBuyEstimate).not.toHaveBeenCalled();
    expect(tradeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pendingReentryUsd: null, pendingReentryTargetMcap: null }) })
    );
  });

  it("goes on to quote a re-entry above the floor", async () => {
    await expect(checkAndExecutePendingReentry(trade(1), token, pair, "BASE")).rejects.toThrow("stop here");
    expect(getBuyEstimate).toHaveBeenCalledTimes(1);
    expect(tradeUpdate).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { shouldRetryPlanningForTransientMomentumMarket, tacticalScoutActionForWatchOnly } from "./planning";
import { TradePlanAction } from "../generated/prisma";

describe("shouldRetryPlanningForTransientMomentumMarket", () => {
  it("retries a momentum candidate when fresh planning liquidity comes back as zero", () => {
    const result = shouldRetryPlanningForTransientMomentumMarket({
      qualificationPath: "MOMENTUM_OVERRIDE",
      evaluation: {
        eligible: false,
        reasons: ["qualityScore 61.7 < 65", "researchConfidence 58 < 65", "liquidityUsd 0 < 8000"],
      },
      pair: { liquidityUsd: 0 },
    });

    expect(result).toBe(true);
  });

  it("retries a momentum candidate when the fresh planning pair is missing", () => {
    const result = shouldRetryPlanningForTransientMomentumMarket({
      qualificationPath: "MOMENTUM_OVERRIDE",
      evaluation: {
        eligible: false,
        reasons: ["liquidityUsd 0 < 8000"],
      },
      pair: undefined,
    });

    expect(result).toBe(true);
  });

  it("does not retry normal candidates", () => {
    const result = shouldRetryPlanningForTransientMomentumMarket({
      qualificationPath: "NORMAL",
      evaluation: {
        eligible: false,
        reasons: ["liquidityUsd 0 < 8000"],
      },
      pair: { liquidityUsd: 0 },
    });

    expect(result).toBe(false);
  });

  it("does not retry real nonzero low-liquidity failures", () => {
    const result = shouldRetryPlanningForTransientMomentumMarket({
      qualificationPath: "MOMENTUM_OVERRIDE",
      evaluation: {
        eligible: false,
        reasons: ["liquidityUsd 500 < 8000"],
      },
      pair: { liquidityUsd: 500 },
    });

    expect(result).toBe(false);
  });
});

describe("tacticalScoutActionForWatchOnly", () => {
  it("turns a MULTI-style watch-only call into BUY_NOW when current price is already inside the AI zone", () => {
    const result = tacticalScoutActionForWatchOnly({
      action: TradePlanAction.WATCH_ONLY,
      qualificationPath: "MOMENTUM_OVERRIDE",
      tradeLane: "MOMENTUM_TACTICAL",
      currentMcap: 41_099,
      targetEntryMcapMin: 28_000,
      targetEntryMcapMax: 42_000,
      pair: {
        liquidityUsd: 18_965,
        volume1h: 126_050,
        buys1h: 816,
        sells1h: 636,
      },
    });

    expect(result).toBe(TradePlanAction.BUY_NOW);
  });

  it("turns a momentum watch-only call into WAIT_FOR_ENTRY when the actionable zone is below current price", () => {
    const result = tacticalScoutActionForWatchOnly({
      action: TradePlanAction.WATCH_ONLY,
      qualificationPath: "MOMENTUM_OVERRIDE",
      tradeLane: "MOMENTUM_TACTICAL",
      currentMcap: 134_329,
      targetEntryMcapMin: 60_000,
      targetEntryMcapMax: 110_000,
      pair: {
        liquidityUsd: 33_985,
        volume1h: 238_262,
        buys1h: 1_369,
        sells1h: 1_216,
      },
    });

    expect(result).toBe(TradePlanAction.WAIT_FOR_ENTRY);
  });

  it("does not override watch-only when the activity looks like wash trading", () => {
    const result = tacticalScoutActionForWatchOnly({
      action: TradePlanAction.WATCH_ONLY,
      qualificationPath: "MOMENTUM_OVERRIDE",
      tradeLane: "MOMENTUM_TACTICAL",
      currentMcap: 41_099,
      targetEntryMcapMin: 28_000,
      targetEntryMcapMax: 42_000,
      pair: {
        liquidityUsd: 18_965,
        volume1h: 250_000,
        buys1h: 816,
        sells1h: 636,
      },
    });

    expect(result).toBeUndefined();
  });

  it("does not override non-momentum watch-only decisions", () => {
    const result = tacticalScoutActionForWatchOnly({
      action: TradePlanAction.WATCH_ONLY,
      qualificationPath: "NORMAL",
      tradeLane: "VERIFIED_PROJECT",
      currentMcap: 41_099,
      targetEntryMcapMin: 28_000,
      targetEntryMcapMax: 42_000,
      pair: {
        liquidityUsd: 18_965,
        volume1h: 126_050,
        buys1h: 816,
        sells1h: 636,
      },
    });

    expect(result).toBeUndefined();
  });
});

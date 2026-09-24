import { describe, it, expect, afterEach } from "vitest";
import { tradingConfig } from "./config";
import {
  evaluateCandidate,
  isBondingCurvePair,
  failedOnlyOnMarketAccess,
  calculatePositionSize,
  validateEntry,
  validatePosition,
  entryMarketFilter,
  validateExit,
} from "./riskEngine";
import type { SizingRules } from "./strategy";
import type { PortfolioState } from "./portfolio";

const sizingRules: SizingRules = {
  baseAllocationPercent: 10,
  qualityMultiplierMin: 0.6,
  qualityMultiplierMax: 1.3,
  confidenceMultiplierMin: 0.6,
  confidenceMultiplierMax: 1.2,
  riskMultiplierLow: 1.2,
  riskMultiplierMedium: 1.0,
  riskMultiplierHigh: 0.5,
  liquidityMultiplierMin: 0.5,
  liquidityMultiplierMax: 1.2,
};

function portfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    cashUsd: 1000,
    openPositionValueUsd: 0,
    totalEquityUsd: 1000,
    lockedProfitUsd: 0,
    reserveTargetUsd: 500,
    deployableCapUsd: 500,
    deployedUsd: 0,
    availableToDeployUsd: 500,
    openPositionCount: 0,
    ...overrides,
  };
}

describe("evaluateCandidate", () => {
  it("hard-rejects regardless of scores when hardReject is true", () => {
    const result = evaluateCandidate({
      qualityScore: 99,
      researchConfidence: 99,
      contractScore: 99,
      liquidityUsd: 1_000_000,
      hardReject: true,
      chain: "robinhood",
      onBondingCurve: false,
    });
    expect(result.eligible).toBe(false);
    expect(result.riskBucket).toBe("REJECT");
  });

  it("rejects when any gate is not cleared", () => {
    const result = evaluateCandidate({
      qualityScore: 50,
      researchConfidence: 90,
      contractScore: 90,
      liquidityUsd: 100_000,
      hardReject: false,
      chain: "robinhood",
      onBondingCurve: false,
    });
    expect(result.eligible).toBe(false);
  });

  it("accepts and buckets LOW risk when comfortably above every gate", () => {
    const result = evaluateCandidate({
      qualityScore: 95,
      researchConfidence: 90,
      contractScore: 90,
      liquidityUsd: 100_000,
      hardReject: false,
      chain: "robinhood",
      onBondingCurve: false,
    });
    expect(result.eligible).toBe(true);
    expect(result.riskBucket).toBe("LOW");
  });

  it("accepts and buckets HIGH risk when barely clearing the gates", () => {
    const result = evaluateCandidate({
      qualityScore: 81,
      researchConfidence: 66,
      contractScore: 76,
      liquidityUsd: 15_000,
      hardReject: false,
      chain: "robinhood",
      onBondingCurve: false,
    });
    expect(result.eligible).toBe(true);
    expect(result.riskBucket).toBe("HIGH");
  });

  // User directive 2026-09-18: the momentum override that used to waive
  // qualityScore/researchConfidence/liquidity for high-hourly-txn candidates
  // was removed — it was exactly how meme/no-utility tokens reached live
  // capital as MOMENTUM_TACTICAL trades. These tests lock in that a
  // below-bar candidate now stays rejected no matter how strong the
  // (formerly override-triggering) demand signal looks. PEG-style evidence
  // (qualityScore 53.6, researchConfidence 59, 459 txns/hour on $20.8K
  // liquidity, clean contract) used to be waived through — it no longer is.
  it("stays rejected on soft quality/confidence even with strong observed demand", () => {
    const result = evaluateCandidate({
      qualityScore: 53.6,
      researchConfidence: 59,
      contractScore: 100,
      liquidityUsd: 20_783,
      hardReject: false,
      chain: "robinhood",
      onBondingCurve: false,
    });
    expect(result.eligible).toBe(false);
  });

  it("stays rejected below the liquidity floor regardless of demand", () => {
    const result = evaluateCandidate({
      qualityScore: 62,
      researchConfidence: 70,
      contractScore: 100,
      liquidityUsd: 5_000,
      hardReject: false,
      chain: "robinhood",
      onBondingCurve: false,
    });
    expect(result.eligible).toBe(false);
  });

  // User directive 2026-09-24 (DESKS): a Solana token's contract score is a
  // fixed placeholder (no Solana contract research exists), and a pre-bond
  // pump.fun pair reports no liquidity at all — both used to fail every such
  // token regardless of quality.
  it("does not hold a Solana token to the contract-score bar it can't be measured against", () => {
    const result = evaluateCandidate({
      qualityScore: tradingConfig.minTradeQualityScore + 5,
      researchConfidence: tradingConfig.minTradeResearchConfidence + 5,
      contractScore: 50,
      liquidityUsd: tradingConfig.minTradeLiquidityUsd * 2,
      hardReject: false,
      chain: "solana",
      onBondingCurve: false,
    });
    expect(result.eligible).toBe(true);
  });

  it("still enforces the contract-score bar on EVM", () => {
    const result = evaluateCandidate({
      qualityScore: tradingConfig.minTradeQualityScore + 5,
      researchConfidence: tradingConfig.minTradeResearchConfidence + 5,
      contractScore: 50,
      liquidityUsd: tradingConfig.minTradeLiquidityUsd * 2,
      hardReject: false,
      chain: "robinhood",
      onBondingCurve: false,
    });
    expect(result.eligible).toBe(false);
  });

  it("does not reject a bonding-curve pair for reporting no liquidity", () => {
    const result = evaluateCandidate({
      qualityScore: tradingConfig.minTradeQualityScore + 5,
      researchConfidence: tradingConfig.minTradeResearchConfidence + 5,
      contractScore: 50,
      liquidityUsd: 0,
      hardReject: false,
      chain: "solana",
      onBondingCurve: true,
    });
    expect(result.eligible).toBe(true);
  });
});

describe("failedOnlyOnMarketAccess", () => {
  const base = {
    qualityScore: tradingConfig.minTradeQualityScore + 5,
    researchConfidence: tradingConfig.minTradeResearchConfidence + 5,
    contractScore: 100,
    hardReject: false,
    chain: "robinhood",
    onBondingCurve: false,
  };

  it("is true when a thin pool is the only failing check", () => {
    expect(failedOnlyOnMarketAccess(evaluateCandidate({ ...base, liquidityUsd: 1 }))).toBe(true);
  });

  it("treats a thin pool as liquid enough once a live quote proved our minimum position executes", () => {
    const result = evaluateCandidate({ ...base, liquidityUsd: 550, executableAtMinimumSize: true });
    expect(result.eligible).toBe(true);
  });

  it("counts a checked-and-unexecutable route as a market-access failure, not a verdict", () => {
    const result = evaluateCandidate({ ...base, liquidityUsd: tradingConfig.minTradeLiquidityUsd * 4, executableAtMinimumSize: false });
    expect(result.eligible).toBe(false);
    expect(result.failedChecks).toEqual(["execution"]);
    expect(failedOnlyOnMarketAccess(result)).toBe(true);
  });

  it("never holds an unchecked route against a candidate", () => {
    expect(evaluateCandidate({ ...base, liquidityUsd: tradingConfig.minTradeLiquidityUsd * 4, executableAtMinimumSize: undefined }).eligible).toBe(true);
  });

  it("is false when anything else failed too, or nothing failed", () => {
    expect(failedOnlyOnMarketAccess(evaluateCandidate({ ...base, qualityScore: 0, liquidityUsd: 1 }))).toBe(false);
    expect(failedOnlyOnMarketAccess(evaluateCandidate({ ...base, hardReject: true, liquidityUsd: 1 }))).toBe(false);
    expect(failedOnlyOnMarketAccess(evaluateCandidate({ ...base, liquidityUsd: tradingConfig.minTradeLiquidityUsd * 2 }))).toBe(false);
  });
});

describe("isBondingCurvePair", () => {
  it("is true only for a pump.fun pair with no reported liquidity", () => {
    expect(isBondingCurvePair({ dexId: "pumpfun" })).toBe(true);
    expect(isBondingCurvePair({ dexId: "pumpfun", liquidityUsd: 29_000 })).toBe(false);
    expect(isBondingCurvePair({ dexId: "pumpswap" })).toBe(false);
    expect(isBondingCurvePair(undefined)).toBe(false);
  });
});

describe("calculatePositionSize", () => {
  it("rejects a REJECT risk bucket outright", () => {
    const result = calculatePositionSize({
      portfolio: portfolio(),
      sizingRules,
      qualityScore: 90,
      confidence: 90,
      riskBucket: "REJECT",
      liquidityUsd: 100_000,
    });
    expect(result.approved).toBe(false);
    expect(result.positionSizeUsd).toBe(0);
  });

  it("caps position size at maxSinglePositionPercent of equity", () => {
    // deliberately extreme multipliers so the raw formula would exceed the cap
    const richSizing: SizingRules = {
      ...sizingRules,
      baseAllocationPercent: 90,
    };
    const result = calculatePositionSize({
      portfolio: portfolio({ availableToDeployUsd: 1000 }),
      sizingRules: richSizing,
      qualityScore: 100,
      confidence: 100,
      riskBucket: "LOW",
      liquidityUsd: 1_000_000,
    });
    expect(result.approved).toBe(true);
    // Reads the live config rather than hardcoding the value, so this stays
    // correct whatever MAX_SINGLE_POSITION_PERCENT is actually set to.
    expect(result.positionSizeUsd).toBeLessThanOrEqual(1000 * (tradingConfig.maxSinglePositionPercent / 100));
  });

  it("caps position size at remaining deployable capital", () => {
    const result = calculatePositionSize({
      portfolio: portfolio({ availableToDeployUsd: 10 }),
      sizingRules,
      qualityScore: 90,
      confidence: 90,
      riskBucket: "MEDIUM",
      liquidityUsd: 100_000,
    });
    expect(result.positionSizeUsd).toBeLessThanOrEqual(10);
  });

  it("sizes a sweet-spot small-mcap entry larger than an identical large-mcap one", () => {
    // User directive 2026-09-11: PEG ($51K entry -> ~4x) and TFLY ($195K ->
    // 2x+) both delivered real, fast multiples; RWA/STONKBROKER, both
    // already $20-30M at entry, did not. Same candidate quality/confidence/
    // liquidity/risk in both calls below — only currentMcapUsd differs.
    const base = {
      portfolio: portfolio({ availableToDeployUsd: 100_000 }),
      sizingRules: { ...sizingRules, baseAllocationPercent: 5 },
      qualityScore: 90,
      confidence: 90,
      riskBucket: "MEDIUM" as const,
      liquidityUsd: 100_000,
    };
    const smallMcap = calculatePositionSize({ ...base, currentMcapUsd: 100_000 });
    const largeMcap = calculatePositionSize({ ...base, currentMcapUsd: 20_000_000 });
    const noMcapData = calculatePositionSize({ ...base });
    expect(smallMcap.positionSizeUsd).toBeGreaterThan(largeMcap.positionSizeUsd);
    // Large-mcap and no-data both get the 1x baseline — a reward for the
    // sweet spot, never a penalty for being outside it.
    expect(largeMcap.positionSizeUsd).toBeCloseTo(noMcapData.positionSizeUsd, 5);
  });

  it("rejects when gas cost would be too large a fraction of a tiny position", () => {
    const result = calculatePositionSize({
      portfolio: portfolio({ totalEquityUsd: 1, availableToDeployUsd: 0.5 }),
      sizingRules,
      qualityScore: 90,
      confidence: 90,
      riskBucket: "MEDIUM",
      liquidityUsd: 100_000,
    });
    expect(result.approved).toBe(false);
  });

  describe("LIVE tactical probe ceiling (opt-in, off by default since 2026-09-18)", () => {
    // tradingConfig.mode is normally fixed at module load from TRADING_MODE
    // (default SHADOW) — mutated directly here (and restored) since these
    // tiers only apply in LIVE mode, matching how calculatePositionSize
    // itself reads tradingConfig.mode live rather than via a passed-in flag.
    const originalMode = tradingConfig.mode;
    const originalTacticalLiveMaxPositionUsd = tradingConfig.tacticalLiveMaxPositionUsd;
    afterEach(() => {
      tradingConfig.mode = originalMode;
      tradingConfig.tacticalLiveMaxPositionUsd = originalTacticalLiveMaxPositionUsd;
    });

    const richBase = {
      portfolio: portfolio({ availableToDeployUsd: 100_000, totalEquityUsd: 100_000 }),
      sizingRules: { ...sizingRules, baseAllocationPercent: 90 },
      qualityScore: 100,
      confidence: 100,
      riskBucket: "LOW" as const,
      liquidityUsd: 1_000_000,
      tradeLane: "MOMENTUM_TACTICAL" as const,
    };

    // User directive 2026-09-18: MOMENTUM_TACTICAL can no longer contain
    // meme/no-utility tokens (the utility gate has no bypass left), so it no
    // longer gets a hardcoded few-dollar probe ceiling by default — it sizes
    // through the normal formula (tacticalLaneSizeMultiplier discount, then
    // the usual single-position-percent/deployable-capital caps) same as
    // VERIFIED_PROJECT. tacticalLiveMaxPositionUsd defaults to 0 (disabled).
    it("does not cap a LIVE tactical trade at a fixed probe ceiling by default", () => {
      tradingConfig.mode = "LIVE";
      expect(tradingConfig.tacticalLiveMaxPositionUsd).toBe(0);
      const result = calculatePositionSize({ ...richBase, highConviction: false });
      expect(result.appliedProbeCapUsd).toBeUndefined();
      expect(result.positionSizeUsd).toBeGreaterThan(10);
    });

    // The mechanism itself still exists for anyone who deliberately
    // re-enables it (sets TACTICAL_LIVE_MAX_POSITION_USD > 0) — covered here
    // by mutating config directly rather than relying on the (now disabled)
    // default.
    it("still caps at the probe ceiling when explicitly re-enabled", () => {
      tradingConfig.mode = "LIVE";
      tradingConfig.tacticalLiveMaxPositionUsd = 2.5;
      const result = calculatePositionSize({ ...richBase, highConviction: false });
      expect(result.positionSizeUsd).toBe(2.5);
      expect(result.appliedProbeCapUsd).toBe(2.5);
    });

    it("raises the ceiling for a high-conviction LIVE tactical trade when the base ceiling is enabled", () => {
      tradingConfig.mode = "LIVE";
      tradingConfig.tacticalLiveMaxPositionUsd = 2.5;
      const result = calculatePositionSize({ ...richBase, highConviction: true });
      expect(result.positionSizeUsd).toBe(tradingConfig.tacticalLiveMaxPositionUsdHighConviction);
      expect(result.appliedProbeCapUsd).toBe(tradingConfig.tacticalLiveMaxPositionUsdHighConviction);
      expect(result.positionSizeUsd).toBeGreaterThan(2.5);
    });

    it("does not apply the LIVE probe ceiling outside LIVE mode even when enabled", () => {
      tradingConfig.mode = "SHADOW";
      tradingConfig.tacticalLiveMaxPositionUsd = 2.5;
      const result = calculatePositionSize({ ...richBase, highConviction: false });
      expect(result.positionSizeUsd).toBeGreaterThan(2.5);
      expect(result.appliedProbeCapUsd).toBeUndefined();
    });
  });
});

describe("validateEntry", () => {
  const base = {
    circuitBreakersPaused: false,
    circuitBreakerReasons: [] as string[],
    currentLiquidityUsd: 20_000,
    liquidityAtPlanUsd: 20_000,
    sellQuoteAvailable: true,
    buySellRatio1h: 0.6,
    priceChange5mPercent: 1,
    estimatedSlippageBps: 100,
    estimatedPriceImpactPercent: 1,
    positionSizeUsd: 50,
    availableToDeployUsd: 500,
  };

  it("defers when circuit breakers are paused", () => {
    expect(
      validateEntry({
        ...base,
        circuitBreakersPaused: true,
        circuitBreakerReasons: ["max open positions"],
      }).decision
    ).toBe("DEFER");
  });

  it("defers when there is no sell path yet", () => {
    expect(validateEntry({ ...base, sellQuoteAvailable: false }).decision).toBe(
      "DEFER"
    );
  });

  it("rejects on the catastrophic-drop combination (liquidity collapse + sharp price drop)", () => {
    const result = validateEntry({
      ...base,
      currentLiquidityUsd: 5_000,
      liquidityAtPlanUsd: 20_000,
      priceChange5mPercent: -30,
    });
    expect(result.decision).toBe("REJECTED");
  });

  it("rejects when sell volume massively exceeds buy volume", () => {
    expect(validateEntry({ ...base, buySellRatio1h: 0.1 }).decision).toBe(
      "REJECTED"
    );
  });

  it("approves when everything is clean", () => {
    expect(validateEntry(base).decision).toBe("APPROVED");
  });

  it("defers rather than permanently rejects when the buy quote is too expensive", () => {
    const result = validateEntry({
      ...base,
      estimatedSlippageBps: 725,
      estimatedPriceImpactPercent: 7.25,
    });
    expect(result.decision).toBe("DEFER");
    expect(result.reasons).toContain("estimated slippage 725bps exceeds 300bps limit");
    expect(result.reasons).toContain("estimated price impact 7.25% exceeds 3% limit");
  });

  it("allows probe-sized tactical entries to use explicit wider execution limits", () => {
    const result = validateEntry({
      ...base,
      estimatedSlippageBps: 725,
      estimatedPriceImpactPercent: 7.25,
      maxBuySlippageBps: 1000,
      maxBuyPriceImpactPercent: 10,
    });
    expect(result.decision).toBe("APPROVED");
  });
});

describe("validatePosition", () => {
  const base = {
    liquidityUsd: 20_000,
    liquidityAtEntryUsd: 20_000,
    unrealizedPnlPercent: 10,
    maxLossPercent: 25,
    catastrophicLossPercent: 40,
    buySellRatio5m: 0.6,
    totalTxns5m: 10,
    sellQuoteAvailable: true,
  };

  it("triggers a CRITICAL exit when the sell quote disappears", () => {
    const result = validatePosition({ ...base, sellQuoteAvailable: false });
    expect(result.riskExitTriggered).toBe(true);
    expect(result.severity).toBe("CRITICAL");
  });

  it("triggers a CRITICAL exit at the catastrophic loss threshold", () => {
    const result = validatePosition({ ...base, unrealizedPnlPercent: -40 });
    expect(result.riskExitTriggered).toBe(true);
    expect(result.severity).toBe("CRITICAL");
  });

  it("does not trigger below all thresholds", () => {
    expect(validatePosition(base).riskExitTriggered).toBe(false);
  });

  it("holds through price-only exits when holdThroughDrawdowns is set, but not through a broken token", () => {
    const hold = { ...base, holdThroughDrawdowns: true };
    expect(validatePosition({ ...hold, unrealizedPnlPercent: -80 }).riskExitTriggered).toBe(false);
    expect(validatePosition({ ...hold, buySellRatio5m: 0.05, totalTxns5m: 50 }).riskExitTriggered).toBe(false);
    expect(validatePosition({ ...hold, sellQuoteAvailable: false }).severity).toBe("CRITICAL");
    expect(validatePosition({ ...hold, liquidityUsd: 5_000 }).severity).toBe("CRITICAL");
  });

  it("does not trigger extreme sell pressure on a near-empty 5-minute window", () => {
    // PERPSHOOD, 2026-09-11: sold on "extreme sell pressure (buy ratio 0%)"
    // from a 5-minute window with 0 buys AND 0 sells — the ratio's own
    // divide-by-zero guard read total silence as 100% sellers. It went on to
    // reach 1.68x.
    const result = validatePosition({ ...base, buySellRatio5m: 0, totalTxns5m: 0 });
    expect(result.riskExitTriggered).toBe(false);
  });

  it("still triggers extreme sell pressure once there's real volume behind the ratio", () => {
    const result = validatePosition({ ...base, buySellRatio5m: 0.1, totalTxns5m: 20 });
    expect(result.riskExitTriggered).toBe(true);
    expect(result.severity).toBe("WARNING");
    expect(result.reasons[0]).toMatch(/extreme sell pressure/);
  });

  it("does not trigger extreme sell pressure just below the txn-count floor", () => {
    const result = validatePosition({ ...base, buySellRatio5m: 0, totalTxns5m: 4 });
    expect(result.riskExitTriggered).toBe(false);
  });
});

describe("validateExit", () => {
  it("rejects a non-emergency exit above the normal slippage ceiling", () => {
    expect(
      validateExit({ isEmergency: false, estimatedSlippageBps: 10_000 })
        .approved
    ).toBe(false);
  });

  it("still proceeds on an emergency exit even above the emergency ceiling (avoids an orphaned position)", () => {
    expect(
      validateExit({ isEmergency: true, estimatedSlippageBps: 50_000 }).approved
    ).toBe(true);
  });
});

describe("entryMarketFilter", () => {
  const healthy = { chain: "robinhood", marketCapUsd: 40_000, liquidityUsd: 12_000, priceChange1hPercent: 80, onBondingCurve: false };

  it("passes a fresh, reasonably liquid token", () => {
    expect(entryMarketFilter(healthy)).toEqual([]);
  });

  it("caps market cap on Robinhood but not on Solana", () => {
    expect(entryMarketFilter({ ...healthy, marketCapUsd: 150_000, liquidityUsd: 40_000 })).toHaveLength(1);
    expect(entryMarketFilter({ ...healthy, chain: "solana", marketCapUsd: 150_000, liquidityUsd: 40_000 })).toEqual([]);
  });

  it("skips a token that already ran 1000%+ in the hour", () => {
    expect(entryMarketFilter({ ...healthy, priceChange1hPercent: 1200 })[0]).toMatch(/already up/);
  });

  it("skips liquidity far out of line with market cap", () => {
    expect(entryMarketFilter({ ...healthy, liquidityUsd: 2_000 })[0]).toMatch(/liquidity is 5% of market cap/);
    expect(entryMarketFilter({ ...healthy, liquidityUsd: 30_000 })[0]).toMatch(/liquidity is 75% of market cap/);
  });

  it("never fails on missing data or a bonding curve's absent pool", () => {
    expect(entryMarketFilter({ ...healthy, marketCapUsd: undefined, liquidityUsd: undefined, priceChange1hPercent: undefined })).toEqual([]);
    expect(entryMarketFilter({ ...healthy, chain: "solana", liquidityUsd: 1, onBondingCurve: true })).toEqual([]);
  });
});

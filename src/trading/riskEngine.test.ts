import { describe, it, expect } from "vitest";
import { tradingConfig } from "./config";
import {
  evaluateCandidate,
  calculatePositionSize,
  validateEntry,
  validatePosition,
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
    });
    expect(result.eligible).toBe(true);
    expect(result.riskBucket).toBe("HIGH");
  });

  it("momentum-overrides a low qualityScore into HIGH risk when every other gate clears and hourly txns are strong", () => {
    const result = evaluateCandidate({
      qualityScore: 62,
      researchConfidence: 70,
      contractScore: 100,
      liquidityUsd: 20_000,
      hardReject: false,
      hourlyTxns: 40,
    });
    expect(result.eligible).toBe(true);
    expect(result.riskBucket).toBe("HIGH");
  });

  it("momentum-overrides both qualityScore and researchConfidence together when contract/liquidity are clean and demand is strong", () => {
    // Confirmed live 2026-09-11: PEG (qualityScore 53.6, researchConfidence
    // 59 — both softly under the bar on a ~2-minute-old token with no
    // site/socials yet to score) had 459 txns/hour on $20.8K liquidity and a
    // clean contract (contractScore 100), and was hard-REJECTED outright
    // because the override previously only ever waived qualityScore alone.
    // It went on to run 100x+ from its detection mcap.
    const result = evaluateCandidate({
      qualityScore: 53.6,
      researchConfidence: 59,
      contractScore: 100,
      liquidityUsd: 20_783,
      hardReject: false,
      hourlyTxns: 459,
    });
    expect(result.eligible).toBe(true);
    expect(result.riskBucket).toBe("HIGH");
  });

  it("does not momentum-override when a non-qualityScore gate also fails", () => {
    const result = evaluateCandidate({
      qualityScore: 62,
      researchConfidence: 70,
      contractScore: 100,
      liquidityUsd: 5_000, // below minTradeLiquidityUsd
      hardReject: false,
      hourlyTxns: 40,
    });
    expect(result.eligible).toBe(false);
  });

  it("does not momentum-override without enough hourly txns", () => {
    const result = evaluateCandidate({
      qualityScore: 62,
      researchConfidence: 70,
      contractScore: 100,
      liquidityUsd: 20_000,
      hardReject: false,
      hourlyTxns: 2,
    });
    expect(result.eligible).toBe(false);
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
      sizingRules,
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

  it("rejects when there is no sell path", () => {
    expect(validateEntry({ ...base, sellQuoteAvailable: false }).decision).toBe(
      "REJECTED"
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

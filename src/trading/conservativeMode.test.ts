import { describe, it, expect } from "vitest";
import {
  resolveEntryMode,
  estimateTokenAgeMinutes,
  evaluateChaseGuard,
  evaluateHighConvictionSetup,
  evaluateQuoteAgreement,
  evaluateRealDemand,
  hasPriceStabilized,
  type HighConvictionInput,
  type RealDemandThresholds,
} from "./conservativeMode";
import { tradingConfig } from "./config";

describe("resolveEntryMode", () => {
  const calm = { hardPauseReasons: [] as string[], dailyRealizedLossPercent: 0, consecutiveLosses: 0 };

  it("stays NORMAL while no breaker has tripped", () => {
    expect(resolveEntryMode(calm).mode).toBe("NORMAL");
    expect(
      resolveEntryMode({
        ...calm,
        dailyRealizedLossPercent: tradingConfig.maxDailyRealizedLossPercent - 5,
        consecutiveLosses: tradingConfig.maxConsecutiveLosses - 1,
      }).mode
    ).toBe("NORMAL");
  });

  // 2026-09-11: daily realized loss 22.2% against a 20% limit, plus 3 losses in a row.
  const tripped = { ...calm, dailyRealizedLossPercent: tradingConfig.maxDailyRealizedLossPercent, consecutiveLosses: tradingConfig.maxConsecutiveLosses };

  it("switches to CONSERVATIVE instead of pausing when only a loss limit tripped, if conservative mode is enabled", () => {
    const original = tradingConfig.conservativeModeEnabled;
    tradingConfig.conservativeModeEnabled = true;
    try {
      const result = resolveEntryMode(tripped);
      expect(result.mode).toBe("CONSERVATIVE");
      expect(result.reasons).toHaveLength(2);
    } finally {
      tradingConfig.conservativeModeEnabled = original;
    }
  });

  it("fully pauses on the same trip when conservative mode is disabled", () => {
    // User directive 2026-09-12: hard-disabled in production
    // (CONSERVATIVE_MODE_ENABLED=false) — "let it be triggered another day"
    // rather than keep trading through a tripped loss breaker.
    const original = tradingConfig.conservativeModeEnabled;
    tradingConfig.conservativeModeEnabled = false;
    try {
      const result = resolveEntryMode(tripped);
      expect(result.mode).toBe("PAUSED");
      expect(result.reasons).toHaveLength(2);
    } finally {
      tradingConfig.conservativeModeEnabled = original;
    }
  });

  it("still fully pauses on a non-loss breaker, even alongside a loss breaker", () => {
    const result = resolveEntryMode({
      hardPauseReasons: ["global kill switch is engaged"],
      dailyRealizedLossPercent: tradingConfig.maxDailyRealizedLossPercent,
      consecutiveLosses: 0,
    });
    expect(result.mode).toBe("PAUSED");
    expect(result.reasons).toContain("global kill switch is engaged");
  });

  // Both hard-stop tests need conservative mode actually ENABLED — otherwise
  // resolveEntryMode short-circuits to PAUSED before ever reaching the
  // hard-stop check below, and the test would pass without exercising it.
  it("fully pauses again past the conservative-mode daily loss hard stop", () => {
    const original = tradingConfig.conservativeModeEnabled;
    tradingConfig.conservativeModeEnabled = true;
    try {
      expect(resolveEntryMode({ ...calm, dailyRealizedLossPercent: tradingConfig.conservativeHardStopDailyLossPercent }).mode).toBe("PAUSED");
    } finally {
      tradingConfig.conservativeModeEnabled = original;
    }
  });

  it("fully pauses again past the conservative-mode consecutive-loss hard stop", () => {
    const original = tradingConfig.conservativeModeEnabled;
    tradingConfig.conservativeModeEnabled = true;
    try {
      expect(resolveEntryMode({ ...calm, consecutiveLosses: tradingConfig.conservativeHardStopConsecutiveLosses }).mode).toBe("PAUSED");
    } finally {
      tradingConfig.conservativeModeEnabled = original;
    }
  });
});

describe("estimateTokenAgeMinutes", () => {
  const now = new Date("2026-09-11T15:26:00Z");

  it("ignores a pairCreatedAt that reads in the future and falls back to when we first saw the token", () => {
    // Sheared, 2026-09-11: DexScreener said the pair was created at 16:18,
    // 52 minutes after we bought it; we had first seen it at 15:18.
    const age = estimateTokenAgeMinutes(new Date("2026-09-11T15:18:00Z"), new Date("2026-09-11T16:18:00Z"), now);
    expect(age).toBeCloseTo(8, 5);
  });

  it("trusts pairCreatedAt, minus the skew, for an old token we only noticed recently", () => {
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60_000);
    const age = estimateTokenAgeMinutes(new Date(now.getTime() - 5 * 60_000), threeDaysAgo, now);
    expect(age).toBeCloseTo(3 * 24 * 60 - 60, 5);
  });
});

describe("evaluateHighConvictionSetup", () => {
  const clean: HighConvictionInput = {
    tokenAgeMinutes: tradingConfig.conservativeMinTokenAgeMinutes * 3,
    liquidityUsd: tradingConfig.conservativeMinLiquidityUsd * 1.5,
    buys1h: 120,
    sells1h: 80, // 60% buy ratio
    volume1hUsd: tradingConfig.conservativeMinLiquidityUsd * 3, // 2x liquidity
    priceChange5mPercent: 4,
    priceChange1hPercent: 35,
    recent: { snapshotCount: 12, runUpPercent: 8, drawdownPercent: 5 },
    marketRegime: "BREAKOUT",
    planRiskScore: 55,
  };

  it("passes an established, liquid, steadily-accumulating setup", () => {
    const result = evaluateHighConvictionSetup(clean);
    expect(result.reasons).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("blocks BLACKHOLE's chase even though DexScreener's lagging 5m change looked calm", () => {
    // 2026-09-11, -$4.60: 8 minutes old, $25K liquidity, 50/50 buys vs sells,
    // up 46% in the 3 minutes before entry by our own snapshots while
    // DexScreener still reported -9% over 5m.
    const result = evaluateHighConvictionSetup({
      tokenAgeMinutes: 8,
      liquidityUsd: 25_098,
      buys1h: 560,
      sells1h: 560,
      volume1hUsd: 55_000,
      priceChange5mPercent: -8.82,
      priceChange1hPercent: -9.52,
      recent: { snapshotCount: 14, runUpPercent: 46, drawdownPercent: 0 },
      marketRegime: "BREAKOUT",
      planRiskScore: 60,
    });
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toEqual(expect.arrayContaining(["tokenAge", "liquidity", "buyRatio", "recentRunUp"]));
    expect(result.failedChecks).not.toContain("priceChange5m");
  });

  it("blocks a parabolic chase on an older, liquid token (THREE)", () => {
    // 2026-09-11, -$1.44: old enough and liquid enough, but +7,553% on the
    // hour and already up 41% in the last 10 minutes.
    const result = evaluateHighConvictionSetup({
      tokenAgeMinutes: 83,
      liquidityUsd: 84_163,
      buys1h: 613,
      sells1h: 542,
      volume1hUsd: 305_700,
      priceChange5mPercent: 9.4,
      priceChange1hPercent: 7_553,
      recent: { snapshotCount: 20, runUpPercent: 41, drawdownPercent: 0 },
      marketRegime: "BREAKOUT",
      planRiskScore: 65,
    });
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toEqual(expect.arrayContaining(["priceChange1h", "recentRunUp"]));
    expect(result.failedChecks).not.toContain("tokenAge");
    expect(result.failedChecks).not.toContain("liquidity");
  });

  it("blocks a brand-new token mid-dump with wash-level volume (PONSFLY)", () => {
    // 2026-09-11, -$0.66: 2 minutes old, 27x its liquidity traded in an hour,
    // -45% over 5m, and the AI itself called it DISTRIBUTION.
    const result = evaluateHighConvictionSetup({
      tokenAgeMinutes: 2,
      liquidityUsd: 16_273,
      buys1h: 3_953,
      sells1h: 2_304,
      volume1hUsd: 440_900,
      priceChange5mPercent: -45.42,
      priceChange1hPercent: -27.18,
      recent: { snapshotCount: 3, runUpPercent: 0, drawdownPercent: 17 },
      marketRegime: "DISTRIBUTION",
      planRiskScore: 75,
    });
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toEqual(expect.arrayContaining(["tokenAge", "liquidity", "volumeToLiquidity", "priceChange5m", "marketRegime"]));
  });

  it("holds back until there is enough of our own price history to judge a run-up", () => {
    const result = evaluateHighConvictionSetup({ ...clean, recent: { snapshotCount: 1, runUpPercent: 0, drawdownPercent: 0 } });
    expect(result.failedChecks).toEqual(["recentHistory"]);
  });

  it("blocks a falling knife by our own recent high", () => {
    const result = evaluateHighConvictionSetup({
      ...clean,
      recent: { snapshotCount: 12, runUpPercent: 0, drawdownPercent: tradingConfig.conservativeMaxRecentDrawdownPercent + 1 },
    });
    expect(result.failedChecks).toEqual(["recentDrawdown"]);
  });

  it("takes the AI plan's own red flags at face value", () => {
    expect(evaluateHighConvictionSetup({ ...clean, marketRegime: "PARABOLIC" }).failedChecks).toEqual(["marketRegime"]);
    expect(evaluateHighConvictionSetup({ ...clean, planRiskScore: tradingConfig.conservativeMaxPlanRiskScore }).failedChecks).toEqual(["planRisk"]);
  });
});

describe("evaluateQuoteAgreement", () => {
  const CONSERVATIVE = tradingConfig.conservativeMaxQuoteDiscountPercent; // 10
  const NORMAL = tradingConfig.normalMaxQuoteDiscountPercent; // 30

  it("passes when the on-chain quote costs about what DexScreener shows (fees push it slightly higher)", () => {
    expect(evaluateQuoteAgreement({ spotPriceUsd: 0.001, positionSizeUsd: 5, quotedTokenAmount: 4_900 }, CONSERVATIVE).passed).toBe(true);
  });

  it("blocks when the chain is far cheaper than DexScreener's price — stale data on a collapsing token", () => {
    // moltfly, 2026-09-11: filled 39% below the displayed price, then collapsed.
    const result = evaluateQuoteAgreement({ spotPriceUsd: 0.001, positionSizeUsd: 5, quotedTokenAmount: 5 / (0.001 * 0.61) }, CONSERVATIVE);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toEqual(["quoteAgreement"]);
  });

  it("blocks when there is no usable quote", () => {
    expect(evaluateQuoteAgreement({ spotPriceUsd: 0.001, positionSizeUsd: 5, quotedTokenAmount: 0 }, CONSERVATIVE).passed).toBe(false);
  });

  it("normal mode's looser cutoff lets a real dip like TUMBLE's through, where conservative mode would block it", () => {
    // TUMBLE, 2026-09-11: filled 25% below the displayed price during a
    // genuine dip and went on to be the day's best trade (+$4.87).
    const input = { spotPriceUsd: 0.001, positionSizeUsd: 5, quotedTokenAmount: 5 / (0.001 * 0.75) };
    expect(evaluateQuoteAgreement(input, NORMAL).passed).toBe(true);
    expect(evaluateQuoteAgreement(input, CONSERVATIVE).passed).toBe(false);
  });

  it("normal mode still blocks a genuinely stale/collapsing quote", () => {
    // Sheared, 2026-09-11: filled 82% below the displayed price.
    const result = evaluateQuoteAgreement({ spotPriceUsd: 0.001, positionSizeUsd: 5, quotedTokenAmount: 5 / (0.001 * 0.18) }, NORMAL);
    expect(result.passed).toBe(false);
  });
});

describe("evaluateChaseGuard", () => {
  const opts = { windowMinutes: 10, minSnapshots: 3, maxRunUpPercent: 30 };

  it("passes a modest run-up", () => {
    const result = evaluateChaseGuard({ snapshotCount: 10, runUpPercent: 8, drawdownPercent: 0 }, opts);
    expect(result.passed).toBe(true);
  });

  it("blocks chasing a token that's already run up hard (BLACKHOLE: +46% in 3 minutes)", () => {
    const result = evaluateChaseGuard({ snapshotCount: 14, runUpPercent: 46, drawdownPercent: 0 }, opts);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toEqual(["recentRunUp"]);
  });

  it("holds back until there's enough of our own price history to judge a run-up", () => {
    const result = evaluateChaseGuard({ snapshotCount: 1, runUpPercent: 0, drawdownPercent: 0 }, opts);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toEqual(["recentHistory"]);
  });

  it("holds back with no recent-range data at all", () => {
    expect(evaluateChaseGuard(undefined, opts).passed).toBe(false);
  });
});

describe("evaluateRealDemand", () => {
  const thresholds: RealDemandThresholds = { minHourlyTxns: 15, minBuyRatio1h: 0.5, maxBuyRatio1h: 0.85, maxVolumeToLiquidity1h: 8 };

  it("passes real, balanced trading activity", () => {
    const result = evaluateRealDemand({ buys1h: 40, sells1h: 30, volume1hUsd: 50_000, liquidityUsd: 20_000 }, thresholds);
    expect(result.passed).toBe(true);
  });

  it("blocks a near-dead pool", () => {
    const result = evaluateRealDemand({ buys1h: 3, sells1h: 2, volume1hUsd: 1_000, liquidityUsd: 20_000 }, thresholds);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain("hourlyTxns");
  });

  it("blocks net-selling pressure (buy ratio below the floor)", () => {
    const result = evaluateRealDemand({ buys1h: 10, sells1h: 30, volume1hUsd: 50_000, liquidityUsd: 20_000 }, thresholds);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain("buyRatio");
  });

  it("blocks bots-ahead-of-a-dump buy ratio above the ceiling", () => {
    const result = evaluateRealDemand({ buys1h: 38, sells1h: 2, volume1hUsd: 50_000, liquidityUsd: 20_000 }, thresholds);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain("buyRatio");
  });

  it("blocks wash trading (volume far above liquidity, PONSFLY/OPAI-shaped)", () => {
    const result = evaluateRealDemand({ buys1h: 40, sells1h: 30, volume1hUsd: 540_000, liquidityUsd: 20_000 }, thresholds);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain("volumeToLiquidity");
  });
});

describe("hasPriceStabilized", () => {
  it("is false with fewer than two readings", () => {
    expect(hasPriceStabilized([])).toBe(false);
    expect(hasPriceStabilized([100])).toBe(false);
  });

  it("is false while the latest reading is still a new low (still falling)", () => {
    // PONSFLY/Sheared/FFSTR, 2026-09-11: each triggered its pullback zone
    // while the price was still actively dropping tick over tick.
    expect(hasPriceStabilized([100, 90])).toBe(false);
  });

  it("is true once the latest reading is at or above the one before it", () => {
    expect(hasPriceStabilized([100, 90, 90])).toBe(true);
    expect(hasPriceStabilized([100, 90, 92])).toBe(true);
  });
});

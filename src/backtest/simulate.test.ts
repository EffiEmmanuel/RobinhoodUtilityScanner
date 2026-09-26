import { describe, expect, it } from "vitest";
import type { ExitRules } from "../trading/strategy";
import type { Candle } from "./candles";
import type { ChainCostModel } from "./costs";
import { refPrice, resolveTierPure, type SimCandidateMeta, simulatePosition, valueAtSize } from "./simulate";

const T0 = 1_790_000_000;

// v1.8's base profile (production 2026-09-25) with fastFlip/goodProject off
// unless a test turns them on.
const rules: ExitRules = {
  profitSteps: [
    { multiple: 2, sellPercentOfRemaining: 50 },
    { multiple: 2.5, sellPercentOfRemaining: 30 },
  ],
  trailRemaining: true,
  trailingActivationMultiple: 1.6,
  trailingPercent: 20,
  maxLossPercent: 15,
  catastrophicLossPercent: 25,
  maxHoldMinutes: 1440,
};

const noCosts: ChainCostModel = { entrySlippagePct: 0, exitSlippagePct: 0, gasBuyUsd: 0, gasSellUsd: 0 };

const meta: SimCandidateMeta = {
  chain: "robinhood",
  qualityScore: 70,
  socialScore: null,
  qualificationPath: "NORMAL",
  tradeLane: "MOMENTUM_TACTICAL",
  invalidationMcap: null,
  supply: 1_000_000,
  liquidityUsdAtDecision: undefined,
  midAtDecision: 1,
};

/** Flat candles (o=h=l=c) at the given prices, one per minute from T0. */
function flat(prices: number[], start = T0): Candle[] {
  return prices.map((p, i) => ({ t: start + i * 60, o: p, h: p, l: p, c: p, v: 100, d: 60 }));
}

function candle(i: number, o: number, h: number, l: number, c: number): Candle {
  return { t: T0 + i * 60, o, h, l, c, v: 100, d: 60 };
}

function sim(candles: Candle[], overrides: Partial<Parameters<typeof simulatePosition>[0]> = {}) {
  const r = simulatePosition({
    candles,
    coverageEnd: candles[candles.length - 1].t + 60,
    entryTs: T0 + 1,
    meta,
    exitRules: rules,
    costs: noCosts,
    sizeUsd: 5,
    ...overrides,
  });
  if ("skip" in r) throw new Error(r.skip);
  return r;
}

describe("refPrice", () => {
  const candles = [candle(0, 1, 1, 1, 1.1), candle(3, 1.2, 1.3, 1.2, 1.25)];
  it("uses the close of the candle containing ts and starts after it", () => {
    expect(refPrice(candles, T0 + 30)).toEqual({ price: 1.1, ts: T0 + 60, nextIdx: 1 });
  });
  it("uses the last close when nothing traded since (the AMM price hasn't moved)", () => {
    expect(refPrice(candles, T0 + 150)).toEqual({ price: 1.1, ts: T0 + 150, nextIdx: 1 });
  });
  it("has no price before the first trade", () => {
    expect(refPrice(candles, T0 - 5)).toBeUndefined();
  });
});

describe("simulatePosition through the live evaluateExits", () => {
  it("stops out at -15% from entry, filling at the low that triggered it", () => {
    const r = sim([candle(0, 1, 1, 1, 1), candle(1, 1, 1, 0.9, 0.95), candle(2, 0.95, 0.95, 0.8, 0.82), candle(3, 0.82, 0.82, 0.5, 0.5)]);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0].type).toBe("RISK_EXIT");
    expect(r.legs[0].mid).toBeCloseTo(0.8);
    expect(r.exitReason).toMatch(/max tolerated loss/);
  });

  it("trails from the peak once it crossed the activation multiple", () => {
    const r = sim(flat([1, 1.3, 1.7, 2.2, 1.9, 1.7, 1.2]));
    expect(r.legs[0].type).toBe("TRAILING_EXIT");
    expect(r.legs[0].mid).toBeCloseTo(1.7); // 1.7 / 2.2 = 22.7% retrace >= 20%
    expect(r.peakMultiple).toBeCloseTo(2.2);
  });

  it("takes no profit at 2x: since 2026-09-22 only the AI review does that", () => {
    const r = sim(flat([1, 2.05, 2.1, 2.1]));
    expect(r.legs.map((l) => l.type)).toEqual(["DATA_END"]);
  });

  it("runs the pre-09-22 profit ladder when asked (as-was replays)", () => {
    const r = sim(flat([1, 2.05, 2.6, 2.6]), { legacyProfitSteps: true });
    expect(r.legs.map((l) => [l.type, +l.fraction.toFixed(3)])).toEqual([
      ["PARTIAL_PROFIT", 0.5],
      ["PARTIAL_PROFIT", 0.15],
      ["DATA_END", 0.35],
    ]);
  });

  it("never sells into a one-candle wick above the close", () => {
    // Up bar: O→L→H→C. The ladder would fire at the 2.5 high; the fill is the 1.3 close.
    const r = sim([candle(0, 1, 1, 1, 1), candle(1, 1.1, 2.5, 1.1, 1.3), candle(2, 1.3, 1.3, 1.3, 1.3)], { legacyProfitSteps: true });
    expect(r.legs[0].type).toBe("PARTIAL_PROFIT");
    expect(r.legs[0].mid).toBeCloseTo(1.3);
  });

  it("in close mode ignores a one-minute wick that the worst-case path stops out on", () => {
    // OPAI-style: a -50% low inside a minute that closes back near entry.
    const bars = [candle(0, 1, 1, 1, 1), candle(1, 1, 1.02, 0.5, 0.98), candle(2, 0.98, 1, 0.97, 0.99)];
    expect(sim(bars).legs[0].type).toBe("RISK_EXIT");
    expect(sim(bars, { intrabar: "close" }).legs.map((l) => l.type)).toEqual(["DATA_END"]);
  });

  it("runs exitRules.stopConfirm through the live evaluateExits, timed by tick", () => {
    const s1: ExitRules = { ...rules, stopConfirm: { seconds: 30, appliesTo: "maxLoss" } };
    // Down bar O,H,L,C: -20% at the 40s tick, back to -5% at the close: a wick, held.
    const wick = [candle(0, 1, 1, 1, 1), candle(1, 1, 1, 0.8, 0.95), candle(2, 0.95, 1, 0.95, 1)];
    expect(sim(wick).legs[0].type).toBe("RISK_EXIT");
    expect(sim(wick, { exitRules: s1 }).legs.map((l) => l.type)).toEqual(["DATA_END"]);
    // A slide that stays past the line: sells at the first tick 30s after it crossed.
    const slide = [candle(0, 1, 1, 1, 1), candle(1, 1, 1, 0.8, 0.82), candle(2, 0.82, 0.82, 0.7, 0.72)];
    const confirmed = sim(slide, { exitRules: s1 });
    expect(confirmed.legs[0].type).toBe("RISK_EXIT");
    expect(confirmed.legs[0].reason).toMatch(/stayed past the max-loss stop/);
    expect(confirmed.legs[0].ts - (T0 + 60 + 40)).toBeGreaterThanOrEqual(30);
    // A -30% wick still trips the immediate catastrophic stop under maxLoss-only confirmation, not under "both".
    const deep = [candle(0, 1, 1, 1, 1), candle(1, 1, 1, 0.7, 0.95), candle(2, 0.95, 1, 0.95, 1)];
    expect(sim(deep, { exitRules: s1 }).legs[0].reason).toMatch(/catastrophic/);
    expect(sim(deep, { exitRules: { ...rules, stopConfirm: { seconds: 30, appliesTo: "both" } } }).legs.map((l) => l.type)).toEqual(["DATA_END"]);
  });

  it("fires the underwater time exit even when nothing trades for hours", () => {
    const r = sim([candle(0, 1, 1, 1, 1), candle(1, 0.95, 0.95, 0.95, 0.95), candle(60 * 30, 0.95, 0.95, 0.95, 0.95)], {
      exitRules: { ...rules, maxHoldMinutes: 60 },
    });
    expect(r.legs[0].type).toBe("TIME_EXIT");
    expect(r.legs[0].ts).toBe(T0 + 60 + 60 * 60);
  });

  it("holds a manual buy-and-hold through a -40% drawdown", () => {
    const r = sim(flat([1, 0.7, 0.6, 0.9]), { meta: { ...meta, qualificationPath: "MANUAL_BUY_AND_HOLD" } });
    expect(r.legs.map((l) => l.type)).toEqual(["DATA_END"]);
    expect(r.troughMultiple).toBeCloseTo(0.6);
  });

  it("sells a manual hold once liquidity has halved (price down ~75% on a full-range pool)", () => {
    const r = sim(flat([1, 0.5, 0.3, 0.2, 0.1]), {
      meta: { ...meta, qualificationPath: "MANUAL_BUY_AND_HOLD", liquidityUsdAtDecision: 20_000 },
    });
    expect(r.legs[0].type).toBe("RISK_EXIT");
    expect(r.legs[0].reason).toMatch(/liquidity dropped/);
    expect(r.legs[0].mid).toBeCloseTo(0.2);
  });

  it("measures stops from the first mark, so the round-trip cost alone doesn't stop it out", () => {
    const costly: ChainCostModel = { entrySlippagePct: 5, exitSlippagePct: 5, gasBuyUsd: 0, gasSellUsd: 0 };
    // A -9% market move, marked through ~10% of costs, is a ~-18% P&L but only -9% from the first mark.
    const r = sim(flat([1, 0.95, 0.91, 0.93]), { costs: costly });
    expect(r.legs.map((l) => l.type)).toEqual(["DATA_END"]);
  });

  it("ignores candles after the hold window (no lookahead past it)", () => {
    const base = flat([1, 1.1, 1.05]);
    const withFuture = [...base, ...flat([0.1, 0.1], T0 + 10 * 3_600)];
    const a = sim(base, { holdWindowS: 3_600, coverageEnd: T0 + 20 * 3_600 });
    const b = sim(withFuture, { holdWindowS: 3_600, coverageEnd: T0 + 20 * 3_600 });
    expect(b.legs).toEqual(a.legs);
    expect(a.legs[0].type).toBe("WINDOW_END");
  });

  it("uses the fast-flip profile for a low-quality candidate", () => {
    const withFastFlip: ExitRules = {
      ...rules,
      fastFlip: {
        qualityScoreThreshold: 65,
        largeMcapUsd: 2_000_000,
        veryGoodQualityScoreThreshold: 80,
        profitSteps: [],
        trailingActivationMultiple: 1.2,
        trailingPercent: 12,
        maxHoldMinutes: 60,
      },
    };
    const r = sim(flat([1, 1.3, 1.1]), { exitRules: withFastFlip, meta: { ...meta, qualityScore: 50 } });
    expect(r.tier).toBe("FAST_FLIP");
    expect(r.legs[0].type).toBe("TRAILING_EXIT");
  });
});

describe("resolveTierPure", () => {
  const withTiers: ExitRules = {
    ...rules,
    fastFlip: {
      qualityScoreThreshold: 65,
      largeMcapUsd: 2_000_000,
      veryGoodQualityScoreThreshold: 80,
      profitSteps: [],
      trailingActivationMultiple: 1.2,
      trailingPercent: 12,
      maxHoldMinutes: 60,
    },
    goodProject: { minSocialScoreToQualify: 60, maxHoldMinutes: 525_600 },
  };
  it("matches positionManager's tiers", () => {
    expect(resolveTierPure(withTiers, { qualityScore: 50, entryMcap: 50_000, socialScore: 90 }).tier).toBe("FAST_FLIP");
    expect(resolveTierPure(withTiers, { qualityScore: 70, entryMcap: 3_000_000, socialScore: 90 }).tier).toBe("FAST_FLIP");
    expect(resolveTierPure(withTiers, { qualityScore: 85, entryMcap: 3_000_000, socialScore: 90 }).tier).toBe("GOOD_PROJECT");
    expect(resolveTierPure(withTiers, { qualityScore: 70, entryMcap: 50_000, socialScore: null }).tier).toBe("BASE");
    // Missing quality isn't low quality.
    expect(resolveTierPure(withTiers, { qualityScore: null, entryMcap: 50_000, socialScore: null }).tier).toBe("BASE");
  });
});

describe("valueAtSize", () => {
  it("charges slippage, constant-product impact and gas per swap", () => {
    const costs: ChainCostModel = { entrySlippagePct: 2, exitSlippagePct: 3, gasBuyUsd: 0.05, gasSellUsd: 0.03 };
    const r = sim(flat([1, 1, 1]), { costs, meta: { ...meta, liquidityUsdAtDecision: 10_000 } });
    const v = valueAtSize(r, 100, costs);
    // Buy: 1 * (1 + 2% + 100/5000) = 1.04. Sell $96.15 worth: 3% + (1 - 1/(1 + 96.15/5000)).
    const tokens = 100 / 1.04;
    const sellPct = 3 + (1 - 1 / (1 + tokens / 5000)) * 100;
    expect(v.proceedsUsd).toBeCloseTo(tokens * (1 - sellPct / 100), 6);
    expect(v.gasUsd).toBeCloseTo(0.08);
    expect(v.netUsd).toBeCloseTo(v.proceedsUsd - 100 - 0.08, 6);
  });
});

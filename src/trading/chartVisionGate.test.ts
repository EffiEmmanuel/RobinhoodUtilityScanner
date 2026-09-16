import { describe, it, expect, afterEach } from "vitest";
import { tradingConfig } from "./config";
import { decideGateOutcome, buildChartSvg, type ChartPoint } from "./chartVisionGate";
import type { ChartVisionVerdict } from "../ai/schemas";

function verdict(overrides: Partial<ChartVisionVerdict> = {}): ChartVisionVerdict {
  return { verdict: "RETRACEMENT_IN_UPTREND", confidence: 0.9, reasoning: "higher-low structure intact", ...overrides };
}

describe("decideGateOutcome", () => {
  it("falls through (does not defer) when no verdict is available", () => {
    const result = decideGateOutcome(undefined, 0);
    expect(result.defer).toBe(false);
  });

  it("defers on a confident RETRACEMENT_IN_UPTREND verdict", () => {
    const result = decideGateOutcome(verdict({ confidence: 0.9 }), 0);
    expect(result.defer).toBe(true);
  });

  it("does not defer on a TREND_REVERSAL verdict, however confident", () => {
    const result = decideGateOutcome(verdict({ verdict: "TREND_REVERSAL", confidence: 0.99 }), 0);
    expect(result.defer).toBe(false);
  });

  it("does not defer below the confidence threshold", () => {
    const result = decideGateOutcome(verdict({ confidence: tradingConfig.chartVisionMinConfidenceToDefer - 0.01 }), 0);
    expect(result.defer).toBe(false);
  });

  it("defers right at the confidence threshold", () => {
    const result = decideGateOutcome(verdict({ confidence: tradingConfig.chartVisionMinConfidenceToDefer }), 0);
    expect(result.defer).toBe(true);
  });

  it("stops deferring once the consecutive-defer cap is reached, even on a confident retracement verdict", () => {
    const result = decideGateOutcome(verdict({ confidence: 0.99 }), tradingConfig.chartVisionMaxConsecutiveDefers);
    expect(result.defer).toBe(false);
  });

  it("still allows a defer one tick below the cap", () => {
    const result = decideGateOutcome(verdict({ confidence: 0.99 }), tradingConfig.chartVisionMaxConsecutiveDefers - 1);
    expect(result.defer).toBe(true);
  });

  describe("buildChartSvg", () => {
    // Rendered from this trade's own PositionSnapshot history instead of a
    // DexScreener screenshot (measured live 2026-09-16 at ~9-11s and
    // sometimes still incomplete by then) — these just check the pure
    // render step produces sane, valid SVG, not that sharp rasterizes it
    // correctly (verified manually against a real Gemini vision call).
    function points(prices: number[]): ChartPoint[] {
      const now = Date.now();
      return prices.map((priceUsd, i) => ({ capturedAt: new Date(now - (prices.length - i) * 60_000), priceUsd, volume5m: 1000 }));
    }

    it("produces a well-formed SVG document", () => {
      const svg = buildChartSvg(points([1, 1.2, 1.5, 1.3]));
      expect(svg).toContain("<svg");
      expect(svg).toContain("</svg>");
    });

    it("does not throw on a single data point (avoids a division by zero)", () => {
      expect(() => buildChartSvg(points([1.5]))).not.toThrow();
    });

    it("does not throw when every price is identical (zero range)", () => {
      expect(() => buildChartSvg(points([1, 1, 1, 1]))).not.toThrow();
    });
  });

  describe("config sensitivity", () => {
    const originalCap = tradingConfig.chartVisionMaxConsecutiveDefers;
    afterEach(() => {
      tradingConfig.chartVisionMaxConsecutiveDefers = originalCap;
    });

    it("respects a lowered consecutive-defer cap", () => {
      tradingConfig.chartVisionMaxConsecutiveDefers = 0;
      const result = decideGateOutcome(verdict({ confidence: 0.99 }), 0);
      expect(result.defer).toBe(false);
    });
  });
});

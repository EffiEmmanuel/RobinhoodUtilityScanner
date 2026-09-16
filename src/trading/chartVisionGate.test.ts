import { describe, it, expect, afterEach } from "vitest";
import { tradingConfig } from "./config";
import { decideGateOutcome } from "./chartVisionGate";
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

import { describe, it, expect } from "vitest";
import { evaluateHolderConcentration, type HolderSnapshot, type HolderConcentrationThresholds } from "./holderConcentration";

describe("evaluateHolderConcentration", () => {
  const thresholds: HolderConcentrationThresholds = { maxTop1HolderPercent: 15, maxTop10HolderPercent: 50, minHolderCount: 15 };

  const snapshot = (overrides: Partial<HolderSnapshot>): HolderSnapshot => ({
    totalSupply: 1_000_000n,
    top1Percent: 5,
    top10Percent: 20,
    holderCount: 40,
    logScanComplete: true,
    ...overrides,
  });

  it("passes a well-distributed token", () => {
    expect(evaluateHolderConcentration(snapshot({}), thresholds).passed).toBe(true);
  });

  it("fails with no snapshot at all (RPC/infra failure)", () => {
    const result = evaluateHolderConcentration(undefined, thresholds);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toEqual(["holderData"]);
  });

  it("blocks a single wallet holding enough supply to tank price alone", () => {
    const result = evaluateHolderConcentration(snapshot({ top1Percent: 40 }), thresholds);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain("top1Holder");
  });

  it("blocks the top 10 holders controlling most of supply", () => {
    const result = evaluateHolderConcentration(snapshot({ top10Percent: 70 }), thresholds);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain("top10Holders");
  });

  it("blocks too few distinct holders even if concentration percentages look fine", () => {
    const result = evaluateHolderConcentration(snapshot({ holderCount: 3, top1Percent: 10, top10Percent: 30 }), thresholds);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain("holderCount");
  });
});

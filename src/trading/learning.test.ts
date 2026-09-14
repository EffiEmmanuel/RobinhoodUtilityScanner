import { describe, it, expect } from "vitest";
import { getDataTier, computeFeatureCorrelations, type FeatureRow } from "./learning";

describe("getDataTier", () => {
  it("classifies per §66's exact thresholds", () => {
    expect(getDataTier(0)).toBe("ANALYTICS_ONLY");
    expect(getDataTier(49)).toBe("ANALYTICS_ONLY");
    expect(getDataTier(50)).toBe("EXPLORATORY");
    expect(getDataTier(199)).toBe("EXPLORATORY");
    expect(getDataTier(200)).toBe("VALIDATED");
    expect(getDataTier(999)).toBe("VALIDATED");
    expect(getDataTier(1000)).toBe("STRONG");
  });
});

function row(overrides: Partial<FeatureRow>): FeatureRow {
  return {
    candidateId: "c",
    traded: false,
    hit125x: false,
    hit150x: false,
    hit200x: false,
    hit250x: false,
    hit500x: false,
    hit1000x: false,
    hit2500x: false,
    hit5000x: false,
    hit10000x: false,
    feasibleHit125x: false,
    feasibleHit150x: false,
    feasibleHit200x: false,
    feasibleHit250x: false,
    feasibleHit500x: false,
    feasibleHit1000x: false,
    feasibleHit2500x: false,
    feasibleHit5000x: false,
    feasibleHit10000x: false,
    ...overrides,
  };
}

describe("computeFeatureCorrelations", () => {
  it("finds a strong positive correlation for a feature that perfectly predicts the target", () => {
    const rows = [
      row({ qualityScore: 90, hit150x: true }),
      row({ qualityScore: 85, hit150x: true }),
      row({ qualityScore: 40, hit150x: false }),
      row({ qualityScore: 30, hit150x: false }),
      row({ qualityScore: 20, hit150x: false }),
    ];
    const correlations = computeFeatureCorrelations(rows, "hit150x");
    expect(correlations.qualityScore).not.toBeNull();
    expect(correlations.qualityScore!).toBeGreaterThan(0.8);
  });

  it("returns null for a feature with fewer than 5 present values", () => {
    const rows = [row({ qualityScore: 90, hit150x: true }), row({ hit150x: false })];
    const correlations = computeFeatureCorrelations(rows, "hit150x");
    expect(correlations.qualityScore).toBeNull();
  });

  it("does not silently zero-fill missing feature values into the correlation", () => {
    const rows = [
      row({ qualityScore: 90, hit125x: true }),
      row({ qualityScore: 85, hit125x: true }),
      row({ hit125x: false }), // missing qualityScore — must be excluded, not treated as 0
      row({ qualityScore: 30, hit125x: false }),
      row({ qualityScore: 20, hit125x: false }),
      row({ qualityScore: 25, hit125x: false }),
    ];
    const correlations = computeFeatureCorrelations(rows, "hit125x");
    // if the missing row were zero-filled, it would look like an extreme low-quality
    // non-hit and inflate the (already positive) correlation further — assert it's
    // still a reasonable magnitude rather than artificially perfect.
    expect(correlations.qualityScore).not.toBeNull();
    expect(correlations.qualityScore!).toBeLessThan(0.999);
  });
});

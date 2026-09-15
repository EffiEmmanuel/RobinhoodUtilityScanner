import { describe, expect, it } from "vitest";
import { shouldRetryPlanningForTransientMomentumMarket } from "./planning";

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

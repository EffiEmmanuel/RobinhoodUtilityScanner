import { describe, expect, it } from "vitest";
import { canBypassUtilityGateForMomentum } from "./utilityGate";

describe("canBypassUtilityGateForMomentum", () => {
  it("allows an eligible momentum override through the utility gate", () => {
    const result = canBypassUtilityGateForMomentum({
      qualificationPath: "MOMENTUM_OVERRIDE",
      evaluation: {
        eligible: true,
        riskBucket: "HIGH",
        reasons: ["momentum override: 535 txns/1h, $65,815 liquidity despite qualityScore 43.1 < 65"],
      },
    });

    expect(result).toBe(true);
  });

  it("does not bypass utility evidence for a normal eligible candidate", () => {
    const result = canBypassUtilityGateForMomentum({
      qualificationPath: "NORMAL",
      evaluation: {
        eligible: true,
        riskBucket: "MEDIUM",
        reasons: ["cleared all trade-eligibility gates"],
      },
    });

    expect(result).toBe(false);
  });

  it("does not revive a rejected candidate", () => {
    const result = canBypassUtilityGateForMomentum({
      qualificationPath: "MOMENTUM_OVERRIDE",
      evaluation: {
        eligible: false,
        riskBucket: "REJECT",
        reasons: ["liquidityUsd 9000 < 15000"],
      },
    });

    expect(result).toBe(false);
  });
});

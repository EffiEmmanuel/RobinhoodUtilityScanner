import { describe, it, expect, vi } from "vitest";

vi.mock("../src/db", () => ({ db: {} }));

import { buildV19ExitRules } from "./create-strategy-v1_9";
import type { ExitRules } from "../src/trading/strategy";

// v1.8-good-project-unlimited-hold's exitRules as stored in production (read 2026-09-25).
const v18: ExitRules = {
  fastFlip: {
    profitSteps: [
      { multiple: 1.5, sellPercentOfRemaining: 50 },
      { multiple: 2, sellPercentOfRemaining: 40 },
    ],
    largeMcapUsd: 2_000_000,
    maxHoldMinutes: 60,
    trailingPercent: 12,
    qualityScoreThreshold: 65,
    trailingActivationMultiple: 1.2,
    veryGoodQualityScoreThreshold: 80,
  },
  goodProject: { maxHoldMinutes: 525_600, minSocialScoreToQualify: 60 },
  profitSteps: [
    { multiple: 2, sellPercentOfRemaining: 50 },
    { multiple: 2.5, sellPercentOfRemaining: 30 },
  ],
  maxHoldMinutes: 1440,
  maxLossPercent: 15,
  trailRemaining: true,
  trailingPercent: 20,
  catastrophicLossPercent: 25,
  trailingActivationMultiple: 1.6,
};

describe("buildV19ExitRules", () => {
  const v19 = buildV19ExitRules(v18);

  it("adds the 2x cost recovery with a 45% runner trail", () => {
    expect(v19.costRecovery).toEqual({ triggerMultiple: 2, sellCostBufferPercent: 3, moonbagTrailingPercent: 45 });
  });

  it("drops fastFlip's early trail and steps but keeps the tier and its time exit", () => {
    expect(v19.fastFlip).toEqual({ qualityScoreThreshold: 65, largeMcapUsd: 2_000_000, veryGoodQualityScoreThreshold: 80, maxHoldMinutes: 60 });
  });

  it("leaves the loss stops, base trail and good-project hold as they were", () => {
    const { fastFlip: _a, costRecovery: _b, ...rest } = v19;
    const { fastFlip: _c, ...parentRest } = v18;
    expect(rest).toEqual(parentRest);
  });
});

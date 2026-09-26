import { describe, it, expect, vi } from "vitest";

vi.mock("../src/db", () => ({ db: {} }));

import { buildV110ExitRules } from "./create-strategy-v1_10";
import type { ExitRules } from "../src/trading/strategy";

// v1.8's stop settings as stored in production.
const v18 = {
  profitSteps: [],
  trailRemaining: true,
  trailingActivationMultiple: 1.6,
  trailingPercent: 20,
  maxLossPercent: 15,
  catastrophicLossPercent: 25,
  maxHoldMinutes: 1440,
} as ExitRules;

describe("buildV110ExitRules", () => {
  const versions = buildV110ExitRules(v18);

  it("adds 15s variants of s1 and s3", () => {
    expect(Object.keys(versions)).toEqual([
      "v1.10-confirm-s1",
      "v1.10-confirm-s2",
      "v1.10-confirm-s3",
      "v1.10-confirm-s1-15s",
      "v1.10-confirm-s3-15s",
    ]);
    expect(versions["v1.10-confirm-s1-15s"]).toEqual({ ...v18, stopConfirm: { seconds: 15, appliesTo: "maxLoss" } });
    expect(versions["v1.10-confirm-s3-15s"]).toEqual({ ...v18, stopConfirm: { seconds: 15, appliesTo: "both" } });
  });

  it("builds the three B5 candidates and changes nothing else", () => {
    expect(versions["v1.10-confirm-s1"]).toEqual({ ...v18, stopConfirm: { seconds: 30, appliesTo: "maxLoss" } });
    expect(versions["v1.10-confirm-s2"]).toEqual({ ...v18, stopConfirm: { seconds: 30, appliesTo: "maxLoss" }, catastrophicLossPercent: 40 });
    expect(versions["v1.10-confirm-s3"]).toEqual({ ...v18, stopConfirm: { seconds: 30, appliesTo: "both" } });
  });
});

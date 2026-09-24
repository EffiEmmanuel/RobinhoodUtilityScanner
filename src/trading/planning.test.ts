import { describe, expect, it } from "vitest";
import { liquidityWaitDecision, tacticalScoutActionForWatchOnly } from "./planning";
import type { CandidateRiskResult } from "./riskEngine";
import { tradingConfig } from "./config";
import { TradePlanAction } from "../generated/prisma";

// User directive 2026-09-24 (MUSETOWN: researched with $0.69 in a pool that
// had just opened, permanently rejected, then ran 63x) — a candidate held
// back only by pool depth waits for liquidity instead of being rejected.
describe("liquidityWaitDecision", () => {
  const liquidityOnly: CandidateRiskResult = {
    eligible: false,
    riskBucket: "REJECT",
    reasons: ["liquidityUsd 1 < 8000"],
    failedChecks: ["liquidity"],
  };
  const createdAt = new Date("2026-09-24T00:00:00Z");
  const hoursLater = (h: number) => new Date(createdAt.getTime() + h * 3_600_000);

  it("waits when pool depth is the only thing failing", () => {
    expect(
      liquidityWaitDecision({ evaluation: liquidityOnly, utilityGatePassed: true, isFirstPlan: true, candidateCreatedAt: createdAt, now: hoursLater(1) })
    ).toBe("WAIT");
  });

  it("gives up once the wait window has passed", () => {
    expect(
      liquidityWaitDecision({
        evaluation: liquidityOnly,
        utilityGatePassed: true,
        isFirstPlan: true,
        candidateCreatedAt: createdAt,
        now: hoursLater(tradingConfig.liquidityWaitMaxHours),
      })
    ).toBe("GIVE_UP");
  });

  it("does not wait when anything besides liquidity failed", () => {
    const alsoLowQuality: CandidateRiskResult = { ...liquidityOnly, failedChecks: ["quality", "liquidity"] };
    expect(
      liquidityWaitDecision({ evaluation: alsoLowQuality, utilityGatePassed: true, isFirstPlan: true, candidateCreatedAt: createdAt, now: hoursLater(1) })
    ).toBe("NOT_APPLICABLE");
    expect(
      liquidityWaitDecision({ evaluation: liquidityOnly, utilityGatePassed: false, isFirstPlan: true, candidateCreatedAt: createdAt, now: hoursLater(1) })
    ).toBe("NOT_APPLICABLE");
  });

  it("does not wait on a replan — liquidity collapsing on a watched candidate still rejects", () => {
    expect(
      liquidityWaitDecision({ evaluation: liquidityOnly, utilityGatePassed: true, isFirstPlan: false, candidateCreatedAt: createdAt, now: hoursLater(1) })
    ).toBe("NOT_APPLICABLE");
  });
});

describe("tacticalScoutActionForWatchOnly", () => {
  // 2026-09-22: these used to pass qualificationPath: "MOMENTUM_OVERRIDE" —
  // a value planCandidate stopped ever setting on 2026-09-18 (hardcoded to
  // "NORMAL" for every candidate post-utility-pivot), which meant these
  // tests were exercising a gate the real call site could never satisfy —
  // the function was silently dead in production while these all still
  // passed. tradeLane alone is the real (and correct) gate now.
  it("turns a MULTI-style watch-only call into BUY_NOW when current price is already inside the AI zone", () => {
    const result = tacticalScoutActionForWatchOnly({
      action: TradePlanAction.WATCH_ONLY,
      tradeLane: "MOMENTUM_TACTICAL",
      currentMcap: 41_099,
      targetEntryMcapMin: 28_000,
      targetEntryMcapMax: 42_000,
      pair: {
        liquidityUsd: 18_965,
        volume1h: 126_050,
        buys1h: 816,
        sells1h: 636,
      },
    });

    expect(result).toBe(TradePlanAction.BUY_NOW);
  });

  it("turns a momentum watch-only call into WAIT_FOR_ENTRY when the actionable zone is below current price", () => {
    const result = tacticalScoutActionForWatchOnly({
      action: TradePlanAction.WATCH_ONLY,
      tradeLane: "MOMENTUM_TACTICAL",
      currentMcap: 134_329,
      targetEntryMcapMin: 60_000,
      targetEntryMcapMax: 110_000,
      pair: {
        liquidityUsd: 33_985,
        volume1h: 238_262,
        buys1h: 1_369,
        sells1h: 1_216,
      },
    });

    expect(result).toBe(TradePlanAction.WAIT_FOR_ENTRY);
  });

  it("does not override watch-only when the activity looks like wash trading", () => {
    const result = tacticalScoutActionForWatchOnly({
      action: TradePlanAction.WATCH_ONLY,
      tradeLane: "MOMENTUM_TACTICAL",
      currentMcap: 41_099,
      targetEntryMcapMin: 28_000,
      targetEntryMcapMax: 42_000,
      pair: {
        liquidityUsd: 18_965,
        volume1h: 250_000,
        buys1h: 816,
        sells1h: 636,
      },
    });

    expect(result).toBeUndefined();
  });

  it("does not override non-momentum watch-only decisions", () => {
    const result = tacticalScoutActionForWatchOnly({
      action: TradePlanAction.WATCH_ONLY,
      tradeLane: "VERIFIED_PROJECT",
      currentMcap: 41_099,
      targetEntryMcapMin: 28_000,
      targetEntryMcapMax: 42_000,
      pair: {
        liquidityUsd: 18_965,
        volume1h: 126_050,
        buys1h: 816,
        sells1h: 636,
      },
    });

    expect(result).toBeUndefined();
  });
});

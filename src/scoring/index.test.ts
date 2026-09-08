import { describe, it, expect } from "vitest";
import { computeScore, computeHardRejections, scoreBandFor, WEIGHTS } from "./index";
import type { ResearchSynthesis } from "../ai/schemas";
import type { OnchainResearchResult } from "../research/onchain";

function baseSynthesis(overrides: Partial<ResearchSynthesis> = {}): ResearchSynthesis {
  return {
    projectSummary: "A test project",
    utilityClass: "INFRASTRUCTURE",
    productExists: true,
    productPredatesToken: "UNKNOWN",
    utility: { score: 80, confidence: "HIGH", reasoning: "" },
    credibility: { score: 70, confidence: "MEDIUM", reasoning: "" },
    website: { score: 75, confidence: "HIGH", reasoning: "" },
    social: { score: 60, confidence: "LOW", reasoning: "" },
    team: { score: 65, confidence: "LOW", reasoning: "" },
    positives: ["existing product"],
    risks: ["low liquidity"],
    redFlags: [],
    impersonationSuspected: false,
    ...overrides,
  };
}

function safeOnchain(overrides: Partial<OnchainResearchResult> = {}): OnchainResearchResult {
  return {
    status: "SUCCESS",
    isContract: "PASS",
    ownerRenounced: "PASS",
    mintCapability: "PASS",
    pauseCapability: "PASS",
    blacklistCapability: "PASS",
    feeControlCapability: "PASS",
    verifiedSource: "PASS",
    flags: [],
    ...overrides,
  };
}

describe("scoreBandFor", () => {
  it("maps boundaries correctly", () => {
    expect(scoreBandFor(85)).toBe("HIGH_CONVICTION_CANDIDATE");
    expect(scoreBandFor(84.9)).toBe("STRONG_WATCH");
    expect(scoreBandFor(75)).toBe("STRONG_WATCH");
    expect(scoreBandFor(65)).toBe("WATCH");
    expect(scoreBandFor(50)).toBe("LOW_QUALITY");
    expect(scoreBandFor(49.9)).toBe("REJECT");
  });
});

describe("WEIGHTS", () => {
  it("sums to 1", () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });
});

describe("computeHardRejections", () => {
  it("hard-rejects mint capability held by a non-renounced owner", () => {
    const reasons = computeHardRejections(
      safeOnchain({ ownerRenounced: "FAIL", mintCapability: "FAIL" }),
      baseSynthesis()
    );
    expect(reasons.some((r) => r.includes("mint capability"))).toBe(true);
  });

  it("does not hard-reject mint capability when owner is renounced", () => {
    const reasons = computeHardRejections(
      safeOnchain({ ownerRenounced: "PASS", mintCapability: "FAIL" }),
      baseSynthesis()
    );
    expect(reasons.some((r) => r.includes("mint capability"))).toBe(false);
  });

  it("hard-rejects when no bytecode exists at the address", () => {
    const reasons = computeHardRejections(safeOnchain({ isContract: "FAIL" }), baseSynthesis());
    expect(reasons.some((r) => r.includes("No contract bytecode"))).toBe(true);
  });

  it("hard-rejects suspected impersonation regardless of on-chain safety", () => {
    const reasons = computeHardRejections(safeOnchain(), baseSynthesis({ impersonationSuspected: true }));
    expect(reasons.some((r) => r.includes("impersonate"))).toBe(true);
  });
});

describe("computeScore", () => {
  it("produces a final score in range and is deterministic for identical inputs", () => {
    const inputs = {
      classification: { brandingQuality: 0.8, reasoningSummary: ["clean branding"] },
      synthesis: baseSynthesis(),
      onchain: safeOnchain(),
      market: {
        pairs: [],
        primaryPair: {
          dexId: "test-dex",
          pairAddress: "0xpair",
          url: "https://dexscreener.com/robinhood/0xpair",
          liquidityUsd: 30000,
          marketCapUsd: 300000,
          volume1h: 5000,
          buys1h: 40,
          sells1h: 10,
          websites: [],
          socials: [],
        },
      },
    };
    const a = computeScore(inputs);
    const b = computeScore(inputs);
    expect(a.finalScore).toBe(b.finalScore);
    expect(a.finalScore).toBeGreaterThanOrEqual(0);
    expect(a.finalScore).toBeLessThanOrEqual(100);
    expect(a.hardReject).toBe(false);
  });

  it("forces hardReject=true through even with a high raw score", () => {
    const inputs = {
      classification: { brandingQuality: 0.9, reasoningSummary: [] },
      synthesis: baseSynthesis({
        utility: { score: 95, confidence: "HIGH", reasoning: "" },
        impersonationSuspected: true,
      }),
      onchain: safeOnchain(),
      market: { pairs: [] as never[] },
    };
    const result = computeScore(inputs);
    expect(result.hardReject).toBe(true);
  });
});

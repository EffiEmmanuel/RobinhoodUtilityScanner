import { describe, expect, it } from "vitest";
import { classifyBlock } from "./gateAudit";

const d = (stage: string, decision: string, reasons: unknown[]) => ({ stage, decision, reasons });

describe("classifyBlock", () => {
  it("reads the kill switch and safety gates as report-only buckets", () => {
    expect(classifyBlock("REJECTED", d("entry_revalidation", "SKIP", ["autonomous entries are off on solana (AUTONOMOUS_ENTRY_CHAINS=none)"]))).toEqual({ gate: "autonomous entries off", kind: "kill switch" });
    expect(classifyBlock("REJECTED", d("candidate_eligibility", "SKIP", ["utility class is MEME — not risking capital on meme/unknown tokens"])).kind).toBe("safety");
    expect(classifyBlock("REJECTED", d("planning", "SKIP", ["no route executes our minimum position within limits right now"])).kind).toBe("safety");
  });
  it("skips informational lines and finds the blocking gate", () => {
    expect(classifyBlock("REJECTED", d("planning", "SKIP", ["cleared all trade-eligibility gates", "not verified-project grade: contractScore 50 < 80", "liquidity is 4% of market cap (outside 10-60%)"])).gate).toBe("market / entry filter");
    expect(classifyBlock("REJECTED", d("planning", "SKIP", ["cleared all trade-eligibility gates", "liquidityUsd 900 < 5000"])).gate).toBe("liquidity floor");
    expect(classifyBlock("REJECTED", d("candidate_eligibility", "SKIP", ["utilityScore 40 < 55"])).gate).toBe("research / utility thresholds");
  });
  it("attributes a planning SKIP with only informational lines to the AI planner", () => {
    expect(classifyBlock("REJECTED", d("planning", "SKIP", ["cleared all trade-eligibility gates", "cleared utility-only trading gate", "not verified-project grade: qualityScore 67 < 70", ["AI reasoning"]])).gate).toBe("AI planner: REJECT_TRADE");
  });
  it("marks traded candidates as passed", () => {
    expect(classifyBlock("TRADED", undefined).gate).toBe("passed: traded live");
  });
});

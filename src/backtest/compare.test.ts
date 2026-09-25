import { describe, expect, it } from "vitest";
import { pairRows, peakBucket, summarizeByPeak, summarizePairs } from "./compare";
import type { RunRow } from "./run";
import type { SimResult } from "./simulate";
import { bracketRule, flatRule, sizingSweep, userBrackets } from "./sizing";
import type { UniverseCandidate } from "./universe";

const T0 = 1_790_000_000;

function row(id: string, netPct: number, pathPeak?: number, skip?: string): RunRow {
  const candidate = { candidateId: id, symbol: id, chain: "solana", trades: [] } as unknown as UniverseCandidate;
  if (skip) return { candidate, chain: "solana", skip };
  return {
    candidate,
    chain: "solana",
    pathPeak,
    sim: { exitReason: `exit ${id}` } as SimResult,
    valued: { sizeUsd: 10, proceedsUsd: 10 + netPct / 10, gasUsd: 0, netUsd: netPct / 10, netPct, grossPct: netPct, legs: [] },
  };
}

describe("paired comparison", () => {
  it("buckets by the token's own path peak", () => {
    expect(peakBucket(undefined)).toBe("<2x");
    expect(peakBucket(1.99)).toBe("<2x");
    expect(peakBucket(2)).toBe("2-4x");
    expect(peakBucket(4)).toBe(">=4x");
  });

  it("pairs only trades both configs simulated, and shows both sides of the difference", () => {
    const a = [row("x", -15, 1.1), row("y", 30, 2.5), row("z", 50, 6), row("s", 0, 1, "no candles")];
    const b = [row("x", -15, 1.1), row("y", 10, 2.5), row("z", 200, 6), row("s", 0, 1)];
    const pairs = pairRows(a, b);
    expect(pairs.map((p) => p.candidateId)).toEqual(["x", "y", "z"]);
    const all = summarizePairs("all", pairs);
    expect(all.diffMeanPct).toBeCloseTo((0 - 20 + 150) / 3);
    expect([all.bBetter, all.bWorse]).toEqual([1, 1]);
    expect(all.gainedPct).toBe(150);
    expect(all.gaveBackPct).toBe(-20);
    expect(all.bTotalUsd - all.aTotalUsd).toBeCloseTo(13);
    const byPeak = summarizeByPeak(pairs);
    expect(byPeak.map((x) => [x.group, x.n])).toEqual([
      ["all", 3],
      ["peak <2x", 1],
      ["peak 2-4x", 1],
      ["peak >=4x", 1],
    ]);
  });
});

describe("sizing sweep", () => {
  it("sizes by equity bracket", () => {
    const rule = userBrackets(40);
    expect(rule.fraction(21)).toBe(0.4);
    expect(rule.fraction(50)).toBe(0.3);
    expect(rule.fraction(300)).toBe(0.15);
    expect(rule.fraction(1_000)).toBe(0.075);
    expect(rule.fraction(10_000)).toBe(0.05);
    expect(userBrackets(20).fraction(21)).toBe(0.2);
    expect(bracketRule("x", [{ belowUsd: 10, pct: 50 }], 1).fraction(5)).toBe(0.5);
  });

  const noCosts = { entrySlippagePct: 0, exitSlippagePct: 0, gasBuyUsd: 0, gasSellUsd: 0 };
  const simAt = (exitMid: number): SimResult => ({
    entryTs: T0,
    entryMid: 1,
    entryFill: 1,
    entryLiquidityUsd: undefined,
    tier: "BASE",
    legs: [{ ts: T0 + 60, fraction: 1, mid: exitMid, liquidityUsd: undefined, type: "X", reason: "" }],
    peakMultiple: exitMid,
    troughMultiple: exitMid,
    exitReason: "",
    holdMinutes: 1,
  });

  it("compounds a fixed edge exactly when every draw is the same trade", () => {
    const res = sizingSweep([{ sim: simAt(1.1), costs: noCosts }], flatRule(10), { startUsd: 21, trades: 100, checkpoint: 50, paths: 20, reachUsd: 50 });
    expect(res.medianAtCheckpoint).toBeCloseTo(21 * 1.01 ** 50, 6);
    expect(res.medianAtEnd).toBeCloseTo(21 * 1.01 ** 100, 6);
    expect(res.pReach).toBe(1);
    expect(res.pRuin).toBe(0);
  });

  it("counts ruin, and gas makes tiny accounts bleed even on flat trades", () => {
    // -50% at 40% size costs 20% of equity a trade: 0.8^20 is ~1% of the start.
    const losing = sizingSweep([{ sim: simAt(0.5), costs: noCosts }], flatRule(40), { startUsd: 21, trades: 20, checkpoint: 5, paths: 5, reachUsd: 100 });
    expect(losing.pRuin).toBe(1);
    expect(losing.pBelowHalf).toBe(1);
    const gas = { ...noCosts, gasBuyUsd: 0.05, gasSellUsd: 0.05 };
    const flat = sizingSweep([{ sim: simAt(1), costs: gas }], flatRule(5), { startUsd: 21, trades: 100, checkpoint: 50, paths: 3, reachUsd: 100 });
    expect(flat.medianAtEnd).toBeCloseTo(21 - 100 * 0.1, 6);
  });
});

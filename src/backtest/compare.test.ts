import { describe, expect, it } from "vitest";
import { decideGrid, launchVenue, passesEntryFilter, type PairSummary, pairRows, peakBucket, summarizeByPeak, summarizeByVenue, summarizePairs } from "./compare";
import type { RunRow } from "./run";
import type { SimResult } from "./simulate";
import { bracketRule, flatRule, sizingSweep, userBrackets } from "./sizing";
import type { UniverseCandidate } from "./universe";

const T0 = 1_790_000_000;

function row(id: string, netPct: number, pathPeak?: number, skip?: string): RunRow {
  const candidate = { candidateId: id, symbol: id, chain: "solana", tokenAddress: id === "z" ? "Zpump" : id, pair: { pairAddress: "p", dexId: "raydium" }, trades: [] } as unknown as UniverseCandidate;
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

describe("launch venue", () => {
  it("counts graduated pump.fun mints as pump.fun wherever they trade now", () => {
    const c = (tokenAddress: string, dexId?: string, chain = "solana") => ({ chain, tokenAddress, pair: dexId ? { pairAddress: "p", dexId } : null });
    expect(launchVenue(c("AbcPump"))).toBe("unknown");
    expect(launchVenue(c("Abcpump", "raydium"))).toBe("pump.fun");
    expect(launchVenue(c("Abc", "pumpswap"))).toBe("pump.fun");
    expect(launchVenue(c("Abc", "raydium"))).toBe("raydium");
    expect(launchVenue(c("Abc", "meteoradbc"))).toBe("meteora");
    expect(launchVenue(c("0xpump", "uniswap", "robinhood"))).toBe("uniswap");
  });
  it("summarizes pairs per venue, biggest first", () => {
    const pairs = pairRows([row("x", 1), row("y", 2), row("z", 3)], [row("x", 2), row("y", 2), row("z", 1)]);
    expect(summarizeByVenue(pairs).map((s) => [s.group, s.n])).toEqual([
      ["venue raydium", 2],
      ["venue pump.fun", 1],
    ]);
  });
});

describe("pre-registered grid decision", () => {
  const sum = (diffMeanPct: number, ci: [number, number] = [diffMeanPct - 1, diffMeanPct + 1]) => ({ diffMeanPct, diffCI90: ci }) as PairSummary;
  const noClear = () => ({ primary: sum(1, [-1, 3]), secondary: sum(1, [-1, 3]) });

  it("keeps V0 when nothing is no-worse in the primary and loss-free in the secondary", () => {
    const d = decideGrid(
      [
        { name: "V1", primary: sum(-0.1), secondary: sum(5) },
        { name: "V2", primary: sum(2), secondary: sum(-0.5) },
      ],
      noClear
    );
    expect(d.winner).toBe("V0");
    expect(d.qualifiers).toEqual([]);
  });
  it("picks the simplest qualifier unless another beats it in both modes with CIs clear of 0", () => {
    const entries = [
      { name: "V1", primary: sum(0.5), secondary: sum(1) },
      { name: "V4", primary: sum(3), secondary: sum(4) },
    ];
    expect(decideGrid(entries, noClear).winner).toBe("V1");
    const clears = () => ({ primary: sum(2, [0.5, 3.5]), secondary: sum(3, [0.2, 6]) });
    expect(decideGrid(entries, clears).winner).toBe("V4");
    const oneMode = () => ({ primary: sum(2, [0.5, 3.5]), secondary: sum(3, [-0.2, 6]) });
    expect(decideGrid(entries, oneMode).winner).toBe("V1");
  });
});

describe("entry filters E1/E2", () => {
  const c = (tokenAddress: string, dexId: string, mcap: number | null) =>
    ({ chain: "solana", tokenAddress, pair: { pairAddress: "p", dexId, marketCapUsd: 1 }, outcome: { marketCapAtDetection: mcap } }) as unknown as UniverseCandidate;
  it("E1 drops only pump.fun launches detected at $50K or more", () => {
    expect(passesEntryFilter(c("Xpump", "pumpswap", 60_000), "E1")).toBe(false);
    expect(passesEntryFilter(c("Xpump", "pumpswap", 49_000), "E1")).toBe(true);
    expect(passesEntryFilter(c("X", "raydium", 5_000_000), "E1")).toBe(true);
  });
  it("E2 keeps only non-pump.fun launches", () => {
    expect(passesEntryFilter(c("Xpump", "raydium", 10_000), "E2")).toBe(false);
    expect(passesEntryFilter(c("X", "raydium", 10_000), "E2")).toBe(true);
    expect(passesEntryFilter(c("Xpump", "pumpswap", 10_000), "none")).toBe(true);
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

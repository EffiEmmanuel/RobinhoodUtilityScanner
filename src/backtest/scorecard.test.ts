import { describe, expect, it } from "vitest";
import type { PaperBookPosition } from "./fidelity";
import {
  classifyLoss,
  classifyWin,
  evidenceStage,
  maeFromBaseline,
  maeLadder,
  mfeLadder,
  outlierDependence,
  realizedDrawdown,
  type ScoredTrade,
  scoreTrade,
  segmentTable,
  stopFillGap,
  streaks,
  timeSplit,
} from "./scorecard";

const position: PaperBookPosition = {
  id: "pp1",
  strategyId: "s1",
  strategyName: "V0 all Solana",
  strategyVersionId: "v18",
  candidateId: "c1",
  status: "CLOSED",
  openedAt: 1_000,
  closedAt: 1_600,
  sizeUsd: 1,
  entryPriceUsd: 0.001,
  costBasisUsd: 1.01, // + $0.01 buy gas
  realizedPnlUsd: -0.23, // sold for $0.80 before $0.02 sell gas
  exitReason: "RISK_EXIT: loss -16.8% reached max tolerated loss",
  mfePercent: 3,
  maePercent: -21,
  gasUsd: 0.03,
  firstMarkPriceUsd: 0.00095, // first sell quote 5% under the fill
};

const t = (over: Partial<ScoredTrade>): ScoredTrade => ({
  id: "x",
  candidateId: "c",
  strategyName: "s",
  openedAt: 0,
  closedAt: 0,
  sizeUsd: 1,
  entryPriceUsd: null,
  firstMarkPriceUsd: null,
  netPct: 0,
  grossPct: 0,
  netUsd: 0,
  gasUsd: 0,
  mfePercent: null,
  maePercent: null,
  exitReason: "",
  liquidityUsd: null,
  qualityScore: null,
  ...over,
});

describe("paper scorecard", () => {
  it("scores net on cost basis and gross before all fill gas", () => {
    const s = scoreTrade(position)!;
    expect(s.netPct).toBeCloseTo((-0.23 / 1.01) * 100);
    expect(s.grossPct).toBeCloseTo(-20);
    expect(scoreTrade({ ...position, status: "OPEN" })).toBeNull();
  });

  it("measures how far past its trigger a stop filled, from the stop baseline", () => {
    // exit at 0.8x entry = 0.842x the 0.95x baseline: -15.8% vs a -16.8% trigger
    expect(stopFillGap(scoreTrade(position)!)).toEqual({ kind: "max-loss", age: "<1h", gapPts: expect.closeTo(1.0, 1) });
    expect(stopFillGap(t({ grossPct: -40, closedAt: 7200, exitReason: "RISK_EXIT: catastrophic loss -35.4%" }))).toEqual({
      kind: "catastrophic",
      age: ">=1h",
      gapPts: expect.closeTo(-4.6, 5),
    });
    expect(stopFillGap(t({ exitReason: "TRAILING_EXIT: retraced 20%" }))).toBeNull();
  });

  it("classifies losses by the most specific rule first", () => {
    expect(classifyLoss(t({ netPct: -100, exitReason: "WRITE_OFF: no sell route" }))).toBe("UNSELLABLE");
    expect(classifyLoss(t({ netPct: -60, mfePercent: 50 }))).toBe("CRASH");
    expect(classifyLoss(t({ netPct: -10, mfePercent: 25 }))).toBe("GAVE_BACK");
    expect(classifyLoss(t({ netPct: -1, grossPct: 1, mfePercent: 8 }))).toBe("COSTS_ONLY");
    expect(classifyLoss(t({ netPct: -20, grossPct: -18, mfePercent: 2 }))).toBe("NEVER_WORKED");
    expect(classifyLoss(t({ netPct: -20, grossPct: -18, mfePercent: 12 }))).toBe("FADED");
    expect(classifyLoss(t({ netPct: -20, grossPct: -18, mfePercent: null }))).toBe("NEVER_WORKED");
  });

  it("classifies wins", () => {
    expect(classifyWin(t({ netPct: 180, exitReason: "TRAILING_EXIT: x" }))).toBe("RUNNER");
    expect(classifyWin(t({ netPct: 30, exitReason: "TRAILING_EXIT: x" }))).toBe("TRAILED");
    expect(classifyWin(t({ netPct: 5, exitReason: "TIME_EXIT" }))).toBe("OTHER_WIN");
  });

  it("labels the evidence stage by sample size", () => {
    expect([evidenceStage(30), evidenceStage(182), evidenceStage(500), evidenceStage(1500)]).toEqual(["sanity", "preliminary", "meaningful", "strong"]);
  });

  it("shows how much the mean leans on the best trades", () => {
    const o = outlierDependence([500, -10, -10, -10, -10, -10, -10]);
    expect(o.mean).toBeCloseTo(440 / 7);
    expect(o.meanExTop1).toBe(-10);
  });

  it("counts streaks in close order, not array order", () => {
    const s = streaks([t({ closedAt: 3, netPct: -1 }), t({ closedAt: 1, netPct: 5 }), t({ closedAt: 2, netPct: -1 }), t({ closedAt: 4, netPct: -1 })]);
    expect(s).toEqual({ maxWin: 1, maxLoss: 3, current: -3 });
  });

  it("measures drawdown on the realized equity curve", () => {
    const dd = realizedDrawdown([t({ closedAt: 1, netUsd: 4 }), t({ closedAt: 2, netUsd: -6 }), t({ closedAt: 3, netUsd: 1 })], 20);
    expect(dd.maxDrawdownPct).toBeCloseTo(25);
    expect(dd.endEquityUsd).toBe(19);
  });

  it("splits by time, at the median or a given cutoff", () => {
    const ts = [4, 1, 3, 2].map((o) => t({ openedAt: o }));
    expect(timeSplit(ts).dev.map((x) => x.openedAt)).toEqual([1, 2]);
    expect(timeSplit(ts, 4).holdout.map((x) => x.openedAt)).toEqual([4]);
  });

  it("only calls a segment's edge real when both halves agree", () => {
    const mk = (seg: string, open: number, net: number) => t({ openedAt: open, netPct: net, exitReason: seg });
    const ts = [
      ...Array.from({ length: 3 }, (_, i) => mk("a", i, 10)),
      ...Array.from({ length: 3 }, (_, i) => mk("a", 100 + i, 5)),
      ...Array.from({ length: 3 }, (_, i) => mk("b", i, 10)),
      ...Array.from({ length: 3 }, (_, i) => mk("b", 100 + i, -5)),
      mk("c", 1, 50),
    ];
    ts.push(mk("a", 500, -90));
    const rows = segmentTable(ts, (x) => x.exitReason, 50, 3, 400);
    expect(rows.find((r) => r.segment === "a")).toMatchObject({ verdict: "positive in both halves", holdoutN: 1, holdoutMeanPct: -90 });
    expect(rows.find((r) => r.segment === "b")?.verdict).toBe("flips between halves");
    expect(rows.find((r) => r.segment === "c")?.verdict).toBe("too few to test");
  });

  it("ladders MFE and MAE, leaving unknown excursions out", () => {
    const ts = [t({ mfePercent: 60, maePercent: -2, netPct: 30 }), t({ mfePercent: 25, maePercent: -18, netPct: -20 }), t({ netPct: -5 })];
    expect(mfeLadder(ts, [20, 50]).map((r) => [r.reached, r.endedPositive])).toEqual([
      [2, 1],
      [1, 1],
    ]);
    expect(maeLadder(ts, [-10]).map((r) => [r.reached, r.endedPositive])).toEqual([[1, 0]]);
    // -21% from a 0.001 fill is -16.8% from a 0.00095 first mark
    expect(maeFromBaseline(scoreTrade(position)!)).toBeCloseTo(-16.84, 1);
  });
});

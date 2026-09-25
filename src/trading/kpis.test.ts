import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
vi.mock("../db", () => ({ db: { trade: { findMany: (...args: unknown[]) => findMany(...args) } } }));
vi.mock("./strategy", () => ({ getActiveStrategyVersion: vi.fn(async () => ({ id: "v18", version: "v1.8" })) }));

import { computeKpis, expectancyPauses, getTradeKpis, getExpectancyPauses, type KpiTrade, type KpiGroup } from "./kpis";
import { tradingConfig } from "./config";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 25, 0, minute));
const trade = (realizedPnlUsd: number, minute: number, positionSizeUsd = 5): KpiTrade => ({ realizedPnlUsd, positionSizeUsd, closedAt: at(minute) });

describe("computeKpis", () => {
  it("computes win rate, average win and loss, expectancy and profit factor net of fees", () => {
    const k = computeKpis([trade(2, 1), trade(-1, 2), trade(-1, 3), trade(0, 4)], 20);
    expect(k).toMatchObject({ trades: 4, wins: 1, losses: 2, winRatePercent: 25, avgWinUsd: 2, avgLossUsd: 1, winLossRatio: 2, expectancyUsd: 0, totalPnlUsd: 0, profitFactor: 1 });
    expect(k.expectancyPercent).toBeCloseTo(0);
  });

  it("matches the 2026-09-25 picture: a 24% win rate needs wins ~3.2x the losses to break even", () => {
    const trades = [...Array(24)].map((_, i) => trade(1.36, i)).concat([...Array(76)].map((_, i) => trade(-1.2, 100 + i)));
    const k = computeKpis(trades, 20);
    expect(k.winRatePercent).toBe(24);
    expect(k.winLossRatio).toBeCloseTo(1.13, 2);
    expect(k.expectancyUsd).toBeCloseTo(-0.586, 3);
    expect(k.profitFactor).toBeCloseTo(0.358, 3);
  });

  it("gives no profit factor or win/loss ratio without losses, and nulls for no trades", () => {
    expect(computeKpis([trade(1, 1)], 20)).toMatchObject({ profitFactor: null, winLossRatio: null, avgLossUsd: null });
    expect(computeKpis([], 20)).toMatchObject({ trades: 0, winRatePercent: null, expectancyUsd: null, rollingExpectancyUsd: null });
  });

  it("takes the rolling expectancy over the most recent trades by close time, and only once there are enough", () => {
    const early = [...Array(5)].map((_, i) => trade(10, i));
    const late = [...Array(20)].map((_, i) => trade(-1, 100 + i));
    expect(computeKpis([...late, ...early], 20).rollingExpectancyUsd).toBe(-1);
    expect(computeKpis(late.slice(0, 19), 20).rollingExpectancyUsd).toBeNull();
  });
});

function group(overrides: Partial<KpiGroup> & { pnls: number[] }): KpiGroup {
  const { pnls, ...rest } = overrides;
  return {
    chain: "solana",
    lane: "MOMENTUM_TACTICAL",
    strategyVersionId: "v18",
    strategyVersion: "v1.8",
    origin: "autonomous",
    kpis: computeKpis(pnls.map((p, i) => trade(p, i)), 20),
    ...rest,
  };
}

describe("expectancyPauses", () => {
  const losing = [...Array(20)].map((_, i) => (i % 4 === 0 ? 1 : -1)); // mean -0.5

  it("pauses a chain+lane whose last 20 autonomous trades under the active version lost money", () => {
    const pauses = expectancyPauses([group({ pnls: losing })], "v18");
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toMatchObject({ chain: "solana", lane: "MOMENTUM_TACTICAL", strategyVersion: "v1.8" });
    expect(pauses[0].reason).toContain("averaged $-0.50 a trade");
  });

  it("does nothing before 20 trades exist", () => {
    expect(expectancyPauses([group({ pnls: losing.slice(0, 19) })], "v18")).toEqual([]);
  });

  it("does not pause a lane that's breaking even or better", () => {
    expect(expectancyPauses([group({ pnls: [...Array(20)].map((_, i) => (i % 2 ? 1 : -1)) })], "v18")).toEqual([]);
  });

  it("counts only the active version's trades, and never manual ones", () => {
    expect(expectancyPauses([group({ pnls: losing, strategyVersionId: "v17", strategyVersion: "v1.7" })], "v18")).toEqual([]);
    expect(expectancyPauses([group({ pnls: losing, origin: "manual" })], "v18")).toEqual([]);
  });
});

describe("getTradeKpis / getExpectancyPauses", () => {
  const row = (pnl: number, minute: number, overrides: Record<string, unknown> = {}) => ({
    realizedPnlUsd: pnl,
    positionSizeUsd: 5,
    closedAt: at(minute),
    tradeLane: "MOMENTUM_TACTICAL",
    strategyVersionId: "v18",
    strategyVersion: { version: "v1.8" },
    token: { chain: "solana" },
    candidate: { qualificationPath: "NORMAL" },
    tradePlan: { planData: {} },
    ...overrides,
  });

  beforeEach(() => findMany.mockReset());

  it("splits autonomous from manual buy-and-hold trades in the same lane", async () => {
    findMany.mockResolvedValue([
      row(1, 1),
      row(-1, 2),
      row(5, 3, { candidate: { qualificationPath: "MANUAL_BUY_AND_HOLD" } }),
      row(4, 4, { tradePlan: { planData: { manualBuyAndHold: true } } }),
    ]);
    const groups = await getTradeKpis();
    const autonomous = groups.find((g) => g.origin === "autonomous")!;
    const manual = groups.find((g) => g.origin === "manual")!;
    expect(autonomous.kpis.trades).toBe(2);
    expect(manual.kpis.trades).toBe(2);
    expect(manual.kpis.totalPnlUsd).toBe(9);
  });

  it("reads only the active version's trades for the pause, and can be switched off", async () => {
    findMany.mockResolvedValue([...Array(20)].map((_, i) => row(i % 4 === 0 ? 1 : -1, i)));
    const pauses = await getExpectancyPauses();
    expect(pauses).toHaveLength(1);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ strategyVersionId: "v18" });

    const original = tradingConfig.expectancyPauseEnabled;
    tradingConfig.expectancyPauseEnabled = false;
    try {
      expect(await getExpectancyPauses()).toEqual([]);
    } finally {
      tradingConfig.expectancyPauseEnabled = original;
    }
  });
});

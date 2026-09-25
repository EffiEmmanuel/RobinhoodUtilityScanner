import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

// A plain function, not a vi.fn(): vitest's spy tracking leaves a rejected
// mock promise looking unhandled even though the route catches it.
let paperKpis: () => Promise<unknown> = async () => null;
vi.mock("./paper", () => ({
  getPaperStrategyKpis: () => paperKpis(),
  paperConfig: { enabled: false },
}));
vi.mock("./kpis", () => ({
  getTradeKpis: vi.fn(async () => []),
  currentTradeMode: () => "LIVE",
  LANE_PAUSE_RESUME_NOTE: "note",
}));
vi.mock("./strategy", () => ({
  getActiveStrategyVersion: vi.fn(async () => ({ id: "v18", version: "v1.8" })),
  promoteStrategyVersion: vi.fn(),
}));
vi.mock("./portfolio", () => ({
  checkCircuitBreakers: vi.fn(async () => ({ lanePauses: [] })),
  getPortfolioState: vi.fn(),
  resetCircuitBreakerCounters: vi.fn(),
  getTotalRealizedPnlUsd: vi.fn(),
  getLossBreakerCounts: vi.fn(),
  getPortfolioByChain: vi.fn(),
  getCachedSolPriceUsd: vi.fn(),
}));

import { registerTradingRoutes } from "./api";

async function getKpis() {
  const app = Fastify();
  registerTradingRoutes(app);
  const res = await app.inject({ method: "GET", url: "/trading/kpis" });
  await app.close();
  return res.json();
}

describe("GET /trading/kpis", () => {

  it("includes the paper strategies, marked with whether they're running", async () => {
    paperKpis = async () => ({ quotesUsedToday: 12, strategies: [{ id: "p1", name: "solana-40pct" }] });
    const body = await getKpis();
    expect(body.paper).toEqual({ enabled: false, quotesUsedToday: 12, strategies: [{ id: "p1", name: "solana-40pct" }] });
    expect(body.activeStrategyVersion).toEqual({ id: "v18", version: "v1.8" });
  });

  it("still serves the real KPIs when the paper ones fail", async () => {
    paperKpis = async () => {
      throw new Error("no Paper tables yet");
    };
    const body = await getKpis();
    expect(body.paper).toBeNull();
    expect(body.groups).toEqual([]);
  });
});

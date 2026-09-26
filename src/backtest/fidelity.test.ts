import { describe, expect, it } from "vitest";
import { asPaperTrade, loadPaperBook, type PaperBookPosition, summarizeFidelity } from "./fidelity";
import type { UniverseCandidate } from "./universe";

const position: PaperBookPosition = {
  id: "pp1",
  strategyId: "s1",
  strategyName: "V0 at decision",
  strategyVersionId: "v18",
  candidateId: "c1",
  status: "CLOSED",
  openedAt: 1_790_000_000,
  closedAt: 1_790_000_600,
  sizeUsd: 8.4,
  entryPriceUsd: 0.0012,
  costBasisUsd: 8.41,
  realizedPnlUsd: -1.3,
  exitReason: "RISK_EXIT: loss -16.1% reached max tolerated loss",
  mfePercent: 4,
};

describe("paper-vs-replay fidelity", () => {
  it("reports missing paper tables instead of failing", async () => {
    const book = await loadPaperBook(async () => [{ ok: false }]);
    expect(book).toMatchObject({ tablesExist: false, positions: [] });
  });

  it("reads the paper book with epoch timestamps", async () => {
    const answers = [[{ ok: true }], [{ ...position, opened_at: "1790000000", closed_at: null, sizeUsd: "8.4", realizedPnlUsd: null }]];
    let i = 0;
    const book = await loadPaperBook(async () => answers[i++]);
    expect(book.positions[0]).toMatchObject({ openedAt: 1_790_000_000, closedAt: null, sizeUsd: 8.4, realizedPnlUsd: null });
  });

  it("stands the paper position in for a trade, with no AI plan", () => {
    const c = { candidateId: "c1", tradeLane: "MOMENTUM_TACTICAL", invalidationMcap: 5_000, trades: [] } as unknown as UniverseCandidate;
    const replayed = asPaperTrade(c, position);
    expect(replayed.invalidationMcap).toBeNull();
    expect(replayed.trades[0]).toMatchObject({ openedAt: position.openedAt, entryPriceUsd: 0.0012, positionSizeUsd: 8.4, invalidationMcap: null });
  });

  it("summarizes error, correlation, exit agreement and write-offs", () => {
    const f = summarizeFidelity([
      { positionId: "a", symbol: "A", paperUsd: -1, simUsd: -1.2, paperPct: -10, simPct: -12, paperExit: "RISK_EXIT: loss -16% reached max tolerated loss", simExit: "RISK_EXIT: loss -15.2% reached max tolerated loss" },
      { positionId: "b", symbol: "B", paperUsd: 3, simUsd: 2, paperPct: 30, simPct: 20, paperExit: "TRAILING_EXIT: retraced 21%", simExit: "TRAILING_EXIT: retraced 20%" },
      { positionId: "c", symbol: "C", paperUsd: -8, simUsd: 1, paperPct: -100, simPct: 10, paperExit: "write-off: no sell route for 6h", simExit: "WINDOW_END" },
    ]);
    expect(f.n).toBe(3);
    expect(f.meanAbsErrorPts).toBeCloseTo((2 + 10 + 110) / 3);
    expect(f.medianAbsErrorPts).toBe(10);
    expect(f.sameExitType).toBe(2);
    expect(f.paperWriteOffs).toBe(1);
    // One honeypot write-off the sim can't see wrecks the correlation; hence the separate count.
    expect(f.correlation).toBeCloseTo(0.0917, 3);
    expect(f.paperTotalUsd).toBeCloseTo(-6);
  });
});

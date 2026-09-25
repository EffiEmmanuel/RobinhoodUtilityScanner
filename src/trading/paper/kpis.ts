import { db } from "../../db";
import { tradeStats } from "../../backtest/stats";
import { quoteBudget } from "./quotes";

/**
 * Per-strategy KPIs for the dashboard. Returns are net of modeled gas, as a
 * percent of each position's cost basis; the CI is a bootstrap 90% interval
 * on the mean.
 */
export interface PaperStrategyKpi {
  id: string;
  name: string;
  active: boolean;
  chain: string;
  strategyVersionId: string;
  sizing: unknown;
  filter: unknown;
  startEquityUsd: number;
  equityUsd: number | null; // latest snapshot
  openPositions: number;
  closed: number;
  winRate: number | null;
  expectancyPct: number | null;
  expectancyCI90: [number, number] | null;
  profitFactor: number | null;
  realizedPnlUsd: number;
  gasUsd: number;
  maxDrawdownPct: number | null;
  equityCurve: { at: string; equityUsd: number }[];
  recent: { symbolAddress: string; openedAt: string; closedAt: string | null; pnlUsd: number | null; exitReason: string | null; peakPct: number | null }[];
}

export async function getPaperStrategyKpis(): Promise<{ quotesUsedToday: number; strategies: PaperStrategyKpi[] }> {
  const strategies = await db.paperStrategy.findMany({ orderBy: { createdAt: "asc" } });
  const out: PaperStrategyKpi[] = [];
  for (const s of strategies) {
    const [closed, openCount, gas, snapshots, recent] = await Promise.all([
      db.paperPosition.findMany({ where: { strategyId: s.id, status: "CLOSED" }, select: { realizedPnlUsd: true, costBasisUsd: true } }),
      db.paperPosition.count({ where: { strategyId: s.id, status: "OPEN" } }),
      db.paperFill.aggregate({ where: { strategyId: s.id }, _sum: { gasUsd: true } }),
      db.paperEquitySnapshot.findMany({ where: { strategyId: s.id }, orderBy: { capturedAt: "asc" }, select: { capturedAt: true, equityUsd: true } }),
      db.paperPosition.findMany({ where: { strategyId: s.id }, orderBy: { openedAt: "desc" }, take: 20 }),
    ]);
    const rows = closed.map((p) => {
      const net = p.realizedPnlUsd ?? 0;
      const pct = p.costBasisUsd > 0 ? (net / p.costBasisUsd) * 100 : 0;
      return { netPct: pct, grossPct: pct, netUsd: net };
    });
    const st = rows.length ? tradeStats(rows) : undefined;
    let peak = -Infinity;
    let maxDd = 0;
    for (const x of snapshots) {
      peak = Math.max(peak, x.equityUsd);
      if (peak > 0) maxDd = Math.max(maxDd, (peak - x.equityUsd) / peak);
    }
    const step = Math.max(1, Math.floor(snapshots.length / 200));
    out.push({
      id: s.id,
      name: s.name,
      active: s.active,
      chain: s.chain,
      strategyVersionId: s.strategyVersionId,
      sizing: s.sizing,
      filter: s.filter,
      startEquityUsd: s.startEquityUsd,
      equityUsd: snapshots.length ? snapshots[snapshots.length - 1].equityUsd : null,
      openPositions: openCount,
      closed: rows.length,
      winRate: st ? st.winRate : null,
      expectancyPct: st ? st.expectancyPct : null,
      expectancyCI90: st ? st.expectancyCI90 : null,
      profitFactor: st && Number.isFinite(st.profitFactor) ? st.profitFactor : null,
      realizedPnlUsd: rows.reduce((a, r) => a + r.netUsd, 0),
      gasUsd: gas._sum.gasUsd ?? 0,
      maxDrawdownPct: snapshots.length ? maxDd * 100 : null,
      equityCurve: snapshots.filter((_, i) => i % step === 0).map((x) => ({ at: x.capturedAt.toISOString(), equityUsd: x.equityUsd })),
      recent: recent.map((p) => ({
        symbolAddress: p.tokenAddress,
        openedAt: p.openedAt.toISOString(),
        closedAt: p.closedAt?.toISOString() ?? null,
        pnlUsd: p.realizedPnlUsd,
        exitReason: p.exitReason,
        peakPct: p.mfePercent,
      })),
    });
  }
  return { quotesUsedToday: quoteBudget.usedToday, strategies: out };
}

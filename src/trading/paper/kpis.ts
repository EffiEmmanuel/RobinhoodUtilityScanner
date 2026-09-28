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
  trades: PaperTradeRow[];
}

export interface PaperTradeRow {
  id: string;
  tokenAddress: string;
  tokenName: string | null;
  tokenSymbol: string | null;
  chain: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  investedUsd: number;
  pnlUsd: number | null;
  pnlPercent: number | null;
  entryMarketCapUsd: number | null;
  exitMarketCapUsd: number | null;
  entryPriceUsd: number | null;
  exitPriceUsd: number | null;
  exitReason: string | null;
  qualityScore: number | null;
  socialScore: number | null;
  tradeLane: string | null;
  peakPercent: number | null;
  drawdownPercent: number | null;
}

export async function getPaperStrategyKpis(): Promise<{ quotesUsedToday: number; strategies: PaperStrategyKpi[] }> {
  const strategies = await db.paperStrategy.findMany({ orderBy: { createdAt: "asc" } });
  const out: PaperStrategyKpi[] = [];
  for (const s of strategies) {
    const [closed, openCount, gas, snapshots, recent, positions] = await Promise.all([
      db.paperPosition.findMany({ where: { strategyId: s.id, status: "CLOSED" }, select: { realizedPnlUsd: true, costBasisUsd: true } }),
      db.paperPosition.count({ where: { strategyId: s.id, status: "OPEN" } }),
      db.paperFill.aggregate({ where: { strategyId: s.id }, _sum: { gasUsd: true } }),
      db.paperEquitySnapshot.findMany({ where: { strategyId: s.id }, orderBy: { capturedAt: "asc" }, select: { capturedAt: true, equityUsd: true } }),
      db.paperPosition.findMany({ where: { strategyId: s.id }, orderBy: { openedAt: "desc" }, take: 20 }),
      db.paperPosition.findMany({ where: { strategyId: s.id }, orderBy: { openedAt: "desc" } }),
    ]);
    const [fills, candidates] = await Promise.all([
      db.paperFill.findMany({ where: { strategyId: s.id }, orderBy: { ts: "asc" } }),
      db.tradeCandidate.findMany({ where: { id: { in: positions.map((p) => p.candidateId) } }, include: { token: { select: { name: true, symbol: true } } } }),
    ]);
    const fillsByPosition = new Map<string, typeof fills>();
    for (const fill of fills) fillsByPosition.set(fill.positionId, [...(fillsByPosition.get(fill.positionId) ?? []), fill]);
    const candidateById = new Map(candidates.map((c) => [c.id, c]));
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
      trades: positions.map((p) => {
        const positionFills = fillsByPosition.get(p.id) ?? [];
        const sells = positionFills.filter((f) => f.side === "SELL");
        const soldRaw = sells.reduce((sum, f) => sum + BigInt(f.tokensRaw), 0n);
        const exitPriceUsd = soldRaw > 0n
          ? sells.reduce((sum, f) => sum + (f.priceUsd ?? 0) * Number(BigInt(f.tokensRaw)), 0) / Number(soldRaw)
          : p.status === "OPEN" ? p.lastMarkPriceUsd : null;
        const meta = p.meta && typeof p.meta === "object" ? p.meta as Record<string, unknown> : {};
        const supply = typeof meta.supply === "number" ? meta.supply : null;
        const currentValue = p.status === "OPEN" && p.lastMarkPriceUsd !== null
          ? Number(BigInt(p.tokensRemainingRaw)) / 10 ** (p.decimals ?? 0) * p.lastMarkPriceUsd
          : 0;
        const pnlUsd = p.status === "CLOSED" ? p.realizedPnlUsd : p.realizedProceedsUsd + currentValue - p.costBasisUsd;
        const candidate = candidateById.get(p.candidateId);
        return {
          id: p.id,
          tokenAddress: p.tokenAddress,
          tokenName: candidate?.token.name ?? null,
          tokenSymbol: candidate?.token.symbol ?? null,
          chain: p.chain,
          status: p.status,
          openedAt: p.openedAt.toISOString(),
          closedAt: p.closedAt?.toISOString() ?? null,
          investedUsd: p.costBasisUsd,
          pnlUsd,
          pnlPercent: p.costBasisUsd > 0 && pnlUsd !== null ? pnlUsd / p.costBasisUsd * 100 : null,
          entryMarketCapUsd: supply !== null && p.entryPriceUsd !== null ? supply * p.entryPriceUsd : null,
          exitMarketCapUsd: supply !== null && exitPriceUsd !== null ? supply * exitPriceUsd : null,
          entryPriceUsd: p.entryPriceUsd,
          exitPriceUsd,
          exitReason: p.exitReason,
          qualityScore: typeof meta.qualityScore === "number" ? meta.qualityScore : null,
          socialScore: typeof meta.socialScore === "number" ? meta.socialScore : null,
          tradeLane: typeof meta.tradeLane === "string" ? meta.tradeLane : null,
          peakPercent: p.mfePercent,
          drawdownPercent: p.maePercent,
        };
      }),
    });
  }
  return { quotesUsedToday: quoteBudget.usedToday, strategies: out };
}

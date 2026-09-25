import { db } from "../db";
import { TradeStatus, TradingMode } from "../generated/prisma";
import { tradingConfig } from "./config";
import { getActiveStrategyVersion } from "./strategy";
import { normalizeTradeLane, type TradeLane } from "./tradeLane";
import type { ChainKey } from "./portfolio";

/**
 * Per-strategy trading KPIs, and the expectancy auto-pause built on them.
 *
 * Why (2026-09-25 review of 85 closed LIVE trades): a ~24% win rate with the
 * average win (~$1.36) about the size of the average loss (~$1.20). At that
 * win rate the average win has to be ~3.2x the average loss just to break
 * even, and nothing on the dashboard showed it. Every figure is net of fees:
 * Trade.realizedPnlUsd already nets out gas (pnl.ts).
 */

export interface KpiTrade {
  realizedPnlUsd: number;
  positionSizeUsd: number;
  closedAt: Date;
}

export interface TradeKpis {
  trades: number;
  wins: number;
  losses: number;
  winRatePercent: number | null;
  avgWinUsd: number | null;
  // A positive number: the average size of a loss.
  avgLossUsd: number | null;
  winLossRatio: number | null;
  // Mean net P&L per trade, in dollars and as a percent of each position.
  expectancyUsd: number | null;
  expectancyPercent: number | null;
  // Gross wins / gross losses; null with no losses to divide by.
  profitFactor: number | null;
  totalPnlUsd: number;
  // Mean net P&L of the most recent `window` trades; null until there are
  // that many.
  rollingExpectancyUsd: number | null;
  rollingWindow: number;
}

const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function computeKpis(trades: KpiTrade[], window: number = tradingConfig.expectancyPauseWindowTrades): TradeKpis {
  const ordered = [...trades].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
  const pnls = ordered.map((t) => t.realizedPnlUsd);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0).map((p) => -p);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = losses.reduce((a, b) => a + b, 0);
  const avgWinUsd = mean(wins);
  const avgLossUsd = mean(losses);
  return {
    trades: ordered.length,
    wins: wins.length,
    losses: losses.length,
    winRatePercent: ordered.length > 0 ? (wins.length / ordered.length) * 100 : null,
    avgWinUsd,
    avgLossUsd,
    winLossRatio: avgWinUsd !== null && avgLossUsd ? avgWinUsd / avgLossUsd : null,
    expectancyUsd: mean(pnls),
    expectancyPercent: mean(ordered.filter((t) => t.positionSizeUsd > 0).map((t) => (t.realizedPnlUsd / t.positionSizeUsd) * 100)),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    totalPnlUsd: pnls.reduce((a, b) => a + b, 0),
    rollingExpectancyUsd: ordered.length >= window ? mean(pnls.slice(-window)) : null,
    rollingWindow: window,
  };
}

export type TradeOrigin = "autonomous" | "manual";

export interface KpiGroup {
  chain: ChainKey;
  lane: TradeLane;
  strategyVersionId: string;
  strategyVersion: string;
  origin: TradeOrigin;
  kpis: TradeKpis;
}

/** The Trade.mode the bot is trading in right now; undefined (all modes)
 * when trading is disabled. */
export function currentTradeMode(): TradingMode | undefined {
  if (tradingConfig.mode === "LIVE") return TradingMode.LIVE;
  if (tradingConfig.mode === "SHADOW") return TradingMode.SHADOW;
  if (tradingConfig.mode === "PAPER") return TradingMode.PAPER;
  return undefined;
}

/**
 * Closed trades with a known P&L, grouped by chain, lane, strategy version
 * and origin (the bot's own pick vs a manual buy-and-hold, which lands in
 * the MOMENTUM_TACTICAL lane too). A trade closed as an external wallet
 * exit has no known P&L and is left out.
 */
export async function getTradeKpis(filter: { mode?: TradingMode; strategyVersionId?: string } = {}): Promise<KpiGroup[]> {
  const trades = await db.trade.findMany({
    where: {
      status: TradeStatus.CLOSED,
      realizedPnlUsd: { not: null },
      ...(filter.mode ? { mode: filter.mode } : {}),
      ...(filter.strategyVersionId ? { strategyVersionId: filter.strategyVersionId } : {}),
    },
    select: {
      realizedPnlUsd: true,
      positionSizeUsd: true,
      closedAt: true,
      tradeLane: true,
      strategyVersionId: true,
      strategyVersion: { select: { version: true } },
      token: { select: { chain: true } },
      candidate: { select: { qualificationPath: true } },
      tradePlan: { select: { planData: true } },
    },
  });

  const groups = new Map<string, Omit<KpiGroup, "kpis"> & { trades: KpiTrade[] }>();
  for (const t of trades) {
    const manual =
      t.candidate?.qualificationPath === "MANUAL_BUY_AND_HOLD" ||
      (t.tradePlan?.planData as { manualBuyAndHold?: unknown } | null)?.manualBuyAndHold === true;
    const group = {
      chain: (t.token.chain === "solana" ? "solana" : "robinhood") as ChainKey,
      lane: normalizeTradeLane(t.tradeLane),
      strategyVersionId: t.strategyVersionId,
      strategyVersion: t.strategyVersion.version,
      origin: (manual ? "manual" : "autonomous") as TradeOrigin,
    };
    const key = [group.chain, group.lane, group.strategyVersionId, group.origin].join("|");
    const entry = groups.get(key) ?? { ...group, trades: [] };
    entry.trades.push({ realizedPnlUsd: t.realizedPnlUsd ?? 0, positionSizeUsd: t.positionSizeUsd, closedAt: t.closedAt ?? new Date(0) });
    groups.set(key, entry);
  }
  return [...groups.values()].map(({ trades: groupTrades, ...group }) => ({ ...group, kpis: computeKpis(groupTrades) }));
}

export interface LanePause {
  chain: ChainKey;
  lane: TradeLane;
  strategyVersion: string;
  reason: string;
}

/**
 * Chain+lane pairs whose last `window` closed autonomous trades under the
 * active strategy version lost money on average. Only that version's trades
 * count, and nothing pauses before there are `window` of them — a newly
 * promoted version starts with a clean slate. Manual buy-and-hold trades
 * never count and are never paused.
 */
export function expectancyPauses(groups: KpiGroup[], activeStrategyVersionId: string): LanePause[] {
  return groups
    .filter((g) => g.origin === "autonomous" && g.strategyVersionId === activeStrategyVersionId)
    .filter((g) => g.kpis.rollingExpectancyUsd !== null && g.kpis.rollingExpectancyUsd < 0)
    .map((g) => ({
      chain: g.chain,
      lane: g.lane,
      strategyVersion: g.strategyVersion,
      reason:
        `${g.chain} ${g.lane}: the last ${g.kpis.rollingWindow} autonomous trades under ${g.strategyVersion} averaged ` +
        `$${g.kpis.rollingExpectancyUsd!.toFixed(2)} a trade after fees (${g.kpis.trades} under this version, ` +
        `win rate ${g.kpis.winRatePercent!.toFixed(0)}%, profit factor ${g.kpis.profitFactor?.toFixed(2) ?? "n/a"}) — ` +
        `new autonomous entries in this lane are paused`,
    }));
}

// A paused lane takes no new trades, so its record can't recover by itself.
export const LANE_PAUSE_RESUME_NOTE =
  "Stays paused until a new strategy version is promoted, or EXPECTANCY_PAUSE_ENABLED=false is set on Railway. Open positions still exit normally.";

/** The expectancy pauses in force right now (EXPECTANCY_PAUSE_ENABLED). */
export async function getExpectancyPauses(): Promise<LanePause[]> {
  if (!tradingConfig.expectancyPauseEnabled) return [];
  const active = await getActiveStrategyVersion();
  const groups = await getTradeKpis({ mode: currentTradeMode(), strategyVersionId: active.id });
  return expectancyPauses(groups, active.id);
}

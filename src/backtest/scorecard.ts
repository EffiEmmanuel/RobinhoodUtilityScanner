import { stopBaseline } from "../trading/positionManager";
import type { PaperBookPosition } from "./fidelity";
import { type TradeStats, bootstrapMeanCI, mean, quantile, tradeStats } from "./stats";

/**
 * Paper scorecard: the measurement layer the strategy spec (2026-09-27)
 * asks for, built only from what the paper book records on real quotes.
 * Gross (before modeled gas) leads, since it doesn't depend on the tiny
 * paper size; net sits beside it so costs can't hide inside the edge.
 * Loss/win classes are deterministic rules on MFE, MAE and the exit, never
 * an AI's reading of the trade.
 */

/**
 * Locked 2026-09-27 before any result past it existed: paper positions
 * opened from here on are the holdout. New rules are developed on what came
 * before and only confirmed here; don't move this to fit a result.
 */
export const PAPER_HOLDOUT_FROM = Date.parse("2026-09-27T18:00:00Z") / 1000;

export interface ScoredTrade {
  id: string;
  candidateId: string;
  strategyName: string;
  openedAt: number;
  closedAt: number;
  sizeUsd: number;
  entryPriceUsd: number | null;
  firstMarkPriceUsd: number | null;
  netPct: number; // of cost basis, after modeled gas
  grossPct: number; // of size, before modeled gas
  netUsd: number;
  gasUsd: number;
  mfePercent: number | null;
  maePercent: number | null;
  exitReason: string;
  liquidityUsd: number | null;
  qualityScore: number | null;
}

export function scoreTrade(p: PaperBookPosition): ScoredTrade | null {
  if (p.status !== "CLOSED" || p.realizedPnlUsd === null || p.closedAt === null || !(p.costBasisUsd > 0)) return null;
  const gasUsd = p.gasUsd ?? 0;
  return {
    id: p.id,
    candidateId: p.candidateId,
    strategyName: p.strategyName,
    openedAt: p.openedAt,
    closedAt: p.closedAt,
    sizeUsd: p.sizeUsd,
    entryPriceUsd: p.entryPriceUsd,
    firstMarkPriceUsd: p.firstMarkPriceUsd ?? null,
    netPct: (p.realizedPnlUsd / p.costBasisUsd) * 100,
    // realized = sell proceeds after sell gas - (size + buy gas), so adding
    // all fill gas back leaves sell proceeds before gas minus size.
    grossPct: p.sizeUsd > 0 ? ((p.realizedPnlUsd + gasUsd) / p.sizeUsd) * 100 : NaN,
    netUsd: p.realizedPnlUsd,
    gasUsd,
    mfePercent: p.mfePercent,
    maePercent: p.maePercent ?? null,
    exitReason: p.exitReason ?? "",
    liquidityUsd: p.liquidityUsdAtDecision ?? null,
    qualityScore: p.qualityScore ?? null,
  };
}

/** The spec's sample-size ladder: guidance on how much a number can carry, not a guarantee. */
export function evidenceStage(n: number): string {
  if (n < 100) return "sanity";
  if (n < 300) return "preliminary";
  if (n < 1000) return "meaningful";
  return "strong";
}

export interface Distribution {
  sd: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
}

export function distribution(xs: number[]): Distribution {
  const s = [...xs].sort((a, b) => a - b);
  const m = mean(xs);
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) : NaN;
  return { sd, p10: quantile(s, 0.1), p25: quantile(s, 0.25), p50: quantile(s, 0.5), p75: quantile(s, 0.75), p90: quantile(s, 0.9), p95: quantile(s, 0.95), p99: quantile(s, 0.99) };
}

/** Mean per-trade return with the best 1 and best 5 trades removed: is the edge broad or a few outliers? */
export function outlierDependence(xs: number[]): { mean: number; meanExTop1: number; meanExTop5: number } {
  const s = [...xs].sort((a, b) => b - a);
  return { mean: mean(xs), meanExTop1: mean(s.slice(1)), meanExTop5: mean(s.slice(5)) };
}

/** Longest win and loss runs in close order, and the run in progress (+wins / -losses). */
export function streaks(trades: Pick<ScoredTrade, "closedAt" | "netPct">[]): { maxWin: number; maxLoss: number; current: number } {
  let maxWin = 0;
  let maxLoss = 0;
  let current = 0;
  for (const t of [...trades].sort((a, b) => a.closedAt - b.closedAt)) {
    if (t.netPct > 0) current = current > 0 ? current + 1 : 1;
    else current = current < 0 ? current - 1 : -1;
    maxWin = Math.max(maxWin, current);
    maxLoss = Math.max(maxLoss, -current);
  }
  return { maxWin, maxLoss, current };
}

/**
 * Peak-to-trough of the realized equity curve (start equity plus closed
 * P&L in close order). Open positions aren't marked, so this understates
 * a drawdown that's still open.
 */
export function realizedDrawdown(trades: Pick<ScoredTrade, "closedAt" | "netUsd">[], startEquityUsd: number): { maxDrawdownPct: number; endEquityUsd: number } {
  let equity = startEquityUsd;
  let peak = equity;
  let maxDd = 0;
  for (const t of [...trades].sort((a, b) => a.closedAt - b.closedAt)) {
    equity += t.netUsd;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  return { maxDrawdownPct: maxDd * 100, endEquityUsd: equity };
}

export type LossClass = "UNSELLABLE" | "CRASH" | "GAVE_BACK" | "COSTS_ONLY" | "NEVER_WORKED" | "FADED";
export type WinClass = "RUNNER" | "TRAILED" | "OTHER_WIN";

export const LOSS_CLASS_MEANING: Record<LossClass, string> = {
  UNSELLABLE: "no sell route / write-off",
  CRASH: "net <= -40%: gapped through the stop (rug / liquidity pull)",
  GAVE_BACK: "was up >= +20% (MFE), closed at a loss: exit problem",
  COSTS_ONLY: "gross positive, gas made it a loss",
  NEVER_WORKED: "MFE < +5%: entry problem (wrong signal or late)",
  FADED: "MFE +5% to +20%, then stopped",
};

/** First matching rule wins, most specific first. */
export function classifyLoss(t: Pick<ScoredTrade, "netPct" | "grossPct" | "mfePercent" | "exitReason">): LossClass {
  if (/write-off|no sell route/i.test(t.exitReason)) return "UNSELLABLE";
  if (t.netPct <= -40) return "CRASH";
  const mfe = t.mfePercent ?? 0;
  if (mfe >= 20) return "GAVE_BACK";
  if (t.grossPct > 0) return "COSTS_ONLY";
  if (mfe < 5) return "NEVER_WORKED";
  return "FADED";
}

export function classifyWin(t: Pick<ScoredTrade, "netPct" | "exitReason">): WinClass {
  if (t.netPct >= 100) return "RUNNER";
  if (/TRAILING_EXIT/.test(t.exitReason)) return "TRAILED";
  return "OTHER_WIN";
}

/**
 * How far past its trigger a loss stop filled, gross of gas, in % points
 * (negative = worse than the trigger). The trigger is measured from the
 * stop baseline (the lower of entry and first mark, as live), so the exit is
 * too. Marks thin out after the first hour, so gaps are split by age.
 */
export function stopFillGap(
  t: Pick<ScoredTrade, "grossPct" | "exitReason" | "entryPriceUsd" | "firstMarkPriceUsd" | "openedAt" | "closedAt">
): { kind: "max-loss" | "catastrophic"; age: "<1h" | ">=1h"; gapPts: number } | null {
  const m = /RISK_EXIT: (catastrophic )?loss -([\d.]+)%/.exec(t.exitReason);
  if (!m) return null;
  const entry = t.entryPriceUsd ?? 0;
  const baseline = entry > 0 ? stopBaseline(entry, t.firstMarkPriceUsd ?? undefined) : 0;
  const fromBaseline = baseline > 0 ? ((1 + t.grossPct / 100) * (entry / baseline) - 1) * 100 : t.grossPct;
  return { kind: m[1] ? "catastrophic" : "max-loss", age: t.closedAt - t.openedAt < 3600 ? "<1h" : ">=1h", gapPts: fromBaseline + Number(m[2]) };
}

/**
 * Chronological split at `cutoff` (default: the median open time). Used on
 * the development set as a stability check; the real out-of-sample test is
 * PAPER_HOLDOUT_FROM.
 */
export function timeSplit<T extends Pick<ScoredTrade, "openedAt">>(trades: T[], cutoff?: number): { cutoff: number; dev: T[]; holdout: T[] } {
  const sorted = [...trades].sort((a, b) => a.openedAt - b.openedAt);
  const at = cutoff ?? sorted[Math.floor(sorted.length / 2)]?.openedAt ?? 0;
  return { cutoff: at, dev: sorted.filter((t) => t.openedAt < at), holdout: sorted.filter((t) => t.openedAt >= at) };
}

export function stats(trades: ScoredTrade[]): TradeStats {
  return tradeStats(trades.map((t) => ({ netPct: t.netPct, grossPct: t.grossPct, netUsd: t.netUsd })));
}

export interface SegmentRow {
  segment: string;
  n: number;
  meanPct: number;
  ci90: [number, number];
  winRate: number;
  firstHalfMeanPct: number;
  firstHalfN: number;
  secondHalfMeanPct: number;
  secondHalfN: number;
  verdict: string; // on the two development halves
  holdoutMeanPct: number;
  holdoutN: number;
}

/**
 * Per-segment net return. The verdict asks whether both development halves
 * (split at halfCutoff) have at least minHalf trades and agree in sign; the
 * locked holdout is reported beside it, never folded in. Many segments are
 * tested at once, so a single CI clear of 0 is still a lead.
 */
export function segmentTable(
  trades: ScoredTrade[],
  key: (t: ScoredTrade) => string,
  halfCutoff: number,
  minHalf = 10,
  holdoutFrom = Infinity
): SegmentRow[] {
  const groups = new Map<string, ScoredTrade[]>();
  for (const t of trades) groups.set(key(t), [...(groups.get(key(t)) ?? []), t]);
  return [...groups.entries()]
    .map(([segment, ts]) => {
      const net = ts.map((t) => t.netPct);
      const first = ts.filter((t) => t.openedAt < halfCutoff).map((t) => t.netPct);
      const second = ts.filter((t) => t.openedAt >= halfCutoff && t.openedAt < holdoutFrom).map((t) => t.netPct);
      const hold = ts.filter((t) => t.openedAt >= holdoutFrom).map((t) => t.netPct);
      const [a, b] = [mean(first), mean(second)];
      let verdict: string;
      if (first.length < minHalf || second.length < minHalf) verdict = "too few to test";
      else if (a > 0 && b > 0) verdict = "positive in both halves";
      else if (a <= 0 && b <= 0) verdict = "negative in both halves";
      else verdict = "flips between halves";
      return {
        segment,
        n: ts.length,
        meanPct: mean(net),
        ci90: bootstrapMeanCI(net, { seed: 13 }),
        winRate: net.filter((x) => x > 0).length / net.length,
        firstHalfMeanPct: a,
        firstHalfN: first.length,
        secondHalfMeanPct: b,
        secondHalfN: second.length,
        verdict,
        holdoutMeanPct: mean(hold),
        holdoutN: hold.length,
      };
    })
    .sort((a, b) => b.n - a.n);
}

export function liquidityBucket(liq: number | null): string {
  if (liq === null || !(liq > 0)) return "unknown";
  if (liq < 10_000) return "<$10K";
  if (liq < 30_000) return "$10-30K";
  if (liq < 100_000) return "$30-100K";
  return ">=$100K";
}

export function qualityBucket(q: number | null): string {
  if (q === null || !Number.isFinite(q)) return "unknown";
  if (q < 60) return "<60";
  if (q < 70) return "60-70";
  if (q < 80) return "70-80";
  return ">=80";
}

export interface ExcursionRow {
  threshold: number;
  reached: number;
  endedPositive: number;
  meanNetPct: number;
}

/**
 * MFE ladder: of positions that touched +X%, how many kept a profit, and
 * what they averaged net. A big "reached" with a low "ended positive" says
 * the exits hand back winners.
 */
export function mfeLadder(trades: ScoredTrade[], thresholds = [10, 20, 50, 100]): ExcursionRow[] {
  return thresholds.map((x) => {
    const hit = trades.filter((t) => (t.mfePercent ?? -Infinity) >= x);
    return { threshold: x, reached: hit.length, endedPositive: hit.filter((t) => t.netPct > 0).length, meanNetPct: mean(hit.map((t) => t.netPct)) };
  });
}

/**
 * MAE from the stop baseline (the lower of entry and first mark), which is
 * what a stop sees: from the entry fill, the ~5% round-trip cost at the
 * first mark would make every dip look deeper than the market moved.
 */
export function maeFromBaseline(t: Pick<ScoredTrade, "maePercent" | "entryPriceUsd" | "firstMarkPriceUsd">): number | null {
  if (t.maePercent === null) return null;
  const entry = t.entryPriceUsd ?? 0;
  const baseline = entry > 0 ? stopBaseline(entry, t.firstMarkPriceUsd ?? undefined) : 0;
  return baseline > 0 ? ((1 + t.maePercent / 100) * (entry / baseline) - 1) * 100 : t.maePercent;
}

/**
 * MAE ladder: of positions that sank X% below the stop baseline at some
 * mark, how many still ended net positive. It says how deep a dip winners
 * survive, but not what a stop there would do: the few that recover can be
 * the runners carrying the book, so a stop level needs a paired replay.
 */
export function maeLadder(trades: ScoredTrade[], thresholds = [-5, -10, -15, -20]): ExcursionRow[] {
  return thresholds.map((x) => {
    const hit = trades.filter((t) => (maeFromBaseline(t) ?? Infinity) <= x);
    return { threshold: x, reached: hit.length, endedPositive: hit.filter((t) => t.netPct > 0).length, meanNetPct: mean(hit.map((t) => t.netPct)) };
  });
}

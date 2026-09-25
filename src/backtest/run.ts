import type { ExitRules } from "../trading/strategy";
import type { Candle } from "./candles";
import { type CostModel, chainCosts } from "./costs";
import { type EntryStrategy, historyView } from "./entries";
import type { PriceSeries } from "./marketData";
import { DEFAULT_HOLD_WINDOW_S, type IntrabarMode, type SimCandidateMeta, type SimResult, type ValuedTrade, simulatePosition, valueAtSize } from "./simulate";
import type { UniverseCandidate } from "./universe";

export interface RunConfig {
  name: string;
  entry: EntryStrategy;
  exitRules: (c: UniverseCandidate) => ExitRules;
  legacyProfitSteps?: (c: UniverseCandidate) => boolean;
  costs: CostModel;
  refSizeUsd: number; // size decisions are simulated at; also the size per-trade stats are quoted at
  sizeFor?: (c: UniverseCandidate) => number; // overrides refSizeUsd per candidate (calibration: the real size)
  holdWindowS?: number;
  intrabar?: IntrabarMode;
  // Calibration: price entries at our real fill instead of the fill model.
  useActualEntryFill?: boolean;
}

export interface RunRow {
  candidate: UniverseCandidate;
  chain: string;
  sim?: SimResult;
  pathPeak?: number; // best candle close in the hold window / entry price, whatever the exits did
  valued?: ValuedTrade;
  skip?: string;
  seriesNote?: string;
}

export function candidateMeta(c: UniverseCandidate): SimCandidateMeta {
  const p = c.pair;
  const trade = c.trades[0];
  const price = p?.priceUsd && p.priceUsd > 0 ? p.priceUsd : undefined;
  const mcap = p?.marketCapUsd ?? p?.fdvUsd;
  let supply = price && mcap ? mcap / price : undefined;
  if (!supply && trade?.actualEntryMcap && trade.entryPriceUsd) supply = trade.actualEntryMcap / trade.entryPriceUsd;
  const useTrade = !price && trade?.entryPriceUsd;
  return {
    chain: c.chain,
    qualityScore: c.qualityScore,
    socialScore: c.socialScore,
    qualificationPath: c.qualificationPath,
    tradeLane: trade?.tradeLane ?? c.tradeLane,
    invalidationMcap: trade?.invalidationMcap ?? c.invalidationMcap,
    supply,
    liquidityUsdAtDecision: useTrade ? (trade.entryLiquidityUsd ?? undefined) : p?.liquidityUsd,
    midAtDecision: useTrade ? trade.entryPriceUsd! : price,
  };
}

export function pathPeak(candles: Candle[], fromTs: number, toTs: number, entryMid: number): number | undefined {
  if (!(entryMid > 0)) return undefined;
  let best = entryMid;
  for (const c of candles) if (c.t >= fromTs && c.t + c.d <= toTs) best = Math.max(best, c.c);
  return best / entryMid;
}

export async function runStrategy(
  candidates: UniverseCandidate[],
  getSeries: (c: UniverseCandidate) => Promise<PriceSeries | undefined>,
  cfg: RunConfig
): Promise<RunRow[]> {
  const rows: RunRow[] = [];
  for (const candidate of candidates) {
    const series = await getSeries(candidate);
    if (!series || series.candles.length === 0) {
      rows.push({ candidate, chain: candidate.chain, skip: "no candles" });
      continue;
    }
    const decision = cfg.entry.decide({ candidate, closedBy: historyView(series.candles) });
    if ("skip" in decision) {
      rows.push({ candidate, chain: candidate.chain, skip: decision.skip, seriesNote: series.note });
      continue;
    }
    const costs = chainCosts(cfg.costs, candidate.chain);
    const trade = candidate.trades[0];
    const actualFill = cfg.useActualEntryFill ? (trade?.entryPriceUsd ?? undefined) : undefined;
    const sizeUsd = cfg.sizeFor?.(candidate) ?? cfg.refSizeUsd;
    const sim = simulatePosition({
      candles: series.candles,
      coverageEnd: series.coverageEnd,
      entryTs: decision.ts,
      meta: candidateMeta(candidate),
      exitRules: cfg.exitRules(candidate),
      costs,
      sizeUsd,
      holdWindowS: cfg.holdWindowS,
      intrabar: cfg.intrabar,
      legacyProfitSteps: cfg.legacyProfitSteps?.(candidate) ?? false,
      entryFillOverride: actualFill,
    });
    if ("skip" in sim) {
      rows.push({ candidate, chain: candidate.chain, skip: sim.skip, seriesNote: series.note });
      continue;
    }
    const windowEnd = Math.min(sim.entryTs + (cfg.holdWindowS ?? DEFAULT_HOLD_WINDOW_S), series.coverageEnd);
    rows.push({
      candidate,
      chain: candidate.chain,
      sim,
      pathPeak: pathPeak(series.candles, sim.entryTs, windowEnd, sim.entryMid),
      valued: valueAtSize(sim, sizeUsd, costs, actualFill),
      seriesNote: series.note,
    });
  }
  return rows;
}

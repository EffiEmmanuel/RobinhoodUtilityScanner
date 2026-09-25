import type { RunRow } from "./run";
import { bootstrapMeanCI, mean } from "./stats";

/**
 * Paired comparison of two exit configs over the same entries. The bucket
 * is the token's own path peak after entry (best candle close in the hold
 * window over the entry price), which doesn't depend on either config's
 * exits, so "runners" means the same trades on both sides.
 */

export type PeakBucket = "<2x" | "2-4x" | ">=4x";

export function peakBucket(pathPeak: number | undefined): PeakBucket {
  if (pathPeak === undefined || pathPeak < 2) return "<2x";
  return pathPeak < 4 ? "2-4x" : ">=4x";
}

export interface PairedTrade {
  candidateId: string;
  tradeId?: string;
  symbol: string | null;
  chain: string;
  pathPeak: number | undefined;
  aPct: number;
  bPct: number;
  aUsd: number;
  bUsd: number;
  aExit: string;
  bExit: string;
}

export function pairRows(a: RunRow[], b: RunRow[]): PairedTrade[] {
  const key = (r: RunRow) => `${r.candidate.candidateId}:${r.candidate.trades[0]?.id ?? ""}`;
  const bByKey = new Map(b.map((r) => [key(r), r]));
  const out: PairedTrade[] = [];
  for (const ra of a) {
    const rb = bByKey.get(key(ra));
    if (!ra.valued || !rb?.valued) continue;
    out.push({
      candidateId: ra.candidate.candidateId,
      tradeId: ra.candidate.trades[0]?.id,
      symbol: ra.candidate.symbol,
      chain: ra.chain,
      pathPeak: ra.pathPeak,
      aPct: ra.valued.netPct,
      bPct: rb.valued.netPct,
      aUsd: ra.valued.netUsd,
      bUsd: rb.valued.netUsd,
      aExit: ra.sim?.exitReason ?? "",
      bExit: rb.sim?.exitReason ?? "",
    });
  }
  return out;
}

export interface PairSummary {
  group: string;
  n: number;
  aMeanPct: number;
  bMeanPct: number;
  diffMeanPct: number; // b - a, per trade, % of position
  diffCI90: [number, number];
  bBetter: number;
  bWorse: number;
  gainedPct: number; // sum of per-trade improvements (b > a), % points
  gaveBackPct: number; // sum of per-trade give-backs (b < a), % points, negative
  aTotalUsd: number;
  bTotalUsd: number;
}

const EPS = 1e-6;

export function summarizePairs(group: string, pairs: PairedTrade[], seed = 11): PairSummary {
  const diffs = pairs.map((p) => p.bPct - p.aPct);
  return {
    group,
    n: pairs.length,
    aMeanPct: mean(pairs.map((p) => p.aPct)),
    bMeanPct: mean(pairs.map((p) => p.bPct)),
    diffMeanPct: mean(diffs),
    diffCI90: bootstrapMeanCI(diffs, { seed }),
    bBetter: diffs.filter((d) => d > EPS).length,
    bWorse: diffs.filter((d) => d < -EPS).length,
    gainedPct: diffs.filter((d) => d > 0).reduce((x, y) => x + y, 0),
    gaveBackPct: diffs.filter((d) => d < 0).reduce((x, y) => x + y, 0),
    aTotalUsd: pairs.reduce((x, p) => x + p.aUsd, 0),
    bTotalUsd: pairs.reduce((x, p) => x + p.bUsd, 0),
  };
}

/** Everything, then each peak bucket. */
export function summarizeByPeak(pairs: PairedTrade[]): PairSummary[] {
  const buckets: PeakBucket[] = ["<2x", "2-4x", ">=4x"];
  return [summarizePairs("all", pairs), ...buckets.map((b) => summarizePairs(`peak ${b}`, pairs.filter((p) => peakBucket(p.pathPeak) === b)))];
}

import type { RunRow } from "./run";
import { bootstrapMeanCI, mean } from "./stats";
import type { UniverseCandidate } from "./universe";

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

/**
 * Where the token launched. A pump.fun mint keeps its "pump" address suffix
 * after it graduates to PumpSwap or Raydium, so the suffix catches graduated
 * tokens whose decision-time pool is no longer the curve.
 */
export function launchVenue(c: Pick<UniverseCandidate, "chain" | "tokenAddress" | "pair">): string {
  const dex = (c.pair?.dexId ?? "").toLowerCase();
  if (c.chain === "solana" && (c.tokenAddress.endsWith("pump") || dex === "pumpfun" || dex === "pumpswap")) return "pump.fun";
  if (dex.startsWith("meteora")) return "meteora";
  return dex || "unknown";
}

export interface PairedTrade {
  candidateId: string;
  venue: string;
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
      venue: launchVenue(ra.candidate),
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

/** One row per launch venue, biggest first. */
export function summarizeByVenue(pairs: PairedTrade[]): PairSummary[] {
  const venues = [...new Set(pairs.map((p) => p.venue))];
  return venues
    .map((v) => summarizePairs(`venue ${v}`, pairs.filter((p) => p.venue === v)))
    .sort((a, b) => b.n - a.n);
}

/** pump.fun vs everything else, the split C's launch-venue table used. */
export function summarizePumpVsOther(pairs: PairedTrade[]): PairSummary[] {
  return [
    summarizePairs("pump.fun launches", pairs.filter((p) => p.venue === "pump.fun")),
    summarizePairs("other launches", pairs.filter((p) => p.venue !== "pump.fun")),
  ];
}

export interface GridEntry {
  name: string;
  primary: PairSummary; // vs V0, all trades, primary mode
  secondary: PairSummary; // vs V0, all trades, secondary mode
}

export interface GridDecision {
  qualifiers: string[];
  winner: string; // "V0" when nothing qualifies
  reasons: string[];
}

/**
 * The pre-registered rule (coordinator, 2026-09-25): a variant qualifies if
 * its paired mean vs V0 is >= 0 in the primary mode and >= 0 in the
 * secondary. Among qualifiers the simplest wins (variants arrive simplest
 * first) unless another beats it in BOTH modes with a 90% CI clear of 0,
 * judged by `headToHead(challenger, simplest)`.
 */
export function decideGrid(
  entries: GridEntry[],
  headToHead: (challenger: string, incumbent: string) => { primary: PairSummary; secondary: PairSummary }
): GridDecision {
  const reasons: string[] = [];
  const qualifiers = entries.filter((e) => {
    const ok = e.primary.diffMeanPct >= 0 && e.secondary.diffMeanPct >= 0;
    reasons.push(
      `${e.name}: primary ${e.primary.diffMeanPct >= 0 ? "no worse" : "worse"} (${e.primary.diffMeanPct.toFixed(2)} pts), secondary ${e.secondary.diffMeanPct >= 0 ? "no loss" : "loses"} (${e.secondary.diffMeanPct.toFixed(2)} pts) -> ${ok ? "qualifies" : "out"}`
    );
    return ok;
  });
  if (qualifiers.length === 0) return { qualifiers: [], winner: "V0", reasons: [...reasons, "nothing qualifies: keep V0"] };
  let winner = qualifiers[0].name;
  reasons.push(`simplest qualifier: ${winner}`);
  for (const challenger of qualifiers.slice(1)) {
    const h = headToHead(challenger.name, winner);
    const clears = h.primary.diffCI90[0] > 0 && h.secondary.diffCI90[0] > 0;
    reasons.push(
      `${challenger.name} vs ${winner}: primary ${h.primary.diffMeanPct.toFixed(2)} [${h.primary.diffCI90.map((x) => x.toFixed(2)).join(", ")}], secondary ${h.secondary.diffMeanPct.toFixed(2)} [${h.secondary.diffCI90.map((x) => x.toFixed(2)).join(", ")}] -> ${clears ? "beats it in both with CIs clear of 0" : "doesn't clear both"}`
    );
    if (clears) winner = challenger.name;
  }
  return { qualifiers: qualifiers.map((q) => q.name), winner, reasons };
}

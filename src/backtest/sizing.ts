import type { ChainCostModel } from "./costs";
import { type SimResult, valueAtSize } from "./simulate";
import { mulberry32, quantile } from "./stats";

/**
 * Compounding sizing sweep. Draws random sequences of replayed trades (with
 * replacement) and walks one wallet through them, sizing each trade by a
 * rule on the equity at that moment. Every draw is re-priced at its actual
 * size: gas is a fixed dollar cost per swap, and impact grows with size.
 *
 * Simplifications: trades are independent draws taken one at a time (no
 * overlapping positions, no streak clustering), so real drawdowns can run
 * deeper than these do.
 */

export type SizingRule = { name: string; fraction: (equityUsd: number) => number };

export function bracketRule(name: string, brackets: { belowUsd: number; pct: number }[], topPct: number): SizingRule {
  const sorted = [...brackets].sort((a, b) => a.belowUsd - b.belowUsd);
  return {
    name,
    fraction: (eq) => (sorted.find((b) => eq < b.belowUsd)?.pct ?? topPct) / 100,
  };
}

export function flatRule(pct: number): SizingRule {
  return { name: `flat ${pct}%`, fraction: () => pct / 100 };
}

/** The user's per-chain capital brackets (2026-09-25), optionally with a different first bracket. */
export function userBrackets(firstPct = 40): SizingRule {
  return bracketRule(
    firstPct === 40 ? "user brackets (40% under $50)" : `user brackets, ${firstPct}% under $50`,
    [
      { belowUsd: 50, pct: firstPct },
      { belowUsd: 100, pct: 30 },
      { belowUsd: 250, pct: 20 },
      { belowUsd: 500, pct: 15 },
      { belowUsd: 1_000, pct: 10 },
      { belowUsd: 2_500, pct: 7.5 },
    ],
    5
  );
}

export interface SweepOptions {
  startUsd: number;
  trades: number;
  checkpoint: number; // report median equity here too (e.g. 50)
  paths: number;
  reachUsd: number;
  seed?: number;
}

export interface SweepResult {
  rule: string;
  medianAtCheckpoint: number;
  medianAtEnd: number;
  p10AtEnd: number;
  p90AtEnd: number;
  pBelowHalf: number; // ever below 50% of start
  pRuin: number; // ever below 10% of start
  pReach: number; // ever at or above reachUsd
}

export function sizingSweep(trades: { sim: SimResult; costs: ChainCostModel }[], rule: SizingRule, opts: SweepOptions): SweepResult {
  const rand = mulberry32(opts.seed ?? 5);
  const atCheckpoint: number[] = [];
  const atEnd: number[] = [];
  let belowHalf = 0;
  let ruin = 0;
  let reached = 0;
  for (let p = 0; p < opts.paths; p++) {
    let eq = opts.startUsd;
    let min = eq;
    let max = eq;
    for (let i = 1; i <= opts.trades; i++) {
      if (eq >= 0.01) {
        const t = trades[Math.floor(rand() * trades.length)];
        const size = eq * rule.fraction(eq);
        if (size > 0) eq += valueAtSize(t.sim, size, t.costs).netUsd;
        eq = Math.max(eq, 0);
      }
      min = Math.min(min, eq);
      max = Math.max(max, eq);
      if (i === opts.checkpoint) atCheckpoint.push(eq);
    }
    atEnd.push(eq);
    if (min < opts.startUsd * 0.5) belowHalf++;
    if (min < opts.startUsd * 0.1) ruin++;
    if (max >= opts.reachUsd) reached++;
  }
  const s = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const end = s(atEnd);
  return {
    rule: rule.name,
    medianAtCheckpoint: quantile(s(atCheckpoint), 0.5),
    medianAtEnd: quantile(end, 0.5),
    p10AtEnd: quantile(end, 0.1),
    p90AtEnd: quantile(end, 0.9),
    pBelowHalf: belowHalf / opts.paths,
    pRuin: ruin / opts.paths,
    pReach: reached / opts.paths,
  };
}

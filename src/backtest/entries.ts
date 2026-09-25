import type { Candle } from "./candles";
import type { UniverseCandidate } from "./universe";

/**
 * Entry plugins decide WHEN to buy a candidate (the fill model decides at
 * what price). A plugin sees history only through `closedBy(ts)`, the
 * candles that had fully closed by ts, so it can't peek at the future.
 */

export type EntryDecision = { ts: number; note?: string } | { skip: string };

export interface EntryContext {
  candidate: UniverseCandidate;
  closedBy: (ts: number) => Candle[];
}

export interface EntryStrategy {
  name: string;
  decide(ctx: EntryContext): EntryDecision;
}

export function historyView(candles: Candle[]): (ts: number) => Candle[] {
  return (ts) => {
    let lo = 0;
    let hi = candles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].t + candles[mid].d <= ts) lo = mid + 1;
      else hi = mid;
    }
    return candles.slice(0, lo);
  };
}

/** Buy at the candidate's decision time (TradeCandidate.createdAt), optionally later. */
export function atDecision(delayMinutes = 0): EntryStrategy {
  return {
    name: delayMinutes ? `at-decision+${delayMinutes}m` : "at-decision",
    decide: ({ candidate }) => ({ ts: candidate.createdAt + delayMinutes * 60 }),
  };
}

/** Buy when we actually bought (first trade's openedAt), for calibration. */
export function atActualEntry(): EntryStrategy {
  return {
    name: "actual-entry",
    decide: ({ candidate }) => {
      const openedAt = candidate.trades[0]?.openedAt;
      return openedAt ? { ts: openedAt } : { skip: "never traded" };
    },
  };
}

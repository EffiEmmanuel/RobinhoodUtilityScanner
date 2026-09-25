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

export interface SurvivorParams {
  checkHours: number; // look at the token this long after detection (6, 12, 24)
  minFractionOfPeak: number; // X: last close must be >= X * best close so far
  minVolumeUsd: number; // USD volume in the volumeLookbackHours before the check
  volumeLookbackHours: number;
  maxQuietMinutes: number; // the pool must have traded this recently at the check
  minPriceVsDecision: number; // liquidity-pull proxy: price must hold this share of the decision-time price
  breakoutLookbackHours: number; // the consolidation range: best close in this window before the check
  breakoutWindowHours: number; // how long after the check a close above that range may come
}

export const SURVIVOR_DEFAULTS: Omit<SurvivorParams, "checkHours" | "minFractionOfPeak" | "minVolumeUsd"> = {
  volumeLookbackHours: 2,
  maxQuietMinutes: 60,
  minPriceVsDecision: 0.2,
  breakoutLookbackHours: 3,
  breakoutWindowHours: 6,
};

/**
 * B3's survivor entry: skip the launch, then buy the tokens that are still
 * alive, near their highs, trading, and breaking out hours later. GeckoTerminal
 * has no liquidity history, so "liquidity not pulled" is read from price: a
 * pull shows up as a collapse, and the pool must still be trading. The peak
 * is the best close in the fetched history (from ~11h before detection), not
 * necessarily since the pool's creation for older tokens.
 */
export function survivor(p: SurvivorParams): EntryStrategy {
  const name = `survivor T+${p.checkHours}h X=${p.minFractionOfPeak} vol>=$${p.minVolumeUsd}/${p.volumeLookbackHours}h`;
  return {
    name,
    decide: ({ candidate, closedBy }) => {
      const check = candidate.createdAt + p.checkHours * 3_600;
      const hist = closedBy(check);
      if (!hist.length) return { skip: "no trades by the check" };
      const last = hist[hist.length - 1];
      if (check - (last.t + last.d) > p.maxQuietMinutes * 60) return { skip: "pool quiet at the check" };
      const peak = Math.max(...hist.map((c) => c.c));
      if (last.c < p.minFractionOfPeak * peak) return { skip: "too far below its peak" };
      const atDecision = [...hist].reverse().find((c) => c.t <= candidate.createdAt);
      if (atDecision && last.c < p.minPriceVsDecision * atDecision.c) return { skip: "collapsed since detection" };
      const volume = hist.filter((c) => c.t >= check - p.volumeLookbackHours * 3_600).reduce((a, c) => a + c.v, 0);
      if (volume < p.minVolumeUsd) return { skip: "volume faded" };
      const range = hist.filter((c) => c.t >= check - p.breakoutLookbackHours * 3_600);
      const rangeHigh = Math.max(...(range.length ? range : [last]).map((c) => c.c));
      // Every candle that closes inside the window is visible by the window's
      // end; taking the first that closes above the range, at its close time,
      // uses nothing that hadn't happened yet.
      const windowEnd = check + p.breakoutWindowHours * 3_600;
      const breakout = closedBy(windowEnd).find((c) => c.t >= check && c.c > rangeHigh);
      if (!breakout) return { skip: "no breakout" };
      return { ts: breakout.t + breakout.d, note: `broke ${rangeHigh.toPrecision(4)}` };
    },
  };
}

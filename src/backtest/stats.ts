import type { CostModel } from "./costs";
import { chainCosts } from "./costs";
import { type SimResult, valueAtSize } from "./simulate";

/** Deterministic PRNG so a report's CI doesn't wobble between reruns. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

/** Percentile bootstrap of the mean: 90% CI by default. */
export function bootstrapMeanCI(xs: number[], opts: { iterations?: number; confidence?: number; seed?: number } = {}): [number, number] {
  if (xs.length === 0) return [NaN, NaN];
  const iterations = opts.iterations ?? 10_000;
  const alpha = (1 - (opts.confidence ?? 0.9)) / 2;
  const rand = mulberry32(opts.seed ?? 7);
  const means = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < xs.length; j++) sum += xs[Math.floor(rand() * xs.length)];
    means[i] = sum / xs.length;
  }
  const sorted = Array.from(means).sort((a, b) => a - b);
  return [quantile(sorted, alpha), quantile(sorted, 1 - alpha)];
}

export interface TradeStats {
  n: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancyPct: number; // mean net return per trade, % of position
  expectancyCI90: [number, number];
  medianPct: number;
  profitFactor: number;
  grossExpectancyPct: number; // before gas
  totalNetUsd: number;
}

export function tradeStats(rows: { netPct: number; grossPct: number; netUsd: number }[], seed = 7): TradeStats {
  const net = rows.map((r) => r.netPct);
  const wins = net.filter((x) => x > 0);
  const losses = net.filter((x) => x <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  return {
    n: rows.length,
    winRate: rows.length ? wins.length / rows.length : NaN,
    avgWinPct: mean(wins),
    avgLossPct: mean(losses),
    expectancyPct: mean(net),
    expectancyCI90: bootstrapMeanCI(net, { seed }),
    medianPct: quantile([...net].sort((a, b) => a - b), 0.5),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : NaN,
    grossExpectancyPct: mean(rows.map((r) => r.grossPct)),
    totalNetUsd: rows.reduce((a, r) => a + r.netUsd, 0),
  };
}

export interface PortfolioOptions {
  startEquityUsd: number;
  sizePct: number; // of current equity, per entry
  maxConcurrent?: number;
  costs: CostModel;
}

export interface EquityPoint {
  ts: number;
  equityUsd: number;
}

export interface PortfolioResult {
  startEquityUsd: number;
  finalEquityUsd: number;
  returnPct: number;
  maxDrawdownPct: number;
  taken: number;
  skippedNoCash: number;
  skippedConcurrency: number;
  gasUsd: number;
  curve: EquityPoint[];
}

/**
 * One wallet, entries in time order, each sized at sizePct of equity at that
 * moment (cash plus open positions at cost), never a fixed dollar amount.
 * Sells return cash leg by leg at their own times.
 */
export function simulatePortfolio(trades: { chain: string; sim: SimResult }[], opts: PortfolioOptions): PortfolioResult {
  const events = trades.map((t, i) => ({ ts: t.sim.entryTs, trade: i })).sort((a, b) => a.ts - b.ts);

  let cash = opts.startEquityUsd;
  let atCost = 0;
  let gasTotal = 0;
  let taken = 0;
  let skippedNoCash = 0;
  let skippedConcurrency = 0;
  const open = new Map<number, number>(); // trade -> cost basis still open
  const pending: { ts: number; trade: number; proceeds: number; gas: number; costReleased: number }[] = [];
  const curve: EquityPoint[] = [{ ts: events[0]?.ts ?? 0, equityUsd: cash }];
  let peak = cash;
  let maxDd = 0;

  const record = (ts: number) => {
    const eq = cash + atCost;
    curve.push({ ts, equityUsd: eq });
    peak = Math.max(peak, eq);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - eq) / peak);
  };

  const settleUntil = (ts: number) => {
    pending.sort((a, b) => a.ts - b.ts);
    while (pending.length && pending[0].ts <= ts) {
      const p = pending.shift()!;
      cash += p.proceeds - p.gas;
      gasTotal += p.gas;
      atCost -= p.costReleased;
      const left = (open.get(p.trade) ?? 0) - p.costReleased;
      if (left <= 1e-9) open.delete(p.trade);
      else open.set(p.trade, left);
      record(p.ts);
    }
  };

  for (const ev of events) {
    settleUntil(ev.ts);
    const { chain, sim } = trades[ev.trade];
    if (opts.maxConcurrent !== undefined && open.size >= opts.maxConcurrent) {
      skippedConcurrency++;
      continue;
    }
    const costs = chainCosts(opts.costs, chain);
    const size = ((cash + atCost) * opts.sizePct) / 100;
    if (!(size > 0) || cash < size + costs.gasBuyUsd) {
      skippedNoCash++;
      continue;
    }
    const valued = valueAtSize(sim, size, costs);
    cash -= size + costs.gasBuyUsd;
    gasTotal += costs.gasBuyUsd;
    atCost += size;
    open.set(ev.trade, size);
    taken++;
    const fractions = sim.legs.map((l) => l.fraction);
    valued.legs.forEach((leg, i) => pending.push({ ts: leg.ts, trade: ev.trade, proceeds: leg.proceedsUsd, gas: leg.gasUsd, costReleased: size * fractions[i] }));
    record(ev.ts);
  }
  settleUntil(Infinity);
  const final = cash + atCost;
  return {
    startEquityUsd: opts.startEquityUsd,
    finalEquityUsd: final,
    returnPct: (final / opts.startEquityUsd - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    taken,
    skippedNoCash,
    skippedConcurrency,
    gasUsd: gasTotal,
    curve,
  };
}

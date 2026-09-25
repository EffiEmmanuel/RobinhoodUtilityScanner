import { type ChainCostModel, type CostModel, DEFAULT_COSTS, buyImpactPct, liquidityAt, sellImpactPct } from "./costs";
import type { PriceSeries } from "./marketData";
import { refPrice } from "./simulate";
import { mean, quantile } from "./stats";
import type { ActualTrade, UniverseCandidate } from "./universe";

/**
 * Measures what our real swaps cost against the same candle reference price
 * the replay fills against. Recorded slippagePercent is always 0 in the DB,
 * so fill price vs market is the only honest measure.
 */

export interface FillSample {
  chain: string;
  tradeId: string;
  symbol: string | null;
  side: "BUY" | "SELL";
  ts: number;
  usd: number;
  actualPrice: number;
  refPrice: number;
  costPct: number; // buy: premium over ref; sell: discount under ref
  impactPct: number; // modeled constant-product impact at that size
  residualPct: number; // costPct - impactPct: what the slippage parameter must cover
}

export function fillPrice(e: { usdValue: number | null; tokenAmount: number | null; actualPrice: number | null }): number | undefined {
  if (e.usdValue && e.usdValue > 0 && e.tokenAmount && e.tokenAmount > 0) return e.usdValue / e.tokenAmount;
  return e.actualPrice && e.actualPrice > 0 ? e.actualPrice : undefined;
}

export function fillSamples(candidate: UniverseCandidate, trade: ActualTrade, series: PriceSeries): FillSample[] {
  const out: FillSample[] = [];
  const entryRef = trade.openedAt ? refPrice(series.candles, trade.openedAt) : undefined;
  for (const e of trade.executions) {
    const actual = fillPrice(e);
    const ref = refPrice(series.candles, e.ts);
    if (!actual || !ref || !(ref.price > 0) || !(e.usdValue && e.usdValue > 0)) continue;
    const costPct = e.type === "BUY" ? (actual / ref.price - 1) * 100 : (1 - actual / ref.price) * 100;
    const liq = liquidityAt(trade.entryLiquidityUsd ?? undefined, entryRef?.price ?? ref.price, ref.price);
    const impactPct = e.type === "BUY" ? buyImpactPct(e.usdValue, liq) : sellImpactPct(e.usdValue, liq);
    out.push({
      chain: candidate.chain,
      tradeId: trade.id,
      symbol: candidate.symbol,
      side: e.type,
      ts: e.ts,
      usd: e.usdValue,
      actualPrice: actual,
      refPrice: ref.price,
      costPct,
      impactPct,
      residualPct: costPct - impactPct,
    });
  }
  return out;
}

export interface SideCalibration {
  n: number;
  p25: number;
  median: number;
  p75: number;
  mean: number;
}

export interface ChainCalibration {
  buy: SideCalibration;
  sell: SideCalibration;
  gasBuyUsd: { n: number; mean: number; median: number };
  gasSellUsd: { n: number; mean: number; median: number };
  firstMarkPct: SideCalibration; // live's own round-trip read: first mark vs entry fill
}

function side(xs: number[]): SideCalibration {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p25: quantile(s, 0.25), median: quantile(s, 0.5), p75: quantile(s, 0.75), mean: mean(s) };
}

// Samples whose price is off from the candle by more than this are the
// candle series disagreeing with our pool (wrong pool, stale index), not a
// fill cost; they'd swamp a 20-sample median.
const MAX_PLAUSIBLE_COST_PCT = 60;

export function calibrateChain(samples: FillSample[], trades: ActualTrade[]): ChainCalibration {
  const ok = samples.filter((s) => Math.abs(s.costPct) <= MAX_PLAUSIBLE_COST_PCT);
  const gas = (type: "BUY" | "SELL") => {
    const xs = trades.flatMap((t) => t.executions.filter((e) => e.type === type && e.gasCostUsd != null).map((e) => e.gasCostUsd!));
    const s = [...xs].sort((a, b) => a - b);
    return { n: s.length, mean: mean(s), median: quantile(s, 0.5) };
  };
  const firstMarks = trades.flatMap((t) =>
    t.firstMark && t.entryPriceUsd && t.openedAt && t.firstMark.ts - t.openedAt <= 60 ? [(t.firstMark.priceUsd / t.entryPriceUsd - 1) * 100] : []
  );
  return {
    buy: side(ok.filter((s) => s.side === "BUY").map((s) => s.residualPct)),
    sell: side(ok.filter((s) => s.side === "SELL").map((s) => s.residualPct)),
    gasBuyUsd: gas("BUY"),
    gasSellUsd: gas("SELL"),
    firstMarkPct: side(firstMarks),
  };
}

// A chain with fewer fills than this borrows the all-chain slippage (Solana
// had 8 buys and 8 sells on 2026-09-25): 8 samples can't pin a percentile.
export const MIN_CHAIN_FILLS = 30;

/**
 * Median measured cost per side, floored at zero; gas at its per-chain mean
 * (fat right tail). Median, not p75, because the replay's intrabar path
 * already fills every stop at the candle's low. Median costs with that path
 * came within ~$4 of the 41 post-09-12 non-write-off live trades (-$26.06
 * simulated vs -$22.01 actual); p75 on top of it overshot by ~$15. p75
 * stays available as a stress test.
 */
export function costModelFrom(calibration: Record<string, ChainCalibration>, pick: "median" | "p75" = "median"): CostModel {
  const model: CostModel = { ...DEFAULT_COSTS };
  const pooled = calibration.all;
  for (const [chain, cal] of Object.entries(calibration)) {
    if (chain === "all") continue;
    const fallback = DEFAULT_COSTS[chain] ?? DEFAULT_COSTS.robinhood;
    const slip = (s: SideCalibration, poolSide: SideCalibration | undefined, d: number) => {
      const src = s.n >= MIN_CHAIN_FILLS || !poolSide ? s : poolSide;
      return src.n >= 3 && Number.isFinite(src[pick]) ? Math.max(0, src[pick]) : d;
    };
    const m: ChainCostModel = {
      entrySlippagePct: slip(cal.buy, pooled?.buy, fallback.entrySlippagePct),
      exitSlippagePct: slip(cal.sell, pooled?.sell, fallback.exitSlippagePct),
      gasBuyUsd: cal.gasBuyUsd.n ? cal.gasBuyUsd.mean : fallback.gasBuyUsd,
      gasSellUsd: cal.gasSellUsd.n ? cal.gasSellUsd.mean : fallback.gasSellUsd,
    };
    model[chain] = m;
  }
  return model;
}

/** Buckets live exitReason strings (free text) so sim vs actual can be cross-tabbed. */
export function exitCategory(reason: string | null | undefined): string {
  const r = (reason ?? "").toLowerCase();
  if (!r) return "unknown";
  if (r.includes("written off") || r.includes("cannot transfer") || r.includes("honeypot")) return "write-off";
  if (r.includes("external/manual wallet exit")) return "external";
  if (r.includes("liquidity dropped")) return "liquidity-pull";
  if (r.includes("catastrophic")) return "catastrophic-stop";
  if (r.includes("max tolerated loss") || r.includes("max loss")) return "max-loss-stop";
  if (r.includes("invalidation")) return "invalidation";
  if (r.includes("retraced") || r.includes("trailing")) return "trailing";
  if (r.includes("ai strategy") || r.includes("ai_strategy")) return "ai-exit";
  if (r.includes("profit target") || r.includes("partial_profit")) return "profit-target";
  if (r.includes("max hold") || r.includes("held") || r.includes("time_exit")) return "time";
  if (r.includes("window_end") || r.includes("data_end")) return "held-to-end";
  if (r.includes("sell pressure") || r.includes("volume faded") || r.includes("buy pressure")) return "flow-exit";
  if (r.includes("fully exited via partial")) return "partials";
  return "other";
}

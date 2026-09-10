import { db } from "../db";
import { captureMarketSnapshot } from "../research/market";
import type { MarketPair } from "../dex/types";

/**
 * DexScreener's public API has no OHLCV/candles endpoint — this module builds
 * a lightweight substitute from our own repeated MarketSnapshot polling of
 * active trade candidates (see pollCandidateMarkets in orchestrator.ts). This
 * means indicators are only as good as how long we've been watching a given
 * token; brand-new candidates will have thin history, which every feature
 * below reports honestly via `dataPoints`/`confidence` rather than pretending
 * to have a real 14-period RSI from 2 data points.
 */

export async function pollCandidateMarket(tokenId: string, chain: string, address: string) {
  return captureMarketSnapshot(tokenId, chain, address);
}

interface SnapshotPoint {
  mcap: number;
  liquidity: number | null;
  volume5m: number | null;
  capturedAt: Date;
}

async function getSnapshotSeries(tokenId: string, limit = 200): Promise<SnapshotPoint[]> {
  const rows = await db.marketSnapshot.findMany({
    where: { tokenId, marketCapUsd: { not: null } },
    orderBy: { capturedAt: "asc" },
    take: limit,
  });
  return rows
    .filter((r) => r.marketCapUsd !== null)
    .map((r) => ({ mcap: r.marketCapUsd as number, liquidity: r.liquidityUsd, volume5m: r.volume5m, capturedAt: r.capturedAt }));
}

function ema(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function simpleRsi(values: number[], period: number): number | undefined {
  if (values.length < period + 1) return undefined;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  if (gains + losses === 0) return 50;
  const rs = gains / (losses || 1e-9);
  return 100 - 100 / (1 + rs);
}

export type Confidence = "LOW" | "MEDIUM" | "HIGH";
export type Trend = "RISING" | "FALLING" | "FLAT";

export interface TechnicalFeatures {
  dataPoints: number;
  confidence: Confidence;
  currentMcap?: number;
  ema9?: number;
  ema20?: number;
  rsi14Like?: number;
  // Named for what they're actually used for now (see
  // formatTechnicalFeaturesForPositionStrategy) — the observed high/low since
  // we started watching this token, which is the closest thing to real
  // support/resistance available without an OHLCV/candles API.
  swingHighMcap?: number;
  swingLowMcap?: number;
  drawdownFromHighPercent?: number;
  distanceFromLowPercent?: number;
  mcapVelocityPercentPerHour?: number;
  liquidityToMcapRatio?: number;
  buySellRatio1h?: number;
  buySellRatio5m?: number;
  priceChange5mPercent?: number;
  priceChange1hPercent?: number;
  // Volume itself (not just price) tells you whether a move has real
  // participation behind it — a price pump on fading volume is a very
  // different signal than one on rising volume.
  volume5mNow?: number;
  volume1hNow?: number;
  volume6hNow?: number;
  volume24hNow?: number;
  volume5mTrend?: Trend; // recent 5m-volume readings vs. slightly older ones, from our own snapshot history
}

function confidenceForDataPoints(n: number): Confidence {
  if (n >= 20) return "HIGH";
  if (n >= 6) return "MEDIUM";
  return "LOW";
}

function volumeTrend(volumes: number[]): Trend | undefined {
  if (volumes.length < 4) return undefined; // too little history to call a trend, not just noise
  const mid = Math.floor(volumes.length / 2);
  const olderAvg = volumes.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const recentAvg = volumes.slice(mid).reduce((a, b) => a + b, 0) / (volumes.length - mid);
  if (olderAvg === 0) return recentAvg > 0 ? "RISING" : "FLAT";
  const change = (recentAvg - olderAvg) / olderAvg;
  if (change >= 0.15) return "RISING";
  if (change <= -0.15) return "FALLING";
  return "FLAT";
}

export async function computeTechnicalFeatures(tokenId: string, latestPair: MarketPair | undefined): Promise<TechnicalFeatures> {
  const series = await getSnapshotSeries(tokenId);
  const mcaps = series.map((s) => s.mcap);
  const volumes = series.map((s) => s.volume5m).filter((v): v is number => v !== null);
  const confidence = confidenceForDataPoints(series.length);

  const features: TechnicalFeatures = {
    dataPoints: series.length,
    confidence,
    currentMcap: latestPair?.marketCapUsd ?? mcaps[mcaps.length - 1],
    liquidityToMcapRatio:
      latestPair?.liquidityUsd !== undefined && latestPair?.marketCapUsd
        ? latestPair.liquidityUsd / latestPair.marketCapUsd
        : undefined,
    priceChange5mPercent: latestPair?.priceChange5m,
    priceChange1hPercent: latestPair?.priceChange1h,
    volume5mNow: latestPair?.volume5m,
    volume1hNow: latestPair?.volume1h,
    volume6hNow: latestPair?.volume6h,
    volume24hNow: latestPair?.volume24h,
    volume5mTrend: volumeTrend(volumes),
  };

  if (latestPair?.buys1h !== undefined || latestPair?.sells1h !== undefined) {
    const total = (latestPair.buys1h ?? 0) + (latestPair.sells1h ?? 0);
    features.buySellRatio1h = total > 0 ? (latestPair.buys1h ?? 0) / total : undefined;
  }
  if (latestPair?.buys5m !== undefined || latestPair?.sells5m !== undefined) {
    const total = (latestPair.buys5m ?? 0) + (latestPair.sells5m ?? 0);
    features.buySellRatio5m = total > 0 ? (latestPair.buys5m ?? 0) / total : undefined;
  }

  if (mcaps.length >= 2) {
    const swingHigh = Math.max(...mcaps);
    const swingLow = Math.min(...mcaps);
    features.swingHighMcap = swingHigh;
    features.swingLowMcap = swingLow;
    const current = features.currentMcap ?? mcaps[mcaps.length - 1];
    features.drawdownFromHighPercent = swingHigh > 0 ? ((current - swingHigh) / swingHigh) * 100 : undefined;
    features.distanceFromLowPercent = swingLow > 0 ? ((current - swingLow) / swingLow) * 100 : undefined;

    const first = series[0];
    const last = series[series.length - 1];
    const hoursElapsed = (last.capturedAt.getTime() - first.capturedAt.getTime()) / 3_600_000;
    if (hoursElapsed > 0.05 && first.mcap > 0) {
      features.mcapVelocityPercentPerHour = ((last.mcap - first.mcap) / first.mcap / hoursElapsed) * 100;
    }
  }

  features.ema9 = ema(mcaps, 9);
  features.ema20 = ema(mcaps, 20);
  features.rsi14Like = simpleRsi(mcaps, 14);

  return features;
}

export function formatTechnicalFeaturesForPrompt(f: TechnicalFeatures): string {
  const lines = [
    `Data points collected so far: ${f.dataPoints} (confidence: ${f.confidence} — fewer than ~6 snapshots means these numbers are not yet reliable)`,
    f.currentMcap !== undefined ? `Current market cap: $${Math.round(f.currentMcap).toLocaleString()}` : undefined,
    f.swingHighMcap !== undefined ? `Observed high (since we started watching): $${Math.round(f.swingHighMcap).toLocaleString()}` : undefined,
    f.swingLowMcap !== undefined ? `Observed low (since we started watching): $${Math.round(f.swingLowMcap).toLocaleString()}` : undefined,
    f.drawdownFromHighPercent !== undefined ? `Distance from observed high: ${f.drawdownFromHighPercent.toFixed(1)}%` : undefined,
    f.distanceFromLowPercent !== undefined ? `Distance from observed low: +${f.distanceFromLowPercent.toFixed(1)}%` : undefined,
    f.mcapVelocityPercentPerHour !== undefined ? `Market cap velocity: ${f.mcapVelocityPercentPerHour.toFixed(1)}%/hour` : undefined,
    f.ema9 !== undefined ? `EMA(9) on market cap: $${Math.round(f.ema9).toLocaleString()}` : "EMA(9): insufficient history yet",
    f.ema20 !== undefined ? `EMA(20) on market cap: $${Math.round(f.ema20).toLocaleString()}` : "EMA(20): insufficient history yet",
    f.rsi14Like !== undefined ? `RSI(14)-like momentum: ${f.rsi14Like.toFixed(0)}/100` : "RSI: insufficient history yet",
    f.liquidityToMcapRatio !== undefined ? `Liquidity/mcap ratio: ${f.liquidityToMcapRatio.toFixed(3)}` : undefined,
    f.buySellRatio1h !== undefined ? `1h buy ratio: ${(f.buySellRatio1h * 100).toFixed(0)}%` : undefined,
    f.buySellRatio5m !== undefined ? `5m buy ratio: ${(f.buySellRatio5m * 100).toFixed(0)}%` : undefined,
    f.priceChange5mPercent !== undefined ? `5m price change: ${f.priceChange5mPercent.toFixed(1)}%` : undefined,
    f.priceChange1hPercent !== undefined ? `1h price change: ${f.priceChange1hPercent.toFixed(1)}%` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * Richer framing for the position-strategy AI review (trading/positionStrategy.ts)
 * — same underlying numbers as the entry-planning formatter above, but named
 * as what they're actually used for (support/resistance, volume trend) since
 * this is consulted throughout the life of a trade, not just once at entry.
 */
export function formatTechnicalFeaturesForPositionStrategy(f: TechnicalFeatures): string {
  const volLines = [
    f.volume5mNow !== undefined ? `5m volume: $${Math.round(f.volume5mNow).toLocaleString()}` : undefined,
    f.volume1hNow !== undefined ? `1h volume: $${Math.round(f.volume1hNow).toLocaleString()}` : undefined,
    f.volume6hNow !== undefined ? `6h volume: $${Math.round(f.volume6hNow).toLocaleString()}` : undefined,
    f.volume24hNow !== undefined ? `24h volume: $${Math.round(f.volume24hNow).toLocaleString()}` : undefined,
    f.volume5mTrend
      ? `5m-volume trend (recent readings vs. slightly older ones): ${f.volume5mTrend}`
      : "5m-volume trend: not enough history yet to call a trend",
  ].filter(Boolean);

  const lines = [
    `Data points collected so far: ${f.dataPoints} (confidence: ${f.confidence} — below ~6 snapshots, treat every number here as provisional)`,
    f.currentMcap !== undefined ? `Current market cap: $${Math.round(f.currentMcap).toLocaleString()}` : undefined,
    f.swingHighMcap !== undefined
      ? `Nearest resistance (highest mcap observed since we started watching): $${Math.round(f.swingHighMcap).toLocaleString()}${f.drawdownFromHighPercent !== undefined ? ` (currently ${f.drawdownFromHighPercent.toFixed(1)}% from it)` : ""}`
      : undefined,
    f.swingLowMcap !== undefined
      ? `Nearest support (lowest mcap observed since we started watching): $${Math.round(f.swingLowMcap).toLocaleString()}${f.distanceFromLowPercent !== undefined ? ` (currently +${f.distanceFromLowPercent.toFixed(1)}% above it)` : ""}`
      : undefined,
    f.mcapVelocityPercentPerHour !== undefined ? `Market cap velocity: ${f.mcapVelocityPercentPerHour.toFixed(1)}%/hour` : undefined,
    f.ema9 !== undefined && f.ema20 !== undefined
      ? `EMA(9) $${Math.round(f.ema9).toLocaleString()} vs EMA(20) $${Math.round(f.ema20).toLocaleString()} — ${f.ema9 > f.ema20 ? "short-term trend above long-term (bullish bias)" : "short-term trend below long-term (bearish bias)"}`
      : "EMA(9)/EMA(20): insufficient history yet",
    f.rsi14Like !== undefined ? `RSI(14)-like momentum: ${f.rsi14Like.toFixed(0)}/100 (>70 stretched to the upside, <30 stretched to the downside, as a rough guide only)` : "RSI: insufficient history yet",
    ...volLines,
    f.buySellRatio1h !== undefined ? `1h buy ratio: ${(f.buySellRatio1h * 100).toFixed(0)}%` : undefined,
    f.buySellRatio5m !== undefined ? `5m buy ratio: ${(f.buySellRatio5m * 100).toFixed(0)}%` : undefined,
    f.priceChange5mPercent !== undefined ? `5m price change: ${f.priceChange5mPercent.toFixed(1)}%` : undefined,
    f.priceChange1hPercent !== undefined ? `1h price change: ${f.priceChange1hPercent.toFixed(1)}%` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}

import { getAddress } from "viem";
import { db } from "../db";
import { logger } from "../logger";
import { captureMarketSnapshot } from "../research/market";
import type { MarketPair } from "../dex/types";
import type { RecentPriceRange } from "./conservativeMode";
import { getPublicClient } from "./live/wallet";
import { getOnChainSwapHistory } from "./live/swapHistory";

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

/**
 * Where the current mcap sits within our OWN snapshots from the last few
 * minutes — conservative mode's chasing / falling-knife check (see
 * conservativeMode.ts). Deliberately not DexScreener's own 5m change, which
 * lags on this chain: BLACKHOLE's read -9% while these snapshots showed a +46%
 * run-up.
 */
export async function getRecentMcapRange(
  tokenId: string,
  windowMinutes: number,
  currentMcap: number | undefined
): Promise<RecentPriceRange | undefined> {
  if (!currentMcap) return undefined;
  const rows = await db.marketSnapshot.findMany({
    where: { tokenId, marketCapUsd: { not: null }, capturedAt: { gte: new Date(Date.now() - windowMinutes * 60_000) } },
    select: { marketCapUsd: true },
  });
  const mcaps = rows.map((r) => r.marketCapUsd as number);
  const low = Math.min(currentMcap, ...mcaps);
  const high = Math.max(currentMcap, ...mcaps);
  return { snapshotCount: mcaps.length, runUpPercent: (currentMcap / low - 1) * 100, drawdownPercent: (1 - currentMcap / high) * 100 };
}

/**
 * The last two market-cap readings for a token, oldest first — used to check
 * whether a still-falling price has actually paused (see
 * conservativeMode.ts's hasPriceStabilized). Deliberately raw, ungapped
 * snapshots rather than a windowed range — what matters here is only the
 * most recent tick-over-tick direction, not how far it's moved overall.
 */
export async function getRecentMcapTicks(tokenId: string, count = 2): Promise<number[]> {
  const rows = await db.marketSnapshot.findMany({
    where: { tokenId, marketCapUsd: { not: null } },
    orderBy: { capturedAt: "desc" },
    take: count,
  });
  return rows.map((r) => r.marketCapUsd as number).reverse();
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
export type SupportResistanceSource = "ONCHAIN_HISTORY" | "SNAPSHOT_POLLING";

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
  supportResistanceSource: SupportResistanceSource;
  onchainSupportStale?: boolean;
  onchainDataPoints?: number;
  drawdownFromHighPercent?: number;
  distanceFromLowPercent?: number;
  mcapVelocityPercentPerHour?: number;
  liquidityToMcapRatio?: number;
  liquidityChangeSinceFirstSnapshotPercent?: number;
  liquidityRecentTrend?: Trend;
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

function numericTrend(values: number[]): Trend | undefined {
  if (values.length < 4) return undefined;
  const mid = Math.floor(values.length / 2);
  const olderAvg = values.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const recentAvg = values.slice(mid).reduce((a, b) => a + b, 0) / (values.length - mid);
  if (olderAvg === 0) return recentAvg > 0 ? "RISING" : "FLAT";
  const change = (recentAvg - olderAvg) / olderAvg;
  if (change >= 0.12) return "RISING";
  if (change <= -0.12) return "FALLING";
  return "FLAT";
}

export async function computeTechnicalFeatures(tokenId: string, latestPair: MarketPair | undefined, tokenAddress: string): Promise<TechnicalFeatures> {
  const series = await getSnapshotSeries(tokenId);
  const mcaps = series.map((s) => s.mcap);
  const volumes = series.map((s) => s.volume5m).filter((v): v is number => v !== null);
  const liquidities = series.map((s) => s.liquidity).filter((v): v is number => v !== null && v > 0);
  const confidence = confidenceForDataPoints(series.length);

  const features: TechnicalFeatures = {
    dataPoints: series.length,
    confidence,
    supportResistanceSource: "SNAPSHOT_POLLING",
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
    liquidityRecentTrend: numericTrend(liquidities),
  };
  if (liquidities.length >= 2 && liquidities[0] > 0) {
    features.liquidityChangeSinceFirstSnapshotPercent = ((liquidities[liquidities.length - 1] - liquidities[0]) / liquidities[0]) * 100;
  }

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
    applySwingDerivedPercentages(features, current);

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

  try {
    const onchain = await getOnChainSwapHistory(getPublicClient(), getAddress(tokenAddress), features.currentMcap, latestPair?.priceUsd);
    if (onchain?.swingLowMcap !== undefined && onchain?.swingHighMcap !== undefined) {
      features.swingHighMcap = onchain.swingHighMcap;
      features.swingLowMcap = onchain.swingLowMcap;
      applySwingDerivedPercentages(features, features.currentMcap);
      features.supportResistanceSource = "ONCHAIN_HISTORY";
      features.onchainSupportStale = onchain.stale;
      features.onchainDataPoints = onchain.dataPoints;
    }
  } catch (err) {
    logger.warn({ tokenAddress, err: String(err) }, "on-chain swap-history lookup failed — falling back to snapshot-derived support/resistance");
  }

  return features;
}

function applySwingDerivedPercentages(features: TechnicalFeatures, current: number | undefined): void {
  features.drawdownFromHighPercent =
    current !== undefined && features.swingHighMcap !== undefined && features.swingHighMcap > 0
      ? ((current - features.swingHighMcap) / features.swingHighMcap) * 100
      : undefined;
  features.distanceFromLowPercent =
    current !== undefined && features.swingLowMcap !== undefined && features.swingLowMcap > 0
      ? ((current - features.swingLowMcap) / features.swingLowMcap) * 100
      : undefined;
}

/**
 * Shared by both the entry-planning AI (trading/planning.ts, deciding
 * BUY_NOW/WAIT_FOR_ENTRY/WATCH_ONLY) and the position-strategy AI
 * (trading/positionStrategy.ts, managing an already-open trade) — these used
 * to be two separate formatters, and the entry-planning one gave the model
 * only raw EMA/RSI numbers with no interpretation while the position-strategy
 * one explicitly labeled swing-low/high as support/resistance and called out
 * the EMA9/EMA20 crossover as bullish/bearish bias. That asymmetry meant the
 * model deciding whether to buy had strictly weaker signal than the model
 * managing the same trade five minutes later — confirmed live: a token that
 * had already pulled back from its high and was actively reclaiming that
 * support (green candles, +7% on 5m) still got planned as WAIT_FOR_ENTRY for
 * a deeper pullback, because nothing in its prompt named the pattern it was
 * looking at. One formatter now, used everywhere.
 */
export function formatTechnicalFeaturesForPrompt(f: TechnicalFeatures): string {
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
    f.supportResistanceSource === "ONCHAIN_HISTORY"
      ? `Support/resistance source: real on-chain Swap history (${f.onchainDataPoints ?? "unknown"} swaps${f.onchainSupportStale ? ", cached/stale after refresh failure" : ""})`
      : "Support/resistance source: our own polling snapshots only, not full on-chain history",
    f.swingHighMcap !== undefined
      ? `${f.supportResistanceSource === "ONCHAIN_HISTORY" ? "Nearest resistance (highest reconstructed on-chain mcap)" : "Highest mcap observed since we started watching"}: $${Math.round(f.swingHighMcap).toLocaleString()}${f.drawdownFromHighPercent !== undefined ? ` (currently ${f.drawdownFromHighPercent.toFixed(1)}% from it)` : ""}`
      : undefined,
    f.swingLowMcap !== undefined
      ? `${f.supportResistanceSource === "ONCHAIN_HISTORY" ? "Nearest support (lowest reconstructed on-chain mcap)" : "Lowest mcap observed since we started watching"}: $${Math.round(f.swingLowMcap).toLocaleString()}${f.distanceFromLowPercent !== undefined ? ` (currently +${f.distanceFromLowPercent.toFixed(1)}% above it)` : ""}`
      : undefined,
    f.mcapVelocityPercentPerHour !== undefined ? `Market cap velocity: ${f.mcapVelocityPercentPerHour.toFixed(1)}%/hour` : undefined,
    f.ema9 !== undefined && f.ema20 !== undefined
      ? `EMA(9) $${Math.round(f.ema9).toLocaleString()} vs EMA(20) $${Math.round(f.ema20).toLocaleString()} — ${f.ema9 > f.ema20 ? "short-term trend above long-term (bullish bias)" : "short-term trend below long-term (bearish bias)"}`
      : "EMA(9)/EMA(20): insufficient history yet",
    f.rsi14Like !== undefined ? `RSI(14)-like momentum: ${f.rsi14Like.toFixed(0)}/100 (>70 stretched to the upside, <30 stretched to the downside, as a rough guide only)` : "RSI: insufficient history yet",
    ...volLines,
    f.liquidityToMcapRatio !== undefined ? `Liquidity/mcap ratio: ${f.liquidityToMcapRatio.toFixed(3)}` : undefined,
    f.liquidityChangeSinceFirstSnapshotPercent !== undefined
      ? `Liquidity change since first snapshot: ${f.liquidityChangeSinceFirstSnapshotPercent.toFixed(1)}%${f.liquidityRecentTrend ? ` (${f.liquidityRecentTrend})` : ""}`
      : undefined,
    f.buySellRatio1h !== undefined ? `1h buy ratio: ${(f.buySellRatio1h * 100).toFixed(0)}%` : undefined,
    f.buySellRatio5m !== undefined ? `5m buy ratio: ${(f.buySellRatio5m * 100).toFixed(0)}%` : undefined,
    f.priceChange5mPercent !== undefined ? `5m price change: ${f.priceChange5mPercent.toFixed(1)}%` : undefined,
    f.priceChange1hPercent !== undefined ? `1h price change: ${f.priceChange1hPercent.toFixed(1)}%` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}

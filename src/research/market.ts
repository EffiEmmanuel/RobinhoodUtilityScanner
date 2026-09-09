import { fetchMarketForToken } from "../dex/client";
import type { MarketSummary } from "../dex/types";
import { logger } from "../logger";
import { db } from "../db";

export async function researchMarket(chain: string, address: string): Promise<MarketSummary> {
  try {
    return await fetchMarketForToken(chain, address);
  } catch (err) {
    logger.warn({ chain, address, err: String(err) }, "market research failed");
    return { pairs: [] };
  }
}

/**
 * Fetches current market data and persists a MarketSnapshot row. Used both by
 * the one-shot research run and by the trading extension's repeated polling
 * of active trade candidates (see src/trading/marketAnalysis.ts) — the latter
 * is what builds up the price/volume history technical indicators need,
 * since DexScreener's public API has no OHLCV/candles endpoint.
 */
export async function captureMarketSnapshot(tokenId: string, chain: string, address: string): Promise<MarketSummary> {
  const market = await researchMarket(chain, address);
  const p = market.primaryPair;
  if (p) {
    await db.marketSnapshot.create({
      data: {
        tokenId,
        priceUsd: p.priceUsd,
        marketCapUsd: p.marketCapUsd,
        fdvUsd: p.fdvUsd,
        liquidityUsd: p.liquidityUsd,
        volume5m: p.volume5m,
        volume1h: p.volume1h,
        volume6h: p.volume6h,
        volume24h: p.volume24h,
        buys5m: p.buys5m,
        sells5m: p.sells5m,
        buys1h: p.buys1h,
        sells1h: p.sells1h,
        pairCreatedAt: p.pairCreatedAt,
      },
    });
  }
  return market;
}

export function formatMarketForPrompt(summary: MarketSummary): string {
  const p = summary.primaryPair;
  if (!p) return "No market/pair data was available yet (token may have no liquidity pool).";
  const ageHours = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt.getTime()) / 3_600_000 : undefined;
  const lines = [
    `Primary DEX: ${p.dexId}`,
    p.priceUsd !== undefined ? `Price USD: $${p.priceUsd}` : undefined,
    p.marketCapUsd !== undefined ? `Market cap: $${Math.round(p.marketCapUsd).toLocaleString()}` : undefined,
    p.fdvUsd !== undefined ? `FDV: $${Math.round(p.fdvUsd).toLocaleString()}` : undefined,
    p.liquidityUsd !== undefined ? `Liquidity: $${Math.round(p.liquidityUsd).toLocaleString()}` : undefined,
    p.volume5m !== undefined ? `5m volume: $${Math.round(p.volume5m).toLocaleString()}` : undefined,
    p.volume1h !== undefined ? `1h volume: $${Math.round(p.volume1h).toLocaleString()}` : undefined,
    p.buys5m !== undefined || p.sells5m !== undefined ? `5m buys/sells: ${p.buys5m ?? 0}/${p.sells5m ?? 0}` : undefined,
    p.buys1h !== undefined || p.sells1h !== undefined ? `1h buys/sells: ${p.buys1h ?? 0}/${p.sells1h ?? 0}` : undefined,
    ageHours !== undefined ? `Pair age: ${ageHours.toFixed(1)} hours` : undefined,
    summary.pairs.length > 1 ? `Total pools found: ${summary.pairs.length}` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}

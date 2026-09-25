import { type Candle, type GeckoTerminalClient, mergePages, stitchSeries } from "./candles";
import type { UniverseCandidate } from "./universe";

/**
 * Builds one continuous USD price series for a candidate's token: 1m candles
 * from just before each anchor (decision time, actual entry) to ~15h after,
 * 5m candles out to FORWARD_HOURS, and a jump to the graduated pool when the
 * decision-time pool was a bonding curve that later migrated.
 */

export const FORWARD_HOURS = 72;
const FINE_LIMIT = 1000;
const FINE_LOOKBACK_S = 3_600;

// Launchpad bonding curves. Trading moves to a new pool at graduation, so the
// decision-time pool's candles just stop.
const BONDING_CURVE_DEXES = new Set(["pumpfun", "pump-fun", "meteoradbc", "meteora-dbc", "launchlab", "raydium-launchlab", "flapsh", "up", "moonshot", "boop"]);

export interface PriceSeries {
  candles: Candle[];
  pools: string[];
  coverageEnd: number; // unix seconds; nothing is known past this
  note?: string;
}

export function seriesAnchors(c: UniverseCandidate): number[] {
  const anchors = [c.createdAt];
  for (const t of c.trades) if (t.openedAt && Math.abs(t.openedAt - c.createdAt) > 6 * 3_600) anchors.push(t.openedAt);
  return anchors;
}

async function poolSeries(
  client: GeckoTerminalClient,
  network: string,
  pool: string,
  token: string,
  anchors: number[],
  nowS: number,
  want: { fine: boolean; coarse: boolean }
): Promise<{ candles: Candle[]; ok: boolean; coveredTo: number }> {
  const finePages: Candle[][] = [];
  let fineFrom = Infinity;
  let fineTo = -Infinity;
  let ok = true;
  let coveredTo = -Infinity;
  for (const anchor of want.fine ? anchors : []) {
    const before = anchor - FINE_LOOKBACK_S + FINE_LIMIT * 60;
    const page = await client.ohlcv({ network, pool, token, timeframe: "1m", beforeTs: before, limit: FINE_LIMIT });
    if (page === undefined) {
      ok = false;
      continue;
    }
    coveredTo = Math.max(coveredTo, Math.min(before, nowS));
    if (!page.length) continue;
    finePages.push(page);
    fineFrom = Math.min(fineFrom, page.length < FINE_LIMIT ? 0 : page[0].t);
    fineTo = Math.max(fineTo, Math.min(before, nowS));
  }
  let coarse: Candle[] | undefined = [];
  if (want.coarse) {
    const coarseBefore = Math.max(...anchors) + FORWARD_HOURS * 3_600;
    coarse = await client.ohlcv({ network, pool, token, timeframe: "5m", beforeTs: coarseBefore, limit: 1000 });
    if (coarse === undefined) ok = false;
    else coveredTo = Math.max(coveredTo, Math.min(coarseBefore, nowS));
  }
  const fineSeries = mergePages(finePages);
  return {
    candles: stitchSeries(fineSeries, coarse ?? [], fineSeries.length ? fineFrom : undefined, fineSeries.length ? fineTo : undefined),
    ok,
    coveredTo,
  };
}

/**
 * The public API allows ~10 requests/min, so the universe is fetched in
 * passes: 1m around each anchor first (where stops and most exits happen),
 * then 5m out to FORWARD_HOURS. An offline client assembles whatever is
 * cached. coverageEnd is how far the fetched windows reach: past it a
 * missing candle means missing data, not a quiet pool.
 */
export async function loadPriceSeries(
  client: GeckoTerminalClient,
  c: UniverseCandidate,
  opts: { fine?: boolean; coarse?: boolean; nowS?: number } = {}
): Promise<PriceSeries | undefined> {
  const nowS = opts.nowS ?? Date.now() / 1000;
  const want = { fine: opts.fine ?? true, coarse: opts.coarse ?? true };
  const network = c.chain;
  const anchors = seriesAnchors(c);

  // No research market data (mostly manual submissions): use the token's
  // deepest pool GeckoTerminal knows today.
  let primaryAddress = c.pair?.pairAddress;
  let primaryDex = c.pair?.dexId ?? "";
  let tokenPools = primaryAddress ? undefined : await client.tokenPools(network, c.tokenAddress);
  if (!primaryAddress) {
    const deepest = [...(tokenPools ?? [])].sort((a, b) => (b.reserveUsd ?? 0) - (a.reserveUsd ?? 0))[0];
    if (!deepest) return undefined;
    primaryAddress = deepest.address;
    primaryDex = deepest.dexId;
  }

  const primary = await poolSeries(client, network, primaryAddress, c.tokenAddress, anchors, nowS, want);
  if (primary.candles.length === 0 && !Number.isFinite(primary.coveredTo)) return undefined; // nothing fetched yet

  const isCurve = BONDING_CURVE_DEXES.has(primaryDex.toLowerCase());
  if (!isCurve && primary.candles.length > 0) return { candles: primary.candles, pools: [primaryAddress], coverageEnd: primary.coveredTo };

  // Curve (or a pool GeckoTerminal doesn't index): continue on the token's
  // deepest other pool from where the primary's candles stop.
  tokenPools ??= await client.tokenPools(network, c.tokenAddress);
  const successor = tokenPools
    .filter((p) => p.address.toLowerCase() !== primaryAddress!.toLowerCase() && !BONDING_CURVE_DEXES.has(p.dexId.toLowerCase()))
    .sort((a, b) => (b.reserveUsd ?? 0) - (a.reserveUsd ?? 0))[0];
  if (!successor) {
    return primary.candles.length ? { candles: primary.candles, pools: [primaryAddress], coverageEnd: primary.coveredTo, note: "curve, no successor pool" } : undefined;
  }
  const lastPrimary = primary.candles.length ? primary.candles[primary.candles.length - 1].t : -Infinity;
  const next = await poolSeries(client, network, successor.address, c.tokenAddress, anchors, nowS, want);
  const tail = next.candles.filter((k) => k.t > lastPrimary);
  const candles = [...primary.candles, ...tail];
  if (!candles.length) return undefined;
  return {
    candles,
    pools: primary.candles.length ? [primaryAddress, successor.address] : [successor.address],
    coverageEnd: Math.min(primary.candles.length ? primary.coveredTo : Infinity, next.coveredTo),
    note: primary.candles.length ? `stitched ${successor.dexId} after curve` : `primary not on GeckoTerminal, used ${successor.dexId}`,
  };
}

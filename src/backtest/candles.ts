import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * GeckoTerminal public OHLCV, cached on disk. One candle per interval that
 * had at least one swap; an interval with no candle had no trades, so on an
 * AMM the pool price simply stayed at the previous close.
 */

export interface Candle {
  t: number; // interval start, unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // USD volume
  d: number; // interval length, seconds
}

export type Timeframe = "1m" | "5m";

const TIMEFRAME_PATH: Record<Timeframe, { path: string; aggregate: number; seconds: number }> = {
  "1m": { path: "minute", aggregate: 1, seconds: 60 },
  "5m": { path: "minute", aggregate: 5, seconds: 300 },
};

export function timeframeSeconds(tf: Timeframe): number {
  return TIMEFRAME_PATH[tf].seconds;
}

/**
 * GeckoTerminal returns rows newest first and sometimes splits one interval
 * into several rows with the same timestamp. Within such a group the rows
 * are in trading order (each row's open is the previous row's close), so
 * they merge as first open, max high, min low, last close, summed volume.
 */
export function parseOhlcvList(rows: unknown, durationSec = 60): Candle[] {
  if (!Array.isArray(rows)) return [];
  const byTime = new Map<number, Candle>();
  const order: number[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, o, h, l, c, v] = row.map(Number);
    if (![t, o, h, l, c].every((x) => Number.isFinite(x) && x >= 0) || !(c > 0)) continue;
    const existing = byTime.get(t);
    if (!existing) {
      byTime.set(t, { t, o, h, l, c, v: Number.isFinite(v) ? v : 0, d: durationSec });
      order.push(t);
      continue;
    }
    existing.h = Math.max(existing.h, h);
    existing.l = Math.min(existing.l, l);
    existing.c = c;
    existing.v += Number.isFinite(v) ? v : 0;
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/**
 * Merge series (e.g. 1m where we have it, 5m beyond), preferring the finer
 * one wherever it has coverage. fineFrom/fineTo bound the window the fine
 * series was fetched for: inside it, a missing 1m candle means no trades,
 * not missing data, so coarse candles must not fill those gaps.
 */
export function stitchSeries(fine: Candle[], coarse: Candle[], fineFrom?: number, fineTo?: number): Candle[] {
  if (fine.length === 0) return coarse;
  const last = fine[fine.length - 1].t;
  const from = Math.min(fineFrom ?? fine[0].t, fine[0].t);
  const to = Math.max(fineTo ?? last, last); // the fine window's end: its before_timestamp
  const before = coarse.filter((c) => c.t + c.d <= from);
  const after = coarse.filter((c) => c.t >= to && c.t > last);
  return [...before, ...fine, ...after];
}

/** Union of pages of the same timeframe (overlaps are identical candles). */
export function mergePages(pages: Candle[][]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const page of pages) for (const c of page) byTime.set(c.t, c);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

export interface GeckoPool {
  address: string;
  dexId: string;
  createdAt: number | undefined; // unix seconds
  reserveUsd: number | undefined;
}

interface CacheEntry<T> {
  fetchedAt: number; // unix seconds
  status: number;
  data: T;
}

export interface GeckoTerminalOptions {
  cacheDir: string;
  minIntervalMs?: number; // docs say 30 req/min; ~10/min is what it enforces (2026-09-25)
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  offline?: boolean; // serve only from cache
}

export class GeckoTerminalClient {
  private readonly cacheDir: string;
  private readonly baseIntervalMs: number;
  private intervalMs: number;
  private okStreak = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (msg: string) => void;
  private readonly offline: boolean;
  private nextSlot = 0;
  requests = 0;
  cacheHits = 0;

  constructor(opts: GeckoTerminalOptions) {
    this.cacheDir = opts.cacheDir;
    this.baseIntervalMs = opts.minIntervalMs ?? 6_500;
    this.intervalMs = this.baseIntervalMs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? (() => {});
    this.offline = opts.offline ?? false;
  }

  /**
   * Up to `limit` candles ending at or before `beforeTs`, oldest first. The
   * token parameter makes GeckoTerminal price OUR token in USD even when the
   * pool lists it as the quote side.
   */
  async ohlcv(input: {
    network: string;
    pool: string;
    token?: string;
    timeframe: Timeframe;
    beforeTs: number;
    limit?: number;
  }): Promise<Candle[] | undefined> {
    const tf = TIMEFRAME_PATH[input.timeframe];
    const limit = input.limit ?? 1000;
    const params = new URLSearchParams({
      aggregate: String(tf.aggregate),
      before_timestamp: String(Math.floor(input.beforeTs)),
      limit: String(limit),
      currency: "usd",
    });
    if (input.token) params.set("token", input.token);
    const url = `https://api.geckoterminal.com/api/v2/networks/${input.network}/pools/${input.pool}/ohlcv/${tf.path}?${params}`;
    const key = path.join(input.network, safe(input.pool), `${input.timeframe}-${Math.floor(input.beforeTs)}-${limit}${input.token ? "-t" : ""}.json`);
    const entry = await this.cached<unknown>(key, url, input.beforeTs);
    if (!entry || entry.status !== 200) return entry?.status === 404 ? [] : undefined;
    const list = (entry.data as { data?: { attributes?: { ohlcv_list?: unknown } } })?.data?.attributes?.ohlcv_list;
    return parseOhlcvList(list, tf.seconds);
  }

  /** Every pool GeckoTerminal knows for a token (first page, deepest first). */
  async tokenPools(network: string, token: string): Promise<GeckoPool[]> {
    const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${token}/pools?page=1`;
    const key = path.join(network, "_tokens", `${safe(token)}-pools.json`);
    const entry = await this.cached<unknown>(key, url, 0);
    if (!entry || entry.status !== 200) return [];
    const rows = (entry.data as { data?: unknown[] })?.data ?? [];
    return rows.flatMap((row) => {
      const attrs = (row as { attributes?: Record<string, unknown>; relationships?: { dex?: { data?: { id?: string } } } }).attributes ?? {};
      const address = typeof attrs.address === "string" ? attrs.address : undefined;
      if (!address) return [];
      const created = typeof attrs.pool_created_at === "string" ? Date.parse(attrs.pool_created_at) / 1000 : undefined;
      const reserve = Number(attrs.reserve_in_usd);
      return [
        {
          address,
          dexId: (row as { relationships?: { dex?: { data?: { id?: string } } } }).relationships?.dex?.data?.id ?? "",
          createdAt: Number.isFinite(created) ? created : undefined,
          reserveUsd: Number.isFinite(reserve) ? reserve : undefined,
        },
      ];
    });
  }

  /**
   * A response whose window has fully closed never changes, so it's cached
   * forever. One whose window reaches into the recent past is refetched after
   * an hour, since more candles will have printed since.
   */
  private async cached<T>(key: string, url: string, windowEndTs: number): Promise<CacheEntry<T> | undefined> {
    const file = path.join(this.cacheDir, key);
    const now = Date.now() / 1000;
    try {
      const entry = JSON.parse(await readFile(file, "utf8")) as CacheEntry<T>;
      const windowClosed = windowEndTs > 0 && windowEndTs <= entry.fetchedAt - 300;
      const recent = now - entry.fetchedAt < (windowEndTs > 0 ? 3_600 : 7 * 86_400);
      if (windowClosed || recent || this.offline) {
        this.cacheHits++;
        return entry;
      }
    } catch {
      // not cached yet
    }
    if (this.offline) return undefined;
    const fetched = await this.fetchWithRetry(url);
    if (!fetched) return undefined;
    const entry: CacheEntry<T> = { fetchedAt: Math.floor(Date.now() / 1000), status: fetched.status, data: fetched.body as T };
    if (fetched.status === 200 || fetched.status === 404) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(entry));
    }
    return entry;
  }

  private async fetchWithRetry(url: string): Promise<{ status: number; body: unknown } | undefined> {
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.waitForSlot();
      this.requests++;
      try {
        const res = await this.fetchImpl(url, { headers: { Accept: "application/json;version=20230302" }, signal: AbortSignal.timeout(45_000) });
        if (res.status === 429 || res.status >= 500) {
          // The documented ~30/min isn't what the API enforces at every
          // moment, so slow down for good on each 429 and only creep back.
          if (res.status === 429) {
            this.intervalMs = Math.min(this.intervalMs * 1.5, 20_000);
            this.okStreak = 0;
          }
          const waitMs = res.status === 429 ? 60_000 : 5_000 * (attempt + 1);
          this.log(`GeckoTerminal ${res.status}, waiting ${waitMs / 1000}s, then one request per ${(this.intervalMs / 1000).toFixed(1)}s`);
          this.nextSlot = Math.max(this.nextSlot, Date.now() + waitMs);
          continue;
        }
        if (++this.okStreak >= 50 && this.intervalMs > this.baseIntervalMs) {
          this.intervalMs = Math.max(this.baseIntervalMs, this.intervalMs * 0.9);
          this.okStreak = 0;
        }
        const body = res.status === 200 ? await res.json() : await res.text().catch(() => "");
        return { status: res.status, body };
      } catch (err) {
        this.log(`GeckoTerminal request failed (${String(err)}), retrying`);
        this.nextSlot = Math.max(this.nextSlot, Date.now() + 5_000 * (attempt + 1));
      }
    }
    return undefined;
  }

  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** Last candle whose interval started at or before ts. */
export function candleAt(series: Candle[], ts: number): number {
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= ts) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

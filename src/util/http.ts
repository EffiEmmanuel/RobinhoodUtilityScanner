import { logger } from "../logger";

const BACKOFF_MS = [0, 1000, 5000, 15000];
const originQueues = new Map<string, Promise<void>>();
const originNextAllowedAt = new Map<string, number>();

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function minIntervalMs(url: string): number {
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname.endsWith("dexscreener.com")) return envNum("DEXSCREENER_MIN_REQUEST_INTERVAL_MS", 1000);
  return envNum("HTTP_MIN_REQUEST_INTERVAL_MS", 0);
}

function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function rememberOriginCooldown(url: string, ms: number): void {
  const origin = new URL(url).origin;
  originNextAllowedAt.set(origin, Math.max(originNextAllowedAt.get(origin) ?? 0, Date.now() + ms));
}

async function waitForOriginSlot(url: string): Promise<void> {
  const origin = new URL(url).origin;
  const previous = originQueues.get(origin) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const delay = Math.max(0, (originNextAllowedAt.get(origin) ?? 0) - Date.now());
    if (delay > 0) await sleep(delay);
    const minInterval = minIntervalMs(url);
    if (minInterval > 0) originNextAllowedAt.set(origin, Date.now() + minInterval);
  });
  originQueues.set(origin, next);
  await next;
}

export async function fetchJsonWithRetry<T>(
  url: string,
  init?: RequestInit,
  opts?: { retries?: number; timeoutMs?: number }
): Promise<T> {
  const retries = opts?.retries ?? BACKOFF_MS.length;
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (BACKOFF_MS[attempt]) await sleep(BACKOFF_MS[attempt]);
    await waitForOriginSlot(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status} for ${url}`);
          if (res.status === 429) {
            rememberOriginCooldown(url, retryAfterMs(res) ?? envNum("HTTP_429_DEFAULT_COOLDOWN_MS", 30_000));
          }
          continue;
        }
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      logger.warn({ url, attempt, err: String(err) }, "fetchJsonWithRetry attempt failed");
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`fetchJsonWithRetry failed for ${url}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

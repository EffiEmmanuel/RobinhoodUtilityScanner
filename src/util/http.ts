import { logger } from "../logger";

const BACKOFF_MS = [0, 1000, 5000, 15000];

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status} for ${url}`);
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

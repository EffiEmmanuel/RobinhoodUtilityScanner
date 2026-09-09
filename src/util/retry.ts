import { sleep } from "./http";
import { logger } from "../logger";

const DEFAULT_BACKOFF_MS = [0, 3000, 10000, 20000];

/**
 * Generic retry for transient infra hiccups — written for Neon's serverless
 * cold-start behavior specifically: the first DB call after a period of
 * inactivity can wake a suspended compute and occasionally exceed the
 * connection attempt's own timeout (observed live: ETIMEDOUT after ~76s on a
 * cold Neon instance), even though the exact same call succeeds in ~1s once
 * warm. Retrying is the correct fix, not increasing a timeout further.
 */
export async function retryAsync<T>(label: string, fn: () => Promise<T>, backoffMs: number[] = DEFAULT_BACKOFF_MS): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (backoffMs[attempt]) await sleep(backoffMs[attempt]);
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      logger.warn({ label, attempt, err: String(err) }, "retryable call failed, will retry");
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label} failed after ${backoffMs.length} attempts`);
}

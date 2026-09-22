import "dotenv/config";
import { Pool, type QueryResultRow } from "pg";
import { isRetryableDbError, RETRY_BACKOFF_MS } from "./db";
import { logger } from "./logger";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const rawPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Confirmed live 2026-09-22: this pool is entirely separate from db.ts's
// Prisma client, so db.ts's own retry wrapper (every `db.*` model call)
// never covered it — a Neon blip that every Prisma call elsewhere just
// retried through 500'd this query outright instead, taking down whatever
// endpoint used it (/trading/no-trade-diagnostics, at the time). Same
// retry/backoff policy as db.ts, applied here directly since this pool
// can't go through Prisma's $extends.
export async function rawQuery<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
    if (RETRY_BACKOFF_MS[attempt]) await sleep(RETRY_BACKOFF_MS[attempt]);
    try {
      const result = await rawPool.query<T>(text, values);
      return result.rows;
    } catch (err) {
      lastErr = err;
      if (!isRetryableDbError(err)) throw err;
      logger.warn({ attempt, err: String(err) }, "transient DB error (rawQuery), retrying");
    }
  }
  throw lastErr;
}

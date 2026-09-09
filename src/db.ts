import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma";
import { config } from "./config";
import { logger } from "./logger";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (expected a postgresql:// connection string) — see .env.example");
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

const basePrisma = new PrismaClient({
  adapter,
  log: config.nodeEnv === "development" ? ["warn", "error"] : ["error"],
});

// Neon's pooled/serverless endpoint occasionally drops or resets a connection
// mid-query under normal operation (confirmed live — not just a cold-start
// issue: ETIMEDOUT/connection-reset errors surfaced from unrelated queries
// across the app, at random points, well after startup). Retrying here once,
// centrally, is far more robust than adding retry logic at every call site —
// every `db.*` call anywhere in the app gets this for free.
const RETRYABLE_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "EPIPE", "P1001", "P1008", "P1017", "P2024"]);
const RETRY_BACKOFF_MS = [0, 500, 2000];

function isRetryableDbError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  const message = String((err as { message?: string })?.message ?? "");
  return /connection|timeout|econnreset|etimedout/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const db = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        let lastErr: unknown;
        for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
          if (RETRY_BACKOFF_MS[attempt]) await sleep(RETRY_BACKOFF_MS[attempt]);
          try {
            return await query(args);
          } catch (err) {
            lastErr = err;
            if (!isRetryableDbError(err)) throw err;
            logger.warn({ attempt, err: String(err) }, "transient DB error, retrying");
          }
        }
        throw lastErr;
      },
    },
  },
});

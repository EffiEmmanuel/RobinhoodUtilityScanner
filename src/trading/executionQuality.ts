import { db } from "../db";
import type { MarketPair } from "../dex/types";

export interface ExecutionQualityInput {
  tokenAddress: string;
  pair?: Pick<MarketPair, "dexId" | "pairAddress">;
  direction: "BUY" | "SELL" | "QUOTE_BUY" | "QUOTE_SELL";
  success?: boolean;
  suspiciousQuote?: boolean;
  slippageBps?: number;
  priceImpactPercent?: number;
  error?: string;
}

function statKey(input: ExecutionQualityInput) {
  return {
    tokenAddress: input.tokenAddress.toLowerCase(),
    dexId: input.pair?.dexId ?? "unknown",
    pairAddress: input.pair?.pairAddress ?? "unknown",
    direction: input.direction,
  };
}

function rollingAverage(previous: number | null | undefined, countBefore: number, next: number | undefined): number | undefined {
  if (next === undefined || !Number.isFinite(next)) return previous ?? undefined;
  if (previous === null || previous === undefined || countBefore <= 0) return next;
  return (previous * countBefore + next) / (countBefore + 1);
}

export async function recordExecutionQuality(input: ExecutionQualityInput): Promise<void> {
  const key = statKey(input);
  const existing = await db.executionQualityStat.findUnique({
    where: { tokenAddress_dexId_pairAddress_direction: key },
  });
  const attempts = existing?.attempts ?? 0;
  const successes = existing?.successes ?? 0;
  const failures = existing?.failures ?? 0;
  const suspiciousQuotes = existing?.suspiciousQuotes ?? 0;

  await db.executionQualityStat.upsert({
    where: { tokenAddress_dexId_pairAddress_direction: key },
    create: {
      ...key,
      attempts: 1,
      successes: input.success ? 1 : 0,
      failures: input.success === false ? 1 : 0,
      suspiciousQuotes: input.suspiciousQuote ? 1 : 0,
      avgSlippageBps: input.slippageBps,
      avgPriceImpactPercent: input.priceImpactPercent,
      maxPriceImpactPercent: input.priceImpactPercent,
      lastError: input.error,
      lastSeenAt: new Date(),
    },
    update: {
      attempts: { increment: 1 },
      successes: input.success ? { increment: 1 } : undefined,
      failures: input.success === false ? { increment: 1 } : undefined,
      suspiciousQuotes: input.suspiciousQuote ? { increment: 1 } : undefined,
      avgSlippageBps: rollingAverage(existing?.avgSlippageBps, attempts, input.slippageBps),
      avgPriceImpactPercent: rollingAverage(existing?.avgPriceImpactPercent, attempts, input.priceImpactPercent),
      maxPriceImpactPercent:
        input.priceImpactPercent !== undefined
          ? Math.max(existing?.maxPriceImpactPercent ?? 0, input.priceImpactPercent)
          : existing?.maxPriceImpactPercent,
      lastError: input.error ?? existing?.lastError,
      lastSeenAt: new Date(),
    },
  });
}

export interface ExecutionQualityRisk {
  passed: boolean;
  reasons: string[];
  stats: {
    attempts: number;
    failures: number;
    successes: number;
    suspiciousQuotes: number;
    maxPriceImpactPercent?: number;
  };
}

export async function evaluateExecutionQualityForEntry(tokenAddress: string): Promise<ExecutionQualityRisk> {
  const rows = await db.executionQualityStat.findMany({
    where: { tokenAddress: tokenAddress.toLowerCase() },
  });
  const attempts = rows.reduce((sum, row) => sum + row.attempts, 0);
  const failures = rows.reduce((sum, row) => sum + row.failures, 0);
  const successes = rows.reduce((sum, row) => sum + row.successes, 0);
  const suspiciousQuotes = rows.reduce((sum, row) => sum + row.suspiciousQuotes, 0);
  const maxPriceImpactPercent = rows.reduce<number | undefined>(
    (max, row) => (row.maxPriceImpactPercent === null ? max : Math.max(max ?? 0, row.maxPriceImpactPercent)),
    undefined
  );
  const reasons: string[] = [];
  if (attempts >= 4 && failures / attempts >= 0.75) {
    reasons.push(`execution quality: ${failures}/${attempts} recent attempts failed for this token`);
  }
  if (suspiciousQuotes >= 3) {
    reasons.push(`execution quality: ${suspiciousQuotes} suspicious quote(s) recorded for this token`);
  }
  if (maxPriceImpactPercent !== undefined && maxPriceImpactPercent >= 50) {
    reasons.push(`execution quality: max observed price impact ${maxPriceImpactPercent.toFixed(1)}%`);
  }
  return {
    passed: reasons.length === 0,
    reasons,
    stats: { attempts, failures, successes, suspiciousQuotes, maxPriceImpactPercent },
  };
}

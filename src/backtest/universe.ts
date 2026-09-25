import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExitRules } from "../trading/strategy";

/**
 * Everything the replay needs from the production DB, in one JSON-able
 * snapshot, so a sweep never touches the DB again. Every timestamp is unix
 * seconds, selected with extract(epoch ...), which sidesteps node-pg parsing
 * Prisma's zone-less UTC columns as local time.
 */

export interface PrimaryPair {
  pairAddress: string;
  dexId?: string;
  quoteSymbol?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  liquidityUsd?: number;
  volume1h?: number;
  priceChange1h?: number;
  buys1h?: number;
  sells1h?: number;
  pairCreatedAt?: string;
}

export interface ActualExecution {
  type: "BUY" | "SELL";
  ts: number;
  tokenAmount: number | null;
  usdValue: number | null;
  actualPrice: number | null;
  gasCostUsd: number | null;
}

export interface ActualTrade {
  id: string;
  candidateId: string | null;
  mode: string;
  status: string;
  positionSizeUsd: number;
  entryPriceUsd: number | null;
  entryLiquidityUsd: number | null;
  actualEntryMcap: number | null;
  openedAt: number | null;
  closedAt: number | null;
  realizedPnlUsd: number | null;
  realizedMultiple: number | null;
  exitReason: string | null;
  strategyVersionId: string;
  tradeLane: string | null;
  mfePercent: number | null;
  invalidationMcap: number | null;
  firstMark: { ts: number; priceUsd: number } | null;
  executions: ActualExecution[];
}

export interface UniverseCandidate {
  candidateId: string;
  tokenId: string;
  chain: string;
  tokenAddress: string;
  symbol: string | null;
  status: string;
  qualificationPath: string | null;
  tradeLane: string | null;
  qualityScore: number | null;
  researchConfidence: number | null;
  socialScore: number | null;
  createdAt: number;
  firstSeenAt: number;
  pair: PrimaryPair | null;
  invalidationMcap: number | null;
  outcome: {
    traded: boolean;
    marketCapAtDetection: number | null;
    maxMultiple24h: number | null;
    feasibleMaxMultiple24h: number | null;
    minMarketCap24h: number | null;
  };
  trades: ActualTrade[];
}

export interface StrategyVersionRow {
  id: string;
  version: string;
  status: string;
  createdAt: number;
  exitRules: ExitRules;
}

export interface UniverseSnapshot {
  capturedAt: number;
  candidates: UniverseCandidate[];
  strategyVersions: StrategyVersionRow[];
}

type Row = Record<string, unknown>;
type Query = (sql: string) => Promise<Row[]>;

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function parsePrimaryPair(raw: unknown): PrimaryPair | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const pairAddress = str(p.pairAddress);
  if (!pairAddress) return null;
  return {
    pairAddress,
    dexId: str(p.dexId) ?? undefined,
    quoteSymbol: str(p.quoteSymbol) ?? undefined,
    priceUsd: num(p.priceUsd) ?? undefined,
    marketCapUsd: num(p.marketCapUsd) ?? undefined,
    fdvUsd: num(p.fdvUsd) ?? undefined,
    liquidityUsd: num(p.liquidityUsd) ?? undefined,
    volume1h: num(p.volume1h) ?? undefined,
    priceChange1h: num(p.priceChange1h) ?? undefined,
    buys1h: num(p.buys1h) ?? undefined,
    sells1h: num(p.sells1h) ?? undefined,
    pairCreatedAt: str(p.pairCreatedAt) ?? undefined,
  };
}

/**
 * Since 2026-09-25 a Solana buy's gasCostUsd also books the token account's
 * rent deposit, which comes back when the account is closed after the exit.
 * It isn't a trading cost, so the fill model's gas leaves it out.
 */
export function gasNetOfRent(gasCostUsd: number | null, feeLamports: number | null, rentLamports: number | null): number | null {
  if (gasCostUsd === null || !rentLamports || rentLamports <= 0 || feeLamports === null) return gasCostUsd;
  return gasCostUsd * (feeLamports / (feeLamports + rentLamports));
}

/** Read-only: only SELECTs, on a session the caller has set read-only. */
export async function loadUniverse(query: Query): Promise<UniverseSnapshot> {
  // Sequential on purpose: one pg client runs one query at a time.
  const queries = [
    `
      select tc.id, tc."tokenId", t.chain, t.address, t.symbol, tc.status::text as status, tc."qualificationPath", tc."tradeLane",
             tc."qualityScore", tc."researchConfidence", rr."socialScore",
             extract(epoch from tc."createdAt") as created_at, extract(epoch from t."firstSeenAt") as first_seen,
             rr."rawResearch"->'market'->'primaryPair' as pp,
             co.traded, co."marketCapAtDetection", co."maxMultiple24h", co."feasibleMaxMultiple24h", co."minMarketCap24h",
             (select tp."invalidationMcap" from "TradePlan" tp where tp."candidateId" = tc.id order by tp."createdAt" desc limit 1) as invalidation
        from "TradeCandidate" tc
        join "Token" t on t.id = tc."tokenId"
        join "CandidateOutcome" co on co."candidateId" = tc.id
        left join "ResearchRun" rr on rr.id = tc."researchRunId"`,
    `
      select tr.id, tr."candidateId", tr.mode::text as mode, tr.status::text as status, tr."positionSizeUsd", tr."entryPriceUsd",
             tr."entryLiquidityUsd", tr."actualEntryMcap", extract(epoch from tr."openedAt") as opened_at,
             extract(epoch from tr."closedAt") as closed_at, tr."realizedPnlUsd", tr."realizedMultiple", tr."exitReason",
             tr."strategyVersionId", tr."tradeLane", tr."mfePercent", tp."invalidationMcap"
        from "Trade" tr left join "TradePlan" tp on tp.id = tr."tradePlanId"`,
    `
      select "tradeId", type::text as type, extract(epoch from coalesce("confirmedAt", "createdAt")) as ts,
             "tokenAmount", "usdValue", "actualPrice", "gasCostUsd",
             "rawReceipt"->>'feeLamports' as fee_lamports, "rawReceipt"->>'rentLamports' as rent_lamports
        from "TradeExecution" where status = 'CONFIRMED' and type in ('BUY', 'SELL') order by ts`,
    `
      select distinct on ("tradeId") "tradeId", extract(epoch from "capturedAt") as ts, "priceUsd"
        from "PositionSnapshot" where "priceUsd" is not null order by "tradeId", "capturedAt"`,
    `select id, version, status::text as status, extract(epoch from "createdAt") as created_at, "exitRules" from "StrategyVersion"`,
  ];
  const results: Row[][] = [];
  for (const sql of queries) results.push(await query(sql));
  const [candidates, trades, executions, firstMarks, versions] = results;

  const execByTrade = new Map<string, ActualExecution[]>();
  for (const e of executions) {
    const list = execByTrade.get(String(e.tradeId)) ?? [];
    list.push({
      type: e.type as "BUY" | "SELL",
      ts: Number(e.ts),
      tokenAmount: num(e.tokenAmount),
      usdValue: num(e.usdValue),
      actualPrice: num(e.actualPrice),
      gasCostUsd: gasNetOfRent(num(e.gasCostUsd), num(e.fee_lamports), num(e.rent_lamports)),
    });
    execByTrade.set(String(e.tradeId), list);
  }
  const firstMarkByTrade = new Map(firstMarks.map((m) => [String(m.tradeId), { ts: Number(m.ts), priceUsd: Number(m.priceUsd) }]));

  const tradesByCandidate = new Map<string, ActualTrade[]>();
  for (const t of trades) {
    const trade: ActualTrade = {
      id: String(t.id),
      candidateId: str(t.candidateId),
      mode: String(t.mode),
      status: String(t.status),
      positionSizeUsd: Number(t.positionSizeUsd),
      entryPriceUsd: num(t.entryPriceUsd),
      entryLiquidityUsd: num(t.entryLiquidityUsd),
      actualEntryMcap: num(t.actualEntryMcap),
      openedAt: num(t.opened_at),
      closedAt: num(t.closed_at),
      realizedPnlUsd: num(t.realizedPnlUsd),
      realizedMultiple: num(t.realizedMultiple),
      exitReason: str(t.exitReason),
      strategyVersionId: String(t.strategyVersionId),
      tradeLane: str(t.tradeLane),
      mfePercent: num(t.mfePercent),
      invalidationMcap: num(t.invalidationMcap),
      firstMark: firstMarkByTrade.get(String(t.id)) ?? null,
      executions: execByTrade.get(String(t.id)) ?? [],
    };
    if (!trade.candidateId) continue;
    const list = tradesByCandidate.get(trade.candidateId) ?? [];
    list.push(trade);
    tradesByCandidate.set(trade.candidateId, list);
  }

  return {
    capturedAt: Math.floor(Date.now() / 1000),
    candidates: candidates.map((c) => ({
      candidateId: String(c.id),
      tokenId: String(c.tokenId),
      chain: String(c.chain),
      tokenAddress: String(c.address),
      symbol: str(c.symbol),
      status: String(c.status),
      qualificationPath: str(c.qualificationPath),
      tradeLane: str(c.tradeLane),
      qualityScore: num(c.qualityScore),
      researchConfidence: num(c.researchConfidence),
      socialScore: num(c.socialScore),
      createdAt: Number(c.created_at),
      firstSeenAt: Number(c.first_seen),
      pair: parsePrimaryPair(c.pp),
      invalidationMcap: num(c.invalidation),
      outcome: {
        traded: Boolean(c.traded),
        marketCapAtDetection: num(c.marketCapAtDetection),
        maxMultiple24h: num(c.maxMultiple24h),
        feasibleMaxMultiple24h: num(c.feasibleMaxMultiple24h),
        minMarketCap24h: num(c.minMarketCap24h),
      },
      trades: (tradesByCandidate.get(String(c.id)) ?? []).sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0)),
    })),
    strategyVersions: versions.map((v) => ({
      id: String(v.id),
      version: String(v.version),
      status: String(v.status),
      createdAt: Number(v.created_at),
      exitRules: v.exitRules as ExitRules,
    })),
  };
}

/**
 * Opens a read-only pg session with the long connect timeout Neon needs from
 * a laptop. pg is required lazily so importing this module never needs it.
 */
export async function withReadOnlyProdQuery<T>(fn: (query: Query) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require("pg") as typeof import("pg");
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 90_000, query_timeout: 300_000 });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    return await fn(async (sql) => (await client.query(sql)).rows as Row[]);
  } finally {
    await client.end();
  }
}

export async function saveSnapshot(file: string, snapshot: UniverseSnapshot): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(snapshot));
}

export async function readSnapshot(file: string): Promise<UniverseSnapshot> {
  return JSON.parse(await readFile(file, "utf8")) as UniverseSnapshot;
}

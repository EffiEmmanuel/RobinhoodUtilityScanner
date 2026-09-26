import { exitCategory } from "./calibrate";
import { bootstrapMeanCI, mean, quantile } from "./stats";
import type { ActualTrade, UniverseCandidate } from "./universe";

/**
 * Paper-vs-replay fidelity: the paper book (src/trading/paper/) trades live
 * candidates on real Jupiter quotes; replaying the same positions through
 * the backtester at the paper entry time, price and size shows how far the
 * simulator is from what real quotes did. This is the running calibration
 * check on the sim.
 */

export interface PaperBookPosition {
  id: string;
  strategyId: string;
  strategyName: string;
  strategyVersionId: string;
  candidateId: string;
  status: string;
  openedAt: number; // unix seconds
  closedAt: number | null;
  sizeUsd: number;
  entryPriceUsd: number | null;
  costBasisUsd: number;
  realizedPnlUsd: number | null;
  exitReason: string | null;
  mfePercent: number | null;
}

export interface PaperBook {
  capturedAt: number;
  tablesExist: boolean;
  positions: PaperBookPosition[];
}

type Row = Record<string, unknown>;

/** Read-only. Before the paper tables are deployed, reports tablesExist: false. */
export async function loadPaperBook(query: (sql: string) => Promise<Row[]>): Promise<PaperBook> {
  const capturedAt = Math.floor(Date.now() / 1000);
  const [exists] = await query(`select to_regclass('"PaperPosition"') is not null as ok`);
  if (!exists?.ok) return { capturedAt, tablesExist: false, positions: [] };
  const rows = await query(`
    select p.id, p."strategyId", s.name as "strategyName", s."strategyVersionId", p."candidateId", p.status,
           extract(epoch from p."openedAt") as opened_at, extract(epoch from p."closedAt") as closed_at,
           p."sizeUsd", p."entryPriceUsd", p."costBasisUsd", p."realizedPnlUsd", p."exitReason", p."mfePercent"
      from "PaperPosition" p join "PaperStrategy" s on s.id = p."strategyId"`);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    capturedAt,
    tablesExist: true,
    positions: rows.map((r) => ({
      id: String(r.id),
      strategyId: String(r.strategyId),
      strategyName: String(r.strategyName),
      strategyVersionId: String(r.strategyVersionId),
      candidateId: String(r.candidateId),
      status: String(r.status),
      openedAt: Number(r.opened_at),
      closedAt: num(r.closed_at),
      sizeUsd: Number(r.sizeUsd),
      entryPriceUsd: num(r.entryPriceUsd),
      costBasisUsd: Number(r.costBasisUsd),
      realizedPnlUsd: num(r.realizedPnlUsd),
      exitReason: r.exitReason === null ? null : String(r.exitReason),
      mfePercent: num(r.mfePercent),
    })),
  };
}

/**
 * The candidate as the paper strategy traded it: its entry time, fill price
 * and size stand in for a live trade, and there's no AI plan (paper
 * strategies have no invalidation level).
 */
export function asPaperTrade(candidate: UniverseCandidate, p: PaperBookPosition): UniverseCandidate {
  const trade: ActualTrade = {
    id: p.id,
    candidateId: p.candidateId,
    mode: "PAPER",
    status: p.status,
    positionSizeUsd: p.sizeUsd,
    entryPriceUsd: p.entryPriceUsd,
    entryLiquidityUsd: null,
    actualEntryMcap: null,
    openedAt: p.openedAt,
    closedAt: p.closedAt,
    realizedPnlUsd: p.realizedPnlUsd,
    realizedMultiple: null,
    exitReason: p.exitReason,
    strategyVersionId: p.strategyVersionId,
    tradeLane: candidate.tradeLane,
    mfePercent: p.mfePercent,
    invalidationMcap: null,
    firstMark: null,
    executions: [],
  };
  return { ...candidate, invalidationMcap: null, trades: [trade] };
}

export interface FidelityPair {
  positionId: string;
  symbol: string | null;
  paperUsd: number;
  simUsd: number;
  paperPct: number; // of cost basis
  simPct: number;
  paperExit: string;
  simExit: string;
}

export interface FidelitySummary {
  n: number;
  paperTotalUsd: number;
  simTotalUsd: number;
  paperMeanPct: number;
  simMeanPct: number;
  meanAbsErrorPts: number;
  medianAbsErrorPts: number;
  meanGapPts: number; // replay minus paper, per trade
  meanGapCI90: [number, number];
  correlation: number;
  sameExitType: number;
  paperWriteOffs: number; // honeypots / no sell route: the sim can't see these
}

function pearson(xs: number[], ys: number[]): number {
  if (xs.length < 3) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sx += (xs[i] - mx) ** 2;
    sy += (ys[i] - my) ** 2;
  }
  return sx > 0 && sy > 0 ? sxy / Math.sqrt(sx * sy) : NaN;
}

export function summarizeFidelity(pairs: FidelityPair[]): FidelitySummary {
  const errors = pairs.map((p) => Math.abs(p.simPct - p.paperPct)).sort((a, b) => a - b);
  return {
    n: pairs.length,
    paperTotalUsd: pairs.reduce((a, p) => a + p.paperUsd, 0),
    simTotalUsd: pairs.reduce((a, p) => a + p.simUsd, 0),
    paperMeanPct: mean(pairs.map((p) => p.paperPct)),
    simMeanPct: mean(pairs.map((p) => p.simPct)),
    meanAbsErrorPts: mean(errors),
    medianAbsErrorPts: quantile(errors, 0.5),
    meanGapPts: mean(pairs.map((p) => p.simPct - p.paperPct)),
    meanGapCI90: bootstrapMeanCI(pairs.map((p) => p.simPct - p.paperPct)),
    correlation: pearson(
      pairs.map((p) => p.paperPct),
      pairs.map((p) => p.simPct)
    ),
    sameExitType: pairs.filter((p) => exitCategory(p.paperExit) === exitCategory(p.simExit)).length,
    paperWriteOffs: pairs.filter((p) => /write-off|no sell route/i.test(p.paperExit)).length,
  };
}

/** Nested LaunchForensics JSON as the dotted keys C's table (and FORENSICS_GATES) use. */
export function flattenFeatures(value: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flattenFeatures(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out[prefix] = value;
  }
  return out;
}

export interface PaperForensicsRow {
  candidateId: string;
  status: string | null; // READY | UNAVAILABLE | null (no snapshot)
  features: Record<string, unknown>; // flattened
  tokenAddress: string;
  chain: string;
  dexId: string | null;
}

/** Read-only: the live LaunchForensicsSnapshot and launch venue for each paper-traded candidate. */
export async function loadPaperForensics(query: (sql: string) => Promise<Row[]>, candidateIds: string[]): Promise<PaperForensicsRow[]> {
  if (!candidateIds.length) return [];
  const [exists] = await query(`select to_regclass('"LaunchForensicsSnapshot"') is not null as ok`);
  const list = candidateIds.map((id) => `'${id.replace(/[^A-Za-z0-9_-]/g, "")}'`).join(",");
  const rows = await query(`
    select tc.id as "candidateId", t.address, t.chain, rr."rawResearch"->'market'->'primaryPair'->>'dexId' as "dexId"
           ${exists?.ok ? `, lf.status, lf.features` : ""}
      from "TradeCandidate" tc
      join "Token" t on t.id = tc."tokenId"
      left join "ResearchRun" rr on rr.id = tc."researchRunId"
      ${exists?.ok ? `left join "LaunchForensicsSnapshot" lf on lf."candidateId" = tc.id` : ""}
     where tc.id in (${list})`);
  return rows.map((r) => ({
    candidateId: String(r.candidateId),
    status: typeof r.status === "string" ? r.status : null,
    features: flattenFeatures(r.features ?? {}),
    tokenAddress: String(r.address),
    chain: String(r.chain),
    dexId: typeof r.dexId === "string" ? r.dexId : null,
  }));
}

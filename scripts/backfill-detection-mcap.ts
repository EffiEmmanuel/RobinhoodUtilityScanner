import { db } from "../src/db";
import { rebuildCohortStats } from "../src/trading/cohortStats";
import { detectionMismatch, relabelOutcome } from "../src/trading/outcomes";

/**
 * One-off, human-run. DRY RUN unless --execute.
 *
 * Re-bases CandidateOutcome rows whose marketCapAtDetection is more than 5x
 * off the mcap the candidate's decision was made on (the first outcome poll
 * used to land up to an hour late, after fast rugs; see
 * decisionTimeMarketCap in src/trading/outcomes.ts). Only those rows are
 * touched, and a corrected row no longer mismatches, so rerunning is a no-op.
 * With --execute it then rebuilds CohortStats so sizing sees the fix at once.
 *
 *   railway run -- npx tsx scripts/backfill-detection-mcap.ts            # dry run
 *   railway run -- npx tsx scripts/backfill-detection-mcap.ts --execute  # write
 */

interface Row {
  id: string;
  candidateId: string;
  tokenId: string;
  researchRunId: string | null;
  candidateCreatedAt: Date;
  chain: string;
  symbol: string | null;
  researchMcap: number | null;
  marketCapAtDetection: number | null;
  maxMarketCap15m: number | null;
  maxMarketCap1h: number | null;
  maxMarketCap6h: number | null;
  maxMarketCap24h: number | null;
  maxMarketCap48h: number | null;
  minMarketCap15m: number | null;
  minMarketCap1h: number | null;
  minMarketCap6h: number | null;
  minMarketCap24h: number | null;
  minMarketCap48h: number | null;
  feasibleMaxMultiple24h: number | null;
  feasibleMaxMultiple48h: number | null;
  hit200x: boolean | null;
  feasibleHit200x: boolean | null;
  feasibleHit500x: boolean | null;
  feasibleHit1000x: boolean | null;
  feasibleOutcomeReason: unknown;
}

async function main() {
  const execute = process.argv.includes("--execute");
  // Decision-time mcap: the research snapshot, else the token's last
  // MarketSnapshot at the candidate's creation (one batched query each).
  const rows = await db.$queryRaw<Row[]>`
    select co.id, co."candidateId", tc."tokenId", tc."researchRunId", tc."createdAt" as "candidateCreatedAt", t.chain, t.symbol,
           coalesce(
             nullif(rr."rawResearch"->'market'->'primaryPair'->>'marketCapUsd', '')::float,
             (select ms."marketCapUsd" from "MarketSnapshot" ms
               where ms."tokenId" = tc."tokenId" and ms."marketCapUsd" > 0
                 and ms."capturedAt" between tc."createdAt" - interval '30 minutes' and tc."createdAt" + interval '1 minute'
               order by ms."capturedAt" desc limit 1)
           ) as "researchMcap",
           co."marketCapAtDetection", co."maxMarketCap15m", co."maxMarketCap1h", co."maxMarketCap6h", co."maxMarketCap24h", co."maxMarketCap48h",
           co."minMarketCap15m", co."minMarketCap1h", co."minMarketCap6h", co."minMarketCap24h", co."minMarketCap48h",
           co."feasibleMaxMultiple24h", co."feasibleMaxMultiple48h", co."hit200x", co."feasibleHit200x", co."feasibleHit500x", co."feasibleHit1000x",
           co."feasibleOutcomeReason"
      from "CandidateOutcome" co
      join "TradeCandidate" tc on tc.id = co."candidateId"
      join "Token" t on t.id = tc."tokenId"
      left join "ResearchRun" rr on rr.id = tc."researchRunId"`;

  const affected = rows.filter((r) => r.researchMcap && r.researchMcap > 0 && detectionMismatch(r.marketCapAtDetection, r.researchMcap));
  const ids = affected.map((r) => r.id);
  const snaps = ids.length
    ? await db.$queryRaw<{ outcomeId: string; capturedAt: Date; marketCapUsd: number | null }[]>`
        select co.id as "outcomeId", ms."capturedAt", ms."marketCapUsd"
          from "CandidateOutcome" co
          join "TradeCandidate" tc on tc.id = co."candidateId"
          join "MarketSnapshot" ms on ms."tokenId" = tc."tokenId"
         where co.id = any(${ids})
           and ms."capturedAt" between tc."createdAt" - interval '2 minutes' and tc."createdAt" + interval '48 hours'
         order by ms."capturedAt"`
    : [];
  const snapsByOutcome = new Map<string, { capturedAt: Date; marketCapUsd: number | null }[]>();
  for (const x of snaps) {
    const list = snapsByOutcome.get(x.outcomeId) ?? [];
    list.push(x);
    snapsByOutcome.set(x.outcomeId, list);
  }

  type Change = { row: Row; decisionMcap: number; after: ReturnType<typeof relabelOutcome> };
  const changes: Change[] = affected.map((row) => ({
    row,
    decisionMcap: row.researchMcap!,
    after: relabelOutcome(row, row.researchMcap!, row.candidateCreatedAt, snapsByOutcome.get(row.id) ?? []),
  }));

  const changedById = new Map(changes.map((c) => [c.row.id, c]));
  for (const chain of [...new Set(rows.map((r) => r.chain))].sort()) {
    const all = rows.filter((r) => r.chain === chain);
    const mine = changes.filter((c) => c.row.chain === chain);
    const low = mine.filter((c) => (c.row.marketCapAtDetection ?? 0) < c.decisionMcap).length;
    const count = (pick: (r: Row) => boolean | null, pickAfter: (c: Change) => boolean) => {
      const before = all.filter((r) => pick(r)).length;
      const after = all.filter((r) => {
        const c = changedById.get(r.id);
        return c ? pickAfter(c) : Boolean(pick(r));
      }).length;
      return `${before} -> ${after} (${((before / all.length) * 100).toFixed(1)}% -> ${((after / all.length) * 100).toFixed(1)}%)`;
    };
    console.log(`\n${chain}: ${all.length} outcomes, ${mine.length} to re-base (${low} detection too low, ${mine.length - low} too high)`);
    console.log(`  feasible (sellable) 2x: ${count((r) => r.feasibleHit200x, (c) => c.after.feasibleHit200x)}`);
    console.log(`  raw 2x:                 ${count((r) => r.hit200x, (c) => c.after.hit200x)}`);
    console.log(`  feasible 5x (sizing):   ${count((r) => r.feasibleHit500x, (c) => c.after.feasibleHit500x)}`);
    console.log(`  feasible 10x (sizing):  ${count((r) => r.feasibleHit1000x, (c) => c.after.feasibleHit1000x)}`);
    const biggest = mine
      .filter((c) => c.row.feasibleMaxMultiple24h !== null)
      .sort((a, b) => (b.row.feasibleMaxMultiple24h ?? 0) - (a.row.feasibleMaxMultiple24h ?? 0))
      .slice(0, 10);
    for (const c of biggest) {
      console.log(
        `    ${c.row.symbol ?? c.row.candidateId}: detection $${Math.round(c.row.marketCapAtDetection ?? 0).toLocaleString()} -> $${Math.round(c.decisionMcap).toLocaleString()}, feasible 24h ${(c.row.feasibleMaxMultiple24h ?? 0).toFixed(2)}x -> ${(c.after.feasibleMaxMultiple24h ?? 0).toFixed(2)}x`
      );
    }
  }

  if (!execute) {
    console.log(`\nDRY RUN: nothing written. ${changes.length} rows would be re-based. Rerun with --execute to write them.`);
    return;
  }
  let written = 0;
  for (const c of changes) {
    const previous = (c.row.feasibleOutcomeReason ?? {}) as Record<string, unknown>;
    await db.candidateOutcome.update({
      where: { id: c.row.id },
      data: {
        ...c.after,
        feasibleOutcomeReason: {
          ...previous,
          detection: { source: "backfill-2026-09-25", decisionMcap: c.decisionMcap, previousDetectionMcap: c.row.marketCapAtDetection, mismatch: false },
        } as object,
      },
    });
    written++;
  }
  const cohorts = await rebuildCohortStats();
  console.log(`\nWROTE ${written} CandidateOutcome rows; rebuilt ${cohorts.cohortsWritten} CohortStats rows.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import "dotenv/config";

/**
 * Builds a reference cache of every token that reached a big multiple after
 * we saw it, so entry-threshold decisions (and manual token review) can be
 * checked against real history instead of gut feel. Uses raw `pg` rather
 * than `src/db` (Prisma) — the Prisma adapter times out on Neon auth from a
 * local machine; see memory reference_prod_db_querying.
 *
 * Two tiers, both from `CandidateOutcome`:
 * - "feasible" misses: the peak also passed a sellability/depth probe
 *   (outcomes.ts) — these are the real, capturable opportunities.
 * - "chart-only" wicks: the raw chart printed a huge number but liquidity
 *   was too thin to actually exit — kept separately so they don't get
 *   mistaken for real misses when eyeballing this list later.
 *
 * Re-run with `yarn tsx scripts/export-missed-opportunities.ts` any time to
 * refresh data/missed-opportunities.json and docs/trade-reviews/missed-opportunities.md.
 */

interface Row {
  symbol: string | null;
  chain: string;
  address: string;
  candidateId: string;
  status: string;
  tradeLane: string | null;
  qualificationPath: string | null;
  traded: boolean;
  qualityScore: number | null;
  researchConfidence: number | null;
  marketCapAtDetection: number | null;
  maxMarketCap24h: number | null;
  maxMultiple24h: number | null;
  feasibleMaxMultiple24h: number | null;
  createdAt: string;
  decisionStage: string | null;
  decisionOutcome: string | null;
  finalReasons: string[] | null;
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 90000,
    query_timeout: 180000,
  });
  await client.connect();
  await client.query("SET default_transaction_read_only = on");

  const feasibleRes = await client.query<Row>(`
    SELECT
      t.symbol, t.chain, t.address,
      tc.id AS "candidateId", tc.status, tc."tradeLane", tc."qualificationPath",
      co.traded, tc."qualityScore", tc."researchConfidence",
      co."marketCapAtDetection", co."maxMarketCap24h", co."maxMultiple24h", co."feasibleMaxMultiple24h",
      tc."createdAt",
      d.stage AS "decisionStage", d.decision AS "decisionOutcome", d."finalReasons"
    FROM "CandidateOutcome" co
    JOIN "TradeCandidate" tc ON tc.id = co."candidateId"
    JOIN "Token" t ON t.id = tc."tokenId"
    LEFT JOIN LATERAL (
      SELECT stage, decision, "finalReasons"
      FROM "TradeDecisionSnapshot" d
      WHERE d."candidateId" = tc.id
      ORDER BY d."createdAt" DESC
      LIMIT 1
    ) d ON true
    WHERE co."feasibleHit500x" = true
    ORDER BY co."feasibleMaxMultiple24h" DESC NULLS LAST;
  `);

  const chartOnlyRes = await client.query<Row>(`
    SELECT
      t.symbol, t.chain, t.address,
      tc.id AS "candidateId", tc.status, tc."tradeLane", tc."qualificationPath",
      co.traded, tc."qualityScore", tc."researchConfidence",
      co."marketCapAtDetection", co."maxMarketCap24h", co."maxMultiple24h", co."feasibleMaxMultiple24h",
      tc."createdAt",
      d.stage AS "decisionStage", d.decision AS "decisionOutcome", d."finalReasons"
    FROM "CandidateOutcome" co
    JOIN "TradeCandidate" tc ON tc.id = co."candidateId"
    JOIN "Token" t ON t.id = tc."tokenId"
    LEFT JOIN LATERAL (
      SELECT stage, decision, "finalReasons"
      FROM "TradeDecisionSnapshot" d
      WHERE d."candidateId" = tc.id
      ORDER BY d."createdAt" DESC
      LIMIT 1
    ) d ON true
    WHERE co."hit1000x" = true AND co."feasibleHit500x" IS NOT TRUE
    ORDER BY co."maxMultiple24h" DESC NULLS LAST;
  `);

  await client.end();

  const feasible = feasibleRes.rows;
  const chartOnly = chartOnlyRes.rows;

  const repoRoot = path.join(__dirname, "..");
  const dataDir = path.join(repoRoot, "data");
  const docsDir = path.join(repoRoot, "docs", "trade-reviews");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(dataDir, "missed-opportunities.json"),
    JSON.stringify({ generatedAt, feasible, chartOnlyWicks: chartOnly }, null, 2) + "\n"
  );

  const fmtUsd = (n: number | null) => (n === null || n === undefined ? "—" : "$" + Math.round(n).toLocaleString());
  const fmtX = (n: number | null) => (n === null || n === undefined ? "—" : n.toFixed(1) + "x");
  const chainTag = (c: string) => (c === "solana" ? "SOL" : c === "robinhood" ? "RH" : c.toUpperCase());

  const fmtDate = (d: string | Date) => new Date(d).toISOString().slice(0, 10);
  // Table cells: strip newlines (some reasons embed a raw error/stack trace)
  // and cap length so one bad reason can't break the markdown table.
  const sanitize = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
  const reasonsFor = (r: Row, max: number) =>
    (r.finalReasons ?? []).slice(0, max).map(sanitize).join("; ").slice(0, 240);

  const rowLine = (r: Row) => {
    const reason = r.traded ? "**TRADED**" + (r.finalReasons ? " — " + reasonsFor(r, 3) : "") : reasonsFor(r, 3) || "(no decision snapshot recorded)";
    return `| ${chainTag(r.chain)} | ${r.symbol ?? "?"} | ${fmtUsd(r.marketCapAtDetection)} | ${fmtUsd(r.maxMarketCap24h)} | ${fmtX(r.feasibleMaxMultiple24h ?? r.maxMultiple24h)} | ${r.qualificationPath ?? "NORMAL"} | ${fmtDate(r.createdAt)} | ${reason} |`;
  };

  const feasibleTraded = feasible.filter((r) => r.traded);
  const feasibleMissed = feasible.filter((r) => !r.traded);

  const md = `# Missed opportunities — real (feasible) 5x+ movers

Auto-generated by \`scripts/export-missed-opportunities.ts\` on ${generatedAt}. Re-run that script to refresh.
Source: raw query against the production DB (\`CandidateOutcome\`, joined to the candidate's latest
\`TradeDecisionSnapshot\` for the rejection reason). "Feasible" means the peak also passed outcomes.ts's
sellability/depth probe — these are real, capturable moves, not thin-liquidity chart wicks (see the
chart-only section and the raw JSON for those).

## Summary

- **${feasible.length} feasible ${"≥5x"} outcomes total**, ${feasibleTraded.length} traded, **${feasibleMissed.length} missed**.
- Every missed one whose reason is visible below was rejected by the same utility/quality/credibility gate
  (\`utility class is MEME\`, \`utilityScore < 70\`, \`credibilityScore < 50\`, \`qualityScore < 65\`) — the same
  gate the utility-only pivot (commit \`0293c28\`) made the *only* path once \`MOMENTUM_OVERRIDE\` was removed.
  This list is direct evidence of the tradeoff that pivot made: real 10x-40x movers and gate-rejected meme
  tokens are, so far, the same population.
- ${chartOnly.length} more "chart-only" wicks reached 10x+ on the raw chart but failed the liquidity/sellability
  probe (see below) — not real misses, kept separately so they don't get mistaken for ones.
- **Data quality caveat:** a handful of rows below show a "hit" flag (e.g. feasibleHit1000x) alongside a
  1.0x-2.4x multiple — the boolean and the numeric peak appear to disagree for a few candidates (likely a
  stale/short-window peak the boolean never got cleared from). Treat the numeric multiple column as the
  source of truth over the presence of a row in this list; this is worth a follow-up look at outcomes.ts's
  update logic, not yet investigated.

## Feasible (real, capturable) misses — sorted by peak multiple

| Chain | Token | Entry Mcap | Peak Mcap (24h) | Multiple | Path | Detected | Why we didn't enter / what happened |
|---|---|---|---|---|---|---|---|
${feasible.map(rowLine).join("\n")}

## Chart-only wicks (NOT real misses — liquidity too thin to have sold)

These printed a big number on DexScreener but the sellability probe (outcomes.ts) found the pool couldn't
have absorbed an exit — usually because liquidity never crossed a few thousand dollars. Kept here so a future
review doesn't re-flag these as "we should have bought" without checking depth first.

| Chain | Token | Entry Mcap | Peak Mcap (24h) | Chart Multiple | Path | Detected | Why infeasible |
${chartOnly
  .slice(0, 50)
  .map(
    (r) =>
      `| ${chainTag(r.chain)} | ${r.symbol ?? "?"} | ${fmtUsd(r.marketCapAtDetection)} | ${fmtUsd(r.maxMarketCap24h)} | ${fmtX(r.maxMultiple24h)} | ${r.qualificationPath ?? "NORMAL"} | ${fmtDate(r.createdAt)} | ${reasonsFor(r, 2) || "(liquidity/depth check failed — see JSON)"} |`
  )
  .join("\n")}
${chartOnly.length > 50 ? `\n_(${chartOnly.length - 50} more in data/missed-opportunities.json)_\n` : ""}
`;

  fs.writeFileSync(path.join(docsDir, "missed-opportunities.md"), md);

  console.log(`Wrote ${feasible.length} feasible + ${chartOnly.length} chart-only rows.`);
  console.log(`  data/missed-opportunities.json`);
  console.log(`  docs/trade-reviews/missed-opportunities.md`);
}

main().catch((err) => {
  console.error("export-missed-opportunities failed:", err);
  process.exit(1);
});

import { db } from "../src/db";
import { StrategyStatus } from "../src/generated/prisma";
import type { ExitRules } from "../src/trading/strategy";

/**
 * One-off, human-run script — never invoked from the app itself. Creates the
 * stop-confirmation candidates from B5's replay (see ExitRules.stopConfirm
 * in strategy.ts) as DRAFT versions of production v1.8, each changing only
 * its stops:
 *   v1.10-confirm-s1      max-loss stop waits 30s past its line; catastrophic immediate
 *   v1.10-confirm-s2      as s1, with the catastrophic stop at 40% instead of 25%
 *   v1.10-confirm-s3      both stops wait 30s past their line
 *   v1.10-confirm-s1-15s  as s1, waiting 15s
 *   v1.10-confirm-s3-15s  as s3, waiting 15s
 * The 15s pair exists because B's replay, marking every 20-60s, can't tell
 * how long a real wick lasts (S3: +2.0 pts/trade at 30s, +5.5 at 15s on the
 * worst-case path, -1.4 close-only either way). Live and paper marks land
 * ~20s apart (median), so 15s in practice means "the next mark is still past
 * the line" and 30s "the next two are".
 * Never promotes anything: they're meant to run as paper strategies next to
 * v1.8 first, and the user promotes a winner on that evidence. Re-running
 * skips any version that already exists.
 *
 * Run with: railway run -- npx tsx scripts/create-strategy-v1_10.ts
 */
const PARENT_VERSION = "v1.8-good-project-unlimited-hold";

export function buildV110ExitRules(parent: ExitRules): Record<string, ExitRules> {
  return {
    "v1.10-confirm-s1": { ...parent, stopConfirm: { seconds: 30, appliesTo: "maxLoss" } },
    "v1.10-confirm-s2": { ...parent, stopConfirm: { seconds: 30, appliesTo: "maxLoss" }, catastrophicLossPercent: 40 },
    "v1.10-confirm-s3": { ...parent, stopConfirm: { seconds: 30, appliesTo: "both" } },
    "v1.10-confirm-s1-15s": { ...parent, stopConfirm: { seconds: 15, appliesTo: "maxLoss" } },
    "v1.10-confirm-s3-15s": { ...parent, stopConfirm: { seconds: 15, appliesTo: "both" } },
  };
}

async function main() {
  const parent = await db.strategyVersion.findFirst({ where: { name: "default", version: PARENT_VERSION } });
  if (!parent) throw new Error(`expected ${PARENT_VERSION} to exist as the parent version — check DATABASE_URL`);

  for (const [version, exitRules] of Object.entries(buildV110ExitRules(parent.exitRules as unknown as ExitRules))) {
    const existing = await db.strategyVersion.findFirst({ where: { name: "default", version } });
    if (existing) {
      console.log(`${version} already exists (${existing.id}, ${existing.status}) — skipped`);
      continue;
    }
    const created = await db.strategyVersion.create({
      data: {
        name: "default",
        version,
        status: StrategyStatus.DRAFT,
        configuration: parent.configuration as object,
        scoringWeights: parent.scoringWeights as object,
        entryRules: parent.entryRules as object,
        sizingRules: parent.sizingRules as object,
        exitRules: exitRules as unknown as object,
        parentVersionId: parent.id,
      },
    });
    console.log(`Created ${created.version} (${created.id}), status ${created.status}; stopConfirm ${JSON.stringify(exitRules.stopConfirm)}, catastrophic ${exitRules.catastrophicLossPercent}%`);
  }
  console.log("None promoted.");
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

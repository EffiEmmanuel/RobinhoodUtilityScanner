import { db } from "../src/db";
import { StrategyStatus } from "../src/generated/prisma";

/**
 * One-off, human-run script — never invoked from the app itself. Same
 * pattern as create-strategy-v1_7.ts: creates the next version as DRAFT
 * (inert until promoted — see that file's doc comment for why).
 *
 * User directive 2026-09-23: "lets hold good utility tokens for as long as
 * possible, not just 48 hours max." Changes ONLY exitRules.goodProject.
 * maxHoldMinutes (2880 -> a year) on top of v1.7 — base and fastFlip
 * profiles are byte-for-byte unchanged, so this can only ever extend
 * patience for a trade that already cleared the GOOD_PROJECT bar, never
 * regress anything else. Still only affects the underwater-only TIME_EXIT;
 * a winning position was never time-capped in the first place.
 *
 * Run with: railway run -- npx tsx scripts/create-strategy-v1_8.ts
 */
async function main() {
  const parent = await db.strategyVersion.findFirst({
    where: { name: "default", version: "v1.7-good-project-hold-and-dca" },
  });
  if (!parent) throw new Error("expected v1.7-good-project-hold-and-dca to exist as the parent version — check DATABASE_URL");

  const parentExitRules = parent.exitRules as Record<string, unknown>;
  const parentGoodProject = parentExitRules.goodProject as Record<string, unknown> | undefined;
  const exitRules = {
    ...parentExitRules,
    goodProject: {
      ...parentGoodProject,
      maxHoldMinutes: 60 * 24 * 365, // was 2880 (48h) — effectively no cap now
    },
  };

  const created = await db.strategyVersion.create({
    data: {
      name: "default",
      version: "v1.8-good-project-unlimited-hold",
      status: StrategyStatus.DRAFT,
      configuration: parent.configuration as object,
      scoringWeights: parent.scoringWeights as object,
      entryRules: parent.entryRules as object,
      sizingRules: parent.sizingRules as object,
      exitRules,
      parentVersionId: parent.id,
    },
  });

  console.log(`Created ${created.name} ${created.version} (${created.id}), status ${created.status}.`);
  console.log("Promote with:");
  console.log(`  npx tsx scripts/promote-strategy.ts ${created.id} BACKTEST SHADOW PRODUCTION`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

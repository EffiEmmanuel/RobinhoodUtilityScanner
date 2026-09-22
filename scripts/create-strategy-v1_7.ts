import { db } from "../src/db";
import { StrategyStatus } from "../src/generated/prisma";

/**
 * One-off, human-run script — never invoked from the app itself. Creates the
 * next strategy version as DRAFT (inert: getActiveStrategyVersion only ever
 * picks PRODUCTION or SHADOW, and DRAFT can't skip straight to SHADOW per
 * strategy.ts's VALID_TRANSITIONS) so this cannot silently become the live
 * strategy on insert. §68 in this codebase is explicit that an LLM must never
 * auto-promote a strategy version — this script only creates the draft;
 * promoting it (DRAFT -> BACKTEST -> SHADOW -> PRODUCTION) is a deliberate,
 * separate human action via POST /strategies/:id/promote.
 *
 * (A prior version of this file created a v1.7 with a tighter fixed
 * profit-step ladder — confirmed via a live DB read 2026-09-22 that it was
 * never actually run, no v1.7 row ever existed. That whole premise is now
 * moot: positionManager.ts no longer enforces exitRules.profitSteps at all
 * — see the 2026-09-22 "remove fixed-multiple profit-taking" commit — so
 * this file was rewritten for the version that's actually needed next.)
 *
 * User directive 2026-09-22: "increase hold time for good projects to as
 * long as 48 hours, we can even dca if the narrative or utility project is
 * very good... good community on X too." Adds ONLY a new exitRules.
 * goodProject tier on top of v1.6, unchanged otherwise — base and fastFlip
 * profiles are byte-for-byte what's already live, so promoting this can only
 * ever ADD the new tier's behavior, never regress existing behavior.
 * goodProject requires resolveProjectTier's existing fastFlip-eligibility
 * check to have already cleared (not low-quality, not an unproven large
 * entry) AND ResearchRun.socialScore >= 60 — socialScore is the research
 * synthesizer's own judgment of a genuine (non-bot) X community, populated
 * identically for utility- and narrative-lane trades (narratives.ts sets
 * socialScore: score.xScore), so this one field covers "good community on X"
 * for both the same way the user asked. See strategy.ts's ExitRules.
 * goodProject doc comment and positionManager.ts's resolveExitRules.
 *
 * Run with: railway run -- npx tsx scripts/create-strategy-v1_7.ts
 * (needs production DATABASE_URL — see the deploy/DB-querying references in
 * project memory for why a local run authenticates far more slowly.)
 */
async function main() {
  const parent = await db.strategyVersion.findFirst({
    where: { name: "default", version: "v1.6" },
  });
  if (!parent) throw new Error("expected v1.6 to exist as the parent version — check `railway run -- npx tsx scripts/create-strategy-v1_7.ts` is running against the right DATABASE_URL");

  const parentExitRules = parent.exitRules as Record<string, unknown>;
  const exitRules = {
    ...parentExitRules,
    goodProject: {
      minSocialScoreToQualify: 60,
      maxHoldMinutes: 48 * 60, // 2880 — was 1440 (24h) for every non-fastFlip trade before this tier existed
    },
  };

  const created = await db.strategyVersion.create({
    data: {
      name: "default",
      version: "v1.7-good-project-hold-and-dca",
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
  console.log("This is inert until promoted. Backtest it first:");
  console.log(`  POST /trading/backtest { "strategyVersionId": "${created.id}" }`);
  console.log("Then promote step by step when you're satisfied:");
  console.log(`  POST /strategies/${created.id}/promote { "status": "BACKTEST" }`);
  console.log(`  POST /strategies/${created.id}/promote { "status": "SHADOW" }`);
  console.log(`  POST /strategies/${created.id}/promote { "status": "PRODUCTION" }`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

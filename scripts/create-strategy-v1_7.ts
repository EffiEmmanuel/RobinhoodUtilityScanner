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
 * User directive 2026-09-13: "be aggressive with taking profit... the goal
 * is to take profit." v1.6 (the current fallback-active version — nothing
 * has ever actually been promoted to PRODUCTION; getActiveStrategyVersion
 * falls back to the most recent SHADOW) only arms its trailing stop at 1.6x
 * with a 20% giveback for anything outside the fastFlip profile, and takes
 * no partial profit before 2x. fastFlip already moved to 1.2x/12% back in
 * v1.2 (2026-09-11) without a regression since — this brings the default
 * (non-fastFlip) profile in line with that, plus an earlier profit ladder
 * (1.4x/1.8x/2.5x instead of just 2x/2.5x) so a pump that reverses before 2x
 * still banks something instead of round-tripping to a loss. Loss-side
 * thresholds (maxLossPercent, catastrophicLossPercent) are unchanged from
 * v1.6 — this is a profit-taking change, not a risk-tolerance change.
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

  const exitRules = {
    profitSteps: [
      { multiple: 1.4, sellPercentOfRemaining: 30 },
      { multiple: 1.8, sellPercentOfRemaining: 30 },
      { multiple: 2.5, sellPercentOfRemaining: 30 },
    ],
    trailRemaining: true,
    trailingActivationMultiple: 1.2,
    trailingPercent: 12,
    maxLossPercent: (parent.exitRules as { maxLossPercent: number }).maxLossPercent,
    catastrophicLossPercent: (parent.exitRules as { catastrophicLossPercent: number }).catastrophicLossPercent,
    maxHoldMinutes: (parent.exitRules as { maxHoldMinutes: number }).maxHoldMinutes,
    fastFlip: (parent.exitRules as { fastFlip: unknown }).fastFlip,
  };

  const created = await db.strategyVersion.create({
    data: {
      name: "default",
      version: "v1.7-aggressive-profit-taking",
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

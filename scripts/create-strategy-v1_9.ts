import { db } from "../src/db";
import { StrategyStatus } from "../src/generated/prisma";
import type { ExitRules } from "../src/trading/strategy";

/**
 * One-off, human-run script — never invoked from the app itself. Same
 * pattern as create-strategy-v1_8.ts: creates the next version as DRAFT,
 * inert until someone promotes it with scripts/promote-strategy.ts. This
 * script never promotes anything.
 *
 * v1.9 changes the exit shape for the bot's own entries (manual buy-and-hold
 * positions are untouched — positionManager.ts's resolveExitRules strips
 * costRecovery for them):
 * - costRecovery: at 2x, sell just enough to get back everything the
 *   position cost (computed per trade, ~53% at 2x); the rest rides with a
 *   45% trailing stop from its peak, and the AI review can't sell it while
 *   it's in profit. See ExitRules.costRecovery in strategy.ts.
 * - fastFlip loses its early 1.2x/12% trail and its 1.5x/2x profit steps;
 *   the FAST_FLIP tier keeps only its underwater-only 60-minute time exit
 *   (and its zero re-entry budget).
 * Loss stops (15% / 25% catastrophic), the base 1.6x/20% trail before cost
 * recovery, and the good-project hold are unchanged from v1.8.
 *
 * This reverses the 2026-09-22 "no fixed profit-taking multiples" directive
 * for any trade under it, so promote only on the user's explicit decision,
 * after the v1.8-vs-v1.9 backtest.
 *
 * Run with: railway run -- npx tsx scripts/create-strategy-v1_9.ts
 */
const PARENT_VERSION = "v1.8-good-project-unlimited-hold";
const VERSION = "v1.9-cost-recovery-runner";

async function main() {
  const existing = await db.strategyVersion.findFirst({ where: { name: "default", version: VERSION } });
  if (existing) throw new Error(`${VERSION} already exists (${existing.id}, ${existing.status}) — nothing to do`);

  const parent = await db.strategyVersion.findFirst({ where: { name: "default", version: PARENT_VERSION } });
  if (!parent) throw new Error(`expected ${PARENT_VERSION} to exist as the parent version — check DATABASE_URL`);

  const exitRules = buildV19ExitRules(parent.exitRules as unknown as ExitRules);

  const created = await db.strategyVersion.create({
    data: {
      name: "default",
      version: VERSION,
      status: StrategyStatus.DRAFT,
      configuration: parent.configuration as object,
      scoringWeights: parent.scoringWeights as object,
      entryRules: parent.entryRules as object,
      sizingRules: parent.sizingRules as object,
      exitRules: exitRules as unknown as object,
      parentVersionId: parent.id,
    },
  });

  console.log(`Created ${created.name} ${created.version} (${created.id}), status ${created.status}. exitRules:`);
  console.log(JSON.stringify(exitRules, null, 2));
  console.log("Not promoted. After the backtest, and only on the user's decision:");
  console.log(`  npx tsx scripts/promote-strategy.ts ${created.id} BACKTEST SHADOW PRODUCTION`);
}

export function buildV19ExitRules(parent: ExitRules): ExitRules {
  if (!parent.fastFlip) throw new Error("parent exitRules has no fastFlip block — expected v1.8's");
  const { profitSteps: _steps, trailingActivationMultiple: _activation, trailingPercent: _trail, ...fastFlipTier } = parent.fastFlip;
  return {
    ...parent,
    fastFlip: fastFlipTier,
    costRecovery: { triggerMultiple: 2, sellCostBufferPercent: 3, moonbagTrailingPercent: 45 },
  };
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

import { StrategyStatus } from "../src/generated/prisma";
import { promoteStrategyVersion } from "../src/trading/strategy";

/**
 * One-off, human-run script — never invoked from the app itself, mirroring
 * create-strategy-v1_7.ts's own convention. §68: "never allow an LLM to
 * auto-promote a strategy" — this script exists so a human's explicit,
 * named instruction (this exact command, with this exact id and status)
 * is what executes the promotion, not the trading system's own AI deciding
 * on its own to advance a version based on live performance.
 *
 * Enforces the same DRAFT -> BACKTEST -> SHADOW -> PRODUCTION state machine
 * promoteStrategyVersion always has (see strategy.ts's VALID_TRANSITIONS) —
 * this is a thin CLI wrapper around that function, not a bypass of it.
 *
 * Run with: railway run -- npx tsx scripts/promote-strategy.ts <versionId> <status>
 * Chain multiple statuses to walk through several steps in one run:
 *   railway run -- npx tsx scripts/promote-strategy.ts <versionId> BACKTEST SHADOW PRODUCTION
 */
async function main() {
  const [id, ...statuses] = process.argv.slice(2);
  if (!id || statuses.length === 0) {
    throw new Error("Usage: npx tsx scripts/promote-strategy.ts <versionId> <status> [status...]");
  }
  for (const status of statuses) {
    if (!(Object.values(StrategyStatus) as string[]).includes(status)) {
      throw new Error(`invalid status "${status}" — must be one of ${Object.values(StrategyStatus).join(", ")}`);
    }
  }

  for (const status of statuses) {
    const result = await promoteStrategyVersion(id, status as StrategyStatus);
    console.log(`Promoted ${result.name} ${result.version} (${result.id}) -> ${result.status}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

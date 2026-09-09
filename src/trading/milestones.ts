import { db } from "../db";
import { logger } from "../logger";
import { getPortfolioState } from "./portfolio";
import { sendMilestoneEmail } from "./notifications";

// §43 — a starting paper balance can already exceed some of these; those get
// seeded as already-reached with no notification so the very first portfolio
// check doesn't spuriously email "you hit $500!" for money that was just
// deposited, not earned.
const DEFAULT_MILESTONE_TARGETS = [50, 100, 200, 500, 1000, 2000, 5000];

async function ensureMilestonesSeeded(): Promise<void> {
  const existingCount = await db.portfolioMilestone.count();
  if (existingCount > 0) return;
  const state = await getPortfolioState();
  for (const target of DEFAULT_MILESTONE_TARGETS) {
    const alreadyPast = state.totalEquityUsd >= target;
    await db.portfolioMilestone.create({
      data: {
        targetUsd: target,
        reached: alreadyPast,
        reachedAt: alreadyPast ? new Date() : null,
        equityAtReach: alreadyPast ? state.totalEquityUsd : null,
        notificationSent: alreadyPast, // suppress a spurious email for the starting deposit
      },
    });
  }
  logger.info({ targets: DEFAULT_MILESTONE_TARGETS }, "seeded portfolio milestones");
}

export async function checkPortfolioMilestones(): Promise<void> {
  await ensureMilestonesSeeded();
  const state = await getPortfolioState();
  const unreached = await db.portfolioMilestone.findMany({ where: { reached: false }, orderBy: { targetUsd: "asc" } });

  for (const milestone of unreached) {
    if (state.totalEquityUsd < milestone.targetUsd) continue;
    await db.portfolioMilestone.update({
      where: { id: milestone.id },
      data: { reached: true, reachedAt: new Date(), equityAtReach: state.totalEquityUsd },
    });
    try {
      await sendMilestoneEmail({ targetUsd: milestone.targetUsd, portfolio: state });
      await db.portfolioMilestone.update({ where: { id: milestone.id }, data: { notificationSent: true } });
    } catch (err) {
      logger.error({ targetUsd: milestone.targetUsd, err: String(err) }, "failed to send milestone email");
    }
    logger.info({ targetUsd: milestone.targetUsd, equity: state.totalEquityUsd }, "portfolio milestone reached");
  }
}

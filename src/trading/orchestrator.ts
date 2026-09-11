import { db } from "../db";
import { logger } from "../logger";
import { sleep } from "../util/http";
import { retryAsync } from "../util/retry";
import { TradeCandidateStatus } from "../generated/prisma";
import { tradingConfig } from "./config";
import { generateTradeCandidates } from "./candidates";
import { planCandidate } from "./planning";
import { processPendingEntries, recoverStuckPendingEntries } from "./entryMonitor";
import { runPositionMonitorTick } from "./positionManager";
import { pollCandidateOutcomes } from "./outcomes";
import { ensurePaperWalletSeeded, recordPortfolioSnapshot } from "./portfolio";
import { getActiveStrategyVersion } from "./strategy";

const CANDIDATE_GENERATION_INTERVAL_SECONDS = 30;
const OUTCOME_POLL_INTERVAL_SECONDS = 300; // 5 min — this is 15m/1h/6h/24h/48h bucketed data, no need to hammer it
const CLAIM_IDLE_DELAY_MS = 3000;

async function claimNextQualifiedCandidate(): Promise<string | undefined> {
  const candidate = await db.tradeCandidate.findFirst({
    where: { status: TradeCandidateStatus.QUALIFIED },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return undefined;
  const result = await db.tradeCandidate.updateMany({
    where: { id: candidate.id, status: TradeCandidateStatus.QUALIFIED },
    data: { status: TradeCandidateStatus.PLANNING },
  });
  return result.count === 1 ? candidate.id : undefined;
}

async function recoverStuckCandidates(): Promise<void> {
  const result = await db.tradeCandidate.updateMany({
    where: { status: TradeCandidateStatus.PLANNING },
    data: { status: TradeCandidateStatus.QUALIFIED },
  });
  if (result.count > 0) logger.info({ count: result.count }, "recovered trade candidates stuck from a previous run");
}

async function planningLoop(signal: { stopped: boolean }): Promise<void> {
  while (!signal.stopped) {
    const candidateId = await claimNextQualifiedCandidate();
    if (!candidateId) {
      await sleep(CLAIM_IDLE_DELAY_MS);
      continue;
    }
    try {
      await planCandidate(candidateId);
    } catch (err) {
      logger.error({ candidateId, err: String(err) }, "trade planning failed");
      await db.tradeCandidate.update({ where: { id: candidateId }, data: { status: TradeCandidateStatus.REJECTED } });
    }
  }
}

// Floor between a replan and the next time that same candidate can be
// re-evaluated — confirmed live: without this, a fast-breakout token got
// replanned 6 times in under 30 seconds (each one immediately invalidated,
// planAgeMinutes: 0) because this loop treated "replanned" the same as any
// other "did work" tick and re-grabbed the brand-new pending entry with zero
// delay, before the market could possibly have moved relative to the ceiling
// that replan had just set. Short enough to stay responsive; long enough that
// a replan actually gets a few ticks of real price movement before being
// judged stale again.
const REPLAN_COOLDOWN_SECONDS = 10;

async function entryMonitorLoop(signal: { stopped: boolean }): Promise<void> {
  while (!signal.stopped) {
    const result = await processPendingEntries();
    if (result === "idle") await sleep(tradingConfig.pendingEntryMonitorIntervalSeconds * 1000);
    else if (result === "replanned") await sleep(REPLAN_COOLDOWN_SECONDS * 1000);
  }
}

async function positionMonitorLoop(signal: { stopped: boolean }): Promise<void> {
  while (!signal.stopped) {
    try {
      await runPositionMonitorTick();
    } catch (err) {
      logger.error({ err: String(err) }, "position monitor tick failed");
    }
    await sleep(tradingConfig.positionMonitorIntervalSeconds * 1000);
  }
}

async function candidateGenerationLoop(signal: { stopped: boolean }): Promise<void> {
  while (!signal.stopped) {
    try {
      const created = await generateTradeCandidates();
      if (created > 0) logger.info({ created }, "trade candidates generated");
    } catch (err) {
      logger.error({ err: String(err) }, "trade candidate generation failed");
    }
    await sleep(CANDIDATE_GENERATION_INTERVAL_SECONDS * 1000);
  }
}

async function outcomePollLoop(signal: { stopped: boolean }): Promise<void> {
  while (!signal.stopped) {
    try {
      const updated = await pollCandidateOutcomes();
      if (updated > 0) logger.info({ updated }, "candidate outcomes updated");
    } catch (err) {
      logger.error({ err: String(err) }, "candidate outcome poll failed");
    }
    await sleep(OUTCOME_POLL_INTERVAL_SECONDS * 1000);
  }
}

export async function startTradingOrchestrator(): Promise<() => void> {
  if (tradingConfig.mode === "DISABLED") {
    logger.info("trading extension is DISABLED (TRADING_MODE=DISABLED) — not starting any trading loops");
    return () => {};
  }

  // Retried in case this is the first DB call of the process (cold Neon compute).
  await retryAsync("trading orchestrator startup", async () => {
    await ensurePaperWalletSeeded();
    await getActiveStrategyVersion(); // ensure a strategy version exists before anything else runs
    await recoverStuckCandidates();
    await recoverStuckPendingEntries();
    await recordPortfolioSnapshot();
  });

  logger.info({ mode: tradingConfig.mode, tradingEnabled: tradingConfig.tradingEnabled }, "starting trading orchestrator");

  const signal = { stopped: false };
  const loops = [
    candidateGenerationLoop(signal),
    planningLoop(signal),
    entryMonitorLoop(signal),
    positionMonitorLoop(signal),
    outcomePollLoop(signal),
  ];
  Promise.allSettled(loops);

  return () => {
    signal.stopped = true;
  };
}

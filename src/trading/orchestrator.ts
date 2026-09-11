import { db } from "../db";
import { logger } from "../logger";
import { sleep } from "../util/http";
import { retryAsync } from "../util/retry";
import { TradeCandidateStatus } from "../generated/prisma";
import { tradingConfig } from "./config";
import { generateTradeCandidates } from "./candidates";
import { planCandidate } from "./planning";
import { processPendingEntries, recoverStuckPendingEntries, recoverStalledRevalidatingEntries } from "./entryMonitor";
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
    // Same class of bug fixed in entryMonitorLoop below: claimNextQualifiedCandidate
    // itself was unprotected — a transient failure there (not inside
    // planCandidate) would throw uncaught and silently kill this entire loop
    // for the rest of the process's life, meaning no QUALIFIED candidate
    // would ever become a TradePlan again.
    let candidateId: string | undefined;
    try {
      candidateId = await claimNextQualifiedCandidate();
    } catch (err) {
      logger.error({ err: String(err) }, "claiming next qualified candidate failed — will retry next tick");
      await sleep(CLAIM_IDLE_DELAY_MS);
      continue;
    }
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

// How often the stalled-REVALIDATING sweep runs — a periodic backstop, not
// the hot path, so a coarse interval checked once per loop iteration (via a
// plain timestamp, not a second setInterval/loop) is enough. See
// recoverStalledRevalidatingEntries in entryMonitor.ts for why this exists.
const STALLED_REVALIDATING_SWEEP_INTERVAL_SECONDS = 60;

async function entryMonitorLoop(signal: { stopped: boolean }): Promise<void> {
  let lastStalledSweepAt = 0;

  while (!signal.stopped) {
    // Confirmed live 2026-09-11: processPendingEntries()'s own try/catch only
    // ever covered evaluateOnePendingEntry — the pendingEntry.findFirst/claim
    // calls before it (and this call itself) had no protection at all. A
    // single transient failure there (a Neon cold-start connection reset is
    // a documented, recurring issue in this exact codebase — see db.ts) threw
    // uncaught, this while loop's async function rejected and exited, and
    // since it's fired once via Promise.allSettled in
    // startTradingOrchestrator with nothing supervising or restarting it,
    // entry processing died silently for the rest of the process's life —
    // zero log line, zero recovery. Confirmed against four separate live
    // BUY_NOW/WAIT_FOR_ENTRY pending entries (WOOD, LOCK, DIVIDEND, SCHIFFY)
    // that sat with lastCheckedAt: null minutes after being created, even
    // immediately following a fresh restart — this is almost certainly the
    // dominant cause of every missed entry tonight (RWA, PEG, TFLY,
    // DIVIDEND), not decision latency. positionMonitorLoop already has this
    // exact protection below; entryMonitorLoop never did.
    try {
      if (Date.now() - lastStalledSweepAt >= STALLED_REVALIDATING_SWEEP_INTERVAL_SECONDS * 1000) {
        lastStalledSweepAt = Date.now();
        await recoverStalledRevalidatingEntries();
      }
      const result = await processPendingEntries();
      // "replanned" no longer gets a separate cooldown — processPendingEntries
      // now evaluates a whole batch of the oldest ACTIVE rows per tick (see
      // entryMonitor.ts), and a freshly-replanned entry is a brand-new row
      // that sorts to the back of that same queue, so it naturally can't be
      // re-grabbed until everything older than it has had a turn.
      if (result === "idle") await sleep(tradingConfig.pendingEntryMonitorIntervalSeconds * 1000);
    } catch (err) {
      logger.error({ err: String(err) }, "entry monitor tick failed — will retry next tick");
      await sleep(tradingConfig.pendingEntryMonitorIntervalSeconds * 1000);
    }
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

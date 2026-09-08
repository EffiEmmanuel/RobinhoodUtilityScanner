import { db } from "../db";
import { config } from "../config";
import { logger } from "../logger";
import { sleep } from "../util/http";
import { runDiscoveryPoll } from "./discover";
import { classifyToken } from "./classify";
import { researchToken } from "./research";
import { TokenStatus } from "../generated/prisma";
import type { Token } from "../generated/prisma";

const WORKER_CONCURRENCY = 2;
const WORKER_IDLE_DELAY_MS = 3000;

export const health = {
  lastDiscoveryPollAt: undefined as Date | undefined,
  lastDiscoveryError: undefined as string | undefined,
  running: false,
};

/**
 * Atomically hand one token in `fromStatus` to the caller, flipping it to
 * `toStatus` in the same conditional update. If two workers race for the
 * same row, only one `updateMany` actually matches (the loser's `where`
 * no longer matches once the winner has moved the status) — this is what
 * stops two workers from both paying for the same AI classification call.
 */
async function claim(fromStatus: TokenStatus, toStatus: TokenStatus): Promise<Token | null> {
  const candidate = await db.token.findFirst({ where: { status: fromStatus }, orderBy: { firstSeenAt: "asc" } });
  if (!candidate) return null;
  const result = await db.token.updateMany({ where: { id: candidate.id, status: fromStatus }, data: { status: toStatus } });
  return result.count === 1 ? candidate : null;
}

/**
 * A crash mid-pipeline leaves a token stuck in the transient CLASSIFYING/
 * RESEARCHING claim states forever (nothing re-queues them). Called once at
 * startup so a restart resumes cleanly instead of silently dropping whatever
 * was in flight.
 */
async function recoverStuckTokens(): Promise<void> {
  const [reclassify, reresearch] = await Promise.all([
    db.token.updateMany({ where: { status: TokenStatus.CLASSIFYING }, data: { status: TokenStatus.DETECTED } }),
    db.token.updateMany({ where: { status: TokenStatus.RESEARCHING }, data: { status: TokenStatus.RESEARCH_QUEUED } }),
  ]);
  if (reclassify.count || reresearch.count) {
    logger.info({ reclassify: reclassify.count, reresearch: reresearch.count }, "recovered tokens stuck from a previous run");
  }
}

/**
 * Token.status IS the job queue (DETECTED -> CLASSIFYING -> RESEARCH_QUEUED
 * -> RESEARCHING -> ALERTED/WATCHLISTED/REJECTED). No Redis/BullMQ needed at
 * this scale.
 */
async function processOneToken(): Promise<boolean> {
  const toClassify = await claim(TokenStatus.DETECTED, TokenStatus.CLASSIFYING);
  if (toClassify) {
    try {
      await classifyToken(toClassify.id);
    } catch (err) {
      logger.error({ tokenId: toClassify.id, err: String(err) }, "classification failed");
      await db.token.update({ where: { id: toClassify.id }, data: { status: TokenStatus.FAILED } });
    }
    return true;
  }

  const toResearch = await claim(TokenStatus.RESEARCH_QUEUED, TokenStatus.RESEARCHING);
  if (toResearch) {
    try {
      await researchToken(toResearch.id);
    } catch (err) {
      logger.error({ tokenId: toResearch.id, err: String(err) }, "research failed");
      await db.token.update({ where: { id: toResearch.id }, data: { status: TokenStatus.FAILED } });
    }
    return true;
  }

  return false;
}

async function workerLoop(workerId: number, signal: { stopped: boolean }): Promise<void> {
  while (!signal.stopped) {
    let didWork = false;
    try {
      didWork = await processOneToken();
    } catch (err) {
      logger.error({ workerId, err: String(err) }, "worker loop iteration failed");
    }
    if (!didWork) await sleep(WORKER_IDLE_DELAY_MS);
  }
}

async function discoveryLoop(signal: { stopped: boolean }): Promise<void> {
  while (!signal.stopped) {
    try {
      const result = await runDiscoveryPoll();
      health.lastDiscoveryPollAt = new Date();
      health.lastDiscoveryError = undefined;
      if (result.created > 0) {
        logger.info(result, "discovery poll complete");
      }
    } catch (err) {
      health.lastDiscoveryError = String(err);
      logger.error({ err: String(err) }, "discovery poll crashed");
    }
    await sleep(config.discoveryIntervalSeconds * 1000);
  }
}

export async function startOrchestrator(): Promise<() => void> {
  await recoverStuckTokens();

  const signal = { stopped: false };
  health.running = true;

  const loops = [discoveryLoop(signal), ...Array.from({ length: WORKER_CONCURRENCY }, (_, i) => workerLoop(i, signal))];

  Promise.allSettled(loops).then(() => {
    health.running = false;
  });

  return () => {
    signal.stopped = true;
  };
}

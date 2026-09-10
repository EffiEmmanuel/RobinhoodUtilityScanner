import { ApiError } from "@google/genai";
import { db } from "../db";
import { config } from "../config";
import { logger } from "../logger";
import { sleep } from "../util/http";
import { retryAsync } from "../util/retry";
import { runDiscoveryPoll, promoteActiveAwaitingProfile } from "./discover";
import { runOnchainDiscoveryPoll } from "./onchainDiscovery";
import { classifyToken } from "./classify";
import { researchToken } from "./research";
import { TokenStatus } from "../generated/prisma";
import type { Token } from "../generated/prisma";

const WORKER_CONCURRENCY = 2;
const WORKER_IDLE_DELAY_MS = 3000;
// Still slower than the discovery loops (each run can fetch market data for
// up to 100 waiting tokens, and DexScreener's public API is shared with the
// core discovery polls that matter more) but tightened from 5 minutes to 1 —
// a real DexScreener profile appearing is caught almost immediately by
// discoveryLoop's 15s poll (see runDiscoveryPoll), but a token that never
// gets an official profile relies entirely on this sweep noticing its real
// trading activity, so making it wait a full 5 minutes was needless latency
// once the fair round-robin ordering below made a wider sweep interval
// unnecessary for correctness.
const AWAITING_PROFILE_ACTIVITY_INTERVAL_SECONDS = 60;
// A 429 from Gemini here is almost always the free-tier's per-day request
// cap, not a transient blip — hammering it every 3s just burns DB/CPU and
// floods logs until the quota resets. Back off for a while instead, and
// critically: requeue the token to where it came from rather than FAILED —
// FAILED never gets retried by anything, so treating a quota hit the same as
// a genuine bug silently drops real candidates for the rest of the day.
const QUOTA_COOLDOWN_MS = 5 * 60 * 1000;
let classifyCooldownUntil = 0;
let researchCooldownUntil = 0;

function isQuotaExhausted(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429;
}

export const health = {
  lastDiscoveryPollAt: undefined as Date | undefined,
  lastDiscoveryError: undefined as string | undefined,
  lastOnchainDiscoveryPollAt: undefined as Date | undefined,
  lastOnchainDiscoveryError: undefined as string | undefined,
  lastActivityCheckAt: undefined as Date | undefined,
  lastActivityCheckError: undefined as string | undefined,
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
  const now = Date.now();

  if (now >= classifyCooldownUntil) {
    const toClassify = await claim(TokenStatus.DETECTED, TokenStatus.CLASSIFYING);
    if (toClassify) {
      try {
        await classifyToken(toClassify.id);
      } catch (err) {
        if (isQuotaExhausted(err)) {
          classifyCooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
          logger.warn({ tokenId: toClassify.id, cooldownMs: QUOTA_COOLDOWN_MS }, "classification hit an AI quota/rate limit — requeued, pausing classification briefly");
          await db.token.update({ where: { id: toClassify.id }, data: { status: TokenStatus.DETECTED } });
        } else {
          logger.error({ tokenId: toClassify.id, err: String(err) }, "classification failed");
          await db.token.update({ where: { id: toClassify.id }, data: { status: TokenStatus.FAILED } });
        }
      }
      return true;
    }
  }

  if (now >= researchCooldownUntil) {
    const toResearch = await claim(TokenStatus.RESEARCH_QUEUED, TokenStatus.RESEARCHING);
    if (toResearch) {
      try {
        await researchToken(toResearch.id);
      } catch (err) {
        if (isQuotaExhausted(err)) {
          researchCooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
          logger.warn({ tokenId: toResearch.id, cooldownMs: QUOTA_COOLDOWN_MS }, "research hit an AI quota/rate limit — requeued, pausing research briefly");
          await db.token.update({ where: { id: toResearch.id }, data: { status: TokenStatus.RESEARCH_QUEUED } });
        } else {
          logger.error({ tokenId: toResearch.id, err: String(err) }, "research failed");
          await db.token.update({ where: { id: toResearch.id }, data: { status: TokenStatus.FAILED } });
        }
      }
      return true;
    }
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

async function onchainDiscoveryLoop(signal: { stopped: boolean }): Promise<void> {
  while (!signal.stopped) {
    try {
      const result = await runOnchainDiscoveryPoll();
      health.lastOnchainDiscoveryPollAt = new Date();
      health.lastOnchainDiscoveryError = undefined;
      if (result.created > 0) {
        logger.info(result, "on-chain discovery poll complete");
      }
    } catch (err) {
      health.lastOnchainDiscoveryError = String(err);
      logger.error({ err: String(err) }, "on-chain discovery poll crashed");
    }
    await sleep(config.onchainDiscoveryIntervalSeconds * 1000);
  }
}

async function awaitingProfileActivityLoop(signal: { stopped: boolean }): Promise<void> {
  while (!signal.stopped) {
    try {
      const result = await promoteActiveAwaitingProfile();
      health.lastActivityCheckAt = new Date();
      health.lastActivityCheckError = undefined;
      if (result.promoted > 0) {
        logger.info(result, "promoted on-chain tokens to AI review based on real trading activity");
      }
    } catch (err) {
      health.lastActivityCheckError = String(err);
      logger.error({ err: String(err) }, "awaiting-profile activity check crashed");
    }
    await sleep(AWAITING_PROFILE_ACTIVITY_INTERVAL_SECONDS * 1000);
  }
}

export async function startOrchestrator(): Promise<() => void> {
  // The first DB call of the process, most likely to hit a cold Neon compute.
  await retryAsync("recoverStuckTokens", recoverStuckTokens);

  const signal = { stopped: false };
  health.running = true;

  const loops = [
    discoveryLoop(signal),
    onchainDiscoveryLoop(signal),
    awaitingProfileActivityLoop(signal),
    ...Array.from({ length: WORKER_CONCURRENCY }, (_, i) => workerLoop(i, signal)),
  ];

  Promise.allSettled(loops).then(() => {
    health.running = false;
  });

  return () => {
    signal.stopped = true;
  };
}

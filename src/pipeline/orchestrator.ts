import { ApiError } from "@google/genai";
import { db } from "../db";
import { config } from "../config";
import { logger } from "../logger";
import { sleep } from "../util/http";
import { retryAsync } from "../util/retry";
import { summarizeError } from "../util/errors";
import { runDiscoveryPoll, promoteActiveAwaitingProfile } from "./discover";
import { runOnchainDiscoveryPoll } from "./onchainDiscovery";
import { classifyToken } from "./classify";
import { researchToken } from "./research";
import { TokenStatus } from "../generated/prisma";
import type { Token } from "../generated/prisma";
import { runWalletTrackingPoll } from "../walletTracking/poller";

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
  lastWalletTrackingPollAt: undefined as Date | undefined,
  lastWalletTrackingError: undefined as string | undefined,
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
          logger.error({ tokenId: toClassify.id, err: summarizeError(err) }, "classification failed");
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
          logger.error({ tokenId: toResearch.id, err: summarizeError(err) }, "research failed");
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
      logger.error({ workerId, err: summarizeError(err) }, "worker loop iteration failed");
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
      health.lastDiscoveryError = summarizeError(err);
      logger.error({ err: summarizeError(err) }, "discovery poll crashed");
    }
    await sleep(config.discoveryIntervalSeconds * 1000);
  }
}

// Confirmed live 2026-09-11: Robinhood Chain's RPC (and its own fallback)
// were Cloudflare-blocked for an extended stretch, so runOnchainDiscoveryPoll
// crashed on every single tick — at the default 3s interval that's a crash
// roughly every 3-4 seconds, sustained for many minutes straight, each one
// previously logging a multi-KB raw HTML error body (see summarizeError's
// own history in portfolio.ts). That volume of synchronous stdout writes
// coincided with the position/entry monitor loops elsewhere in this same
// process going from their normal sub-minute cadence to multi-minute gaps
// between ticks during the exact same window — confirmed against a live
// pending BUY_NOW entry (TFLY) that should have been evaluated within
// seconds of being queued and instead sat unchecked for 5+ minutes, long
// enough for the token to run past its entry ceiling before ever being
// looked at. Backing off on sustained failure — same rationale as this
// file's own QUOTA_COOLDOWN_MS above — fixes the log volume regardless of
// the exact mechanism, and stops hammering a provider that's already
// telling us no for minutes at a stretch.
const ONCHAIN_DISCOVERY_MAX_BACKOFF_SECONDS = 120;
let onchainDiscoveryConsecutiveFailures = 0;

async function onchainDiscoveryLoop(signal: { stopped: boolean }): Promise<void> {
  while (!signal.stopped) {
    try {
      const result = await runOnchainDiscoveryPoll();
      health.lastOnchainDiscoveryPollAt = new Date();
      health.lastOnchainDiscoveryError = undefined;
      onchainDiscoveryConsecutiveFailures = 0;
      if (result.created > 0) {
        logger.info(result, "on-chain discovery poll complete");
      }
    } catch (err) {
      health.lastOnchainDiscoveryError = summarizeError(err);
      onchainDiscoveryConsecutiveFailures++;
      logger.error({ err: summarizeError(err), consecutiveFailures: onchainDiscoveryConsecutiveFailures }, "on-chain discovery poll crashed");
    }
    const backoffSeconds =
      onchainDiscoveryConsecutiveFailures > 0
        ? Math.min(config.onchainDiscoveryIntervalSeconds * 2 ** (onchainDiscoveryConsecutiveFailures - 1), ONCHAIN_DISCOVERY_MAX_BACKOFF_SECONDS)
        : config.onchainDiscoveryIntervalSeconds;
    await sleep(backoffSeconds * 1000);
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
      health.lastActivityCheckError = summarizeError(err);
      logger.error({ err: summarizeError(err) }, "awaiting-profile activity check crashed");
    }
    await sleep(AWAITING_PROFILE_ACTIVITY_INTERVAL_SECONDS * 1000);
  }
}

const WALLET_TRACKING_MAX_BACKOFF_SECONDS = 120;
let walletTrackingConsecutiveFailures = 0;

async function walletTrackingLoop(signal: { stopped: boolean }): Promise<void> {
  while (!signal.stopped) {
    try {
      const result = await runWalletTrackingPoll();
      health.lastWalletTrackingPollAt = new Date();
      health.lastWalletTrackingError = undefined;
      walletTrackingConsecutiveFailures = 0;
      if (result.events > 0 || result.discoveredTokens > 0) {
        logger.info(result, "wallet tracking detected token movement");
      }
    } catch (err) {
      health.lastWalletTrackingError = summarizeError(err);
      walletTrackingConsecutiveFailures++;
      logger.error({ err: summarizeError(err), consecutiveFailures: walletTrackingConsecutiveFailures }, "wallet tracking poll crashed");
    }
    const backoffSeconds =
      walletTrackingConsecutiveFailures > 0
        ? Math.min(config.walletTrackingIntervalSeconds * 2 ** (walletTrackingConsecutiveFailures - 1), WALLET_TRACKING_MAX_BACKOFF_SECONDS)
        : config.walletTrackingIntervalSeconds;
    await sleep(backoffSeconds * 1000);
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
    walletTrackingLoop(signal),
    ...Array.from({ length: WORKER_CONCURRENCY }, (_, i) => workerLoop(i, signal)),
  ];

  Promise.allSettled(loops).then(() => {
    health.running = false;
  });

  return () => {
    signal.stopped = true;
  };
}

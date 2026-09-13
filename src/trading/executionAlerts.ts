import { logger } from "../logger";
import { tradingConfig } from "./config";
import { sendExecutionFailureEmail } from "./notifications";

/**
 * Decides WHEN a run of failing buys/sells is worth emailing about — the
 * email bodies themselves live in notifications.ts.
 *
 * Why this needs thresholds at all: the position monitor retries a failed
 * sell every positionMonitorIntervalSeconds (2s), so a naive "email on
 * failure" would send thousands of messages for a single stuck position.
 * And a one-off failure is genuinely routine here — an RPC blip, a
 * momentarily-too-thin quote — so alerting on the first one would train the
 * inbox to be ignored, which is worse than no alert.
 *
 * Sells and buys need different shapes:
 *  - A failing SELL retries the same position forever, so what matters is
 *    how LONG it's been stuck (a stuck sell means an un-exitable position).
 *    Tracked per token, alerted once it's been failing continuously past
 *    sellFailureAlertAfterMinutes.
 *  - A failing BUY doesn't retry — the candidate is rejected and the bot
 *    moves on — so per-token duration means nothing. What matters is the
 *    RATE across all tokens: several buys failing in a short window is the
 *    signal that something systemic (RPC, gas, routing) is broken.
 */

interface FailureState {
  firstFailedAt: number;
  lastFailedAt: number;
  count: number;
  lastAlertedAt?: number;
}

const sellFailures = new Map<string, FailureState>();
const buyFailures: number[] = []; // timestamps, global across tokens
let lastBuyAlertAt: number | undefined;

function shouldAlertAgain(lastAlertedAt: number | undefined, now: number): boolean {
  if (lastAlertedAt === undefined) return true;
  return now - lastAlertedAt >= tradingConfig.executionAlertCooldownMinutes * 60_000;
}

/** Clears a token's failure streak — call after any sell that goes through. */
export function recordSellSuccess(tokenAddress: string): void {
  sellFailures.delete(tokenAddress.toLowerCase());
}

/** How long (in minutes) a token's sell has been failing continuously, 0 if
 * it isn't currently in a failure streak. Lets a caller decide when a stuck
 * exit has gone on long enough to give up on rather than retry forever. */
export function getSellFailureMinutes(tokenAddress: string): number {
  const state = sellFailures.get(tokenAddress.toLowerCase());
  return state ? (Date.now() - state.firstFailedAt) / 60_000 : 0;
}

/** Clears the global buy-failure window — call after any buy that goes through. */
export function recordBuySuccess(): void {
  buyFailures.length = 0;
}

export function recordSellFailure(input: {
  tokenAddress: string;
  tokenLabel: string;
  error: string;
  positionValueUsd?: number;
  unrealizedPnlPercent?: number;
}): void {
  if (tradingConfig.sellFailureAlertAfterMinutes <= 0) return;
  const key = input.tokenAddress.toLowerCase();
  const now = Date.now();
  const existing = sellFailures.get(key);
  const state: FailureState = existing
    ? { ...existing, lastFailedAt: now, count: existing.count + 1 }
    : { firstFailedAt: now, lastFailedAt: now, count: 1 };
  sellFailures.set(key, state);

  const failingForMinutes = (now - state.firstFailedAt) / 60_000;
  if (failingForMinutes < tradingConfig.sellFailureAlertAfterMinutes) return;
  if (!shouldAlertAgain(state.lastAlertedAt, now)) return;

  state.lastAlertedAt = now;
  sellFailures.set(key, state);
  logger.error(
    { tokenAddress: input.tokenAddress, failureCount: state.count, failingForMinutes: Math.round(failingForMinutes) },
    "sells have been failing long enough to alert — emailing"
  );
  void sendExecutionFailureEmail({
    direction: "SELL",
    tokenLabel: input.tokenLabel,
    tokenAddress: input.tokenAddress,
    failureCount: state.count,
    failingForMinutes,
    lastError: input.error,
    positionValueUsd: input.positionValueUsd,
    unrealizedPnlPercent: input.unrealizedPnlPercent,
  }).catch((err) => logger.error({ err: String(err) }, "failed to send sell-failure alert email"));
}

export function recordBuyFailure(input: { tokenAddress?: string; tokenLabel: string; error: string }): void {
  if (tradingConfig.buyFailureAlertCount <= 0) return;
  const now = Date.now();
  const windowMs = tradingConfig.buyFailureAlertWindowMinutes * 60_000;
  buyFailures.push(now);
  while (buyFailures.length > 0 && now - buyFailures[0] > windowMs) buyFailures.shift();

  if (buyFailures.length < tradingConfig.buyFailureAlertCount) return;
  if (!shouldAlertAgain(lastBuyAlertAt, now)) return;

  lastBuyAlertAt = now;
  const failingForMinutes = (now - buyFailures[0]) / 60_000;
  logger.error({ failureCount: buyFailures.length, failingForMinutes: Math.round(failingForMinutes) }, "buys have been failing repeatedly — emailing");
  void sendExecutionFailureEmail({
    direction: "BUY",
    tokenLabel: input.tokenLabel,
    tokenAddress: input.tokenAddress,
    failureCount: buyFailures.length,
    failingForMinutes,
    lastError: input.error,
  }).catch((err) => logger.error({ err: String(err) }, "failed to send buy-failure alert email"));
}

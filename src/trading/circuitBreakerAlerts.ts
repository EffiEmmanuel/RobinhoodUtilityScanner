import { logger } from "../logger";
import { sendCircuitBreakerEmail } from "./notifications";
import type { CircuitBreakerResult } from "./portfolio";

/**
 * User directive 2026-09-12: email whenever new entries stop being NORMAL —
 * checked periodically by orchestrator.ts's circuitBreakerAlertLoop, since
 * checkCircuitBreakers() itself stays a plain read with no side effects.
 *
 * A factory (not a bare module-level function) so tests get an isolated
 * tracker each time instead of sharing one mutable "last mode seen" across
 * the whole test file. orchestrator.ts creates exactly one instance at
 * startup and calls it every tick.
 *
 * In-memory only: a restart re-alerts if the process comes back up already
 * tripped, which is the right call — if the mode isn't NORMAL, the user
 * should hear about it regardless of why this process doesn't remember the
 * last one. Fires once per transition INTO a non-NORMAL mode (including
 * CONSERVATIVE -> PAUSED, a real escalation), never while it stays put, and
 * never on the way back to NORMAL — a "trading resumed" email wasn't asked
 * for.
 */
export function createCircuitBreakerAlertTracker() {
  let lastMode: CircuitBreakerResult["mode"] | undefined;

  return function check(result: CircuitBreakerResult): void {
    const mode = result.mode;
    const previousMode = lastMode;
    lastMode = mode;
    if (mode === "NORMAL" || mode === previousMode) return;

    logger.warn({ mode, reasons: result.reasons }, "circuit breaker state changed — emailing");
    void sendCircuitBreakerEmail({ mode, reasons: result.reasons }).catch((err) =>
      logger.error({ err: String(err) }, "failed to send circuit-breaker alert email")
    );
  };
}

export const checkForCircuitBreakerTransition = createCircuitBreakerAlertTracker();

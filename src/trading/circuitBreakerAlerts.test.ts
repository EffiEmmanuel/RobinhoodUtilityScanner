import { describe, it, expect, vi, beforeEach } from "vitest";

const sendCircuitBreakerEmail = vi.fn().mockResolvedValue(undefined);
const sendLanePauseEmail = vi.fn().mockResolvedValue(undefined);
vi.mock("./notifications", () => ({
  sendCircuitBreakerEmail: (...args: unknown[]) => sendCircuitBreakerEmail(...args),
  sendLanePauseEmail: (...args: unknown[]) => sendLanePauseEmail(...args),
}));

import { createCircuitBreakerAlertTracker } from "./circuitBreakerAlerts";
import type { LanePause } from "./kpis";

function result(mode: "NORMAL" | "CONSERVATIVE" | "PAUSED", reasons: string[] = ["some reason"], lanePauses: LanePause[] = []) {
  const chain = { mode, reasons, pausedLanes: [] };
  return { paused: mode === "PAUSED", mode, reasons, chains: { robinhood: chain, solana: chain }, lanePauses };
}

const solanaTacticalPause: LanePause = { chain: "solana", lane: "MOMENTUM_TACTICAL", strategyVersion: "v1.8", reason: "solana MOMENTUM_TACTICAL lost money" };

describe("circuit breaker alert tracker", () => {
  beforeEach(() => sendCircuitBreakerEmail.mockClear());

  it("does not email while everything stays NORMAL", () => {
    const check = createCircuitBreakerAlertTracker();
    check(result("NORMAL", []));
    check(result("NORMAL", []));
    expect(sendCircuitBreakerEmail).not.toHaveBeenCalled();
  });

  it("emails once on a fresh trip", () => {
    const check = createCircuitBreakerAlertTracker();
    check(result("NORMAL", []));
    check(result("PAUSED", ["3 consecutive losses"]));
    expect(sendCircuitBreakerEmail).toHaveBeenCalledTimes(1);
    expect(sendCircuitBreakerEmail.mock.calls[0][0]).toMatchObject({ mode: "PAUSED", reasons: ["3 consecutive losses"] });
  });

  it("does not re-email while it stays tripped, even as the reasons change", () => {
    const check = createCircuitBreakerAlertTracker();
    check(result("NORMAL", []));
    check(result("PAUSED", ["3 consecutive losses"]));
    check(result("PAUSED", ["3 consecutive losses"]));
    check(result("PAUSED", ["daily realized loss 22.2% >= 20% limit", "3 consecutive losses"]));
    expect(sendCircuitBreakerEmail).toHaveBeenCalledTimes(1);
  });

  it("emails again on escalation from CONSERVATIVE to PAUSED", () => {
    const check = createCircuitBreakerAlertTracker();
    check(result("NORMAL", []));
    check(result("CONSERVATIVE", ["3 consecutive losses"]));
    check(result("PAUSED", ["5 consecutive losses >= conservative-mode hard stop"]));
    expect(sendCircuitBreakerEmail).toHaveBeenCalledTimes(2);
    expect(sendCircuitBreakerEmail.mock.calls[1][0]).toMatchObject({ mode: "PAUSED" });
  });

  it("does not email on the way back to NORMAL", () => {
    const check = createCircuitBreakerAlertTracker();
    check(result("NORMAL", []));
    check(result("PAUSED", ["3 consecutive losses"]));
    sendCircuitBreakerEmail.mockClear();
    check(result("NORMAL", []));
    expect(sendCircuitBreakerEmail).not.toHaveBeenCalled();
  });

  it("emails again on a fresh trip after clearing back to NORMAL", () => {
    const check = createCircuitBreakerAlertTracker();
    check(result("NORMAL", []));
    check(result("PAUSED", ["3 consecutive losses"]));
    check(result("NORMAL", []));
    check(result("PAUSED", ["3 consecutive losses"]));
    expect(sendCircuitBreakerEmail).toHaveBeenCalledTimes(2);
  });

  it("emails on the very first check if the process starts up already tripped", () => {
    // A fresh tracker (e.g. right after a restart) has no prior mode to
    // compare against — the user should still hear about it, not have the
    // first read silently treated as a no-op baseline.
    const check = createCircuitBreakerAlertTracker();
    check(result("PAUSED", ["global kill switch is engaged"]));
    expect(sendCircuitBreakerEmail).toHaveBeenCalledTimes(1);
  });
});

describe("expectancy pause alerts", () => {
  beforeEach(() => {
    sendCircuitBreakerEmail.mockClear();
    sendLanePauseEmail.mockClear();
  });

  it("emails once when a lane pauses, and not again while it stays paused", () => {
    const check = createCircuitBreakerAlertTracker();
    check(result("NORMAL", []));
    check(result("NORMAL", [], [solanaTacticalPause]));
    check(result("NORMAL", [], [solanaTacticalPause]));
    expect(sendLanePauseEmail).toHaveBeenCalledTimes(1);
    expect(sendLanePauseEmail.mock.calls[0][0]).toEqual({ reasons: ["solana MOMENTUM_TACTICAL lost money"] });
    // Not a circuit-breaker trip: the mode stayed NORMAL.
    expect(sendCircuitBreakerEmail).not.toHaveBeenCalled();
  });

  it("emails again if the lane pauses again after lifting", () => {
    const check = createCircuitBreakerAlertTracker();
    check(result("NORMAL", [], [solanaTacticalPause]));
    check(result("NORMAL", []));
    check(result("NORMAL", [], [solanaTacticalPause]));
    expect(sendLanePauseEmail).toHaveBeenCalledTimes(2);
  });
});

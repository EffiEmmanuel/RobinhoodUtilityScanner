import { describe, it, expect, vi, beforeEach } from "vitest";

const sendCircuitBreakerEmail = vi.fn().mockResolvedValue(undefined);
vi.mock("./notifications", () => ({ sendCircuitBreakerEmail: (...args: unknown[]) => sendCircuitBreakerEmail(...args) }));

import { createCircuitBreakerAlertTracker } from "./circuitBreakerAlerts";

function result(mode: "NORMAL" | "CONSERVATIVE" | "PAUSED", reasons: string[] = ["some reason"]) {
  return { paused: mode === "PAUSED", mode, reasons };
}

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

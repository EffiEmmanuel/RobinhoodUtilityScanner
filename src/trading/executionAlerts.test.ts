import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendExecutionFailureEmail = vi.fn().mockResolvedValue(undefined);
vi.mock("./notifications", () => ({ sendExecutionFailureEmail: (...args: unknown[]) => sendExecutionFailureEmail(...args) }));

import { recordSellFailure, recordSellSuccess, recordBuyFailure, recordBuySuccess } from "./executionAlerts";
import { tradingConfig } from "./config";

const TOKEN = "0xabc0000000000000000000000000000000000001";

function failSell(error = "TRANSFER_FROM_FAILED") {
  recordSellFailure({ tokenAddress: TOKEN, tokenLabel: "TEST", error });
}

describe("execution failure alerting", () => {
  beforeEach(() => {
    sendExecutionFailureEmail.mockClear();
    recordSellSuccess(TOKEN);
    recordBuySuccess();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    recordSellSuccess(TOKEN);
    recordBuySuccess();
  });

  it("does not email on the first failing sell — a single blip is routine here", () => {
    failSell();
    expect(sendExecutionFailureEmail).not.toHaveBeenCalled();
  });

  it("does not email while the sell has been failing for less than the threshold", () => {
    failSell();
    vi.advanceTimersByTime((tradingConfig.sellFailureAlertAfterMinutes - 1) * 60_000);
    failSell();
    expect(sendExecutionFailureEmail).not.toHaveBeenCalled();
  });

  it("emails once the sell has been failing continuously past the threshold", () => {
    failSell();
    vi.advanceTimersByTime((tradingConfig.sellFailureAlertAfterMinutes + 1) * 60_000);
    failSell();
    expect(sendExecutionFailureEmail).toHaveBeenCalledTimes(1);
    expect(sendExecutionFailureEmail.mock.calls[0][0]).toMatchObject({ direction: "SELL", tokenLabel: "TEST" });
  });

  it("does not send a second email during the cooldown — one problem is one email, not one per retry", () => {
    failSell();
    vi.advanceTimersByTime((tradingConfig.sellFailureAlertAfterMinutes + 1) * 60_000);
    failSell();
    expect(sendExecutionFailureEmail).toHaveBeenCalledTimes(1);
    // the position monitor retries every couple of seconds — none of these
    // should produce another email
    for (let i = 0; i < 200; i++) {
      vi.advanceTimersByTime(2_000);
      failSell();
    }
    expect(sendExecutionFailureEmail).toHaveBeenCalledTimes(1);
  });

  it("a successful sell clears the streak, so the clock restarts rather than alerting immediately", () => {
    failSell();
    vi.advanceTimersByTime((tradingConfig.sellFailureAlertAfterMinutes + 1) * 60_000);
    recordSellSuccess(TOKEN);
    failSell();
    expect(sendExecutionFailureEmail).not.toHaveBeenCalled();
  });

  it("emails on buys only once enough have failed inside the window", () => {
    for (let i = 0; i < tradingConfig.buyFailureAlertCount - 1; i++) {
      recordBuyFailure({ tokenLabel: "TEST", error: "boom" });
    }
    expect(sendExecutionFailureEmail).not.toHaveBeenCalled();
    recordBuyFailure({ tokenLabel: "TEST", error: "boom" });
    expect(sendExecutionFailureEmail).toHaveBeenCalledTimes(1);
    expect(sendExecutionFailureEmail.mock.calls[0][0]).toMatchObject({ direction: "BUY" });
  });

  it("ages buy failures out of the window so old, unrelated ones never accumulate into an alert", () => {
    for (let i = 0; i < tradingConfig.buyFailureAlertCount - 1; i++) {
      recordBuyFailure({ tokenLabel: "TEST", error: "boom" });
    }
    vi.advanceTimersByTime((tradingConfig.buyFailureAlertWindowMinutes + 1) * 60_000);
    recordBuyFailure({ tokenLabel: "TEST", error: "boom" });
    expect(sendExecutionFailureEmail).not.toHaveBeenCalled();
  });
});

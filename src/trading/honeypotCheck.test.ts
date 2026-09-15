import { describe, expect, it } from "vitest";
import { isBenignZeroTransferProbeFailure } from "./honeypotCheck";

describe("isBenignZeroTransferProbeFailure", () => {
  it("treats standard zero-amount transfer reverts as non-blocking", () => {
    expect(isBenignZeroTransferProbeFailure("ERC20: transfer amount must be greater than zero")).toBe(true);
    expect(isBenignZeroTransferProbeFailure("reverted: amount must be greater than 0")).toBe(true);
  });

  it("does not forgive suspicious transfer failures", () => {
    expect(isBenignZeroTransferProbeFailure("blacklisted wallet cannot transfer")).toBe(false);
    expect(isBenignZeroTransferProbeFailure("trading is disabled")).toBe(false);
  });
});

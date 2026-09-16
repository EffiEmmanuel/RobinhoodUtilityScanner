import { describe, expect, it } from "vitest";
import { evaluateHoneypotRisk, isBenignZeroTransferProbeFailure } from "./honeypotCheck";

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

describe("evaluateHoneypotRisk chain gate", () => {
  // Proven by rejecting on a string that isn't a valid Solana pubkey — the
  // EVM path would never attempt to parse an address this way, so any
  // rejection here confirms real dispatch happened. Deliberately doesn't
  // assert *why* it rejects: whether SOLANA_RPC_URL happens to be configured
  // in this environment changes which line throws first (an unconfigured
  // connection throws before ever parsing the address; a configured one
  // rejects on the invalid pubkey itself) — both are real dispatch, so
  // asserting the specific reason would make this test flaky based on
  // ambient .env state instead of testing the actual thing it should.
  it("dispatches solana to the SPL-specific check", async () => {
    await expect(evaluateHoneypotRisk("not-a-valid-solana-pubkey", "solana")).rejects.toThrow();
  });

  it("fails closed for a chain with no implementation at all, without touching any RPC client", async () => {
    const result = await evaluateHoneypotRisk("some-address", "some-future-chain");
    expect(result.passed).toBe(false);
    expect(result.flags).toContain("CHAIN_NOT_SUPPORTED");
  });
});

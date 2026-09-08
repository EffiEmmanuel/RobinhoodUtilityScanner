import { describe, it, expect } from "vitest";
import { cheapFilter } from "./cheapFilter";
import type { DiscoveredTokenProfile } from "../dex/types";

function profile(overrides: Partial<DiscoveredTokenProfile> = {}): DiscoveredTokenProfile {
  return {
    chainId: "robinhood",
    tokenAddress: "0x1234567890123456789012345678901234567890",
    icon: "https://example.com/icon.png",
    links: [],
    ...overrides,
  };
}

describe("cheapFilter", () => {
  it("passes a token with a real name and icon", () => {
    expect(cheapFilter(profile(), "Navier Protocol").passed).toBe(true);
  });

  it("rejects a missing name", () => {
    const result = cheapFilter(profile(), undefined);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain("missing or placeholder token name");
  });

  it("rejects a placeholder name", () => {
    expect(cheapFilter(profile(), "Test Token").passed).toBe(false);
  });

  it("rejects a missing icon", () => {
    const result = cheapFilter(profile({ icon: undefined }), "Navier Protocol");
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain("missing icon");
  });

  it("rejects a malformed contract address", () => {
    const result = cheapFilter(profile({ tokenAddress: "not-an-address" }), "Navier Protocol");
    expect(result.passed).toBe(false);
  });
});

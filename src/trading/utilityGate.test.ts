import { describe, expect, it } from "vitest";
import { evaluateUtilityOnlyGate } from "./utilityGate";

// User directive 2026-09-18: utility tokens only, no memecoins, no
// exceptions — canBypassUtilityGateForMomentum (previously tested here) was
// removed along with the momentum/narrative bypass mechanism it served.
// evaluateUtilityOnlyGate is now the ONLY gate, with no bypass of any kind.
describe("evaluateUtilityOnlyGate", () => {
  const passing = {
    utilityClass: "UTILITY",
    productExists: true,
    productPredatesToken: "YES" as const,
    utilityScore: 80,
    credibilityScore: 70,
    websiteScore: 70,
  };

  it("passes a genuine, well-evidenced utility project", () => {
    const result = evaluateUtilityOnlyGate(passing);
    expect(result.passed).toBe(true);
  });

  it("rejects a MEME utility class regardless of every other score", () => {
    const result = evaluateUtilityOnlyGate({ ...passing, utilityClass: "MEME" });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("meme/unknown"))).toBe(true);
  });

  it("rejects an UNKNOWN utility class", () => {
    const result = evaluateUtilityOnlyGate({ ...passing, utilityClass: "UNKNOWN" });
    expect(result.passed).toBe(false);
  });

  it("rejects when research did not verify a real product exists", () => {
    const result = evaluateUtilityOnlyGate({ ...passing, productExists: false });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("did not verify a real product"))).toBe(true);
  });

  it("rejects a token-first project (product created after the token)", () => {
    const result = evaluateUtilityOnlyGate({ ...passing, productPredatesToken: "NO" });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("token-first"))).toBe(true);
  });

  it("rejects below-threshold utility/credibility/website scores", () => {
    const result = evaluateUtilityOnlyGate({ ...passing, utilityScore: 10, credibilityScore: 5, websiteScore: 5 });
    expect(result.passed).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

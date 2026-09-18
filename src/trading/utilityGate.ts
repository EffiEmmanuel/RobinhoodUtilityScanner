import { tradingConfig } from "./config";

const NON_UTILITY_CLASSES = new Set(["MEME", "UNKNOWN"]);

export interface UtilityGateInput {
  utilityClass?: string | null;
  productExists?: boolean | null;
  productPredatesToken?: "YES" | "NO" | "UNKNOWN" | string | null;
  utilityScore?: number | null;
  credibilityScore?: number | null;
  websiteScore?: number | null;
}

export interface UtilityGateResult {
  passed: boolean;
  reasons: string[];
}

function score(value: number | null | undefined): number {
  return value ?? 0;
}

export function evaluateUtilityOnlyGate(input: UtilityGateInput): UtilityGateResult {
  if (!tradingConfig.utilityOnlyTradingEnabled) return { passed: true, reasons: ["utility-only trading gate disabled"] };

  const reasons: string[] = [];
  if (!input.utilityClass || NON_UTILITY_CLASSES.has(input.utilityClass)) {
    reasons.push(`utility class is ${input.utilityClass ?? "missing"} — not risking capital on meme/unknown tokens`);
  }
  if (tradingConfig.requireProductForTrade && input.productExists !== true) {
    reasons.push("research did not verify a real product/app exists");
  }
  if (!tradingConfig.allowUnknownProductPredatesToken && input.productPredatesToken !== "YES") {
    reasons.push(`productPredatesToken is ${input.productPredatesToken ?? "missing"}`);
  } else if (input.productPredatesToken === "NO") {
    reasons.push("product appears token-first/newly-created, not an established utility project");
  }
  if (score(input.utilityScore) < tradingConfig.minTradeUtilityScore) {
    reasons.push(`utilityScore ${score(input.utilityScore)} < ${tradingConfig.minTradeUtilityScore}`);
  }
  if (score(input.credibilityScore) < tradingConfig.minTradeCredibilityScore) {
    reasons.push(`credibilityScore ${score(input.credibilityScore)} < ${tradingConfig.minTradeCredibilityScore}`);
  }
  if (score(input.websiteScore) < tradingConfig.minTradeWebsiteScore) {
    reasons.push(`websiteScore ${score(input.websiteScore)} < ${tradingConfig.minTradeWebsiteScore}`);
  }

  return { passed: reasons.length === 0, reasons: reasons.length ? reasons : ["cleared utility-only trading gate"] };
}

export function utilityGateInputFromRawResearch(rawResearch: unknown, scores: {
  utilityScore?: number | null;
  credibilityScore?: number | null;
  websiteScore?: number | null;
}): UtilityGateInput {
  const synthesis = (rawResearch as { synthesis?: UtilityGateInput } | null | undefined)?.synthesis;
  return {
    utilityClass: synthesis?.utilityClass,
    productExists: synthesis?.productExists,
    productPredatesToken: synthesis?.productPredatesToken,
    utilityScore: scores.utilityScore,
    credibilityScore: scores.credibilityScore,
    websiteScore: scores.websiteScore,
  };
}

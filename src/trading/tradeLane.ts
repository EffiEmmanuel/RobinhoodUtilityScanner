import { tradingConfig } from "./config";
import type { CandidateRiskResult } from "./riskEngine";

export const TRADE_LANES = ["VERIFIED_PROJECT", "MOMENTUM_TACTICAL", "NARRATIVE_TACTICAL", "REJECT"] as const;
export type TradeLane = (typeof TRADE_LANES)[number];

export interface TradeLaneInput {
  evaluation: CandidateRiskResult;
  qualificationPath?: string | null;
  qualityScore?: number | null;
  researchConfidence?: number | null;
  contractScore?: number | null;
  utilityScore?: number | null;
  credibilityScore?: number | null;
  websiteScore?: number | null;
  liquidityUsd?: number | null;
}

export interface TradeLaneResult {
  tradeLane: TradeLane;
  reasons: string[];
}

function score(value: number | null | undefined): number {
  return value ?? 0;
}

export function classifyTradeLane(input: TradeLaneInput): TradeLaneResult {
  if (!input.evaluation.eligible) {
    return { tradeLane: "REJECT", reasons: ["candidate is not trade-eligible"] };
  }

  if (input.qualificationPath === "NARRATIVE_META") {
    return { tradeLane: "NARRATIVE_TACTICAL", reasons: ["qualified through trending narrative/meta evidence"] };
  }
  if (input.qualificationPath === "MOMENTUM_OVERRIDE" || input.evaluation.reasons[0]?.startsWith("momentum override:")) {
    return { tradeLane: "MOMENTUM_TACTICAL", reasons: ["qualified through momentum override, not verified-project evidence"] };
  }

  const checks = [
    {
      ok: score(input.qualityScore) >= tradingConfig.verifiedProjectMinQualityScore,
      reason: `qualityScore ${score(input.qualityScore)} < ${tradingConfig.verifiedProjectMinQualityScore}`,
    },
    {
      ok: score(input.researchConfidence) >= tradingConfig.verifiedProjectMinResearchConfidence,
      reason: `researchConfidence ${score(input.researchConfidence)} < ${tradingConfig.verifiedProjectMinResearchConfidence}`,
    },
    {
      ok: score(input.contractScore) >= tradingConfig.verifiedProjectMinContractScore,
      reason: `contractScore ${score(input.contractScore)} < ${tradingConfig.verifiedProjectMinContractScore}`,
    },
    {
      ok: score(input.utilityScore) >= tradingConfig.verifiedProjectMinUtilityScore,
      reason: `utilityScore ${score(input.utilityScore)} < ${tradingConfig.verifiedProjectMinUtilityScore}`,
    },
    {
      ok: score(input.credibilityScore) >= tradingConfig.verifiedProjectMinCredibilityScore,
      reason: `credibilityScore ${score(input.credibilityScore)} < ${tradingConfig.verifiedProjectMinCredibilityScore}`,
    },
    {
      ok: score(input.websiteScore) >= tradingConfig.verifiedProjectMinWebsiteScore,
      reason: `websiteScore ${score(input.websiteScore)} < ${tradingConfig.verifiedProjectMinWebsiteScore}`,
    },
    {
      ok: score(input.liquidityUsd) >= tradingConfig.minTradeLiquidityUsd * tradingConfig.verifiedProjectMinLiquidityMultiple,
      reason: `liquidityUsd ${Math.round(score(input.liquidityUsd))} < ${Math.round(tradingConfig.minTradeLiquidityUsd * tradingConfig.verifiedProjectMinLiquidityMultiple)}`,
    },
  ];

  const failed = checks.filter((check) => !check.ok).map((check) => check.reason);
  if (failed.length === 0) {
    return { tradeLane: "VERIFIED_PROJECT", reasons: ["cleared verified-project evidence bundle"] };
  }

  return { tradeLane: "MOMENTUM_TACTICAL", reasons: [`not verified-project grade: ${failed.join("; ")}`] };
}

export function normalizeTradeLane(value: string | null | undefined): TradeLane {
  return value === "VERIFIED_PROJECT" || value === "MOMENTUM_TACTICAL" || value === "NARRATIVE_TACTICAL" || value === "REJECT" ? value : "MOMENTUM_TACTICAL";
}

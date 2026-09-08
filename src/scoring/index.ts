import { config } from "../config";
import type { ResearchSynthesis, FactorScore } from "../ai/schemas";
import type { OnchainResearchResult } from "../research/onchain";
import type { MarketSummary, MarketPair } from "../dex/types";

// Only the fields the scoring engine actually reads from a classification —
// deliberately narrower than the full AI output contract so callers can pass
// either the live AI result or the persisted DB row without adapting shape.
export interface BrandingInput {
  brandingQuality: number;
  reasoningSummary: string[];
}

export type Confidence = "LOW" | "MEDIUM" | "HIGH";

export interface FactorResult {
  score: number; // 0-100
  confidence: Confidence;
  reasoning?: string;
}

export interface ScoringInputs {
  classification: BrandingInput;
  synthesis: ResearchSynthesis;
  onchain: OnchainResearchResult;
  market: MarketSummary;
}

export interface ScoringResult {
  factors: {
    utility: FactorResult;
    contract: FactorResult;
    credibility: FactorResult;
    website: FactorResult;
    social: FactorResult;
    liquidity: FactorResult;
    market: FactorResult;
    holders: FactorResult;
    team: FactorResult;
    branding: FactorResult;
  };
  finalScore: number;
  confidence: number; // 0-100
  hardReject: boolean;
  rejectionReasons: string[];
  band: ScoreBand;
}

// Weights from PRD §20 — must sum to 1.
export const WEIGHTS = {
  utility: 0.2,
  contract: 0.15,
  credibility: 0.1,
  website: 0.1,
  social: 0.1,
  liquidity: 0.1,
  market: 0.08,
  holders: 0.07,
  team: 0.05,
  branding: 0.05,
} as const;

export type ScoreBand = "REJECT" | "LOW_QUALITY" | "WATCH" | "STRONG_WATCH" | "HIGH_CONVICTION_CANDIDATE";

export function scoreBandFor(score: number): ScoreBand {
  if (score >= 85) return "HIGH_CONVICTION_CANDIDATE";
  if (score >= 75) return "STRONG_WATCH";
  if (score >= 65) return "WATCH";
  if (score >= 50) return "LOW_QUALITY";
  return "REJECT";
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

const CONFIDENCE_NUMERIC: Record<Confidence, number> = { LOW: 30, MEDIUM: 65, HIGH: 92 };

function fromFactorScore(f: FactorScore): FactorResult {
  return { score: clamp(f.score), confidence: f.confidence, reasoning: f.reasoning };
}

function contractSafetyScore(onchain: OnchainResearchResult): FactorResult {
  if (onchain.status === "UNAVAILABLE") {
    return { score: 50, confidence: "LOW", reasoning: "on-chain RPC unreachable" };
  }
  if (onchain.isContract === "FAIL") {
    return { score: 0, confidence: "HIGH", reasoning: "no contract bytecode found at address" };
  }

  let penalty = 0;
  let unknowns = 0;
  const notes: string[] = [];

  if (onchain.ownerRenounced === "FAIL") {
    penalty += 10;
    notes.push("owner not renounced");
  } else if (onchain.ownerRenounced === "UNKNOWN") unknowns++;

  if (onchain.mintCapability === "FAIL") {
    penalty += 30;
    notes.push("mint capability present");
  } else if (onchain.mintCapability === "UNKNOWN") unknowns++;

  if (onchain.pauseCapability === "FAIL") {
    penalty += 15;
    notes.push("pause capability present");
  } else if (onchain.pauseCapability === "UNKNOWN") unknowns++;

  if (onchain.blacklistCapability === "FAIL") {
    penalty += 20;
    notes.push("blacklist capability present");
  } else if (onchain.blacklistCapability === "UNKNOWN") unknowns++;

  if (onchain.feeControlCapability === "FAIL") {
    penalty += 10;
    notes.push("fee/tax control present");
  } else if (onchain.feeControlCapability === "UNKNOWN") unknowns++;

  if (onchain.verifiedSource === "FAIL") {
    penalty += 10;
    notes.push("source not verified on explorer");
  } else if (onchain.verifiedSource === "UNKNOWN") unknowns++;

  const confidence: Confidence = unknowns >= 3 ? "LOW" : unknowns >= 1 ? "MEDIUM" : "HIGH";
  return { score: clamp(100 - penalty), confidence, reasoning: notes.join("; ") || "no contract risk indicators found" };
}

function liquidityScore(pair?: MarketPair): FactorResult {
  if (!pair || pair.liquidityUsd === undefined) {
    return { score: 40, confidence: "LOW", reasoning: "no liquidity data available" };
  }
  const liq = pair.liquidityUsd;
  let score = Math.min(60, (liq / config.minLiquidityUsd) * 30);
  if (pair.marketCapUsd && pair.marketCapUsd > 0) {
    const ratio = liq / pair.marketCapUsd;
    score += Math.min(40, (ratio / config.minLiquidityToMcapRatio) * 20);
  } else {
    score += 15;
  }
  return { score: clamp(score), confidence: "HIGH" };
}

function marketActivityScore(pair?: MarketPair): FactorResult {
  if (!pair) return { score: 40, confidence: "LOW", reasoning: "no market data available" };
  const buys = pair.buys1h ?? 0;
  const sells = pair.sells1h ?? 0;
  const total = buys + sells;
  if (total === 0) return { score: 35, confidence: "MEDIUM", reasoning: "no trading activity in the last hour" };
  const buyRatio = buys / total;
  const volume1h = pair.volume1h ?? 0;
  const liq = pair.liquidityUsd || 1;
  const volToLiq = volume1h / liq;
  const score = 40 + buyRatio * 30 + Math.min(30, volToLiq * 30);
  return { score: clamp(score), confidence: "HIGH" };
}

function brandingScore(classification: BrandingInput): FactorResult {
  return {
    score: clamp(classification.brandingQuality * 100),
    confidence: "MEDIUM",
    reasoning: classification.reasoningSummary.join("; "),
  };
}

// No holder-distribution data source in v1 (would require an indexer) —
// explicitly neutral + LOW confidence rather than silently scoring 0. See PRD §25.
function holderScoreStub(): FactorResult {
  return { score: 50, confidence: "LOW", reasoning: "holder distribution data not available in v1" };
}

export function computeHardRejections(onchain: OnchainResearchResult, synthesis: ResearchSynthesis, pair?: MarketPair): string[] {
  const reasons: string[] = [];

  if (onchain.status !== "UNAVAILABLE" && onchain.isContract === "FAIL") {
    reasons.push("No contract bytecode found at the token address.");
  }
  const activeOwner = onchain.ownerRenounced === "FAIL";
  if (activeOwner && onchain.mintCapability === "FAIL") {
    reasons.push("Active (non-renounced) owner retains mint capability — rug risk.");
  }
  if (activeOwner && onchain.blacklistCapability === "FAIL") {
    reasons.push("Active (non-renounced) owner can blacklist wallets — may prevent normal selling.");
  }
  if (pair?.liquidityUsd !== undefined && pair.liquidityUsd < config.minLiquidityUsd * 0.2) {
    reasons.push(`Liquidity ($${Math.round(pair.liquidityUsd)}) is far below the emergency safety floor.`);
  }
  if (synthesis.impersonationSuspected) {
    reasons.push("Website/branding is suspected to impersonate another real project.");
  }

  return reasons;
}

export function computeScore(inputs: ScoringInputs): ScoringResult {
  const primaryPair = inputs.market.primaryPair;

  const factors: ScoringResult["factors"] = {
    utility: fromFactorScore(inputs.synthesis.utility),
    contract: contractSafetyScore(inputs.onchain),
    credibility: fromFactorScore(inputs.synthesis.credibility),
    website: fromFactorScore(inputs.synthesis.website),
    social: fromFactorScore(inputs.synthesis.social),
    liquidity: liquidityScore(primaryPair),
    market: marketActivityScore(primaryPair),
    holders: holderScoreStub(),
    team: fromFactorScore(inputs.synthesis.team),
    branding: brandingScore(inputs.classification),
  };

  const finalScore =
    factors.utility.score * WEIGHTS.utility +
    factors.contract.score * WEIGHTS.contract +
    factors.credibility.score * WEIGHTS.credibility +
    factors.website.score * WEIGHTS.website +
    factors.social.score * WEIGHTS.social +
    factors.liquidity.score * WEIGHTS.liquidity +
    factors.market.score * WEIGHTS.market +
    factors.holders.score * WEIGHTS.holders +
    factors.team.score * WEIGHTS.team +
    factors.branding.score * WEIGHTS.branding;

  const confidence =
    CONFIDENCE_NUMERIC[factors.utility.confidence] * WEIGHTS.utility +
    CONFIDENCE_NUMERIC[factors.contract.confidence] * WEIGHTS.contract +
    CONFIDENCE_NUMERIC[factors.credibility.confidence] * WEIGHTS.credibility +
    CONFIDENCE_NUMERIC[factors.website.confidence] * WEIGHTS.website +
    CONFIDENCE_NUMERIC[factors.social.confidence] * WEIGHTS.social +
    CONFIDENCE_NUMERIC[factors.liquidity.confidence] * WEIGHTS.liquidity +
    CONFIDENCE_NUMERIC[factors.market.confidence] * WEIGHTS.market +
    CONFIDENCE_NUMERIC[factors.holders.confidence] * WEIGHTS.holders +
    CONFIDENCE_NUMERIC[factors.team.confidence] * WEIGHTS.team +
    CONFIDENCE_NUMERIC[factors.branding.confidence] * WEIGHTS.branding;

  const rejectionReasons = computeHardRejections(inputs.onchain, inputs.synthesis, primaryPair);

  return {
    factors,
    finalScore: Math.round(finalScore * 10) / 10,
    confidence: Math.round(confidence),
    hardReject: rejectionReasons.length > 0,
    rejectionReasons,
    band: scoreBandFor(finalScore),
  };
}

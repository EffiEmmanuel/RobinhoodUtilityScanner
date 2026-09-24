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
  // True when the input behind this factor was never collected at all (not
  // "collected and looked bad"). Excluded from finalScore/confidence rather
  // than averaged in as a fake middling number — see computeScore.
  unmeasured?: boolean;
}

export interface ScoringInputs {
  classification: BrandingInput;
  synthesis: ResearchSynthesis;
  onchain: OnchainResearchResult;
  // False for chains with no on-chain contract research (Solana today — its
  // mint/freeze-authority safety is enforced by the honeypot gate right
  // before any trade instead). Defaults to true.
  onchainApplicable?: boolean;
  market: MarketSummary;
  holders?: {
    top1Percent: number;
    top10Percent: number;
    holderCount: number;
    logScanComplete: boolean;
  };
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

function contractSafetyScore(onchain: OnchainResearchResult, applicable: boolean): FactorResult {
  if (!applicable) {
    return { score: 50, confidence: "LOW", reasoning: "not applicable on this chain (checked by the entry-time honeypot gate)", unmeasured: true };
  }
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
    // e.g. every pre-bond pump.fun pair — DexScreener reports no liquidity
    // for a bonding curve at all.
    return { score: 40, confidence: "LOW", reasoning: "no liquidity data available", unmeasured: true };
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

function holderDistributionScore(snapshot: ScoringInputs["holders"]): FactorResult {
  if (!snapshot) {
    return { score: 50, confidence: "LOW", reasoning: "holder distribution data not available", unmeasured: true };
  }
  let score = 100;
  const notes: string[] = [];
  if (snapshot.holderCount < 10) {
    score -= 35;
    notes.push(`only ${snapshot.holderCount} non-excluded holders`);
  } else if (snapshot.holderCount < 25) {
    score -= 15;
    notes.push(`${snapshot.holderCount} non-excluded holders`);
  }
  if (snapshot.top1Percent > 20) {
    score -= 35;
    notes.push(`top holder owns ${snapshot.top1Percent.toFixed(1)}%`);
  } else if (snapshot.top1Percent > 10) {
    score -= 15;
    notes.push(`top holder owns ${snapshot.top1Percent.toFixed(1)}%`);
  }
  if (snapshot.top10Percent > 65) {
    score -= 30;
    notes.push(`top 10 holders own ${snapshot.top10Percent.toFixed(1)}%`);
  } else if (snapshot.top10Percent > 45) {
    score -= 12;
    notes.push(`top 10 holders own ${snapshot.top10Percent.toFixed(1)}%`);
  }
  return {
    score: clamp(score),
    confidence: snapshot.logScanComplete ? "HIGH" : "MEDIUM",
    reasoning: notes.join("; ") || "holder distribution looks reasonably dispersed",
  };
}

// Liquidity is deliberately NOT a hard rejection here: research often runs
// seconds after a pool opens, before liquidity is added (MUSETOWN,
// 2026-09-23: $0.69 at research, permanently rejected, then ran 63x). Pool
// depth is a moment-in-time market condition, not a property of the
// project — it's enforced with fresh data at planning/entry instead, where a
// thin pool waits for liquidity rather than killing the token.
export function computeHardRejections(onchain: OnchainResearchResult, synthesis: ResearchSynthesis): string[] {
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
  if (synthesis.impersonationSuspected) {
    reasons.push("Website/branding is suspected to impersonate another real project.");
  }

  return reasons;
}

export function computeScore(inputs: ScoringInputs): ScoringResult {
  const primaryPair = inputs.market.primaryPair;

  const factors: ScoringResult["factors"] = {
    utility: fromFactorScore(inputs.synthesis.utility),
    contract: contractSafetyScore(inputs.onchain, inputs.onchainApplicable ?? true),
    credibility: fromFactorScore(inputs.synthesis.credibility),
    website: fromFactorScore(inputs.synthesis.website),
    social: fromFactorScore(inputs.synthesis.social),
    liquidity: liquidityScore(primaryPair),
    market: marketActivityScore(primaryPair),
    holders: holderDistributionScore(inputs.holders),
    team: fromFactorScore(inputs.synthesis.team),
    branding: brandingScore(inputs.classification),
  };

  // User directive 2026-09-24 (DESKS): a pre-bond Solana token had 35% of its
  // weight scored as fake-middling numbers for data we never collect —
  // contract (no Solana on-chain research), liquidity (bonding curves report
  // none) — which alone capped every such token below the watchlist bar no
  // matter how good it was. Weights are re-normalized over what was actually
  // measured instead.
  let weightedScore = 0;
  let weightedConfidence = 0;
  let measuredWeight = 0;
  for (const key of Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]) {
    const factor = factors[key];
    if (factor.unmeasured) continue;
    weightedScore += factor.score * WEIGHTS[key];
    weightedConfidence += CONFIDENCE_NUMERIC[factor.confidence] * WEIGHTS[key];
    measuredWeight += WEIGHTS[key];
  }
  const finalScore = measuredWeight > 0 ? weightedScore / measuredWeight : 0;
  const confidence = measuredWeight > 0 ? weightedConfidence / measuredWeight : 0;

  const rejectionReasons = computeHardRejections(inputs.onchain, inputs.synthesis);

  return {
    factors,
    finalScore: Math.round(finalScore * 10) / 10,
    confidence: Math.round(confidence),
    hardReject: rejectionReasons.length > 0,
    rejectionReasons,
    band: scoreBandFor(finalScore),
  };
}

import { tradingConfig } from "./config";
import type { SizingRules } from "./strategy";
import type { PortfolioState } from "./portfolio";

export type RiskBucket = "LOW" | "MEDIUM" | "HIGH" | "REJECT";

// ---------------------------------------------------------------------------
// evaluateCandidate — §9/§24: does this candidate clear the trade-eligibility
// gates at all, and what risk bucket does it fall into?
// ---------------------------------------------------------------------------
export interface CandidateRiskInput {
  qualityScore: number;
  researchConfidence: number;
  contractScore: number;
  liquidityUsd: number;
  hardReject: boolean;
}

export interface CandidateRiskResult {
  eligible: boolean;
  riskBucket: RiskBucket;
  reasons: string[];
}

export function evaluateCandidate(input: CandidateRiskInput): CandidateRiskResult {
  const reasons: string[] = [];

  if (input.hardReject) {
    return { eligible: false, riskBucket: "REJECT", reasons: ["hardReject == true (never trade — §9)"] };
  }
  if (input.qualityScore < tradingConfig.minTradeQualityScore) {
    reasons.push(`qualityScore ${input.qualityScore} < ${tradingConfig.minTradeQualityScore}`);
  }
  if (input.researchConfidence < tradingConfig.minTradeResearchConfidence) {
    reasons.push(`researchConfidence ${input.researchConfidence} < ${tradingConfig.minTradeResearchConfidence}`);
  }
  if (input.contractScore < tradingConfig.minTradeContractScore) {
    reasons.push(`contractScore ${input.contractScore} < ${tradingConfig.minTradeContractScore}`);
  }
  if (input.liquidityUsd < tradingConfig.minTradeLiquidityUsd) {
    reasons.push(`liquidityUsd ${Math.round(input.liquidityUsd)} < ${tradingConfig.minTradeLiquidityUsd}`);
  }

  if (reasons.length > 0) {
    return { eligible: false, riskBucket: "REJECT", reasons };
  }

  // Risk bucket from how comfortably it cleared the bars, not just pass/fail.
  const qualityMargin = input.qualityScore - tradingConfig.minTradeQualityScore;
  const confidenceMargin = input.researchConfidence - tradingConfig.minTradeResearchConfidence;
  let riskBucket: RiskBucket = "MEDIUM";
  if (qualityMargin >= 10 && confidenceMargin >= 10 && input.liquidityUsd >= tradingConfig.minTradeLiquidityUsd * 2) {
    riskBucket = "LOW";
  } else if (qualityMargin < 3 || confidenceMargin < 3) {
    riskBucket = "HIGH";
  }

  return { eligible: true, riskBucket, reasons: ["cleared all trade-eligibility gates"] };
}

// ---------------------------------------------------------------------------
// calculatePositionSize — §21/§22/§23
// ---------------------------------------------------------------------------
export interface PositionSizingInput {
  portfolio: PortfolioState;
  sizingRules: SizingRules;
  qualityScore: number; // 0-100
  confidence: number; // 0-100
  riskBucket: RiskBucket;
  liquidityUsd: number;
}

export interface PositionSizingResult {
  approved: boolean;
  positionSizeUsd: number;
  reasons: string[];
}

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * Math.max(0, Math.min(1, t));
}

export function calculatePositionSize(input: PositionSizingInput): PositionSizingResult {
  const { portfolio, sizingRules } = input;
  const reasons: string[] = [];

  if (input.riskBucket === "REJECT") {
    return { approved: false, positionSizeUsd: 0, reasons: ["risk bucket is REJECT"] };
  }

  const base = portfolio.totalEquityUsd * (sizingRules.baseAllocationPercent / 100);
  const qualityMult = lerp(sizingRules.qualityMultiplierMin, sizingRules.qualityMultiplierMax, input.qualityScore / 100);
  const confidenceMult = lerp(sizingRules.confidenceMultiplierMin, sizingRules.confidenceMultiplierMax, input.confidence / 100);
  const riskMult =
    input.riskBucket === "LOW"
      ? sizingRules.riskMultiplierLow
      : input.riskBucket === "MEDIUM"
        ? sizingRules.riskMultiplierMedium
        : sizingRules.riskMultiplierHigh;
  // Liquidity multiplier: scales up to max once liquidity is well above the
  // minimum trade-eligibility floor, scales down toward min near it.
  const liquidityRatio = input.liquidityUsd / tradingConfig.minTradeLiquidityUsd;
  const liquidityMult = lerp(sizingRules.liquidityMultiplierMin, sizingRules.liquidityMultiplierMax, (liquidityRatio - 1) / 2);

  let positionSizeUsd = base * qualityMult * confidenceMult * riskMult * liquidityMult;

  // Hard caps (§22) — these override the formula, never the other way around.
  const maxBySinglePositionCap = portfolio.totalEquityUsd * (tradingConfig.maxSinglePositionPercent / 100);
  if (positionSizeUsd > maxBySinglePositionCap) {
    positionSizeUsd = maxBySinglePositionCap;
    reasons.push(`capped at maxSinglePositionPercent (${tradingConfig.maxSinglePositionPercent}% of equity)`);
  }
  if (positionSizeUsd > portfolio.availableToDeployUsd) {
    positionSizeUsd = portfolio.availableToDeployUsd;
    reasons.push("capped at remaining deployable capital");
  }

  // Small-account gas check (§23).
  const gasCost = tradingConfig.paperAssumedGasCostUsd;
  if (positionSizeUsd > 0 && (gasCost / positionSizeUsd) * 100 > tradingConfig.maxGasCostPercentOfPosition) {
    return {
      approved: false,
      positionSizeUsd: 0,
      reasons: [
        `estimated gas cost is ${((gasCost / positionSizeUsd) * 100).toFixed(1)}% of position, exceeds ${tradingConfig.maxGasCostPercentOfPosition}% limit — skip`,
      ],
    };
  }

  if (positionSizeUsd <= 0) {
    return { approved: false, positionSizeUsd: 0, reasons: [...reasons, "no deployable capital remaining"] };
  }

  reasons.push(
    `base=$${base.toFixed(2)} x quality=${qualityMult.toFixed(2)} x confidence=${confidenceMult.toFixed(2)} x risk=${riskMult.toFixed(2)} x liquidity=${liquidityMult.toFixed(2)}`
  );
  return { approved: true, positionSizeUsd: Math.round(positionSizeUsd * 100) / 100, reasons };
}

// ---------------------------------------------------------------------------
// validateEntry — §17/§18: final revalidation right before a simulated buy.
// ---------------------------------------------------------------------------
export interface EntryRiskInput {
  circuitBreakersPaused: boolean;
  circuitBreakerReasons: string[];
  currentLiquidityUsd: number;
  liquidityAtPlanUsd: number;
  sellQuoteAvailable: boolean;
  buySellRatio1h: number | undefined; // buys / (buys+sells), undefined if no activity
  priceChange5mPercent: number | undefined;
  estimatedSlippageBps: number;
  estimatedPriceImpactPercent: number;
  positionSizeUsd: number;
  availableToDeployUsd: number;
}

export type EntryDecision = "APPROVED" | "DEFER" | "REJECTED";

export interface EntryRiskResult {
  decision: EntryDecision;
  reasons: string[];
}

export function validateEntry(input: EntryRiskInput): EntryRiskResult {
  const reasons: string[] = [];

  if (input.circuitBreakersPaused) {
    return { decision: "DEFER", reasons: input.circuitBreakerReasons };
  }
  if (!input.sellQuoteAvailable) {
    return { decision: "REJECTED", reasons: ["no sell path available — possible honeypot/delisted pool"] };
  }

  // §18 catastrophic drop detection: a price that reached the target zone
  // because the project is collapsing must not trigger a buy.
  const liquidityCollapsed = input.currentLiquidityUsd < input.liquidityAtPlanUsd * 0.5;
  const sharpDrop = (input.priceChange5mPercent ?? 0) < -20;
  if (liquidityCollapsed && sharpDrop) {
    return { decision: "REJECTED", reasons: ["catastrophic pattern: liquidity collapsed + sharp price drop together"] };
  }
  if (liquidityCollapsed) {
    return { decision: "REJECTED", reasons: [`liquidity collapsed from plan-time (${Math.round(input.liquidityAtPlanUsd)} -> ${Math.round(input.currentLiquidityUsd)})`] };
  }
  if (input.buySellRatio1h !== undefined && input.buySellRatio1h < 0.25) {
    return { decision: "REJECTED", reasons: [`sell volume massively exceeds buy volume (buy ratio ${(input.buySellRatio1h * 100).toFixed(0)}%)`] };
  }

  if (input.estimatedSlippageBps > tradingConfig.defaultMaxBuySlippageBps) {
    reasons.push(`estimated slippage ${input.estimatedSlippageBps}bps exceeds ${tradingConfig.defaultMaxBuySlippageBps}bps limit`);
  }
  if (input.estimatedPriceImpactPercent > tradingConfig.maxBuyPriceImpactPercent) {
    reasons.push(`estimated price impact ${input.estimatedPriceImpactPercent.toFixed(2)}% exceeds ${tradingConfig.maxBuyPriceImpactPercent}% limit`);
  }
  if (input.positionSizeUsd > input.availableToDeployUsd) {
    reasons.push("position size no longer fits within available deployable capital");
  }

  if (reasons.length > 0) {
    return { decision: "REJECTED", reasons };
  }
  return { decision: "APPROVED", reasons: ["all entry checks passed"] };
}

// ---------------------------------------------------------------------------
// validatePosition — §37: ongoing risk flags during position monitoring.
// ---------------------------------------------------------------------------
export interface PositionRiskInput {
  liquidityUsd: number;
  liquidityAtEntryUsd: number;
  unrealizedPnlPercent: number;
  maxLossPercent: number;
  catastrophicLossPercent: number;
  buySellRatio5m: number | undefined;
  sellQuoteAvailable: boolean;
}

export interface PositionRiskResult {
  riskExitTriggered: boolean;
  severity: "INFO" | "WARNING" | "CRITICAL";
  reasons: string[];
}

export function validatePosition(input: PositionRiskInput): PositionRiskResult {
  const reasons: string[] = [];

  if (!input.sellQuoteAvailable) {
    return { riskExitTriggered: true, severity: "CRITICAL", reasons: ["sell quote unavailable — attempt emergency exit"] };
  }
  if (input.unrealizedPnlPercent <= -input.catastrophicLossPercent) {
    return { riskExitTriggered: true, severity: "CRITICAL", reasons: [`catastrophic loss ${input.unrealizedPnlPercent.toFixed(1)}%`] };
  }
  if (input.liquidityUsd < input.liquidityAtEntryUsd * 0.5) {
    return { riskExitTriggered: true, severity: "CRITICAL", reasons: ["liquidity dropped more than 50% since entry — possible liquidity removal"] };
  }
  if (input.unrealizedPnlPercent <= -input.maxLossPercent) {
    reasons.push(`loss ${input.unrealizedPnlPercent.toFixed(1)}% reached max tolerated loss`);
  }
  if (input.buySellRatio5m !== undefined && input.buySellRatio5m < 0.2) {
    reasons.push(`extreme sell pressure (buy ratio ${(input.buySellRatio5m * 100).toFixed(0)}%)`);
  }

  if (reasons.length > 0) {
    return { riskExitTriggered: true, severity: "WARNING", reasons };
  }
  return { riskExitTriggered: false, severity: "INFO", reasons: [] };
}

// ---------------------------------------------------------------------------
// validateExit — sanity bounds on an exit before it's "executed" in paper
// mode. Exits must still function when new entries are paused (§26/rule 17) —
// this function never checks the entry circuit breakers.
// ---------------------------------------------------------------------------
export interface ExitRiskInput {
  isEmergency: boolean;
  estimatedSlippageBps: number;
}

export interface ExitRiskResult {
  approved: boolean;
  reasons: string[];
}

export function validateExit(input: ExitRiskInput): ExitRiskResult {
  const maxSlippage = input.isEmergency ? tradingConfig.emergencyMaxSellSlippageBps : tradingConfig.defaultMaxSellSlippageBps;
  if (input.estimatedSlippageBps > maxSlippage) {
    // Per §29: do not silently widen slippage. An exit that can't clear even
    // the emergency ceiling still gets flagged, not silently forced through.
    return { approved: !input.isEmergency ? false : true, reasons: [`slippage ${input.estimatedSlippageBps}bps exceeds ${maxSlippage}bps ${input.isEmergency ? "(emergency ceiling — proceeding anyway to avoid an orphaned position)" : "limit"}`] };
  }
  return { approved: true, reasons: ["within slippage limits"] };
}

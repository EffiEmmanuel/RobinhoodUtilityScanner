import { config } from "../config";
import { tradingConfig } from "./config";
import type { SizingRules } from "./strategy";
import type { PortfolioState } from "./portfolio";
import type { TradeLane } from "./tradeLane";

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
  // Real, already-observed trading demand (buys+sells in the last hour) —
  // used only by the momentum override below, never as a standalone gate.
  hourlyTxns?: number;
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

  const qualityScoreOk = input.qualityScore >= tradingConfig.minTradeQualityScore;
  const confidenceOk = input.researchConfidence >= tradingConfig.minTradeResearchConfidence;
  const contractScoreOk = input.contractScore >= tradingConfig.minTradeContractScore;
  const liquidityOk = input.liquidityUsd >= tradingConfig.minTradeLiquidityUsd;
  if (!qualityScoreOk) {
    reasons.push(`qualityScore ${input.qualityScore} < ${tradingConfig.minTradeQualityScore}`);
  }
  if (!confidenceOk) {
    reasons.push(`researchConfidence ${input.researchConfidence} < ${tradingConfig.minTradeResearchConfidence}`);
  }
  if (!contractScoreOk) {
    reasons.push(`contractScore ${input.contractScore} < ${tradingConfig.minTradeContractScore}`);
  }
  if (!liquidityOk) {
    reasons.push(`liquidityUsd ${Math.round(input.liquidityUsd)} < ${tradingConfig.minTradeLiquidityUsd}`);
  }

  // Momentum override, same rationale as classify.ts's and research.ts's:
  // qualityScore AND researchConfidence both weigh signals that are
  // structurally near-zero for ANY token still in its first minutes,
  // legitimate or not — team/social/credibility, and confidence in general,
  // simply because there hasn't been time to build a track record. Real,
  // already-observed two-sided trading volume on real liquidity is evidence a
  // brand-new project can't fake the way it can fake a team page.
  //
  // Confirmed live 2026-09-11: PEG (qualityScore 53.6 AND researchConfidence
  // 59, both softly under the bar — a token ~2 minutes old, no site/socials
  // yet to even score) had 459 txns/hour on $20.8K liquidity with a clean
  // contract (contractScore 100) and was hard-REJECTED outright, because this
  // override previously only ever waived qualityScore alone — reasons.length
  // === 1 required confidence to already be passing. It went on to run 4x+
  // from its detection mcap. Widened to waive qualityScore and/or
  // researchConfidence together (never both at once with contract safety or
  // the liquidity floor, which stay real, unwaived gates on capital actually
  // at risk — validateEntry still re-checks live buy/sell pressure right
  // before any buy executes).
  const onlySoftScoresFailing = (!qualityScoreOk || !confidenceOk) && contractScoreOk && liquidityOk;
  if (
    onlySoftScoresFailing &&
    (input.hourlyTxns ?? 0) >= config.momentumOverrideMinHourlyTxns &&
    input.liquidityUsd >= config.momentumOverrideMinLiquidityUsd
  ) {
    const waived = [
      !qualityScoreOk ? `qualityScore ${input.qualityScore} < ${tradingConfig.minTradeQualityScore}` : null,
      !confidenceOk ? `researchConfidence ${input.researchConfidence} < ${tradingConfig.minTradeResearchConfidence}` : null,
    ].filter((r): r is string => r !== null);
    return {
      eligible: true,
      riskBucket: "HIGH",
      reasons: [`momentum override: ${input.hourlyTxns} txns/1h, $${Math.round(input.liquidityUsd).toLocaleString()} liquidity despite ${waived.join(" and ")}`],
    };
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
  // The AI trade-plan's own market-timing risk score (0-100, distinct from
  // riskBucket which is a project-quality margin). Previously a hard
  // entry-blocking gate — confirmed live that blocked EVERY trigger this
  // system ever had, including a token that went on to 2x right after. A
  // pullback that just triggered will almost always still read as
  // elevated-risk to the AI (that's inherent to "recently volatile," not
  // evidence it's a bad trade), so it scales size down instead of vetoing
  // the trade outright — consistent with how quality/confidence/liquidity
  // already work here.
  entryRiskScore?: number | null;
  // Current market cap at entry time — feeds the sweet-spot size boost
  // below. Undefined gets no boost (1x), never a penalty.
  currentMcapUsd?: number;
  tradeLane?: TradeLane;
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
  // Full size at/below 40 risk, linearly down to 50% size at 100 — a soft
  // preference for lower risk, never a wall that stops the trade entirely.
  const entryRiskMult =
    input.entryRiskScore != null ? lerp(1, 0.5, (input.entryRiskScore - 40) / 60) : 1;
  // Sweet-spot size boost (user directive 2026-09-11): confirmed live, PEG
  // ($51K entry -> ~4x) and TFLY ($195K -> 2x+) both delivered real, fast
  // multiples; RWA and STONKBROKER, both already $20-30M at entry, did not.
  // A candidate that's already cleared every eligibility/quality gate gets
  // sized UP toward maxMcapSizeBoostMultiple the closer its entry mcap is to
  // sizeBoostSweetSpotMcapUsd, tapering back to 1x (never below — this is a
  // reward, not a penalty; the exit-side fastFlip profile already handles
  // "large mcap, unproven project" caution) by sizeBoostTaperOffMcapUsd.
  const mcapBoostRatio =
    input.currentMcapUsd !== undefined
      ? lerp(
          0,
          1,
          (tradingConfig.sizeBoostTaperOffMcapUsd - input.currentMcapUsd) /
            (tradingConfig.sizeBoostTaperOffMcapUsd - tradingConfig.sizeBoostSweetSpotMcapUsd)
        )
      : 0;
  const marketCapMult = 1 + mcapBoostRatio * (tradingConfig.maxMcapSizeBoostMultiple - 1);
  const laneMult =
    input.tradeLane === "VERIFIED_PROJECT"
      ? tradingConfig.verifiedLaneSizeMultiplier
      : input.tradeLane === "MOMENTUM_TACTICAL"
        ? tradingConfig.tacticalLaneSizeMultiplier
        : 1;

  let positionSizeUsd = base * qualityMult * confidenceMult * riskMult * liquidityMult * entryRiskMult * marketCapMult * laneMult;

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

  // Small-account gas check (§23). Below this size, gas alone exceeds
  // maxGasCostPercentOfPosition no matter what the formula above computed.
  const gasCost = tradingConfig.paperAssumedGasCostUsd;
  const gasViableFloorUsd = (gasCost * 100) / tradingConfig.maxGasCostPercentOfPosition;

  // Confirmed live 2026-09-11: a HIGH-risk-bucket candidate that had already
  // cleared every eligibility gate (RWA, momentum-override entry) got sized
  // down by the quality/risk/entryRisk multipliers to ~$0.22 — well under the
  // ~$1 floor gas viability requires at the default 5% cap — and was rejected
  // outright by the check below on a token that went on to run 3x. The
  // formula's job is choosing how confidently to size *among tradeable
  // sizes*, not deciding whether to trade at all — a candidate that cleared
  // every gate deserves the smallest gas-viable position, not zero, as long
  // as the account can actually afford one within the hard caps already
  // applied above (never exceeds maxSinglePositionPercent or deployable
  // capital — this raises the floor, it doesn't bypass either ceiling).
  if (positionSizeUsd > 0 && positionSizeUsd < gasViableFloorUsd) {
    const raisedTo = Math.min(gasViableFloorUsd, maxBySinglePositionCap, portfolio.availableToDeployUsd);
    if (raisedTo >= gasViableFloorUsd - 1e-9) {
      reasons.push(`raised from $${positionSizeUsd.toFixed(2)} to gas-viable floor $${raisedTo.toFixed(2)} (gates already cleared; capital available)`);
      positionSizeUsd = raisedTo;
    }
  }

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
    `base=$${base.toFixed(2)} x quality=${qualityMult.toFixed(2)} x confidence=${confidenceMult.toFixed(2)} x risk=${riskMult.toFixed(2)} x liquidity=${liquidityMult.toFixed(2)} x entryRisk=${entryRiskMult.toFixed(2)} x lane=${laneMult.toFixed(2)}`
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
  // Total 5m buys+sells — gates the extreme-sell-pressure check below.
  // Confirmed live 2026-09-11: PERPSHOOD was sold on "extreme sell pressure
  // (buy ratio 0%)" from a 5-minute window with 0 buys AND 0 sells — the
  // ratio's own divide-by-zero guard (buys / max(total, 1)) reads a totally
  // silent window as 100% sellers. It went on to reach 1.68x.
  totalTxns5m: number | undefined;
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
  if (
    input.buySellRatio5m !== undefined &&
    input.buySellRatio5m < 0.2 &&
    (input.totalTxns5m ?? 0) >= tradingConfig.minTxns5mForSellPressureExit
  ) {
    reasons.push(`extreme sell pressure (buy ratio ${(input.buySellRatio5m * 100).toFixed(0)}%, ${input.totalTxns5m} txns/5m)`);
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

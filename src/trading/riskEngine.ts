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
  chain: string;
  // Pre-bond pump.fun pair — see isBondingCurvePair.
  onBondingCurve: boolean;
  // Whether a live quote showed our smallest position can be bought within
  // the price-impact limit AND sold back (planning.ts's
  // canExecuteMinimumPosition): true overrides the reported-liquidity bar
  // (MUSETOWN, 2026-09-23: $550 reported in the pool we could see, its real
  // market elsewhere); false means it was checked and nothing executes (a
  // hook that blocks outside swaps, a drained pool); undefined means not
  // checked or couldn't be checked — never treated as a failure.
  executableAtMinimumSize?: boolean;
}

/**
 * A pre-bond pump.fun pair: DexScreener reports no liquidity for a bonding
 * curve at all, so a min-liquidity check reads it as $0 and rejects every
 * one. Exit-ability is still enforced for real at entry time by the
 * executable buy-quote (slippage/price-impact) and sell-quote checks.
 */
export function isBondingCurvePair(pair: { dexId?: string; liquidityUsd?: number } | undefined): boolean {
  return pair?.dexId === "pumpfun" && pair.liquidityUsd === undefined;
}

/**
 * Whether the bot may open a position on this chain by itself — see
 * autonomousEntryChains' config comment. Manual buy-and-hold entries never
 * ask this.
 */
export function autonomousEntryAllowedOnChain(chain: string): boolean {
  return tradingConfig.autonomousEntryChains.includes(chain.toLowerCase());
}

export interface EntryMarketInput {
  chain: string;
  marketCapUsd: number | undefined;
  liquidityUsd: number | undefined;
  priceChange1hPercent: number | undefined;
  onBondingCurve: boolean;
}

/**
 * Market conditions that, in the 2026-09-24 outcome study, marked
 * candidates that almost never went on to a sellable 2x (see the entry*
 * config comment for the numbers). Returns the reasons it fails; empty
 * means pass. Missing data never fails a check, and a bonding curve has
 * no pool liquidity to judge.
 */
export function entryMarketFilter(input: EntryMarketInput): string[] {
  const reasons: string[] = [];
  const maxMcap = input.chain === "solana" ? tradingConfig.entryMaxMarketCapUsdSolana : tradingConfig.entryMaxMarketCapUsdRobinhood;
  if (maxMcap > 0 && input.marketCapUsd !== undefined && input.marketCapUsd >= maxMcap) {
    reasons.push(`market cap $${Math.round(input.marketCapUsd).toLocaleString()} >= $${maxMcap.toLocaleString()} entry cap`);
  }
  const maxPump = tradingConfig.entryMaxPriceChange1hPercent;
  if (maxPump > 0 && input.priceChange1hPercent !== undefined && input.priceChange1hPercent >= maxPump) {
    reasons.push(`already up ${Math.round(input.priceChange1hPercent)}% in the last hour (>= ${maxPump}%)`);
  }
  if (!input.onBondingCurve && input.liquidityUsd && input.liquidityUsd > 0 && input.marketCapUsd && input.marketCapUsd > 0) {
    const ratio = input.liquidityUsd / input.marketCapUsd;
    const { entryMinLiquidityToMarketCap: lo, entryMaxLiquidityToMarketCap: hi } = tradingConfig;
    if ((lo > 0 && ratio < lo) || (hi > 0 && ratio >= hi)) {
      reasons.push(`liquidity is ${(ratio * 100).toFixed(0)}% of market cap (outside ${Math.round(lo * 100)}-${Math.round(hi * 100)}%)`);
    }
  }
  return reasons;
}

export type CandidateCheck = "hardReject" | "quality" | "confidence" | "contract" | "liquidity" | "execution";

export interface CandidateRiskResult {
  eligible: boolean;
  riskBucket: RiskBucket;
  reasons: string[];
  failedChecks: CandidateCheck[];
}

const MARKET_ACCESS_CHECKS: CandidateCheck[] = ["liquidity", "execution"];

/**
 * True when the only things standing between a candidate and eligibility are
 * about reaching its market right now — pool depth, or no route that
 * executes — timing conditions (a pool that just opened, a launch hook that
 * blocks outside trades for its first minutes, a pool DexScreener
 * momentarily stopped listing), not a verdict on the project. Callers wait
 * and recheck instead of rejecting on these.
 */
export function failedOnlyOnMarketAccess(result: CandidateRiskResult): boolean {
  return !result.eligible && result.failedChecks.length > 0 && result.failedChecks.every((c) => MARKET_ACCESS_CHECKS.includes(c));
}

export function evaluateCandidate(input: CandidateRiskInput): CandidateRiskResult {
  const reasons: string[] = [];

  if (input.hardReject) {
    return { eligible: false, riskBucket: "REJECT", reasons: ["hardReject == true (never trade — §9)"], failedChecks: ["hardReject"] };
  }
  const failedChecks: CandidateCheck[] = [];

  const qualityScoreOk = input.qualityScore >= tradingConfig.minTradeQualityScore;
  const confidenceOk = input.researchConfidence >= tradingConfig.minTradeResearchConfidence;
  // Solana has no contract research (its score is a fixed placeholder, which
  // failed every Solana token against this bar). Mint/freeze authority is
  // enforced instead by the Solana honeypot gate right before entry.
  const contractScoreOk = input.chain === "solana" || input.contractScore >= tradingConfig.minTradeContractScore;
  const liquidityOk =
    input.onBondingCurve || input.executableAtMinimumSize === true || input.liquidityUsd >= tradingConfig.minTradeLiquidityUsd;
  if (!qualityScoreOk) {
    failedChecks.push("quality");
    reasons.push(`qualityScore ${input.qualityScore} < ${tradingConfig.minTradeQualityScore}`);
  }
  if (!confidenceOk) {
    failedChecks.push("confidence");
    reasons.push(`researchConfidence ${input.researchConfidence} < ${tradingConfig.minTradeResearchConfidence}`);
  }
  if (!contractScoreOk) {
    failedChecks.push("contract");
    reasons.push(`contractScore ${input.contractScore} < ${tradingConfig.minTradeContractScore}`);
  }
  if (!liquidityOk) {
    failedChecks.push("liquidity");
    reasons.push(`liquidityUsd ${Math.round(input.liquidityUsd)} < ${tradingConfig.minTradeLiquidityUsd}`);
  }
  if (input.executableAtMinimumSize === false) {
    failedChecks.push("execution");
    reasons.push("no route executes our minimum position within limits right now (hook-restricted, drained or unlisted pool)");
  }

  // User directive 2026-09-18: retired the momentum override that used to
  // waive qualityScore/researchConfidence/liquidity for high hourly-txn
  // tokens regardless of what the utility classification found. That path
  // was exactly how meme/no-utility tokens reached live capital (as
  // MOMENTUM_TACTICAL trades) — see utilityGate.ts's now-removed
  // canBypassUtilityGateForMomentum and classify.ts's now-removed
  // classify-stage override for the rest of that mechanism. Contract safety
  // was always unwaived here; now nothing is.
  if (reasons.length > 0) {
    return { eligible: false, riskBucket: "REJECT", reasons, failedChecks };
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

  return { eligible: true, riskBucket, reasons: ["cleared all trade-eligibility gates"], failedChecks: [] };
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
  // Whether this candidate cleared evaluateHighConvictionSetup
  // (conservativeMode.ts) — already computed by the caller pre-entry, so
  // checking it here costs nothing extra. Only changes the LIVE
  // tactical/narrative probe ceiling below; never affects VERIFIED_PROJECT
  // sizing, which was never flat-capped in the first place.
  highConviction?: boolean;
  // Bounded "how did similar past projects do" nudge from cohortStats.ts —
  // 1 means no data/effect. Defaults to 1 so every existing caller/test that
  // doesn't pass it keeps today's behavior unchanged.
  cohortSizeMultiplier?: number;
  // Picks the per-chain swap cost for the gas check (estimatedSwapGasUsd).
  // Undefined is treated as Robinhood.
  chain?: string;
  // A manual buy-and-hold keeps the small-account/steady-state single-
  // position limits; everything else is also held to
  // autonomousMaxSinglePositionPercent.
  manualBuyAndHold?: boolean;
}

/**
 * Estimated network cost of one swap on this chain — see the
 * robinhoodSwapGasCostUsd/solanaSwapFeeUsd config comment for the measured
 * numbers behind each.
 */
export function estimatedSwapGasUsd(chain: string | undefined): number {
  return chain === "solana" ? tradingConfig.solanaSwapFeeUsd : tradingConfig.robinhoodSwapGasCostUsd;
}

/** Smallest position whose swap cost stays within maxGasCostPercentOfPosition. */
export function gasViableFloorUsd(chain: string | undefined): number {
  return (estimatedSwapGasUsd(chain) * 100) / tradingConfig.maxGasCostPercentOfPosition;
}

export interface PositionSizingResult {
  approved: boolean;
  positionSizeUsd: number;
  reasons: string[];
  // Whichever LIVE tactical/narrative probe ceiling actually applied (base or
  // high-conviction), so callers can key slippage/impact tolerance off it
  // instead of re-deriving the tier themselves. Undefined outside LIVE
  // tactical/narrative lanes.
  appliedProbeCapUsd?: number;
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
      : input.tradeLane === "NARRATIVE_TACTICAL"
        ? tradingConfig.narrativeLaneSizeMultiplier
      : input.tradeLane === "MOMENTUM_TACTICAL"
        ? tradingConfig.tacticalLaneSizeMultiplier
        : 1;

  // Cohort multiplier folds in right alongside the other multipliers, before
  // any hard cap — small and bounded (cohortSizeMultiplierMin/Max), never
  // itself the reason a trade crosses a tier ceiling below.
  const cohortMult = input.cohortSizeMultiplier ?? 1;

  let positionSizeUsd = base * qualityMult * confidenceMult * riskMult * liquidityMult * entryRiskMult * marketCapMult * laneMult * cohortMult;

  // Hard caps (§22) — these override the formula, never the other way around.
  // Small-account boost (user directive 2026-09-17): the flat percent below
  // is tuned for an account with enough equity that fixed costs (gas) are
  // noise; below smallAccountEquityUsd it isn't, so the cap widens toward
  // smallAccountMaxSinglePositionPercent, tapering back to the steady-state
  // maxSinglePositionPercent by largeAccountEquityUsd — same lerp idiom as
  // the mcap sweet-spot boost above, just keyed on account size instead of
  // entry mcap.
  const accountSizedPercent = lerp(
    tradingConfig.smallAccountMaxSinglePositionPercent,
    tradingConfig.maxSinglePositionPercent,
    (portfolio.totalEquityUsd - tradingConfig.smallAccountEquityUsd) /
      (tradingConfig.largeAccountEquityUsd - tradingConfig.smallAccountEquityUsd)
  );
  // The bot's own picks are held to a much smaller slice — see
  // autonomousMaxSinglePositionPercent's config comment for why.
  const autonomousCapApplies =
    !input.manualBuyAndHold &&
    tradingConfig.autonomousMaxSinglePositionPercent > 0 &&
    tradingConfig.autonomousMaxSinglePositionPercent < accountSizedPercent;
  const singlePositionPercent = autonomousCapApplies ? tradingConfig.autonomousMaxSinglePositionPercent : accountSizedPercent;
  const maxBySinglePositionCap = portfolio.totalEquityUsd * (singlePositionPercent / 100);
  if (positionSizeUsd > maxBySinglePositionCap) {
    positionSizeUsd = maxBySinglePositionCap;
    reasons.push(`capped at ${autonomousCapApplies ? "autonomous " : ""}single-position limit (${singlePositionPercent.toFixed(1)}% of equity)`);
  }
  if (positionSizeUsd > portfolio.availableToDeployUsd) {
    positionSizeUsd = portfolio.availableToDeployUsd;
    reasons.push("capped at remaining deployable capital");
  }

  let appliedProbeCapUsd: number | undefined;
  if (tradingConfig.mode === "LIVE" && input.tradeLane === "MOMENTUM_TACTICAL" && tradingConfig.tacticalLiveMaxPositionUsd > 0) {
    appliedProbeCapUsd = input.highConviction
      ? tradingConfig.tacticalLiveMaxPositionUsdHighConviction
      : tradingConfig.tacticalLiveMaxPositionUsd;
    if (positionSizeUsd > appliedProbeCapUsd) {
      positionSizeUsd = appliedProbeCapUsd;
      reasons.push(
        `capped tactical LIVE probe at $${appliedProbeCapUsd.toFixed(2)}${input.highConviction ? " (high-conviction tier)" : " until this lane proves positive expectancy"}`
      );
    }
  }
  if (tradingConfig.mode === "LIVE" && input.tradeLane === "NARRATIVE_TACTICAL" && tradingConfig.narrativeLiveMaxPositionUsd > 0) {
    appliedProbeCapUsd = input.highConviction
      ? tradingConfig.narrativeLiveMaxPositionUsdHighConviction
      : tradingConfig.narrativeLiveMaxPositionUsd;
    if (positionSizeUsd > appliedProbeCapUsd) {
      positionSizeUsd = appliedProbeCapUsd;
      reasons.push(
        `capped narrative LIVE probe at $${appliedProbeCapUsd.toFixed(2)}${input.highConviction ? " (high-conviction tier)" : " until this lane proves positive expectancy"}`
      );
    }
  }

  // Small-account gas check (§23). Below this size, gas alone exceeds
  // maxGasCostPercentOfPosition no matter what the formula above computed.
  // At 5% of a ~$21 account ($1.05) this rejects every Robinhood entry
  // (~$0.04-0.05 a swap, ~4.8%) and passes Solana (~$0.01 at most, ~1%):
  // Robinhood's round-trip gas alone would be ~7% of the position.
  const gasCost = estimatedSwapGasUsd(input.chain);
  const gasFloorUsd = gasViableFloorUsd(input.chain);

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
  if (positionSizeUsd > 0 && positionSizeUsd < gasFloorUsd) {
    const raisedTo = Math.min(gasFloorUsd, maxBySinglePositionCap, portfolio.availableToDeployUsd);
    if (raisedTo >= gasFloorUsd - 1e-9) {
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
    `base=$${base.toFixed(2)} x quality=${qualityMult.toFixed(2)} x confidence=${confidenceMult.toFixed(2)} x risk=${riskMult.toFixed(2)} x liquidity=${liquidityMult.toFixed(2)} x entryRisk=${entryRiskMult.toFixed(2)} x mcap=${marketCapMult.toFixed(2)} x lane=${laneMult.toFixed(2)} x cohort=${cohortMult.toFixed(2)}`
  );
  return { approved: true, positionSizeUsd: Math.round(positionSizeUsd * 100) / 100, reasons, appliedProbeCapUsd };
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
  maxBuySlippageBps?: number;
  maxBuyPriceImpactPercent?: number;
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
    return {
      decision: "DEFER",
      reasons: ["no sell path available yet — waiting for a sell quote before risking capital"],
    };
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

  const maxBuySlippageBps = input.maxBuySlippageBps ?? tradingConfig.defaultMaxBuySlippageBps;
  const maxBuyPriceImpactPercent = input.maxBuyPriceImpactPercent ?? tradingConfig.maxBuyPriceImpactPercent;
  if (input.estimatedSlippageBps > maxBuySlippageBps) {
    reasons.push(`estimated slippage ${input.estimatedSlippageBps}bps exceeds ${maxBuySlippageBps}bps limit`);
  }
  if (input.estimatedPriceImpactPercent > maxBuyPriceImpactPercent) {
    reasons.push(`estimated price impact ${input.estimatedPriceImpactPercent.toFixed(2)}% exceeds ${maxBuyPriceImpactPercent}% limit`);
  }
  if (input.positionSizeUsd > input.availableToDeployUsd) {
    reasons.push("position size no longer fits within available deployable capital");
  }

  if (reasons.length > 0) {
    return { decision: "DEFER", reasons };
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
  // Skips the price-only exits (catastrophic loss, max loss, sell pressure)
  // and keeps the two that mean the token itself is broken (can't be sold,
  // liquidity pulled). Set for manual buy-and-hold positions — see
  // positionManager.ts's resolveExitRules.
  holdThroughDrawdowns?: boolean;
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
  if (!input.holdThroughDrawdowns && input.unrealizedPnlPercent <= -input.catastrophicLossPercent) {
    return { riskExitTriggered: true, severity: "CRITICAL", reasons: [`catastrophic loss ${input.unrealizedPnlPercent.toFixed(1)}%`] };
  }
  if (input.liquidityUsd < input.liquidityAtEntryUsd * 0.5) {
    return { riskExitTriggered: true, severity: "CRITICAL", reasons: ["liquidity dropped more than 50% since entry — possible liquidity removal"] };
  }
  if (input.holdThroughDrawdowns) {
    return { riskExitTriggered: false, severity: "INFO", reasons: [] };
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

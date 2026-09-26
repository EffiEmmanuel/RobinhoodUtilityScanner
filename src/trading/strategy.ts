import { db } from "../db";
import { logger } from "../logger";
import { StrategyStatus } from "../generated/prisma";
import { WEIGHTS } from "../scoring";
import { tradingConfig } from "./config";

export interface ProfitStep {
  multiple: number;
  sellPercentOfRemaining: number;
}

// User directive 2026-09-22: computed per-trade by positionManager.ts's
// resolveExitRules, from the same candidate/research data both the extended-
// hold decision (ExitRules.goodProject) and the tiered DCA/re-entry budget
// (positionStrategy.ts) read — one classification, two places it's applied.
export type ProjectTier = "FAST_FLIP" | "BASE" | "GOOD_PROJECT";

export interface SizingRules {
  baseAllocationPercent: number; // % of deployable capital for a "normal" (medium risk, medium confidence) position
  qualityMultiplierMin: number;
  qualityMultiplierMax: number;
  confidenceMultiplierMin: number;
  confidenceMultiplierMax: number;
  riskMultiplierLow: number;
  riskMultiplierMedium: number;
  riskMultiplierHigh: number;
  liquidityMultiplierMin: number;
  liquidityMultiplierMax: number;
}

export interface ExitRules {
  profitSteps: ProfitStep[];
  trailRemaining: boolean;
  trailingActivationMultiple: number;
  trailingPercent: number;
  maxLossPercent: number;
  catastrophicLossPercent: number;
  maxHoldMinutes: number;
  // Two independent reasons a trade gets the tighter profile below instead
  // of the normal one above — either is sufficient on its own:
  //
  // 1. The candidate only cleared eligibility on real trading demand (the
  //    momentum override — qualityScore and/or researchConfidence below
  //    qualityScoreThreshold, see riskEngine.ts), not on its own merits —
  //    it's a speculative ride on momentum someone else started, and every
  //    minute spent holding it past the point real buying pressure fades is
  //    a minute spent being exit liquidity for whoever bought before us.
  //
  // 2. Entry market cap was already above largeMcapUsd — a token that large
  //    has far less room left to run than one caught at tens/hundreds of
  //    thousands (confirmed live 2026-09-11: PEG $51K entry -> ~4x, TFLY
  //    $195K -> 2x+, vs RWA/STONKBROKER both already $20-30M entry and
  //    neither delivered a comparable multiple) — UNLESS qualityScore also
  //    clears the higher veryGoodQualityScoreThreshold, meaning this is a
  //    genuinely strong project worth holding long-term regardless of the
  //    market cap already paid to get in.
  //
  // positionManager.ts's resolveExitRules applies this. undefined (the
  // default until a strategy version sets it) disables the distinction
  // entirely and every trade uses the profile above, unchanged from before
  // this field existed.
  //
  // The profile overrides below are each optional: v1.9 drops the early
  // trail and profit steps (see costRecovery) and keeps only the tighter,
  // underwater-only maxHoldMinutes. The FAST_FLIP tier itself still exists
  // either way — it also sets the re-entry budget (positionStrategy.ts).
  fastFlip?: {
    qualityScoreThreshold: number;
    largeMcapUsd: number;
    veryGoodQualityScoreThreshold: number;
    profitSteps?: ProfitStep[];
    trailingActivationMultiple?: number;
    trailingPercent?: number;
    maxHoldMinutes: number;
  };

  // User directive 2026-09-22: a third, higher tier above the base profile —
  // a genuinely strong project (cleared fastFlip's own bar, i.e. not
  // low-quality/unproven-large-mcap) that ALSO has a confirmed real
  // community on X, not just decent research scores. socialScore is the
  // AI research synthesizer's own judgment of genuine (non-bot) X community
  // presence (see prompts.ts's RESEARCH_SYNTHESIZER_SYSTEM) — populated
  // identically for utility-lane ResearchRuns and narrative-lane ones
  // (narratives.ts sets socialScore: score.xScore), so this one field covers
  // "the narrative or utility project is very good" uniformly across both
  // lanes. positionManager.ts's resolveExitRules reads it from the trade's
  // linked ResearchRun; undefined/missing fails closed to BASE, not
  // GOOD_PROJECT. Only maxHoldMinutes is overridden here — trailing stop and
  // loss thresholds are unchanged from the base profile for this tier.
  goodProject?: {
    minSocialScoreToQualify: number;
    maxHoldMinutes: number;
  };

  // v1.9 (2026-09-25): one deterministic profit-take, then a runner. When
  // a position first reaches triggerMultiple, sell just enough of it to get
  // back everything it has cost (buys, their gas, and this sell's own
  // estimated gas, plus sellCostBufferPercent for quote drift) — ~53% at 2x.
  // What's left rides with a moonbagTrailingPercent trailing stop from its
  // peak, and nothing else sells it while it's above entry: not the AI
  // review, not the time exit (underwater-only anyway). The loss stops still
  // apply. Manual buy-and-hold positions never get this (resolveExitRules
  // strips it). This overrides the 2026-09-22 "no fixed profit-taking
  // multiples" directive for any version that sets it, so it only takes
  // effect once the user promotes such a version. Undefined (every version
  // up to v1.8) keeps the AI review as the only profit-taker. Evidence
  // (live trades 09-11 to 09-24): the runners sold far below their peaks
  // went out on the old 1.5x/2x steps (CLIP had sold 90% by 2x and peaked
  // at 5.2x) and on fastFlip's 1.2x/12% trail (SWARM sold at 1.19x from a
  // 1.36x peak, later ran to 5.8x); of 66 autonomous trades only 11 ever
  // offered a 2x.
  costRecovery?: CostRecoveryRules;

  // v1.10 candidates (B5 replay, 2026-09-26, paired over the full Solana
  // universe): act on a loss stop only once the mark has stayed past its line
  // for `seconds`, instead of on the first mark past it — most wicks through
  // the stop recover within a minute. appliesTo "maxLoss" confirms only the
  // max-loss stop (catastrophicLossPercent stays immediate); "both" confirms
  // the catastrophic stop too. Measured: +2.3 [+1.0,+3.6] pts/trade with
  // maxLoss confirmed, +6.0 [+4.4,+7.7] with both; the cost is a rug that
  // gaps through within the window is eaten in full (XPAY -23% -> -99% with
  // both). Liquidity pulls, a vanished sell quote and invalidation stay
  // immediate always; manual holds have no price stops. Undefined (v1.8)
  // keeps every stop immediate.
  stopConfirm?: StopConfirmRules;
}

export interface StopConfirmRules {
  seconds: number;
  appliesTo: "maxLoss" | "both";
}

export interface CostRecoveryRules {
  triggerMultiple: number;
  sellCostBufferPercent: number;
  moonbagTrailingPercent: number;
}

export interface EntryRules {
  pullbackExtendedThresholdPercent: number; // price this far above recent swing low => "extended", prefer pullback entry
  doNotChaseAboveMultiplePastTarget: number; // e.g. 1.15 = don't chase more than 15% above the top of the target zone
}

export interface StrategyConfiguration {
  minTradeQualityScore: number;
  minTradeResearchConfidence: number;
  minTradeContractScore: number;
  minTradeLiquidityUsd: number;
  defaultEntryPlanTtlMinutes: number;
}

const DEFAULT_NAME = "default";
const DEFAULT_VERSION = "v1.0";

// Mirrors the PRD's own worked examples (§35/§39) — a reasonable starting
// point, not a tuned strategy. Change by creating a NEW StrategyVersion, never
// by editing this file's defaults in place once real trades reference v1.0.
function buildDefaultConfiguration(): {
  configuration: StrategyConfiguration;
  entryRules: EntryRules;
  sizingRules: SizingRules;
  exitRules: ExitRules;
} {
  return {
    configuration: {
      minTradeQualityScore: tradingConfig.minTradeQualityScore,
      minTradeResearchConfidence: tradingConfig.minTradeResearchConfidence,
      minTradeContractScore: tradingConfig.minTradeContractScore,
      minTradeLiquidityUsd: tradingConfig.minTradeLiquidityUsd,
      defaultEntryPlanTtlMinutes: tradingConfig.defaultEntryPlanTtlMinutes,
    },
    entryRules: {
      pullbackExtendedThresholdPercent: 15,
      doNotChaseAboveMultiplePastTarget: 1.15,
    },
    sizingRules: {
      baseAllocationPercent: 10,
      qualityMultiplierMin: 0.6,
      qualityMultiplierMax: 1.3,
      confidenceMultiplierMin: 0.6,
      confidenceMultiplierMax: 1.2,
      riskMultiplierLow: 1.2,
      riskMultiplierMedium: 1.0,
      riskMultiplierHigh: 0.5,
      liquidityMultiplierMin: 0.5,
      liquidityMultiplierMax: 1.2,
    },
    exitRules: {
      profitSteps: [
        { multiple: 2.0, sellPercentOfRemaining: 50 },
        { multiple: 2.5, sellPercentOfRemaining: 30 },
      ],
      trailRemaining: true,
      trailingActivationMultiple: 1.6,
      trailingPercent: 20,
      maxLossPercent: 25,
      catastrophicLossPercent: 40,
      maxHoldMinutes: tradingConfig.defaultMaxHoldMinutes,
      goodProject: { minSocialScoreToQualify: 60, maxHoldMinutes: tradingConfig.goodProjectMaxHoldMinutes },
    },
  };
}

let cachedActiveVersionId: string | undefined;

/**
 * Get-or-create the default strategy version and return it as the "active"
 * one for new plans/trades. Later versions (v1.1, v2.0, ...) are created and
 * promoted explicitly via the API (see promoteStrategyVersion) — never
 * silently swapped in here.
 */
export async function getActiveStrategyVersion() {
  if (cachedActiveVersionId) {
    const cached = await db.strategyVersion.findUnique({ where: { id: cachedActiveVersionId } });
    if (cached) return cached;
  }

  // PRODUCTION outranks SHADOW if somehow both exist.
  const active =
    (await db.strategyVersion.findFirst({ where: { status: StrategyStatus.PRODUCTION }, orderBy: { createdAt: "desc" } })) ??
    (await db.strategyVersion.findFirst({ where: { status: StrategyStatus.SHADOW }, orderBy: { createdAt: "desc" } }));
  if (active) {
    cachedActiveVersionId = active.id;
    return active;
  }

  const defaults = buildDefaultConfiguration();
  const created = await db.strategyVersion.create({
    data: {
      name: DEFAULT_NAME,
      version: DEFAULT_VERSION,
      status: StrategyStatus.SHADOW,
      configuration: defaults.configuration as unknown as object,
      scoringWeights: WEIGHTS as unknown as object,
      entryRules: defaults.entryRules as unknown as object,
      sizingRules: defaults.sizingRules as unknown as object,
      exitRules: defaults.exitRules as unknown as object,
    },
  });
  logger.info({ id: created.id, name: created.name, version: created.version }, "seeded default strategy version");
  cachedActiveVersionId = created.id;
  return created;
}

const VALID_TRANSITIONS: Record<StrategyStatus, StrategyStatus[]> = {
  [StrategyStatus.DRAFT]: [StrategyStatus.BACKTEST],
  [StrategyStatus.BACKTEST]: [StrategyStatus.SHADOW, StrategyStatus.DRAFT],
  [StrategyStatus.SHADOW]: [StrategyStatus.PRODUCTION, StrategyStatus.DRAFT],
  [StrategyStatus.PRODUCTION]: [StrategyStatus.RETIRED],
  [StrategyStatus.RETIRED]: [],
};

/**
 * Explicit, human-triggered promotion only (§68: "Never allow an LLM to
 * auto-promote a strategy") — this is called from an API endpoint, never
 * from the planning/trading loops themselves.
 */
export async function promoteStrategyVersion(id: string, toStatus: StrategyStatus) {
  const version = await db.strategyVersion.findUniqueOrThrow({ where: { id } });
  if (!VALID_TRANSITIONS[version.status].includes(toStatus)) {
    throw new Error(`Invalid strategy transition ${version.status} -> ${toStatus}`);
  }
  if (toStatus === StrategyStatus.PRODUCTION) {
    // Only one PRODUCTION version at a time — retire the current one.
    await db.strategyVersion.updateMany({
      where: { status: StrategyStatus.PRODUCTION },
      data: { status: StrategyStatus.RETIRED },
    });
  }
  const updated = await db.strategyVersion.update({
    where: { id },
    data: { status: toStatus, promotedAt: toStatus === StrategyStatus.PRODUCTION ? new Date() : version.promotedAt },
  });
  cachedActiveVersionId = undefined;
  return updated;
}
